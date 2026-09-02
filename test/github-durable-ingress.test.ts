import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import {
  type GitHubPermanentRejectContext,
  settleGitHubDispatchResult,
} from "../src/github/dispatch-disposition.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET_ENV = "MASWE_TEST_DURABLE_INGRESS_SECRET";
const DURABLE_INGRESS_REPO_ID = 1308655205;

/** Live installation-repository listing proving the allowlisted stable id is present. */
function canonicalListing() {
  return {
    status: 200,
    headers: {},
    body: { repositories: [{ id: DURABLE_INGRESS_REPO_ID, full_name: "owner/repo" }] },
  };
}

/** Full live pull request snapshot proving `base.repo.id`. */
function livePullRequest(headSha = "sha-durable", state: "open" | "closed" = "open") {
  return {
    status: 200,
    headers: {},
    body: {
      state,
      head: { sha: headSha, ref: "feature" },
      base: {
        sha: "base",
        ref: "main",
        repo: { id: DURABLE_INGRESS_REPO_ID, full_name: "owner/repo" },
      },
    },
  };
}
const SECRET = "durable-ingress-secret";

function config() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [DURABLE_INGRESS_REPO_ID],
      allowedRepositories: ["owner/repo"],
    },
  });
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withWatchdog<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function signedRequest(deliveryId: string, headSha = "sha-durable") {
  const rawBody = JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    repository: { id: DURABLE_INGRESS_REPO_ID, full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: headSha, ref: "feature" },
      base: { sha: "base" },
    },
  });
  return {
    deliveryId,
    eventName: "pull_request",
    signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    rawBody,
  };
}

function signedRequestMissingRepositoryId(deliveryId: string) {
  const rawBody = JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: "sha-durable", ref: "feature" },
      base: { sha: "base" },
    },
  });
  return {
    deliveryId,
    eventName: "pull_request",
    signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    rawBody,
  };
}

const FOREIGN_REPO_ID = 909_090_909;

/** A repository that is live but not operator-allowlisted: permanent, never retryable. */
function signedRequestForForeignRepository(deliveryId: string) {
  const rawBody = JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    repository: { id: FOREIGN_REPO_ID, full_name: "foreign/repo" },
    pull_request: {
      number: 11,
      head: { sha: "sha-foreign", ref: "feature" },
      base: { sha: "base" },
    },
  });
  return {
    deliveryId,
    eventName: "pull_request",
    signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    rawBody,
  };
}

async function readInboxRecord(cwd: string, deliveryId: string): Promise<{ status?: string }> {
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  return JSON.parse(
    await readFile(
      path.join(cwd, ".maswe", "github", "inbox", "state", hash.slice(0, 2), hash, "state.json"),
      "utf8",
    ),
  ) as { status?: string };
}

test("durable ingress acknowledges before a blocked downstream dispatch", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-ack-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const dispatchReached = deferred();
  const releaseDispatch = deferred();
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/installation/repositories")) {
        return canonicalListing();
      }
      if (method === "GET" && url.includes("/pulls/")) {
        dispatchReached.resolve();
        await releaseDispatch.promise;
        return livePullRequest();
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      return { status: 201, headers: {}, body: { id: 1 } };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http,
    repositoryTokenProvider: async () => "token",
    autoStartWebhookWorker: true,
  });

  const responsePromise = adapter.handleWebhook(signedRequest("durable-ack"));
  await dispatchReached.promise;
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) => {
        raceTimer = setTimeout(
          () => reject(new Error("ingress waited for downstream dispatch")),
          250,
        );
      }),
    ]);
    assert.equal(response.status, 202);
  } finally {
    if (raceTimer !== undefined) clearTimeout(raceTimer);
    releaseDispatch.resolve();
    await Promise.allSettled([responsePromise]);
    await adapter.waitForWebhookIdle();
    await adapter.stopWebhookWorker();
  }
});

test("durable ingress resumes an acknowledged queued event after restart", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-restart-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  let posts = 0;
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/installation/repositories")) {
        return canonicalListing();
      }
      if (method === "GET" && url.includes("/pulls/")) {
        return livePullRequest();
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      posts += 1;
      return { status: 201, headers: {}, body: { id: posts } };
    },
  };
  const makeAdapter = () =>
    new GitHubAppAdapter({
      cwd,
      config: config(),
      store: new FileRunStore(cwd),
      http,
      repositoryTokenProvider: async () => "token",
    });
  const firstProcess = makeAdapter();
  const accepted = await firstProcess.handleWebhook(signedRequest("durable-restart"));
  assert.equal(accepted.status, 202);
  assert.equal(posts, 0);

  const restarted = makeAdapter();
  await restarted.startWebhookWorker();
  await restarted.waitForWebhookIdle();
  await restarted.stopWebhookWorker();
  assert.equal(posts, 4);

  const replay = await restarted.handleWebhook(signedRequest("durable-restart"));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
});

test("an idle worker sleeps until due and a new enqueue wakes it immediately", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-due-aware-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const scheduled = deferred<number>();
  const dispatchReached = deferred();
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/installation/repositories")) {
          return canonicalListing();
        }
        if (method === "GET" && url.includes("/pulls/")) {
          dispatchReached.resolve();
          return livePullRequest();
        }
        if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    },
    repositoryTokenProvider: async () => "token",
    onWebhookWorkerSchedule: (delayMs) => scheduled.resolve(delayMs),
  });
  await adapter.startWebhookWorker();
  t.after(async () => adapter.stopWebhookWorker({ drainMs: 10 }));
  const idleDelay = await withWatchdog(
    scheduled.promise,
    "idle worker schedule was not exposed",
  );
  assert.ok(idleDelay >= 1_000, `idle worker unexpectedly polled after ${idleDelay}ms`);

  assert.equal((await adapter.handleWebhook(signedRequest("due-aware-wake"))).status, 202);
  await withWatchdog(
    dispatchReached.promise,
    "new enqueue did not wake the idle worker",
  );
  await adapter.waitForWebhookIdle();
});

test("queued duplicates are acknowledged and conflicting delivery bytes are rejected", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-duplicate-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("worker must not run"); } },
    repositoryTokenProvider: async () => "token",
  });

  assert.equal((await adapter.handleWebhook(signedRequest("durable-duplicate"))).status, 202);
  const duplicate = await adapter.handleWebhook(signedRequest("durable-duplicate"));
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(
    (await adapter.handleWebhook(signedRequest("durable-duplicate", "different-sha"))).status,
    409,
  );

  const files = await readdir(path.join(cwd, ".maswe", "github", "inbox", "state"), {
    recursive: true,
  });
  const stateName = files.find((name) => name.endsWith("state.json"));
  assert.ok(stateName);
  const persisted = await readFile(
    path.join(cwd, ".maswe", "github", "inbox", "state", stateName),
    "utf8",
  );
  assert.match(persisted, /"rawBodyDigest":"sha256:[0-9a-f]{64}"/);
  assert.match(persisted, /"event":\{/);
  assert.doesNotMatch(persisted, /signature|token|secret|"rawBody":|"headers":/);
});

test("signed invalid UTF-8 authenticates exact bytes but is rejected without enqueue", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-utf8-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("invalid input must not dispatch"); } },
    repositoryTokenProvider: async () => "token",
  });
  const rawBody = Buffer.from([0x7b, 0xff, 0x7d]);
  const response = await adapter.handleWebhook({
    deliveryId: "durable-invalid-utf8",
    eventName: "push",
    signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    rawBody,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.message, "invalid UTF-8 body");
  await assert.rejects(
    access(path.join(cwd, ".maswe", "github", "inbox", "state")),
    { code: "ENOENT" },
  );
});

test("signed direct adapter ingress rejects unsafe delivery ids without durable mutation", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-invalid-delivery-id-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("invalid input must not dispatch"); } },
    repositoryTokenProvider: async () => "token",
  });

  const response = await adapter.handleWebhook(signedRequest("unsafe/id"));

  assert.equal(response.status, 400);
  await assert.rejects(
    access(path.join(cwd, ".maswe", "github", "inbox", "state")),
    { code: "ENOENT" },
  );
});

test("a new payload missing repository.id is rejected before durable enqueue", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-missing-repo-id-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("malformed identity must not dispatch"); } },
    repositoryTokenProvider: async () => "token",
  });

  const response = await adapter.handleWebhook(
    signedRequestMissingRepositoryId("missing-repository-id"),
  );

  assert.equal(response.status, 400);
  await assert.rejects(
    access(path.join(cwd, ".maswe", "github", "inbox", "state")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    access(path.join(cwd, ".maswe", "github", "inbox", "queue")),
    { code: "ENOENT" },
  );
});

test("worker stop bounds drain while preserving active durable work", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-drain-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const dispatchReached = deferred();
  const releaseDispatch = deferred();
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/installation/repositories")) {
          return canonicalListing();
        }
        if (method === "GET" && url.includes("/pulls/")) {
          dispatchReached.resolve();
          await releaseDispatch.promise;
          return livePullRequest();
        }
        if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    },
    repositoryTokenProvider: async () => "token",
    autoStartWebhookWorker: true,
  });

  assert.equal((await adapter.handleWebhook(signedRequest("durable-drain"))).status, 202);
  await dispatchReached.promise;
  const started = Date.now();
  await adapter.stopWebhookWorker({ drainMs: 50 });
  assert.ok(Date.now() - started < 500);
  releaseDispatch.resolve();
  await adapter.waitForWebhookIdle();
});

test("manual publication preflight does not recover an active webhook lease", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-manual-lease-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const options = {
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("manual preflight must not call GitHub"); } },
    repositoryTokenProvider: async () => "token",
  } satisfies ConstructorParameters<typeof GitHubAppAdapter>[0];
  const ingress = new GitHubAppAdapter(options);
  assert.equal((await ingress.handleWebhook(signedRequest("manual-active-lease"))).status, 202);

  const inbox = new GitHubDeliveryInbox(path.join(cwd, ".maswe", "github"), {
    leaseMs: 60_000,
  });
  const claimed = await inbox.claimNext();
  assert.ok(claimed);
  const leaseId = claimed.record.leaseId;

  const manual = new GitHubAppAdapter(options);
  await assert.rejects(manual.publishChecksForRun("missing-run"), /missing-run/);

  const hash = createHash("sha256").update("manual-active-lease").digest("hex");
  const state = JSON.parse(
    await readFile(
      path.join(
        cwd,
        ".maswe",
        "github",
        "inbox",
        "state",
        hash.slice(0, 2),
        hash,
        "state.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(state.status, "processing");
  assert.equal(state.leaseId, leaseId);
});

test("durable handoff failures emit a local diagnostic before returning 503", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-durable-diagnostic-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const failure = new Error("simulated durable handoff failure");
  const diagnostics: unknown[] = [];
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("failed handoff must not dispatch"); } },
    repositoryTokenProvider: async () => "token",
    beforeInboxEnqueue: async () => { throw failure; },
    onWebhookDiagnostic: (error) => diagnostics.push(error),
  });

  const response = await adapter.handleWebhook(signedRequest("durable-diagnostic"));

  assert.equal(response.status, 503);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(
    {
      code: (diagnostics[0] as { code?: unknown }).code,
      deliveryId: (diagnostics[0] as { deliveryId?: unknown }).deliveryId,
      eventName: (diagnostics[0] as { eventName?: unknown }).eventName,
      attempt: (diagnostics[0] as { attempt?: unknown }).attempt,
      cause: (diagnostics[0] as { cause?: unknown }).cause,
    },
    {
      code: "GITHUB_WEBHOOK_HANDOFF_FAILED",
      deliveryId: "durable-diagnostic",
      eventName: "pull_request",
      attempt: 0,
      cause: failure,
    },
  );
});

test("worker failures emit bounded delivery context for recovery", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-worker-diagnostic-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const diagnostics: unknown[] = [];
  let resolveDiagnostic!: () => void;
  const diagnosticReady = new Promise<void>((resolve) => { resolveDiagnostic = resolve; });
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/installation/repositories")) {
          return canonicalListing();
        }
        if (method === "GET" && url.includes("/pulls/")) {
          return { status: 500, headers: {}, body: {} };
        }
        throw new Error("unexpected worker request");
      },
    },
    repositoryTokenProvider: async () => "token",
    onWebhookDiagnostic: (error) => {
      diagnostics.push(error);
      if ((error as { code?: unknown }).code === "GITHUB_WEBHOOK_DISPATCH_FAILED") {
        resolveDiagnostic();
      }
    },
  });
  await adapter.startWebhookWorker();
  t.after(async () => adapter.stopWebhookWorker({ drainMs: 10 }));
  assert.equal((await adapter.handleWebhook(signedRequest("worker-diagnostic"))).status, 202);
  await withWatchdog(
    diagnosticReady,
    "worker diagnostic timed out",
  );

  const failure = diagnostics.find(
    (diagnostic) =>
      (diagnostic as { code?: unknown }).code === "GITHUB_WEBHOOK_DISPATCH_FAILED",
  ) as { deliveryId?: unknown; eventName?: unknown; attempt?: unknown } | undefined;
  assert.equal(failure?.deliveryId, "worker-diagnostic");
  assert.equal(failure?.eventName, "pull_request");
  assert.equal(failure?.attempt, 1);
});

test("synchronous dispatch failure schedules retry from the failure time", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-sync-retry-clock-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request() {
        return { status: 500, headers: {}, body: {} };
      },
    },
    repositoryTokenProvider: async () => "token",
    synchronousWebhookDispatch: true,
  });
  const retryStartedAt = Date.now();

  await assert.rejects(
    adapter.handleWebhook(signedRequest("sync-retry-clock")),
    // Pre-#34 the first live GitHub read on this path was the name-scoped PR
    // head lookup. The stable path reaches the bounded canonical repository
    // lookup first; its typed upstream error is likewise transient, so the
    // delivery is still retried and still scheduled from the failure time.
    /GitHub installation repository lookup failed: HTTP 500/,
  );

  const hash = createHash("sha256").update("sync-retry-clock").digest("hex");
  const record = JSON.parse(
    await readFile(
      path.join(
        cwd,
        ".maswe",
        "github",
        "inbox",
        "state",
        hash.slice(0, 2),
        hash,
        "state.json",
      ),
      "utf8",
    ),
  ) as { nextAttemptAt?: string };
  assert.ok(record.nextAttemptAt);
  assert.ok(
    Date.parse(record.nextAttemptAt) >= retryStartedAt + 200,
    `retry was scheduled from an epoch-era clock: ${record.nextAttemptAt}`,
  );
});

test("queue-marker reopen failure is not masked by closing the original handle twice", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-queue-marker-reopen-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let closeCalls = 0;
  const inbox = new GitHubDeliveryInbox(root, {
    syncFile: async (handle, filePath) => {
      if (!filePath.endsWith(".queued")) {
        await handle.sync();
        return;
      }
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closeCalls += 1;
        if (closeCalls > 1) throw new Error("queue marker handle closed twice");
        await close();
      };
      await rm(filePath, { force: true });
      throw Object.assign(new Error("simulated queue marker collision"), { code: "EEXIST" });
    },
  });

  await assert.rejects(
    inbox.enqueue({
      deliveryId: "queue-marker-reopen",
      eventName: "push",
      receivedAt: "2026-08-11T00:00:00.000Z",
      rawBodyDigest: `sha256:${"c".repeat(64)}`,
      event: {
        eventId: "queue-marker-reopen",
        type: "push",
        repository: "owner/repo",
        repositoryId: 1308655205,
        installationId: 44,
        headSha: "head",
        branch: "feature",
        receivedAt: "2026-08-11T00:00:00.000Z",
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(closeCalls, 1);
});

test("inbox.enqueue rejects an ID-less repo-scoped event in strict mode", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-enqueue-strict-no-id-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);

  await assert.rejects(
    inbox.enqueue({
      deliveryId: "strict-missing-repository-id",
      eventName: "push",
      receivedAt: "2026-08-11T00:00:00.000Z",
      rawBodyDigest: `sha256:${"d".repeat(64)}`,
      event: {
        eventId: "strict-missing-repository-id",
        type: "push",
        repository: "owner/repo",
        installationId: 44,
        headSha: "head",
        branch: "feature",
        receivedAt: "2026-08-11T00:00:00.000Z",
      },
    }),
    /Invalid GitHub durable inbox event/,
  );
});

test("inbox.enqueue rejects a legacyRepositories-bearing installation_repositories event in strict mode", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-enqueue-strict-legacy-names-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);

  await assert.rejects(
    inbox.enqueue({
      deliveryId: "strict-legacy-repositories",
      eventName: "installation_repositories",
      receivedAt: "2026-08-11T00:00:00.000Z",
      rawBodyDigest: `sha256:${"e".repeat(64)}`,
      event: {
        eventId: "strict-legacy-repositories",
        type: "installation_repositories.removed",
        installationId: 7,
        repository: "owner/one",
        legacyRepositories: ["owner/one"],
        rawAction: "removed",
        receivedAt: "2026-08-11T00:00:00.000Z",
      },
    }),
    /Invalid GitHub durable inbox event/,
  );
});

test("the synchronous seam consumes a permanent repository rejection and counts it", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-permanent-sync-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const diagnostics: Array<Record<string, unknown>> = [];
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        throw new Error(`permanent rejection must not touch GitHub: ${method} ${url}`);
      },
    },
    repositoryTokenProvider: async () => {
      throw new Error("permanent rejection must not mint an installation token");
    },
    synchronousWebhookDispatch: true,
    onWebhookDiagnostic: (error) => diagnostics.push(error as Record<string, unknown>),
  });

  const first = await adapter.handleWebhook(signedRequestForForeignRepository("permanent-sync-1"));
  const second = await adapter.handleWebhook(signedRequestForForeignRepository("permanent-sync-2"));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await readInboxRecord(cwd, "permanent-sync-1")).status, "completed");
  assert.equal((await readInboxRecord(cwd, "permanent-sync-2")).status, "completed");
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.deliveryId,
      diagnostic.eventName,
      diagnostic.attempt,
      diagnostic.reason,
      diagnostic.count,
    ]),
    [
      [
        "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP",
        "permanent-sync-1",
        "pull_request",
        1,
        "repository-not-allowlisted",
        1,
      ],
      [
        "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP",
        "permanent-sync-2",
        "pull_request",
        1,
        "repository-not-allowlisted",
        2,
      ],
    ],
  );
  assert.equal(diagnostics[0]!.cause, undefined);
});

async function readInboxRecordAtRoot(
  githubRoot: string,
  deliveryId: string,
): Promise<{ status?: string }> {
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  return JSON.parse(
    await readFile(
      path.join(githubRoot, "inbox", "state", hash.slice(0, 2), hash, "state.json"),
      "utf8",
    ),
  ) as { status?: string };
}

test(
  "the synchronous seam does not count a permanent drop whose completion lost its lease, "
    + "and counts it exactly once after a later success",
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-permanent-sync-lease-lost-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    // A real durable inbox -- the same `inbox.complete()` the synchronous
    // seam (adapter.ts) and the worker both call through
    // `settleGitHubDispatchResult`. A short lease lets the test reproduce
    // the exact race Finding 1 fixes: the lease is lost (e.g. a failed
    // heartbeat) and the delivery is reclaimed before the first dispatch's
    // completion lands.
    const inbox = new GitHubDeliveryInbox(root, { leaseMs: 10 });
    await inbox.enqueue({
      deliveryId: "permanent-sync-lease-lost",
      eventName: "pull_request",
      receivedAt: "2026-08-11T00:00:00.000Z",
      rawBodyDigest: `sha256:${"a".repeat(64)}`,
      event: {
        eventId: "permanent-sync-lease-lost",
        type: "pull_request.synchronize",
        repository: "foreign/repo",
        repositoryId: FOREIGN_REPO_ID,
        installationId: 44,
        pullRequestNumber: 11,
        headSha: "sha-foreign",
        baseSha: "base",
        branch: "feature",
        rawAction: "synchronize",
        receivedAt: "2026-08-11T00:00:00.000Z",
      },
    });

    const firstClaim = await inbox.claimNext();
    assert.ok(firstClaim, "the first claim must succeed");
    const staleLeaseId = firstClaim!.record.leaseId;
    const staleAttempt = firstClaim!.record.attempt;

    await new Promise((resolve) => setTimeout(resolve, 25));
    const secondClaim = await inbox.claimNext();
    assert.ok(secondClaim, "the delivery must be reclaimable once its lease expires");
    assert.notEqual(
      secondClaim!.record.leaseId,
      staleLeaseId,
      "the reclaim must mint a fresh lease",
    );

    // The synchronous seam's own permanent-reject completion, using its
    // now-stale lease -- the exact composition adapter.ts uses (same
    // helper, same `inbox.complete()` seam).
    const staleCounted: GitHubPermanentRejectContext[] = [];
    await settleGitHubDispatchResult({
      result: { kind: "permanent-reject", reason: "repository-not-allowlisted" },
      complete: () => inbox.complete("permanent-sync-lease-lost", staleLeaseId),
      onPermanentRejectCompleted: (reason) => staleCounted.push({
        deliveryId: "permanent-sync-lease-lost",
        eventName: "pull_request",
        attempt: staleAttempt,
        reason,
      }),
    });
    assert.deepEqual(
      staleCounted,
      [],
      "a completion that lost its lease must not count a permanent drop",
    );
    assert.equal(
      (await readInboxRecordAtRoot(root, "permanent-sync-lease-lost")).status,
      "processing",
      "a lost-lease completion must not mark the delivery completed",
    );

    // The later successful completion of the same delivery, using the
    // reclaimed lease, must count exactly once.
    const laterCounted: GitHubPermanentRejectContext[] = [];
    await settleGitHubDispatchResult({
      result: { kind: "permanent-reject", reason: "repository-not-allowlisted" },
      complete: () => inbox.complete("permanent-sync-lease-lost", secondClaim!.record.leaseId),
      onPermanentRejectCompleted: (reason) => laterCounted.push({
        deliveryId: "permanent-sync-lease-lost",
        eventName: "pull_request",
        attempt: secondClaim!.record.attempt,
        reason,
      }),
    });
    assert.equal(
      laterCounted.length,
      1,
      "a later successful completion must count the drop exactly once",
    );
    assert.deepEqual(laterCounted, [{
      deliveryId: "permanent-sync-lease-lost",
      eventName: "pull_request",
      attempt: secondClaim!.record.attempt,
      reason: "repository-not-allowlisted",
    }]);
    assert.equal(
      (await readInboxRecordAtRoot(root, "permanent-sync-lease-lost")).status,
      "completed",
    );
  },
);

test("the worker consumes a permanent repository rejection with the same classification", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-permanent-worker-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const diagnostics: Array<Record<string, unknown>> = [];
  const dropped = deferred();
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        throw new Error(`permanent rejection must not touch GitHub: ${method} ${url}`);
      },
    },
    repositoryTokenProvider: async () => {
      throw new Error("permanent rejection must not mint an installation token");
    },
    autoStartWebhookWorker: true,
    onWebhookDiagnostic: (error) => {
      const diagnostic = error as Record<string, unknown>;
      diagnostics.push(diagnostic);
      if (diagnostic.code === "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP") dropped.resolve();
    },
  });
  t.after(async () => adapter.stopWebhookWorker({ drainMs: 10 }));

  const response = await adapter.handleWebhook(
    signedRequestForForeignRepository("permanent-worker-1"),
  );
  assert.equal(response.status, 202);
  await withWatchdog(dropped.promise, "permanent repository drop was never reported");

  assert.equal((await readInboxRecord(cwd, "permanent-worker-1")).status, "completed");
  assert.equal(
    diagnostics.some(({ code }) => code === "GITHUB_WEBHOOK_DISPATCH_FAILED"),
    false,
    "a permanent rejection is not a dispatch failure",
  );
  const drop = diagnostics.find(
    ({ code }) => code === "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP",
  )!;
  assert.equal(drop.deliveryId, "permanent-worker-1");
  assert.equal(drop.eventName, "pull_request");
  assert.equal(drop.attempt, 1);
  assert.equal(drop.reason, "repository-not-allowlisted");
  assert.equal(drop.count, 1);
});
