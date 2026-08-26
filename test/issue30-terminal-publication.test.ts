import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  MasweConfig,
  RunRecord,
  RunTerminalCleanup,
  WorkflowEventType,
} from "../src/domain.ts";
import { ensureRunWorkspace, refreshWorkspaceHead } from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { RevalidationService } from "../src/revalidation.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import {
  FileRunStore,
  type CreateRunOptions,
  type RunStore,
} from "../src/store.ts";
const execFileAsync = promisify(execFile);
const TERMINAL_EVENTS = new Set<WorkflowEventType>(["COMPLETE", "CANCEL", "FAIL"]);

class TerminalPublicationCaptureStore implements RunStore {
  readonly captures: Array<{
    type: WorkflowEventType;
    terminalCleanup: RunRecord["terminalCleanup"];
  }> = [];
  private readonly delegate: FileRunStore;

  constructor(delegate: FileRunStore) {
    this.delegate = delegate;
  }

  create(
    title: string,
    request: string,
    config: MasweConfig,
    options: CreateRunOptions = {},
  ): Promise<RunRecord> {
    return this.delegate.create(title, request, config, options);
  }

  save(run: RunRecord): Promise<void> {
    return this.delegate.save(run);
  }

  load(runId: string): Promise<RunRecord> {
    return this.delegate.load(runId);
  }

  list(): Promise<RunRecord[]> {
    return this.delegate.list();
  }

  async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (TERMINAL_EVENTS.has(type)) {
      this.captures.push({
        type,
        terminalCleanup: structuredClone(run.terminalCleanup),
      });
    }
    return this.delegate.applyEvent(run, type, actor, details);
  }

  writeArtifact(run: RunRecord, name: string, content: string) {
    return this.delegate.writeArtifact(run, name, content);
  }

  readArtifact(run: RunRecord, name: string) {
    return this.delegate.readArtifact(run, name);
  }
}

class EditingBuilderRuntime extends MockRuntime {
  override async execute(request: Parameters<MockRuntime["execute"]>[0]) {
    if (request.role === "builder") {
      await writeFile(path.join(request.cwd, "builder-change.txt"), "builder delta\n", "utf8");
    }
    return super.execute(request);
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

function nonIsolatedConfig(): MasweConfig {
  const config = isolatedConfig();
  config.policy.useIsolatedWorktree = false;
  return config;
}

async function initGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-publication-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# publication\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function assertTerminalCleanup(
  actual: RunTerminalCleanup | undefined,
  expected: Pick<RunTerminalCleanup, "status"> & {
    preservationReason?: RunTerminalCleanup["preservationReason"];
  },
): void {
  assert.ok(actual, "terminal cleanup intent must be present on the terminal publication candidate");
  assert.equal(actual.status, expected.status);
  assert.equal(actual.preservationReason, expected.preservationReason);
  assert.match(actual.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
}

function latestCapture(
  store: TerminalPublicationCaptureStore,
  type: WorkflowEventType,
): RunTerminalCleanup | undefined {
  const capture = [...store.captures].reverse().find((entry) => entry.type === type);
  return capture?.terminalCleanup;
}

async function prepareMergeReadyRun(
  cwd: string,
  config: MasweConfig,
  store: FileRunStore,
): Promise<RunRecord> {
  let run = await store.create("merge-ready", "complete with cleanup intent", config);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  const headSha = run.workspace.headSha;
  run.evidence = {
    quality: { headSha, passed: true, at: "2026-08-24T12:00:00.000Z" },
    verification: { headSha, passed: true, at: "2026-08-24T12:01:00.000Z" },
    mergeReady: { headSha, passed: true, at: "2026-08-24T12:02:00.000Z" },
  };
  await store.save(run);
  run = await store.applyEvent(run, "MARK_MERGE_READY", "user", { headSha });
  return run;
}

test("isolated COMPLETE publishes pending cleanup intent before event persistence", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = isolatedConfig();
  const run = await prepareMergeReadyRun(cwd, config, delegate);

  await new Orchestrator(cwd, config, new MockRuntime(), store).complete(run.id);

  assertTerminalCleanup(latestCapture(store, "COMPLETE"), { status: "pending" });
});

test("isolated CANCEL publishes pending cleanup intent before event persistence", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
  const run = await orchestrator.start("cancel", "cancel with cleanup intent");

  await orchestrator.cancel(run.id);

  assertTerminalCleanup(latestCapture(store, "CANCEL"), { status: "pending" });
});

test("ordinary isolated FAIL publishes pending cleanup intent before event persistence", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = isolatedConfig();
  config.policy.maxBuildVerifyCycles = 1;
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 20,
  });
  let run = await orchestrator.start("ordinary fail", "fail without preservation");
  run.state = "BUILDING";
  run.counters.buildVerifyCycles = config.policy.maxBuildVerifyCycles;
  await delegate.save(run);

  await orchestrator.runUntilBlocked(run.id);

  assertTerminalCleanup(latestCapture(store, "FAIL"), { status: "pending" });
});

test("non-isolated terminal publication publishes complete cleanup intent", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = nonIsolatedConfig();
  const run = await delegate.create("non-isolated cancel", "no managed worktree path", config);

  await new Orchestrator(cwd, config, new MockRuntime(), store).cancel(run.id);

  assertTerminalCleanup(latestCapture(store, "CANCEL"), { status: "complete" });
});

test("bootstrap recovery after managed checkpoint publishes preserved bootstrap-recovery intent", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 20,
    afterWorkspaceCheckpoint: async () => {
      throw new Error("interrupt after workspace checkpoint");
    },
  });

  await orchestrator.start("bootstrap checkpoint fail", "preserve managed worktree");

  assertTerminalCleanup(latestCapture(store, "FAIL"), {
    status: "preserved",
    preservationReason: "bootstrap-recovery",
  });
});

test("bootstrap failure before managed worktree publishes complete cleanup intent", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store, {
    automaticTransitionLimit: 20,
    bootstrapHooks: {
      afterBranchCreate: async () => {
        throw new Error("interrupt before worktree checkpoint");
      },
    },
  });

  await orchestrator.start("bootstrap pre-worktree fail", "no managed worktree yet");

  assertTerminalCleanup(latestCapture(store, "FAIL"), { status: "complete" });
});

class FailingBuilderRuntime extends MockRuntime {
  override async execute(request: Parameters<MockRuntime["execute"]>[0]) {
    if (request.role === "builder") {
      throw new Error("builder failed during active revalidation");
    }
    return super.execute(request);
  }
}

test("active revalidation failure publishes preserved revalidation-recovery intent", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = isolatedConfig();
  let run = await delegate.create("revalidation fail", "preserve managed revalidation worktree", config);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  const headA = run.workspace.headSha;
  run.evidence = {
    quality: { headSha: headA, passed: true, at: "2026-08-24T12:00:00.000Z" },
    verification: { headSha: headA, passed: true, at: "2026-08-24T12:01:00.000Z" },
    mergeReady: { headSha: headA, passed: true, at: "2026-08-24T12:02:00.000Z" },
  };
  await delegate.save(run);
  const worktreePath = run.workspace.worktreePath;
  assert.ok(worktreePath);
  await writeFile(path.join(worktreePath, "head-b.txt"), "head B\n", "utf8");
  await execFileAsync("git", ["add", "head-b.txt"], { cwd: worktreePath });
  await execFileAsync("git", ["commit", "-qm", "head B"], { cwd: worktreePath });
  const observed = structuredClone(run);
  await refreshWorkspaceHead(observed);
  run = await new RevalidationService(delegate).route(run.id, {
    source: "local-workspace",
    previousHeadSha: headA,
    requestedHeadSha: observed.workspace!.headSha,
    expectedRunVersion: run.version,
    actor: "local-runner",
    observedWorkspace: observed.workspace!,
    at: "2026-08-24T12:03:00.000Z",
  });
  run.state = "BUILDING";
  await delegate.save(run);

  await new Orchestrator(cwd, config, new FailingBuilderRuntime(), store, {
    automaticTransitionLimit: 20,
  }).runUntilBlocked(run.id);

  assertTerminalCleanup(latestCapture(store, "FAIL"), {
    status: "preserved",
    preservationReason: "revalidation-recovery",
  });
});

test("mutable-role publication outcome unknown publishes preserved publication-outcome-unknown intent", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const delegate = new FileRunStore(cwd);
  const store = new TerminalPublicationCaptureStore(delegate);
  const config = isolatedConfig();
  let winningWorktreePath: string | undefined;
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilderRuntime(), store, {
    afterSpeculativeRoleCleanupBeforePublication: async () => {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd });
      winningWorktreePath = stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .find((worktreePath) => path.resolve(worktreePath) !== path.resolve(cwd));
      assert.ok(winningWorktreePath);
      await writeFile(
        path.join(winningWorktreePath, "prepublication-external-change.txt"),
        "external winner before publication\n",
        "utf8",
      );
    },
  });

  await orchestrator.start(
    "publication outcome unknown",
    "Preserve managed workspace after publication uncertainty.",
  );
  assert.ok(winningWorktreePath);

  assertTerminalCleanup(latestCapture(store, "FAIL"), {
    status: "preserved",
    preservationReason: "publication-outcome-unknown",
  });
});
