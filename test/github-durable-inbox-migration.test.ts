import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import type { GitHubInternalEvent } from "../src/github/types.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET_ENV = "MASWE_TEST_INBOX_MIGRATION_SECRET";
const SECRET = "inbox-migration-secret";

function config() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_APP_ID",
      privateKeyEnv: "MASWE_TEST_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
    },
  });
}

function request(deliveryId: string, headSha: string) {
  const rawBody = JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    repository: { id: 1308655205, full_name: "owner/repo" },
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

async function writeLegacy(
  root: string,
  deliveryId: string,
  status: "processing" | "completed",
): Promise<string> {
  const deliveries = path.join(root, ".maswe", "github", "deliveries");
  await mkdir(deliveries, { recursive: true });
  const canonical = path.join(deliveries, `${deliveryId}.json`);
  await writeFile(
    canonical,
    `${JSON.stringify({
      deliveryId,
      status,
      claimedAt: "2026-08-09T12:00:00.000Z",
      leaseId: "legacy-lease",
      ...(status === "completed" ? { completedAt: "2026-08-09T12:00:01.000Z" } : {}),
    })}\n`,
    "utf8",
  );
  await writeFile(`${canonical}.staging.retained`, "retained-artifact\n", "utf8");
  await writeFile(`${canonical}.suppression.retained`, "retained-suppression\n", "utf8");
  return canonical;
}

test("startup migration turns v1 processing into awaiting-redelivery", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-v1-processing-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const canonical = await writeLegacy(cwd, "legacy-processing", "processing");
  let posts = 0;
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: {
      async request(method, url) {
        if (method === "GET" && url.includes("/pulls/")) {
          return { status: 200, headers: {}, body: { head: { sha: "sha-legacy" }, state: "open" } };
        }
        if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
        posts += 1;
        return { status: 201, headers: {}, body: { id: posts } };
      },
    },
    tokenProvider: async () => "token",
  });

  await adapter.initialize();
  const accepted = await adapter.handleWebhook(request("legacy-processing", "sha-legacy"));
  assert.equal(accepted.status, 202);
  await adapter.startWebhookWorker();
  await adapter.waitForWebhookIdle();
  await adapter.stopWebhookWorker();
  assert.equal(posts, 4);
  await assert.rejects(readFile(canonical, "utf8"), { code: "ENOENT" });

  const hash = createHash("sha256").update("legacy-processing").digest("hex");
  const legacyDirectory = path.join(
    cwd,
    ".maswe",
    "github",
    "inbox",
    "legacy",
    hash.slice(0, 2),
    hash,
  );
  const migratedNames = await readdir(legacyDirectory);
  const stagingName = migratedNames.find((name) => name.includes("staging.retained"));
  const suppressionName = migratedNames.find((name) => name.includes("suppression.retained"));
  assert.ok(stagingName);
  assert.ok(suppressionName);
  assert.equal(await readFile(path.join(legacyDirectory, stagingName), "utf8"), "retained-artifact\n");
  assert.equal(
    await readFile(path.join(legacyDirectory, suppressionName), "utf8"),
    "retained-suppression\n",
  );
});

test("startup migration preserves v1 completed as terminal legacy", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-v1-completed-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await writeLegacy(cwd, "legacy-completed", "completed");
  let requests = 0;
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { requests += 1; return { status: 500, headers: {}, body: {} }; } },
    tokenProvider: async () => "token",
  });

  await adapter.initialize();
  const replay = await adapter.handleWebhook(request("legacy-completed", "different-body"));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(requests, 0);
});

test("startup migration fails closed instead of overwriting conflicting retained evidence", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-v1-conflict-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const deliveryId = "legacy-conflict";
  const canonical = await writeLegacy(cwd, deliveryId, "processing");
  const sourceName = `${path.basename(canonical)}.staging.retained`;
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  const legacyDirectory = path.join(
    cwd,
    ".maswe",
    "github",
    "inbox",
    "legacy",
    hash.slice(0, 2),
    hash,
  );
  await mkdir(legacyDirectory, { recursive: true });
  const retainedPath = path.join(legacyDirectory, sourceName);
  await writeFile(retainedPath, "conflicting-retained-evidence\n", "utf8");
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: { async request() { throw new Error("migration must fail before API work"); } },
    tokenProvider: async () => "token",
  });

  await assert.rejects(adapter.initialize(), /conflicting legacy delivery evidence/i);
  assert.equal(await readFile(retainedPath, "utf8"), "conflicting-retained-evidence\n");
  assert.equal(await readFile(`${canonical}.staging.retained`, "utf8"), "retained-artifact\n");
});

test("startup fails closed on an unexpected durable queue entry", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-invalid-queue-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const invalidQueueDirectory = path.join(githubRoot, "inbox", "queue", "not-a-prefix");
  await mkdir(invalidQueueDirectory, { recursive: true });
  await writeFile(path.join(invalidQueueDirectory, "stranded.queued"), "", "utf8");

  await assert.rejects(
    new GitHubDeliveryInbox(githubRoot).initialize(),
    /Invalid GitHub durable inbox queue entry/,
  );
});

test("startup migration rejects legacy canonical records outside the v1 whitelist", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-v1-fields-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const canonical = await writeLegacy(cwd, "legacy-extra-field", "processing");
  const parsed = JSON.parse(await readFile(canonical, "utf8")) as Record<string, unknown>;
  parsed.rawBody = "must-not-be-trusted-or-migrated";
  await writeFile(canonical, `${JSON.stringify(parsed)}\n`, "utf8");

  await assert.rejects(
    new GitHubDeliveryInbox(path.join(cwd, ".maswe", "github")).initialize(),
    /Invalid legacy GitHub delivery canonical record/,
  );
});

test("orphan queue markers cannot lease payloadless legacy migration states", async (t) => {
  for (const status of ["processing", "completed"] as const) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), `maswe-gh-inbox-v1-orphan-${status}-`));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const deliveryId = `legacy-orphan-${status}`;
    await writeLegacy(cwd, deliveryId, status);
    const githubRoot = path.join(cwd, ".maswe", "github");
    const inbox = new GitHubDeliveryInbox(githubRoot);
    await inbox.initialize();
    const hash = createHash("sha256").update(deliveryId).digest("hex");
    const queueDirectory = path.join(githubRoot, "inbox", "queue", hash.slice(0, 2));
    await mkdir(queueDirectory, { recursive: true });
    await writeFile(path.join(queueDirectory, `${hash}.queued`), "");

    assert.equal(await inbox.claimNext(Date.now() + 1), undefined);
  }
});

/**
 * Writes a pre-#34 format-2 durable inbox record directly to disk, bypassing
 * normalization entirely, to prove historical ID-less events remain exactly
 * loadable at the durable-record boundary. Historical records never carry a
 * `repositoryId`; #34 must not synthesize one on read.
 */
async function writeFormat2QueuedFixture(
  githubRoot: string,
  deliveryId: string,
  eventName: string,
  event: Record<string, unknown>,
): Promise<void> {
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  const prefix = hash.slice(0, 2);
  const stateDirectory = path.join(githubRoot, "inbox", "state", prefix, hash);
  const queueDirectory = path.join(githubRoot, "inbox", "queue", prefix);
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(queueDirectory, { recursive: true });
  const receivedAt = "2026-01-01T00:00:00.000Z";
  const record = {
    format: 2,
    record: "github-delivery-inbox",
    deliveryId,
    eventName,
    receivedAt,
    rawBodyDigest: `sha256:${"a".repeat(64)}`,
    status: "queued",
    attempt: 0,
    nextAttemptAt: receivedAt,
    event: { eventId: deliveryId, receivedAt, ...event },
  };
  await writeFile(path.join(stateDirectory, "state.json"), JSON.stringify(record), "utf8");
  await writeFile(path.join(queueDirectory, `${hash}.queued`), "", "utf8");
}

test("a pre-#34 ordinary repository event remains readable and stays ID-less", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-legacy-ordinary-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const deliveryId = "pre34-ordinary-push";
  await writeFormat2QueuedFixture(githubRoot, deliveryId, "push", {
    type: "push",
    repository: "owner/repo",
    installationId: 44,
    headSha: "sha-legacy",
    branch: "main",
  });

  const inbox = new GitHubDeliveryInbox(githubRoot);
  await inbox.initialize();
  const claimed = await inbox.claimNext(Date.now());
  assert.ok(claimed, "expected the pre-#34 event to be claimable");
  const event = claimed!.record.event as GitHubInternalEvent;
  assert.equal(event.repository, "owner/repo");
  assert.equal(event.repositoryId, undefined);
  assert.equal(event.headSha, "sha-legacy");
  assert.equal(event.branch, "main");
});

test("a pre-#34 installation_repositories string array migrates to legacyRepositories at the durable-record boundary", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-legacy-install-repos-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const deliveryId = "pre34-installation-repositories-removed";
  await writeFormat2QueuedFixture(githubRoot, deliveryId, "installation_repositories", {
    type: "installation_repositories.removed",
    installationId: 7,
    repository: "owner/one",
    repositories: ["owner/one", "owner/two"],
    rawAction: "removed",
  });

  const inbox = new GitHubDeliveryInbox(githubRoot);
  await inbox.initialize();
  const claimed = await inbox.claimNext(Date.now());
  assert.ok(claimed, "expected the pre-#34 installation_repositories event to be claimable");
  const event = claimed!.record.event as GitHubInternalEvent;
  assert.deepEqual(event.legacyRepositories, ["owner/one", "owner/two"]);
  assert.equal(event.repositories, undefined);
  assert.equal(event.repository, "owner/one");
  assert.equal(event.repositoryId, undefined);
});

test("startup rejects symlinked inbox namespaces without mutating their targets", async (t) => {
  for (const relativePath of [
    "deliveries",
    "inbox/state",
    "inbox/queue",
    "inbox/legacy",
    "inbox/state/aa",
    `inbox/state/aa/${"a".repeat(64)}`,
    "inbox/queue/aa",
  ]) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-symlink-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-external-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    t.after(async () => rm(external, { recursive: true, force: true }));
    const githubRoot = path.join(cwd, ".maswe", "github");
    const linkedPath = path.join(githubRoot, relativePath);
    await mkdir(path.dirname(linkedPath), { recursive: true });
    await writeFile(path.join(external, "sentinel"), "unchanged\n", "utf8");
    await symlink(external, linkedPath, "dir");

    await assert.rejects(
      new GitHubDeliveryInbox(githubRoot).initialize(),
      /ordinary directory/i,
    );
    assert.equal(await readFile(path.join(external, "sentinel"), "utf8"), "unchanged\n");
  }
});
