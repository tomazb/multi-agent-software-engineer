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
  externalWorktreePath,
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
import { captureWorkspaceBootstrapIntent } from "../src/workspace-bootstrap.ts";

const execFileAsync = promisify(execFile);

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

class CancelInsideRecoveryBarrierStore extends DelegatingStore {
  predecessorId = "";
  gate: ReturnType<typeof createGate> | undefined;

  override async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (this.gate && type === "CANCEL" && run.id === this.predecessorId) {
      this.gate.signal();
      await this.gate.wait;
    }
    return this.inner.applyEvent(run, type, actor, details);
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-i30-boot-supersede-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# bootstrap supersede concurrency\n", "utf8");
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

async function plannedCreatedRun(
  store: RunStore,
  cwd: string,
  config: MasweConfig,
  title: string,
): Promise<RunRecord> {
  return store.create(title, "bootstrap supersede concurrency", config, {
    workspaceBootstrap: await captureWorkspaceBootstrapIntent(cwd, config),
  });
}

async function assertBranchRetained(cwd: string, runId: string): Promise<void> {
  const branch = `maswe/${runId}`;
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd });
  assert.match(stdout.trim(), /^[0-9a-f]{40}$/);
}

async function managedRegistrationPresent(cwd: string, runId: string): Promise<boolean> {
  const branch = `maswe/${runId}`;
  const registrations = await listGitWorktreeRegistrations(cwd);
  return registrations.some((registration) => registration.branch === branch);
}

test("B1: bootstrap-before-supersede serializes cleanup until bootstrap target is finished", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const planned = await plannedCreatedRun(store, cwd, config, "B1 predecessor");
  const plannedPath = path.resolve(externalWorktreePath(cwd, planned.id));
  const barrier = createGate();

  const bootstrapOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      beforeBranchCreate: async (candidate) => {
        assert.equal(candidate.id, planned.id);
        const durable = await store.load(planned.id);
        assert.equal(durable.state, "CREATED");
        assert.ok(durable.workspaceBootstrap?.plannedWorktreePath);
        assert.equal(
          path.resolve(durable.workspaceBootstrap.plannedWorktreePath),
          plannedPath,
        );
        assert.equal(durable.workspace, undefined);
        await assert.rejects(access(plannedPath), /ENOENT/);
        assert.equal(await managedRegistrationPresent(cwd, planned.id), false);
        barrier.signal();
        await barrier.wait;
      },
    },
  });
  const supersedeOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);

  const bootstrapPromise = bootstrapOrchestrator.bootstrapCreatedRun(planned.id);
  await barrier.entered;

  const supersedePromise = supersedeOrchestrator.supersede(planned.id);

  type RaceOutcome =
    | { kind: "serialized" }
    | { kind: "supersede-finished-while-paused"; abandoned: RunRecord };

  let raceOutcome: RaceOutcome;
  try {
    raceOutcome = await Promise.race([
      waitFor(
        "queued terminal-recovery behind bootstrap target",
        async () => {
          const ops = await unreleasedOperations(cwd, planned.id);
          return ops.includes("run-target-mutation") && ops.includes("run-terminal-recovery");
        },
        15_000,
      ).then(() => ({ kind: "serialized" as const })),
      supersedePromise.then(async () => {
        const abandoned = await store.load(planned.id);
        return { kind: "supersede-finished-while-paused" as const, abandoned };
      }),
    ]);
  } catch (error) {
    barrier.release();
    await Promise.allSettled([bootstrapPromise, supersedePromise]);
    throw error;
  }

  if (raceOutcome.kind === "supersede-finished-while-paused") {
    // Current-head RED: cleanup can finish while bootstrap is still paused after
    // plannedWorktreePath publication but before branch/worktree creation.
    assert.equal(raceOutcome.abandoned.terminalCleanup?.status, "complete");
    assert.equal(await managedRegistrationPresent(cwd, planned.id), false);
    barrier.release();
    await Promise.allSettled([bootstrapPromise]);
    const orphanRegistration = await managedRegistrationPresent(cwd, planned.id);
    let orphanPath = false;
    try {
      await access(plannedPath);
      orphanPath = true;
    } catch {
      orphanPath = false;
    }
    assert.equal(
      orphanRegistration || orphanPath,
      false,
      "terminalCleanup.complete must not coexist with a surviving managed bootstrap target",
    );
    assert.fail(
      "supersede completed cleanup while bootstrap could still create the managed target",
    );
  }

  assert.ok(
    (await unreleasedOperations(cwd, planned.id)).includes("run-target-mutation"),
    "bootstrap must hold target before planned-path bind / side effects",
  );
  const mid = await store.load(planned.id);
  assert.equal(mid.state, "CREATED");
  assert.notEqual(mid.terminalCleanup?.status, "complete");

  barrier.release();

  const [bootstrapSettled, supersedeSettled] = await Promise.all([
    Promise.allSettled([bootstrapPromise]).then((results) => results[0]!),
    Promise.allSettled([supersedePromise]).then((results) => results[0]!),
  ]);

  const abandoned = await store.load(planned.id);
  assert.ok(abandoned.supersededBy);
  assert.equal(abandoned.state, "CANCELLED");
  assert.equal(abandoned.terminalCleanup?.status, "complete");
  assert.equal(await managedRegistrationPresent(cwd, planned.id), false);
  await assert.rejects(access(plannedPath), /ENOENT/);
  await assertBranchRetained(cwd, planned.id);

  assert.equal(supersedeSettled.status, "fulfilled");
  const replacement = (supersedeSettled as PromiseFulfilledResult<RunRecord>).value;
  assert.equal(replacement.supersedes, planned.id);
  assert.ok(replacement.workspace?.worktreePath);
  assert.notEqual(path.resolve(replacement.workspace!.worktreePath!), plannedPath);

  if (bootstrapSettled.status === "fulfilled") {
    assert.notEqual(bootstrapSettled.value.state, "CREATED");
  } else {
    assert.match(
      String(bootstrapSettled.reason),
      /CREATED|CANCELLED|superseded|conflict|ambiguous|bootstrap|version/i,
    );
  }
  assert.equal((await unreleasedOperations(cwd, planned.id)).length, 0);
});

test("B2: supersede-before-bootstrap — bootstrap performs zero Git side effects", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const inner = new FileRunStore(cwd);
  const store = new CancelInsideRecoveryBarrierStore(inner);
  const config = isolatedConfig();
  const planned = await plannedCreatedRun(store, cwd, config, "B2 predecessor");
  const plannedPath = path.resolve(externalWorktreePath(cwd, planned.id));
  // Durably bind plannedWorktreePath without Git side effects so supersede cleanup
  // has portable authority while proving bootstrap still performs zero branch/worktree
  // creation after losing the mutation race.
  const bound = structuredClone(planned);
  bound.workspaceBootstrap = {
    ...bound.workspaceBootstrap!,
    plannedWorktreePath: plannedPath,
  };
  await store.save(bound);
  const cancelGate = createGate();
  store.predecessorId = planned.id;
  store.gate = cancelGate;
  let branchCreateAttempts = 0;

  const bootstrapOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      beforeBranchCreate: async () => {
        branchCreateAttempts += 1;
      },
    },
  });
  const supersedeOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);

  const supersedePromise = supersedeOrchestrator.supersede(planned.id);
  await cancelGate.entered;
  assert.ok(
    (await unreleasedOperations(cwd, planned.id)).includes("run-terminal-recovery"),
    "supersede must hold terminal-recovery through CANCEL publication",
  );

  const bootstrapPromise = bootstrapOrchestrator.bootstrapCreatedRun(planned.id);
  await waitFor("bootstrap target queued behind supersede terminal-recovery", async () => {
    const ops = await unreleasedOperations(cwd, planned.id);
    return ops.includes("run-terminal-recovery") && ops.includes("run-target-mutation");
  });
  assert.equal(branchCreateAttempts, 0);
  assert.equal(await managedRegistrationPresent(cwd, planned.id), false);
  await assert.rejects(access(plannedPath), /ENOENT/);
  assert.equal((await store.load(planned.id)).state, "CREATED");

  cancelGate.release();

  const [supersedeSettled, bootstrapSettled] = await Promise.all([
    Promise.allSettled([supersedePromise]).then((results) => results[0]!),
    Promise.allSettled([bootstrapPromise]).then((results) => results[0]!),
  ]);

  assert.equal(supersedeSettled.status, "fulfilled");
  const replacement = (supersedeSettled as PromiseFulfilledResult<RunRecord>).value;
  assert.equal(bootstrapSettled.status, "rejected");
  assert.match(
    String((bootstrapSettled as PromiseRejectedResult).reason),
    /CREATED|CANCELLED|superseded|bootstrap requires CREATED/i,
  );

  const abandoned = await store.load(planned.id);
  assert.equal(abandoned.state, "CANCELLED");
  assert.equal(abandoned.supersededBy, replacement.id);
  assert.equal(abandoned.terminalCleanup?.status, "complete");
  assert.equal(branchCreateAttempts, 0);
  assert.equal(await managedRegistrationPresent(cwd, planned.id), false);
  await assert.rejects(access(plannedPath), /ENOENT/);
  assert.equal(abandoned.workspaceBootstrap?.plannedWorktreePath, plannedPath);
  assert.ok(replacement.workspace?.worktreePath);
  assert.equal((await unreleasedOperations(cwd, planned.id)).length, 0);
});

test("B3: cancel while bootstrap is paused must not leave complete + surviving target", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const planned = await plannedCreatedRun(store, cwd, config, "B3 cancel race");
  const plannedPath = path.resolve(externalWorktreePath(cwd, planned.id));
  const barrier = createGate();

  const bootstrapOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      beforeBranchCreate: async () => {
        const durable = await store.load(planned.id);
        assert.ok(durable.workspaceBootstrap?.plannedWorktreePath);
        barrier.signal();
        await barrier.wait;
      },
    },
  });
  const cancelOrchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);

  const bootstrapPromise = bootstrapOrchestrator.bootstrapCreatedRun(planned.id);
  await barrier.entered;

  const heldTargetAtPause = (await unreleasedOperations(cwd, planned.id)).includes(
    "run-target-mutation",
  );

  const cancelPromise = cancelOrchestrator.cancel(planned.id);
  try {
    await waitFor(
      "cancel published or cleanup queued",
      async () => {
        const ops = await unreleasedOperations(cwd, planned.id);
        if (ops.includes("run-terminal-cleanup") && ops.includes("run-target-mutation")) {
          return true;
        }
        const current = await store.load(planned.id);
        return current.state === "CANCELLED";
      },
      15_000,
    );
  } catch (error) {
    barrier.release();
    await Promise.allSettled([bootstrapPromise, cancelPromise]);
    throw error;
  }

  barrier.release();
  await Promise.allSettled([bootstrapPromise, cancelPromise]);

  assert.equal(
    heldTargetAtPause,
    true,
    "bootstrap must hold target through cancel interleaving",
  );

  const cancelled = await store.load(planned.id);
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.terminalCleanup?.status, "complete");
  assert.equal(await managedRegistrationPresent(cwd, planned.id), false);
  await assert.rejects(access(plannedPath), /ENOENT/);
  const listed = await execFileAsync("git", ["branch", "--list", `maswe/${planned.id}`], { cwd });
  if (listed.stdout.trim().length > 0) {
    await assertBranchRetained(cwd, planned.id);
  }
  assert.equal((await unreleasedOperations(cwd, planned.id)).length, 0);
});

test("B4: bootstrap failure before worktree add does not leak target claim", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = isolatedConfig();
  const planned = await plannedCreatedRun(store, cwd, config, "B4 failure leak");

  let heldTargetDuringFailure = false;
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    bootstrapHooks: {
      beforeBranchCreate: async () => {
        heldTargetDuringFailure = (await unreleasedOperations(cwd, planned.id)).includes(
          "run-target-mutation",
        );
        throw new Error("injected bootstrap failure before branch create");
      },
    },
  });

  const failed = await orchestrator.bootstrapCreatedRun(planned.id);
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.failure?.resumeState, "CREATED");
  assert.ok(failed.workspaceBootstrap?.plannedWorktreePath);
  assert.equal(await managedRegistrationPresent(cwd, planned.id), false);
  // Pre-worktree bootstrap-recovery may publish complete when the managed target is
  // observably absent, or preserved when presence cannot be proven absent.
  assert.ok(
    failed.terminalCleanup?.status === "complete" ||
      failed.terminalCleanup?.status === "preserved",
  );
  if (failed.terminalCleanup?.status === "preserved") {
    assert.equal(failed.terminalCleanup.preservationReason, "bootstrap-recovery");
  }
  assert.equal(
    heldTargetDuringFailure,
    true,
    "bootstrap failure path must hold target through the failing side-effect window",
  );
  assert.equal((await unreleasedOperations(cwd, planned.id)).length, 0);
});
