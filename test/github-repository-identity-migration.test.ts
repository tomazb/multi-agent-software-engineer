import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import type { MasweConfig, RunRecord, WorkflowEventType } from "../src/domain.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import {
  checkRunIdempotencyKey,
  externalIdFor,
  legacyCheckRunIdempotencyKey,
} from "../src/github/checks.ts";
import { withGitHubJournal } from "../src/github/journal.ts";
import {
  RepositoryIdentityMigrationService,
  RepositoryIdentityMigrationError,
  type RepositoryIdentityMigrationStep,
} from "../src/github/repository-identity-migration.ts";
import {
  RepositoryIdentityMigrationStore,
  repositoryIdentityMigrationFilename,
  type RepositoryIdentityMigrationRecord,
} from "../src/github/repository-identity-migration-store.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { MASWE_CHECK_NAMES } from "../src/github/types.ts";
import { FileRunStore, type RunStore } from "../src/store.ts";

const REPO_ID = 4242;
const OTHER_REPO_ID = 9191;
const LEGACY = "owner/legacy";
const CANONICAL = "owner/renamed";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const INSTALLATION = 44;

function githubRootOf(cwd: string): string {
  return path.join(cwd, ".maswe", "github");
}

function config(options: { repositoryIds?: number[] } = {}): MasweConfig {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_TEST_GITHUB_MIGRATION_SECRET",
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: options.repositoryIds ?? [REPO_ID],
      allowedRepositories: [LEGACY, CANONICAL],
    },
  });
}

interface WorldPullRequest {
  state: "open" | "closed";
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  baseRepositoryId: number;
  baseRepository: string;
}

interface CheckRunRow {
  id: number;
  name: string;
  head_sha: string;
  external_id: string;
}

interface World {
  installations: Map<number, Array<{ id: number; full_name: string }>>;
  pullRequests: Map<number, WorldPullRequest>;
  checkRuns: Map<number, CheckRunRow>;
  requests: string[];
  routedRepositories: Set<string>;
  failCheckRunReads: number;
  failListings: number;
}

function createWorld(options: {
  canonical?: string;
  installations?: number[];
  pullRequests?: Record<number, Partial<WorldPullRequest>>;
} = {}): World {
  const canonical = options.canonical ?? CANONICAL;
  const installations = new Map<number, Array<{ id: number; full_name: string }>>();
  for (const installationId of options.installations ?? [INSTALLATION]) {
    installations.set(installationId, [{ id: REPO_ID, full_name: canonical }]);
  }
  const pullRequests = new Map<number, WorldPullRequest>();
  for (const [number, overrides] of Object.entries(options.pullRequests ?? { 7: {} })) {
    pullRequests.set(Number(number), {
      state: "open",
      headSha: HEAD_A,
      headRef: "maswe/topic",
      baseSha: "base-sha",
      baseRef: "main",
      baseRepositoryId: REPO_ID,
      baseRepository: canonical,
      ...overrides,
    });
  }
  return {
    installations,
    pullRequests,
    checkRuns: new Map(),
    requests: [],
    routedRepositories: new Set(),
    failCheckRunReads: 0,
    failListings: 0,
  };
}

function tokenFor(installationId: number, repositoryId: number, purpose: string): string {
  return `inst:${installationId}:repo:${repositoryId}:${purpose}`;
}

function parseToken(headers: Record<string, string> | undefined): {
  installationId: number;
  repositoryId: number;
  purpose: string;
} {
  const authorization = headers?.authorization ?? "";
  const match = authorization.match(/^Bearer inst:(\d+):repo:(\d+):([a-z-]+)$/);
  if (!match) throw new Error(`Unexpected authorization header: ${authorization}`);
  return {
    installationId: Number(match[1]),
    repositoryId: Number(match[2]),
    purpose: match[3]!,
  };
}

function createHttp(world: World): GitHubHttpClient {
  return {
    async request(method, url, options) {
      world.requests.push(`${method} ${url}`);
      const token = parseToken(options?.headers);
      const parsed = new URL(url);

      if (parsed.pathname === "/installation/repositories") {
        if (world.failListings > 0) {
          world.failListings -= 1;
          throw new Error("simulated installation listing transport failure");
        }
        assert.equal(token.purpose, "metadata-reconcile");
        assert.equal(token.repositoryId, REPO_ID);
        const repositories = world.installations.get(token.installationId) ?? [];
        return { status: 200, headers: {}, body: { repositories } };
      }

      const pullMatch = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
      if (pullMatch) {
        assert.equal(token.purpose, "pull-request-read");
        world.routedRepositories.add(`${pullMatch[1]}/${pullMatch[2]}`);
        const pull = world.pullRequests.get(Number(pullMatch[3]));
        if (!pull) return { status: 404, headers: {}, body: {} };
        return {
          status: 200,
          headers: {},
          body: {
            state: pull.state,
            head: { sha: pull.headSha, ref: pull.headRef },
            base: {
              sha: pull.baseSha,
              ref: pull.baseRef,
              repo: { id: pull.baseRepositoryId, full_name: pull.baseRepository },
            },
          },
        };
      }

      const checkRunMatch = parsed.pathname.match(
        /^\/repos\/([^/]+)\/([^/]+)\/check-runs\/(\d+)$/,
      );
      if (checkRunMatch) {
        assert.equal(token.purpose, "checks");
        world.routedRepositories.add(`${checkRunMatch[1]}/${checkRunMatch[2]}`);
        if (world.failCheckRunReads > 0) {
          world.failCheckRunReads -= 1;
          return { status: 500, headers: {}, body: {} };
        }
        const row = world.checkRuns.get(Number(checkRunMatch[3]));
        if (!row) return { status: 404, headers: {}, body: {} };
        return {
          status: 200,
          headers: {},
          body: { name: row.name, head_sha: row.head_sha, external_id: row.external_id },
        };
      }

      const listMatch = parsed.pathname.match(
        /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-runs$/,
      );
      if (listMatch) {
        assert.equal(token.purpose, "checks");
        world.routedRepositories.add(`${listMatch[1]}/${listMatch[2]}`);
        const headSha = decodeURIComponent(listMatch[3]!);
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
  store: FileRunStore;
  index: GitHubAssociationIndex;
  sideEffects: GitHubSideEffectStore;
  world: World;
  http: GitHubHttpClient;
  checkpoints: RepositoryIdentityMigrationStore;
}

async function createHarness(
  t: { after(fn: () => Promise<void> | void): void },
  world: World,
): Promise<Harness> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-repo-migration-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const root = githubRootOf(cwd);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return {
    cwd,
    store,
    index: new GitHubAssociationIndex(root),
    sideEffects: new GitHubSideEffectStore(root),
    world,
    http: createHttp(world),
    checkpoints: new RepositoryIdentityMigrationStore(root),
  };
}

/** Seeds a PR_READY run plus its unresolved legacy `<repository>#<pr>` index record. */
async function seedLegacyRun(
  harness: Harness,
  options: {
    pullRequestNumber?: number;
    installationId?: number;
    headSha?: string;
    repository?: string;
    title?: string;
  } = {},
): Promise<RunRecord> {
  const pullRequestNumber = options.pullRequestNumber ?? 7;
  const installationId = options.installationId ?? INSTALLATION;
  const headSha = options.headSha ?? HEAD_A;
  const repository = options.repository ?? LEGACY;
  let run = await harness.store.create(
    options.title ?? `migration ${pullRequestNumber}`,
    "request",
    config(),
  );
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
  for (const [type, actor] of transitions) {
    run = await harness.store.applyEvent(run, type, actor);
  }
  run.workspace = {
    remote: `https://github.com/${repository}.git`,
    baseSha: "base-sha",
    headSha,
    branch: "maswe/topic",
    fingerprint: "fingerprint",
  };
  run.github = {
    installationId,
    repository,
    pullRequestNumber,
    baseSha: "base-sha",
    headSha,
    branch: "maswe/topic",
    suspended: false,
  };
  run.evidence = {
    quality: { headSha, passed: true, at: "2026-08-18T10:00:00.000Z" },
    verification: { headSha, passed: true, at: "2026-08-18T10:01:00.000Z" },
  };
  await harness.store.save(run);
  await harness.index.withTransaction(async (transaction) =>
    transaction.bind({
      runId: run.id,
      installationId,
      repository,
      pullRequestNumber,
      baseSha: "base-sha",
      headSha,
      branch: "maswe/topic",
    }));
  return harness.store.load(run.id);
}

function createService(
  harness: Harness,
  options: {
    config?: MasweConfig;
    afterStep?: (step: RepositoryIdentityMigrationStep) => Promise<void>;
    store?: RunStore;
    index?: GitHubAssociationIndex;
    sideEffects?: GitHubSideEffectStore;
    checkpoints?: RepositoryIdentityMigrationStore;
  } = {},
): RepositoryIdentityMigrationService {
  return new RepositoryIdentityMigrationService({
    cwd: harness.cwd,
    config: options.config ?? config(),
    store: options.store ?? harness.store,
    associations: options.index ?? harness.index,
    sideEffects: options.sideEffects ?? harness.sideEffects,
    http: harness.http,
    tokenProvider: async (installationId, repositoryId, purpose) =>
      tokenFor(installationId, repositoryId, purpose),
    ...(options.afterStep ? { afterStep: options.afterStep } : {}),
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
  });
}

/** Seeds the pre-#34 attempt-1 side-effect record and its live GitHub check run. */
async function seedLegacyCheck(
  harness: Harness,
  options: {
    legacyRepository?: string;
    pullRequestNumber?: number;
    headSha?: string;
    resourceId?: number;
    withLocalRecord?: boolean;
  } = {},
): Promise<{ legacyKey: string; stableKey: string; resourceId: number }> {
  const legacyRepository = options.legacyRepository ?? LEGACY;
  const pullRequestNumber = options.pullRequestNumber ?? 7;
  const headSha = options.headSha ?? HEAD_A;
  const resourceId = options.resourceId ?? 900001;
  const checkName = MASWE_CHECK_NAMES[0];
  const legacyKey = legacyCheckRunIdempotencyKey(
    legacyRepository,
    pullRequestNumber,
    headSha,
    checkName,
    1,
  );
  const stableKey = checkRunIdempotencyKey(
    REPO_ID,
    pullRequestNumber,
    headSha,
    checkName,
    1,
  );
  harness.world.checkRuns.set(resourceId, {
    id: resourceId,
    name: checkName,
    head_sha: headSha,
    external_id: externalIdFor(legacyKey),
  });
  if (options.withLocalRecord !== false) {
    await harness.sideEffects.put(legacyKey, { resourceId, kind: "check-run" });
  }
  return { legacyKey, stableKey, resourceId };
}

// ---------------------------------------------------------------------------
// Step 1: checkpoint store
// ---------------------------------------------------------------------------

function checkpointRecord(
  overrides: Partial<RepositoryIdentityMigrationRecord> = {},
): RepositoryIdentityMigrationRecord {
  return {
    version: 1,
    repositoryId: REPO_ID,
    legacyRepository: LEGACY,
    canonicalRepository: CANONICAL,
    status: "in-progress",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    ...overrides,
  };
}

test("checkpoint filename is sha256(repositoryId + NUL + legacyRepository)", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-migration-store-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const root = githubRootOf(cwd);
  await mkdir(root, { recursive: true, mode: 0o700 });

  const expected = `${createHash("sha256")
    .update(`${REPO_ID}\0${LEGACY}`)
    .digest("hex")}.json`;
  assert.equal(repositoryIdentityMigrationFilename(REPO_ID, LEGACY), expected);

  const store = new RepositoryIdentityMigrationStore(root);
  assert.equal(
    store.recordPath(REPO_ID, LEGACY),
    path.join(root, "repository-identity-migrations", expected),
  );

  await store.write(checkpointRecord());
  assert.deepEqual(await store.read(REPO_ID, LEGACY), checkpointRecord());
  assert.equal(await store.read(OTHER_REPO_ID, LEGACY), undefined);
  assert.deepEqual(await store.list(), [checkpointRecord()]);
});

test("checkpoint store rejects malformed, oversize, and symlinked state", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-migration-store-bad-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const root = githubRootOf(cwd);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new RepositoryIdentityMigrationStore(root, { maxFileBytes: 4096 });

  await assert.rejects(
    () => store.write(checkpointRecord({ version: 2 as 1 })),
    /repository identity migration checkpoint/i,
  );
  await assert.rejects(
    () => store.write(checkpointRecord({ legacyRepository: "Owner/Legacy" })),
    /repository identity migration checkpoint/i,
  );
  await assert.rejects(
    () => store.write(checkpointRecord({ repositoryId: 0 })),
    /repository identity migration checkpoint/i,
  );
  await assert.rejects(
    () => store.write(checkpointRecord({ startedAt: "not-a-timestamp" })),
    /repository identity migration checkpoint/i,
  );

  await store.write(checkpointRecord());
  const recordPath = store.recordPath(REPO_ID, LEGACY);

  await writeFile(recordPath, "{ not json", "utf8");
  await assert.rejects(() => store.read(REPO_ID, LEGACY), /migration checkpoint/i);
  await assert.rejects(() => store.list(), /migration checkpoint/i);

  await writeFile(
    recordPath,
    `${JSON.stringify({ ...checkpointRecord(), extra: true })}\n`,
    "utf8",
  );
  await assert.rejects(() => store.read(REPO_ID, LEGACY), /migration checkpoint/i);

  await writeFile(recordPath, `${JSON.stringify(checkpointRecord())}\n${"x".repeat(5000)}`, "utf8");
  await assert.rejects(() => store.read(REPO_ID, LEGACY), /bounded/i);

  await rm(recordPath);
  await symlink(path.join(root, "elsewhere.json"), recordPath);
  await writeFile(path.join(root, "elsewhere.json"), `${JSON.stringify(checkpointRecord())}\n`);
  await assert.rejects(() => store.read(REPO_ID, LEGACY), /ordinary local file/i);
});

test("checkpoint list skips its own durable temp residue but still fails closed and names other unrecognized entries", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-migration-store-residue-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const root = githubRootOf(cwd);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new RepositoryIdentityMigrationStore(root);
  await store.write(checkpointRecord());
  const checkpointDir = path.join(root, "repository-identity-migrations");

  // The exact `.<basename>.<uuid>.tmp` shape `writeDurableAtomic` stages inside
  // the target directory before an atomic rename -- residue from a rename
  // killed mid-flight. It was never durably committed and carries no conflict
  // information a fail-closed scan could act on.
  const filename = repositoryIdentityMigrationFilename(REPO_ID, LEGACY);
  const strayTempPath = path.join(checkpointDir, `.${filename}.${randomUUID()}.tmp`);
  await writeFile(strayTempPath, "partial write residue from a killed rename", "utf8");
  assert.deepEqual(await store.list(), [checkpointRecord()]);

  // A genuinely unrecognized entry must still fail closed, and the error must
  // name it so an operator without a debugger can find and remove it.
  const mysteryPath = path.join(checkpointDir, "mystery.json.bak");
  await writeFile(mysteryPath, "not a checkpoint", "utf8");
  await assert.rejects(
    () => store.list(),
    (error: unknown) =>
      error instanceof Error &&
      /migration checkpoint/i.test(error.message) &&
      error.message.includes("mystery.json.bak"),
  );
});

// ---------------------------------------------------------------------------
// Step 2: happy path, rerun no-op, selector conflict
// ---------------------------------------------------------------------------

test("migration binds stable identity, current canonical name, and check aliases", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const alias = await seedLegacyCheck(harness);

  const service = createService(harness);
  const result = await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });

  assert.equal(result.status, "complete");
  assert.equal(result.repositoryId, REPO_ID);
  assert.equal(result.legacyRepository, LEGACY);
  assert.equal(result.canonicalRepository, CANONICAL);
  assert.deepEqual(result.installationIds, [INSTALLATION]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.migratedFromLegacy, true);

  const migrated = await harness.store.load(run.id);
  assert.equal(migrated.github?.repositoryId, REPO_ID);
  assert.equal(migrated.github?.repository, CANONICAL);
  assert.equal(migrated.github?.headSha, HEAD_A);
  // §14: an unchanged live head preserves existing SHA-bound evidence.
  assert.deepEqual(migrated.evidence, run.evidence);

  assert.equal(await harness.index.findLegacy(LEGACY, 7), undefined);
  const stable = await harness.index.findStable(REPO_ID, 7);
  assert.equal(stable?.repository, CANONICAL);
  assert.equal(stable?.runId, run.id);

  assert.deepEqual(await harness.sideEffects.get(alias.stableKey), {
    resourceId: alias.resourceId,
    kind: "check-run",
  });
  // Old side-effect records remain historical evidence.
  assert.deepEqual(await harness.sideEffects.get(alias.legacyKey), {
    resourceId: alias.resourceId,
    kind: "check-run",
  });

  const checkpoint = await harness.checkpoints.read(REPO_ID, LEGACY);
  assert.equal(checkpoint?.status, "complete");
  assert.equal(checkpoint?.canonicalRepository, CANONICAL);

  // Every authenticated route uses the reconciled canonical name, never the selector.
  assert.deepEqual([...world.routedRepositories], [CANONICAL]);
});

test("aliasing runs for a repository that was never renamed", async (t) => {
  // upsertCheck derives its idempotency key from repositoryId, so every pre-#34
  // attempt-1 check is unfindable under the stable key even when the name is
  // unchanged. Aliasing must therefore not be conditional on a rename.
  const world = createWorld({ canonical: LEGACY });
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness);
  const alias = await seedLegacyCheck(harness);

  const result = await createService(harness).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });

  assert.equal(result.canonicalRepository, LEGACY);
  assert.deepEqual(await harness.sideEffects.get(alias.stableKey), {
    resourceId: alias.resourceId,
    kind: "check-run",
  });
  assert.equal(result.candidates[0]?.aliasedHeadShas.includes(HEAD_A), true);
});

test("rerunning a completed migration is a no-op after live proof", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const service = createService(harness);
  await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });

  const checkpointPath = harness.checkpoints.recordPath(REPO_ID, LEGACY);
  const indexPath = path.join(githubRootOf(harness.cwd), "associations.json");
  const checkpointBefore = await readFile(checkpointPath, "utf8");
  const indexBefore = await readFile(indexPath, "utf8");
  const runBefore = await harness.store.load(run.id);
  const requestsBefore = world.requests.length;

  const rerun = await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  assert.equal(rerun.status, "complete");
  assert.equal(rerun.candidates.every((candidate) => !candidate.migratedFromLegacy), true);

  assert.equal(await readFile(checkpointPath, "utf8"), checkpointBefore);
  assert.equal(await readFile(indexPath, "utf8"), indexBefore);
  const runAfter = await harness.store.load(run.id);
  assert.equal(runAfter.version, runBefore.version);
  // The rerun still proved liveness rather than trusting the checkpoint.
  assert.equal(world.requests.length > requestsBefore, true);
});

test("the same normalized selector with a different repository id conflicts and mutates nothing", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  await harness.checkpoints.write(checkpointRecord({
    repositoryId: OTHER_REPO_ID,
    status: "complete",
  }));

  const indexPath = path.join(githubRootOf(harness.cwd), "associations.json");
  const indexBefore = await readFile(indexPath, "utf8");

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError &&
      error.code === "selector-identity-conflict",
  );

  assert.equal(await readFile(indexPath, "utf8"), indexBefore);
  assert.equal((await harness.store.load(run.id)).github?.repositoryId, undefined);
  assert.equal(await harness.checkpoints.read(REPO_ID, LEGACY), undefined);
  assert.equal(world.requests.length, 0);
});

test("a mixed-case --from selector normalizes to the lowercase selector everywhere", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const alias = await seedLegacyCheck(harness);

  const result = await createService(harness).migrate({
    legacyRepository: "Owner/Legacy",
    repositoryId: REPO_ID,
  });

  assert.equal(result.legacyRepository, LEGACY);
  assert.equal((await harness.checkpoints.read(REPO_ID, LEGACY))?.status, "complete");
  assert.equal((await harness.store.load(run.id)).github?.repositoryId, REPO_ID);
  // The alias key is derived from the normalized selector, not the raw argument.
  assert.deepEqual(await harness.sideEffects.get(alias.stableKey), {
    resourceId: alias.resourceId,
    kind: "check-run",
  });
});

test("an empty candidate universe fails closed instead of writing an unproven checkpoint", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError &&
      error.code === "no-migration-candidates",
  );
  assert.equal(await harness.checkpoints.read(REPO_ID, LEGACY), undefined);
});

// ---------------------------------------------------------------------------
// Step 3: union candidate universe
// ---------------------------------------------------------------------------

test("the candidate universe unions legacy-by-name with already-stable-by-id records", async (t) => {
  const world = createWorld({ pullRequests: { 7: {}, 8: {} } });
  const harness = await createHarness(t, world);
  const legacyRun = await seedLegacyRun(harness, { pullRequestNumber: 7 });
  const stableRun = await seedLegacyRun(harness, { pullRequestNumber: 8, title: "already" });

  // Simulate a prior partial pass: PR 8 is already stable, but under the pre-rename name.
  const migratedRun = await harness.store.load(stableRun.id);
  migratedRun.github = { ...migratedRun.github!, repositoryId: REPO_ID };
  await harness.store.save(migratedRun);
  await harness.index.withTransaction(async (transaction) =>
    transaction.migrateLegacy({
      legacyRepository: LEGACY,
      stable: {
        runId: stableRun.id,
        installationId: INSTALLATION,
        repositoryId: REPO_ID,
        repository: LEGACY,
        pullRequestNumber: 8,
        baseSha: "base-sha",
        headSha: HEAD_A,
        branch: "maswe/topic",
      },
    }));

  const result = await createService(harness).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.pullRequestNumber).sort(),
    [7, 8],
  );
  assert.equal((await harness.store.load(legacyRun.id)).github?.repositoryId, REPO_ID);
  // The partially migrated run stayed visible and had its canonical name refreshed.
  assert.equal((await harness.index.findStable(REPO_ID, 8))?.repository, CANONICAL);
  assert.equal((await harness.store.load(stableRun.id)).github?.repository, CANONICAL);
});

test("the installation proof set is re-derived from the union after partial mutation", async (t) => {
  const world = createWorld({
    installations: [INSTALLATION, 55],
    pullRequests: { 7: {}, 8: {} },
  });
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness, { pullRequestNumber: 7, installationId: INSTALLATION });
  const second = await seedLegacyRun(harness, {
    pullRequestNumber: 8,
    installationId: 55,
    title: "second installation",
  });

  // PR 8 is already stable (installation 55 no longer appears in the legacy set).
  const migratedRun = await harness.store.load(second.id);
  migratedRun.github = { ...migratedRun.github!, repositoryId: REPO_ID, repository: CANONICAL };
  await harness.store.save(migratedRun);
  await harness.index.withTransaction(async (transaction) =>
    transaction.migrateLegacy({
      legacyRepository: LEGACY,
      stable: {
        runId: second.id,
        installationId: 55,
        repositoryId: REPO_ID,
        repository: CANONICAL,
        pullRequestNumber: 8,
        baseSha: "base-sha",
        headSha: HEAD_A,
        branch: "maswe/topic",
      },
    }));

  const result = await createService(harness).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });
  assert.deepEqual(result.installationIds, [INSTALLATION, 55]);

  // Every installation in the union proved the id through a bounded canonical lookup.
  const listings = world.requests.filter((request) =>
    request.includes("/installation/repositories"));
  assert.equal(listings.length >= 2, true);
});

// ---------------------------------------------------------------------------
// Step 4: proofs and lifecycle
// ---------------------------------------------------------------------------

test("an installation that cannot see the repository id blocks migration", async (t) => {
  const world = createWorld();
  world.installations.set(INSTALLATION, [{ id: 777, full_name: "owner/other" }]);
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError &&
      error.code === "installation-proof-failed",
  );
  assert.equal((await harness.store.load(run.id)).github?.repositoryId, undefined);
  assert.equal(await harness.checkpoints.read(REPO_ID, LEGACY), undefined);
});

test("a pull request whose base repository id differs is a permanent identity conflict", async (t) => {
  const world = createWorld();
  world.pullRequests.get(7)!.baseRepositoryId = 5150;
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError &&
      error.code === "pull-request-identity-conflict",
  );
  assert.equal((await harness.store.load(run.id)).github?.repositoryId, undefined);
  assert.equal(await harness.index.findLegacy(LEGACY, 7) !== undefined, true);
});

test("a closed pull request migrates and applies the pull-request-closed suspension", async (t) => {
  const world = createWorld();
  world.pullRequests.get(7)!.state = "closed";
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);

  const result = await createService(harness).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });
  assert.equal(result.candidates[0]?.suspended, true);

  const migrated = await harness.store.load(run.id);
  assert.equal(migrated.github?.repositoryId, REPO_ID);
  assert.equal(migrated.github?.suspended, true);
  assert.equal(migrated.github?.suspensionReason, "pull-request-closed");
  const stable = await harness.index.findStable(REPO_ID, 7);
  assert.equal(stable?.suspended, true);
  assert.equal(stable?.suspensionReason, "pull-request-closed");
});

test("a stable record already suspended without a reason on an open pull request gets no fabricated closure reason", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);

  // Model a record that is already stable (repositoryId bound) and already
  // suspended, but with no reason on record -- e.g. a restart that left the
  // run mutation durable before any reason was chosen -- and whose canonical
  // name still needs refreshing so this candidate performs work. The PR is
  // (and stays) open: findAllLegacyByRepository excludes suspended legacy
  // records from the candidate universe, so this can only be modelled on the
  // stable arm, which includes suspended records regardless of state.
  const stableRun = await harness.store.load(run.id);
  stableRun.github = { ...stableRun.github!, repositoryId: REPO_ID, repository: LEGACY, suspended: true };
  await harness.store.save(stableRun);
  await harness.index.withTransaction(async (transaction) =>
    transaction.migrateLegacy({
      legacyRepository: LEGACY,
      stable: {
        runId: run.id,
        installationId: INSTALLATION,
        repositoryId: REPO_ID,
        repository: LEGACY,
        pullRequestNumber: 7,
        baseSha: "base-sha",
        headSha: HEAD_A,
        branch: "maswe/topic",
        suspended: true,
      },
    }));

  const result = await createService(harness).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });
  assert.equal(result.candidates[0]?.suspended, true);

  const migrated = await harness.store.load(run.id);
  assert.equal(migrated.github?.repository, CANONICAL);
  assert.equal(migrated.github?.suspended, true);
  // Must not fabricate "pull-request-closed": the PR was never observed closed.
  assert.equal(migrated.github?.suspensionReason, undefined);
  const stable = await harness.index.findStable(REPO_ID, 7);
  assert.equal(stable?.suspended, true);
  assert.equal(stable?.suspensionReason, undefined);
});

test("a second rename during restart reconciles the same id onto the newer canonical name", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const service = createService(harness);
  await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  assert.equal((await harness.index.findStable(REPO_ID, 7))?.repository, CANONICAL);

  const renamedAgain = "owner/renamed-again";
  world.installations.set(INSTALLATION, [{ id: REPO_ID, full_name: renamedAgain }]);
  world.pullRequests.get(7)!.baseRepository = renamedAgain;

  const restarted = await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  assert.equal(restarted.canonicalRepository, renamedAgain);
  assert.equal((await harness.index.findStable(REPO_ID, 7))?.repository, renamedAgain);
  assert.equal((await harness.store.load(run.id)).github?.repository, renamedAgain);
  assert.equal(
    (await harness.checkpoints.read(REPO_ID, LEGACY))?.canonicalRepository,
    renamedAgain,
  );
});

test("run and index state that disagree stops migration", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const drifted = await harness.store.load(run.id);
  drifted.github = { ...drifted.github!, branch: "maswe/other" };
  await harness.store.save(drifted);

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError && error.code === "run-index-conflict",
  );
  assert.equal((await harness.store.load(run.id)).github?.repositoryId, undefined);
});

test("an index record whose run has no github association stops migration", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const stripped = await harness.store.load(run.id);
  delete stripped.github;
  await harness.store.save(stripped);

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError && error.code === "run-index-conflict",
  );
});

// ---------------------------------------------------------------------------
// Step 5: stale head and the exact lock sequence
// ---------------------------------------------------------------------------

test("a changed live head updates the association, pends cancellation, and routes revalidation", async (t) => {
  const world = createWorld();
  world.pullRequests.get(7)!.headSha = HEAD_B;
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const alias = await seedLegacyCheck(harness);

  const result = await createService(harness).migrate({
    legacyRepository: LEGACY,
    repositoryId: REPO_ID,
  });
  assert.equal(result.candidates[0]?.headChanged, true);
  assert.equal(result.candidates[0]?.revalidationRouted, true);

  const migrated = await harness.store.load(run.id);
  assert.equal(migrated.github?.repositoryId, REPO_ID);
  assert.equal(migrated.github?.headSha, HEAD_B);
  assert.deepEqual(migrated.github?.pendingCancellationHeadShas, [HEAD_A]);
  // Old success cannot be silently reused.
  assert.equal(migrated.evidence?.quality, undefined);
  assert.equal(migrated.evidence?.verification, undefined);
  assert.equal(migrated.revalidation?.requestedHeadSha, HEAD_B);
  assert.equal(migrated.revalidation?.source, "github");

  assert.equal((await harness.index.findStable(REPO_ID, 7))?.headSha, HEAD_B);
  // §15.1 alias scope is { headSha } U pendingCancellationHeadShas.
  assert.deepEqual(result.candidates[0]?.aliasedHeadShas.slice().sort(), [HEAD_A, HEAD_B].sort());
  assert.deepEqual(await harness.sideEffects.get(alias.stableKey), {
    resourceId: alias.resourceId,
    kind: "check-run",
  });
});

test("revalidation is routed only after the run fence and association transaction are released", async (t) => {
  const world = createWorld();
  world.pullRequests.get(7)!.headSha = HEAD_B;
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);

  const observed: string[] = [];
  const migrationStore = harness.store;
  const tracked = {
    create: migrationStore.create.bind(migrationStore),
    load: migrationStore.load.bind(migrationStore),
    list: migrationStore.list.bind(migrationStore),
    writeArtifact: migrationStore.writeArtifact.bind(migrationStore),
    readArtifact: migrationStore.readArtifact.bind(migrationStore),
    save: async (record: RunRecord) => {
      observed.push("run-save");
      return migrationStore.save(record);
    },
    applyEvent: async (
      record: RunRecord,
      type: WorkflowEventType,
      actor: string,
      details?: Record<string, unknown>,
    ) => {
      observed.push(`apply:${type}`);
      return migrationStore.applyEvent(record, type, actor, details);
    },
  };

  await createService(harness, {
    store: tracked,
    afterStep: async (step) => {
      observed.push(`step:${step}`);
    },
  }).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });

  const published = observed.indexOf("step:association-published");
  const revalidate = observed.indexOf("apply:REVALIDATE_REQUESTED");
  const routed = observed.indexOf("step:revalidation-routed");
  const aliased = observed.indexOf("step:check-aliases-published");
  assert.equal(published >= 0 && revalidate >= 0 && routed >= 0 && aliased >= 0, true);
  // Identity/head mutation is durable before the run fence is released; revalidation
  // reacquires the run target fence only afterwards; aliases follow durable revalidation.
  assert.equal(published < revalidate, true);
  assert.equal(revalidate < routed, true);
  assert.equal(routed < aliased, true);
  assert.equal((await harness.store.load(run.id)).revalidation?.requestedHeadSha, HEAD_B);
});

// ---------------------------------------------------------------------------
// Step 7: old-lock preflight uses the --from selector
// ---------------------------------------------------------------------------

test("a live pre-#34 legacy publication lock blocks migration before any mutation", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  const run = await seedLegacyRun(harness);
  const root = githubRootOf(harness.cwd);
  const legacyKey = `${LEGACY}#7`;

  await withGitHubJournal(root, "publication", legacyKey, async () => {
    await assert.rejects(
      () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
      (error: unknown) =>
        error instanceof RepositoryIdentityMigrationError &&
        error.code === "legacy-lock-blocked" &&
        error.message.includes(legacyKey),
    );
  });

  assert.equal((await harness.store.load(run.id)).github?.repositoryId, undefined);
  assert.equal(await harness.checkpoints.read(REPO_ID, LEGACY), undefined);
});

test("a live pre-#34 legacy association-identity lock blocks migration", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness);
  const root = githubRootOf(harness.cwd);

  await withGitHubJournal(root, "association-identity", `${LEGACY}#7`, async () => {
    await assert.rejects(
      () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
      (error: unknown) =>
        error instanceof RepositoryIdentityMigrationError &&
        error.code === "legacy-lock-blocked",
    );
  });
});

test("a malformed legacy journal blocks migration", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness);
  const root = githubRootOf(harness.cwd);
  const digest = createHash("sha256").update(`${LEGACY}#7`).digest("hex");
  await mkdir(path.join(root, "journals", "publication"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "journals", "publication", digest), "not a directory", "utf8");

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError && error.code === "legacy-lock-blocked",
  );
});

test("preflight inspects the legacy selector key and never the reconciled canonical name", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness);
  const root = githubRootOf(harness.cwd);

  // A live lock on the CANONICAL key must not block: the pre-#34 world only ever
  // used the legacy name, so the canonical key cannot hold pre-#34 ownership.
  await withGitHubJournal(root, "publication", `${CANONICAL}#7`, async () => {
    const result = await createService(harness).migrate({
      legacyRepository: LEGACY,
      repositoryId: REPO_ID,
    });
    assert.equal(result.status, "complete");
  });
});

// ---------------------------------------------------------------------------
// Controller ruling 1: the final full rescan is load-bearing
// ---------------------------------------------------------------------------

test("the final rescan catches a stable association bound after the initial scan", async (t) => {
  const world = createWorld({ pullRequests: { 7: {}, 9: {} } });
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness, { pullRequestNumber: 7 });

  // The repository-identity fence covers publication ENTRY only, so a publication
  // that entered before this migration can still bind a stable association while the
  // migration owns the fence. Only the §13.2 rescan catches it.
  const late = await seedLegacyRun(harness, { pullRequestNumber: 9, title: "late" });
  await harness.index.withTransaction(async (transaction) =>
    transaction.suspendLegacy(LEGACY, 9, "authorization-revoked"));

  let bound = false;
  const service = createService(harness, {
    afterStep: async (step) => {
      if (step !== "association-published" || bound) return;
      bound = true;
      const lateRun = await harness.store.load(late.id);
      lateRun.github = {
        ...lateRun.github!,
        repositoryId: REPO_ID,
        repository: LEGACY,
        suspended: true,
        suspensionReason: "authorization-revoked",
      };
      await harness.store.save(lateRun);
      await harness.index.withTransaction(async (transaction) =>
        transaction.migrateLegacy({
          legacyRepository: LEGACY,
          stable: {
            runId: late.id,
            installationId: INSTALLATION,
            repositoryId: REPO_ID,
            repository: LEGACY,
            pullRequestNumber: 9,
            baseSha: "base-sha",
            headSha: HEAD_A,
            branch: "maswe/topic",
            suspended: true,
            suspensionReason: "authorization-revoked",
          },
        }));
    },
  });

  const result = await service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID });
  assert.equal(bound, true);
  // Exactly 3: the work pass, the late-bind pass that reconciles the record
  // bound mid-migration, and the clean rescan that proves convergence. This
  // pins the rescan tightly -- `>= 2` would still pass if it collapsed, and
  // the rescan is the only mechanism catching an association bound after the
  // initial scan.
  assert.equal(result.passes, 3);
  // The record bound mid-pass was reconciled onto the current canonical name.
  assert.equal((await harness.index.findStable(REPO_ID, 9))?.repository, CANONICAL);
  assert.equal((await harness.store.load(late.id)).github?.repository, CANONICAL);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.pullRequestNumber).sort(),
    [7, 9],
  );
});

test("the final rescan fails closed on a concrete conflict bound after the initial scan", async (t) => {
  const world = createWorld({ pullRequests: { 7: {}, 9: {} } });
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness, { pullRequestNumber: 7 });
  const late = await seedLegacyRun(harness, { pullRequestNumber: 9, title: "late" });
  await harness.index.withTransaction(async (transaction) =>
    transaction.suspendLegacy(LEGACY, 9, "authorization-revoked"));

  let bound = false;
  const service = createService(harness, {
    afterStep: async (step) => {
      if (step !== "association-published" || bound) return;
      bound = true;
      // A stable index record appears whose run never agreed with it.
      await harness.index.withTransaction(async (transaction) =>
        transaction.migrateLegacy({
          legacyRepository: LEGACY,
          stable: {
            runId: late.id,
            installationId: INSTALLATION,
            repositoryId: REPO_ID,
            repository: LEGACY,
            pullRequestNumber: 9,
            baseSha: "other-base",
            headSha: HEAD_A,
            branch: "maswe/topic",
            suspended: true,
            suspensionReason: "authorization-revoked",
          },
        }));
    },
  });

  await assert.rejects(
    () => service.migrate({ legacyRepository: LEGACY, repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError && error.code === "run-index-conflict",
  );
  assert.equal(bound, true);
  // The first candidate's completed work stays durable; the migration never completed.
  assert.notEqual((await harness.checkpoints.read(REPO_ID, LEGACY))?.status, "complete");
});

// ---------------------------------------------------------------------------
// Config and credential preconditions
// ---------------------------------------------------------------------------

test("migration requires the GitHub App enabled and the id live-allowlisted", async (t) => {
  const world = createWorld();
  const harness = await createHarness(t, world);
  await seedLegacyRun(harness);

  const disabled = mergeConfigForTest({ runtime: { kind: "mock" }, quality: { commands: [] } });
  await assert.rejects(
    () =>
      createService(harness, { config: disabled }).migrate({
        legacyRepository: LEGACY,
        repositoryId: REPO_ID,
      }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError && error.code === "github-app-disabled",
  );

  await assert.rejects(
    () =>
      createService(harness, { config: config({ repositoryIds: [OTHER_REPO_ID] }) }).migrate({
        legacyRepository: LEGACY,
        repositoryId: REPO_ID,
      }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError &&
      error.code === "repository-id-not-allowlisted",
  );

  await assert.rejects(
    () =>
      createService(harness).migrate({ legacyRepository: "not-a-selector", repositoryId: REPO_ID }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError &&
      error.code === "invalid-legacy-selector",
  );

  await assert.rejects(
    () => createService(harness).migrate({ legacyRepository: LEGACY, repositoryId: 0 }),
    (error: unknown) =>
      error instanceof RepositoryIdentityMigrationError && error.code === "invalid-repository-id",
  );
  assert.equal(world.requests.length, 0);
});
