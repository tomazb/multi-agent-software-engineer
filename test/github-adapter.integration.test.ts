import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import {
  DurableAtomicWriteOutcomeUnknownError,
  writeDurableAtomic,
} from "../src/durable-file.ts";
import { GitHubAppAdapter, type WebhookHandleResult } from "../src/github/adapter.ts";
import {
  GitHubJournalError,
  type GitHubJournalKind,
  withGitHubJournal,
} from "../src/github/journal.ts";
import { withRunMutationFence } from "../src/run-mutation.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import {
  GitHubAssociationIndex,
  type StableAssociationBindInput,
} from "../src/github/association.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { FileRunStore, type RunStore } from "../src/store.ts";
import type { MasweConfig } from "../src/domain.ts";
import type { GitHubInstallationTokenPurpose } from "../src/github/token.ts";

const SECRET = "integration-webhook-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_SECRET";
/** The stable repository id every ordinary fixture in this file is scoped to. */
const REPO_ID = 1308655205;
const tempDirectories = new Set<string>();

/** Seeds a stable `<repositoryId>#<pr>` association record. */
async function bindStableRecord(
  index: GitHubAssociationIndex,
  input: StableAssociationBindInput,
): Promise<void> {
  await index.withTransaction(async (transaction) => transaction.bindStable(input));
}

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
      allowedRepositoryIds: [REPO_ID],
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
  /** Canonical name the live installation listing reports for {@link REPO_ID}. */
  canonicalName?: string;
  /** `base.repo.id` the live pull request read reports. */
  baseRepositoryId?: number;
  /** Overrides the whole adapter config (used to pin the name-only cutover fault). */
  config?: MasweConfig;
  /** Fails the durable completion write exactly once, when armed. */
  failCompletionOnce?: boolean;
  /** Extra rows the live installation listing reports alongside {@link REPO_ID}. */
  additionalCanonicalRepositories?: Array<{ id: number; full_name: string }>;
} = {}) {
  const beforeCheckPost = options.beforeCheckPost;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-int-"));
  tempDirectories.add(cwd);
  const store = new FileRunStore(cwd);
  const adapterStore = options.wrapStore?.(store) ?? store;
  const config = options.config ?? testConfig();
  const diagnostics: Array<Record<string, unknown>> = [];
  let failNextCompletionWrite = false;
  let completionFailuresArmed = 0;
  const additionalCanonicalRepositories = options.additionalCanonicalRepositories ?? [];
  const posts: unknown[] = [];
  const checkRunHeadShas = new Map<number, string>();
  const patches: Array<{ url: string; body: unknown; headSha: string | undefined }> = [];
  const tokens: Array<{
    installationId: number;
    repositoryId: number;
    purpose: GitHubInstallationTokenPurpose;
  }> = [];
  let nextId = 1;
  let rateLimitOnce = false;
  let liveHead = options.liveHead;
  let liveState = options.liveState ?? "open";
  let failAll = false;
  let failPatchForHeadOnce: string | undefined;
  let pullHeadLookups = 0;
  let canonicalName = options.canonicalName ?? "owner/repo";
  let canonicalPresent = true;
  let baseRepositoryId = options.baseRepositoryId ?? REPO_ID;
  let canonicalLookups = 0;
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
      if (method === "GET" && url.includes("/installation/repositories")) {
        canonicalLookups += 1;
        return {
          status: 200,
          headers: {},
          body: {
            repositories: [
              ...(canonicalPresent
                ? [{ id: REPO_ID, full_name: canonicalName }]
                : [{ id: REPO_ID + 1, full_name: "other/repo" }]),
              ...additionalCanonicalRepositories,
            ],
          },
        };
      }
      if (method === "GET" && url.includes("/pulls/")) {
        pullHeadLookups += 1;
        return {
          status: 200,
          headers: {},
          body: {
            state: liveState,
            head: { sha: liveHead ?? "unknown", ref: "maswe/run-1" },
            base: {
              sha: "basebase",
              ref: "main",
              repo: { id: baseRepositoryId, full_name: canonicalName },
            },
          },
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
    repositoryTokenProvider: async (installationId, repositoryId, purpose) => {
      tokens.push({ installationId, repositoryId, purpose });
      // Arms the completion failure exactly once, during the first dispatch,
      // so only that delivery's durable completion write fails.
      if (options.failCompletionOnce && completionFailuresArmed === 0) {
        completionFailuresArmed += 1;
        failNextCompletionWrite = true;
      }
      return "test-token";
    },
    onWebhookDiagnostic: (error) => diagnostics.push(error as Record<string, unknown>),
    ...(options.failCompletionOnce
      ? {
          inboxOptions: {
            syncFile: async (handle: FileHandle, filePath: string) => {
              if (
                failNextCompletionWrite &&
                path.basename(filePath).startsWith(".state.")
              ) {
                failNextCompletionWrite = false;
                throw new Error("simulated durable completion failure");
              }
              await handle.sync();
            },
          },
        }
      : {}),
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
    diagnostics,
    permanentDrops() {
      return diagnostics.filter(
        (diagnostic) => diagnostic.code === "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP",
      );
    },
    pullHeadLookups() {
      return pullHeadLookups;
    },
    canonicalLookups() {
      return canonicalLookups;
    },
    setCanonicalName(name: string) {
      canonicalName = name;
    },
    setCanonicalPresent(present: boolean) {
      canonicalPresent = present;
    },
    setBaseRepositoryId(id: number) {
      baseRepositoryId = id;
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
    repositoryTokenProvider: async () => {
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
  assert.ok(tokens.some((t) => t.installationId === 44 && t.repositoryId === REPO_ID));
  assert.ok(tokens.some((t) => t.purpose === "checks"));
  assert.ok(tokens.every((t) => t.repositoryId === REPO_ID));
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
    repositoryId: REPO_ID,
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
  await bindStableRecord(new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")), {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: routedHead,
    branch: "maswe/run-1",
    suspended: false,
    pendingCancellationHeadShas: ["a".repeat(40), "c".repeat(40)],
  };
  await store.save(run);
  await bindStableRecord(new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")), {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-old",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  await bindStableRecord(new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")), {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-previous",
    branch: "maswe/run-1",
    suspended: false,
    pendingCancellationHeadShas,
  };
  await store.save(run);
  await bindStableRecord(new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")), {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
    (await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).findStable(REPO_ID, 9))
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-event",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  await bindStableRecord(new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")), {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-close",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
  assert.equal((await index.findStable(REPO_ID, 9))?.suspended, true);
  assert.equal(
    (await index.findStable(REPO_ID, 9))?.suspensionReason,
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-reopen",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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

  assert.equal((await index.findStable(REPO_ID, 9))?.suspended, false);
  assert.equal((await index.findStable(REPO_ID, 9))?.suspensionReason, undefined);
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-lifecycle",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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

  assert.equal((await index.findStable(REPO_ID, 9))?.suspended, false);
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
    repositoryId: REPO_ID,
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
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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

  assert.equal((await index.findStable(REPO_ID, 9))?.suspended, true);
  assert.equal((await index.findStable(REPO_ID, 9))?.suspensionReason, "pull-request-closed");
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
  assert.equal((await index.findStable(REPO_ID, 9))?.suspended, true);
  assert.equal(
    (await index.findStable(REPO_ID, 9))?.suspensionReason,
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
    repositoryId: REPO_ID,
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
    repositoryId: REPO_ID,
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 10,
    baseSha: "base",
    headSha: "old-second",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(secondRun);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: firstRun.id,
    installationId: 44,
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "old-first",
    branch: "maswe/run-1",
  });
  await bindStableRecord(index, {
    runId: secondRun.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
      repositoryId: REPO_ID,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: `old-${pullRequestNumber}`,
      branch: "maswe/run-1",
      suspended: false,
    };
    await store.save(run);
    await bindStableRecord(index, {
      runId: run.id,
      installationId: 44,
      repositoryId: REPO_ID,
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
    repositoryTokenProvider: async () => "token",
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/installation/repositories")) {
          return {
            status: 200,
            headers: {},
            body: { repositories: [{ id: REPO_ID, full_name: "owner/repo" }] },
          };
        }
        if (method === "GET" && url.includes("/pulls/9")) {
          return { status: 500, headers: {}, body: {} };
        }
        if (method === "GET" && url.includes("/pulls/10")) {
          return {
            status: 200,
            headers: {},
            body: {
              state: "open",
              head: { sha: "sha-push", ref: "maswe/run-1" },
              base: {
                sha: "base",
                ref: "main",
                repo: { id: REPO_ID, full_name: "owner/repo" },
              },
            },
          };
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-old",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  await bindStableRecord(new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")), {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
      repositoryId: REPO_ID,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: "sha-shared",
      branch: `maswe/run-${position + 1}`,
      suspended: false,
    };
    await store.save(run);
    await bindStableRecord(index, {
      runId: run.id,
      installationId: 44,
      repositoryId: REPO_ID,
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
    index.findStable(REPO_ID, 9),
    index.findStable(REPO_ID, 10),
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
    await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).findStable(
      REPO_ID,
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
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-close-outcome",
    branch: "maswe/run-1",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
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
  assert.equal((await index.findStable(REPO_ID, 9))?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspended, true);

  await completeRetryableDelivery(() => adapter.handleWebhook(request));
  assert.equal((await index.findStable(REPO_ID, 9))?.suspensionReason, "pull-request-closed");
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
    repositoryId: REPO_ID,
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
      async request(method, url) {
        if (method === "GET" && url.includes("/installation/repositories")) {
          return {
            status: 200,
            headers: {},
            body: { repositories: [{ id: REPO_ID, full_name: "owner/repo" }] },
          };
        }
        return {
          status: 200,
          headers: {},
          body: {
            state: "closed",
            head: { sha: "sha-close-lost-index", ref: "maswe/run-1" },
            base: {
              sha: "basebase",
              ref: "main",
              repo: { id: REPO_ID, full_name: "owner/repo" },
            },
          },
        };
      },
    },
    repositoryTokenProvider: async () => "test-token",
    synchronousWebhookDispatch: true,
  });
  await completeRetryableDelivery(() => restarted.handleWebhook(request));
  const recovered = await new GitHubAssociationIndex(githubRoot).findStable(REPO_ID, 9);
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
    await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).findStable(
      REPO_ID,
      9,
    ),
    undefined,
  );
});

test("integration: an outcome-unknown run save is never rolled back", async () => {
  process.env[SECRET_ENV] = SECRET;
  let raiseOutcomeUnknown = true;
  const { adapter, store, cwd } = await setup({
    liveHead: "sha-save-outcome-unknown",
    wrapStore: (base) => ({
      create: base.create.bind(base),
      load: base.load.bind(base),
      list: base.list.bind(base),
      applyEvent: base.applyEvent.bind(base),
      writeArtifact: base.writeArtifact.bind(base),
      readArtifact: base.readArtifact.bind(base),
      async save(run) {
        await base.save(run);
        if (raiseOutcomeUnknown) {
          raiseOutcomeUnknown = false;
          throw new DurableAtomicWriteOutcomeUnknownError("Run record", new Error("sync failed"));
        }
      },
    }),
  });
  const run = await store.create("association-save-outcome-unknown", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-save-outcome-unknown",
    branch: "maswe/run-1",
    fingerprint: "fp",
    remote: "https://github.com/owner/repo.git",
  };
  await store.save(run);
  const rawBody = JSON.stringify(prPayload("sha-save-outcome-unknown", 9, "opened"));

  await assert.rejects(
    adapter.handleWebhook({
      deliveryId: "del-association-save-outcome-unknown",
      eventName: "pull_request",
      signatureHeader: sign(rawBody),
      rawBody,
    }),
    DurableAtomicWriteOutcomeUnknownError,
  );

  // The write reached disk with an unknown outcome, so it must be re-read and
  // reconciled by a later delivery -- never blindly compensated away.
  const afterOutcomeUnknown = await store.load(run.id);
  assert.equal(afterOutcomeUnknown.github?.repository, "owner/repo");
  assert.equal(afterOutcomeUnknown.github?.pullRequestNumber, 9);
  assert.equal(afterOutcomeUnknown.github?.headSha, "sha-save-outcome-unknown");
  assert.equal(
    await new GitHubAssociationIndex(path.join(cwd, ".maswe", "github")).findStable(
      REPO_ID,
      9,
    ),
    undefined,
    "the association index is only bound after the run mutation is certain",
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
    repositoryTokenProvider: async () => "token",
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
    // Pre-#34 this failed inside the name-scoped `currentPullRequest` read. The
    // stable path reaches the bounded canonical lookup first, and its typed
    // upstream error is likewise transient: the delivery still retries and the
    // already-routed newer head is still preserved.
    /HTTP 500/i,
  );
  assert.equal((await store.load(run.id)).github?.headSha, "sha-new");
});

test("integration: installation_repositories.removed suspends every listed repo", async () => {
  process.env[SECRET_ENV] = SECRET;
  const { store, cwd } = await setup();
  const runOne = await store.create("r1", "req", testConfig());
  runOne.github = {
    installationId: 44,
    repositoryId: 1,
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
    repositoryId: 2,
    repository: "owner/two",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "b",
    suspended: false,
  };
  await store.save(runTwo);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: runOne.id,
    installationId: 44,
    repositoryId: 1,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });
  await bindStableRecord(index, {
    runId: runTwo.id,
    installationId: 44,
    repositoryId: 2,
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
    repositoryTokenProvider: async () => "token",
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
  assert.equal((await index.findStable(1, 1))?.suspended, true);
  assert.equal((await index.findStable(2, 2))?.suspended, true);
  assert.equal((await store.load(runOne.id)).github?.suspended, true);
  assert.equal((await store.load(runTwo.id)).github?.suspended, true);
});

// ---------------------------------------------------------------------------
// Issue #34 Task 8: stable-ID routing, rename reconciliation, fence order, and
// the real producers for every permanent dispatch disposition.
// ---------------------------------------------------------------------------

/** True when `kind`/`logicalKey` is currently held by somebody else. */
async function journalHeld(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
): Promise<boolean> {
  try {
    await withGitHubJournal(githubRoot, kind, logicalKey, async () => undefined, {
      timeoutMs: 120,
      pollIntervalMs: 10,
    });
    return false;
  } catch (error) {
    if (
      error instanceof GitHubJournalError &&
      error.code === "GITHUB_JOURNAL_TIMEOUT"
    ) {
      return true;
    }
    throw error;
  }
}

/** True when the run target mutation fence for `runId` is currently held. */
async function runTargetFenceHeld(repositoryPath: string, runId: string): Promise<boolean> {
  try {
    await withRunMutationFence(
      repositoryPath,
      runId,
      "target",
      async () => undefined,
      { timeoutMs: 120, pollIntervalMs: 10 },
    );
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Timed out acquiring durable run mutation fence/.test(message)) return true;
    throw error;
  }
}

/**
 * How many distinct logical keys have ever been fenced under one journal kind.
 * Keys are stored as digests, so this counts identities rather than naming
 * them: a name-keyed fence would show up here as an extra identity.
 */
async function fencedIdentityCount(
  githubRoot: string,
  kind: GitHubJournalKind,
): Promise<number> {
  try {
    return (await readdir(path.join(githubRoot, "journals", kind))).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function seedStableRun(
  store: FileRunStore,
  cwd: string,
  options: {
    title: string;
    pullRequestNumber?: number;
    headSha: string;
    branch?: string;
    repository?: string;
    repositoryId?: number;
    remote?: string;
  },
) {
  const pullRequestNumber = options.pullRequestNumber ?? 9;
  const branch = options.branch ?? "maswe/run-1";
  const repository = options.repository ?? "owner/repo";
  const repositoryId = options.repositoryId ?? REPO_ID;
  const run = await store.create(options.title, "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: options.headSha,
    branch,
    fingerprint: "fp",
    remote: options.remote ?? `https://github.com/${repository}.git`,
  };
  run.github = {
    installationId: 44,
    repositoryId,
    repository,
    pullRequestNumber,
    baseSha: "base",
    headSha: options.headSha,
    branch,
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId,
    repository,
    pullRequestNumber,
    baseSha: "base",
    headSha: options.headSha,
    branch,
  });
  return { run, index };
}

test("integration: a renamed repository keeps the same stable id, run, and association", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-rename" });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "rename-same-id",
    headSha: "sha-rename",
  });
  harness.setCanonicalName("owner/renamed");

  // The delivery still carries the OLD mutable name; only the stable id is authoritative.
  const body = JSON.stringify(prPayload("sha-rename"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-rename-same-id",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  const indexed = await index.findStable(REPO_ID, 9);
  assert.equal(indexed?.runId, run.id, "the same stable id must resolve the same run");
  assert.equal(indexed?.repository, "owner/renamed");
  const routed = await harness.store.load(run.id);
  assert.equal(routed.github?.repositoryId, REPO_ID);
  assert.equal(routed.github?.repository, "owner/renamed");
  assert.equal(
    await index.findLegacy("owner/repo", 9),
    undefined,
    "a rename must not leave a name-keyed legacy record behind",
  );
  assert.ok(harness.posts.length >= 4);
});

test("integration: an old-name replay with the same id cannot roll the canonical name back", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-replay" });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "rename-replay",
    headSha: "sha-replay",
  });
  harness.setCanonicalName("owner/renamed");
  const firstBody = JSON.stringify(prPayload("sha-replay"));
  await harness.adapter.handleWebhook({
    deliveryId: "del-rename-replay-1",
    eventName: "pull_request",
    signatureHeader: sign(firstBody),
    rawBody: firstBody,
  });
  assert.equal((await index.findStable(REPO_ID, 9))?.repository, "owner/renamed");

  // A delayed redelivery of the pre-rename payload: same id, old name.
  const replayBody = JSON.stringify(prPayload("sha-replay"));
  const replay = await harness.adapter.handleWebhook({
    deliveryId: "del-rename-replay-2",
    eventName: "pull_request",
    signatureHeader: sign(replayBody),
    rawBody: replayBody,
  });

  assert.equal(replay.status, 200);
  assert.equal(
    (await index.findStable(REPO_ID, 9))?.repository,
    "owner/renamed",
    "live id reconciliation decides the current name; a replay cannot restore the old one",
  );
  assert.equal((await harness.store.load(run.id)).github?.repository, "owner/renamed");
});

test("integration: the same repository text under a different stable id is a permanent conflict", async () => {
  process.env[SECRET_ENV] = SECRET;
  const otherRepositoryId = REPO_ID + 7;
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      // Both ids are operator-allowlisted, so only stable identity -- never the
      // shared mutable name -- can decide this.
      allowedRepositoryIds: [REPO_ID, otherRepositoryId],
      allowedRepositories: ["owner/repo"],
    },
  });
  const harness = await setup({
    liveHead: "sha-conflict",
    config,
    // Both repositories are live under this installation and the new one now
    // carries the same `owner/repo` text; its live pull request legitimately
    // targets it.
    additionalCanonicalRepositories: [{ id: otherRepositoryId, full_name: "owner/repo" }],
    baseRepositoryId: otherRepositoryId,
  });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "identity-conflict",
    headSha: "sha-conflict",
  });
  const before = await harness.store.load(run.id);
  const postsBefore = harness.posts.length;

  const body = JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    // Same text, different stable id.
    repository: { id: otherRepositoryId, full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: "sha-conflict", ref: "maswe/run-1" },
      base: { sha: "basebase" },
    },
  });
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-identity-conflict",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(
    harness.permanentDrops().map((drop) => drop.reason),
    ["repository-identity-conflict"],
  );
  assert.equal(harness.posts.length, postsBefore, "zero authority increase");
  assert.deepEqual(await harness.store.load(run.id), before);
  assert.equal(
    await index.findStable(otherRepositoryId, 9),
    undefined,
    "the conflicting id must never be bound",
  );
  assert.equal((await index.findStable(REPO_ID, 9))?.runId, run.id);
});

test("integration: manual publication reconciles the canonical name before routing", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-manual-rename" });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "manual-rename",
    headSha: "sha-manual-rename",
  });
  harness.setCanonicalName("owner/renamed");

  const published = await harness.adapter.publishChecksForRun(run.id);

  assert.equal(published.github?.repository, "owner/renamed");
  assert.equal((await index.findStable(REPO_ID, 9))?.repository, "owner/renamed");
  assert.ok(harness.posts.length >= 4);
  assert.ok(
    harness.tokens.some((token) => token.purpose === "metadata-reconcile"),
    "manual publication mints the id-scoped metadata token for reconciliation",
  );
  assert.ok(harness.tokens.every((token) => token.repositoryId === REPO_ID));
});

test("integration: a stale pre-rename remote does not invalidate an already stable association", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-stale-remote" });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "stale-remote-stable",
    headSha: "sha-old-remote",
    // The operator never updated the remote after the rename.
    remote: "https://github.com/owner/repo.git",
  });
  harness.setCanonicalName("owner/renamed");

  const body = JSON.stringify(prPayload("sha-stale-remote"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-stale-remote-stable",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  const routed = await harness.store.load(run.id);
  assert.equal(routed.github?.suspended, false);
  assert.equal(routed.github?.headSha, "sha-stale-remote");
  assert.equal(
    routed.workspace?.remote,
    "https://github.com/owner/repo.git",
    "#34 never rewrites the operator's local remote",
  );
  assert.equal((await index.findStable(REPO_ID, 9))?.runId, run.id);
});

test("integration: a stale pre-rename remote cannot first-associate a run automatically", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-first-assoc" });
  const run = await harness.store.create("stale-remote-first", "req", testConfig());
  run.workspace = {
    baseSha: "base",
    headSha: "sha-first-assoc",
    branch: "maswe/run-1",
    fingerprint: "fp",
    // Pre-rename slug only; redirect behavior is never identity proof.
    remote: "https://github.com/owner/repo.git",
  };
  await harness.store.save(run);
  harness.setCanonicalName("owner/renamed");

  const body = JSON.stringify(prPayload("sha-first-assoc"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-stale-remote-first",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.equal(
    (await harness.store.load(run.id)).github,
    undefined,
    "an outdated remote must not be inferred to be equivalent to the current name",
  );
  const index = new GitHubAssociationIndex(path.join(harness.cwd, ".maswe", "github"));
  assert.equal(await index.findStable(REPO_ID, 9), undefined);
});

test("integration: stable publication takes repository-identity, pr, run, and association locks in order", async () => {
  process.env[SECRET_ENV] = SECRET;
  const observed: Array<Record<string, boolean>> = [];
  const harness = await setup({ liveHead: "sha-locks" });
  const githubRoot = path.join(harness.cwd, ".maswe", "github");
  const { run } = await seedStableRun(harness.store, harness.cwd, {
    title: "lock-order",
    headSha: "sha-locks",
  });

  // Hold the single global association journal so the delivery parks exactly at
  // the transaction boundary, with every lock above it already acquired.
  const release = deferred();
  const parked = deferred();
  const holder = withGitHubJournal(
    githubRoot,
    "association",
    "associations",
    async () => {
      parked.resolve();
      await release.promise;
    },
    { timeoutMs: 60_000 },
  );
  await parked.promise;

  const body = JSON.stringify(prPayload("sha-locks"));
  const delivery = harness.adapter.handleWebhook({
    deliveryId: "del-lock-order",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  // Wait until the delivery is blocked on the association journal while already
  // holding the run target fence -- that ordering is only possible if the fence
  // was taken BEFORE the transaction, never from inside it.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await runTargetFenceHeld(harness.cwd, run.id)) break;
  }
  observed.push({
    repositoryIdentityId: await journalHeld(githubRoot, "repository-identity", String(REPO_ID)),
    publicationById: await journalHeld(githubRoot, "publication", `${REPO_ID}#9`),
    identityById: await journalHeld(githubRoot, "association-identity", `${REPO_ID}#9`),
    publicationByName: await journalHeld(githubRoot, "publication", "owner/repo#9"),
    identityByName: await journalHeld(githubRoot, "association-identity", "owner/repo#9"),
    runTargetFence: await runTargetFenceHeld(harness.cwd, run.id),
  });

  release.resolve();
  await holder;
  const result = await withWatchdog(delivery, 20_000, "fenced delivery stalled");
  assert.equal(result.status, 200);

  assert.deepEqual(observed, [{
    // Released after publication ENTRY (design doc §9), so unrelated pull
    // requests of the same repository are never serialized behind this one.
    repositoryIdentityId: false,
    publicationById: true,
    identityById: true,
    // No operational fence may be keyed by the mutable repository name.
    publicationByName: false,
    identityByName: false,
    // Held while blocked on the global association transaction: acquired
    // before it, never from inside it.
    runTargetFence: true,
  }]);
});

test("integration: stable publication never creates a name-keyed operational fence identity", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-fence-keys" });
  const githubRoot = path.join(harness.cwd, ".maswe", "github");
  await seedStableRun(harness.store, harness.cwd, {
    title: "fence-keys",
    headSha: "sha-fence-keys",
  });

  const body = JSON.stringify(prPayload("sha-fence-keys"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-fence-keys",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);

  // Exactly the identities the stable path is allowed to fence: the journal
  // preflight key plus one id-keyed pull request identity each, and one
  // repository identity. A surviving name-keyed operational fence would show
  // up here as an extra logical identity.
  assert.equal(await fencedIdentityCount(githubRoot, "publication"), 2);
  assert.equal(await fencedIdentityCount(githubRoot, "association-identity"), 1);
  assert.equal(await fencedIdentityCount(githubRoot, "repository-identity"), 1);
});

test("integration: a held repository-identity fence blocks entry before any pull request fence", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-entry" });
  const githubRoot = path.join(harness.cwd, ".maswe", "github");
  await seedStableRun(harness.store, harness.cwd, {
    title: "identity-entry",
    headSha: "sha-entry",
  });
  await harness.adapter.initialize();

  const release = deferred();
  const parked = deferred();
  const holder = withGitHubJournal(
    githubRoot,
    "repository-identity",
    String(REPO_ID),
    async () => {
      parked.resolve();
      await release.promise;
    },
    { timeoutMs: 60_000 },
  );
  await parked.promise;

  const body = JSON.stringify(prPayload("sha-entry"));
  const delivery = harness.adapter.handleWebhook({
    deliveryId: "del-identity-entry",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    await journalHeld(githubRoot, "publication", `${REPO_ID}#9`),
    false,
    "a blocked repository identity must not have entered pull request publication",
  );
  assert.equal(harness.posts.length, 0);
  assert.equal(harness.canonicalLookups(), 0);

  release.resolve();
  await holder;
  const result = await withWatchdog(delivery, 20_000, "entry-fenced delivery stalled");
  assert.equal(result.status, 200);
  assert.ok(harness.posts.length >= 4);
});

test("integration: a fork pull request stays valid when only its base repository id matches", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-fork" });
  const { run } = await seedStableRun(harness.store, harness.cwd, {
    title: "fork-pr",
    headSha: "sha-fork",
  });

  // `head.repo` is deliberately absent in the harness response; only
  // `base.repo.id` proves ownership.
  const body = JSON.stringify(prPayload("sha-fork"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-fork-pr",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.equal(harness.permanentDrops().length, 0);
  assert.equal((await harness.store.load(run.id)).github?.headSha, "sha-fork");
  assert.ok(harness.posts.length >= 4);
});

test("integration: a pull request whose base repository id differs is permanently rejected", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-base-mismatch", baseRepositoryId: REPO_ID + 3 });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "base-mismatch",
    headSha: "sha-base-mismatch",
  });
  const before = await harness.store.load(run.id);

  const body = JSON.stringify(prPayload("sha-base-mismatch"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-base-mismatch",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(
    harness.permanentDrops().map((drop) => drop.reason),
    ["repository-identity-conflict"],
  );
  assert.equal(harness.posts.length, 0);
  assert.deepEqual(await harness.store.load(run.id), before);
  assert.equal((await index.findStable(REPO_ID, 9))?.headSha, "sha-base-mismatch");
});

test("integration: a proven absence with a suspendable association applies revocation without counting a drop", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-revoke-a" });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "revoke-case-a",
    headSha: "sha-revoke-a",
  });
  // A fully and safely traversed listing that reaches its terminal page
  // without the target id: positive authorization-loss evidence.
  harness.setCanonicalPresent(false);

  const body = JSON.stringify(prPayload("sha-revoke-a"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-revoke-case-a",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.equal(harness.permanentDrops().length, 0, "an applied authority reduction never counts");
  const suspended = await harness.store.load(run.id);
  assert.equal(suspended.github?.suspended, true);
  assert.equal(suspended.github?.suspensionReason, "authorization-revoked");
  const indexed = await index.findStable(REPO_ID, 9);
  assert.equal(indexed?.suspended, true);
  assert.equal(indexed?.suspensionReason, "authorization-revoked");
  assert.equal(harness.posts.length, 0);
});

test("integration: a proven absence with nothing to reduce permanently consumes the delivery", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-revoke-b" });
  harness.setCanonicalPresent(false);

  const body = JSON.stringify(prPayload("sha-revoke-b"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-revoke-case-b",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(
    harness.permanentDrops().map((drop) => [drop.reason, drop.count]),
    [["repository-access-revoked", 1]],
  );
  assert.equal(harness.posts.length, 0);
});

test("integration: an ambiguous canonical lookup failure retries and never becomes revocation", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-ambiguous" });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "ambiguous-lookup",
    headSha: "sha-ambiguous",
  });
  harness.enableRateLimitOnce();

  const body = JSON.stringify(prPayload("sha-ambiguous"));
  await assert.rejects(
    () =>
      harness.adapter.handleWebhook({
        deliveryId: "del-ambiguous-lookup",
        eventName: "pull_request",
        signatureHeader: sign(body),
        rawBody: body,
      }),
    /rate limited/i,
  );

  assert.equal(harness.permanentDrops().length, 0);
  assert.equal((await harness.store.load(run.id)).github?.suspended, false);
  assert.equal((await index.findStable(REPO_ID, 9))?.suspended, false);
});

test("integration: name-only authorization permanently rejects repository dispatch", async () => {
  process.env[SECRET_ENV] = SECRET;
  const nameOnly = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      // The operator violated the §9.1 cutover order: names only.
      allowedRepositories: ["owner/repo"],
    },
  });
  const harness = await setup({ liveHead: "sha-nameonly", config: nameOnly });
  const { run } = await seedStableRun(harness.store, harness.cwd, {
    title: "name-only-config",
    headSha: "sha-nameonly",
  });
  const before = await harness.store.load(run.id);

  const body = JSON.stringify(prPayload("sha-nameonly"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-name-only",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(
    harness.permanentDrops().map((drop) => drop.reason),
    ["stable-repository-authorization-required"],
  );
  assert.equal(harness.tokens.length, 0, "no credential is minted without stable authorization");
  assert.equal(harness.posts.length, 0);
  assert.deepEqual(await harness.store.load(run.id), before);
});

test("integration: an id outside allowedRepositoryIds is rejected even when its name is allowlisted", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-not-allowed" });

  const body = JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    // The NAME is in `allowedRepositories`; only the id decides.
    repository: { id: REPO_ID + 11, full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: "sha-not-allowed", ref: "maswe/run-1" },
      base: { sha: "basebase" },
    },
  });
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-id-not-allowlisted",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(
    harness.permanentDrops().map((drop) => drop.reason),
    ["repository-not-allowlisted"],
  );
  assert.equal(harness.tokens.length, 0);
  assert.equal(harness.posts.length, 0);
});

test("integration: an unresolved legacy association cannot enter stable publication", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-legacy-block" });
  const run = await harness.store.create("legacy-block", "req", testConfig());
  // A pre-#34 run/index pair that migration has not resolved yet.
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-legacy-block",
    branch: "maswe/run-1",
    suspended: false,
  };
  await harness.store.save(run);
  const index = new GitHubAssociationIndex(path.join(harness.cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "sha-legacy-block",
    branch: "maswe/run-1",
  });
  const before = await harness.store.load(run.id);

  const body = JSON.stringify(prPayload("sha-legacy-block"));
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-legacy-block",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(
    harness.permanentDrops().map((drop) => drop.reason),
    ["legacy-repository-identity-missing"],
  );
  assert.equal(harness.posts.length, 0);
  assert.deepEqual(await harness.store.load(run.id), before);
  assert.equal(
    await index.findStable(REPO_ID, 9),
    undefined,
    "identity is never upgraded from a name",
  );
  assert.equal((await index.findLegacy("owner/repo", 9))?.runId, run.id);
});

test("integration: a permanent drop whose completion fails is counted once, only after it succeeds", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-order", failCompletionOnce: true });
  // Case B: proven absence with nothing to authority-reduce, produced by the
  // real canonical traversal rather than a dispatch double.
  harness.setCanonicalPresent(false);
  const body = JSON.stringify(prPayload("sha-order"));
  const request = {
    deliveryId: "del-drop-ordering",
    eventName: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
  };

  await assert.rejects(
    () => harness.adapter.handleWebhook(request),
    /simulated durable completion failure/,
  );
  assert.deepEqual(
    harness.permanentDrops(),
    [],
    "a failed completion must not count the drop",
  );

  const recovered = await completeRetryableDelivery(() => harness.adapter.handleWebhook(request));
  assert.equal(recovered.status, 200);
  assert.deepEqual(
    harness.permanentDrops().map((drop) => [drop.reason, drop.count]),
    [["repository-access-revoked", 1]],
    "the recovered completion counts the drop exactly once",
  );
  assert.equal(harness.posts.length, 0);
});

test("integration: push routing selects associations by stable id, never by repository name", async () => {
  process.env[SECRET_ENV] = SECRET;
  const harness = await setup({ liveHead: "sha-push-stable" });
  const { run, index } = await seedStableRun(harness.store, harness.cwd, {
    title: "push-stable",
    headSha: "sha-push-old",
    branch: "maswe/push",
  });
  // The repository was renamed since the association was written.
  harness.setCanonicalName("owner/renamed");

  const body = JSON.stringify({
    ref: "refs/heads/maswe/push",
    after: "sha-push-stable",
    installation: { id: 44 },
    repository: { id: REPO_ID, full_name: "owner/repo" },
  });
  const result = await harness.adapter.handleWebhook({
    deliveryId: "del-push-stable",
    eventName: "push",
    signatureHeader: sign(body),
    rawBody: body,
  });

  assert.equal(result.status, 200);
  const routed = await harness.store.load(run.id);
  assert.equal(routed.github?.headSha, "sha-push-stable");
  assert.equal(routed.github?.repository, "owner/renamed");
  assert.equal((await index.findStable(REPO_ID, 9))?.headSha, "sha-push-stable");
  assert.ok(
    harness.posts.length >= 4,
    "the renamed route still publishes through the reconciled canonical name",
  );
});
