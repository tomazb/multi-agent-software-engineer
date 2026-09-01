import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import {
  assertReadOnlyChecksMode,
  buildCheckConclusions,
  CheckPublisher,
  externalIdFor,
  type GitHubHttpClient,
} from "../src/github/checks.ts";
import type { RunRecord } from "../src/domain.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("side-effect store remembers GitHub resource ids by idempotency key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-side-"));
  const store = new GitHubSideEffectStore(root);
  const key = "check-run:owner/repo/1/sha/quality/1";
  assert.equal(await store.get(key), undefined);
  await store.put(key, { resourceId: 99, kind: "check-run" });
  assert.deepEqual(await store.get(key), { resourceId: 99, kind: "check-run" });
});

test("read-only mode rejects write side effects", () => {
  assert.doesNotThrow(() => assertReadOnlyChecksMode(true, "checks"));
  assert.throws(() => assertReadOnlyChecksMode(true, "push"), /read-only/i);
  assert.throws(() => assertReadOnlyChecksMode(true, "pull_request_write"), /read-only/i);
  assert.throws(() => assertReadOnlyChecksMode(true, "comment_reply"), /read-only/i);
});

test("externalIdFor is a stable full SHA-256 identity for the complete key", () => {
  const key = "check-run:owner/repo/1/sha/MASWE / deterministic quality/1";
  const externalId = externalIdFor(key);

  assert.equal(
    externalId,
    "maswe:check-run:sha256:26f91d94b5264f291f2cfbafef75c48fe7f65713108a4b4251ad8eebc68e407e",
  );
  assert.match(externalId, /^maswe:check-run:sha256:[0-9a-f]{64}$/);
  assert.equal(externalIdFor(key), externalId);
});

test("externalIdFor distinguishes long keys that differ only after byte 64", () => {
  const sharedPrefix = "x".repeat(64);

  assert.notEqual(
    externalIdFor(`${sharedPrefix}first-complete-key`),
    externalIdFor(`${sharedPrefix}second-complete-key`),
  );
});

test("buildCheckConclusions binds success only to matching evidence SHA", () => {
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [
      {
        name: "02-brainstorm.md",
        logicalName: "02-brainstorm.md",
        attempt: 1,
        path: "x",
        sha256: "a".repeat(64),
        createdAt: "",
      },
      {
        name: "03-specification-and-design.md",
        logicalName: "03-specification-and-design.md",
        attempt: 1,
        path: "x",
        sha256: "b".repeat(64),
        createdAt: "",
      },
    ],
    events: [],
    evidence: {
      quality: { headSha: "sha-good", passed: true, at: "t" },
      verification: { headSha: "sha-good", passed: true, at: "t" },
    },
  } as RunRecord;

  const good = buildCheckConclusions(run, "sha-good");
  assert.equal(good["MASWE / deterministic quality"].conclusion, "success");
  assert.equal(good["MASWE / independent verification"].conclusion, "success");
  assert.equal(good["MASWE / specification compliance"].conclusion, "success");
  assert.equal(good["MASWE / review comments resolved"].conclusion, "neutral");

  const stale = buildCheckConclusions(run, "sha-other");
  assert.equal(stale["MASWE / deterministic quality"].conclusion, "neutral");
  assert.equal(stale["MASWE / independent verification"].conclusion, "neutral");
});

test("buildCheckConclusions rejects the non-canonical 03-design.md name", () => {
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [
      {
        name: "02-brainstorm.md",
        logicalName: "02-brainstorm.md",
        attempt: 1,
        path: "x",
        sha256: "a".repeat(64),
        createdAt: "",
      },
      {
        name: "03-design.md",
        logicalName: "03-design.md",
        attempt: 1,
        path: "x",
        sha256: "b".repeat(64),
        createdAt: "",
      },
    ],
    events: [],
  } as RunRecord;
  assert.equal(
    buildCheckConclusions(run, "sha")["MASWE / specification compliance"].conclusion,
    "action_required",
  );
});

test("CheckPublisher PATCH bodies omit head_sha", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-patch-"));
  const sideEffects = new GitHubSideEffectStore(root);
  const patches: unknown[] = [];
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
      if (method === "PATCH") {
        patches.push(options?.body);
        return { status: 200, headers: {}, body: { id: 1 } };
      }
      return { status: 200, headers: {}, body: {} };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects,
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;
  await publisher.publishForHeadSha(run, "sha1");
  await publisher.publishForHeadSha(run, "sha1");
  assert.ok(patches.length >= 4);
  for (const body of patches) {
    assert.equal(Object.hasOwn(body as object, "head_sha"), false);
  }
});

test("CheckPublisher reconciles all pages with filter=all and patches a later-page match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-pages-"));
  const sideEffects = new GitHubSideEffectStore(root);
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      calls.push({ method, url, body: options?.body });
      if (method === "GET") {
        const requested = new URL(url);
        assert.equal(requested.searchParams.get("filter"), "all");
        assert.equal(requested.searchParams.get("per_page"), "100");
        const name = requested.searchParams.get("check_name")!;
        const key = `check-run:owner/repo/1/sha/${name}/1`;
        const id = name === "MASWE / specification compliance" ? 401 : 402 + calls.length;
        if (name === "MASWE / specification compliance" && !requested.searchParams.has("page")) {
          requested.searchParams.set("page", "2");
          return {
            status: 200,
            headers: { LiNk: `<${requested.toString()}>; rel="next"` },
            body: { check_runs: [] },
          };
        }
        return {
          status: 200,
          headers: {},
          body: { check_runs: [{ id, external_id: externalIdFor(key) }] },
        };
      }
      if (method === "PATCH") {
        return { status: 200, headers: {}, body: { id: Number(url.split("/").pop()) } };
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects,
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await publisher.publishForHeadSha(run, "sha");

  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(
    calls.filter(
      (call) =>
        call.method === "GET" &&
        new URL(call.url).searchParams.get("check_name") ===
          "MASWE / specification compliance",
    ).length,
    2,
  );
  const recoveredPatch = calls.find(
    (call) => call.method === "PATCH" && call.url.endsWith("/check-runs/401"),
  );
  assert.deepEqual(recoveredPatch?.body, {
    status: "completed",
    conclusion: "action_required",
    output: {
      title: "Specification incomplete",
      summary: "Approved brainstorm/design artifacts are required before specification compliance succeeds.",
    },
  });
});

test("CheckPublisher reconciles a POST response without id, persists it, and patches the outcome", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-ambiguous-post-"));
  const sideEffects = new GitHubSideEffectStore(root);
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const getsByName = new Map<string, number>();
  const idsByName = new Map<string, number>();
  let nextId = 700;
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      calls.push({ method, url, body: options?.body });
      if (method === "GET") {
        const name = new URL(url).searchParams.get("check_name")!;
        const getCount = (getsByName.get(name) ?? 0) + 1;
        getsByName.set(name, getCount);
        if (getCount === 1) {
          return { status: 200, headers: {}, body: { check_runs: [] } };
        }
        return {
          status: 200,
          headers: {},
          body: {
            check_runs: [{ id: idsByName.get(name), external_id: externalIdFor(`check-run:owner/repo/1/sha/${name}/1`) }],
          },
        };
      }
      if (method === "POST") {
        const name = (options?.body as { name: string }).name;
        idsByName.set(name, nextId++);
        return { status: 201, headers: {}, body: {} };
      }
      if (method === "PATCH") {
        return { status: 200, headers: {}, body: { id: Number(url.split("/").pop()) } };
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects,
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await publisher.publishForHeadSha(run, "sha");

  const key = "check-run:owner/repo/1/sha/MASWE / specification compliance/1";
  assert.deepEqual(await sideEffects.get(key), { resourceId: 700, kind: "check-run" });
  assert.equal(calls.filter((call) => call.method === "POST").length, 4);
  const recoveredPatch = calls.find(
    (call) => call.method === "PATCH" && call.url.endsWith("/check-runs/700"),
  );
  assert.deepEqual(recoveredPatch?.body, {
    status: "completed",
    conclusion: "action_required",
    output: {
      title: "Specification incomplete",
      summary: "Approved brainstorm/design artifacts are required before specification compliance succeeds.",
    },
  });
  assert.equal(Object.hasOwn(recoveredPatch?.body as object, "head_sha"), false);
});

test("CheckPublisher rejects unsafe or looping reconciliation links", async (t) => {
  const cases = [
    {
      name: "loop",
      nextUrl: (current: string) => current,
    },
    {
      name: "cross-origin",
      nextUrl: (current: string) => current.replace("https://api.github.com", "https://example.invalid"),
    },
    {
      name: "repository path escape",
      nextUrl: (current: string) => current.replace("/repos/owner/repo/", "/repos/owner/other/"),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-unsafe-page-"));
      const http: GitHubHttpClient = {
        async request(method, url) {
          if (method === "GET") {
            return {
              status: 200,
              headers: { link: `<${fixture.nextUrl(url)}>; rel="next"` },
              body: { check_runs: [] },
            };
          }
          if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
          return { status: 200, headers: {}, body: {} };
        },
      };
      const publisher = new CheckPublisher({
        http,
        sideEffects: new GitHubSideEffectStore(root),
        readOnlyChecks: true,
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 1,
        token: "token",
      });
      const run = {
        schemaVersion: 1,
        version: 1,
        id: "run-1",
        title: "t",
        request: "r",
        repositoryPath: "/tmp",
        state: "PR_REVIEW",
        createdAt: "",
        updatedAt: "",
        approvals: { brainstorm: false, design: false },
        counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
        config: DEFAULT_CONFIG,
        artifacts: [],
        events: [],
      } as RunRecord;

      await assert.rejects(
        () => publisher.publishForHeadSha(run, "sha"),
        /pagination|link|loop|unsafe/i,
      );
    });
  }
});

test("CheckPublisher rejects duplicate, unknown, and noncanonical pagination query parameters", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (next: URL) => void;
  }> = [
    {
      name: "duplicate check_name",
      mutate: (next) => next.searchParams.append("check_name", "MASWE / deterministic quality"),
    },
    {
      name: "conflicting duplicate filter",
      mutate: (next) => next.searchParams.append("filter", "latest"),
    },
    {
      name: "duplicate per_page",
      mutate: (next) => next.searchParams.append("per_page", "100"),
    },
    {
      name: "unknown query key",
      mutate: (next) => next.searchParams.set("cursor", "opaque"),
    },
    {
      name: "duplicate page",
      mutate: (next) => {
        next.searchParams.set("page", "1");
        next.searchParams.append("page", "2");
      },
    },
    {
      name: "zero page",
      mutate: (next) => next.searchParams.set("page", "0"),
    },
    {
      name: "leading-zero page",
      mutate: (next) => next.searchParams.set("page", "01"),
    },
    {
      name: "signed page",
      mutate: (next) => next.searchParams.set("page", "+1"),
    },
    {
      name: "fractional page",
      mutate: (next) => next.searchParams.set("page", "1.0"),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-query-page-"));
      let gets = 0;
      const http: GitHubHttpClient = {
        async request(method, url) {
          if (method === "GET") {
            gets += 1;
            if (gets !== 1) {
              throw new Error("HTTP double received an unsafe pagination URL");
            }
            const next = new URL(url);
            fixture.mutate(next);
            return {
              status: 200,
              headers: { link: `<${next.toString()}>; rel="next"` },
              body: { check_runs: [] },
            };
          }
          if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
          return { status: 200, headers: {}, body: {} };
        },
      };
      const publisher = new CheckPublisher({
        http,
        sideEffects: new GitHubSideEffectStore(root),
        readOnlyChecks: true,
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 1,
        token: "token",
      });
      const run = {
        schemaVersion: 1,
        version: 1,
        id: "run-1",
        title: "t",
        request: "r",
        repositoryPath: "/tmp",
        state: "PR_REVIEW",
        createdAt: "",
        updatedAt: "",
        approvals: { brainstorm: false, design: false },
        counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
        config: DEFAULT_CONFIG,
        artifacts: [],
        events: [],
      } as RunRecord;

      await assert.rejects(
        () => publisher.publishForHeadSha(run, "sha"),
        /pagination Link URL is unsafe/i,
      );
      assert.equal(gets, 1);
    });
  }
});

test("CheckPublisher rejects duplicate rel attributes or relation tokens", async (t) => {
  const cases = [
    'rel="next"; rel="prev"',
    'rel="next"; rel="next"',
    'rel="next next"',
  ];

  for (const relParameters of cases) {
    await t.test(relParameters, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-duplicate-rel-"));
      let posts = 0;
      const http: GitHubHttpClient = {
        async request(method, url) {
          if (method === "GET") {
            return {
              status: 200,
              headers: { link: `<${url}>; ${relParameters}` },
              body: { check_runs: [] },
            };
          }
          if (method === "POST") {
            posts += 1;
            return { status: 201, headers: {}, body: { id: posts } };
          }
          return { status: 200, headers: {}, body: {} };
        },
      };
      const publisher = new CheckPublisher({
        http,
        sideEffects: new GitHubSideEffectStore(root),
        readOnlyChecks: true,
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 1,
        token: "token",
      });
      const run = {
        schemaVersion: 1,
        version: 1,
        id: "run-1",
        title: "t",
        request: "r",
        repositoryPath: "/tmp",
        state: "PR_REVIEW",
        createdAt: "",
        updatedAt: "",
        approvals: { brainstorm: false, design: false },
        counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
        config: DEFAULT_CONFIG,
        artifacts: [],
        events: [],
      } as RunRecord;

      await assert.rejects(
        () => publisher.publishForHeadSha(run, "sha"),
        /pagination Link header is malformed/i,
      );
      assert.equal(posts, 0);
    });
  }
});

// The following four tests pin the exact historical error message families
// (issue #34 Task 3: pagination.ts extraction must not change checks.ts's
// asserted strings verbatim, not just their regex family).
test("CheckPublisher preserves the exact 'Link header is malformed' message after pagination extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-exact-header-malformed-"));
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET") {
        return {
          status: 200,
          headers: { link: `<${url}>; rel="next"; rel="prev"` },
          body: { check_runs: [] },
        };
      }
      if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: {} };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects: new GitHubSideEffectStore(root),
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await assert.rejects(
    () => publisher.publishForHeadSha(run, "sha"),
    (error: unknown) => {
      assert.equal((error as Error).message, "GitHub check-run pagination Link header is malformed");
      return true;
    },
  );
});

test("CheckPublisher preserves the exact 'Link URL is malformed' message after pagination extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-exact-url-malformed-"));
  const http: GitHubHttpClient = {
    async request(method) {
      if (method === "GET") {
        return {
          status: 200,
          headers: { link: `<:::not-a-url>; rel="next"` },
          body: { check_runs: [] },
        };
      }
      if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: {} };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects: new GitHubSideEffectStore(root),
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await assert.rejects(
    () => publisher.publishForHeadSha(run, "sha"),
    (error: unknown) => {
      assert.equal((error as Error).message, "GitHub check-run pagination Link URL is malformed");
      return true;
    },
  );
});

test("CheckPublisher preserves the exact 'Link URL is unsafe' message after pagination extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-exact-url-unsafe-"));
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET") {
        return {
          status: 200,
          headers: { link: `<${url.replace("https://api.github.com", "https://example.invalid")}>; rel="next"` },
          body: { check_runs: [] },
        };
      }
      if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: {} };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects: new GitHubSideEffectStore(root),
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await assert.rejects(
    () => publisher.publishForHeadSha(run, "sha"),
    (error: unknown) => {
      assert.equal((error as Error).message, "GitHub check-run pagination Link URL is unsafe");
      return true;
    },
  );
});

test("CheckPublisher preserves the exact 'page limit exceeded' message after pagination extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-exact-page-limit-"));
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET") {
        const next = new URL(url);
        next.searchParams.set("page", String((Number(next.searchParams.get("page")) || 1) + 1));
        return {
          status: 200,
          headers: { link: `<${next.toString()}>; rel="next"` },
          body: { check_runs: [] },
        };
      }
      if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: {} };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects: new GitHubSideEffectStore(root),
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await assert.rejects(
    () => publisher.publishForHeadSha(run, "sha"),
    (error: unknown) => {
      assert.equal((error as Error).message, "GitHub check-run pagination page limit exceeded");
      return true;
    },
  );
});

test("CheckPublisher stops reconciliation at a finite page ceiling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-page-limit-"));
  let gets = 0;
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET") {
        gets += 1;
        const next = new URL(url);
        next.searchParams.set("page", String(gets + 1));
        return {
          status: 200,
          headers: { link: `<${next.toString()}>; rel="next"` },
          body: { check_runs: [] },
        };
      }
      if (method === "POST") return { status: 201, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: {} };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects: new GitHubSideEffectStore(root),
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await assert.rejects(
    () => publisher.publishForHeadSha(run, "sha"),
    /pagination|page limit/i,
  );
  assert.ok(gets > 1);
  assert.ok(gets <= 20);
});

test("CheckPublisher fails closed when a successful list response omits check_runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-malformed-list-"));
  let posts = 0;
  const publisher = new CheckPublisher({
    http: {
      async request(method) {
        if (method === "GET") {
          return { status: 200, headers: {}, body: { total_count: 0 } };
        }
        if (method === "POST") posts += 1;
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    },
    sideEffects: new GitHubSideEffectStore(root),
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await assert.rejects(
    () => publisher.publishForHeadSha(run, "sha"),
    /check_runs.*malformed/i,
  );
  assert.equal(posts, 0);
});

test("CheckPublisher reconciles and cancels prior-SHA checks when local side effects are missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-missing-prior-side-effect-"));
  const patches: unknown[] = [];
  let nextId = 900;
  const publisher = new CheckPublisher({
    http: {
      async request(method, url, options) {
        if (method === "GET") {
          const parsed = new URL(url);
          const checkName = parsed.searchParams.get("check_name")!;
          const headSha = parsed.pathname.split("/").at(-2)!;
          if (headSha === "sha-old") {
            const key = `check-run:owner/repo/1/sha-old/${checkName}/1`;
            return {
              status: 200,
              headers: {},
              body: { check_runs: [{ id: nextId++, external_id: externalIdFor(key) }] },
            };
          }
          return { status: 200, headers: {}, body: { check_runs: [] } };
        }
        if (method === "PATCH") {
          patches.push(options?.body);
          return { status: 200, headers: {}, body: {} };
        }
        return { status: 201, headers: {}, body: { id: nextId++ } };
      },
    },
    sideEffects: new GitHubSideEffectStore(root),
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await publisher.publishForHeadSha(run, "sha-new", { previousHeadSha: "sha-old" });

  assert.equal(patches.length, 4);
  assert.deepEqual(
    patches.map((body) => (body as { conclusion?: string }).conclusion),
    Array(4).fill("cancelled"),
  );
});

test("CheckPublisher creates checks idempotently and invalidates prior SHA success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-checks-"));
  const sideEffects = new GitHubSideEffectStore(root);
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let nextId = 1;
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      calls.push({ method, url, body: options?.body });
      if (method === "GET") {
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      if (method === "POST" && url.includes("/check-runs")) {
        const id = nextId++;
        return { status: 201, headers: {}, body: { id } };
      }
      if (method === "PATCH" && url.includes("/check-runs/")) {
        return { status: 200, headers: {}, body: { id: Number(url.split("/").pop()) } };
      }
      return { status: 200, headers: {}, body: {} };
    },
  };

  const publisher = new CheckPublisher({
    http,
    sideEffects,
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
  });

  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
    evidence: {
      quality: { headSha: "sha1", passed: true, at: "t" },
      verification: { headSha: "sha1", passed: true, at: "t" },
    },
  } as RunRecord;

  const first = await publisher.publishForHeadSha(run, "sha1");
  assert.equal(first.createdOrUpdated.length, 4);
  const postCount = calls.filter((c) => c.method === "POST").length;
  assert.equal(postCount, 4);

  // Idempotent retry: no new POSTs for same SHA/attempt
  await publisher.publishForHeadSha(run, "sha1");
  assert.equal(calls.filter((c) => c.method === "POST").length, 4);

  // New SHA: prior success invalidated via PATCH cancel/neutral, new checks for sha2
  run.evidence = {
    quality: { headSha: "sha2", passed: true, at: "t" },
    verification: { headSha: "sha2", passed: true, at: "t" },
  };
  await publisher.publishForHeadSha(run, "sha2", { previousHeadSha: "sha1" });
  assert.ok(calls.some((c) => c.method === "PATCH"));
  assert.ok(calls.filter((c) => c.method === "POST").length >= 8);
});

test("CheckPublisher surfaces rate limits without recording success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-rl-"));
  const sideEffects = new GitHubSideEffectStore(root);
  let calls = 0;
  const http: GitHubHttpClient = {
    async request() {
      calls += 1;
      return {
        status: 403,
        headers: {
          "X-RaTeLiMiT-ReMaInInG": "0",
          "X-RaTeLiMiT-ReSeT": "9999999999",
        },
        body: { message: "forbidden" },
      };
    },
  };
  const publisher = new CheckPublisher({
    http,
    sideEffects,
    readOnlyChecks: true,
    owner: "owner",
    repo: "repo",
    pullRequestNumber: 1,
    token: "token",
    maxRateLimitRetries: 2,
    sleepFn: async () => {},
  });
  const run = {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;

  await assert.rejects(() => publisher.publishForHeadSha(run, "sha"), /rate limit/i);
  assert.ok(calls > 1);
  assert.equal(await sideEffects.get("check-run:owner/repo/1/sha/MASWE / specification compliance/1"), undefined);
});
