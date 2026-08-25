import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig, RunRecord } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);
const AT = "2026-08-25T12:00:00.000Z";

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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-legacy-absent-recovery-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# legacy absent recovery\n", "utf8");
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

test("legacy FAILED bootstrap recovery with absent path and registration publishes complete", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    afterWorkspaceCheckpoint: async () => {
      throw new Error("injected bootstrap interruption");
    },
  });

  const failed = await orchestrator.start("legacy bootstrap absent", "fail after worktree checkpoint");
  assert.equal(failed.state, "FAILED");
  assert.ok(failed.workspaceBootstrap);
  const worktreePath = failed.workspace?.worktreePath;
  assert.ok(worktreePath);

  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
  const legacy = await stripTerminalCleanup(store, failed.id);
  const beforeEvents = structuredClone(legacy.events);

  const cleaned = await orchestrator.cleanupTerminal(failed.id);

  assert.equal(cleaned.state, "FAILED");
  assert.equal(cleaned.terminalCleanup?.status, "complete");
  assert.equal(cleaned.terminalCleanup?.preservationReason, undefined);
  assert.equal(cleaned.terminalCleanup?.lastError, undefined);
  await assert.rejects(access(worktreePath), /ENOENT/);
  assert.deepEqual(cleaned.events, beforeEvents);
});

test("legacy FAILED revalidation recovery with absent path and registration publishes complete", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);

  let run = await orchestrator.start("legacy revalidation absent", "fail active revalidation");
  const worktreePath = run.workspace?.worktreePath;
  assert.ok(worktreePath);
  const headSha = run.workspace!.headSha;
  run.state = "FAILED";
  run.failure = {
    code: "workflow-failure",
    message: "injected active revalidation failure",
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
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
  run = await stripTerminalCleanup(store, run.id);
  const beforeEvents = structuredClone(run.events);

  const cleaned = await orchestrator.cleanupTerminal(run.id);

  assert.equal(cleaned.state, "FAILED");
  assert.equal(cleaned.terminalCleanup?.status, "complete");
  assert.equal(cleaned.terminalCleanup?.preservationReason, undefined);
  assert.equal(cleaned.terminalCleanup?.lastError, undefined);
  await assert.rejects(access(worktreePath), /ENOENT/);
  assert.deepEqual(cleaned.events, beforeEvents);
});
