import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RunRecord } from "../src/domain.ts";
import { TerminalCleanupError, ensureRunWorkspace } from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);
const AT = "2026-08-24T12:00:00.000Z";

function isolatedConfig(useIsolatedWorktree = true): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = useIsolatedWorktree;
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];
  return config;
}

async function initGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-legacy-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# legacy cleanup\n", "utf8");
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

function workflowEventTypes(run: RunRecord): string[] {
  return run.events.map((event) => event.type);
}

async function prepareMergeReadyRun(
  cwd: string,
  config: MasweConfig,
  store: FileRunStore,
): Promise<RunRecord> {
  let run = await store.create("legacy complete", "complete without cleanup field", config);
  run.workspace = await ensureRunWorkspace(cwd, run);
  const headSha = run.workspace.headSha;
  run.evidence = {
    quality: { headSha, passed: true, at: AT },
    verification: { headSha, passed: true, at: AT },
    mergeReady: { headSha, passed: true, at: AT },
  };
  await store.save(run);
  run = await store.applyEvent(run, "START", "user");
  run = await store.applyEvent(run, "BRAINSTORM_COMPLETED", "brainstormer");
  run = await store.applyEvent(run, "APPROVE_BRAINSTORM", "user");
  run = await store.applyEvent(run, "DESIGN_COMPLETED", "designer");
  run = await store.applyEvent(run, "APPROVE_DESIGN", "user");
  run = await store.applyEvent(run, "BUILD_COMPLETED", "builder", { headSha });
  run = await store.applyEvent(run, "CI_PASSED", "quality", { headSha });
  run = await store.applyEvent(run, "VERIFY_PASSED", "verifier", { headSha });
  return store.applyEvent(run, "MARK_MERGE_READY", "user", { headSha });
}

async function assertBranchSurvives(cwd: string, runId: string): Promise<void> {
  const result = await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/maswe/${runId}`], {
    cwd,
  });
  assert.match(result.stdout.trim(), /^[0-9a-f]{40}$/);
}

for (const state of ["COMPLETED", "CANCELLED"] as const) {
  test(`legacy ${state} with no managed target publishes complete`, async (t) => {
    const cwd = await initGitRepo();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const config = isolatedConfig(false);
    const created = await store.create(`legacy ${state}`, "no managed worktree", config);
    const runPath = path.join(store.root, created.id, "run.json");
    const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
    raw.state = state;
    delete raw.workspace;
    delete raw.terminalCleanup;
    await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const before = await store.load(created.id);
    assert.equal(before.terminalCleanup, undefined);
    assert.equal(before.workspace?.worktreePath, undefined);

    const cleaned = await new Orchestrator(cwd, config, new MockRuntime(), store).cleanupTerminal(
      created.id,
    );

    assert.equal(cleaned.state, state);
    assert.equal(cleaned.terminalCleanup?.status, "complete");
    assert.equal(cleaned.terminalCleanup?.preservationReason, undefined);
    assert.equal(cleaned.terminalCleanup?.lastError, undefined);
    assert.deepEqual(workflowEventTypes(cleaned), workflowEventTypes(before));
  });

  test(`legacy ${state} with registration and path absent publishes complete`, async (t) => {
    const cwd = await initGitRepo();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const config = isolatedConfig();
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
    let run: RunRecord;
    if (state === "COMPLETED") {
      const prepared = await prepareMergeReadyRun(cwd, config, store);
      run = await store.applyEvent(prepared, "COMPLETE", "user", {
        headSha: prepared.workspace!.headSha,
      });
    } else {
      run = await orchestrator.start("legacy cancel absent", "cancel then strip cleanup");
      run = await store.applyEvent(run, "CANCEL", "user");
    }
    const worktreePath = run.workspace?.worktreePath;
    assert.ok(worktreePath);
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
    run = await stripTerminalCleanup(store, run.id);
    const beforeEvents = workflowEventTypes(run);

    const cleaned = await orchestrator.cleanupTerminal(run.id);

    assert.equal(cleaned.state, state);
    assert.equal(cleaned.terminalCleanup?.status, "complete");
    await assert.rejects(access(worktreePath), /ENOENT/);
    await assertBranchSurvives(cwd, run.id);
    assert.deepEqual(workflowEventTypes(cleaned), beforeEvents);
  });

  test(`legacy ${state} with exact surviving owned worktree reconciles then completes`, async (t) => {
    const cwd = await initGitRepo();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const config = isolatedConfig();
    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
    let run: RunRecord;
    if (state === "COMPLETED") {
      const prepared = await prepareMergeReadyRun(cwd, config, store);
      run = await store.applyEvent(prepared, "COMPLETE", "user", {
        headSha: prepared.workspace!.headSha,
      });
    } else {
      run = await orchestrator.start("legacy cancel surviving", "cancel without cleanup");
      run = await store.applyEvent(run, "CANCEL", "user");
    }
    run = await stripTerminalCleanup(store, run.id);
    const worktreePath = run.workspace?.worktreePath;
    assert.ok(worktreePath);
    await access(worktreePath);
    const beforeEvents = workflowEventTypes(run);

    const cleaned = await orchestrator.cleanupTerminal(run.id);

    assert.equal(cleaned.state, state);
    assert.equal(cleaned.terminalCleanup?.status, "complete");
    await assert.rejects(access(worktreePath), /ENOENT/);
    await assertBranchSurvives(cwd, run.id);
    assert.deepEqual(workflowEventTypes(cleaned), beforeEvents);
  });
}

test("legacy FAILED with workspaceBootstrap recovery is preserved and cleanup rejects", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    afterWorkspaceCheckpoint: async () => {
      throw new Error("injected bootstrap interruption");
    },
  });
  const failed = await orchestrator.start("legacy bootstrap", "fail before START");
  assert.equal(failed.state, "FAILED");
  assert.ok(failed.workspaceBootstrap);
  const worktreePath = failed.workspace?.worktreePath;
  assert.ok(worktreePath);
  const stripped = await stripTerminalCleanup(store, failed.id);
  const beforeEvents = workflowEventTypes(stripped);

  await assert.rejects(
    orchestrator.cleanupTerminal(failed.id),
    (error: unknown) =>
      error instanceof Error &&
      /refuses a preserved recovery worktree \(bootstrap-recovery\)/.test(error.message),
  );

  const authoritative = await store.load(failed.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.terminalCleanup?.status, "preserved");
  assert.equal(authoritative.terminalCleanup?.preservationReason, "bootstrap-recovery");
  assert.equal(authoritative.terminalCleanup?.lastError, undefined);
  assert.notEqual(authoritative.terminalCleanup?.preservationReason, "publication-outcome-unknown");
  await access(worktreePath);
  assert.deepEqual(workflowEventTypes(authoritative), beforeEvents);
});

test("legacy FAILED with revalidation recovery is preserved and cleanup rejects", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  let run = await orchestrator.start("legacy revalidation", "failed active revalidation");
  const worktreePath = run.workspace?.worktreePath;
  assert.ok(worktreePath);
  const headSha = run.workspace!.headSha;
  run.state = "FAILED";
  run.failure = {
    code: "workflow-failure",
    message: "publication-outcome-unknown must not be inferred from this prose",
    at: AT,
    resumeState: "BUILDING",
  };
  run.revalidation = {
    returnState: "PR_READY",
    source: "local-workspace",
    originHeadSha: headSha,
    requestedHeadSha: headSha,
    generation: 1,
    requestedAt: AT,
    updatedAt: AT,
  };
  delete run.terminalCleanup;
  await store.save(run);
  run = await stripTerminalCleanup(store, run.id);
  const beforeEvents = workflowEventTypes(run);

  await assert.rejects(
    orchestrator.cleanupTerminal(run.id),
    (error: unknown) =>
      error instanceof Error &&
      /refuses a preserved recovery worktree \(revalidation-recovery\)/.test(error.message),
  );

  const authoritative = await store.load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.terminalCleanup?.status, "preserved");
  assert.equal(authoritative.terminalCleanup?.preservationReason, "revalidation-recovery");
  assert.equal(authoritative.terminalCleanup?.lastError, undefined);
  assert.notEqual(authoritative.terminalCleanup?.preservationReason, "publication-outcome-unknown");
  await access(worktreePath);
  assert.deepEqual(workflowEventTypes(authoritative), beforeEvents);
});

test("legacy FAILED with surviving worktree and no structural proof fails closed as ambiguous", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  let run = await orchestrator.start("legacy ambiguous", "ordinary failed worktree");
  run.failure = {
    code: "workflow-failure",
    message: "mutable-role publication-outcome-unknown; do not classify from this sentence",
    at: AT,
    resumeState: "WAITING_FOR_BRAINSTORM_APPROVAL",
  };
  run = await store.applyEvent(run, "FAIL", "orchestrator", {
    reason: run.failure.message,
    resumeState: run.failure.resumeState,
  });
  run = await stripTerminalCleanup(store, run.id);
  const worktreePath = run.workspace?.worktreePath;
  assert.ok(worktreePath);
  await access(worktreePath);
  assert.equal(run.workspaceBootstrap, undefined);
  assert.equal(run.revalidation, undefined);
  const beforeEvents = workflowEventTypes(run);

  await assert.rejects(
    orchestrator.cleanupTerminal(run.id),
    (error: unknown) =>
      error instanceof TerminalCleanupError && error.code === "cleanup-legacy-state-ambiguous",
  );

  const authoritative = await store.load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.terminalCleanup?.status, "failed");
  assert.equal(
    authoritative.terminalCleanup?.lastError?.code,
    "cleanup-legacy-state-ambiguous",
  );
  assert.equal(authoritative.terminalCleanup?.preservationReason, undefined);
  await access(worktreePath);

  await assert.rejects(
    orchestrator.cleanupTerminal(run.id),
    (error: unknown) =>
      error instanceof TerminalCleanupError && error.code === "cleanup-legacy-state-ambiguous",
  );
  await access(worktreePath);
  assert.deepEqual(workflowEventTypes(await store.load(run.id)), beforeEvents);
});

test("legacy FAILED with registration and path absent publishes complete", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  let run = await orchestrator.start("legacy failed absent", "failed then already cleaned");
  run.failure = {
    code: "workflow-failure",
    message: "retryable failure mentioning publication-outcome-unknown in prose",
    at: AT,
    resumeState: "WAITING_FOR_BRAINSTORM_APPROVAL",
  };
  run = await store.applyEvent(run, "FAIL", "orchestrator", {
    reason: run.failure.message,
    resumeState: run.failure.resumeState,
  });
  const worktreePath = run.workspace?.worktreePath;
  assert.ok(worktreePath);
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
  run = await stripTerminalCleanup(store, run.id);
  const beforeEvents = workflowEventTypes(run);

  const cleaned = await orchestrator.cleanupTerminal(run.id);

  assert.equal(cleaned.state, "FAILED");
  assert.equal(cleaned.terminalCleanup?.status, "complete");
  assert.equal(cleaned.terminalCleanup?.preservationReason, undefined);
  assert.equal(cleaned.failure?.resumeState, "WAITING_FOR_BRAINSTORM_APPROVAL");
  await assert.rejects(access(worktreePath), /ENOENT/);
  await assertBranchSurvives(cwd, run.id);
  assert.deepEqual(workflowEventTypes(cleaned), beforeEvents);
});
