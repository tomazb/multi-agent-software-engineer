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
  RunGitHubAssociation,
  RunRecord,
  WorkflowEventType,
} from "../src/domain.ts";
import { TerminalCleanupError, ensureRunWorkspace } from "../src/git-workspace.ts";
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

class FailingBuilderRuntime extends MockRuntime {
  override async execute(request: Parameters<MockRuntime["execute"]>[0]) {
    if (request.role === "builder") {
      throw new Error("injected builder execution failure");
    }
    return super.execute(request);
  }
}

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

class CleanupPublicationFaultStore extends DelegatingStore {
  failNextCompletePublication = false;

  override async save(run: RunRecord): Promise<void> {
    if (this.failNextCompletePublication && run.terminalCleanup?.status === "complete") {
      this.failNextCompletePublication = false;
      throw new Error("injected cleanup-state publication failure");
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-cleanup-orch-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# cleanup orchestrator\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function unreleasedPublicationHeld(cwd: string, runId: string): Promise<boolean> {
  const scan = await scanLockJournal(runMutationJournalRoot(cwd, runId), "data");
  return scan.claims.some(
    (claim) =>
      claim.operation === "run-publication" && !scan.releases.has(claim.ticket),
  );
}

function failCount(run: RunRecord): number {
  return run.events.filter((event) => event.type === "FAIL").length;
}

function evidenceSnapshot(run: RunRecord): {
  evidence: RunRecord["evidence"];
  github: RunGitHubAssociation | undefined;
} {
  return {
    evidence: structuredClone(run.evidence),
    github: structuredClone(run.github),
  };
}

async function prepareMergeReadyRun(
  cwd: string,
  config: MasweConfig,
  store: FileRunStore,
  extras: { github?: boolean } = {},
): Promise<RunRecord> {
  let run = await store.create("merge-ready cleanup", "complete then cleanup", config);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  const headSha = run.workspace.headSha;
  run.evidence = {
    quality: { headSha, passed: true, at: "2026-08-24T12:00:00.000Z" },
    verification: { headSha, passed: true, at: "2026-08-24T12:01:00.000Z" },
    mergeReady: { headSha, passed: true, at: "2026-08-24T12:02:00.000Z" },
  };
  if (extras.github) {
    run.github = {
      installationId: 1,
      repository: "acme/demo",
      pullRequestNumber: 12,
      baseSha: headSha,
      headSha,
      branch: `maswe/${run.id}`,
    };
  }
  await store.save(run);
  return store.applyEvent(run, "MARK_MERGE_READY", "user", { headSha });
}

async function seedBuildingRun(
  orchestrator: Orchestrator,
  store: FileRunStore,
  title: string,
  cycles: number,
): Promise<RunRecord> {
  const started = await orchestrator.start(title, "drive building cleanup");
  if (started.terminalCleanup) {
    throw new Error(`seedBuildingRun expected a nonterminal start, found ${started.state}`);
  }
  started.state = "BUILDING";
  started.counters.buildVerifyCycles = cycles;
  await store.save(started);
  return store.load(started.id);
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

test("automatic successful completion persists COMPLETED with terminalCleanup.complete", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const run = await prepareMergeReadyRun(cwd, config, store);
  const worktreePath = run.workspace?.worktreePath;
  assert.ok(worktreePath);

  const completed = await new Orchestrator(cwd, config, new MockRuntime(), store).complete(run.id);

  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.terminalCleanup?.status, "complete");
  assert.equal(completed.failure, undefined);
  assert.equal(completed.events.filter((event) => event.type === "COMPLETE").length, 1);
  await assert.rejects(access(worktreePath), /ENOENT/);
});

test("injected completion cleanup failure keeps COMPLETED, persists failed cleanup, and leaves failure absent", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const prepared = await prepareMergeReadyRun(cwd, config, store, { github: true });
  const worktreePath = prepared.workspace?.worktreePath;
  assert.ok(worktreePath);
  const beforeEvidence = evidenceSnapshot(prepared);
  let removeFailuresRemaining = 1;
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    terminalCleanupDependencies: {
      removeWorktree: async (repositoryPath, worktreePath) => {
        if (removeFailuresRemaining > 0) {
          removeFailuresRemaining -= 1;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "injected completion remove failure",
          };
        }
        return gitRemoveWorktree(repositoryPath, worktreePath);
      },
    },
  });

  await assert.rejects(
    orchestrator.complete(prepared.id),
    (error: unknown) =>
      error instanceof TerminalCleanupError && error.code === "cleanup-remove-failed",
  );

  const authoritative = await store.load(prepared.id);
  assert.equal(authoritative.state, "COMPLETED");
  assert.equal(authoritative.failure, undefined);
  assert.equal(authoritative.terminalCleanup?.status, "failed");
  assert.equal(authoritative.terminalCleanup?.lastError?.code, "cleanup-remove-failed");
  assert.deepEqual(evidenceSnapshot(authoritative), beforeEvidence);
  await access(worktreePath);

  const retried = await orchestrator.cleanupTerminal(prepared.id);
  assert.equal(retried.state, "COMPLETED");
  assert.equal(retried.terminalCleanup?.status, "complete");
  assert.equal(retried.failure, undefined);
  assert.equal(retried.events.filter((event) => event.type === "COMPLETE").length, 1);
  await assert.rejects(access(worktreePath), /ENOENT/);
});

test("injected cancellation cleanup failure keeps CANCELLED and independent cleanup failure", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    terminalCleanupDependencies: {
      removeWorktree: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "injected cancellation remove failure",
      }),
    },
  });
  const started = await orchestrator.start("cancel cleanup", "cancel with injected cleanup failure");
  const worktreePath = started.workspace?.worktreePath;
  assert.ok(worktreePath);

  await assert.rejects(
    orchestrator.cancel(started.id),
    (error: unknown) =>
      error instanceof TerminalCleanupError && error.code === "cleanup-remove-failed",
  );

  const authoritative = await store.load(started.id);
  assert.equal(authoritative.state, "CANCELLED");
  assert.equal(authoritative.failure, undefined);
  assert.equal(authoritative.terminalCleanup?.status, "failed");
  assert.equal(authoritative.terminalCleanup?.lastError?.code, "cleanup-remove-failed");
  await access(worktreePath);
});

test("ordinary FAILED cleanup failure preserves engineering failure exactly", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  config.policy.maxBuildVerifyCycles = 1;
  let seeded!: RunRecord;
  let failureAtCleanup: RunRecord["failure"];
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 20,
    terminalCleanupDependencies: {
      removeWorktree: async () => {
        failureAtCleanup = structuredClone((await store.load(seeded.id)).failure);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "injected failed-run remove failure",
        };
      },
    },
  });
  seeded = await seedBuildingRun(
    orchestrator,
    store,
    "failed cleanup",
    config.policy.maxBuildVerifyCycles,
  );

  await assert.rejects(
    orchestrator.advance(seeded.id),
    (error: unknown) =>
      error instanceof TerminalCleanupError && error.code === "cleanup-remove-failed",
  );

  const authoritative = await store.load(seeded.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.code, "workflow-failure");
  assert.match(authoritative.failure?.message ?? "", /Maximum build\/verify cycles exceeded/);
  assert.deepEqual(authoritative.failure, failureAtCleanup);
  assert.equal(authoritative.terminalCleanup?.status, "failed");
  assert.equal(authoritative.terminalCleanup?.lastError?.code, "cleanup-remove-failed");
  assert.equal(failCount(authoritative), 1);
});

test("advance-driven FAIL starts physical cleanup only after publication is released", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  config.policy.maxBuildVerifyCycles = 1;
  let seeded!: RunRecord;
  let publicationHeldAtCleanup: boolean | undefined;
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 20,
    terminalCleanupDependencies: {
      removeWorktree: async (repositoryPath, worktreePath) => {
        publicationHeldAtCleanup = await unreleasedPublicationHeld(cwd, seeded.id);
        return gitRemoveWorktree(repositoryPath, worktreePath);
      },
    },
  });
  seeded = await seedBuildingRun(
    orchestrator,
    store,
    "cycle-limit fence release",
    config.policy.maxBuildVerifyCycles,
  );

  const advanced = await orchestrator.advance(seeded.id);

  assert.equal(
    publicationHeldAtCleanup,
    false,
    "automatic FAIL cleanup must start only after the publication claim is released",
  );
  assert.equal(advanced.state, "FAILED");
  assert.equal(advanced.terminalCleanup?.status, "complete");
  assert.equal(failCount(advanced), 1);
});

test("ordinary BUILDING execution failure uses the same post-publication cleanup boundary", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  let seeded!: RunRecord;
  let publicationHeldAtCleanup: boolean | undefined;
  const starter = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 20,
  });
  seeded = await seedBuildingRun(starter, store, "builder execution fail", 0);
  assert.ok(seeded.workspace);
  seeded.workspace.baseSha = "not-a-git-repository";
  await store.save(seeded);
  seeded = await store.load(seeded.id);
  const orchestrator = new Orchestrator(cwd, config, new FailingBuilderRuntime(), store, {
    automaticTransitionLimit: 20,
    terminalCleanupDependencies: {
      removeWorktree: async (repositoryPath, worktreePath) => {
        publicationHeldAtCleanup = await unreleasedPublicationHeld(cwd, seeded.id);
        return gitRemoveWorktree(repositoryPath, worktreePath);
      },
    },
  });

  const advanced = await orchestrator.advance(seeded.id);

  assert.equal(
    publicationHeldAtCleanup,
    false,
    "ordinary BUILDING FAIL cleanup must start only after the publication claim is released",
  );
  assert.equal(advanced.state, "FAILED");
  assert.match(advanced.failure?.message ?? "", /injected builder execution failure/);
  assert.equal(advanced.terminalCleanup?.status, "complete");
  assert.equal(failCount(advanced), 1);
});

test("injected advance cleanup failure surfaces TerminalCleanupError without a second FAIL", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  config.policy.maxBuildVerifyCycles = 1;
  let seeded!: RunRecord;
  let failureAtCleanup: RunRecord["failure"];
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 20,
    terminalCleanupDependencies: {
      removeWorktree: async () => {
        failureAtCleanup = structuredClone((await store.load(seeded.id)).failure);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "injected advance remove failure",
        };
      },
    },
  });
  seeded = await seedBuildingRun(
    orchestrator,
    store,
    "advance cleanup failure",
    config.policy.maxBuildVerifyCycles,
  );

  await assert.rejects(
    orchestrator.advance(seeded.id),
    (error: unknown) =>
      error instanceof TerminalCleanupError && error.code === "cleanup-remove-failed",
  );

  const authoritative = await store.load(seeded.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.code, "workflow-failure");
  assert.match(authoritative.failure?.message ?? "", /Maximum build\/verify cycles exceeded/);
  assert.deepEqual(authoritative.failure, failureAtCleanup);
  assert.equal(authoritative.terminalCleanup?.status, "failed");
  assert.equal(authoritative.terminalCleanup?.lastError?.code, "cleanup-remove-failed");
  assert.equal(failCount(authoritative), 1);
});

test("physical cleanup success followed by cleanup-state publication failure is later reconciled to complete", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const inner = new FileRunStore(cwd);
  const store = new CleanupPublicationFaultStore(inner);
  const config = isolatedConfig();
  const prepared = await prepareMergeReadyRun(cwd, config, inner);
  const worktreePath = prepared.workspace?.worktreePath;
  assert.ok(worktreePath);
  store.failNextCompletePublication = true;
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);

  await assert.rejects(orchestrator.complete(prepared.id), /injected cleanup-state publication failure/);

  const afterFault = await store.load(prepared.id);
  assert.equal(afterFault.state, "COMPLETED");
  assert.equal(afterFault.terminalCleanup?.status, "pending");
  await assert.rejects(access(worktreePath), /ENOENT/);

  const reconciled = await orchestrator.cleanupTerminal(prepared.id);
  assert.equal(reconciled.state, "COMPLETED");
  assert.equal(reconciled.terminalCleanup?.status, "complete");
  assert.equal(reconciled.failure, undefined);
  assert.equal(reconciled.events.filter((event) => event.type === "COMPLETE").length, 1);
});

test("repeated cleanupTerminal after success is idempotent and adds no workflow events", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const prepared = await prepareMergeReadyRun(cwd, config, store);
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  const completed = await orchestrator.complete(prepared.id);
  const eventCount = completed.events.length;

  const again = await orchestrator.cleanupTerminal(completed.id);
  assert.equal(again.terminalCleanup?.status, "complete");
  assert.equal(again.state, "COMPLETED");
  assert.equal(again.events.length, eventCount);
});
