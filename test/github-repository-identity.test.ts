import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubRepositoryLookupError,
  lookupCanonicalGitHubRepository,
  type GitHubRepositoryLookupErrorCode,
} from "../src/github/repository-identity.ts";
import type { GitHubHttpClient } from "../src/github/http.ts";

function page(
  repositories: Array<{ id: number; full_name: string }>,
  next?: string,
): { status: number; headers: Record<string, string>; body: unknown } {
  return {
    status: 200,
    headers: next ? { link: `<${next}>; rel="next"` } : {},
    body: { repositories },
  };
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: GitHubRepositoryLookupErrorCode,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GitHubRepositoryLookupError, `expected GitHubRepositoryLookupError, got ${error}`);
    assert.equal((error as GitHubRepositoryLookupError).code, code);
    return true;
  });
}

test("lookupCanonicalGitHubRepository finds the target on page 1", async () => {
  let requests = 0;
  const http: GitHubHttpClient = {
    async request(method, url) {
      requests += 1;
      assert.equal(method, "GET");
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://api.github.com");
      assert.equal(parsed.pathname, "/installation/repositories");
      assert.equal(parsed.searchParams.get("per_page"), "100");
      return page([
        { id: 111, full_name: "owner/other" },
        { id: 4242, full_name: "owner/target" },
      ]);
    },
  };
  const result = await lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 });
  assert.deepEqual(result, { kind: "found", repositoryId: 4242, repository: "owner/target" });
  assert.equal(requests, 1, "must stop immediately once the target is found");
});

test("lookupCanonicalGitHubRepository finds the target on page 2+", async () => {
  let requests = 0;
  const http: GitHubHttpClient = {
    async request(_method, url) {
      requests += 1;
      const parsed = new URL(url);
      const pageNumber = parsed.searchParams.get("page") ?? "1";
      if (pageNumber === "1") {
        const next = new URL(url);
        next.searchParams.set("per_page", "100");
        next.searchParams.set("page", "2");
        return page([{ id: 111, full_name: "owner/other" }], next.toString());
      }
      return page([{ id: 4242, full_name: "owner/target" }]);
    },
  };
  const result = await lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 });
  assert.deepEqual(result, { kind: "found", repositoryId: 4242, repository: "owner/target" });
  assert.equal(requests, 2);
});

test("lookupCanonicalGitHubRepository authenticates with the given token", async () => {
  let seenHeaders: Record<string, string> | undefined;
  const http: GitHubHttpClient = {
    async request(_method, _url, options) {
      seenHeaders = options?.headers;
      return page([]);
    },
  };
  await lookupCanonicalGitHubRepository({ http, token: "ghs_bearer_test", repositoryId: 4242 });
  assert.equal(seenHeaders?.authorization, "Bearer ghs_bearer_test");
});

test("lookupCanonicalGitHubRepository returns not-found on clean terminal exhaustion", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([{ id: 1, full_name: "owner/unrelated" }]);
    },
  };
  const result = await lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 });
  assert.deepEqual(result, { kind: "not-found" });
});

test("lookupCanonicalGitHubRepository does not assume at most one row per page", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([
        { id: 1, full_name: "owner/one" },
        { id: 4242, full_name: "owner/target" },
        { id: 3, full_name: "owner/three" },
      ]);
    },
  };
  const result = await lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 });
  assert.deepEqual(result, { kind: "found", repositoryId: 4242, repository: "owner/target" });
});

test("lookupCanonicalGitHubRepository throws a distinct traversal-limit code on page-limit exhaustion, not not-found", async () => {
  let requests = 0;
  const http: GitHubHttpClient = {
    async request(_method, url) {
      requests += 1;
      const next = new URL(url);
      next.searchParams.set("per_page", "100");
      next.searchParams.set("page", String(requests + 1));
      return page([{ id: 1, full_name: "owner/never-found" }], next.toString());
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "traversal-limit-exceeded",
  );
  assert.ok(requests <= 100, `must not exceed the 100-page bound (made ${requests} requests)`);
  assert.ok(requests >= 100, `must exhaust the full 100-page bound before giving up (made ${requests} requests)`);
});

test("lookupCanonicalGitHubRepository rejects a malformed next Link header without suspension", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return {
        status: 200,
        headers: { link: "not-a-valid-link-header" },
        body: { repositories: [] },
      };
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "pagination-link-malformed",
  );
});

test("lookupCanonicalGitHubRepository rejects duplicate next rels without suspension", async () => {
  const http: GitHubHttpClient = {
    async request(_method, url) {
      return {
        status: 200,
        headers: { link: `<${url}>; rel="next", <${url}>; rel="next"` },
        body: { repositories: [] },
      };
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "pagination-link-malformed",
  );
});

test("lookupCanonicalGitHubRepository rejects an unsafe next URL (wrong origin) without suspension", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([], "https://example.invalid/installation/repositories?per_page=100&page=2");
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "pagination-link-unsafe",
  );
});

test("lookupCanonicalGitHubRepository rejects an unsafe next URL (wrong path) without suspension", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([], "https://api.github.com/installation/repositories/other?per_page=100&page=2");
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "pagination-link-unsafe",
  );
});

test("lookupCanonicalGitHubRepository rejects an unsafe next URL (unexpected query key) without suspension", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([], "https://api.github.com/installation/repositories?per_page=100&page=2&cursor=opaque");
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "pagination-link-unsafe",
  );
});

test("lookupCanonicalGitHubRepository rejects a next URL loop without suspension", async () => {
  const http: GitHubHttpClient = {
    async request(_method, url) {
      return page([{ id: 1, full_name: "owner/one" }], url);
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "pagination-loop-detected",
  );
});

test("lookupCanonicalGitHubRepository treats rate limiting as retryable, not revocation", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
        body: { message: "API rate limit exceeded" },
      };
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "rate-limited",
  );
});

test("lookupCanonicalGitHubRepository treats transport failure as retryable, not revocation", async () => {
  const http: GitHubHttpClient = {
    async request() {
      throw new Error("socket hang up");
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "transport-failure",
  );
});

test("lookupCanonicalGitHubRepository treats a 5xx upstream error as retryable, not revocation", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return { status: 502, headers: {}, body: {} };
    },
  };
  const error = await lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }).catch(
    (e: unknown) => e,
  );
  assert.ok(error instanceof GitHubRepositoryLookupError);
  assert.equal((error as GitHubRepositoryLookupError).code, "upstream-error");
  assert.equal((error as GitHubRepositoryLookupError).retryable, true);
});

test("lookupCanonicalGitHubRepository fails closed on the same ID with conflicting names across pages", async () => {
  const http: GitHubHttpClient = {
    async request(_method, url) {
      const parsed = new URL(url);
      if ((parsed.searchParams.get("page") ?? "1") === "1") {
        const next = new URL(url);
        next.searchParams.set("per_page", "100");
        next.searchParams.set("page", "2");
        return page([{ id: 4242, full_name: "owner/old-name" }], next.toString());
      }
      return page([{ id: 4242, full_name: "owner/new-name" }]);
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 9999 }),
    "duplicate-id-conflicting-name",
  );
});

test("lookupCanonicalGitHubRepository dedupes identical repeated IDs without error", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([
        { id: 1, full_name: "owner/one" },
        { id: 1, full_name: "owner/one" },
        { id: 4242, full_name: "owner/target" },
      ]);
    },
  };
  const result = await lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 });
  assert.deepEqual(result, { kind: "found", repositoryId: 4242, repository: "owner/target" });
});

test("lookupCanonicalGitHubRepository fails closed on a malformed response body (repositories missing)", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return { status: 200, headers: {}, body: { total_count: 0 } };
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "malformed-response",
  );
});

test("lookupCanonicalGitHubRepository fails closed on a malformed row id", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([{ id: "not-a-number" as unknown as number, full_name: "owner/target" }]);
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "malformed-response",
  );
});

test("lookupCanonicalGitHubRepository fails closed on an invalid canonical name for the matched row", async () => {
  const http: GitHubHttpClient = {
    async request() {
      return page([{ id: 4242, full_name: "not-owner-slash-repo" }]);
    },
  };
  await rejectsWithCode(
    lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
    "canonical-name-invalid",
  );
});

test("lookupCanonicalGitHubRepository fails closed on path-traversal segments in the canonical name", async () => {
  // A whole owner or repo segment of "." or ".." is a value GitHub never
  // issues for full_name; reject it as a path-traversal hazard rather than
  // accepting it as routing/display metadata.
  const traversalNames = ["owner/..", "../repo", "owner/.", "./repo"];
  for (const fullName of traversalNames) {
    const http: GitHubHttpClient = {
      async request() {
        return page([{ id: 4242, full_name: fullName }]);
      },
    };
    await rejectsWithCode(
      lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
      "canonical-name-invalid",
    );
  }
});

test("lookupCanonicalGitHubRepository fails closed on control characters in the canonical name", async () => {
  const controlCharacterNames = ["own\u0001er/repo", "owner/re\u0007po", "owner\towner2/repo", "owner/repo\u007f"];
  for (const fullName of controlCharacterNames) {
    const http: GitHubHttpClient = {
      async request() {
        return page([{ id: 4242, full_name: fullName }]);
      },
    };
    await rejectsWithCode(
      lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 }),
      "canonical-name-invalid",
    );
  }
});

test("lookupCanonicalGitHubRepository accepts canonical names GitHub can legitimately issue", async () => {
  // Dots and underscores anywhere within a segment (not as the whole
  // segment) are real GitHub repository name characters and must not be
  // rejected by the path-traversal tightening.
  const legitimateNames = ["my-org/repo.name_1", "a.b.c/d_e-f", "owner123/.github", "owner/repo.."];
  for (const fullName of legitimateNames) {
    const http: GitHubHttpClient = {
      async request() {
        return page([{ id: 4242, full_name: fullName }]);
      },
    };
    const result = await lookupCanonicalGitHubRepository({ http, token: "ghs_test", repositoryId: 4242 });
    assert.deepEqual(result, { kind: "found", repositoryId: 4242, repository: fullName.toLowerCase() });
  }
});

test("lookupCanonicalGitHubRepository rejects invalid repository ids", async () => {
  const invalidRepositoryIds = [0, -1, 1.5, Number.NaN];
  for (const repositoryId of invalidRepositoryIds) {
    let requests = 0;
    await assert.rejects(
      lookupCanonicalGitHubRepository({
        http: {
          async request() {
            requests += 1;
            return page([]);
          },
        },
        token: "ghs_test",
        repositoryId,
      }),
      /repository id/i,
    );
    assert.equal(requests, 0);
  }
});
