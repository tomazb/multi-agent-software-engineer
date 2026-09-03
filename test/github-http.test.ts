import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import { CheckPublisher } from "../src/github/checks.ts";
import { createFetchGitHubHttpClient } from "../src/github/http.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";

function emptyRun(): RunRecord {
  return {
    schemaVersion: 1,
    version: 1,
    id: "run-http-timeout",
    title: "timeout",
    request: "timeout",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  };
}

test("fetch GitHub HTTP client aborts a never-settling request at its injected deadline", async () => {
  let suppliedSignal: AbortSignal | undefined;
  const fetchFn: typeof fetch = async (_input, init) => {
    suppliedSignal = init?.signal ?? undefined;
    if (!suppliedSignal) throw new Error("fetch was called without an AbortSignal");
    return new Promise<Response>((_resolve, reject) => {
      suppliedSignal!.addEventListener(
        "abort",
        () => reject(suppliedSignal!.reason),
        { once: true },
      );
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const http = createFetchGitHubHttpClient({ timeoutMs: 15, fetchFn });
    await assert.rejects(
      () =>
        http.request("POST", "https://api.github.com/app/installations/9/access_tokens", {
          headers: { authorization: "Bearer secret-token" },
          body: { private: "secret-body" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GitHub HTTP request timed out after 15ms/);
        assert.doesNotMatch(error.message, /secret-token|secret-body/);
        return true;
      },
    );
    assert.ok(suppliedSignal instanceof AbortSignal);
    assert.equal(suppliedSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("each bounded rate-limit retry receives a fresh request deadline", async (t) => {
  const signals: AbortSignal[] = [];
  let requestCount = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    signals.push(init.signal);
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-http-retry-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const publisher = new CheckPublisher({
      http: createFetchGitHubHttpClient({ timeoutMs: 15, fetchFn }),
      sideEffects: new GitHubSideEffectStore(root),
      readOnlyChecks: true,
      repositoryId: 424242,
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 1,
      token: "token",
      maxRateLimitRetries: 1,
      sleepFn: async () => undefined,
    });

    await assert.rejects(
      () => publisher.publishForHeadSha(emptyRun(), "head-sha"),
      /GitHub HTTP request timed out after 15ms/,
    );
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(signals[0]!.aborted, false);
    assert.equal(signals[1]!.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
