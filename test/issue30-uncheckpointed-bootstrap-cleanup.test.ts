import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RunRecord } from "../src/domain.ts";
import {
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

async function initGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-i30-uncheckpointed-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# uncheckpointed bootstrap cleanup\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function stripTerminalCleanup(store: FileRunStore, runId: string): Promise<RunRecord> {
  const runPath = path.join(store.root, runId, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  delete raw.terminalCleanup;
  await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const loaded = await store.load(runId);
  assert.equal(loaded.terminalCleanup, undefined);
  return loaded;
}

async function assertBranchRetained(cwd: string, runId: string): Promise<void> {
  const branch = `maswe/${runId}`;
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd });
  assert.match(stdout.trim(), /^[0-9a-f]{40}$/);
}

async function assertExactManagedTarget(
  cwd: string,
  run: RunRecord,
): Promise<{ worktreePath: string; branch: string; headSha: string }> {
  const worktreePath = path.resolve(externalWorktreePath(cwd, run.id));
  const branch = `maswe/${run.id}`;
  const expectedHead = run.workspaceBootstrap!.sourceBaseSha;
  await access(worktreePath);
  const registrations = await listGitWorktreeRegistrations(cwd);
  const byPath = registrations.find(
    (registration) => path.resolve(registration.worktreePath) === worktreePath,
  );
  assert.ok(byPath, "expected Git worktree registration for deterministic path");
  assert.equal(byPath.branch, branch);
  assert.equal(byPath.headSha, expectedHead.toLowerCase());
  return { worktreePath, branch, headSha: expectedHead };
}

test("6A: afterWorktreeCreate failure preserves uncheckpointed bootstrap target", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterWorktreeCreate: async () => {
        throw new Error("interrupt after worktree create before checkpoint");
      },
    },
  });

  const failed = await orchestrator.start(
    "uncheckpointed afterWorktreeCreate",
    "preserve surviving bootstrap worktree",
  );
  const authoritative = await store.load(failed.id);

  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CREATED");
  assert.ok(authoritative.workspaceBootstrap);
  assert.equal(authoritative.workspace, undefined);
  assert.equal(
    authoritative.events.some((event) => event.type === "START"),
    false,
  );
  const target = await assertExactManagedTarget(cwd, authoritative);

  assert.equal(authoritative.terminalCleanup?.status, "preserved");
  assert.equal(authoritative.terminalCleanup?.preservationReason, "bootstrap-recovery");
  await access(target.worktreePath);
  await assertBranchRetained(cwd, authoritative.id);
});

test("6B: afterBranchCreate failure remains cleanup complete without worktree", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterBranchCreate: async () => {
        throw new Error("interrupt before worktree add");
      },
    },
  });

  const failed = await orchestrator.start(
    "pre-worktree bootstrap failure",
    "no managed worktree yet",
  );
  const authoritative = await store.load(failed.id);
  const worktreePath = path.resolve(externalWorktreePath(cwd, authoritative.id));
  const branch = `maswe/${authoritative.id}`;

  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.workspace, undefined);
  assert.ok(authoritative.workspaceBootstrap);
  await assert.rejects(access(worktreePath), /ENOENT/);
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.equal(
    registrations.some(
      (registration) =>
        path.resolve(registration.worktreePath) === worktreePath ||
        registration.branch === branch,
    ),
    false,
  );
  assert.equal(authoritative.terminalCleanup?.status, "complete");
  assert.equal(authoritative.terminalCleanup?.preservationReason, undefined);
  await assertBranchRetained(cwd, authoritative.id);
});

test("6C: dirty uncheckpointed bootstrap worktree stays preserved with intact bytes", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const dirtyBytes = "dirty recovery bytes must survive\n";
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterWorktreeCreate: async (run: RunRecord) => {
        const worktreePath = externalWorktreePath(cwd, run.id);
        await writeFile(path.join(worktreePath, "README.md"), dirtyBytes, "utf8");
      },
    },
  });

  const failed = await orchestrator.start("dirty uncheckpointed", "preserve dirty bytes");
  const authoritative = await store.load(failed.id);
  const target = await assertExactManagedTarget(cwd, authoritative);

  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.workspace, undefined);
  assert.equal(authoritative.terminalCleanup?.status, "preserved");
  assert.equal(authoritative.terminalCleanup?.preservationReason, "bootstrap-recovery");
  assert.equal(await readFile(path.join(target.worktreePath, "README.md"), "utf8"), dirtyBytes);

  await assert.rejects(
    orchestrator.cleanupTerminal(authoritative.id),
    (error: unknown) =>
      error instanceof Error &&
      /refuses a preserved recovery worktree \(bootstrap-recovery\)/.test(error.message),
  );
  assert.equal(await readFile(path.join(target.worktreePath, "README.md"), "utf8"), dirtyBytes);
  await assertExactManagedTarget(cwd, authoritative);
});

test("6D: legacy missing-workspace bootstrap recovery inspects derived target", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();

  const survivingOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterWorktreeCreate: async () => {
        throw new Error("leave uncheckpointed target for legacy surviving case");
      },
    },
  });
  const surviving = await survivingOrchestrator.start(
    "legacy surviving uncheckpointed",
    "inspect before complete",
  );
  assert.equal(surviving.terminalCleanup?.status, "preserved");
  const survivingTarget = await assertExactManagedTarget(cwd, surviving);
  const legacySurviving = await stripTerminalCleanup(store, surviving.id);
  const beforeEvents = structuredClone(legacySurviving.events);

  await assert.rejects(
    survivingOrchestrator.cleanupTerminal(surviving.id),
    (error: unknown) =>
      error instanceof Error &&
      /refuses a preserved recovery worktree \(bootstrap-recovery\)/.test(error.message),
  );
  const afterSurviving = await store.load(surviving.id);
  assert.equal(afterSurviving.terminalCleanup?.status, "preserved");
  assert.equal(afterSurviving.terminalCleanup?.preservationReason, "bootstrap-recovery");
  await access(survivingTarget.worktreePath);
  assert.deepEqual(afterSurviving.events, beforeEvents);

  const absentOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterBranchCreate: async () => {
        throw new Error("no worktree for legacy absent case");
      },
    },
  });
  const absent = await absentOrchestrator.start(
    "legacy absent uncheckpointed",
    "complete when derived target absent",
  );
  assert.equal(absent.workspace, undefined);
  assert.ok(absent.workspaceBootstrap);
  const absentPath = path.resolve(externalWorktreePath(cwd, absent.id));
  await assert.rejects(access(absentPath), /ENOENT/);
  const legacyAbsent = await stripTerminalCleanup(store, absent.id);
  const absentEvents = structuredClone(legacyAbsent.events);

  const cleaned = await absentOrchestrator.cleanupTerminal(absent.id);
  assert.equal(cleaned.terminalCleanup?.status, "complete");
  assert.equal(cleaned.terminalCleanup?.preservationReason, undefined);
  assert.deepEqual(cleaned.events, absentEvents);
});

test("6E: supersede removes preserved uncheckpointed bootstrap target safely", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterWorktreeCreate: async () => {
        throw new Error("preserve uncheckpointed predecessor for supersede");
      },
    },
  });

  const predecessor = await orchestrator.start(
    "uncheckpointed supersede predecessor",
    "abandon via supersede",
  );
  assert.equal(predecessor.state, "FAILED");
  assert.equal(predecessor.terminalCleanup?.status, "preserved");
  assert.equal(predecessor.workspace, undefined);
  const target = await assertExactManagedTarget(cwd, predecessor);
  const neighbor = await new Orchestrator(cwd, config, new MockRuntime(), store).start(
    "neighbor run",
    "must not be touched",
  );
  const neighborPath = neighbor.workspace?.worktreePath;
  assert.ok(neighborPath);
  await access(neighborPath);

  const supersedeOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  const replacement = await supersedeOrchestrator.supersede(predecessor.id);
  const abandoned = await store.load(predecessor.id);

  assert.equal(abandoned.supersededBy, replacement.id);
  assert.equal(replacement.supersedes, predecessor.id);
  assert.equal(
    (await store.list()).filter((run) => run.supersededBy === replacement.id).length,
    1,
  );
  await assert.rejects(access(target.worktreePath), /ENOENT/);
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.equal(
    registrations.some(
      (registration) => path.resolve(registration.worktreePath) === target.worktreePath,
    ),
    false,
  );
  await assertBranchRetained(cwd, predecessor.id);
  await access(neighborPath);
  assert.ok(
    registrations.some(
      (registration) => path.resolve(registration.worktreePath) === path.resolve(neighborPath),
    ),
  );
  assert.equal(abandoned.terminalCleanup?.status, "complete");
  assert.notEqual(abandoned.terminalCleanup?.preservationReason, "bootstrap-recovery");
  assert.ok(replacement.workspace?.worktreePath);
  assert.notEqual(replacement.state, "FAILED");
  assert.equal(
    abandoned.events.filter((event) => event.type === "FAIL").length,
    1,
  );
  assert.equal(
    abandoned.events.filter((event) => event.type === "CANCEL").length,
    0,
  );
});

test("6F: conflicting derived uncheckpointed target fails closed", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterWorktreeCreate: async () => {
        throw new Error("create uncheckpointed target then conflict it");
      },
    },
  });

  const failed = await orchestrator.start(
    "conflicting derived target",
    "fail closed on ownership conflict",
  );
  assert.equal(failed.terminalCleanup?.status, "preserved");
  const target = await assertExactManagedTarget(cwd, failed);

  const altPath = path.join(cwd, ".maswe-alt-worktree");
  await execFileAsync("git", ["worktree", "remove", "--force", target.worktreePath], { cwd });
  await execFileAsync("git", ["worktree", "add", "--", altPath, target.branch], { cwd });
  await mkdir(path.dirname(target.worktreePath), { recursive: true });
  await mkdir(target.worktreePath, { recursive: true });
  await writeFile(path.join(target.worktreePath, "occupied.txt"), "unregistered\n", "utf8");

  const legacy = await stripTerminalCleanup(store, failed.id);
  await assert.rejects(orchestrator.cleanupTerminal(legacy.id), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ownership|cleanup|inspect|conflict|registered|unsafe|different/i);
    return true;
  });

  const after = await store.load(failed.id);
  assert.notEqual(after.terminalCleanup?.status, "complete");
  await access(altPath);
  await access(path.join(target.worktreePath, "occupied.txt"));
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.ok(
    registrations.some(
      (registration) =>
        registration.branch === target.branch &&
        path.resolve(registration.worktreePath) === path.resolve(altPath),
    ),
  );
})

test("6F-symlink: unsafe derived path fails closed without complete", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      afterWorktreeCreate: async () => {
        throw new Error("create then replace with symlink");
      },
    },
  });

  const failed = await orchestrator.start("symlink derived target", "unsafe path");
  const target = await assertExactManagedTarget(cwd, failed);
  await execFileAsync("git", ["worktree", "remove", "--force", target.worktreePath], { cwd });
  const decoy = await mkdtemp(path.join(os.tmpdir(), "maswe-i30-decoy-"));
  t.after(async () => rm(decoy, { recursive: true, force: true }));
  await symlink(decoy, target.worktreePath);

  const legacy = await stripTerminalCleanup(store, failed.id);
  await assert.rejects(orchestrator.cleanupTerminal(legacy.id), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ownership|unsafe|symlink|directory|cleanup/i);
    return true;
  });
  const after = await store.load(failed.id);
  assert.notEqual(after.terminalCleanup?.status, "complete");
  const linkStat = await lstat(target.worktreePath);
  assert.equal(linkStat.isSymbolicLink(), true);
});
