import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RunRecord } from "../src/domain.ts";
import {
  externalWorktreePath,
  listGitWorktreeRegistrations,
  type GitWorktreeRegistration,
} from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);

function isolatedConfig(): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];
  return config;
}

async function initGitRepo(prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# historical created retry binding\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function withTmpDir<T>(tmpdir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmpdir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

async function makeTempRoot(t: test.TestContext, label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `maswe-i30-hist-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function stripPlannedWorktreePath(store: FileRunStore, runId: string): Promise<RunRecord> {
  const runPath = path.join(store.root, runId, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  assert.ok(raw.workspaceBootstrap);
  delete raw.workspaceBootstrap.plannedWorktreePath;
  await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const loaded = await store.load(runId);
  assert.equal(loaded.workspaceBootstrap?.plannedWorktreePath, undefined);
  return loaded;
}

async function createHistoricalCreatedRetryFixture(
  t: test.TestContext,
  label: string,
): Promise<{
  cwd: string;
  store: FileRunStore;
  config: MasweConfig;
  historical: RunRecord;
  pathA: string;
  tmpA: string;
  tmpB: string;
}> {
  const tmpA = await makeTempRoot(t, `tmpA-${label}`);
  const tmpB = await makeTempRoot(t, `tmpB-${label}`);
  const cwd = await withTmpDir(tmpA, () => initGitRepo(`maswe-i30-hist-${label}-`));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  const { failed, pathA } = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        afterWorktreeCreate: async () => {
          throw new Error("historical unique registration for CREATED retry");
        },
      },
    });
    const run = await orchestrator.start(`${label} historical`, "unique registration retry");
    const createdPath = path.resolve(
      run.workspaceBootstrap?.plannedWorktreePath ?? externalWorktreePath(cwd, run.id),
    );
    await access(createdPath);
    return { failed: run, pathA: createdPath };
  });

  const historical = await stripPlannedWorktreePath(store, failed.id);
  assert.equal(historical.state, "FAILED");
  assert.equal(historical.failure?.resumeState, "CREATED");
  assert.equal(historical.workspace, undefined);
  assert.equal(historical.workspaceBootstrap?.mode, "isolated-worktree");
  assert.equal(historical.workspaceBootstrap?.plannedWorktreePath, undefined);
  return { cwd, store, config, historical, pathA, tmpA, tmpB };
}

function countRetryEvents(run: RunRecord): number {
  return run.events.filter((event) => event.type === "RETRY_FROM_FAILED").length;
}

test("H1: historical exact-registration CREATED retry binds path A under TMPDIR B", async (t) => {
  const { cwd, store, config, historical, pathA, tmpB } = await createHistoricalCreatedRetryFixture(
    t,
    "h1",
  );
  const bindingSaves: string[] = [];
  const innerSave = store.save.bind(store);
  store.save = async (run) => {
    await innerSave(run);
    if (
      run.state === "FAILED" &&
      run.failure?.resumeState === "CREATED" &&
      run.workspaceBootstrap?.plannedWorktreePath !== undefined
    ) {
      bindingSaves.push(path.resolve(run.workspaceBootstrap.plannedWorktreePath));
    }
  };

  let durableBeforePublication: string | undefined;
  const retried = await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
    assert.notEqual(pathA, pathB);
    await assert.rejects(access(pathB), /ENOENT/);

    return new Orchestrator(cwd, config, new MockRuntime(), store, {
      beforeRetryPublication: async (candidate) => {
        const durable = await store.load(candidate.id);
        assert.equal(durable.state, "FAILED");
        assert.equal(durable.failure?.resumeState, "CREATED");
        assert.equal(countRetryEvents(durable), 0);
        assert.ok(durable.workspaceBootstrap?.plannedWorktreePath);
        durableBeforePublication = path.resolve(durable.workspaceBootstrap.plannedWorktreePath);
        assert.equal(durableBeforePublication, pathA);
        assert.equal(path.resolve(candidate.workspace!.worktreePath!), pathA);
        assert.deepEqual(bindingSaves, [pathA]);
        await assert.rejects(access(pathB), /ENOENT/);
      },
    }).retryFromFailed(historical.id);
  });

  assert.equal(durableBeforePublication, pathA);
  assert.equal(path.resolve(retried.workspace!.worktreePath!), pathA);
  assert.equal(countRetryEvents(await store.load(retried.id)), 1);
  const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
  await assert.rejects(access(pathB), /ENOENT/);
  assert.ok(path.resolve(retried.workspace!.worktreePath!).startsWith(path.resolve(pathA)));
});

test("H2: historical binding is durable before retry workspace reconciliation", async (t) => {
  const { cwd, store, config, historical, pathA, tmpB } = await createHistoricalCreatedRetryFixture(
    t,
    "h2",
  );
  const sequence: string[] = [];
  const innerSave = store.save.bind(store);
  store.save = async (run) => {
    await innerSave(run);
    if (
      run.state === "FAILED" &&
      run.failure?.resumeState === "CREATED" &&
      run.workspaceBootstrap?.plannedWorktreePath !== undefined &&
      path.resolve(run.workspaceBootstrap.plannedWorktreePath) === pathA
    ) {
      sequence.push("binding-saved");
    }
  };

  await withTmpDir(tmpB, async () => {
    await new Orchestrator(cwd, config, new MockRuntime(), store, {
      beforeRetryPublication: async (candidate) => {
        sequence.push("before-retry-publication");
        const durable = await store.load(candidate.id);
        assert.deepEqual(sequence, ["binding-saved", "before-retry-publication"]);
        assert.equal(
          path.resolve(durable.workspaceBootstrap!.plannedWorktreePath!),
          pathA,
          "authoritative plannedWorktreePath must already be durable before reconcile completes",
        );
        assert.equal(path.resolve(candidate.workspace!.worktreePath!), pathA);
        assert.equal(countRetryEvents(durable), 0);
      },
    }).retryFromFailed(historical.id);
  });

  assert.ok(sequence.includes("binding-saved"));
  assert.ok(sequence.includes("before-retry-publication"));
  assert.ok(
    sequence.indexOf("binding-saved") < sequence.indexOf("before-retry-publication"),
  );
});

test("H3a: wrong HEAD registration fails closed for historical CREATED retry", async (t) => {
  const { cwd, store, config, historical, pathA, tmpB } = await createHistoricalCreatedRetryFixture(
    t,
    "h3a",
  );
  await writeFile(path.join(pathA, "drift.txt"), "wrong head\n", "utf8");
  await execFileAsync("git", ["add", "drift.txt"], { cwd: pathA });
  await execFileAsync("git", ["commit", "-qm", "drift head away from sourceBaseSha"], {
    cwd: pathA,
  });

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
    await assert.rejects(
      new Orchestrator(cwd, config, new MockRuntime(), store).retryFromFailed(historical.id),
      /historical CREATED retry cannot uniquely prove/i,
    );
    const after = await store.load(historical.id);
    assert.equal(after.workspaceBootstrap?.plannedWorktreePath, undefined);
    assert.equal(countRetryEvents(after), 0);
    assert.equal(after.state, "FAILED");
    await assert.rejects(access(pathB), /ENOENT/);
    await access(pathA);
  });
});

test("H3b: conflicting branch registrations fail closed for historical CREATED retry", async (t) => {
  const { cwd, store, config, historical, pathA, tmpB } = await createHistoricalCreatedRetryFixture(
    t,
    "h3b",
  );
  const conflicting: GitWorktreeRegistration[] = [
    {
      worktreePath: pathA,
      headSha: historical.workspaceBootstrap!.sourceBaseSha.toLowerCase(),
      branch: `maswe/${historical.id}`,
      prunable: false,
    },
    {
      worktreePath: path.join(tmpB, "conflict-alt"),
      headSha: historical.workspaceBootstrap!.sourceBaseSha.toLowerCase(),
      branch: `maswe/${historical.id}`,
      prunable: false,
    },
  ];

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
    await assert.rejects(
      new Orchestrator(cwd, config, new MockRuntime(), store, {
        terminalCleanupDependencies: {
          listRegistrations: async () => conflicting,
        },
      }).retryFromFailed(historical.id),
      /historical CREATED retry cannot uniquely prove/i,
    );
    const after = await store.load(historical.id);
    assert.equal(after.workspaceBootstrap?.plannedWorktreePath, undefined);
    assert.equal(countRetryEvents(after), 0);
    await assert.rejects(access(pathB), /ENOENT/);
    await access(pathA);
  });
});

test("H3c: prunable registration fails closed for historical CREATED retry", async (t) => {
  const { cwd, store, config, historical, pathA, tmpB } = await createHistoricalCreatedRetryFixture(
    t,
    "h3c",
  );
  await rm(pathA, { recursive: true, force: true });
  const registrations = await listGitWorktreeRegistrations(cwd);
  const owned = registrations.find(
    (registration) => registration.branch === `maswe/${historical.id}`,
  );
  assert.ok(owned?.prunable);

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
    await assert.rejects(
      new Orchestrator(cwd, config, new MockRuntime(), store).retryFromFailed(historical.id),
      /historical CREATED retry cannot uniquely prove/i,
    );
    const after = await store.load(historical.id);
    assert.equal(after.workspaceBootstrap?.plannedWorktreePath, undefined);
    assert.equal(countRetryEvents(after), 0);
    await assert.rejects(access(pathB), /ENOENT/);
  });
});

test("H3d: missing registration fails closed and does not create TMPDIR B worktree", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-h3d");
  const tmpB = await makeTempRoot(t, "tmpB-h3d");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-hist-h3d-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  const failed = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        afterBranchCreate: async () => {
          throw new Error("no worktree registration for historical retry");
        },
      },
    });
    return orchestrator.start("H3d missing", "no registration");
  });
  const historical = await stripPlannedWorktreePath(store, failed.id);
  assert.equal(historical.workspaceBootstrap?.plannedWorktreePath, undefined);

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
    await assert.rejects(
      new Orchestrator(cwd, config, new MockRuntime(), store).retryFromFailed(historical.id),
      /historical CREATED retry cannot uniquely prove/i,
    );
    const after = await store.load(historical.id);
    assert.equal(after.workspaceBootstrap?.plannedWorktreePath, undefined);
    assert.equal(countRetryEvents(after), 0);
    await assert.rejects(access(pathB), /ENOENT/);
  });
});

test("H4: terminal-recovery fence serializes supersede against historical CREATED retry binding", async (t) => {
  const { cwd, store, config, historical, pathA, tmpB } = await createHistoricalCreatedRetryFixture(
    t,
    "h4",
  );

  await withTmpDir(tmpB, async () => {
    const retryOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
    const supersedeOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);

    const retryPromise = retryOrchestrator.retryFromFailed(historical.id);
    const supersedePromise = supersedeOrchestrator.supersede(historical.id);

    const [retryResult, supersedeResult] = await Promise.allSettled([
      retryPromise,
      supersedePromise,
    ]);

    const fulfilled = [retryResult, supersedeResult].filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = [retryResult, supersedeResult].filter(
      (result) => result.status === "rejected",
    );
    assert.equal(fulfilled.length, 1, "exactly one of retry/supersede must win under the fence");
    assert.equal(rejected.length, 1, "the loser must fail closed rather than race");

    if (retryResult.status === "fulfilled") {
      assert.equal(path.resolve(retryResult.value.workspace!.worktreePath!), pathA);
      assert.equal(supersedeResult.status, "rejected");
      assert.match(
        String(supersedeResult.reason),
        /superseded|already|conflict|version|FAILED|CREATED|retry|not FAILED|terminal|ambiguous|publication/i,
      );
    } else {
      assert.equal(supersedeResult.status, "fulfilled");
      assert.match(
        String(retryResult.reason),
        /superseded|already superseded|conflict|version|FAILED|retry requires|ambiguous|publication|bootstrap/i,
      );
      const abandoned = await store.load(historical.id);
      assert.ok(abandoned.supersededBy);
    }
  });
});

test("H5: first-time CREATED bootstrap may still choose current externalWorktreePath", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-h5");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-hist-h5-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  let boundBeforeSideEffect: string | undefined;
  const run = await withTmpDir(tmpA, async () => {
    return new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        beforeBranchCreate: async (candidate) => {
          const durable = await store.load(candidate.id);
          boundBeforeSideEffect = durable.workspaceBootstrap?.plannedWorktreePath;
          assert.ok(boundBeforeSideEffect);
          const expected = path.resolve(externalWorktreePath(cwd, candidate.id));
          assert.equal(path.resolve(boundBeforeSideEffect), expected);
          const registrations = await listGitWorktreeRegistrations(cwd);
          assert.equal(
            registrations.some((registration) => registration.branch === `maswe/${candidate.id}`),
            false,
            "first-time bind must not require an existing Git registration",
          );
        },
      },
    }).start("H5 first-time", "current TMPDIR bind");
  });

  assert.ok(boundBeforeSideEffect);
  assert.equal(
    path.resolve(run.workspace!.worktreePath!),
    path.resolve(boundBeforeSideEffect!),
  );
  assert.ok(path.resolve(boundBeforeSideEffect!).startsWith(path.resolve(tmpA)));
});
