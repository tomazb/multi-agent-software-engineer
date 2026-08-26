import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RunRecord } from "../src/domain.ts";
import {
  deriveManagedTerminalCleanupTarget,
  externalWorktreePath,
  listGitWorktreeRegistrations,
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
  await writeFile(path.join(cwd, "README.md"), "# tmpdir bootstrap path recovery\n", "utf8");
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
  const root = await mkdtemp(path.join(os.tmpdir(), `maswe-i30-${label}-`));
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

async function assertBranchRetained(cwd: string, runId: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `maswe/${runId}`], {
    cwd,
  });
  assert.match(stdout.trim(), /^[0-9a-f]{40}$/);
}

test("14A: TMPDIR change after persisted-path bootstrap failure still inspects path A", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA");
  const tmpB = await makeTempRoot(t, "tmpB");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14a-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));

  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const failed = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        afterWorktreeCreate: async () => {
          throw new Error("interrupt after worktree create before checkpoint");
        },
      },
    });
    return orchestrator.start("14A preserved", "persist planned path before side effect");
  });

  const authoritative = await store.load(failed.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CREATED");
  assert.ok(authoritative.workspaceBootstrap);
  assert.equal(authoritative.workspace, undefined);
  const pathA = path.resolve(authoritative.workspaceBootstrap.plannedWorktreePath!);
  assert.ok(pathA.startsWith(path.resolve(tmpA)), `planned path must be under TMPDIR A: ${pathA}`);
  await access(pathA);
  const registrationsA = await listGitWorktreeRegistrations(cwd);
  assert.ok(
    registrationsA.some(
      (registration) => path.resolve(registration.worktreePath) === pathA,
    ),
  );
  assert.equal(authoritative.terminalCleanup?.status, "preserved");
  assert.equal(authoritative.terminalCleanup?.preservationReason, "bootstrap-recovery");

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, authoritative.id));
    assert.notEqual(pathA, pathB, "TMPDIR A and B must yield different derived paths");
    assert.ok(pathB.startsWith(path.resolve(tmpB)));

    const derivation = await deriveManagedTerminalCleanupTarget(authoritative);
    assert.equal(derivation.status, "target");
    assert.equal(path.resolve(derivation.target.worktreePath), pathA);
    assert.equal(derivation.target.source, "bootstrap-uncheckpointed");

    const reloaded = await store.load(authoritative.id);
    assert.equal(path.resolve(reloaded.workspaceBootstrap!.plannedWorktreePath!), pathA);
    assert.equal(reloaded.terminalCleanup?.status, "preserved");

    await assert.rejects(
      new Orchestrator(cwd, config, new MockRuntime(), store).cleanupTerminal(authoritative.id),
      (error: unknown) =>
        error instanceof Error &&
        /refuses a preserved recovery worktree \(bootstrap-recovery\)/.test(error.message),
    );
    await access(pathA);
    await assert.rejects(access(pathB), /ENOENT/);
  });
});

test("14B: cross-TMPDIR supersede removes predecessor path A only", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-sup");
  const tmpB = await makeTempRoot(t, "tmpB-sup");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14b-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  const predecessor = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        afterWorktreeCreate: async () => {
          throw new Error("preserve uncheckpointed predecessor");
        },
      },
    });
    return orchestrator.start("14B predecessor", "abandon via supersede");
  });
  assert.equal(predecessor.terminalCleanup?.status, "preserved");
  const pathA = path.resolve(predecessor.workspaceBootstrap!.plannedWorktreePath!);
  await access(pathA);
  const failCountBefore = predecessor.events.filter((event) => event.type === "FAIL").length;

  const replacement = await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, predecessor.id));
    assert.notEqual(pathA, pathB);
    return new Orchestrator(cwd, config, new MockRuntime(), store).supersede(predecessor.id);
  });

  const abandoned = await store.load(predecessor.id);
  assert.equal(abandoned.supersededBy, replacement.id);
  assert.equal(replacement.supersedes, predecessor.id);
  await assert.rejects(access(pathA), /ENOENT/);
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.equal(
    registrations.some((registration) => path.resolve(registration.worktreePath) === pathA),
    false,
  );
  await assertBranchRetained(cwd, predecessor.id);
  assert.equal(abandoned.terminalCleanup?.status, "complete");
  assert.notEqual(abandoned.terminalCleanup?.preservationReason, "bootstrap-recovery");
  assert.ok(replacement.workspace?.worktreePath);
  assert.equal(
    path.resolve(replacement.workspace!.worktreePath!),
    path.resolve(replacement.workspaceBootstrap?.plannedWorktreePath ?? replacement.workspace!.worktreePath!),
  );
  assert.ok(
    path
      .resolve(replacement.workspace!.worktreePath!)
      .startsWith(path.resolve(tmpB)),
    "replacement must bind under the supersede-time environment",
  );
  assert.equal(
    abandoned.events.filter((event) => event.type === "FAIL").length,
    failCountBefore,
  );
  assert.equal(abandoned.events.filter((event) => event.type === "CANCEL").length, 0);
});

test("14C: plannedWorktreePath is durable before branch/worktree side effects", async (t) => {
  const cwd = await initGitRepo("maswe-i30-14c-");
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  let observedBeforeBranch: string | undefined;
  let observedAfterWorktree: string | undefined;

  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      beforeBranchCreate: async (run) => {
        const durable = await store.load(run.id);
        observedBeforeBranch = durable.workspaceBootstrap?.plannedWorktreePath;
        assert.ok(
          observedBeforeBranch,
          "plannedWorktreePath must be durable before branch creation",
        );
        assert.equal(path.isAbsolute(observedBeforeBranch), true);
      },
      afterWorktreeCreate: async (run) => {
        const durable = await store.load(run.id);
        observedAfterWorktree = durable.workspaceBootstrap?.plannedWorktreePath;
        assert.equal(observedAfterWorktree, observedBeforeBranch);
      },
    },
  });

  const run = await orchestrator.start("14C ordering", "publish path before side effects");
  assert.ok(observedBeforeBranch);
  assert.ok(observedAfterWorktree);
  assert.equal(path.resolve(run.workspace!.worktreePath!), path.resolve(observedBeforeBranch!));
  assert.equal(
    path.resolve(run.workspaceBootstrap?.plannedWorktreePath ?? observedBeforeBranch!),
    path.resolve(observedBeforeBranch!),
  );
});

test("14D: crash before path binding leaves no side effects and later bind is safe", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-14d");
  const tmpB = await makeTempRoot(t, "tmpB-14d");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14d-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      beforeBootstrapReconcile: async () => {
        throw new Error("interrupt before planned path binding");
      },
    });
    await assert.rejects(
      orchestrator.start("14D pre-bind", "no side effects yet"),
      /interrupt before planned path binding/,
    );
  });

  const [created] = await store.list();
  assert.ok(created);
  const interrupted = await store.load(created.id);
  assert.equal(interrupted.state, "CREATED");
  assert.equal(interrupted.workspace, undefined);
  assert.equal(interrupted.workspaceBootstrap?.plannedWorktreePath, undefined);
  const branch = await execFileAsync("git", ["branch", "--list", `maswe/${interrupted.id}`], {
    cwd,
  });
  assert.equal(branch.stdout, "");
  await assert.rejects(access(externalWorktreePath(cwd, interrupted.id)), /ENOENT/);

  const resumed = await withTmpDir(tmpB, async () => {
    return new Orchestrator(cwd, config, new MockRuntime(), store).bootstrapCreatedRun(
      interrupted.id,
    );
  });
  assert.ok(resumed.workspace?.worktreePath);
  assert.ok(
    path.resolve(resumed.workspace!.worktreePath!).startsWith(path.resolve(tmpB)),
    "post-crash bind may use the new environment",
  );
});

test("14E: crash after binding keeps path A across TMPDIR change", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-14e");
  const tmpB = await makeTempRoot(t, "tmpB-14e");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14e-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  let boundPath: string | undefined;

  await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        beforeBranchCreate: async (run) => {
          const durable = await store.load(run.id);
          boundPath = durable.workspaceBootstrap?.plannedWorktreePath;
          assert.ok(boundPath);
          throw new Error("interrupt after planned path binding before branch");
        },
      },
    });
    const failed = await orchestrator.start("14E post-bind", "keep planned path A");
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.failure?.resumeState, "CREATED");
  });

  assert.ok(boundPath);
  assert.ok(path.resolve(boundPath!).startsWith(path.resolve(tmpA)));
  const failed = (await store.list()).find((run) => run.state === "FAILED");
  assert.ok(failed);
  const authoritative = await store.load(failed.id);
  assert.equal(
    path.resolve(authoritative.workspaceBootstrap!.plannedWorktreePath!),
    path.resolve(boundPath!),
  );

  const resumed = await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, authoritative.id));
    assert.notEqual(path.resolve(boundPath!), pathB);
    return new Orchestrator(cwd, config, new MockRuntime(), store).retryFromFailed(
      authoritative.id,
    );
  });
  assert.equal(
    path.resolve(resumed.workspace!.worktreePath!),
    path.resolve(boundPath!),
  );
  assert.ok(
    !path.resolve(resumed.workspace!.worktreePath!).startsWith(path.resolve(tmpB)),
    "must not recalculate under TMPDIR B",
  );
});

test("14F: unregistered leftover directory across TMPDIR change fails closed", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-14f");
  const tmpB = await makeTempRoot(t, "tmpB-14f");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14f-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  const failed = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        afterWorktreeCreate: async () => {
          throw new Error("create then leave unregistered directory");
        },
      },
    });
    return orchestrator.start("14F unregistered", "inspect durable A");
  });
  const pathA = path.resolve(failed.workspaceBootstrap!.plannedWorktreePath!);
  await execFileAsync("git", ["worktree", "remove", "--force", pathA], { cwd });
  await mkdir(pathA, { recursive: true });
  await writeFile(path.join(pathA, "orphan.txt"), "unregistered leftover\n", "utf8");

  const runPath = path.join(store.root, failed.id, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  delete raw.terminalCleanup;
  await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, failed.id));
    assert.notEqual(pathA, pathB);
    await assert.rejects(access(pathB), /ENOENT/);

    const derivation = await deriveManagedTerminalCleanupTarget(await store.load(failed.id));
    assert.equal(derivation.status, "target");
    assert.equal(path.resolve(derivation.target.worktreePath), pathA);

    await assert.rejects(
      new Orchestrator(cwd, config, new MockRuntime(), store).cleanupTerminal(failed.id),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ownership|unregistered|cleanup|unsafe|mismatch/i);
        return true;
      },
    );
    const after = await store.load(failed.id);
    assert.notEqual(after.terminalCleanup?.status, "complete");
    assert.equal(await readFile(path.join(pathA, "orphan.txt"), "utf8"), "unregistered leftover\n");
  });
});

test("14G: historical missing planned path recovers unique registration under TMPDIR B", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-14g");
  const tmpB = await makeTempRoot(t, "tmpB-14g");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14g-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  const { failed, pathA } = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        afterWorktreeCreate: async () => {
          throw new Error("historical unique registration");
        },
      },
    });
    const run = await orchestrator.start("14G historical", "unique registration recovery");
    const createdPath = path.resolve(
      run.workspaceBootstrap?.plannedWorktreePath ?? externalWorktreePath(cwd, run.id),
    );
    await access(createdPath);
    return { failed: run, pathA: createdPath };
  });
  const historical = await stripPlannedWorktreePath(store, failed.id);
  assert.equal(historical.workspace, undefined);
  assert.equal(historical.workspaceBootstrap?.plannedWorktreePath, undefined);

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
    assert.notEqual(pathA, pathB);
    const derivation = await deriveManagedTerminalCleanupTarget(historical);
    assert.equal(derivation.status, "target");
    assert.equal(path.resolve(derivation.target.worktreePath), pathA);
    assert.notEqual(path.resolve(derivation.target.worktreePath), pathB);

    const replacement = await new Orchestrator(cwd, config, new MockRuntime(), store).supersede(
      historical.id,
    );
    const abandoned = await store.load(historical.id);
    await assert.rejects(access(pathA), /ENOENT/);
    await assertBranchRetained(cwd, historical.id);
    assert.equal(abandoned.terminalCleanup?.status, "complete");
    assert.ok(replacement.workspace?.worktreePath);
  });
});

test("14H: historical missing path and missing registration does not complete from TMPDIR B absence", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-14h");
  const tmpB = await makeTempRoot(t, "tmpB-14h");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14h-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  const failed = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      bootstrapHooks: {
        afterBranchCreate: async () => {
          throw new Error("no worktree registration for historical ambiguity");
        },
      },
    });
    return orchestrator.start("14H ambiguous", "no registration");
  });
  assert.equal(failed.workspace, undefined);
  assert.ok(failed.workspaceBootstrap);
  // Simulate historical schema-v1 omission even if a modern bind occurred before the branch hook.
  const historical = await stripPlannedWorktreePath(store, failed.id);
  const runPath = path.join(store.root, historical.id, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  delete raw.terminalCleanup;
  await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, historical.id));
    await assert.rejects(access(pathB), /ENOENT/);
    const derivation = await deriveManagedTerminalCleanupTarget(await store.load(historical.id));
    assert.equal(derivation.status, "ambiguous");

    await assert.rejects(
      new Orchestrator(cwd, config, new MockRuntime(), store).cleanupTerminal(historical.id),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ambiguous|ownership|cleanup|legacy|uncertain|inspect/i);
        return true;
      },
    );
    const after = await store.load(historical.id);
    assert.notEqual(after.terminalCleanup?.status, "complete");
  });
});

test("14I: operator-checkout rejects plannedWorktreePath", async (t) => {
  const cwd = await initGitRepo("maswe-i30-14i-");
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  config.policy.useIsolatedWorktree = false;
  const run = await store.create("14I operator", "no planned path", config);
  const runPath = path.join(store.root, run.id, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  raw.state = "CREATED";
  raw.workspaceBootstrap = {
    mode: "operator-checkout",
    sourceBaseSha: "a".repeat(40),
    sourceBranch: "main",
    sourceTreeFingerprint: "b".repeat(64),
    plannedAt: "2026-08-26T00:00:00.000Z",
    plannedWorktreePath: "/tmp/should-not-exist-for-operator",
  };
  await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  await assert.rejects(
    store.load(run.id),
    /plannedWorktreePath|operator-checkout/i,
  );
});

test("14J: successful isolated bootstrap keeps workspace and planned paths equal across TMPDIR change", async (t) => {
  const tmpA = await makeTempRoot(t, "tmpA-14j");
  const tmpB = await makeTempRoot(t, "tmpB-14j");
  const cwd = await withTmpDir(tmpA, () => initGitRepo("maswe-i30-14j-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  let checkpointSnapshot: RunRecord | undefined;

  const failed = await withTmpDir(tmpA, async () => {
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
      afterWorkspaceCheckpoint: async (checkpoint) => {
        checkpointSnapshot = structuredClone(checkpoint);
        throw new Error("stop after checkpoint for 14J");
      },
    });
    return orchestrator.start("14J checkpoint consistency", "planned equals workspace");
  });

  assert.equal(failed.state, "FAILED");
  assert.equal(failed.failure?.resumeState, "CREATED");
  assert.ok(checkpointSnapshot?.workspace?.worktreePath);
  assert.ok(checkpointSnapshot?.workspaceBootstrap?.plannedWorktreePath);
  const durablePath = path.resolve(checkpointSnapshot!.workspaceBootstrap!.plannedWorktreePath!);
  assert.equal(path.resolve(checkpointSnapshot!.workspace!.worktreePath!), durablePath);
  assert.ok(durablePath.startsWith(path.resolve(tmpA)));

  const authoritative = await store.load(failed.id);
  assert.equal(path.resolve(authoritative.workspace!.worktreePath!), durablePath);
  assert.equal(
    path.resolve(authoritative.workspaceBootstrap!.plannedWorktreePath!),
    durablePath,
  );

  await withTmpDir(tmpB, async () => {
    const pathB = path.resolve(externalWorktreePath(cwd, authoritative.id));
    assert.notEqual(durablePath, pathB);
    const reloaded = await store.load(authoritative.id);
    assert.equal(path.resolve(reloaded.workspace!.worktreePath!), durablePath);
    assert.equal(
      path.resolve(reloaded.workspaceBootstrap!.plannedWorktreePath!),
      durablePath,
    );
  });
});
