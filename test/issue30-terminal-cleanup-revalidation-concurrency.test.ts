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
  refreshWorkspaceHead,
} from "../src/git-workspace.ts";
import { scanLockJournal } from "../src/lock-journal.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { RevalidationService } from "../src/revalidation.ts";
import { runMutationJournalRoot } from "../src/run-mutation.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import {
  FileRunStore,
  type CreateRunOptions,
  type RunStore,
} from "../src/store.ts";

const execFileAsync = promisify(execFile);
const AT = "2026-08-25T11:30:00.000Z";

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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-revalidation-race-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# revalidation cleanup race\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function cleanupGitRepo(cwd: string): Promise<void> {
  try {
    const registrations = await listGitWorktreeRegistrations(cwd);
    for (const registration of registrations) {
      if (registration.worktreePath === path.resolve(cwd)) continue;
      await execFileAsync(
        "git",
        ["worktree", "remove", "--force", registration.worktreePath],
        { cwd },
      ).catch(() => undefined);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function createGate(): {
  wait: Promise<void>;
  entered: Promise<void>;
  signal: () => void;
  release: () => void;
} {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { wait, entered, signal, release };
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
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function pathIsAbsent(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function createFailedActiveRevalidation(
  cwd: string,
  store: FileRunStore,
  config: MasweConfig,
): Promise<RunRecord> {
  let run = await store.create(
    "failed active revalidation",
    "serialize retry revalidation with supersession cleanup",
    config,
  );
  run.workspace = await ensureRunWorkspace(cwd, run);
  run.state = "PR_READY";
  await store.save(run);
  const headA = run.workspace.headSha;
  const worktreePath = run.workspace.worktreePath;
  assert.ok(worktreePath);

  await writeFile(path.join(worktreePath, "head-b.txt"), "head B\n", "utf8");
  await execFileAsync("git", ["add", "head-b.txt"], { cwd: worktreePath });
  await execFileAsync("git", ["commit", "-qm", "head B"], { cwd: worktreePath });
  const observed = structuredClone(run);
  await refreshWorkspaceHead(observed);
  const headB = observed.workspace?.headSha;
  assert.ok(headB && headB !== headA);

  let failed = await new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha: headA,
    requestedHeadSha: headB,
    expectedRunVersion: run.version,
    actor: "local-runner",
    observedWorkspace: observed.workspace!,
  });
  failed.failure = {
    code: "workflow-failure",
    message: "retry active revalidation",
    at: AT,
    resumeState: "CI_RUNNING",
  };
  failed = await store.applyEvent(failed, "FAIL", "orchestrator", {
    reason: failed.failure.message,
    resumeState: failed.failure.resumeState,
  });
  failed.terminalCleanup = {
    status: "preserved",
    updatedAt: AT,
    preservationReason: "revalidation-recovery",
  };
  await store.save(failed);
  return store.load(failed.id);
}

test("active-revalidation retry cannot observe or recreate the worktree ahead of supersede recovery", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => cleanupGitRepo(cwd));
  const inner = new FileRunStore(cwd);
  const store = new PredecessorAbandonBarrierStore(inner);
  const config = isolatedConfig();
  const failed = await createFailedActiveRevalidation(cwd, inner, config);
  const worktreePath = failed.workspace?.worktreePath;
  assert.ok(worktreePath);
  store.predecessorId = failed.id;
  const abandonGate = createGate();
  store.gate = abandonGate;

  const supersedeOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  const retryOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  const observationGate = createGate();
  type RetryObservationInternals = {
    observeRevalidationWorkspace(run: RunRecord): Promise<string | undefined>;
  };
  const retryInternals = retryOrchestrator as unknown as RetryObservationInternals;
  const observe = retryInternals.observeRevalidationWorkspace.bind(retryOrchestrator);
  retryInternals.observeRevalidationWorkspace = async (candidate) => {
    const headSha = await observe(candidate);
    observationGate.signal();
    await observationGate.wait;
    return headSha;
  };

  const supersedePromise = supersedeOrchestrator.supersede(failed.id);
  await abandonGate.entered;
  const retryPromise = retryOrchestrator.retryFromFailed(failed.id);

  const observedBeforeFence = await Promise.race([
    observationGate.entered.then(() => true),
    waitFor("queued retry terminal-recovery claim", async () => {
      const operations = await unreleasedOperations(cwd, failed.id);
      return operations.filter((operation) => operation === "run-terminal-recovery").length >= 2;
    }).then(() => false),
  ]);

  abandonGate.release();
  if (observedBeforeFence) {
    await waitFor("supersede cleanup to remove the predecessor worktree", async () => {
      const authoritative = await inner.load(failed.id);
      return authoritative.terminalCleanup?.status === "complete" && pathIsAbsent(worktreePath);
    });
    observationGate.release();
  }

  const [replacementResult, retryResult] = await Promise.allSettled([
    supersedePromise,
    retryPromise,
  ]);
  assert.equal(replacementResult.status, "fulfilled");
  assert.equal(retryResult.status, "rejected");
  if (retryResult.status === "rejected") {
    assert.match(String(retryResult.reason), /already superseded by/);
  }

  assert.equal(
    observedBeforeFence,
    false,
    "retry must queue for terminal-recovery before active revalidation observation",
  );
  const abandoned = await inner.load(failed.id);
  assert.equal(abandoned.terminalCleanup?.status, "complete");
  assert.equal(await pathIsAbsent(worktreePath), true);
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.equal(
    registrations.some(
      (registration) => registration.worktreePath === path.resolve(worktreePath),
    ),
    false,
  );
});
