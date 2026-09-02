import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import {
  GitHubJournalError,
  type GitHubJournalKind,
  withGitHubJournal,
} from "../src/github/journal.ts";
import { withRunMutationFence } from "../src/run-mutation.ts";
import { writeDurableAtomic } from "../src/durable-file.ts";
import {
  GitHubAssociationIndex,
  type StableAssociationBindInput,
} from "../src/github/association.ts";
import { FileRunStore } from "../src/store.ts";
import { seedLegacyAssociations } from "./fixtures/github-legacy-associations.ts";
import type { RunStore } from "../src/store.ts";
import type { RunRecord } from "../src/domain.ts";

const SECRET = "suspend-reconcile-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_SECRET_SUSPEND";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

/** Seeds a stable `<repositoryId>#<pr>` association record. */
async function bindStableRecord(
  index: GitHubAssociationIndex,
  input: StableAssociationBindInput,
): Promise<void> {
  await index.withTransaction(async (transaction) => transaction.bindStable(input));
}

test("redelivery after run-save failure still suspends the authoritative run", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-rec-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/one"],
    },
  });
  const run = await store.create("s1", "req", config);
  run.github = {
    installationId: 44,
    repositoryId: 1,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(run);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: 1,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });

  // Simulate crash after index suspend but before run save: index already suspended, run still active.
  await index.suspendRepository(44, "owner/one");
  assert.equal((await index.findStable(1, 1))?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspended, false);

  const adapter = new GitHubAppAdapter({
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
    repositories_removed: [{ id: 1, full_name: "owner/one" }],
  });
  const result = await adapter.handleWebhook({
    deliveryId: "del-suspend-retry",
    eventName: "installation_repositories",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.equal((await store.load(run.id)).github?.suspended, true);
});

for (const eventKind of ["installation", "repository-removal"] as const) {
  test(`${eventKind} suspension processes later associations before aggregating a persistent first save failure`, async (t) => {
    process.env[SECRET_ENV] = SECRET;
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-all-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const config = mergeConfigForTest({
      runtime: { kind: "mock" },
      quality: { commands: [] },
      githubApp: {
        enabled: true,
        readOnlyChecks: true,
        webhookSecretEnv: SECRET_ENV,
        appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
        privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
        allowedRepositories: ["owner/one", "owner/two"],
      },
    });
    const runs: RunRecord[] = [];
    const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
    for (const [offset, repository] of ["owner/one", "owner/two"].entries()) {
      const run = await store.create(`s${offset + 1}`, "req", config);
      run.github = {
        installationId: 44,
        repositoryId: offset + 1,
        repository,
        pullRequestNumber: offset + 1,
        baseSha: "b",
        headSha: "h",
        branch: "a",
        suspended: false,
      };
      await store.save(run);
      await bindStableRecord(index, {
        runId: run.id,
        installationId: 44,
        repositoryId: offset + 1,
        repository,
        pullRequestNumber: offset + 1,
        baseSha: "b",
        headSha: "h",
        branch: "a",
      });
      runs.push(run);
    }

    const failingStore: RunStore = {
      create: store.create.bind(store),
      load: store.load.bind(store),
      list: store.list.bind(store),
      applyEvent: store.applyEvent.bind(store),
      writeArtifact: store.writeArtifact.bind(store),
      readArtifact: store.readArtifact.bind(store),
      save: async (run) => {
        if (run.id === runs[0]!.id && run.github?.suspended) {
          throw new Error("persistent first run-save failure");
        }
        await store.save(run);
      },
    };
    const adapter = new GitHubAppAdapter({
      cwd,
      config,
      store: failingStore,
      http: { async request() { return { status: 200, headers: {}, body: {} }; } },
      repositoryTokenProvider: async () => "token",
      synchronousWebhookDispatch: true,
    });
    const body = eventKind === "installation"
      ? JSON.stringify({ action: "deleted", installation: { id: 44 } })
      : JSON.stringify({
          action: "removed",
          installation: { id: 44 },
          repositories_removed: [
            { id: 1, full_name: "owner/one" },
            { id: 2, full_name: "owner/two" },
          ],
        });

    await assert.rejects(
      adapter.handleWebhook({
        deliveryId: `del-suspend-all-${eventKind}`,
        eventName: eventKind === "installation" ? "installation" : "installation_repositories",
        signatureHeader: sign(body),
        rawBody: body,
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some((nested) => /persistent first run-save failure/.test(String(nested))),
    );

    const firstIndex = await index.findStable(1, 1);
    const secondIndex = await index.findStable(2, 2);
    // #34 applies the run and index halves of one suspension inside a single
    // association transaction (design doc §19.11: a concurrent run mutation
    // must not race an authority reduction into a split run/index state), so
    // the persistently failing record now leaves BOTH halves untouched instead
    // of the pre-#34 index-suspended/run-active split.
    assert.equal(firstIndex?.suspended, false);
    assert.equal(firstIndex?.suspensionReason, undefined);
    assert.equal(secondIndex?.suspensionReason, "authorization-revoked");
    assert.equal((await store.load(runs[0]!.id)).github?.suspended, false);
    assert.equal((await store.load(runs[1]!.id)).github?.suspensionReason, "authorization-revoked");
  });
}

test("authorization suspension only treats ENOENT as a missing run", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-load-error-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/one"],
    },
  });
  const run = await store.create("load failure", "do not swallow corruption", config);
  run.github = {
    installationId: 44,
    repositoryId: 1,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: 1,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });
  const corruptingStore: RunStore = {
    create: store.create.bind(store),
    save: store.save.bind(store),
    load: async () => {
      throw new Error("run record required field is missing");
    },
    list: store.list.bind(store),
    applyEvent: store.applyEvent.bind(store),
    writeArtifact: store.writeArtifact.bind(store),
    readArtifact: store.readArtifact.bind(store),
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store: corruptingStore,
    http: { async request() { return { status: 200, headers: {}, body: {} }; } },
    repositoryTokenProvider: async () => "token",
    synchronousWebhookDispatch: true,
  });
  const body = JSON.stringify({ action: "deleted", installation: { id: 44 } });

  await assert.rejects(
    adapter.handleWebhook({
      deliveryId: "del-suspend-load-error",
      eventName: "installation",
      signatureHeader: sign(body),
      rawBody: body,
    }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((nested) => /required field is missing/.test(String(nested))),
  );
});

// ---------------------------------------------------------------------------
// Issue #34 Task 8: mixed stable/legacy authority-reduction fan-out.
// Every affected record is classified BEFORE a lock path is chosen; stable
// records take repository-identity -> pr identity -> run fence -> transaction,
// and unresolved legacy records take only run fence -> transaction (design doc
// §6.2, §9).
// ---------------------------------------------------------------------------

const STABLE_REPO_ID = 501;

function fanoutConfig() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [STABLE_REPO_ID],
      allowedRepositories: ["owner/stable", "owner/legacy"],
    },
  });
}

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
    if (error instanceof GitHubJournalError && error.code === "GITHUB_JOURNAL_TIMEOUT") {
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

/** How many distinct logical keys have ever been fenced under one journal kind. */
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

async function seedMixedInstallation(cwd: string, store: FileRunStore) {
  const config = fanoutConfig();
  const githubRoot = path.join(cwd, ".maswe", "github");
  const index = new GitHubAssociationIndex(githubRoot);

  const stableRun = await store.create("stable-record", "req", config);
  stableRun.github = {
    installationId: 44,
    repositoryId: STABLE_REPO_ID,
    repository: "owner/stable",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(stableRun);
  await bindStableRecord(index, {
    runId: stableRun.id,
    installationId: 44,
    repositoryId: STABLE_REPO_ID,
    repository: "owner/stable",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });

  // A pre-#34 record migration has not resolved yet: no repositoryId anywhere.
  const legacyRun = await store.create("legacy-record", "req", config);
  legacyRun.github = {
    installationId: 44,
    repository: "owner/legacy",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(legacyRun);
  await seedLegacyAssociations(githubRoot, [{
    runId: legacyRun.id,
    installationId: 44,
    repository: "owner/legacy",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  }]);

  return { config, index, stableRun, legacyRun };
}

function installationDeletedRequest(deliveryId: string) {
  const body = JSON.stringify({ action: "deleted", installation: { id: 44 } });
  return {
    deliveryId,
    eventName: "installation",
    signatureHeader: sign(body),
    rawBody: body,
  };
}

test("installation.deleted classifies each record before choosing its lock path", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-mixed-fanout-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const githubRoot = path.join(cwd, ".maswe", "github");
  const { config, index, stableRun, legacyRun } = await seedMixedInstallation(cwd, store);

  const observations: Array<{ record: string; locks: Record<string, boolean> }> = [];
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http: { async request() { throw new Error("authority reduction must not call GitHub"); } },
    repositoryTokenProvider: async () => {
      throw new Error("authority reduction must not mint a token");
    },
    synchronousWebhookDispatch: true,
    // Fires inside the global association transaction, with every lock the
    // chosen path acquired above it still held.
    associationWriteRecords: async (filePath, content) => {
      const stableHeld = await runTargetFenceHeld(cwd, stableRun.id);
      observations.push({
        record: stableHeld ? "stable" : "legacy",
        locks: {
          repositoryIdentity: await journalHeld(
            githubRoot,
            "repository-identity",
            String(STABLE_REPO_ID),
          ),
          stableIdentityById: await journalHeld(
            githubRoot,
            "association-identity",
            `${STABLE_REPO_ID}#1`,
          ),
          stableIdentityByName: await journalHeld(
            githubRoot,
            "association-identity",
            "owner/stable#1",
          ),
          legacyIdentityByName: await journalHeld(
            githubRoot,
            "association-identity",
            "owner/legacy#2",
          ),
          legacyPublicationByName: await journalHeld(
            githubRoot,
            "publication",
            "owner/legacy#2",
          ),
          stableRunFence: stableHeld,
          legacyRunFence: await runTargetFenceHeld(cwd, legacyRun.id),
        },
      });
      await writeDurableAtomic(filePath, content, "GitHub association index");
    },
  });

  const result = await adapter.handleWebhook(installationDeletedRequest("del-mixed-fanout"));
  assert.equal(result.status, 200);

  // `findAllByInstallation` orders by repository name, so the unresolved
  // legacy record is attempted first and the stable record second.
  assert.deepEqual(observations.map((entry) => entry.record), ["legacy", "stable"]);
  assert.deepEqual(observations[0]!.locks, {
    // The legacy branch acquires ONLY `run fence -> association transaction`.
    repositoryIdentity: false,
    stableIdentityById: false,
    stableIdentityByName: false,
    legacyIdentityByName: false,
    legacyPublicationByName: false,
    stableRunFence: false,
    legacyRunFence: true,
  });
  assert.deepEqual(observations[1]!.locks, {
    // The stable branch acquires the full documented chain.
    repositoryIdentity: true,
    stableIdentityById: true,
    stableIdentityByName: false,
    legacyIdentityByName: false,
    legacyPublicationByName: false,
    stableRunFence: true,
    legacyRunFence: false,
  });

  const stableIndexed = await index.findStable(STABLE_REPO_ID, 1);
  assert.equal(stableIndexed?.suspended, true);
  assert.equal(stableIndexed?.suspensionReason, "authorization-revoked");
  const legacyIndexed = await index.findLegacy("owner/legacy", 2);
  assert.equal(legacyIndexed?.suspended, true);
  assert.equal(legacyIndexed?.suspensionReason, "authorization-revoked");
  assert.equal(legacyIndexed?.repositoryId, undefined, "no repository id was invented");
  assert.equal(
    (await store.load(stableRun.id)).github?.suspensionReason,
    "authorization-revoked",
  );
  const reducedLegacyRun = await store.load(legacyRun.id);
  assert.equal(reducedLegacyRun.github?.suspensionReason, "authorization-revoked");
  assert.equal(reducedLegacyRun.github?.repositoryId, undefined);
});

test("legacy-only authority reduction never fences a repository identity", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-legacy-only-fanout-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const githubRoot = path.join(cwd, ".maswe", "github");
  const config = fanoutConfig();
  const index = new GitHubAssociationIndex(githubRoot);
  const run = await store.create("legacy-only", "req", config);
  run.github = {
    installationId: 44,
    repository: "owner/legacy",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(run);
  await seedLegacyAssociations(githubRoot, [{
    runId: run.id,
    installationId: 44,
    repository: "owner/legacy",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  }]);
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http: { async request() { throw new Error("authority reduction must not call GitHub"); } },
    repositoryTokenProvider: async () => {
      throw new Error("authority reduction must not mint a token");
    },
    synchronousWebhookDispatch: true,
  });

  const result = await adapter.handleWebhook(installationDeletedRequest("del-legacy-only"));
  assert.equal(result.status, 200);

  // Nothing may key a fence by an unresolved record's mutable name, and no
  // repository ID fence may be invented for a record that has no id.
  assert.equal(await fencedIdentityCount(githubRoot, "repository-identity"), 0);
  assert.equal(await fencedIdentityCount(githubRoot, "association-identity"), 0);
  // Only the journal preflight key: no name-keyed publication fence was taken.
  assert.equal(await fencedIdentityCount(githubRoot, "publication"), 1);
  assert.equal((await index.findLegacy("owner/legacy", 2))?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspended, true);
});

test("a failing legacy record does not skip the later stable record", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-mixed-failure-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const { config, index, stableRun, legacyRun } = await seedMixedInstallation(cwd, store);
  const failingStore: RunStore = {
    create: store.create.bind(store),
    load: store.load.bind(store),
    list: store.list.bind(store),
    applyEvent: store.applyEvent.bind(store),
    writeArtifact: store.writeArtifact.bind(store),
    readArtifact: store.readArtifact.bind(store),
    save: async (run) => {
      if (run.id === legacyRun.id && run.github?.suspended) {
        throw new Error("persistent legacy run-save failure");
      }
      await store.save(run);
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store: failingStore,
    http: { async request() { throw new Error("authority reduction must not call GitHub"); } },
    repositoryTokenProvider: async () => {
      throw new Error("authority reduction must not mint a token");
    },
    synchronousWebhookDispatch: true,
  });

  await assert.rejects(
    adapter.handleWebhook(installationDeletedRequest("del-mixed-failure")),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((nested) => /persistent legacy run-save failure/.test(String(nested))),
  );

  assert.equal(
    (await index.findStable(STABLE_REPO_ID, 1))?.suspensionReason,
    "authorization-revoked",
    "the later stable record is still attempted after the earlier failure",
  );
  assert.equal(
    (await store.load(stableRun.id)).github?.suspensionReason,
    "authorization-revoked",
  );
  assert.equal((await index.findLegacy("owner/legacy", 2))?.suspended, false);
  assert.equal((await store.load(legacyRun.id)).github?.suspended, false);
});

test("an index record pointing at a missing run reconciles only the index suspension", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-missing-run-fanout-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const githubRoot = path.join(cwd, ".maswe", "github");
  const config = fanoutConfig();
  const index = new GitHubAssociationIndex(githubRoot);
  await bindStableRecord(index, {
    runId: "run-that-never-existed",
    installationId: 44,
    repositoryId: STABLE_REPO_ID,
    repository: "owner/stable",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http: { async request() { throw new Error("authority reduction must not call GitHub"); } },
    repositoryTokenProvider: async () => {
      throw new Error("authority reduction must not mint a token");
    },
    synchronousWebhookDispatch: true,
  });

  const result = await adapter.handleWebhook(installationDeletedRequest("del-missing-run"));

  assert.equal(result.status, 200);
  const suspended = await index.findStable(STABLE_REPO_ID, 1);
  assert.equal(suspended?.suspended, true);
  assert.equal(suspended?.suspensionReason, "authorization-revoked");
  assert.equal(suspended?.runId, "run-that-never-existed", "no run was invented");
  assert.deepEqual(await store.list(), []);
});

test("a historical id-less removal cannot suspend a stable association by name", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-legacy-removal-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const githubRoot = path.join(cwd, ".maswe", "github");
  const config = fanoutConfig();
  const index = new GitHubAssociationIndex(githubRoot);
  const run = await store.create("stable-not-by-name", "req", config);
  run.github = {
    installationId: 44,
    repositoryId: STABLE_REPO_ID,
    repository: "owner/stable",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(run);
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: STABLE_REPO_ID,
    repository: "owner/stable",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http: { async request() { throw new Error("authority reduction must not call GitHub"); } },
    repositoryTokenProvider: async () => {
      throw new Error("authority reduction must not mint a token");
    },
    synchronousWebhookDispatch: true,
  });

  // A historical durable removal record naming exactly the stable
  // association's current repository text. Strict ingress rejects a new ID-less
  // payload, so the pre-#34 `repositories: string[]` shape is written straight
  // into durable state; the record reader migrates it to `legacyRepositories`.
  await adapter.initialize();
  const inbox = new GitHubDeliveryInbox(githubRoot);
  const deliveryId = "del-legacy-removal-by-name";
  await inbox.enqueue({
    deliveryId,
    eventName: "installation_repositories",
    receivedAt: "2026-08-11T00:00:00.000Z",
    rawBodyDigest: `sha256:${"c".repeat(64)}`,
    event: {
      eventId: deliveryId,
      type: "installation_repositories.removed",
      installationId: 44,
      repository: "owner/stable",
      repositories: [{ repositoryId: STABLE_REPO_ID, repository: "owner/stable" }],
      rawAction: "removed",
      receivedAt: "2026-08-11T00:00:00.000Z",
    },
  });
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  const statePath = path.join(
    githubRoot,
    "inbox",
    "state",
    hash.slice(0, 2),
    hash,
    "state.json",
  );
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
    event: Record<string, unknown>;
  };
  persisted.event.repositories = ["owner/stable"];
  await writeFile(statePath, `${JSON.stringify(persisted)}\n`, "utf8");

  await adapter.startWebhookWorker();
  await adapter.waitForWebhookIdle();
  await adapter.stopWebhookWorker();

  const indexed = await index.findStable(STABLE_REPO_ID, 1);
  assert.equal(indexed?.suspended, false, "a name-only event cannot suspend a stable record");
  assert.equal((await store.load(run.id)).github?.suspended, false);
  assert.equal(await fencedIdentityCount(githubRoot, "repository-identity"), 0);
});
