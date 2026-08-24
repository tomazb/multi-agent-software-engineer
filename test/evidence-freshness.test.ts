import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  AgentRuntime,
  ArtifactReference,
  MasweConfig,
  RunRecord,
  RuntimeDoctorResult,
  RuntimeRequest,
  RuntimeResult,
} from "../src/domain.ts";
import {
  ensureRunWorkspace,
  refreshWorkspaceHead,
  TerminalCleanupError,
} from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import {
  RevalidationOptimisticConflictError,
  RevalidationService,
} from "../src/revalidation.ts";
import { RunMutationSupersededError } from "../src/run-mutation.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);
const HEAD_C = "c".repeat(40);

function configuredWithinTimeoutMs(): number {
  const raw = process.env.MASWE_TEST_WITHIN_TIMEOUT_MS;
  const timeoutMs = raw === undefined ? 15_000 : Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("MASWE_TEST_WITHIN_TIMEOUT_MS must be an integer from 1000 through 60000");
  }
  return timeoutMs;
}

const WITHIN_TIMEOUT_MS = configuredWithinTimeoutMs();

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), WITHIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-evidence-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "ok.ts"), "export {}\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function baseConfig(overrides: (c: MasweConfig) => void = () => undefined): MasweConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runtime.kind = "mock";
  c.policy.useIsolatedWorktree = true;
  c.policy.allowedPathGlobs = ["**"];
  c.gates.requireBrainstormApproval = false;
  c.gates.requireDesignApproval = false;
  overrides(c);
  return c;
}

class EditingBuilder implements AgentRuntime {
  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "builder") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
      return {
        status: "finished",
        output: "done\nBUILD_COMPLETE\n",
        requestedModel: request.roleConfig.model,
        actualModel: request.roleConfig.model,
      };
    }
    return new MockRuntime().execute(request);
  }
  doctor(): Promise<RuntimeDoctorResult> {
    return new MockRuntime().doctor();
  }
  listModels(): Promise<string[]> {
    return new MockRuntime().listModels();
  }
}

class EditingBuilderAndResolver extends EditingBuilder {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "prResolver") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(
        path.join(request.cwd, "src", "resolution.ts"),
        "export const resolved = true;\n",
        "utf8",
      );
      return {
        status: "finished",
        output: "resolved\nRESOLUTION_COMPLETE\n",
        requestedModel: request.roleConfig.model,
        actualModel: request.roleConfig.model,
      };
    }
    return super.execute(request);
  }
}

class TrackingRuntime extends EditingBuilder {
  verifierExecutions = 0;

  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "verifier") this.verifierExecutions += 1;
    return super.execute(request);
  }
}

class RetargetAfterArtifactStore extends FileRunStore {
  private retargeted = false;
  private retargetCompletion: Promise<void> | undefined;
  private retargetError: unknown;
  private retargetRunId: string | undefined;
  private readonly artifactName: string;

  constructor(cwd: string, artifactName: string) {
    super(cwd);
    this.artifactName = artifactName;
  }

  override async writeArtifact(
    run: RunRecord,
    name: string,
    content: string,
  ): Promise<ArtifactReference> {
    const reference = await super.writeArtifact(run, name, content);
    if (name === this.artifactName && !this.retargeted) {
      this.retargeted = true;
      this.retargetRunId = run.id;
      const current = await this.load(run.id);
      const claimPublished = deferred();
      this.retargetCompletion = new RevalidationService(this, undefined, {
        mutationFenceOptions: {
          transition: async (event) => {
            if (event === "CLAIM_PUBLISHED") claimPublished.resolve();
          },
        },
      }).route(run.id, {
        source: "github",
        previousHeadSha: current.revalidation!.requestedHeadSha,
        requestedHeadSha: HEAD_C,
        expectedRunVersion: current.version,
        actor: "github-app",
      }).then(
        () => undefined,
        (error: unknown) => {
          this.retargetError = error;
        },
      );
      await within(claimPublished.promise, "artifact-triggered retarget claim");
    }
    return reference;
  }

  async waitForRetarget(): Promise<void> {
    await this.retargetCompletion;
    if (
      this.retargetError instanceof RevalidationOptimisticConflictError &&
      this.retargetRunId
    ) {
      const current = await this.load(this.retargetRunId);
      assert.ok(current.revalidation);
      await new RevalidationService(this).route(this.retargetRunId, {
        source: "github",
        previousHeadSha: current.revalidation.requestedHeadSha,
        requestedHeadSha: HEAD_C,
        expectedRunVersion: current.version,
        actor: "github-app",
      });
      this.retargetError = undefined;
    }
    if (this.retargetError !== undefined) throw this.retargetError;
  }
}

class AssociateHeadOnLoadStore extends FileRunStore {
  private remainingLoads = 0;

  arm(): void {
    this.remainingLoads = 2;
  }

  override async load(runId: string): Promise<RunRecord> {
    if (this.remainingLoads > 0) {
      this.remainingLoads -= 1;
      if (this.remainingLoads === 0) {
        const current = await super.load(runId);
        assert.ok(current.github);
        current.github.headSha = HEAD_C;
        await super.save(current);
        return super.load(runId);
      }
    }
    return super.load(runId);
  }
}

async function prepareActiveRevalidation(
  cwd: string,
  store: FileRunStore,
  state: "CI_RUNNING" | "VERIFYING",
): Promise<{ run: RunRecord; headA: string; headB: string }> {
  const value = baseConfig((c) => {
    c.policy.useIsolatedWorktree = false;
    c.quality.commands = [];
  });
  const run = await store.create("fenced publication", "Publish only current evidence.", value);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  await store.save(run);
  const headA = run.workspace.headSha;

  await writeFile(path.join(cwd, "head-b.txt"), "head B\n", "utf8");
  await execFileAsync("git", ["add", "head-b.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "head B"], { cwd });
  const observed = structuredClone(run);
  await refreshWorkspaceHead(observed);
  const headB = observed.workspace!.headSha;
  let active = await new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha: headA,
    requestedHeadSha: headB,
    expectedRunVersion: run.version,
    actor: "local-runner",
    observedWorkspace: observed.workspace!,
  });

  if (state === "VERIFYING") {
    active.evidence = {
      quality: {
        headSha: headB,
        passed: true,
        at: "2026-08-19T12:00:00.000Z",
      },
    };
    await store.save(active);
    active = await store.applyEvent(active, "CI_PASSED", "quality-runner", {
      passed: true,
      required: true,
      headSha: headB,
    });
  }
  return { run: active, headA, headB };
}

type CurrentHeadGate = "merge-ready" | "complete";

async function prepareCurrentHeadGate(
  t: test.TestContext,
  gate: CurrentHeadGate,
): Promise<{
  cwd: string;
  orchestrator: Orchestrator;
  run: RunRecord;
  headSha: string;
  trackWorktreePath: (worktreePath: string) => void;
}> {
  const cwd = await initRepo();
  const config = baseConfig((candidate) => {
    candidate.quality.commands = [];
  });
  const store = new FileRunStore(cwd);
  let run = await store.create("current-head gate", "accept only current evidence", config);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  const headSha = run.workspace.headSha;
  run.evidence = {
    quality: { headSha, passed: true, at: "2026-08-19T12:00:00.000Z" },
    verification: { headSha, passed: true, at: "2026-08-19T12:01:00.000Z" },
    mergeReady: { headSha, passed: true, at: "2026-08-19T12:02:00.000Z" },
  };
  await store.save(run);
  if (gate === "complete") {
    run = await store.applyEvent(run, "MARK_MERGE_READY", "user", { headSha });
  }
  const worktreePaths = new Set<string>();
  const worktreePath = run.workspace?.worktreePath;
  if (worktreePath) worktreePaths.add(worktreePath);
  t.after(async () => {
    for (const registeredPath of worktreePaths) {
      await execFileAsync("git", ["worktree", "remove", "--force", registeredPath], { cwd }).catch(
        () => undefined,
      );
      await rm(registeredPath, { recursive: true, force: true });
    }
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    orchestrator: new Orchestrator(cwd, config, new MockRuntime(), store),
    run,
    headSha,
    trackWorktreePath: (registeredPath) => worktreePaths.add(registeredPath),
  };
}

function currentHeadGateSnapshot(run: RunRecord): {
  state: RunRecord["state"];
  events: RunRecord["events"];
  evidence: RunRecord["evidence"];
} {
  return structuredClone({
    state: run.state,
    events: run.events,
    evidence: run.evidence,
  });
}

async function rejectCurrentHeadGateWithoutMutation(
  orchestrator: Orchestrator,
  run: RunRecord,
  gate: CurrentHeadGate,
  expected: RegExp,
): Promise<void> {
  const before = currentHeadGateSnapshot(await orchestrator.store.load(run.id));
  const operation = gate === "merge-ready"
    ? orchestrator.markMergeReady(run.id)
    : orchestrator.complete(run.id);
  await assert.rejects(operation, expected);
  const authoritative = await orchestrator.store.load(run.id);
  assert.deepEqual(currentHeadGateSnapshot(authoritative), before);
}

const currentHeadGateCases: Array<{
  name: string;
  expected: RegExp;
  arrange: (fixture: {
    cwd: string;
    orchestrator: Orchestrator;
    run: RunRecord;
    headSha: string;
    trackWorktreePath: (worktreePath: string) => void;
  }) => Promise<void> | void;
}> = [
  {
    name: "unknown recorded HEAD",
    expected: /known.*HEAD|exact.*HEAD|workspace.*HEAD/i,
    arrange: ({ run }) => {
      assert.ok(run.workspace);
      run.workspace.headSha = "not-a-git-repository";
    },
  },
  {
    name: "missing isolated worktree",
    expected: /isolated.*worktree|worktree.*required/i,
    arrange: ({ run }) => {
      assert.ok(run.workspace);
      delete run.workspace.worktreePath;
    },
  },
  {
    name: "alternate registered checkout path",
    expected: /canonical.*worktree|worktree.*canonical/i,
    arrange: async ({ cwd, run, trackWorktreePath }) => {
      assert.ok(run.workspace?.worktreePath);
      const canonicalPath = run.workspace.worktreePath;
      const alternatePath = await mkdtemp(path.join(os.tmpdir(), "maswe-alternate-worktree-"));
      await rm(alternatePath, { recursive: true, force: true });
      trackWorktreePath(alternatePath);
      await execFileAsync("git", ["worktree", "remove", "--force", canonicalPath], { cwd });
      await execFileAsync("git", ["worktree", "add", alternatePath, run.workspace.branch], { cwd });
      run.workspace.worktreePath = alternatePath;
    },
  },
  {
    name: "unregistered canonical path",
    expected: /registered.*worktree|worktree.*registration/i,
    arrange: async ({ cwd, run }) => {
      assert.ok(run.workspace?.worktreePath);
      await execFileAsync("git", ["worktree", "remove", "--force", run.workspace.worktreePath], {
        cwd,
      });
      await mkdir(run.workspace.worktreePath, { recursive: true });
    },
  },
  {
    name: "prunable canonical registration",
    expected: /prunable.*worktree|worktree.*prunable/i,
    arrange: async ({ run }) => {
      assert.ok(run.workspace?.worktreePath);
      await rm(run.workspace.worktreePath, { recursive: true, force: true });
    },
  },
  {
    name: "noncanonical recorded branch",
    expected: /canonical.*branch/i,
    arrange: ({ run }) => {
      assert.ok(run.workspace);
      run.workspace.branch = `maswe/noncanonical-${run.id}`;
    },
  },
  {
    name: "canonical path registered to a conflicting branch",
    expected: /registered.*branch|registration.*branch/i,
    arrange: async ({ cwd, run }) => {
      assert.ok(run.workspace?.worktreePath);
      const canonicalPath = run.workspace.worktreePath;
      const conflictingBranch = `maswe/conflicting-${run.id}`;
      await execFileAsync("git", ["worktree", "remove", "--force", canonicalPath], { cwd });
      await execFileAsync("git", ["branch", conflictingBranch, run.workspace.headSha], { cwd });
      await execFileAsync("git", ["worktree", "add", canonicalPath, conflictingBranch], { cwd });
    },
  },
  {
    name: "registered HEAD conflicts with recorded HEAD",
    expected: /registered.*HEAD|registration.*HEAD/i,
    arrange: async ({ run }) => {
      assert.ok(run.workspace?.worktreePath);
      await execFileAsync("git", ["commit", "--allow-empty", "-qm", "move registered head"], {
        cwd: run.workspace.worktreePath,
      });
    },
  },
  {
    name: "recorded workspace HEAD mismatch",
    expected: /workspace.*HEAD|current.*HEAD|HEAD.*mismatch/i,
    arrange: ({ run }) => {
      assert.ok(run.workspace);
      run.workspace.headSha = HEAD_C;
      run.evidence = {
        quality: { headSha: HEAD_C, passed: true, at: "2026-08-19T12:00:00.000Z" },
        verification: { headSha: HEAD_C, passed: true, at: "2026-08-19T12:01:00.000Z" },
        mergeReady: { headSha: HEAD_C, passed: true, at: "2026-08-19T12:02:00.000Z" },
      };
    },
  },
  {
    name: "dirty worktree",
    expected: /clean.*worktree|worktree.*dirty/i,
    arrange: async ({ run }) => {
      assert.ok(run.workspace?.worktreePath);
      await writeFile(path.join(run.workspace.worktreePath, "dirty.txt"), "dirty\n", "utf8");
    },
  },
  {
    name: "wrong branch",
    expected: /branch/i,
    arrange: async ({ run }) => {
      assert.ok(run.workspace?.worktreePath);
      await execFileAsync("git", ["checkout", "-qb", "maswe/wrong-current-head-gate"], {
        cwd: run.workspace.worktreePath,
      });
    },
  },
  {
    name: "missing quality evidence",
    expected: /quality evidence/i,
    arrange: ({ run }) => {
      assert.ok(run.evidence);
      delete run.evidence.quality;
    },
  },
  {
    name: "failed quality evidence",
    expected: /passing quality evidence|quality evidence/i,
    arrange: ({ run }) => {
      assert.ok(run.evidence?.quality);
      run.evidence.quality.passed = false;
    },
  },
  {
    name: "stale quality evidence",
    expected: /current.*HEAD|quality evidence/i,
    arrange: ({ run }) => {
      assert.ok(run.evidence?.quality);
      run.evidence.quality.headSha = HEAD_C;
    },
  },
  {
    name: "missing verification evidence",
    expected: /verification evidence/i,
    arrange: ({ run }) => {
      assert.ok(run.evidence);
      delete run.evidence.verification;
    },
  },
  {
    name: "failed verification evidence",
    expected: /passing verification evidence|verification evidence/i,
    arrange: ({ run }) => {
      assert.ok(run.evidence?.verification);
      run.evidence.verification.passed = false;
    },
  },
  {
    name: "stale verification evidence",
    expected: /current.*HEAD|verification evidence/i,
    arrange: ({ run }) => {
      assert.ok(run.evidence?.verification);
      run.evidence.verification.headSha = HEAD_C;
    },
  },
];

for (const gate of ["merge-ready", "complete"] as const) {
  test(`${gate} rejects every non-current gate input without state, event, or evidence mutation`, async (t) => {
    for (const rejection of currentHeadGateCases) {
      await t.test(rejection.name, async (subtest) => {
        const fixture = await prepareCurrentHeadGate(subtest, gate);
        await rejection.arrange(fixture);
        await fixture.orchestrator.store.save(fixture.run);
        const authoritative = await fixture.orchestrator.store.load(fixture.run.id);
        await rejectCurrentHeadGateWithoutMutation(
          fixture.orchestrator,
          authoritative,
          gate,
          rejection.expected,
        );
      });
    }
  });
}

for (const gate of ["merge-ready", "complete"] as const) {
  test(`${gate} routes an associated GitHub HEAD mismatch before final-gate publication`, async (t) => {
    const fixture = await prepareCurrentHeadGate(t, gate);
    assert.ok(fixture.run.workspace);
    fixture.run.github = {
      installationId: 28,
      repository: "owner/repo",
      pullRequestNumber: 28,
      baseSha: fixture.run.workspace.baseSha,
      headSha: HEAD_C,
      branch: fixture.run.workspace.branch,
      suspended: false,
    };
    await fixture.orchestrator.store.save(fixture.run);
    const before = await fixture.orchestrator.store.load(fixture.run.id);

    await assert.rejects(
      gate === "merge-ready"
        ? fixture.orchestrator.markMergeReady(fixture.run.id)
        : fixture.orchestrator.complete(fixture.run.id),
      /revalidation|complete requires MERGE_READY/i,
    );

    const authoritative = await fixture.orchestrator.store.load(fixture.run.id);
    assert.equal(authoritative.state, "CI_RUNNING");
    assert.equal(authoritative.evidence, undefined);
    assert.equal(authoritative.github?.headSha, HEAD_C);
    assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
    assert.equal(authoritative.revalidation?.returnState, "PR_READY");
    assert.equal(authoritative.revalidation?.generation, 1);
    assert.equal(
      authoritative.events.filter((event) => event.type === "REVALIDATE_REQUESTED").length,
      1,
    );
    assert.equal(
      authoritative.events.filter((event) => event.type === "MARK_MERGE_READY").length,
      before.events.filter((event) => event.type === "MARK_MERGE_READY").length,
    );
    assert.equal(authoritative.events.some((event) => event.type === "COMPLETE"), false);
  });
}

test("complete starts same-target recovery when association movement erased current evidence", async (t) => {
  const fixture = await prepareCurrentHeadGate(t, "complete");
  assert.ok(fixture.run.workspace);
  fixture.run.github = {
    installationId: 28,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: fixture.run.workspace.baseSha,
    headSha: fixture.headSha,
    branch: fixture.run.workspace.branch,
    suspended: false,
    pendingCancellationHeadShas: [HEAD_C],
  };
  delete fixture.run.evidence;
  await fixture.orchestrator.store.save(fixture.run);
  const before = await fixture.orchestrator.store.load(fixture.run.id);

  await assert.rejects(
    fixture.orchestrator.complete(fixture.run.id),
    /revalidation|complete requires MERGE_READY/i,
  );

  const authoritative = await fixture.orchestrator.store.load(fixture.run.id);
  assert.equal(authoritative.state, "CI_RUNNING");
  assert.equal(authoritative.github?.headSha, fixture.headSha);
  assert.equal(authoritative.workspace?.headSha, fixture.headSha);
  assert.equal(authoritative.revalidation?.originHeadSha, fixture.headSha);
  assert.equal(authoritative.revalidation?.requestedHeadSha, fixture.headSha);
  assert.equal(authoritative.revalidation?.returnState, "PR_READY");
  assert.equal(authoritative.revalidation?.generation, 1);
  assert.equal(
    authoritative.events.filter((event) => event.type === "REVALIDATE_REQUESTED").length,
    1,
  );
  assert.equal(
    authoritative.events.filter((event) => event.type === "MARK_MERGE_READY").length,
    before.events.filter((event) => event.type === "MARK_MERGE_READY").length,
  );
  assert.equal(authoritative.events.some((event) => event.type === "COMPLETE"), false);
});

for (const mergeReadyCase of ["missing", "failed", "stale", "historical-only"] as const) {
  test(`complete rejects ${mergeReadyCase} merge-ready evidence without mutation`, async (t) => {
    const fixture = await prepareCurrentHeadGate(t, "complete");
    assert.ok(fixture.run.evidence?.mergeReady);
    if (mergeReadyCase === "missing" || mergeReadyCase === "historical-only") {
      delete fixture.run.evidence.mergeReady;
    } else if (mergeReadyCase === "failed") {
      fixture.run.evidence.mergeReady.passed = false;
    } else {
      fixture.run.evidence.mergeReady.headSha = HEAD_C;
    }
    if (mergeReadyCase !== "historical-only") {
      fixture.run.events = fixture.run.events.filter((event) => event.type !== "MARK_MERGE_READY");
    }
    await fixture.orchestrator.store.save(fixture.run);
    const authoritative = await fixture.orchestrator.store.load(fixture.run.id);
    await rejectCurrentHeadGateWithoutMutation(
      fixture.orchestrator,
      authoritative,
      "complete",
      /current.*merge-ready|merge-ready evidence/i,
    );
  });
}

test("merge-ready and completion events use the exact current HEAD returned by the gate", async (t) => {
  const fixture = await prepareCurrentHeadGate(t, "merge-ready");
  const mergeReady = await fixture.orchestrator.markMergeReady(fixture.run.id);
  assert.equal(mergeReady.events.at(-1)?.details?.headSha, fixture.headSha);
  const completed = await fixture.orchestrator.complete(mergeReady.id);
  assert.equal(completed.events.at(-1)?.details?.headSha, fixture.headSha);
  assert.equal(completed.events.at(-1)?.details?.mergeReadySha, fixture.headSha);
});

for (const gate of ["merge-ready", "complete"] as const) {
  test(`${gate} unconditionally requires current passing final evidence when pre-PR pass flags are false`, async (t) => {
    for (const evidenceCase of ["missing", "failed", "stale", "passing"] as const) {
      await t.test(evidenceCase, async (subtest) => {
        const fixture = await prepareCurrentHeadGate(subtest, gate);
        fixture.run.config.gates.requireCiPass = false;
        fixture.run.config.gates.requireVerifierPass = false;
        assert.ok(fixture.run.evidence);
        if (evidenceCase === "missing") {
          delete fixture.run.evidence.quality;
          delete fixture.run.evidence.verification;
        } else if (evidenceCase === "failed") {
          fixture.run.evidence.quality = {
            headSha: fixture.headSha,
            passed: false,
            at: "2026-08-19T12:03:00.000Z",
          };
          fixture.run.evidence.verification = {
            headSha: fixture.headSha,
            passed: false,
            at: "2026-08-19T12:04:00.000Z",
          };
        } else if (evidenceCase === "stale") {
          fixture.run.evidence.quality = {
            headSha: HEAD_C,
            passed: true,
            at: "2026-08-19T12:03:00.000Z",
          };
          fixture.run.evidence.verification = {
            headSha: HEAD_C,
            passed: true,
            at: "2026-08-19T12:04:00.000Z",
          };
        }
        await fixture.orchestrator.store.save(fixture.run);
        const before = await fixture.orchestrator.store.load(fixture.run.id);

        if (evidenceCase === "passing") {
          const accepted = gate === "merge-ready"
            ? await fixture.orchestrator.markMergeReady(fixture.run.id)
            : await fixture.orchestrator.complete(fixture.run.id);
          assert.equal(accepted.state, gate === "merge-ready" ? "MERGE_READY" : "COMPLETED");
          return;
        }

        await assert.rejects(
          gate === "merge-ready"
            ? fixture.orchestrator.markMergeReady(fixture.run.id)
            : fixture.orchestrator.complete(fixture.run.id),
          /quality evidence|verification evidence/i,
        );
        assert.deepEqual(await fixture.orchestrator.store.load(fixture.run.id), before);
      });
    }
  });
}

for (const stage of ["builder", "resolver", "quality", "verifier"] as const) {
  test(`${stage} final publication fence rejects HEAD movement after the prior last check`, async (t) => {
    const cwd = await initRepo();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const config = baseConfig((candidate) => {
      candidate.policy.useIsolatedWorktree = false;
      candidate.quality.commands = [];
    });
    const store = new FileRunStore(cwd);
    const run = await store.create(
      `${stage} final Git fence`,
      "Do not publish evaluated state for a superseded HEAD.",
      config,
    );
    run.state = stage === "builder"
      ? "BUILDING"
      : stage === "resolver"
        ? "RESOLVING"
        : stage === "quality"
          ? "CI_RUNNING"
          : "VERIFYING";
    run.workspace = await ensureRunWorkspace(cwd, run);
    const oldHeadSha = run.workspace.headSha;
    assert.equal(typeof oldHeadSha, "string");
    run.evidence = {
      quality: {
        headSha: oldHeadSha,
        passed: true,
        at: "2026-08-19T13:00:00.000Z",
      },
      verification: {
        headSha: oldHeadSha,
        passed: true,
        at: "2026-08-19T13:01:00.000Z",
      },
    };
    await store.save(run);
    const before = await store.load(run.id);
    let movedHeadSha: string | undefined;
    const orchestrator = new Orchestrator(
      cwd,
      config,
      stage === "resolver" ? new EditingBuilderAndResolver() : new EditingBuilder(),
      store,
      {
        afterRunMutationReload: async (phase: string) => {
          if (phase !== stage) return;
          await execFileAsync("git", ["commit", "--allow-empty", "-qm", `${stage} operator move`], {
            cwd,
          });
          movedHeadSha = (
            await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
          ).stdout.trim();
        },
      },
    );

    await orchestrator.advance(run.id);
    const authoritative = await store.load(run.id);
    assert.equal(typeof movedHeadSha, "string");
    assert.equal(
      (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(),
      movedHeadSha,
    );
    assert.equal(authoritative.state, "FAILED");
    assert.equal(authoritative.workspace?.headSha, movedHeadSha);
    assert.equal(authoritative.evidence, undefined);
    const staleSuccessTypes = new Set<string>(
      stage === "builder"
        ? ["BUILD_COMPLETED"]
        : stage === "resolver"
          ? ["RESOLUTION_COMPLETED"]
          : stage === "quality"
            ? ["CI_PASSED", "CI_FAILED"]
            : ["VERIFY_PASSED", "VERIFY_PASSED_AFTER_REVIEW", "VERIFY_FAILED"],
    );
    const newEvents = authoritative.events.slice(before.events.length);
    assert.equal(
      newEvents.some((event) => staleSuccessTypes.has(event.type)),
      false,
    );
    assert.equal(
      newEvents.some((event) => event.details?.headSha === oldHeadSha),
      false,
    );
  });
}

for (const gate of ["merge-ready", "complete"] as const) {
  test(`${gate} final publication fence rejects HEAD movement before authoritative publication`, async (t) => {
    const fixture = await prepareCurrentHeadGate(t, gate);
    const workdir = fixture.run.workspace?.worktreePath;
    assert.equal(typeof workdir, "string");
    const before = await fixture.orchestrator.store.load(fixture.run.id);
    let movedHeadSha: string | undefined;
    const fenced = new Orchestrator(
      fixture.cwd,
      fixture.run.config,
      new MockRuntime(),
      fixture.orchestrator.store,
      {
        afterRunMutationReload: async (phase: string) => {
          if (phase !== gate) return;
          await execFileAsync("git", ["commit", "--allow-empty", "-qm", `${gate} operator move`], {
            cwd: workdir,
          });
          movedHeadSha = (
            await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workdir })
          ).stdout.trim();
        },
      },
    );

    await assert.rejects(
      gate === "merge-ready"
        ? fenced.markMergeReady(fixture.run.id)
        : fenced.complete(fixture.run.id),
      /HEAD|current|registered/i,
    );
    const authoritative = await fixture.orchestrator.store.load(fixture.run.id);
    assert.equal(typeof movedHeadSha, "string");
    assert.notEqual(movedHeadSha, before.workspace?.headSha);
    assert.deepEqual(authoritative, before);
    assert.ok(
      Object.values(authoritative.evidence ?? {}).every(
        (binding) => binding.headSha !== movedHeadSha,
      ),
      "historical evidence must not be represented as current for the moved HEAD",
    );
    assert.equal(
      authoritative.events.slice(before.events.length).some(
        (event) => event.type === "MARK_MERGE_READY" || event.type === "COMPLETE",
      ),
      false,
    );
  });
}

test("quality command that edits a tracked file fails closed before verifier", async () => {
  const cwd = await initRepo();
  const config = baseConfig((c) => {
    c.quality.commands = [
      `node -e "require('fs').writeFileSync('src/ok.ts', 'export const dirty = 1\\n')"`,
    ];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder());
  const run = await orchestrator.start("Dirty CI", "Quality must not dirty tree.");
  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /clean worktree|dirty/i);
  assert.equal(run.events.some((e) => e.type === "VERIFY_PASSED"), false);
});

test("quality command that creates a commit invalidates and fails before verifier", async () => {
  const cwd = await initRepo();
  const store = new FileRunStore(cwd);
  const config = baseConfig((c) => {
    c.quality.commands = [
      `node -e "require('fs').writeFileSync('src/ok.ts','export const y=1\\n'); require('child_process').execFileSync('git',['add','src/ok.ts']); require('child_process').execFileSync('git',['commit','-qm','ci commit'])"`,
    ];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder(), store);
  await assert.rejects(
    () => orchestrator.start("CI commit", "Quality must not commit."),
    (error: unknown) =>
      error instanceof TerminalCleanupError &&
      error.code === "cleanup-ownership-mismatch",
  );
  const runs = await store.list();
  assert.equal(runs.length, 1);
  const run = await store.load(runs[0]!.id);
  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /clean worktree|HEAD moved|dirty|commit/i);
  assert.equal(run.events.some((e) => e.type === "VERIFY_PASSED"), false);
  assert.equal(run.terminalCleanup?.status, "failed");
  assert.equal(
    run.terminalCleanup?.lastError?.code,
    "cleanup-ownership-mismatch",
  );
  assert.equal(
    run.events.filter((event) => event.type === "FAIL").length,
    1,
  );
});

test("HEAD change between CI and verifier fails closed", async () => {
  const cwd = await initRepo();
  const config = baseConfig((c) => {
    c.quality.commands = [];
  });

  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder());
  const run = await orchestrator.store.create(
    "HEAD move",
    "Verifier must see clean fresh SHA.",
    config,
  );
  run.workspace = await ensureRunWorkspace(cwd, run);
  await orchestrator.store.save(run);
  await orchestrator.store.applyEvent(run, "START", "user");

  let current = run;
  for (let i = 0; i < 20 && current.state !== "VERIFYING" && current.state !== "FAILED"; i += 1) {
    const before = current.state;
    current = await orchestrator.advance(current.id);
    if (before === "CI_RUNNING" && current.state === "VERIFYING") break;
  }
  assert.equal(current.state, "VERIFYING");

  const workdir = current.workspace?.worktreePath ?? cwd;
  await writeFile(path.join(workdir, "src", "ok.ts"), "export const z = 1;\n", "utf8");
  await execFileAsync("git", ["add", "src/ok.ts"], { cwd: workdir });
  await execFileAsync("git", ["commit", "-qm", "sneaky"], { cwd: workdir });

  current = await orchestrator.advance(current.id);
  assert.equal(current.state, "FAILED");
  assert.match(
    current.failure?.message ?? "",
    /clean worktree|stale|HEAD|quality evidence|fresh/i,
  );
});

test("initial revalidation invalidates every stale evidence binding", async () => {
  const cwd = await initRepo();
  const store = new FileRunStore(cwd);
  const run = await store.create("stale evidence", "revalidate a newer head", baseConfig());
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  const previousHeadSha = run.workspace.headSha;
  run.evidence = {
    quality: { headSha: previousHeadSha, passed: true, at: "2026-08-18T12:00:00.000Z" },
    verification: { headSha: previousHeadSha, passed: true, at: "2026-08-18T12:00:00.000Z" },
    mergeReady: { headSha: previousHeadSha, passed: true, at: "2026-08-18T12:00:00.000Z" },
  };
  await store.save(run);

  const routed = await new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha,
    requestedHeadSha: "b".repeat(40),
    expectedRunVersion: run.version,
    actor: "local-runner",
    at: "2026-08-18T12:01:00.000Z",
  });

  assert.equal(routed.evidence, undefined);
  assert.equal((await store.load(run.id)).evidence, undefined);
});

test("an associated target mismatch fails before work and an exact operator alignment retries", async (t) => {
  const cwd = await initRepo();
  const config = baseConfig((c) => {
    c.quality.commands = [];
  });
  const runtime = new TrackingRuntime();
  const orchestrator = new Orchestrator(cwd, config, runtime);
  let run = await orchestrator.start("Associated revalidation", "Verify only the associated HEAD.");
  assert.equal(run.state, "PR_READY");
  assert.equal(runtime.verifierExecutions, 1);
  const headB = run.workspace?.headSha;
  const worktreePath = run.workspace?.worktreePath;
  const branch = run.workspace?.branch;
  assert.ok(typeof headB === "string", "old HEAD must be an explicit string fixture");
  assert.ok(worktreePath && branch);
  t.after(async () => {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd }).catch(
      () => undefined,
    );
    await rm(cwd, { recursive: true, force: true });
  });

  const { stdout: treeOutput } = await execFileAsync(
    "git",
    ["rev-parse", `${headB}^{tree}`],
    { cwd },
  );
  const { stdout: headOutput } = await execFileAsync(
    "git",
    ["commit-tree", treeOutput.trim(), "-p", headB, "-m", "associated head C"],
    { cwd },
  );
  const headC = headOutput.trim();
  run.github = {
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: run.workspace!.baseSha,
    headSha: headC,
    branch: run.workspace!.branch,
  };
  await orchestrator.store.save(run);
  await new RevalidationService(orchestrator.store).route(run.id, {
    source: "github",
    previousHeadSha: headB,
    requestedHeadSha: headC,
    expectedRunVersion: run.version,
    actor: "github-app",
  });

  await orchestrator.advance(run.id);
  let authoritative = await orchestrator.store.load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CI_RUNNING");
  assert.match(authoritative.failure?.message ?? "", /workspace.*HEAD|target.*workspace|alignment/i);
  assert.equal(runtime.verifierExecutions, 1);
  assert.equal(
    authoritative.artifacts.filter(
      (artifact) => artifact.logicalName === "05-quality-report.md",
    ).length,
    1,
  );

  await execFileAsync("git", ["update-ref", `refs/heads/${branch}`, headC, headB], { cwd });
  await new Orchestrator(cwd, config, runtime, orchestrator.store).retryFromFailed(run.id);
  authoritative = await orchestrator.store.load(run.id);

  assert.equal(authoritative.state, "PR_READY");
  assert.equal(authoritative.workspace?.headSha, headC);
  assert.equal(authoritative.evidence?.quality?.headSha, headC);
  assert.equal(authoritative.evidence?.verification?.headSha, headC);
  assert.equal(authoritative.revalidation, undefined);
  assert.equal(runtime.verifierExecutions, 2);
});

test("active preflight retries an association update injected at the routing load and publishes no stale evidence", async (t) => {
  const cwd = await initRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new AssociateHeadOnLoadStore(cwd);
  const { run, headA, headB } = await prepareActiveRevalidation(cwd, store, "CI_RUNNING");
  run.github = {
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: headA,
    headSha: headB,
    branch: run.workspace!.branch,
  };
  await store.save(run);
  const historicalEvents = structuredClone(run.events);
  store.arm();

  await new Orchestrator(cwd, run.config, new MockRuntime(), store).advance(run.id);
  const authoritative = await store.load(run.id);

  assert.deepEqual(authoritative.events.slice(0, historicalEvents.length), historicalEvents);
  assert.equal(authoritative.github?.headSha, HEAD_C);
  assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(authoritative.revalidation?.generation, 2);
  assert.equal(authoritative.evidence?.quality, undefined);
  assert.equal(
    authoritative.events.some(
      (event) =>
        (event.type === "CI_PASSED" || event.type === "CI_FAILED") &&
        event.details?.headSha === headB,
    ),
    false,
  );
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CI_RUNNING");
});

test("a concurrent retarget discards a speculative builder generation", async (t) => {
  const cwd = await initRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = baseConfig((c) => {
    c.policy.useIsolatedWorktree = false;
    c.quality.commands = [];
  });
  const store = new RetargetAfterArtifactStore(cwd, "04-builder-report.md");
  const run = await store.create("fenced builder", "Do not commit stale work.", config);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  await store.save(run);
  const previousHeadSha = run.workspace.headSha;

  await writeFile(path.join(cwd, "new-head.txt"), "head B\n", "utf8");
  await execFileAsync("git", ["add", "new-head.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "head B"], { cwd });
  const observed = structuredClone(run);
  await refreshWorkspaceHead(observed);
  const headB = observed.workspace!.headSha;
  await new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha,
    requestedHeadSha: headB,
    expectedRunVersion: run.version,
    actor: "local-runner",
    observedWorkspace: observed.workspace!,
  });
  const active = await store.load(run.id);
  await store.applyEvent(active, "CI_FAILED", "quality-runner", {
    passed: false,
    required: true,
    headSha: headB,
  });

  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder(), store);
  await assert.rejects(
    orchestrator.advance(run.id),
    (error: unknown) => error instanceof RunMutationSupersededError,
  );
  await store.waitForRetarget();
  const authoritative = await store.load(run.id);
  const { stdout: actualHeadOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });

  assert.equal(authoritative.state, "CI_RUNNING");
  assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(authoritative.revalidation?.generation, 2);
  assert.equal(actualHeadOutput.trim(), headB);
  assert.equal(
    authoritative.events.some((event) => event.type === "BUILD_COMPLETED"),
    false,
  );
  assert.equal(
    authoritative.artifacts.filter(
      (artifact) => artifact.logicalName === "04-builder-report.md",
    ).length,
    1,
  );
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  assert.equal(status, "");
});

test("a queued C retarget supersedes a speculative builder generation", async (t) => {
  const cwd = await initRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = baseConfig((c) => {
    c.policy.useIsolatedWorktree = false;
    c.quality.commands = [];
  });
  const store = new FileRunStore(cwd);
  const run = await store.create("durable builder fence", "C supersedes B.", config);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  await store.save(run);
  const headA = run.workspace.headSha;

  await writeFile(path.join(cwd, "head-b.txt"), "head B\n", "utf8");
  await execFileAsync("git", ["add", "head-b.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "head B"], { cwd });
  const observed = structuredClone(run);
  await refreshWorkspaceHead(observed);
  const headB = observed.workspace!.headSha;
  const routed = await new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha: headA,
    requestedHeadSha: headB,
    expectedRunVersion: run.version,
    actor: "local-runner",
    observedWorkspace: observed.workspace!,
  });
  await store.applyEvent(routed, "CI_FAILED", "quality-runner", {
    passed: false,
    required: true,
    headSha: headB,
  });
  const beforeBuilder = await store.load(run.id);
  const historicalEvents = structuredClone(beforeBuilder.events);

  const finalReload = deferred();
  const releaseBuilder = deferred();
  const cClaimPublished = deferred();
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder(), store, {
    afterRunMutationReload: async (phase) => {
      if (phase !== "builder") return;
      finalReload.resolve();
      await releaseBuilder.promise;
    },
  });
  const builder = orchestrator.advance(run.id);
  await within(finalReload.promise, "builder final generation reload");
  const beforeRetarget = await store.load(run.id);

  const cRoute = new RevalidationService(store, undefined, {
    mutationFenceOptions: {
      transition: async (event: string) => {
        if (event === "CLAIM_PUBLISHED") cClaimPublished.resolve();
      },
    },
  }).route(run.id, {
    source: "github",
    previousHeadSha: headB,
    requestedHeadSha: HEAD_C,
    expectedRunVersion: beforeRetarget.version,
    actor: "github-app",
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await within(cClaimPublished.promise, "C target claim publication");
  releaseBuilder.resolve();

  await assert.rejects(
    builder,
    (error: unknown) => error instanceof RunMutationSupersededError,
  );
  const firstRoute = await cRoute;
  assert.ok("value" in firstRoute);
  const authoritative = firstRoute.value;
  const { stdout: actualHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  assert.equal(actualHead.trim(), headB);
  assert.deepEqual(authoritative.events.slice(0, historicalEvents.length), historicalEvents);
  assert.equal(authoritative.events.some((event) => event.type === "BUILD_COMPLETED"), false);
  assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(authoritative.revalidation?.generation, 2);
  assert.equal(authoritative.evidence, undefined);
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  assert.equal(status, "", "the builder-owned generation must publish from a clean worktree");
});

test("a queued C retarget after the final verifier reload preserves C context and blocks B evidence", async (t) => {
  const cwd = await initRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const { run, headB } = await prepareActiveRevalidation(cwd, store, "VERIFYING");
  const historicalEvents = structuredClone(run.events);
  const finalReload = deferred();
  const releaseVerifier = deferred();
  const cClaimPublished = deferred();
  const orchestrator = new Orchestrator(cwd, run.config, new MockRuntime(), store, {
    afterRunMutationReload: async (phase) => {
      if (phase !== "verifier") return;
      finalReload.resolve();
      await releaseVerifier.promise;
    },
  });
  const verifier = orchestrator.advance(run.id);
  await within(finalReload.promise, "verifier final generation reload");
  const beforeRetarget = await store.load(run.id);
  const cRoute = new RevalidationService(store, undefined, {
    mutationFenceOptions: {
      transition: async (event: string) => {
        if (event === "CLAIM_PUBLISHED") cClaimPublished.resolve();
      },
    },
  }).route(run.id, {
    source: "github",
    previousHeadSha: headB,
    requestedHeadSha: HEAD_C,
    expectedRunVersion: beforeRetarget.version,
    actor: "github-app",
  });
  await within(cClaimPublished.promise, "C target claim publication");
  releaseVerifier.resolve();

  await assert.rejects(verifier, /superseded.*target|target.*superseded/i);
  await cRoute;
  const authoritative = await store.load(run.id);
  assert.deepEqual(authoritative.events.slice(0, historicalEvents.length), historicalEvents);
  assert.equal(authoritative.events.some((event) => event.type.startsWith("VERIFY_")), false);
  assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(authoritative.revalidation?.generation, 2);
  assert.equal(authoritative.evidence?.verification, undefined);
});

test("a quality artifact cannot publish stale evidence or an event after a concurrent retarget", async (t) => {
  const cwd = await initRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new RetargetAfterArtifactStore(cwd, "05-quality-report.md");
  const { run, headB } = await prepareActiveRevalidation(cwd, store, "CI_RUNNING");
  const historicalEvents = structuredClone(run.events);

  await assert.rejects(
    new Orchestrator(cwd, run.config, new MockRuntime(), store).advance(run.id),
    RunMutationSupersededError,
  );
  await store.waitForRetarget();
  const authoritative = await store.load(run.id);

  assert.deepEqual(authoritative.events.slice(0, historicalEvents.length), historicalEvents);
  assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(authoritative.revalidation?.generation, 2);
  assert.equal(authoritative.evidence?.quality, undefined);
  assert.equal(
    authoritative.events.some(
      (event) =>
        (event.type === "CI_PASSED" || event.type === "CI_FAILED") &&
        event.details?.headSha === headB,
    ),
    false,
  );
});

test("a verifier artifact cannot publish stale evidence or clear the newer context", async (t) => {
  const cwd = await initRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new RetargetAfterArtifactStore(cwd, "06-verification-report.md");
  const { run, headB } = await prepareActiveRevalidation(cwd, store, "VERIFYING");
  const historicalEvents = structuredClone(run.events);

  await assert.rejects(
    new Orchestrator(cwd, run.config, new MockRuntime(), store).advance(run.id),
    RunMutationSupersededError,
  );
  await store.waitForRetarget();
  const authoritative = await store.load(run.id);

  assert.deepEqual(authoritative.events.slice(0, historicalEvents.length), historicalEvents);
  assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(authoritative.revalidation?.generation, 2);
  assert.equal(authoritative.evidence?.verification, undefined);
  assert.equal(
    authoritative.events.some(
      (event) =>
        (event.type === "VERIFY_PASSED" || event.type === "VERIFY_PASSED_AFTER_REVIEW") &&
        event.details?.headSha === headB,
    ),
    false,
  );
});
