import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  ArtifactReference,
  MasweConfig,
  RunRecord,
  WorkflowEventType,
} from "../src/domain.ts";
import {
  ensureRunWorkspace,
  listGitWorktreeRegistrations,
} from "../src/git-workspace.ts";
import { scanLockJournal } from "../src/lock-journal.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { runMutationJournalRoot } from "../src/run-mutation.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import {
  FileRunStore,
  type CreateRunOptions,
  type RunStore,
} from "../src/store.ts";

const execFileAsync = promisify(execFile);
const AT = "2026-08-24T12:00:00.000Z";

class DelegatingStore implements RunStore {
  protected readonly inner: FileRunStore;

  constructor(inner: FileRunStore) {
    this.inner = inner;
  }

  create(
    title: string,
    request: string,
    config: MasweConfig,
    options: CreateRunOptions = {},
  ): Promise<RunRecord> {
    return this.inner.create(title, request, config, options);
  }

  save(run: RunRecord): Promise<void> {
    return this.inner.save(run);
  }

  load(runId: string): Promise<RunRecord> {
    return this.inner.load(runId);
  }

  list(): Promise<RunRecord[]> {
    return this.inner.list();
  }

  applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    return this.inner.applyEvent(run, type, actor, details);
  }

  writeArtifact(
    run: RunRecord,
    name: string,
    content: string,
  ): Promise<ArtifactReference> {
    return this.inner.writeArtifact(run, name, content);
  }

  readArtifact(run: RunRecord, name: string): Promise<string | undefined> {
    return this.inner.readArtifact(run, name);
  }
}

class PredecessorAbandonBarrierStore extends DelegatingStore {
  predecessorId = "";
  gate: ReturnType<typeof createGate> | undefined;

  override async save(run: RunRecord): Promise<void> {
    if (this.gate && run.id === this.predecessorId && run.supersededBy) {
      this.gate.signal();
      await this.gate.wait;
    }
    return this.inner.save(run);
  }
}

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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-concurrency-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# cleanup concurrency\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function createGate(): {
  wait: Promise<void>;
  entered: Promise<void>;
  signal: () => void;
  release: () => void;
} {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let signal: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signal = () => resolve();
  });
  return {
    wait,
    entered,
    signal: () => signal(),
    release: () => release(),
  };
}

function createOverlapTracker(): {
  enter: (role: string) => void;
  leave: (role: string) => void;
} {
  const active = new Set<string>();
  return {
    enter(role: string) {
      if (active.size > 0) {
        throw new Error(`overlapping mutation roles: ${[...active].join(",")} + ${role}`);
      }
      active.add(role);
    },
    leave(role: string) {
      active.delete(role);
    },
  };
}

async function unreleasedOperations(cwd: string, runId: string): Promise<string[]> {
  try {
    const scan = await scanLockJournal(runMutationJournalRoot(cwd, runId), "data");
    return scan.claims
      .filter((claim) => !scan.releases.has(claim.ticket))
      .map((claim) => claim.operation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function gitRemoveWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repositoryPath,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
}

function retryEvents(run: RunRecord): RunRecord["events"] {
  return run.events.filter((event) => event.type === "RETRY_FROM_FAILED");
}

function assertNoCleanupWorkflowEvent(run: RunRecord): void {
  assert.equal(
    run.events.filter((event) => String(event.type).includes("CLEANUP")).length,
    0,
  );
}

async function createRetryableFailedPending(
  cwd: string,
  store: FileRunStore,
  config: MasweConfig,
): Promise<RunRecord> {
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  let run = await orchestrator.start("retryable failed", "serialize cleanup and retry");
  run.failure = {
    code: "workflow-failure",
    message: "retryable ordinary failure",
    at: AT,
    resumeState: "WAITING_FOR_BRAINSTORM_APPROVAL",
  };
  run.terminalCleanup = { status: "pending", updatedAt: AT };
  run = await store.applyEvent(run, "FAIL", "orchestrator", {
    reason: run.failure.message,
    resumeState: run.failure.resumeState,
  });
  const loaded = await store.load(run.id);
  assert.equal(loaded.state, "FAILED");
  assert.equal(loaded.terminalCleanup?.status, "pending");
  assert.ok(loaded.workspace?.worktreePath);
  return loaded;
}

async function prepareMergeReadyRun(
  cwd: string,
  config: MasweConfig,
  store: FileRunStore,
): Promise<RunRecord> {
  let run = await store.create("merge-ready concurrency", "publication vs cleanup", config);
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

test("cleanup wins: retry waits, then reconstructs after terminal-cleanup releases", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const failed = await createRetryableFailedPending(cwd, store, config);
  const worktreePath = failed.workspace!.worktreePath!;
  const other = await new Orchestrator(cwd, config, new MockRuntime(), store).start(
    "other run",
    "must not be deleted",
  );
  const otherWorktree = other.workspace?.worktreePath;
  assert.ok(otherWorktree);
  const cleanupGate = createGate();
  const overlap = createOverlapTracker();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    terminalCleanupDependencies: {
      removeWorktree: async (repositoryPath, candidatePath) => {
        overlap.enter("cleanup");
        cleanupGate.signal();
        await cleanupGate.wait;
        overlap.leave("cleanup");
        const ops = await unreleasedOperations(cwd, failed.id);
        assert.ok(ops.includes("run-terminal-cleanup"));
        return gitRemoveWorktree(repositoryPath, candidatePath);
      },
    },
  });

  const cleanupPromise = orchestrator.cleanupTerminal(failed.id);
  await cleanupGate.entered;
  const retryPromise = orchestrator.retryFromFailed(failed.id);
  await Promise.race([
    waitFor("queued terminal-recovery claim", async () =>
      (await unreleasedOperations(cwd, failed.id)).includes("run-terminal-recovery"),
    ),
    retryPromise.then((result) => {
      throw new Error(
        `retry finished while cleanup still held the fence; state=${result.state}`,
      );
    }),
  ]);
  assert.equal((await store.load(failed.id)).state, "FAILED");
  cleanupGate.release();

  const cleaned = await cleanupPromise;
  const retried = await retryPromise;
  assert.equal(cleaned.state, "FAILED");
  assert.equal(cleaned.terminalCleanup?.status, "complete");
  assert.equal(retried.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(retried.terminalCleanup, undefined);
  assert.equal(retryEvents(retried).length, 1);
  assertNoCleanupWorkflowEvent(retried);
  await access(worktreePath);
  await access(otherWorktree);
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.ok(
    registrations.some(
      (registration) => registration.worktreePath === path.resolve(worktreePath),
    ),
  );
  assert.ok(
    registrations.some(
      (registration) => registration.worktreePath === path.resolve(otherWorktree),
    ),
    "cleanup must not delete another run's worktree",
  );
});

test("retry wins: cleanup reloads nonterminal and rejects after terminal-recovery publishes", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const failed = await createRetryableFailedPending(cwd, store, config);
  const retryGate = createGate();
  const overlap = createOverlapTracker();
  let removeCalls = 0;
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    beforeRetryPublication: async (candidate) => {
      assert.equal(candidate.terminalCleanup, undefined);
      const ops = await unreleasedOperations(cwd, failed.id);
      assert.ok(ops.includes("run-terminal-recovery"));
      assert.equal(
        ops.includes("run-publication"),
        false,
        "retry must not hold publication while terminal-recovery is held",
      );
      assert.equal(
        ops.includes("run-target-mutation"),
        false,
        "retry must not hold target while terminal-recovery is held",
      );
      overlap.enter("retry");
      retryGate.signal();
      await retryGate.wait;
      overlap.leave("retry");
    },
    terminalCleanupDependencies: {
      removeWorktree: async (repositoryPath, candidatePath) => {
        removeCalls += 1;
        overlap.enter("cleanup");
        overlap.leave("cleanup");
        return gitRemoveWorktree(repositoryPath, candidatePath);
      },
    },
  });

  const retryPromise = orchestrator.retryFromFailed(failed.id);
  await retryGate.entered;
  const cleanupPromise = orchestrator.cleanupTerminal(failed.id);
  await waitFor("queued terminal-cleanup claim", async () =>
    (await unreleasedOperations(cwd, failed.id)).includes("run-terminal-cleanup"),
  );
  assert.equal((await store.load(failed.id)).state, "FAILED");
  const held = await unreleasedOperations(cwd, failed.id);
  assert.ok(held.includes("run-terminal-recovery"));
  retryGate.release();

  const retried = await retryPromise;
  await assert.rejects(
    cleanupPromise,
    (error: unknown) =>
      error instanceof Error && /cleanupTerminal requires a terminal run/.test(error.message),
  );
  assert.equal(retried.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(retried.terminalCleanup, undefined);
  assert.equal(retryEvents(retried).length, 1);
  assert.equal(removeCalls, 0);
  assertNoCleanupWorkflowEvent(retried);
  await access(failed.workspace!.worktreePath!);
});

test("supersede wins: terminal-recovery abandons preserved predecessor before cleanup", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const inner = new FileRunStore(cwd);
  const store = new PredecessorAbandonBarrierStore(inner);
  const config = isolatedConfig();
  const abandonGate = createGate();
  store.gate = abandonGate;
  const overlap = createOverlapTracker();
  const bootstrapOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    afterWorkspaceCheckpoint: async () => {
      throw new Error("injected preserved bootstrap failure");
    },
  });
  const predecessor = await bootstrapOrchestrator.start("preserved predecessor", "supersede me");
  assert.equal(predecessor.state, "FAILED");
  assert.equal(predecessor.terminalCleanup?.status, "preserved");
  store.predecessorId = predecessor.id;
  const worktreePath = predecessor.workspace?.worktreePath;
  assert.ok(worktreePath);
  const other = await new Orchestrator(cwd, config, new MockRuntime(), store).start(
    "other preserved neighbor",
    "cross-run safety",
  );
  const otherWorktree = other.workspace?.worktreePath;
  assert.ok(otherWorktree);

  const supersedeOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    terminalCleanupDependencies: {
      removeWorktree: async (repositoryPath, candidatePath) => {
        overlap.enter("cleanup");
        const ops = await unreleasedOperations(cwd, predecessor.id);
        assert.equal(
          ops.includes("run-terminal-recovery"),
          false,
          "shared cleanup must run only after terminal-recovery is released",
        );
        assert.ok(ops.includes("run-terminal-cleanup"));
        overlap.leave("cleanup");
        return gitRemoveWorktree(repositoryPath, candidatePath);
      },
    },
  });

  const supersedePromise = supersedeOrchestrator.supersede(predecessor.id);
  await abandonGate.entered;
  const cleanupPromise = supersedeOrchestrator.cleanupTerminal(predecessor.id);
  await Promise.race([
    waitFor("queued terminal-cleanup behind terminal-recovery", async () => {
      const ops = await unreleasedOperations(cwd, predecessor.id);
      return ops.includes("run-terminal-recovery") && ops.includes("run-terminal-cleanup");
    }),
    cleanupPromise.then(
      (result) => {
        throw new Error(
          `cleanup finished while supersede still held recovery; cleanup=${result.terminalCleanup?.status}`,
        );
      },
      (error: unknown) => {
        throw new Error(
          `cleanup rejected while supersede still held recovery: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    ),
  ]);
  assert.equal((await inner.load(predecessor.id)).terminalCleanup?.status, "preserved");
  abandonGate.release();

  const replacement = await supersedePromise;
  const cleaned = await cleanupPromise;
  const abandoned = await inner.load(predecessor.id);
  assert.equal(abandoned.supersededBy, replacement.id);
  assert.equal(abandoned.terminalCleanup?.status, "complete");
  assert.notEqual(abandoned.terminalCleanup?.preservationReason, "bootstrap-recovery");
  assert.equal(cleaned.terminalCleanup?.status, "complete");
  assertNoCleanupWorkflowEvent(abandoned);
  await assert.rejects(access(worktreePath), /ENOENT/);
  await access(otherWorktree);
});

test("publication vs cleanup: one FIFO journal owner at a time with no overlap", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const prepared = await prepareMergeReadyRun(cwd, config, store);
  const publicationGate = createGate();
  const overlap = createOverlapTracker();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    afterRunMutationReload: async (phase) => {
      if (phase !== "complete") return;
      overlap.enter("publication");
      publicationGate.signal();
      await publicationGate.wait;
      overlap.leave("publication");
    },
    terminalCleanupDependencies: {
      removeWorktree: async (repositoryPath, candidatePath) => {
        overlap.enter("cleanup");
        const ops = await unreleasedOperations(cwd, prepared.id);
        assert.equal(ops.includes("run-publication"), false);
        assert.ok(ops.includes("run-terminal-cleanup"));
        overlap.leave("cleanup");
        return gitRemoveWorktree(repositoryPath, candidatePath);
      },
    },
  });

  const completePromise = orchestrator.complete(prepared.id);
  await publicationGate.entered;
  const cleanupPromise = orchestrator.cleanupTerminal(prepared.id);
  await waitFor("queued terminal-cleanup behind publication", async () => {
    const ops = await unreleasedOperations(cwd, prepared.id);
    return ops.includes("run-publication") && ops.includes("run-terminal-cleanup");
  });
  publicationGate.release();

  const completed = await completePromise;
  const cleaned = await cleanupPromise;
  assert.equal(completed.state, "COMPLETED");
  assert.equal(cleaned.state, "COMPLETED");
  assert.equal(completed.terminalCleanup?.status, "complete");
  assert.equal(cleaned.terminalCleanup?.status, "complete");
  assert.equal(completed.events.filter((event) => event.type === "COMPLETE").length, 1);
  assertNoCleanupWorkflowEvent(completed);
});
