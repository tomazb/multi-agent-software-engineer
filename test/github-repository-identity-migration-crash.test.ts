import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import type { MasweConfig, RunRecord, WorkflowEventType } from "../src/domain.ts";
import {
  DurableAtomicWriteOutcomeUnknownError,
  writeDurableAtomic,
} from "../src/durable-file.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import {
  checkRunIdempotencyKey,
  externalIdFor,
  legacyCheckRunIdempotencyKey,
} from "../src/github/checks.ts";
import {
  RepositoryIdentityMigrationService,
  RepositoryIdentityMigrationError,
  type RepositoryIdentityMigrationStep,
} from "../src/github/repository-identity-migration.ts";
import { RepositoryIdentityMigrationStore } from "../src/github/repository-identity-migration-store.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { MASWE_CHECK_NAMES } from "../src/github/types.ts";
import { FileRunStore, type RunStore } from "../src/store.ts";

const REPO_ID = 4242;
const LEGACY = "owner/legacy";
const CANONICAL = "owner/renamed";
const HEAD_A = "a".repeat(40);
const INSTALLATION = 44;
const RESOURCE_ID = 900001;

function githubRootOf(cwd: string): string {
  return path.join(cwd, ".maswe", "github");
}

function config(): MasweConfig {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_TEST_GITHUB_MIGRATION_CRASH_SECRET",
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [REPO_ID],
      allowedRepositories: [LEGACY, CANONICAL],
    },
  });
}

interface World {
  canonical: string;
  headSha: string;
  state: "open" | "closed";
  checkRuns: Map<number, { id: number; name: string; head_sha: string; external_id: string }>;
  failListings: number;
  failCheckRunReads: number;
  requests: string[];
}

function createWorld(): World {
  return {
    canonical: CANONICAL,
    headSha: HEAD_A,
    state: "open",
    checkRuns: new Map(),
    failListings: 0,
    failCheckRunReads: 0,
    requests: [],
  };
}

function createHttp(world: World): GitHubHttpClient {
  return {
    async request(method, url, options) {
      world.requests.push(`${method} ${url}`);
      const authorization = options?.headers?.authorization ?? "";
      const match = authorization.match(/^Bearer inst:(\d+):repo:(\d+):([a-z-]+)$/);
      if (!match) throw new Error(`Unexpected authorization header: ${authorization}`);
      const parsed = new URL(url);

      if (parsed.pathname === "/installation/repositories") {
        if (world.failListings > 0) {
          world.failListings -= 1;
          throw new Error("simulated installation listing transport failure");
        }
        return {
          status: 200,
          headers: {},
          body: { repositories: [{ id: REPO_ID, full_name: world.canonical }] },
        };
      }

      if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(parsed.pathname)) {
        return {
          status: 200,
          headers: {},
          body: {
            state: world.state,
            head: { sha: world.headSha, ref: "maswe/topic" },
            base: {
              sha: "base-sha",
              ref: "main",
              repo: { id: REPO_ID, full_name: world.canonical },
            },
          },
        };
      }

      const checkRunMatch = parsed.pathname.match(/^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/);
      if (checkRunMatch) {
        if (world.failCheckRunReads > 0) {
          world.failCheckRunReads -= 1;
          return { status: 500, headers: {}, body: {} };
        }
        const row = world.checkRuns.get(Number(checkRunMatch[1]));
        if (!row) return { status: 404, headers: {}, body: {} };
        return {
          status: 200,
          headers: {},
          body: { name: row.name, head_sha: row.head_sha, external_id: row.external_id },
        };
      }

      const listMatch = parsed.pathname.match(
        /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/,
      );
      if (listMatch) {
        const headSha = decodeURIComponent(listMatch[1]!);
        const checkName = parsed.searchParams.get("check_name");
        const rows = [...world.checkRuns.values()].filter(
          (row) => row.head_sha === headSha && row.name === checkName,
        );
        return { status: 200, headers: {}, body: { check_runs: rows } };
      }

      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    },
  };
}

interface Harness {
  cwd: string;
  root: string;
  store: FileRunStore;
  index: GitHubAssociationIndex;
  sideEffects: GitHubSideEffectStore;
  checkpoints: RepositoryIdentityMigrationStore;
  world: World;
  http: GitHubHttpClient;
  runId: string;
  legacyKey: string;
  stableKey: string;
}

async function createHarness(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-migration-crash-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const root = githubRootOf(cwd);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new FileRunStore(cwd);
  const index = new GitHubAssociationIndex(root);
  const sideEffects = new GitHubSideEffectStore(root);
  const world = createWorld();

  let run = await store.create("migration crash", "request", config());
  const transitions: Array<[WorkflowEventType, string]> = [
    ["START", "user"],
    ["BRAINSTORM_COMPLETED", "brainstormer"],
    ["APPROVE_BRAINSTORM", "user"],
    ["DESIGN_COMPLETED", "designer"],
    ["APPROVE_DESIGN", "user"],
    ["BUILD_COMPLETED", "builder"],
    ["CI_PASSED", "quality"],
    ["VERIFY_PASSED", "verifier"],
    ["PR_OPENED", "github-app"],
  ];
  for (const [type, actor] of transitions) run = await store.applyEvent(run, type, actor);
  run.workspace = {
    remote: `https://github.com/${LEGACY}.git`,
    baseSha: "base-sha",
    headSha: HEAD_A,
    branch: "maswe/topic",
    fingerprint: "fingerprint",
  };
  run.github = {
    installationId: INSTALLATION,
    repository: LEGACY,
    pullRequestNumber: 7,
    baseSha: "base-sha",
    headSha: HEAD_A,
    branch: "maswe/topic",
    suspended: false,
  };
  await store.save(run);
  await index.withTransaction(async (transaction) =>
    transaction.bind({
      runId: run.id,
      installationId: INSTALLATION,
      repository: LEGACY,
      pullRequestNumber: 7,
      baseSha: "base-sha",
      headSha: HEAD_A,
      branch: "maswe/topic",
    }));

  const checkName = MASWE_CHECK_NAMES[0];
  const legacyKey = legacyCheckRunIdempotencyKey(LEGACY, 7, HEAD_A, checkName, 1);
  const stableKey = checkRunIdempotencyKey(REPO_ID, 7, HEAD_A, checkName, 1);
  world.checkRuns.set(RESOURCE_ID, {
    id: RESOURCE_ID,
    name: checkName,
    head_sha: HEAD_A,
    external_id: externalIdFor(legacyKey),
  });
  await sideEffects.put(legacyKey, { resourceId: RESOURCE_ID, kind: "check-run" });

  return {
    cwd,
    root,
    store,
    index,
    sideEffects,
    checkpoints: new RepositoryIdentityMigrationStore(root),
    world,
    http: createHttp(world),
    runId: run.id,
    legacyKey,
    stableKey,
  };
}

function createService(
  harness: Harness,
  options: {
    store?: RunStore;
    index?: GitHubAssociationIndex;
    sideEffects?: GitHubSideEffectStore;
    checkpoints?: RepositoryIdentityMigrationStore;
    afterStep?: (step: RepositoryIdentityMigrationStep) => Promise<void>;
  } = {},
): RepositoryIdentityMigrationService {
  return new RepositoryIdentityMigrationService({
    cwd: harness.cwd,
    config: config(),
    store: options.store ?? harness.store,
    associations: options.index ?? harness.index,
    sideEffects: options.sideEffects ?? harness.sideEffects,
    http: harness.http,
    tokenProvider: async (installationId, repositoryId, purpose) =>
      `inst:${installationId}:repo:${repositoryId}:${purpose}`,
    ...(options.afterStep ? { afterStep: options.afterStep } : {}),
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
  });
}

function trackedStore(store: FileRunStore, save: (run: RunRecord) => Promise<void>): RunStore {
  return {
    create: store.create.bind(store),
    load: store.load.bind(store),
    list: store.list.bind(store),
    writeArtifact: store.writeArtifact.bind(store),
    readArtifact: store.readArtifact.bind(store),
    applyEvent: store.applyEvent.bind(store),
    save,
  };
}

async function assertConverged(harness: Harness): Promise<void> {
  const run = await harness.store.load(harness.runId);
  assert.equal(run.github?.repositoryId, REPO_ID);
  assert.equal(run.github?.repository, CANONICAL);
  assert.equal(await harness.index.findLegacy(LEGACY, 7), undefined);
  assert.equal((await harness.index.findStable(REPO_ID, 7))?.repository, CANONICAL);
  assert.deepEqual(await harness.sideEffects.get(harness.stableKey), {
    resourceId: RESOURCE_ID,
    kind: "check-run",
  });
  assert.equal((await harness.checkpoints.read(REPO_ID, LEGACY))?.status, "complete");
}

// ---------------------------------------------------------------------------
// §19.8 injected failures at each documented boundary
// ---------------------------------------------------------------------------

test("a failure before the checkpoint leaves no state and restarts cleanly", async (t) => {
  const harness = await createHarness(t);
  harness.world.failListings = 1;

  await assert.rejects(() =>
    createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }));

  assert.equal(await harness.checkpoints.read(REPO_ID, LEGACY), undefined);
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, undefined);
  assert.notEqual(await harness.index.findLegacy(LEGACY, 7), undefined);

  await createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  await assertConverged(harness);
});

test("a failure immediately after the checkpoint restarts idempotently", async (t) => {
  const harness = await createHarness(t);
  let injected = false;
  await assert.rejects(() =>
    createService(harness, {
      afterStep: async (step) => {
        if (step !== "checkpoint-started" || injected) return;
        injected = true;
        throw new Error("crash after checkpoint");
      },
    }).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }));

  assert.equal(injected, true);
  assert.equal((await harness.checkpoints.read(REPO_ID, LEGACY))?.status, "in-progress");
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, undefined);

  await createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  await assertConverged(harness);
});

test("a known index commit failure after the run mutation rolls back and restarts cleanly", async (t) => {
  const harness = await createHarness(t);
  let armed = true;
  const failingIndex = new GitHubAssociationIndex(harness.root, {
    writeRecords: async (filePath, content) => {
      if (armed) {
        armed = false;
        throw new Error("simulated association index commit failure");
      }
      await writeDurableAtomic(filePath, content, "GitHub association index");
    },
  });

  await assert.rejects(
    () =>
      createService(harness, { index: failingIndex }).migrate({
        legacyRepository: LEGACY,
        repositoryId: REPO_ID,
      }),
    /simulated association index commit failure/,
  );
  assert.equal(armed, false);
  // The known failure compensated the run; neither copy moved.
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, undefined);
  assert.notEqual(await harness.index.findLegacy(LEGACY, 7), undefined);

  await createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  await assertConverged(harness);
});

test("a failure after the index commit and before the checkpoint refresh restarts idempotently", async (t) => {
  const harness = await createHarness(t);
  let injected = false;
  await assert.rejects(() =>
    createService(harness, {
      afterStep: async (step) => {
        if (step !== "association-published" || injected) return;
        injected = true;
        throw new Error("crash after index commit");
      },
    }).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }));

  assert.equal(injected, true);
  // Run and index are already stable; the checkpoint is still in progress.
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, REPO_ID);
  assert.equal(await harness.index.findLegacy(LEGACY, 7), undefined);
  assert.equal((await harness.checkpoints.read(REPO_ID, LEGACY))?.status, "in-progress");
  assert.equal(await harness.sideEffects.get(harness.stableKey), undefined);

  await createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  await assertConverged(harness);
});

test("a failure during stable check aliasing restarts and publishes the alias", async (t) => {
  const harness = await createHarness(t);
  harness.world.failCheckRunReads = 1;

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    /HTTP 500/,
  );
  assert.equal(await harness.sideEffects.get(harness.stableKey), undefined);
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, REPO_ID);
  assert.notEqual((await harness.checkpoints.read(REPO_ID, LEGACY))?.status, "complete");

  await createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  await assertConverged(harness);
});

test("a failure after every association is stable but before completion restarts idempotently", async (t) => {
  const harness = await createHarness(t);
  let injected = false;
  await assert.rejects(() =>
    createService(harness, {
      afterStep: async (step) => {
        if (step !== "before-complete" || injected) return;
        injected = true;
        throw new Error("crash before completion");
      },
    }).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }));

  assert.equal(injected, true);
  assert.equal((await harness.checkpoints.read(REPO_ID, LEGACY))?.status, "in-progress");
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, REPO_ID);
  assert.deepEqual(await harness.sideEffects.get(harness.stableKey), {
    resourceId: RESOURCE_ID,
    kind: "check-run",
  });

  await createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  await assertConverged(harness);
});

// ---------------------------------------------------------------------------
// §13.2 outcome-unknown durable writes: re-read and reconcile, never blind rollback
// ---------------------------------------------------------------------------

test("an outcome-unknown run write is reconciled by re-reading rather than rolled back", async (t) => {
  const harness = await createHarness(t);
  let armed = true;
  const store = trackedStore(harness.store, async (run) => {
    await harness.store.save(run);
    if (armed && run.github?.repositoryId === REPO_ID) {
      armed = false;
      throw new DurableAtomicWriteOutcomeUnknownError("Run record", new Error("sync failed"));
    }
  });

  const result = await createService(harness, { store }).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });
  assert.equal(armed, false);
  assert.equal(result.status, "complete");
  await assertConverged(harness);
});

test("an outcome-unknown index write is reconciled by re-reading rather than rolled back", async (t) => {
  const harness = await createHarness(t);
  let armed = true;
  const index = new GitHubAssociationIndex(harness.root, {
    writeRecords: async (filePath, content) => {
      await writeDurableAtomic(filePath, content, "GitHub association index");
      if (armed) {
        armed = false;
        throw new DurableAtomicWriteOutcomeUnknownError(
          "GitHub association index",
          new Error("sync failed"),
        );
      }
    },
  });

  const result = await createService(harness, { index }).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });
  assert.equal(armed, false);
  assert.equal(result.status, "complete");
  // The run mutation was never blindly rolled back: both copies agree on the stable identity.
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, REPO_ID);
  await assertConverged(harness);
});

test("an outcome-unknown checkpoint write is reconciled by re-reading the checkpoint", async (t) => {
  const harness = await createHarness(t);
  let armed = true;
  const checkpoints = new RepositoryIdentityMigrationStore(harness.root, {
    syncDirectory: async (directoryPath) => {
      if (armed && directoryPath.endsWith("repository-identity-migrations")) {
        armed = false;
        throw new DurableAtomicWriteOutcomeUnknownError(
          "GitHub repository identity migration checkpoint",
          new Error("sync failed"),
        );
      }
    },
  });

  const result = await createService(harness, { checkpoints }).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });
  assert.equal(armed, false);
  assert.equal(result.status, "complete");
  await assertConverged(harness);
});

test("an outcome-unknown side-effect alias write is reconciled by re-reading the alias", async (t) => {
  const harness = await createHarness(t);
  // Armed exactly once, for the first alias write of the first pass.
  let mayArm = true;
  let armed = false;
  let triggered = false;
  const sideEffects = new GitHubSideEffectStore(harness.root, {
    syncDirectory: async (directoryPath) => {
      if (armed && directoryPath.endsWith("side-effects")) {
        armed = false;
        triggered = true;
        throw new DurableAtomicWriteOutcomeUnknownError(
          "GitHub side-effect record",
          new Error("sync failed"),
        );
      }
    },
  });

  const result = await createService(harness, {
    sideEffects,
    afterStep: async (step) => {
      if (step === "association-published" && mayArm) {
        mayArm = false;
        armed = true;
      }
    },
  }).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });

  assert.equal(triggered, true);
  assert.equal(armed, false);
  assert.equal(result.status, "complete");
  assert.deepEqual(await sideEffects.get(harness.stableKey), {
    resourceId: RESOURCE_ID,
    kind: "check-run",
  });
  await assertConverged(harness);
});

test("a restart whose run is stable but whose index is still legacy converges", async (t) => {
  // The exact on-disk shape left by a crash between the run publication and the
  // association index commit.
  const harness = await createHarness(t);
  const run = await harness.store.load(harness.runId);
  run.github = { ...run.github!, repositoryId: REPO_ID, repository: CANONICAL };
  await harness.store.save(run);

  await createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  await assertConverged(harness);
});

test("a restart whose run carries a foreign stable id fails on a concrete conflict", async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.load(harness.runId);
  run.github = { ...run.github!, repositoryId: 777001, repository: CANONICAL };
  await harness.store.save(run);

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError && error.code === "run-index-conflict",
  );
  assert.equal((await harness.store.load(harness.runId)).github?.repositoryId, 777001);
  assert.notEqual(await harness.index.findLegacy(LEGACY, 7), undefined);
});

test("the completed checkpoint is not rewritten by a converged rerun", async (t) => {
  const harness = await createHarness(t);
  const service = createService(harness);
  await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  const checkpointPath = harness.checkpoints.recordPath(REPO_ID, LEGACY);
  const before = await readFile(checkpointPath, "utf8");
  await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  assert.equal(await readFile(checkpointPath, "utf8"), before);
});
