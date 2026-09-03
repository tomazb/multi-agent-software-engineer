import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubHttpClient } from "../src/github/http.ts";
import {
  readGitHubPullRequestSnapshot,
  type GitHubPullRequestSnapshot,
} from "../src/github/pull-request.ts";

const TARGET_REPOSITORY_ID = 4242;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "open",
    head: {
      sha: "a".repeat(40),
      ref: "maswe/run-1",
      repo: { id: TARGET_REPOSITORY_ID, full_name: "owner/repo" },
    },
    base: {
      sha: "b".repeat(40),
      ref: "main",
      repo: { id: TARGET_REPOSITORY_ID, full_name: "owner/repo" },
    },
    ...overrides,
  };
}

function httpReturning(
  body: unknown,
  status = 200,
  record?: (method: string, url: string, headers: Record<string, string> | undefined) => void,
): GitHubHttpClient {
  return {
    async request(method, url, options) {
      record?.(method, url, options?.headers);
      return { status, headers: {}, body };
    },
  };
}

async function read(body: unknown, status = 200): Promise<GitHubPullRequestSnapshot> {
  return readGitHubPullRequestSnapshot({
    http: httpReturning(body, status),
    token: "ghs_pull_request_read",
    repository: "owner/repo",
    pullRequestNumber: 9,
  });
}

test("readGitHubPullRequestSnapshot reads the documented PR endpoint and parses the exact target", async () => {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> | undefined }> = [];
  const snapshot = await readGitHubPullRequestSnapshot({
    http: httpReturning(payload(), 200, (method, url, headers) => {
      calls.push({ method, url, headers });
    }),
    token: "ghs_pull_request_read",
    repository: "owner/repo",
    pullRequestNumber: 9,
  });

  assert.deepEqual(snapshot, {
    state: "open",
    headSha: "a".repeat(40),
    headRef: "maswe/run-1",
    baseSha: "b".repeat(40),
    baseRef: "main",
    baseRepositoryId: TARGET_REPOSITORY_ID,
    baseRepository: "owner/repo",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, "https://api.github.com/repos/owner/repo/pulls/9");
  assert.equal(calls[0]!.headers?.authorization, "Bearer ghs_pull_request_read");
  assert.equal(calls[0]!.headers?.accept, "application/vnd.github+json");
});

test("readGitHubPullRequestSnapshot parses a closed PR", async () => {
  const snapshot = await read(payload({ state: "closed" }));
  assert.equal(snapshot.state, "closed");
});

test("readGitHubPullRequestSnapshot keeps a fork PR whose head repository differs from base", async () => {
  const snapshot = await read(payload({
    head: {
      sha: "c".repeat(40),
      ref: "fork-feature",
      repo: { id: 999_111, full_name: "forker/repo-fork" },
    },
  }));

  // The caller's ownership proof compares ONLY base.repo.id to the stable
  // target ID. A fork's differing head repository must never invalidate it.
  assert.equal(snapshot.baseRepositoryId, TARGET_REPOSITORY_ID);
  assert.equal(snapshot.baseRepository, "owner/repo");
  assert.equal(snapshot.headSha, "c".repeat(40));
  assert.equal(snapshot.headRef, "fork-feature");
  assert.equal(
    snapshot.baseRepositoryId === TARGET_REPOSITORY_ID,
    true,
    "fork PR must still prove ownership through its base repository id",
  );
});

test("readGitHubPullRequestSnapshot keeps a fork PR whose head repository was deleted", async () => {
  const snapshot = await read(payload({
    head: { sha: "d".repeat(40), ref: "deleted-fork", repo: null },
  }));
  assert.equal(snapshot.baseRepositoryId, TARGET_REPOSITORY_ID);
  assert.equal(snapshot.headSha, "d".repeat(40));
});

test("readGitHubPullRequestSnapshot never reads head.repo at all", async () => {
  const body = payload();
  const head = body.head as Record<string, unknown>;
  delete head.repo;
  Object.defineProperty(head, "repo", {
    enumerable: true,
    get() {
      throw new Error("head.repo must never be read for ownership proof");
    },
  });

  const snapshot = await read(body);
  assert.equal(snapshot.baseRepositoryId, TARGET_REPOSITORY_ID);
});

test("readGitHubPullRequestSnapshot rejects a missing base repository identity", async () => {
  await assert.rejects(
    read(payload({ base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "owner/repo" } } })),
    /base repository id/i,
  );
  await assert.rejects(
    read(payload({ base: { sha: "b".repeat(40), ref: "main", repo: null } })),
    /base repository id/i,
  );
  await assert.rejects(
    read(payload({ base: { sha: "b".repeat(40), ref: "main" } })),
    /base repository id/i,
  );
});

test("readGitHubPullRequestSnapshot rejects a malformed base repository id", async () => {
  for (const id of ["4242", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, null]) {
    await assert.rejects(
      read(payload({
        base: { sha: "b".repeat(40), ref: "main", repo: { id, full_name: "owner/repo" } },
      })),
      /base repository id/i,
      `base.repo.id ${String(id)} must be rejected`,
    );
  }
});

test("readGitHubPullRequestSnapshot rejects a missing base repository canonical name", async () => {
  await assert.rejects(
    read(payload({
      base: { sha: "b".repeat(40), ref: "main", repo: { id: TARGET_REPOSITORY_ID } },
    })),
    /base repository name/i,
  );
  await assert.rejects(
    read(payload({
      base: { sha: "b".repeat(40), ref: "main", repo: { id: TARGET_REPOSITORY_ID, full_name: "owner" } },
    })),
    /base repository name/i,
  );
});

test("readGitHubPullRequestSnapshot rejects a malformed state", async () => {
  for (const state of ["merged", "OPEN", undefined, 1]) {
    await assert.rejects(read(payload({ state })), /state/i, `state ${String(state)} must be rejected`);
  }
});

test("readGitHubPullRequestSnapshot rejects malformed head and base refs and SHAs", async () => {
  await assert.rejects(
    read(payload({ head: { ref: "maswe/run-1", repo: { id: 1, full_name: "o/r" } } })),
    /head\.sha/i,
  );
  await assert.rejects(
    read(payload({ head: { sha: "", ref: "maswe/run-1" } })),
    /head\.sha/i,
  );
  await assert.rejects(
    read(payload({ head: { sha: "a".repeat(40), ref: "" } })),
    /head\.ref/i,
  );
  await assert.rejects(
    read(payload({
      base: { sha: "", ref: "main", repo: { id: TARGET_REPOSITORY_ID, full_name: "owner/repo" } },
    })),
    /base\.sha/i,
  );
  await assert.rejects(
    read(payload({
      base: {
        sha: "b".repeat(40),
        ref: 7,
        repo: { id: TARGET_REPOSITORY_ID, full_name: "owner/repo" },
      },
    })),
    /base\.ref/i,
  );
});

test("readGitHubPullRequestSnapshot rejects a non-2xx response and a non-object body", async () => {
  await assert.rejects(read(payload(), 404), /HTTP 404/);
  await assert.rejects(read(payload(), 500), /HTTP 500/);
  await assert.rejects(read("not-an-object"), /malformed|body/i);
  await assert.rejects(read(null), /malformed|body/i);
  await assert.rejects(read([payload()]), /malformed|body/i);
});

test("readGitHubPullRequestSnapshot rejects an invalid repository or pull request number", async () => {
  const http = httpReturning(payload());
  await assert.rejects(
    readGitHubPullRequestSnapshot({
      http,
      token: "t",
      repository: "owner/repo/extra",
      pullRequestNumber: 9,
    }),
    /Invalid repository/,
  );
  for (const pullRequestNumber of [0, -1, 1.5]) {
    await assert.rejects(
      readGitHubPullRequestSnapshot({ http, token: "t", repository: "owner/repo", pullRequestNumber }),
      /pull request number/i,
      `pull request number ${pullRequestNumber} must be rejected`,
    );
  }
});
