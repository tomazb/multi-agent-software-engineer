import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import {
  TerminalCleanupError,
  type GitWorktreeRegistration,
  type TerminalCleanupDependencies,
  type TerminalCleanupPathState,
  ensureRunWorkspace,
  externalWorktreePath,
  reconcileTerminalWorktreeCleanup,
} from "../src/git-workspace.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-i30-reconcile-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function terminalRun(
  repositoryPath: string,
  runId: string,
  headSha: string,
  overrides: {
    worktreePath?: string;
    branch?: string;
    repositoryPath?: string;
  } = {},
): RunRecord {
  const branch = overrides.branch ?? `maswe/${runId}`;
  const worktreePath = overrides.worktreePath ?? externalWorktreePath(repositoryPath, runId);
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.useIsolatedWorktree = true;
  return {
    schemaVersion: 1,
    version: 1,
    id: runId,
    title: "terminal cleanup reconcile",
    request: "test",
    repositoryPath: overrides.repositoryPath ?? repositoryPath,
    state: "COMPLETED",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config,
    artifacts: [],
    events: [],
    workspace: {
      baseSha: headSha,
      headSha,
      branch,
      worktreePath,
      fingerprint: "test-fingerprint",
    },
  };
}

function exactRegistration(
  worktreePath: string,
  branch: string,
  headSha: string,
): GitWorktreeRegistration {
  return { worktreePath: path.resolve(worktreePath), headSha: headSha.toLowerCase(), branch, prunable: false };
}

async function assertCleanupError(
  promise: Promise<unknown>,
  code: TerminalCleanupError["code"],
): Promise<void> {
  try {
    await promise;
    assert.fail("expected TerminalCleanupError");
  } catch (error) {
    assert.ok(error instanceof TerminalCleanupError, String(error));
    assert.equal(error.code, code);
  }
}

test("1 exact registration + directory removes to absent/absent success", async (t) => {
  const cwd = await initRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const runId = "run-exact-remove";
  const run = {
    id: runId,
    config: structuredClone(DEFAULT_CONFIG),
  } as RunRecord;
  run.config.policy.useIsolatedWorktree = true;
  const workspace = await ensureRunWorkspace(cwd, run);
  const terminal = terminalRun(cwd, runId, workspace.headSha);
  await access(workspace.worktreePath!);

  await reconcileTerminalWorktreeCleanup(terminal, cwd);

  await assert.rejects(access(workspace.worktreePath!), /ENOENT/);
  const listed = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd })).stdout;
  assert.doesNotMatch(listed, new RegExp(path.resolve(workspace.worktreePath!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("2 absent registration + absent path is idempotent without remove", async () => {
  const cwd = "/tmp/maswe-i30-absent";
  const runId = "run-idempotent";
  const headSha = "a".repeat(40);
  const run = terminalRun(cwd, runId, headSha);
  let removeCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => [],
    inspectPath: async () => "absent" as TerminalCleanupPathState,
    removeWorktree: async () => {
      removeCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await reconcileTerminalWorktreeCleanup(run, cwd, deps);
  assert.equal(removeCalls, 0);
});

test("3 non-zero remove + absent/absent post-state succeeds", async () => {
  const cwd = "/tmp/maswe-i30-remove-absent";
  const runId = "run-remove-absent";
  const headSha = "b".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      return listCalls === 1 ? [registration] : [];
    },
    inspectPath: async () => (listCalls <= 1 ? "directory" : "absent") as TerminalCleanupPathState,
    removeWorktree: async () => ({ exitCode: 1, stdout: "", stderr: "remove failed" }),
  };
  await reconcileTerminalWorktreeCleanup(run, cwd, deps);
});

test("4 non-zero remove + exact registration/directory remains -> cleanup-remove-failed", async () => {
  const cwd = "/tmp/maswe-i30-remove-failed";
  const runId = "run-remove-failed";
  const headSha = "c".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => [registration],
    inspectPath: async () => "directory",
    removeWorktree: async () => ({ exitCode: 1, stdout: "", stderr: "still there" }),
  };
  await assertCleanupError(reconcileTerminalWorktreeCleanup(run, cwd, deps), "cleanup-remove-failed");
});

test("5 registration remains + path absent after attempt -> cleanup-postcondition-failed", async () => {
  const cwd = "/tmp/maswe-i30-postcondition";
  const runId = "run-postcondition";
  const headSha = "d".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      return [registration];
    },
    inspectPath: async () => (listCalls <= 1 ? "directory" : "absent") as TerminalCleanupPathState,
    removeWorktree: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-postcondition-failed",
  );
});

test("6 unregistered present directory -> cleanup-ownership-mismatch without remove", async () => {
  const cwd = "/tmp/maswe-i30-unregistered";
  const runId = "run-unregistered";
  const headSha = "e".repeat(40);
  const run = terminalRun(cwd, runId, headSha);
  let removeCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => [],
    inspectPath: async () => "directory",
    removeWorktree: async () => {
      removeCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
  assert.equal(removeCalls, 0);
});

test("7 unsafe/symlink path -> cleanup-ownership-mismatch", async () => {
  const cwd = "/tmp/maswe-i30-unsafe";
  const runId = "run-unsafe";
  const headSha = "f".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => [registration],
    inspectPath: async () => "unsafe",
    removeWorktree: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
});

test("8 branch mismatch is rejected", async () => {
  const cwd = "/tmp/maswe-i30-branch";
  const runId = "run-branch";
  const headSha = "0".repeat(40);
  const run = terminalRun(cwd, runId, headSha, { branch: "maswe/wrong-branch" });
  await assertCleanupError(reconcileTerminalWorktreeCleanup(run, cwd, {}), "cleanup-ownership-mismatch");
});

test("9 HEAD mismatch is rejected", async () => {
  const cwd = "/tmp/maswe-i30-head";
  const runId = "run-head";
  const headSha = "1".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => [
      exactRegistration(worktreePath, `maswe/${runId}`, "2".repeat(40)),
    ],
    inspectPath: async () => "directory",
  };
  await assertCleanupError(reconcileTerminalWorktreeCleanup(run, cwd, deps), "cleanup-ownership-mismatch");
});

test("10 expected branch registered at another path is rejected", async () => {
  const cwd = "/tmp/maswe-i30-other-path";
  const runId = "run-other-path";
  const headSha = "3".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const otherPath = path.join(os.tmpdir(), "maswe-other-worktree");
  const run = terminalRun(cwd, runId, headSha);
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => [
      exactRegistration(otherPath, `maswe/${runId}`, headSha),
    ],
    inspectPath: async () => "directory",
  };
  await assertCleanupError(reconcileTerminalWorktreeCleanup(run, cwd, deps), "cleanup-ownership-mismatch");
});

test("11 malformed registration inspection -> cleanup-inspection-failed", async () => {
  const cwd = "/tmp/maswe-i30-inspection";
  const runId = "run-inspection";
  const headSha = "4".repeat(40);
  const run = terminalRun(cwd, runId, headSha);
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      throw new Error("Malformed Git worktree registration output");
    },
    inspectPath: async () => "absent",
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-inspection-failed",
  );
});

test("12 operator checkout target is rejected", async () => {
  const cwd = "/tmp/maswe-i30-operator";
  const runId = "run-operator";
  const headSha = "5".repeat(40);
  const run = terminalRun(cwd, runId, headSha, { worktreePath: cwd });
  await assertCleanupError(reconcileTerminalWorktreeCleanup(run, cwd, {}), "cleanup-ownership-mismatch");
});

test("13 invocation repository root different from run.repositoryPath is rejected", async () => {
  const cwd = "/tmp/maswe-i30-repo";
  const other = "/tmp/maswe-i30-other-repo";
  const runId = "run-repo";
  const headSha = "6".repeat(40);
  const run = terminalRun(cwd, runId, headSha);
  await assertCleanupError(reconcileTerminalWorktreeCleanup(run, other, {}), "cleanup-ownership-mismatch");
});

test("14 successful cleanup leaves branch ref untouched", async (t) => {
  const cwd = await initRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const runId = "run-branch-preserve";
  const run = {
    id: runId,
    config: structuredClone(DEFAULT_CONFIG),
  } as RunRecord;
  run.config.policy.useIsolatedWorktree = true;
  const workspace = await ensureRunWorkspace(cwd, run);
  const terminal = terminalRun(cwd, runId, workspace.headSha);
  const branch = `maswe/${runId}`;
  const beforeRef = (await execFileAsync("git", ["rev-parse", branch], { cwd })).stdout.trim();

  await reconcileTerminalWorktreeCleanup(terminal, cwd);

  const afterRef = (await execFileAsync("git", ["rev-parse", branch], { cwd })).stdout.trim();
  assert.equal(afterRef, beforeRef);
  await assert.rejects(access(workspace.worktreePath!), /ENOENT/);
});

test("15 nonterminal run rejects cleanup without calling removeWorktree", async () => {
  const cwd = "/tmp/maswe-i30-nonterminal";
  const runId = "run-nonterminal";
  const headSha = "7".repeat(40);
  const run = terminalRun(cwd, runId, headSha);
  run.state = "PR_READY";
  let removeCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    removeWorktree: async () => {
      removeCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
  assert.equal(removeCalls, 0);
});

test("16 useIsolatedWorktree=false rejects cleanup without calling removeWorktree", async () => {
  const cwd = "/tmp/maswe-i30-no-isolated";
  const runId = "run-no-isolated";
  const headSha = "8".repeat(40);
  const run = terminalRun(cwd, runId, headSha);
  run.config.policy.useIsolatedWorktree = false;
  let removeCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    removeWorktree: async () => {
      removeCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
  assert.equal(removeCalls, 0);
});

test("A1 removeWorktree throws and post absent/absent succeeds", async () => {
  const cwd = "/tmp/maswe-i30-throw-success";
  const runId = "run-throw-success";
  const headSha = "9".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      return listCalls === 1 ? [registration] : [];
    },
    inspectPath: async () => (listCalls <= 1 ? "directory" : "absent") as TerminalCleanupPathState,
    removeWorktree: async () => {
      throw new Error("spawn EACCES");
    },
  };
  await reconcileTerminalWorktreeCleanup(run, cwd, deps);
});

test("A2 removeWorktree throws and exact owned registration/path remains -> cleanup-remove-failed", async () => {
  const cwd = "/tmp/maswe-i30-throw-remove-failed";
  const runId = "run-throw-remove-failed";
  const headSha = "a".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => [registration],
    inspectPath: async () => "directory",
    removeWorktree: async () => {
      throw new Error("injected timeout");
    },
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-remove-failed",
  );
});

test("A3 removeWorktree throws and branch relocates -> cleanup-ownership-mismatch", async () => {
  const cwd = "/tmp/maswe-i30-throw-relocated";
  const runId = "run-throw-relocated";
  const headSha = "b".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const otherPath = path.join(os.tmpdir(), "maswe-relocated-after-throw");
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      if (listCalls === 1) return [registration];
      return [exactRegistration(otherPath, `maswe/${runId}`, headSha)];
    },
    inspectPath: async () => (listCalls <= 1 ? "directory" : "absent") as TerminalCleanupPathState,
    removeWorktree: async () => {
      throw new Error("remove exploded");
    },
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
});

test("A4 post-inspection failure after removeWorktree throw -> cleanup-inspection-failed", async () => {
  const cwd = "/tmp/maswe-i30-throw-post-inspect";
  const runId = "run-throw-post-inspect";
  const headSha = "c".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      if (listCalls === 1) return [registration];
      throw new Error("post list failed");
    },
    inspectPath: async () => "directory",
    removeWorktree: async () => {
      throw new Error("remove exploded");
    },
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-inspection-failed",
  );
});

test("B1 post absent target/path but branch registered elsewhere -> cleanup-ownership-mismatch", async () => {
  const cwd = "/tmp/maswe-i30-post-branch-elsewhere";
  const runId = "run-post-branch-elsewhere";
  const headSha = "d".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const otherPath = path.join(os.tmpdir(), "maswe-post-other-path");
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      if (listCalls === 1) return [registration];
      return [exactRegistration(otherPath, `maswe/${runId}`, headSha)];
    },
    inspectPath: async () => (listCalls <= 1 ? "directory" : "absent") as TerminalCleanupPathState,
    removeWorktree: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
});

test("B2 post target registration survives with changed branch -> cleanup-ownership-mismatch", async () => {
  const cwd = "/tmp/maswe-i30-post-branch-changed";
  const runId = "run-post-branch-changed";
  const headSha = "e".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      if (listCalls === 1) return [registration];
      return [exactRegistration(worktreePath, "maswe/wrong-branch", headSha)];
    },
    inspectPath: async () => (listCalls <= 1 ? "directory" : "directory") as TerminalCleanupPathState,
    removeWorktree: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
});

test("B3 post target registration survives with changed HEAD -> cleanup-ownership-mismatch", async () => {
  const cwd = "/tmp/maswe-i30-post-head-changed";
  const runId = "run-post-head-changed";
  const headSha = "f".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      if (listCalls === 1) return [registration];
      return [exactRegistration(worktreePath, `maswe/${runId}`, "0".repeat(40))];
    },
    inspectPath: async () => "directory",
    removeWorktree: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
});

test("B4 post target becomes unsafe after removal -> cleanup-ownership-mismatch", async () => {
  const cwd = "/tmp/maswe-i30-post-unsafe";
  const runId = "run-post-unsafe";
  const headSha = "0".repeat(40);
  const worktreePath = externalWorktreePath(cwd, runId);
  const run = terminalRun(cwd, runId, headSha);
  const registration = exactRegistration(worktreePath, `maswe/${runId}`, headSha);
  let listCalls = 0;
  const deps: Partial<TerminalCleanupDependencies> = {
    listRegistrations: async () => {
      listCalls += 1;
      return listCalls === 1 ? [registration] : [];
    },
    inspectPath: async () => (listCalls <= 1 ? "directory" : "unsafe") as TerminalCleanupPathState,
    removeWorktree: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  await assertCleanupError(
    reconcileTerminalWorktreeCleanup(run, cwd, deps),
    "cleanup-ownership-mismatch",
  );
});
