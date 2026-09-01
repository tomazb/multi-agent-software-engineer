import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { writeDurableAtomic } from "../src/durable-file.ts";
import { GitHubAppAdapter, type WebhookHandleResult } from "../src/github/adapter.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { FileRunStore, type RunStore } from "../src/store.ts";

const SECRET = "integration-webhook-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_SECRET";
const tempDirectories = new Set<string>();

after(async () => {
  await Promise.all([...tempDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

function testConfig() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
    },
  });
}

async function setup(options: {
  liveHead?: string;
  liveState?: "open" | "closed";
  afterManualRunLoaded?: (runId: string) => Promise<void>;
  beforeAssociationTransaction?: (deliveryId: string) => Promise<void>;
  afterAssociationCommitBeforeRouting?: (runId: string) => Promise<void>;
  beforeCheckPost?: (headSha: string) => Promise<void>;
  associationWriteRecords?: (filePath: string, content: string) => Promise<void>;
  wrapStore?: (store: FileRunStore) => RunStore;
} = {}) {
  const beforeCheckPost = options.beforeCheckPost;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-int-"));
  tempDirectories.add(cwd);
  const store = new FileRunStore(cwd);
  const adapterStore = options.wrapStore?.(store) ?? store;
  const config = testConfig();
  const posts: unknown[] = [];
  const checkRunHeadShas = new Map<number, string>();
  const patches: Array<{ url: string; body: unknown; headSha: string | undefined }> = [];
  const tokens: Array<{ installationId: number; repository: string }> = [];
  let nextId = 1;
  let rateLimitOnce = false;
  let liveHead = options.liveHead;
  let liveState = options.liveState ?? "open";
  let failAll = false;
  let failPatchForHeadOnce: string | undefined;
  let pullHeadLookups = 0;
  const http: GitHubHttpClient = {
    async request(method, url, options) {
      if (failAll) {
        return {
          status: 500,
          headers: {},
          body: { message: "forced failure" },
        };
      }
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
          body: { message: "API rate limit exceeded" },
        };
      }
      if (method === "GET" && url.includes("/pulls/")) {
        pullHeadLookups += 1;
        return {
          status: 200,
          headers: {},
          body: { head: { sha: liveHead ?? "unknown" }, state: liveState },
        };
      }
      if (method === "GET" && url.includes("/check-runs")) {
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      if (method === "POST" && url.includes("/check-runs")) {
        const headSha = (options?.body as { head_sha?: unknown } | undefined)?.head_sha;
        if (typeof headSha === "string") await beforeCheckPost?.(headSha);
        posts.push(options?.body);
        const id = nextId++;
        if (typeof headSha === "string") checkRunHeadShas.set(id, headSha);
        return { status: 201, headers: {}, body: { id } };
      }
      if (method === "PATCH") {
        const checkRunId = Number(url.match(/\/check-runs\/(\d+)$/)?.[1]);
        const patchHeadSha = checkRunHeadShas.get(checkRunId);
        if (failPatchForHeadOnce !== undefined && patchHeadSha === failPatchForHeadOnce) {
          failPatchForHeadOnce = undefined;
          return { status: 500, headers: {}, body: { message: "forced patch failure" } };
        }
        patches.push({
          url,
          body: options?.body,
          headSha: patchHeadSha,
        });
        return { status: 200, headers: {}, body: { id: 1 } };
      }
      return { status: 200, headers: {}, body: {} };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store: adapterStore,
    http,
    tokenProvider: async (installationId, repository) => {
      tokens.push({ installationId, repository });
      return "test-token";
    },
    ...(options.afterManualRunLoaded
      ? { afterManualRunLoaded: options.afterManualRunLoaded }
      : {}),
    ...(options.beforeAssociationTransaction
      ? { beforeAssociationTransaction: options.beforeAssociationTransaction }
      : {}),
    ...(options.afterAssociationCommitBeforeRouting
      ? { afterAssociationCommitBeforeRouting: options.afterAssociationCommitBeforeRouting }
      : {}),
    ...(options.associationWriteRecords
      ? { associationWriteRecords: options.associationWriteRecords }
      : {}),
    synchronousWebhookDispatch: true,
  });
  return {
    cwd,
    store,
    adapter,
    posts,
    patches,
    tokens,
    pullHeadLookups() {
      return pullHeadLookups;
    },
    setLiveHead(sha: string) {
      liveHead = sha;
    },
    setLiveState(state: "open" | "closed") {
      liveState = state;
    },
    enableRateLimitOnce() {
      rateLimitOnce = true;
    },
    setFailAll(value: boolean) {
      failAll = value;
    },
    failNextPatchForHead(sha: string) {
      failPatchForHeadOnce = sha;
    },
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withWatchdog<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForInitialDeliveryRetry(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
}

async function completeRetryableDelivery(
  deliver: () => Promise<WebhookHandleResult>,
): Promise<WebhookHandleResult> {
  let response = await deliver();
  if (response.status === 202) {
    assert.equal(response.body.duplicate, true);
    await waitForInitialDeliveryRetry();
    response = await deliver();
  }
  assert.equal(response.status, 200);
  return response;
}

function twoPartyBarrier(): (identity: string) => Promise<void> {
  const release = deferred();
  const arrivals = new Set<string>();
  return async (identity: string) => {
    arrivals.add(identity);
    if (arrivals.size === 2) release.resolve();
    await withWatchdog(release.promise, 5_000, "association barrier timed out");
  };
}

function prPayload(headSha: string, number = 9, action = "synchronize") {
  return {
    action,
    installation: { id: 44 },
    repository: { id: 1308655205, full_name: "owner/repo" },
    pull_request: {
      number,
      head: { sha: headSha, ref: "maswe/run-1" },
      base: { sha: "basebase" },
    },
  };
}

test("integration: forged signature makes no durable state change before initialization", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-forged-preauth-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: testConfig(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("forged request must not reach GitHub"); } },
    tokenProvider: async () => {
      throw new Error("forged request must not create a token");
    },
  });
  const githubRoot = path.join(cwd, ".maswe", "github");
  await assert.rejects(access(githubRoot), { code: "ENOENT" });
  const body = JSON.stringify(prPayload("sha1"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-forged",
    eventName: "pull_request",
    signatureHeader: sign("tampered"),
    rawBody: body,
  });
  assert.equal(result.status, 401);
  await assert.rejects(access(githubRoot), { code: "ENOENT" });
});

test("integration: replayed completed delivery does not duplicate checks", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, store } = await setup({ liveHead: "sha1" });
  const run = await store.create("assoc", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha1",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  run.evidence = {
    quality: { headSha: "sha1", passed: true, at: "t" },
    verification: { headSha: "sha1", passed: true, at: "t" },
  };
  await store.save(run);

  const body = JSON.stringify(prPayload("sha1"));
  const first = await adapter.handleWebhook({
    deliveryId: "del-replay",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(first.status, 200);
  const postCount = posts.length;
  assert.ok(postCount >= 4);

  const second = await adapter.handleWebhook({
    deliveryId: "del-replay",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(posts.length, postCount);
});

test("integration: failed delivery can be retried with the same id", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, setFailAll, posts } = await setup({ liveHead: "sha-rl" });
  setFailAll(true);
  const body = JSON.stringify(prPayload("sha-rl"));
  await assert.rejects(
    () =>
      adapter.handleWebhook({
        deliveryId: "del-rl-retry",
        eventName: "pull_request",
        signatureHeader: sign(body),
        rawBody: body,
      }),
    /forced failure|HTTP 500/i,
  );
  setFailAll(false);
  await completeRetryableDelivery(() => adapter.handleWebhook({
    deliveryId: "del-rl-retry",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  }));
  assert.ok(posts.length >= 4);
});

test("integration: unassociated PR uses the event installation token", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, tokens, posts } = await setup({ liveHead: "sha-u" });
  const body = JSON.stringify(prPayload("sha-u"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-unassoc",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.ok(tokens.some((t) => t.installationId === 44 && t.repository === "owner/repo"));
  assert.ok(posts.length >= 4);
});

test("integration: new head SHA invalidates prior success conclusions", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, patches, store, setLiveHead } = await setup({ liveHead: "sha1" });
  const run = await store.create("sha-order", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha1",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  run.evidence = {
    quality: { headSha: "sha1", passed: true, at: "t" },
    verification: { headSha: "sha1", passed: true, at: "t" },
  };
  await store.save(run);

  const body1 = JSON.stringify(prPayload("sha1"));
  await adapter.handleWebhook({
    deliveryId: "del-sha1",
    eventName: "pull_request",
    signatureHeader: sign(body1),
    rawBody: body1,
  });

  setLiveHead("sha2");
  const body2 = JSON.stringify(prPayload("sha2"));
  await adapter.handleWebhook({
    deliveryId: "del-sha2",
    eventName: "pull_request",
    signatureHeader: sign(body2),
    rawBody: body2,
  });
  assert.ok(patches.length > 0);
  const sha2Quality = posts.filter(
    (body) =>
      (body as { head_sha?: string; name?: string }).head_sha === "sha2" &&
      (body as { name?: string }).name === "MASWE / deterministic quality",
  );
  assert.ok(sha2Quality.length >= 1);
  assert.equal((sha2Quality[0] as { conclusion: string }).conclusion, "neutral");

  const loaded = await store.load(run.id);
  assert.equal(loaded.evidence?.quality, undefined);
  assert.equal(loaded.github?.headSha, "sha2");
});

test("integration: the post-association seam is event-free before equal-target evidence recovery", async () => {
  process.env[SECRET_ENV] = SECRET;
  const priorHead = "a".repeat(40);
  const routedHead = "b".repeat(40);
  let authoritativeStore: FileRunStore;
  let snapshotAtSeam: Awaited<ReturnType<FileRunStore["load"]>> | undefined;
  const { adapter, store, cwd } = await setup({
    liveHead: routedHead,
    afterAssociationCommitBeforeRouting: async (runId) => {
      snapshotAtSeam = await authoritativeStore.load(runId);
    },
  });
  authoritativeStore = store;
  const run = await store.create("association-routing-seam", "req", testConfig());
  run.state = "PR_REVIEW";
  run.workspace = {
    baseSha: "base",
    headSha: routedHead,
    branch: "maswe/run-1",
    fingerprint: "f".repeat(64),
    remote: "https://github.com/owner/repo.git",
  };
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: priorHead,
    branch: "maswe/run-1",
    suspended: false,
  };
  run.evidence = {
    quality: { headSha: priorHead, passed: true, at: "t" },
    verification: { headSha: priorHead, passed: true, at: "t" },
  };
  await store.save(run);
  await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: priorHead,
    branch: "maswe/run-1",
  });
  const priorEvents = structuredClone(run.events);
  const body = JSON.stringify(prPayload(routedHead));

  await adapter.handleWebhook({
    deliveryId: "del-association-routing-seam",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(snapshotAtSeam?.github?.headSha, routedHead);
  assert.equal(snapshotAtSeam?.evidence, undefined);
  assert.equal(snapshotAtSeam?.revalidation, undefined);
  assert.deepEqual(snapshotAtSeam?.events, priorEvents);
  const routed = await store.load(run.id);
  assert.equal(routed.state, "CI_RUNNING");
  assert.equal(routed.revalidation?.originHeadSha, routedHead);
  assert.equal(routed.revalidation?.requestedHeadSha, routedHead);
  assert.equal(routed.revalidation?.returnState, "PR_REVIEW");
  assert.equal(routed.events.at(-1)?.type, "REVALIDATE_REQUESTED");
});

test("integration: pending cancellation heads cannot replace a missing authoritative workflow target", async () => {
  process.env[SECRET_ENV] = SECRET;
  const routedHead = "b".repeat(40);
  const { adapter, store, cwd } = await setup({ liveHead: routedHead });
  const run = await store.create("missing-routing-target", "req", testConfig());
  run.state = "PR_REVIEW";
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: routedHead,
    branch: "maswe/run-1",
    suspended: false,
    pendingCancellationHeadShas: ["a".repeat(40), "c".repeat(40)],
  };
  await store.save(run);
  await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: routedHead,
    branch: "maswe/run-1",
  });
  const priorEvents = structuredClone(run.events);
  const body = JSON.stringify(prPayload(routedHead));

  await assert.rejects(
    adapter.handleWebhook({
      deliveryId: "del-missing-routing-target",
      eventName: "pull_request",
      signatureHeader: sign(body),
      rawBody: body,
    }),
    /has no authoritative workflow target/i,
  );

  const after = await store.load(run.id);
  assert.equal(after.revalidation, undefined);
  assert.deepEqual(after.events, priorEvents);
});

test("integration: retry remembers every old head until cancellation publication succeeds", async () => {
  process.env[SECRET_ENV] = SECRET;
  const {
    adapter,
    patches,
    store,
    cwd,
    setLiveHead,
    failNextPatchForHead,
  } = await setup({ liveHead: "sha-old" });
  const run = await store.create("cancellation-retry", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-old",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-old",
    branch: "maswe/run-1",
  });
  await adapter.publishChecksForRun(run.id);

  setLiveHead("sha-new");
  failNextPatchForHead("sha-old");
  const body = JSON.stringify(prPayload("sha-new"));
  const request = {
    deliveryId: "del-cancellation-retry",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  };
  await assert.rejects(adapter.handleWebhook(request), /HTTP 500/);
  assert.equal((await store.load(run.id)).github?.headSha, "sha-new");

  await completeRetryableDelivery(() => adapter.handleWebhook(request));
  assert.equal(
    patches.filter((patch) => patch.headSha === "sha-old").length,
    4,
  );
});

test("integration: a 65th pending cancellation fails closed without changing durable state", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd } = await setup({ liveHead: "sha-new" });
  const run = await store.create("cancellation-overflow", "req", testConfig());
  const pendingCancellationHeadShas = Array.from(
    { length: 64 },
    (_, index) => `retained-head-${index.toString().padStart(2, "0")}`,
  );
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-previous",
    branch: "maswe/run-1",
    suspended: false,
    pendingCancellationHeadShas,
  };
  await store.save(run);
  await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-previous",
    branch: "maswe/run-1",
  });
  const before = await store.load(run.id);
  const body = JSON.stringify(prPayload("sha-new"));

  await assert.rejects(
    adapter.handleWebhook({
      deliveryId: "del-cancellation-overflow",
      eventName: "pull_request",
      signatureHeader: sign(body),
      rawBody: body,
    }),
    /pending check cancellation limit exceeded/i,
  );

  const after = await store.load(run.id);
  assert.equal(after.version, before.version);
  assert.equal(after.github?.headSha, "sha-previous");
  assert.deepEqual(after.github?.pendingCancellationHeadShas, pendingCancellationHeadShas);
  assert.equal(
    (await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).find("owner/repo", 9))
      ?.headSha,
    "sha-previous",
  );
});

test("integration: stale out-of-order head is ignored", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, setLiveHead } = await setup({ liveHead: "sha2" });
  const run = await store.create("stale", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha1",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);

  await adapter.handleWebhook({
    deliveryId: "del-newer",
    eventName: "pull_request",
    signatureHeader: sign(JSON.stringify(prPayload("sha2"))),
    rawBody: JSON.stringify(prPayload("sha2")),
  });
  assert.equal((await store.load(run.id)).github?.headSha, "sha2");

  setLiveHead("sha2");
  await adapter.handleWebhook({
    deliveryId: "del-stale",
    eventName: "pull_request",
    signatureHeader: sign(JSON.stringify(prPayload("sha1"))),
    rawBody: JSON.stringify(prPayload("sha1")),
  });
  assert.equal((await store.load(run.id)).github?.headSha, "sha2");
});

test("integration: first-seen stale PR delivery is rejected against the live head", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, posts, pullHeadLookups } = await setup({ liveHead: "sha-live" });
  const run = await store.create("first-stale", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-stale",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);

  const body = JSON.stringify(prPayload("sha-stale"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-first-stale",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.equal(pullHeadLookups(), 1);
  assert.equal((await store.load(run.id)).github, undefined);
  assert.equal(posts.length, 0);
});

test("integration: matching local and event heads are rejected when the remote advanced", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd, posts, pullHeadLookups } = await setup({ liveHead: "sha-live" });
  const run = await store.create("locally-equal-stale", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-event",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-event",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-event",
    branch: "maswe/run-1",
  });

  const body = JSON.stringify(prPayload("sha-event"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-local-equals-stale",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.equal(pullHeadLookups(), 1);
  assert.equal((await store.load(run.id)).github?.headSha, "sha-event");
  assert.equal(posts.length, 0);
});

test("integration: pull request close suspends the index and run association", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd, posts } = await setup({
    liveHead: "sha-close",
    liveState: "closed",
  });
  const run = await store.create("close", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-close",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-close",
    branch: "maswe/run-1",
  });

  const body = JSON.stringify(prPayload("sha-close", 9, "closed"));
  const result = await adapter.handleWebhook({
    deliveryId: "del-close",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.equal((await index.find("owner/repo", 9))?.suspended, true);
  assert.equal(
    (await index.find("owner/repo", 9))?.suspensionReason,
    "pull-request-closed",
  );
  assert.equal((await store.load(run.id)).github?.suspended, true);
  assert.equal(
    (await store.load(run.id)).github?.suspensionReason,
    "pull-request-closed",
  );
  assert.deepEqual(await index.findAllByRepositoryBranch("owner/repo", "maswe/run-1"), []);
  assert.equal(posts.length, 0);
});

test("integration: a reopened PR clears only closure suspension and republishes", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd, posts, setLiveState } = await setup({
    liveHead: "sha-reopen",
    liveState: "closed",
  });
  const run = await store.create("close-reopen", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-reopen",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-reopen",
    branch: "maswe/run-1",
  });
  const closeBody = JSON.stringify(prPayload("sha-reopen", 9, "closed"));
  await adapter.handleWebhook({
    deliveryId: "del-close-before-reopen",
    eventName: "pull_request",
    signatureHeader: sign(closeBody),
    rawBody: closeBody,
  });

  setLiveState("open");
  const reopenBody = JSON.stringify(prPayload("sha-reopen", 9, "reopened"));
  assert.equal((await adapter.handleWebhook({
    deliveryId: "del-reopen-after-close",
    eventName: "pull_request",
    signatureHeader: sign(reopenBody),
    rawBody: reopenBody,
  })).status, 200);

  assert.equal((await index.find("owner/repo", 9))?.suspended, false);
  assert.equal((await index.find("owner/repo", 9))?.suspensionReason, undefined);
  assert.equal((await store.load(run.id)).github?.suspended, false);
  assert.equal((await store.load(run.id)).github?.suspensionReason, undefined);
  assert.equal(posts.length, 4);
});

test("integration: delayed close cannot re-suspend a reopened live PR", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd, posts } = await setup({
    liveHead: "sha-lifecycle",
    liveState: "open",
  });
  const run = await store.create("delayed-close", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-lifecycle",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-lifecycle",
    branch: "maswe/run-1",
  });
  const body = JSON.stringify(prPayload("sha-lifecycle", 9, "closed"));

  assert.equal((await adapter.handleWebhook({
    deliveryId: "del-stale-close-after-reopen",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  })).status, 200);

  assert.equal((await index.find("owner/repo", 9))?.suspended, false);
  assert.equal((await store.load(run.id)).github?.suspended, false);
  assert.equal(posts.length, 0);
});

test("integration: delayed reopen cannot clear a reclosed live PR", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd, posts } = await setup({
    liveHead: "sha-lifecycle",
    liveState: "closed",
  });
  const run = await store.create("delayed-reopen", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-lifecycle",
    branch: "maswe/run-1",
    suspended: true,
    suspensionReason: "pull-request-closed",
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-lifecycle",
    branch: "maswe/run-1",
    suspended: true,
    suspensionReason: "pull-request-closed",
  });
  const body = JSON.stringify(prPayload("sha-lifecycle", 9, "reopened"));

  assert.equal((await adapter.handleWebhook({
    deliveryId: "del-stale-reopen-after-reclose",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  })).status, 200);

  assert.equal((await index.find("owner/repo", 9))?.suspended, true);
  assert.equal((await index.find("owner/repo", 9))?.suspensionReason, "pull-request-closed");
  assert.equal((await store.load(run.id)).github?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspensionReason, "pull-request-closed");
  assert.equal(posts.length, 0);
});

test("integration: installation deletion suspension cannot be cleared by reopen", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, cwd, store, posts } = await setup({ liveHead: "sha-after-suspend" });
  const run = await store.create("suspend-me", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
  });

  const body = JSON.stringify({ action: "deleted", installation: { id: 44 } });
  const result = await adapter.handleWebhook({
    deliveryId: "del-install",
    eventName: "installation",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.equal((await index.find("owner/repo", 9))?.suspended, true);
  assert.equal(
    (await index.find("owner/repo", 9))?.suspensionReason,
    "authorization-revoked",
  );
  assert.equal((await store.load(run.id)).github?.suspended, true);
  assert.equal(
    (await store.load(run.id)).github?.suspensionReason,
    "authorization-revoked",
  );

  const syncBody = JSON.stringify(prPayload("sha-after-suspend", 9, "reopened"));
  const after = await adapter.handleWebhook({
    deliveryId: "del-after-suspend",
    eventName: "pull_request",
    signatureHeader: sign(syncBody),
    rawBody: syncBody,
  });
  assert.equal(after.status, 200);
  assert.equal(posts.length, 0);
});

test("integration: does not steal another PR's associated run", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store } = await setup({ liveHead: "other" });
  const run = await store.create("pr-one", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "maswe/other",
    suspended: false,
  };
  run.workspace = {
    baseSha: "b",
    headSha: "h",
    branch: "maswe/other",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);

  const body = JSON.stringify(prPayload("other", 99));
  await adapter.handleWebhook({
    deliveryId: "del-other-pr",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  const loaded = await store.load(run.id);
  assert.equal(loaded.github?.pullRequestNumber, 1);
  assert.equal(loaded.github?.headSha, "h");
});

test("integration: push events invalidate every matching PR association", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, posts, patches, store, cwd, setLiveHead } = await setup({
    liveHead: "old-first",
  });
  const firstRun = await store.create("first-push-run", "req", testConfig());
  firstRun.workspace = {
    baseSha: "base",
    headSha: "old-first",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  firstRun.evidence = {
    quality: { headSha: "old-first", passed: true, at: "t" },
    verification: { headSha: "old-first", passed: true, at: "t" },
    mergeReady: { headSha: "old-first", passed: true, at: "t" },
  };
  firstRun.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "old-first",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(firstRun);

  const secondRun = await store.create("second-push-run", "req", testConfig());
  secondRun.workspace = {
    baseSha: "base",
    headSha: "old-second",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  secondRun.evidence = {
    quality: { headSha: "old-second", passed: true, at: "t" },
    verification: { headSha: "old-second", passed: true, at: "t" },
    mergeReady: { headSha: "old-second", passed: true, at: "t" },
  };
  secondRun.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 10,
    baseSha: "base",
    headSha: "old-second",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(secondRun);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: firstRun.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "old-first",
    branch: "maswe/run-1",
  });
  await index.bind({
    runId: secondRun.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 10,
    baseSha: "base",
    headSha: "old-second",
    branch: "maswe/run-1",
  });

  await adapter.publishChecksForRun(firstRun.id);
  setLiveHead("old-second");
  await adapter.publishChecksForRun(secondRun.id);
  const postCountBeforePush = posts.length;

  setLiveHead("sha-push");
  const body = JSON.stringify({
    ref: "refs/heads/maswe/run-1",
    after: "sha-push",
    installation: { id: 44 },
    repository: { id: 1308655205, full_name: "owner/repo" },
  });
  const result = await adapter.handleWebhook({
    deliveryId: "del-push",
    eventName: "push",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  const loadedFirst = await store.load(firstRun.id);
  const loadedSecond = await store.load(secondRun.id);
  assert.equal(loadedFirst.github?.headSha, "sha-push");
  assert.equal(loadedFirst.evidence?.quality, undefined);
  assert.equal(loadedFirst.evidence?.verification, undefined);
  assert.equal(loadedFirst.evidence?.mergeReady, undefined);
  assert.equal(loadedSecond.github?.headSha, "sha-push");
  assert.equal(loadedSecond.evidence?.quality, undefined);
  assert.equal(loadedSecond.evidence?.verification, undefined);
  assert.equal(loadedSecond.evidence?.mergeReady, undefined);

  assert.equal(patches.filter((patch) => patch.headSha === "old-first").length, 4);
  assert.equal(patches.filter((patch) => patch.headSha === "old-second").length, 4);
  assert.deepEqual(
    patches.map((patch) => (patch.body as { conclusion?: string }).conclusion),
    Array(8).fill("cancelled"),
  );
  assert.equal(
    posts
      .slice(postCountBeforePush)
      .filter((post) => {
        const headSha = (post as { head_sha?: unknown }).head_sha;
        return typeof headSha === "string" && ["old-first", "old-second"].includes(headSha);
      })
      .length,
    0,
  );
});

test("integration: push attempts later PRs before reporting an earlier invalidation failure", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { cwd, store } = await setup();
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  const runs = [];
  for (const pullRequestNumber of [9, 10]) {
    const run = await store.create(`fanout-${pullRequestNumber}`, "req", testConfig());
    run.github = {
      installationId: 44,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: `old-${pullRequestNumber}`,
      branch: "maswe/run-1",
      suspended: false,
    };
    await store.save(run);
    await index.bind({
      runId: run.id,
      installationId: 44,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: `old-${pullRequestNumber}`,
      branch: "maswe/run-1",
    });
    runs.push(run);
  }
  let nextId = 500;
  const adapter = new GitHubAppAdapter({
    cwd,
    config: testConfig(),
    store,
    tokenProvider: async () => "token",
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/pulls/9")) {
          return { status: 500, headers: {}, body: {} };
        }
        if (method === "GET" && url.includes("/pulls/10")) {
          return { status: 200, headers: {}, body: { head: { sha: "sha-push" }, state: "open" } };
        }
        if (method === "GET" && url.includes("/check-runs")) {
          return { status: 200, headers: {}, body: { check_runs: [] } };
        }
        return { status: 201, headers: {}, body: { id: nextId++ } };
      },
    },
    synchronousWebhookDispatch: true,
  });
  const body = JSON.stringify({
    ref: "refs/heads/maswe/run-1",
    after: "sha-push",
    installation: { id: 44 },
    repository: { id: 1308655205, full_name: "owner/repo" },
  });

  await assert.rejects(
    () =>
      adapter.handleWebhook({
        deliveryId: "del-push-partial-failure",
        eventName: "push",
        signatureHeader: sign(body),
        rawBody: body,
      }),
    /current PR head|invalidation/i,
  );

  assert.equal((await store.load(runs[0]!.id)).github?.headSha, "old-9");
  assert.equal((await store.load(runs[1]!.id)).github?.headSha, "sha-push");
});

test("integration: a manual publisher revalidates inside the fence after a newer head wins", async () => {
  process.env[SECRET_ENV] = SECRET;
  const manualLoaded = deferred();
  const releaseManual = deferred();
  const { adapter, store, cwd, posts, setLiveHead } = await setup({
    liveHead: "sha-old",
    afterManualRunLoaded: async () => {
      manualLoaded.resolve();
      await releaseManual.promise;
    },
  });
  const run = await store.create("manual-fence", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-old",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-old",
    branch: "maswe/run-1",
  });

  const manual = adapter.publishChecksForRun(run.id);
  await withWatchdog(manualLoaded.promise, 1_000, "manual-load barrier timed out");
  setLiveHead("sha-new");
  const body = JSON.stringify(prPayload("sha-new"));
  await adapter.handleWebhook({
    deliveryId: "del-manual-fence-new-head",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  releaseManual.resolve();
  await manual;

  assert.equal(
    posts.filter((post) => (post as { head_sha?: string }).head_sha === "sha-old").length,
    0,
  );
  assert.equal((await store.load(run.id)).github?.headSha, "sha-new");
});

test("integration: a blocked publication fence does not stall an unrelated pull request", async () => {
  process.env[SECRET_ENV] = SECRET;
  const blockedPostReached = deferred();
  const releaseBlockedPost = deferred();
  let blockFirstPost = true;
  const { adapter, store, cwd } = await setup({
    liveHead: "sha-shared",
    beforeCheckPost: async () => {
      if (!blockFirstPost) return;
      blockFirstPost = false;
      blockedPostReached.resolve();
      await releaseBlockedPost.promise;
    },
  });
  const runs = await Promise.all([
    store.create("publication-fence-one", "req", testConfig()),
    store.create("publication-fence-two", "req", testConfig()),
  ]);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  for (const [position, run] of runs.entries()) {
    const pullRequestNumber = position + 9;
    run.github = {
      installationId: 44,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: "sha-shared",
      branch: `maswe/run-${position + 1}`,
      suspended: false,
    };
    await store.save(run);
    await index.bind({
      runId: run.id,
      installationId: 44,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: "sha-shared",
      branch: `maswe/run-${position + 1}`,
    });
  }

  const blocked = adapter.publishChecksForRun(runs[0]!.id);
  await blockedPostReached.promise;
  const unrelated = adapter.publishChecksForRun(runs[1]!.id);
  try {
    await withWatchdog(unrelated, 5_000, "unrelated publication stalled");
  } finally {
    releaseBlockedPost.resolve();
    await Promise.allSettled([blocked, unrelated]);
  }
});

test("integration: simultaneous same-branch PRs associate one run at most once", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd } = await setup({
    liveHead: "sha-shared",
    beforeAssociationTransaction: twoPartyBarrier(),
  });
  const run = await store.create("association-race", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-shared",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);
  const requests = [9, 10].map((pullRequestNumber) => {
    const rawBody = JSON.stringify(prPayload("sha-shared", pullRequestNumber, "opened"));
    return adapter.handleWebhook({
      deliveryId: `del-association-race-${pullRequestNumber}`,
      eventName: "pull_request",
      signatureHeader: sign(rawBody),
      rawBody,
    });
  });

  await Promise.all(requests);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  const associated = await Promise.all([
    index.find("owner/repo", 9),
    index.find("owner/repo", 10),
  ]);
  assert.equal(associated.filter((record) => record?.runId === run.id).length, 1);
  assert.ok([9, 10].includes((await store.load(run.id)).github!.pullRequestNumber));
});

test("integration: association commit failure rolls back the run mutation", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd } = await setup({
    liveHead: "sha-rollback",
    associationWriteRecords: async () => {
      throw new Error("simulated association commit failure");
    },
  });
  const run = await store.create("association-rollback", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-rollback",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);
  const rawBody = JSON.stringify(prPayload("sha-rollback", 9, "opened"));

  await assert.rejects(
    adapter.handleWebhook({
      deliveryId: "del-association-commit-failure",
      eventName: "pull_request",
      signatureHeader: sign(rawBody),
      rawBody,
    }),
    /simulated association commit failure/,
  );

  assert.equal((await store.load(run.id)).github, undefined);
  assert.equal(
    await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).find(
      "owner/repo",
      9,
    ),
    undefined,
  );
});

test("integration: post-rename association sync failure never rolls back a committed close", async () => {
  process.env[SECRET_ENV] = SECRET;
  let failDirectorySync = true;
  const { adapter, store, cwd } = await setup({
    liveHead: "sha-close-outcome",
    liveState: "closed",
    associationWriteRecords: async (filePath, content) => writeDurableAtomic(
      filePath,
      content,
      "GitHub association index",
      {
        syncDirectory: async () => {
          if (failDirectorySync) {
            failDirectorySync = false;
            throw new Error("simulated post-rename association directory sync failure");
          }
        },
      },
    ),
  });
  const run = await store.create("close-outcome", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-close-outcome",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-close-outcome",
    branch: "maswe/run-1",
  });
  const rawBody = JSON.stringify(prPayload("sha-close-outcome", 9, "closed"));
  const request = {
    deliveryId: "del-close-post-rename",
    eventName: "pull_request",
    signatureHeader: sign(rawBody),
    rawBody,
  };

  await assert.rejects(adapter.handleWebhook(request), /post-rename|outcome|directory sync/i);
  assert.equal((await index.find("owner/repo", 9))?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspended, true);

  await completeRetryableDelivery(() => adapter.handleWebhook(request));
  assert.equal((await index.find("owner/repo", 9))?.suspensionReason, "pull-request-closed");
  assert.equal((await store.load(run.id)).github?.suspensionReason, "pull-request-closed");
});

test("integration: close redelivery rebuilds a lost association for the exact suspended PR", async () => {
  process.env[SECRET_ENV] = SECRET;
  let failDirectorySync = true;
  const { adapter, store, cwd } = await setup({
    liveHead: "sha-close-lost-index",
    liveState: "closed",
    associationWriteRecords: async (filePath, content) => writeDurableAtomic(
      filePath,
      content,
      "GitHub association index",
      {
        syncDirectory: async () => {
          if (failDirectorySync) {
            failDirectorySync = false;
            throw new Error("simulated post-rename association directory sync failure");
          }
        },
      },
    ),
  });
  const run = await store.create("close-lost-index", "req", testConfig());
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-close-lost-index",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const rawBody = JSON.stringify(prPayload("sha-close-lost-index", 9, "closed"));
  const request = {
    deliveryId: "del-close-lost-index",
    eventName: "pull_request",
    signatureHeader: sign(rawBody),
    rawBody,
  };

  await assert.rejects(adapter.handleWebhook(request), /post-rename|outcome|directory sync/i);
  assert.equal((await store.load(run.id)).github?.suspensionReason, "pull-request-closed");
  const githubRoot = path.join(cwd, ".maswe", "github");
  await rm(path.join(githubRoot, "associations.json"), { force: true });

  const restarted = new GitHubAppAdapter({
    cwd,
    config: testConfig(),
    store: new FileRunStore(cwd),
    http: {
      async request() {
        return {
          status: 200,
          headers: {},
          body: { head: { sha: "sha-close-lost-index" }, state: "closed" },
        };
      },
    },
    tokenProvider: async () => "test-token",
    synchronousWebhookDispatch: true,
  });
  await completeRetryableDelivery(() => restarted.handleWebhook(request));
  const recovered = await new GitHubAssociationIndex(githubRoot).find("owner/repo", 9);
  assert.equal(recovered?.runId, run.id);
  assert.equal(recovered?.suspensionReason, "pull-request-closed");
});

test("integration: a rejected run save that reached disk is reconciled before bind", async () => {
  process.env[SECRET_ENV] = SECRET;
  let rejectAfterSave = true;
  const { adapter, store, cwd } = await setup({
    liveHead: "sha-save-rejected",
    wrapStore: (base) => ({
      create: base.create.bind(base),
      load: base.load.bind(base),
      list: base.list.bind(base),
      applyEvent: base.applyEvent.bind(base),
      writeArtifact: base.writeArtifact.bind(base),
      readArtifact: base.readArtifact.bind(base),
      async save(run) {
        await base.save(run);
        if (rejectAfterSave) {
          rejectAfterSave = false;
          throw new Error("simulated rejected save after durable write");
        }
      },
    }),
  });
  const run = await store.create("association-save-rejected", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-save-rejected",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);
  const rawBody = JSON.stringify(prPayload("sha-save-rejected", 9, "opened"));

  await assert.rejects(
    adapter.handleWebhook({
      deliveryId: "del-association-save-rejected",
      eventName: "pull_request",
      signatureHeader: sign(rawBody),
      rawBody,
    }),
    /simulated rejected save after durable write/,
  );

  assert.equal((await store.load(run.id)).github, undefined);
  assert.equal(
    await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).find(
      "owner/repo",
      9,
    ),
    undefined,
  );
});

test("integration: live-head lookup failure fails closed", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { adapter, store, cwd } = await setup({ liveHead: "sha-new" });
  const run = await store.create("fail-closed", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-new",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);
  await adapter.handleWebhook({
    deliveryId: "del-new-head",
    eventName: "pull_request",
    signatureHeader: sign(JSON.stringify(prPayload("sha-new"))),
    rawBody: JSON.stringify(prPayload("sha-new")),
  });
  assert.equal((await store.load(run.id)).github?.headSha, "sha-new");

  const failingHttp: GitHubHttpClient = {
    async request(method) {
      if (method === "GET") {
        return { status: 500, headers: {}, body: { message: "boom" } };
      }
      return { status: 201, headers: {}, body: { id: 99 } };
    },
  };
  const badAdapter = new GitHubAppAdapter({
    cwd,
    config: testConfig(),
    store,
    http: failingHttp,
    tokenProvider: async () => "token",
    synchronousWebhookDispatch: true,
  });
  await assert.rejects(
    () =>
      badAdapter.handleWebhook({
        deliveryId: "del-old-after-fail",
        eventName: "pull_request",
        signatureHeader: sign(JSON.stringify(prPayload("sha-old"))),
        rawBody: JSON.stringify(prPayload("sha-old")),
      }),
    /Failed to resolve current PR head/i,
  );
  assert.equal((await store.load(run.id)).github?.headSha, "sha-new");
});

test("integration: installation_repositories.removed suspends every listed repo", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { store, cwd } = await setup();
  const runOne = await store.create("r1", "req", testConfig());
  runOne.github = {
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(runOne);
  const runTwo = await store.create("r2", "req", testConfig());
  runTwo.github = {
    installationId: 44,
    repository: "owner/two",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "b",
    suspended: false,
  };
  await store.save(runTwo);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: runOne.id,
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });
  await index.bind({
    runId: runTwo.id,
    installationId: 44,
    repository: "owner/two",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "b",
  });

  // Allowlist both for this test config by writing a dedicated adapter.
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/one", "owner/two", "owner/repo"],
    },
  });
  const multiAdapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http: {
      async request() {
        return { status: 200, headers: {}, body: {} };
      },
    },
    tokenProvider: async () => "token",
    synchronousWebhookDispatch: true,
  });

  const body = JSON.stringify({
    action: "removed",
    installation: { id: 44 },
    repositories_removed: [{ id: 1, full_name: "owner/one" }, { id: 2, full_name: "owner/two" }],
  });
  const result = await multiAdapter.handleWebhook({
    deliveryId: "del-multi-removed",
    eventName: "installation_repositories",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.equal((await index.find("owner/one", 1))?.suspended, true);
  assert.equal((await index.find("owner/two", 2))?.suspended, true);
  assert.equal((await store.load(runOne.id)).github?.suspended, true);
  assert.equal((await store.load(runTwo.id)).github?.suspended, true);
});
