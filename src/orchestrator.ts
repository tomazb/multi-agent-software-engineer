import type {
  AgentRuntime,
  DurableRuntimeFailureAttempt,
  DurableRuntimeFailureSummary,
  PermissionMode,
  RoleId,
  RunFailureCode,
  RunRecord,
  RunTerminalCleanup,
  RuntimeFinishedResult,
  TerminalCleanupPreservationReason,
  WorkflowState,
} from "./domain.ts";
import { buildCommentClassifierPrompt, buildRolePrompt } from "./prompt-builder.ts";
import {
  captureWorkspaceSourceFingerprint,
  gitRevParse,
  gitRun,
  gitWorkspaceFingerprint,
  isGitRepository,
  isGitWorkspaceClean,
} from "./git-snapshot.ts";
import {
  assertChangeScope,
  assertExpectedBranch,
  assertWorkingTreeScope,
  createDeterministicCommit,
  externalWorktreePath,
  invalidateStaleEvidence,
  listGitWorktreeRegistrations,
  reconcileTerminalWorktreeCleanup,
  refreshWorkspaceHead,
  workingDirectoryFor,
  TerminalCleanupError,
  type TerminalCleanupDependencies,
  type TerminalCleanupPathState,
} from "./git-workspace.ts";
import { parseRoleMarker } from "./markers.ts";
import {
  resolveProjectModels,
  validatePersistedExactModel,
} from "./model-resolution.ts";
import { renderQualityReport, runQualityChecks } from "./quality.ts";
import { isHumanGate, isTerminal } from "./state-machine.ts";
import { FileRunStore, type RunStore } from "./store.ts";
import {
  assertRevalidationFence,
  captureRevalidationFence,
  hasEnteredPullRequestReview,
  requiresSameTargetEvidenceRecovery,
  RevalidationOptimisticConflictError,
  RevalidationService,
  type RevalidationFence,
} from "./revalidation.ts";
import {
  assertBootstrapWorkspaceReady,
  captureWorkspaceBootstrapIntent,
  reconcileBootstrapWorkspace,
  reconcileRetryWorkspace,
  type WorkspaceBootstrapHooks,
} from "./workspace-bootstrap.ts";
import type { MasweConfig } from "./domain.ts";
import {
  appendFailureAggregate,
  assertRuntimeIdentity,
  DURABLE_RUNTIME_FAILURE_ATTEMPT_LIMIT,
  ensureRuntimeSuccess,
  makeDurableRuntimeFailureSummary,
  reportOmittedFailureAttempts,
  runFailureCode,
  runFailureDetails,
  runFailureMessage,
  runFailureRuntime,
  RuntimeModelsExhaustedError,
  runtimeEventIdentityDetails,
  runtimeAttemptFailure,
  safeFailureMessage,
} from "./failure-diagnostics.ts";
import path from "node:path";
import os from "node:os";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { spawnCaptured } from "./process.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";
import {
  RunMutationSupersededError,
  withRunMutationFence,
  type RunMutationLease,
} from "./run-mutation.ts";
import {
  findPolicyViolationError,
  PolicyViolationError,
  resolveExecutionPermission,
} from "./policy.ts";

interface ReadOnlyExecutionState {
  fingerprint: string;
  head?: string;
}

async function captureReadOnlyExecutionState(
  workdir: string,
): Promise<ReadOnlyExecutionState> {
  const fingerprint = await gitWorkspaceFingerprint(workdir);
  const git = await isGitRepository(workdir);
  const head = git ? await gitRevParse(workdir, "HEAD") : undefined;
  return { fingerprint, ...(head !== undefined ? { head } : {}) };
}

async function assertReadOnlyExecutionState(
  workdir: string,
  role: RoleId,
  before: ReadOnlyExecutionState,
): Promise<void> {
  let afterHead: string | undefined;
  if (before.head !== undefined) {
    try {
      afterHead = await gitRevParse(workdir, "HEAD");
    } catch (error) {
      throw new PolicyViolationError(
        "policy-read-only-head-moved",
        `${role} changed HEAD during read-only execution.`,
        { cause: error },
      );
    }
  }
  if (before.head !== undefined && afterHead !== before.head) {
    throw new PolicyViolationError(
      "policy-read-only-head-moved",
      `${role} changed HEAD during read-only execution.`,
    );
  }
  const afterFingerprint = await gitWorkspaceFingerprint(workdir);
  if (afterFingerprint !== before.fingerprint) {
    throw new PolicyViolationError(
      "policy-read-only-workspace-mutation",
      `${role} modified the workspace during read-only execution.`,
    );
  }
}

class RolePublicationOutcomeUnknownError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "RolePublicationOutcomeUnknownError";
  }
}

function requiresWorkspacePreservation(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof RolePublicationOutcomeUnknownError) return true;
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) {
      pending.push(candidate.cause);
    }
  }
  return false;
}

function terminalCleanupIntent(
  run: RunRecord,
  preservationReason?: TerminalCleanupPreservationReason,
): RunTerminalCleanup {
  const updatedAt = new Date().toISOString();
  if (!run.config.policy.useIsolatedWorktree || !run.workspace?.worktreePath) {
    return { status: "complete", updatedAt };
  }
  if (preservationReason) {
    return { status: "preserved", updatedAt, preservationReason };
  }
  return { status: "pending", updatedAt };
}

function attachTerminalCleanupIntent(
  run: RunRecord,
  preservationReason?: TerminalCleanupPreservationReason,
): void {
  run.terminalCleanup = terminalCleanupIntent(run, preservationReason);
}

function failRunPreservationReason(
  run: RunRecord,
  error: unknown,
): TerminalCleanupPreservationReason | undefined {
  if (run.revalidation !== undefined) return "revalidation-recovery";
  if (requiresWorkspacePreservation(error)) return "publication-outcome-unknown";
  return undefined;
}

function optionalFailRunPreservation(
  run: RunRecord,
  error: unknown,
): { preservationReason?: TerminalCleanupPreservationReason } {
  const preservationReason = failRunPreservationReason(run, error);
  return preservationReason ? { preservationReason } : {};
}

function isCanonicalFileStoreTimestamp(value: string): boolean {
  if (value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function areCanonicalFileStoreTimestamps(
  ...values: Array<string | undefined>
): boolean {
  return values.every(
    (value) => value === undefined || isCanonicalFileStoreTimestamp(value),
  );
}

export function extractVerifierDefects(report: string): string {
  const lines = report.split(/\r?\n/);
  const defects: string[] = [];
  for (const line of lines) {
    if (/^\s*([-*]|\d+\.)\s+/.test(line) || /\b(FAIL|BLOCK|DEFECT|FINDING)\b/i.test(line)) {
      defects.push(line.trim());
    }
  }
  if (defects.length === 0) {
    return [
      "# Verifier defects",
      "",
      "Verifier returned VERDICT: FAIL without a structured defect list.",
      "Review the full verification report and address blocking findings.",
      "",
      report.trim(),
      "",
    ].join("\n");
  }
  return ["# Verifier defects", "", ...defects.map((line) => `- ${line}`), ""].join("\n");
}

export interface OrchestratorOptions {
  /** Test-only seam for exercising bounded automatic workflow transitions. */
  automaticTransitionLimit?: number;
  /** Test seam immediately after durable bootstrap intent publication. */
  beforeBootstrapReconcile?: (run: RunRecord) => Promise<void>;
  /** Failure barriers around deterministic branch/worktree reconciliation. */
  bootstrapHooks?: WorkspaceBootstrapHooks;
  /** Failure barrier after the CREATED workspace checkpoint has been reloaded. */
  afterWorkspaceCheckpoint?: (run: RunRecord) => Promise<void>;
  /** Test seam immediately before the single retry event publication. */
  beforeRetryPublication?: (candidate: RunRecord) => Promise<void>;
  /** Deterministic barrier after final authority reload under the mutation fence. */
  afterRunMutationReload?: (
    phase: "builder" | "resolver" | "quality" | "verifier" | "merge-ready" | "complete",
    authoritative: RunRecord,
  ) => Promise<void>;
  /** Failure seam after a dirty baseline receives a speculative mutable-role delta. */
  afterDirtyRoleDeltaApplied?: () => Promise<void>;
  /** Deterministic barrier immediately before mutable-role ref publication. */
  beforeRoleRefPublish?: () => Promise<void>;
  /** Deterministic barrier after speculative cleanup and before authoritative publication checks. */
  afterSpeculativeRoleCleanupBeforePublication?: () => Promise<void>;
  /** Deterministic barrier before reversing a rejected mutable-role publication. */
  beforeRoleFailureRollback?: () => Promise<void>;
  /** Deterministic barrier after rollback safety observation and before failure propagation. */
  afterRoleFailureRollbackObserved?: () => Promise<void>;
  /** Test-only timeout for mutable-role ref publication. */
  roleRefPublishTimeoutMs?: number;
  /** Test seam for exact terminal worktree cleanup reconciliation. */
  terminalCleanupDependencies?: Partial<TerminalCleanupDependencies>;
}

interface ActiveRevalidationPreflight {
  run: RunRecord;
  headSha: string | undefined;
  alignmentError?: Error;
}

const REVALIDATION_STABILITY_ATTEMPTS = 8;
const MASWE_SOURCE_PATHSPEC = [".", ":(exclude).maswe", ":(exclude).maswe/**"] as const;

type MutableRoleId = "builder" | "prResolver";

interface MutableRolePublicationSpec {
  role: MutableRoleId;
  phase: "builder" | "resolver";
  artifactName: "04-builder-report.md" | "09-resolution-report.md";
  commitMessage: string;
  successEvent: "BUILD_COMPLETED" | "RESOLUTION_COMPLETED";
  actor: "builder" | "prResolver";
  label: "Builder" | "Resolver";
}

interface SpeculativeRoleWorktree {
  repositoryWorkdir: string;
  rootPath: string;
  worktreePath: string;
  branch: string;
  ownsBranch: boolean;
  cleaned: boolean;
}

interface SpeculativeRoleBaseline {
  treeSha: string;
  ignoredInputPaths: string[];
}

function gitCommandFailure(label: string, result: { stdout: string; stderr: string }): Error {
  return new Error(`${label}: ${(result.stderr || result.stdout).trim() || "git failed"}`);
}

export class Orchestrator {
  readonly store: RunStore;
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly runtime: AgentRuntime;
  private readonly automaticTransitionLimit: number;
  private readonly beforeBootstrapReconcile: ((run: RunRecord) => Promise<void>) | undefined;
  private readonly bootstrapHooks: WorkspaceBootstrapHooks;
  private readonly afterWorkspaceCheckpoint: ((run: RunRecord) => Promise<void>) | undefined;
  private readonly beforeRetryPublication: ((candidate: RunRecord) => Promise<void>) | undefined;
  private readonly afterRunMutationReload: OrchestratorOptions["afterRunMutationReload"];
  private readonly afterDirtyRoleDeltaApplied: OrchestratorOptions["afterDirtyRoleDeltaApplied"];
  private readonly beforeRoleRefPublish: OrchestratorOptions["beforeRoleRefPublish"];
  private readonly afterSpeculativeRoleCleanupBeforePublication: OrchestratorOptions["afterSpeculativeRoleCleanupBeforePublication"];
  private readonly beforeRoleFailureRollback: OrchestratorOptions["beforeRoleFailureRollback"];
  private readonly afterRoleFailureRollbackObserved: OrchestratorOptions["afterRoleFailureRollbackObserved"];
  private readonly roleRefPublishTimeoutMs: number;
  private readonly terminalCleanupDependencies: Partial<TerminalCleanupDependencies> | undefined;

  constructor(
    cwd: string,
    config: MasweConfig,
    runtime: AgentRuntime,
    store?: RunStore,
    options: OrchestratorOptions = {},
  ) {
    this.cwd = cwd;
    this.config = config;
    this.runtime = runtime;
    this.store = store ?? new FileRunStore(cwd);
    this.automaticTransitionLimit = options.automaticTransitionLimit ?? 20;
    this.beforeBootstrapReconcile = options.beforeBootstrapReconcile;
    this.bootstrapHooks = options.bootstrapHooks ?? {};
    this.afterWorkspaceCheckpoint = options.afterWorkspaceCheckpoint;
    this.beforeRetryPublication = options.beforeRetryPublication;
    this.afterRunMutationReload = options.afterRunMutationReload;
    this.afterDirtyRoleDeltaApplied = options.afterDirtyRoleDeltaApplied;
    this.beforeRoleRefPublish = options.beforeRoleRefPublish;
    this.afterSpeculativeRoleCleanupBeforePublication =
      options.afterSpeculativeRoleCleanupBeforePublication;
    this.beforeRoleFailureRollback = options.beforeRoleFailureRollback;
    this.afterRoleFailureRollbackObserved = options.afterRoleFailureRollbackObserved;
    this.roleRefPublishTimeoutMs = options.roleRefPublishTimeoutMs ?? 120_000;
    this.terminalCleanupDependencies = options.terminalCleanupDependencies;
    if (
      !Number.isSafeInteger(this.automaticTransitionLimit) ||
      this.automaticTransitionLimit <= 0
    ) {
      throw new Error("automaticTransitionLimit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.roleRefPublishTimeoutMs) || this.roleRefPublishTimeoutMs <= 0) {
      throw new Error("roleRefPublishTimeoutMs must be a positive safe integer");
    }
  }

  private async createPlannedRun(
    title: string,
    request: string,
    config: MasweConfig,
    options: { supersedes?: string } = {},
  ): Promise<RunRecord> {
    if (!config.policy.allowDirtyWorkspace && !(await isGitWorkspaceClean(this.cwd))) {
      throw new Error("Workspace is dirty. Commit, stash, or set policy.allowDirtyWorkspace=true.");
    }
    const workspaceBootstrap = await captureWorkspaceBootstrapIntent(this.cwd, config);
    const run = await this.store.create(title, request, config, {
      workspaceBootstrap,
      ...options,
    });
    await this.beforeBootstrapReconcile?.(run);
    return run;
  }

  private recordsEqual(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left, right);
  }

  private isCompleteBootstrapStart(prior: RunRecord, candidate: RunRecord): boolean {
    if (
      prior.state !== "CREATED" ||
      !prior.workspace ||
      !prior.workspaceBootstrap ||
      candidate.state !== "BRAINSTORMING" ||
      candidate.workspaceBootstrap !== undefined ||
      candidate.version !== prior.version + 1 ||
      candidate.events.length !== prior.events.length + 1 ||
      JSON.stringify(candidate.events.slice(0, prior.events.length)) !==
        JSON.stringify(prior.events)
    ) {
      return false;
    }
    const event = candidate.events.at(-1);
    const expectedDetails = prior.supersedes ? { supersedes: prior.supersedes } : undefined;
    if (
      !event ||
      event.type !== "START" ||
      event.actor !== "user" ||
      event.from !== "CREATED" ||
      event.to !== "BRAINSTORMING" ||
      JSON.stringify(event.details) !== JSON.stringify(expectedDetails)
    ) {
      return false;
    }

    const expected = structuredClone(prior);
    expected.state = "BRAINSTORMING";
    expected.version = candidate.version;
    expected.updatedAt = candidate.updatedAt;
    expected.events = candidate.events;
    delete expected.workspaceBootstrap;
    return this.recordsEqual(candidate, expected);
  }

  /** Establish and publish the durable CREATED workspace checkpoint before START. */
  async bootstrapCreatedRun(runId: string): Promise<RunRecord> {
    const prior = await this.store.load(runId);
    if (prior.state !== "CREATED") {
      throw new Error(`Run ${runId} bootstrap requires CREATED state, found ${prior.state}`);
    }
    let checkpointExpected: RunRecord | undefined;
    let startExpected: RunRecord | undefined;
    try {
      if (prior.workspace) {
        checkpointExpected = structuredClone(prior);
        await assertBootstrapWorkspaceReady(this.cwd, checkpointExpected);
      } else {
        const workspace = await reconcileBootstrapWorkspace(
          this.cwd,
          prior,
          this.bootstrapHooks,
        );
        checkpointExpected = structuredClone(prior);
        checkpointExpected.workspace = workspace;
        await this.store.save(checkpointExpected);
      }

      const checkpoint = await this.store.load(runId);
      if (!checkpointExpected || !this.recordsEqual(checkpoint, checkpointExpected)) {
        throw new Error("Authoritative CREATED workspace checkpoint changed during bootstrap");
      }
      await this.afterWorkspaceCheckpoint?.(checkpoint);
      const reloaded = await this.store.load(runId);
      if (!this.recordsEqual(reloaded, checkpoint)) {
        throw new Error("Authoritative CREATED workspace checkpoint changed before START");
      }
      await assertBootstrapWorkspaceReady(this.cwd, reloaded);

      startExpected = structuredClone(reloaded);
      delete startExpected.workspaceBootstrap;
      const details = startExpected.supersedes
        ? { supersedes: startExpected.supersedes }
        : undefined;
      return await this.store.applyEvent(startExpected, "START", "user", details);
    } catch (error) {
      const observed = await this.store.load(runId);
      if (checkpointExpected && this.isCompleteBootstrapStart(checkpointExpected, observed)) {
        return observed;
      }
      const exactPrior = this.recordsEqual(observed, prior);
      const exactCheckpoint = checkpointExpected
        ? this.recordsEqual(observed, checkpointExpected)
        : false;
      if (observed.state === "CREATED" && observed.workspaceBootstrap && (exactPrior || exactCheckpoint)) {
        return this.failRun(
          observed,
          runFailureMessage(error),
          runFailureCode(error),
          runFailureRuntime(error),
          { preservationReason: "bootstrap-recovery" },
        );
      }
      throw new Error(
        "Workspace bootstrap publication outcome is ambiguous: authoritative state is neither an exact actionable CREATED checkpoint nor a complete START publication.",
        { cause: error },
      );
    }
  }

  private assertWithinBudget(run: RunRecord): void {
    const max = run.config.policy.maxRunDurationMs;
    if (!max) return;
    const elapsed = Date.now() - Date.parse(run.createdAt);
    if (elapsed > max) {
      throw new Error(`Run exceeded maxRunDurationMs (${max}).`);
    }
  }

  private async finalizeTerminal(run: RunRecord): Promise<RunRecord> {
    const status = run.terminalCleanup?.status;
    if (status === "complete" || status === "preserved") {
      return run;
    }
    return this.reconcileTerminalCleanup(run.id, { allowLegacy: false });
  }

  async cleanupTerminal(runId: string): Promise<RunRecord> {
    return this.reconcileTerminalCleanup(runId, { allowLegacy: true });
  }

  private refusePreservedRecoveryWorktree(reason: string): never {
    throw new Error(`cleanupTerminal refuses a preserved recovery worktree (${reason})`);
  }

  private async inspectTerminalCleanupPath(
    candidatePath: string,
  ): Promise<TerminalCleanupPathState> {
    try {
      const stat = await lstat(candidatePath);
      return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
  }

  private async legacyManagedTargetPresent(run: RunRecord): Promise<boolean> {
    const worktreePath = run.workspace?.worktreePath;
    if (!worktreePath) return false;
    if (path.resolve(this.cwd) !== path.resolve(run.repositoryPath)) {
      throw new TerminalCleanupError(
        "cleanup-ownership-mismatch",
        "Cleanup invocation repository root must match the run repositoryPath exactly",
      );
    }
    const listRegistrations =
      this.terminalCleanupDependencies?.listRegistrations ?? listGitWorktreeRegistrations;
    const inspectPath =
      this.terminalCleanupDependencies?.inspectPath ??
      ((candidatePath: string) => this.inspectTerminalCleanupPath(candidatePath));
    let registrations;
    let pathState: TerminalCleanupPathState;
    try {
      registrations = await listRegistrations(run.repositoryPath);
      pathState = await inspectPath(worktreePath);
    } catch (error) {
      throw error instanceof TerminalCleanupError
        ? error
        : new TerminalCleanupError(
            "cleanup-inspection-failed",
            error instanceof Error ? error.message : "Failed to inspect legacy worktree state",
          );
    }
    const expectedBranch = `maswe/${run.id}`;
    const resolved = path.resolve(worktreePath);
    return (
      pathState !== "absent" ||
      registrations.some(
        (registration) =>
          path.resolve(registration.worktreePath) === resolved ||
          registration.branch === expectedBranch,
      )
    );
  }

  private async classifyLegacyTerminalCleanup(
    run: RunRecord,
  ): Promise<
    | { kind: "complete" }
    | { kind: "reconcile" }
    | {
        kind: "preserved";
        preservationReason: Exclude<
          TerminalCleanupPreservationReason,
          "publication-outcome-unknown"
        >;
      }
    | { kind: "ambiguous" }
  > {
    if (!run.workspace?.worktreePath) {
      return { kind: "complete" };
    }
    if (run.state === "FAILED" && run.workspaceBootstrap) {
      return { kind: "preserved", preservationReason: "bootstrap-recovery" };
    }
    if (run.state === "FAILED" && run.revalidation) {
      return { kind: "preserved", preservationReason: "revalidation-recovery" };
    }
    if (run.state !== "FAILED") {
      return { kind: "reconcile" };
    }
    if (await this.legacyManagedTargetPresent(run)) {
      return { kind: "ambiguous" };
    }
    return { kind: "complete" };
  }

  private async persistCleanupFailure(
    run: RunRecord,
    error: TerminalCleanupError,
  ): Promise<never> {
    try {
      await this.persistTerminalCleanupState(run, {
        status: "failed",
        lastError: {
          code: error.code,
          message: sanitizeDiagnostic(error.message, FAILURE_AGGREGATE_MAX_CODE_POINTS).text,
        },
      });
    } catch (persistError) {
      throw new AggregateError(
        [error, persistError],
        `Terminal cleanup failed and cleanup failure persistence also failed for run ${run.id}`,
      );
    }
    throw error;
  }

  private async reconcileTerminalCleanup(
    runId: string,
    options: { allowLegacy: boolean },
  ): Promise<RunRecord> {
    return withRunMutationFence(this.cwd, runId, "terminal-cleanup", async () => {
      const authoritative = await this.store.load(runId);
      if (!isTerminal(authoritative.state)) {
        throw new Error(
          `cleanupTerminal requires a terminal run; currently ${authoritative.state}`,
        );
      }
      const status = authoritative.terminalCleanup?.status;
      if (status === "complete") return authoritative;
      if (status === "preserved") {
        this.refusePreservedRecoveryWorktree(
          authoritative.terminalCleanup?.preservationReason ?? "preserved",
        );
      }
      if (
        status === "failed" &&
        authoritative.terminalCleanup?.lastError?.code === "cleanup-legacy-state-ambiguous"
      ) {
        throw new TerminalCleanupError(
          "cleanup-legacy-state-ambiguous",
          authoritative.terminalCleanup.lastError.message,
        );
      }
      if (status !== "pending" && status !== "failed") {
        if (!options.allowLegacy || authoritative.terminalCleanup !== undefined) {
          throw new Error(
            `cleanupTerminal requires explicit pending or failed cleanup intent`,
          );
        }
        let decision;
        try {
          decision = await this.classifyLegacyTerminalCleanup(authoritative);
        } catch (error) {
          if (error instanceof TerminalCleanupError) {
            return this.persistCleanupFailure(authoritative, error);
          }
          throw error;
        }
        if (decision.kind === "complete") {
          return this.persistTerminalCleanupState(authoritative, { status: "complete" });
        }
        if (decision.kind === "preserved") {
          await this.persistTerminalCleanupState(authoritative, {
            status: "preserved",
            preservationReason: decision.preservationReason,
          });
          this.refusePreservedRecoveryWorktree(decision.preservationReason);
        }
        if (decision.kind === "ambiguous") {
          return this.persistCleanupFailure(
            authoritative,
            new TerminalCleanupError(
              "cleanup-legacy-state-ambiguous",
              "Legacy FAILED run has a surviving worktree without durable preservation proof",
            ),
          );
        }
      }
      try {
        await reconcileTerminalWorktreeCleanup(
          authoritative,
          this.cwd,
          this.terminalCleanupDependencies,
        );
      } catch (error) {
        if (error instanceof TerminalCleanupError) {
          return this.persistCleanupFailure(authoritative, error);
        }
        throw error;
      }
      return this.persistTerminalCleanupState(authoritative, { status: "complete" });
    });
  }

  private async persistTerminalCleanupState(
    run: RunRecord,
    update:
      | { status: "complete" }
      | {
          status: "preserved";
          preservationReason: TerminalCleanupPreservationReason;
        }
      | {
          status: "failed";
          lastError: { code: TerminalCleanupError["code"]; message: string };
        },
  ): Promise<RunRecord> {
    const latest = await this.store.load(run.id);
    const updatedAt = new Date().toISOString();
    latest.terminalCleanup =
      update.status === "complete"
        ? { status: "complete", updatedAt }
        : update.status === "preserved"
          ? {
              status: "preserved",
              updatedAt,
              preservationReason: update.preservationReason,
            }
          : { status: "failed", updatedAt, lastError: update.lastError };
    await this.store.save(latest);
    return this.store.load(run.id);
  }

  async start(title: string, request: string): Promise<RunRecord> {
    const catalogue = await this.runtime.listModels();
    const resolvedConfig = resolveProjectModels(this.config, catalogue);
    const planned = await this.createPlannedRun(title, request, resolvedConfig);
    const run = await this.bootstrapCreatedRun(planned.id);
    return this.runUntilBlocked(run.id);
  }

  async approve(runId: string, gate: "brainstorm" | "design"): Promise<RunRecord> {
    const run = await this.store.load(runId);
    if (gate === "brainstorm") {
      run.approvals.brainstorm = true;
      await this.store.applyEvent(run, "APPROVE_BRAINSTORM", "user");
    } else {
      run.approvals.design = true;
      await this.store.applyEvent(run, "APPROVE_DESIGN", "user");
    }
    return this.runUntilBlocked(run.id);
  }

  async runUntilBlocked(runId: string): Promise<RunRecord> {
    let run = await this.store.load(runId);
    let iterations = 0;
    while (!isTerminal(run.state)) {
      if (isHumanGate(run.state)) {
        if (run.state !== "PR_READY" && run.state !== "PR_REVIEW") return run;
        try {
          const preflight = await this.preflightStableReturnGate(run);
          run = preflight.run;
          if (preflight.continueAutomaticWork) continue;
          return run;
        } catch (error) {
          return this.failRun(
            run,
            runFailureMessage(error),
            runFailureCode(error),
            runFailureRuntime(error),
            { preservationReason: "revalidation-recovery" },
          );
        }
      }
      run = await this.advance(run.id);
      iterations += 1;
      if (isTerminal(run.state)) return run;
      if (iterations >= this.automaticTransitionLimit && !isHumanGate(run.state)) {
        return this.failRun(
          run,
          `Workflow exceeded ${this.automaticTransitionLimit} automatic transitions.`,
          "automatic-transition-limit-exceeded",
        );
      }
    }
    return run;
  }

  private hasCurrentGateEvidence(run: RunRecord, headSha: string): boolean {
    return (
      run.evidence?.quality?.headSha === headSha &&
      run.evidence.verification?.headSha === headSha
    );
  }

  private async observeRevalidationWorkspace(run: RunRecord): Promise<string | undefined> {
    if (!run.workspace) {
      throw new Error(`Run ${run.id} has no workspace for revalidation`);
    }
    const workdir = workingDirectoryFor(run);
    if (!(await isGitWorkspaceClean(workdir))) {
      throw new Error(`Revalidation workspace is dirty at ${run.workspace.headSha}`);
    }
    const headSha = (await refreshWorkspaceHead(run)) ?? run.workspace.headSha;
    if (!(await isGitWorkspaceClean(workdir))) {
      throw new Error(`Revalidation workspace changed while observing HEAD ${headSha}`);
    }
    return headSha;
  }

  private async preflightReturnGate(run: RunRecord): Promise<RunRecord> {
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return run;
    const previousHeadSha = run.workspace.headSha;
    const observed = structuredClone(run);
    const requestedHeadSha = await this.observeRevalidationWorkspace(observed);
    if (!requestedHeadSha) return run;
    if (
      requestedHeadSha === previousHeadSha &&
      this.hasCurrentGateEvidence(run, requestedHeadSha)
    ) {
      return run;
    }
    return new RevalidationService(this.store).route(run.id, {
      source: "local-workspace",
      previousHeadSha,
      requestedHeadSha,
      expectedRunVersion: run.version,
      actor: "local-runner",
      observedWorkspace: observed.workspace!,
    });
  }

  private async preflightStableReturnGate(
    run: RunRecord,
  ): Promise<{ run: RunRecord; continueAutomaticWork: boolean }> {
    let snapshot = run;
    for (let attempt = 0; attempt < REVALIDATION_STABILITY_ATTEMPTS; attempt += 1) {
      if (snapshot.state !== "PR_READY" && snapshot.state !== "PR_REVIEW") {
        return { run: snapshot, continueAutomaticWork: false };
      }
      snapshot = await this.preflightCommittedAssociationHead(snapshot);
      if (snapshot.state !== "PR_READY" && snapshot.state !== "PR_REVIEW") {
        // A GitHub route may target a commit that is not checked out locally yet.
        // Publish and return that checkpoint; continuing here would immediately
        // fail revalidation alignment instead of waiting for the workspace at C.
        return { run: snapshot, continueAutomaticWork: false };
      }

      let localPreflight: RunRecord;
      try {
        localPreflight = await this.preflightReturnGate(snapshot);
      } catch (error) {
        if (!(error instanceof RevalidationOptimisticConflictError)) throw error;
        snapshot = await this.store.load(run.id);
        continue;
      }
      if (localPreflight.state !== "PR_READY" && localPreflight.state !== "PR_REVIEW") {
        return { run: localPreflight, continueAutomaticWork: true };
      }

      const authoritative = await this.store.load(run.id);
      if (this.recordsEqual(authoritative, localPreflight)) {
        return { run: authoritative, continueAutomaticWork: false };
      }
      snapshot = authoritative;
    }
    throw new Error(`Run ${run.id} return-gate authority did not stabilize`);
  }

  private currentWorkflowTarget(run: RunRecord): string | undefined {
    return run.revalidation?.requestedHeadSha ?? run.workspace?.headSha;
  }

  private async preflightCommittedAssociationHead(run: RunRecord): Promise<RunRecord> {
    let snapshot = run;
    for (let attempt = 0; attempt < REVALIDATION_STABILITY_ATTEMPTS; attempt += 1) {
      const github = snapshot.github;
      if (!github || github.suspended === true) return snapshot;
      const currentTarget = this.currentWorkflowTarget(snapshot);
      if (!currentTarget) {
        throw new Error(
          `Run ${run.id} has no authoritative workflow target for committed GitHub HEAD ${github.headSha}`,
        );
      }
      if (
        github.headSha === currentTarget &&
        !requiresSameTargetEvidenceRecovery(snapshot, currentTarget)
      ) {
        return snapshot;
      }

      const committedHeadSha = github.headSha;
      try {
        await new RevalidationService(this.store).route(run.id, {
          source: "github",
          previousHeadSha: currentTarget,
          requestedHeadSha: committedHeadSha,
          expectedRunVersion: snapshot.version,
          actor: "local-runner",
        });
      } catch (error) {
        if (!(error instanceof RevalidationOptimisticConflictError)) throw error;
        const authoritative = await this.store.load(run.id);
        if (
          authoritative.github?.suspended !== true &&
          authoritative.github?.headSha === committedHeadSha &&
          this.currentWorkflowTarget(authoritative) === committedHeadSha &&
          !requiresSameTargetEvidenceRecovery(authoritative, committedHeadSha)
        ) {
          return authoritative;
        }
        snapshot = authoritative;
        continue;
      }

      const authoritative = await this.store.load(run.id);
      if (
        authoritative.github?.suspended !== true &&
        authoritative.github?.headSha === committedHeadSha &&
        this.currentWorkflowTarget(authoritative) === committedHeadSha &&
        !requiresSameTargetEvidenceRecovery(authoritative, committedHeadSha)
      ) {
        return authoritative;
      }
      snapshot = authoritative;
    }
    throw new Error(`Run ${run.id} committed GitHub association target did not stabilize`);
  }

  private async preflightActiveRevalidation(
    run: RunRecord,
  ): Promise<ActiveRevalidationPreflight> {
    let snapshot = run;
    for (let attempt = 0; attempt < REVALIDATION_STABILITY_ATTEMPTS; attempt += 1) {
      if (!snapshot.revalidation) {
        return {
          run: snapshot,
          headSha: (await this.syncWorkspace(snapshot)) ?? snapshot.workspace?.headSha,
        };
      }
      const observed = structuredClone(snapshot);
      const observedHeadSha = await this.observeRevalidationWorkspace(observed);
      if (!observedHeadSha || !observed.workspace) {
        throw new Error(`Run ${run.id} has no observable revalidation workspace HEAD`);
      }
      const source = snapshot.github ? "github" : "local-workspace";
      const requiredHeadSha = snapshot.github?.headSha ?? observedHeadSha;
      if (
        snapshot.revalidation.requestedHeadSha === requiredHeadSha &&
        observedHeadSha !== requiredHeadSha
      ) {
        return {
          run: snapshot,
          headSha: observedHeadSha,
          alignmentError: new Error(
            `Required revalidation target ${requiredHeadSha} does not match workspace HEAD ${observedHeadSha}`,
          ),
        };
      }

      let routed: RunRecord;
      try {
        routed = await new RevalidationService(this.store).route(run.id, {
          source,
          previousHeadSha: snapshot.revalidation.requestedHeadSha,
          requestedHeadSha: requiredHeadSha,
          expectedRunVersion: snapshot.version,
          actor: source === "github" ? "github-app" : "local-runner",
          observedWorkspace: observed.workspace,
        });
      } catch (error) {
        if (!(error instanceof RevalidationOptimisticConflictError)) throw error;
        snapshot = await this.store.load(run.id);
        continue;
      }

      const authoritative = await this.store.load(run.id);
      if (!this.recordsEqual(authoritative, routed)) {
        snapshot = authoritative;
        continue;
      }
      if (!authoritative.revalidation) {
        return {
          run: authoritative,
          headSha: authoritative.workspace?.headSha,
        };
      }
      const stableObserved = structuredClone(authoritative);
      const stableObservedHeadSha = await this.observeRevalidationWorkspace(stableObserved);
      if (!stableObservedHeadSha || !stableObserved.workspace) {
        throw new Error(`Run ${run.id} has no observable revalidation workspace HEAD`);
      }
      const stableRequiredHeadSha = authoritative.github?.headSha ?? stableObservedHeadSha;
      if (authoritative.revalidation.requestedHeadSha !== stableRequiredHeadSha) {
        snapshot = authoritative;
        continue;
      }
      if (stableObservedHeadSha !== stableRequiredHeadSha) {
        return {
          run: authoritative,
          headSha: stableObservedHeadSha,
          alignmentError: new Error(
            `Required revalidation target ${stableRequiredHeadSha} does not match workspace HEAD ${stableObservedHeadSha}`,
          ),
        };
      }
      return { run: authoritative, headSha: stableObservedHeadSha };
    }
    throw new Error(`Run ${run.id} revalidation target did not stabilize`);
  }

  private captureOptionalRevalidationFence(run: RunRecord): RevalidationFence | undefined {
    return run.revalidation ? captureRevalidationFence(run) : undefined;
  }

  private async assertOptionalRevalidationFence(
    run: RunRecord,
    fence: RevalidationFence | undefined,
  ): Promise<void> {
    if (fence) await assertRevalidationFence(this.store, run.id, fence);
  }

  private async withRunPublicationFence<T>(
    run: RunRecord,
    phase: "builder" | "resolver" | "quality" | "verifier",
    fence: RevalidationFence | undefined,
    publish: () => Promise<T>,
    ownedLease?: RunMutationLease,
  ): Promise<T> {
    const publishUnderLease = async (lease: RunMutationLease): Promise<T> => {
      const authoritative = fence
        ? await assertRevalidationFence(this.store, run.id, fence)
        : await this.store.load(run.id);
      if (!fence && authoritative.version !== run.version) {
        throw new Error(
          `Run ${run.id} changed before ${phase} publication: expected ${run.version}, authoritative ${authoritative.version}`,
        );
      }
      await this.afterRunMutationReload?.(phase, authoritative);
      await lease.assertNoQueuedTargetMutation();
      return publish();
    };
    if (ownedLease) return publishUnderLease(ownedLease);
    return withRunMutationFence(
      run.repositoryPath,
      run.id,
      "publication",
      publishUnderLease,
    );
  }

  private async assertExpectedGitPublicationInput(
    run: RunRecord,
    expectedHeadSha: string,
    label: string,
  ): Promise<void> {
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return;
    const workdir = workingDirectoryFor(run);
    await assertExpectedBranch(workdir, run.workspace.branch);
    const actualHeadSha = await gitRevParse(workdir, "HEAD");
    if (actualHeadSha !== expectedHeadSha) {
      run.workspace.headSha = actualHeadSha;
      run.workspace.fingerprint = await gitWorkspaceFingerprint(workdir);
      invalidateStaleEvidence(run, actualHeadSha);
      throw new Error(
        `${label} expected HEAD ${expectedHeadSha}, but authoritative publication observed ${actualHeadSha}`,
      );
    }
  }

  private async assertExactGitPublicationState(
    run: RunRecord,
    expectedHeadSha: string,
    label: string,
  ): Promise<void> {
    await this.assertExpectedGitPublicationInput(run, expectedHeadSha, label);
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return;
    const workdir = workingDirectoryFor(run);
    if (!(await isGitWorkspaceClean(workdir))) {
      throw new Error(`${label} requires a clean worktree at ${expectedHeadSha}`);
    }
    await assertExpectedBranch(workdir, run.workspace.branch);
    const finalHeadSha = await gitRevParse(workdir, "HEAD");
    if (finalHeadSha !== expectedHeadSha) {
      run.workspace.headSha = finalHeadSha;
      run.workspace.fingerprint = await gitWorkspaceFingerprint(workdir);
      invalidateStaleEvidence(run, finalHeadSha);
      throw new Error(
        `${label} final HEAD moved from ${expectedHeadSha} to ${finalHeadSha}`,
      );
    }
  }

  private async createSpeculativeRoleWorktree(
    repositoryWorkdir: string,
    beforeSha: string,
    role: MutableRoleId,
  ): Promise<SpeculativeRoleWorktree> {
    const roleName = role === "prResolver" ? "resolver" : role;
    const rootPath = await mkdtemp(path.join(os.tmpdir(), `maswe-${roleName}-generation-`));
    const suffix = path.basename(rootPath).replace(/[^A-Za-z0-9._-]/g, "-");
    const speculative: SpeculativeRoleWorktree = {
      repositoryWorkdir,
      rootPath,
      worktreePath: path.join(rootPath, "worktree"),
      branch: `maswe/speculative-${roleName}/${suffix}`,
      ownsBranch: false,
      cleaned: false,
    };
    const branchCreated = await gitRun(
      ["branch", speculative.branch, beforeSha],
      repositoryWorkdir,
    );
    if (branchCreated.exitCode !== 0) {
      await rm(rootPath, { recursive: true, force: true });
      throw gitCommandFailure(`Failed to create speculative ${roleName} branch`, branchCreated);
    }
    speculative.ownsBranch = true;
    const added = await gitRun(
      ["worktree", "add", speculative.worktreePath, speculative.branch],
      repositoryWorkdir,
    );
    if (added.exitCode === 0) return speculative;

    const primary = gitCommandFailure(`Failed to create speculative ${roleName} worktree`, added);
    try {
      await this.cleanupSpeculativeRoleWorktree(speculative);
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        `Speculative ${roleName} worktree creation and cleanup failed`,
      );
    }
    throw primary;
  }

  private async cleanupSpeculativeRoleWorktree(
    speculative: SpeculativeRoleWorktree,
  ): Promise<void> {
    if (speculative.cleaned) return;
    const branchRef = `refs/heads/${speculative.branch}`;
    const branchHead = speculative.ownsBranch
      ? await gitRun(
          ["rev-parse", "--verify", branchRef],
          speculative.repositoryWorkdir,
        )
      : undefined;
    const registration = (await listGitWorktreeRegistrations(
      speculative.repositoryWorkdir,
    )).find(
      (candidate) => path.resolve(candidate.worktreePath) === path.resolve(speculative.worktreePath),
    );
    if (registration) {
      const removed = await gitRun(
        ["worktree", "remove", "--force", speculative.worktreePath],
        speculative.repositoryWorkdir,
      );
      if (removed.exitCode !== 0) {
        throw gitCommandFailure("Failed to remove speculative role worktree", removed);
      }
    }
    if (branchHead?.exitCode === 0) {
      const expectedHeadSha = branchHead.stdout.trim();
      const deleted = await gitRun(
        ["update-ref", "-d", branchRef, expectedHeadSha],
        speculative.repositoryWorkdir,
      );
      if (deleted.exitCode !== 0) {
        throw gitCommandFailure("Failed to delete speculative role branch", deleted);
      }
      speculative.ownsBranch = false;
    }
    await rm(speculative.rootPath, { recursive: true, force: true });
    speculative.cleaned = true;
  }

  private async applyGitPatch(
    workdir: string,
    patchContent: string,
    label: string,
    reverse = false,
  ): Promise<void> {
    if (patchContent.length === 0) return;
    const applied = await spawnCaptured(
      "git",
      ["apply", ...(reverse ? ["--reverse"] : []), "--binary", "--whitespace=nowarn"],
      { cwd: workdir, input: patchContent, timeoutMs: 120_000 },
    );
    if (applied.timedOut) {
      throw new Error(`${label}: git apply timed out after 120000ms`);
    }
    if (applied.exitCode !== 0) throw gitCommandFailure(label, applied);
  }

  private async publishRoleCommit(
    workdir: string,
    branch: string,
    beforeSha: string,
    commitSha: string,
    roleDelta: string,
    dirtyBaseline: boolean,
    preserveManagedWorkspaceOnFailure: boolean,
  ): Promise<void> {
    const rollbackBaselineFingerprint = await captureWorkspaceSourceFingerprint(workdir);
    let deltaApplied = false;
    let publicationOutcomeUncertain = false;
    let refPublished = false;
    try {
      await this.applyGitPatch(
        workdir,
        roleDelta,
        "Failed to apply speculative role changes",
      );
      deltaApplied = true;
      if (dirtyBaseline) await this.afterDirtyRoleDeltaApplied?.();
      await this.beforeRoleRefPublish?.();
      const published = await spawnCaptured(
        "git",
        ["update-ref", `refs/heads/${branch}`, commitSha, beforeSha],
        { cwd: workdir, timeoutMs: this.roleRefPublishTimeoutMs },
      );
      publicationOutcomeUncertain = published.timedOut === true;
      if (published.timedOut) {
        throw new Error(
          `Authoritative role ref publication timed out after ${this.roleRefPublishTimeoutMs}ms`,
        );
      }
      if (published.exitCode !== 0) {
        throw gitCommandFailure("Failed to publish authoritative role commit", published);
      }
      refPublished = true;
      const preparedIndex = await gitRun(["read-tree", commitSha], workdir);
      if (preparedIndex.exitCode !== 0) {
        throw gitCommandFailure("Failed to prepare authoritative role index", preparedIndex);
      }
    } catch (publicationError) {
      if (refPublished || publicationOutcomeUncertain) {
        throw new RolePublicationOutcomeUnknownError(
          [publicationError],
          "Role publication may have changed the authoritative ref or index; operator reconciliation is required",
        );
      }

      const rollbackErrors: unknown[] = [];
      try {
        await this.beforeRoleFailureRollback?.();
      } catch (error) {
        rollbackErrors.push(error);
      }
      if (deltaApplied) {
        try {
          await this.applyGitPatch(
            workdir,
            roleDelta,
            "Failed to reverse speculative role changes",
            true,
          );
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      let actualHeadSha: string | undefined;
      let workspaceClean: boolean | undefined;
      let actualSourceFingerprint: string | undefined;
      try {
        actualHeadSha = await gitRevParse(workdir);
        workspaceClean = await isGitWorkspaceClean(workdir);
        actualSourceFingerprint = await captureWorkspaceSourceFingerprint(workdir);
      } catch (error) {
        rollbackErrors.push(error);
      }
      if (rollbackErrors.length > 0) {
        throw new RolePublicationOutcomeUnknownError(
          [publicationError, ...rollbackErrors],
          "Role publication and authoritative workspace rollback failed; operator reconciliation is required",
        );
      }
      if (
        actualHeadSha !== beforeSha ||
        actualSourceFingerprint !== rollbackBaselineFingerprint
      ) {
        throw new RolePublicationOutcomeUnknownError(
          [publicationError],
          `Role publication rollback did not restore the exact authoritative baseline at ${actualHeadSha} (${workspaceClean ? "clean" : "dirty"}); operator reconciliation is required`,
        );
      }
      try {
        await this.afterRoleFailureRollbackObserved?.();
      } catch (error) {
        throw new RolePublicationOutcomeUnknownError(
          [publicationError, error],
          "Role publication rollback observation failed; operator reconciliation is required",
        );
      }
      if (preserveManagedWorkspaceOnFailure) {
        throw new RolePublicationOutcomeUnknownError(
          [publicationError],
          "Role publication failed after speculative mutation; the managed workspace was preserved for operator reconciliation",
        );
      }
      throw publicationError;
    }
  }

  private resolveSpeculativePath(rootPath: string, relativePath: string): string {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(root, relativePath);
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Git returned an unsafe workspace path: ${relativePath}`);
    }
    return candidate;
  }

  private async copySpeculativeWorkspacePath(
    speculative: SpeculativeRoleWorktree,
    relativePath: string,
    kind: "untracked baseline" | "ignored local input",
  ): Promise<void> {
    const sourcePath = this.resolveSpeculativePath(
      speculative.repositoryWorkdir,
      relativePath,
    );
    const destinationPath = this.resolveSpeculativePath(
      speculative.worktreePath,
      relativePath,
    );
    const sourceStat = await lstat(sourcePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), destinationPath);
    } else if (sourceStat.isFile()) {
      await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_FICLONE);
      await chmod(destinationPath, sourceStat.mode & 0o777);
    } else {
      throw new Error(`Unsupported ${kind} path: ${relativePath}`);
    }
  }

  private async seedSpeculativeRoleWorktree(
    speculative: SpeculativeRoleWorktree,
    beforeSha: string,
  ): Promise<SpeculativeRoleBaseline> {
    const tracked = await gitRun(
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-renames",
        "HEAD",
        "--",
        ...MASWE_SOURCE_PATHSPEC,
      ],
      speculative.repositoryWorkdir,
    );
    if (tracked.exitCode !== 0) {
      throw gitCommandFailure("Failed to capture the authoritative role baseline", tracked);
    }
    await this.applyGitPatch(
      speculative.worktreePath,
      tracked.stdout,
      "Failed to seed tracked role baseline changes",
    );

    const untracked = await gitRun(
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...MASWE_SOURCE_PATHSPEC,
      ],
      speculative.repositoryWorkdir,
    );
    if (untracked.exitCode !== 0) {
      throw gitCommandFailure("Failed to enumerate untracked role baseline paths", untracked);
    }
    for (const relativePath of untracked.stdout.split("\0").filter(Boolean)) {
      await this.copySpeculativeWorkspacePath(
        speculative,
        relativePath,
        "untracked baseline",
      );
    }

    const ignored = await gitRun(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ...MASWE_SOURCE_PATHSPEC,
      ],
      speculative.repositoryWorkdir,
    );
    if (ignored.exitCode !== 0) {
      throw gitCommandFailure("Failed to enumerate ignored local role inputs", ignored);
    }
    const ignoredInputPaths = ignored.stdout.split("\0").filter(Boolean);
    for (const relativePath of ignoredInputPaths) {
      await this.copySpeculativeWorkspacePath(
        speculative,
        relativePath,
        "ignored local input",
      );
    }

    const staged = await gitRun(["add", "-A"], speculative.worktreePath);
    if (staged.exitCode !== 0) {
      throw gitCommandFailure("Failed to stage the speculative role baseline", staged);
    }
    const tree = await gitRun(["write-tree"], speculative.worktreePath);
    if (tree.exitCode !== 0) {
      throw gitCommandFailure("Failed to snapshot the speculative role baseline", tree);
    }
    const restoredIndex = await gitRun(["read-tree", beforeSha], speculative.worktreePath);
    if (restoredIndex.exitCode !== 0) {
      throw gitCommandFailure("Failed to restore the speculative builder index", restoredIndex);
    }
    return { treeSha: tree.stdout.trim(), ignoredInputPaths };
  }

  private async prepareSpeculativeRoleIndex(
    speculative: SpeculativeRoleWorktree,
    beforeSha: string,
    ignoredInputPaths: readonly string[],
  ): Promise<void> {
    if (ignoredInputPaths.length > 0) {
      const ignored = await spawnCaptured(
        "git",
        ["check-ignore", "--no-index", "-z", "--stdin"],
        {
          cwd: speculative.worktreePath,
          input: `${ignoredInputPaths.join("\0")}\0`,
          timeoutMs: 120_000,
        },
      );
      if (ignored.timedOut) {
        throw new Error("Ignored local input validation timed out after 120000ms");
      }
      if (ignored.exitCode !== 0 && ignored.exitCode !== 1) {
        throw gitCommandFailure("Failed to validate ignored local role inputs", ignored);
      }
      const stillIgnored = new Set(ignored.stdout.split("\0").filter(Boolean));
      const exposed = ignoredInputPaths.filter((relativePath) => !stillIgnored.has(relativePath));
      if (exposed.length > 0) {
        const sample = exposed.slice(0, 10).join(", ");
        const omitted = exposed.length > 10 ? ` (+${exposed.length - 10} more)` : "";
        throw new Error(
          `Role publication refuses ignore-rule changes that expose seeded local inputs: ${sample}${omitted}`,
        );
      }
    }
    const restoredIndex = await gitRun(["read-tree", beforeSha], speculative.worktreePath);
    if (restoredIndex.exitCode !== 0) {
      throw gitCommandFailure("Failed to clear mutable-role index changes", restoredIndex);
    }
  }

  private async assertNoMasweControlPlaneChanges(workdir: string): Promise<void> {
    const status = await gitRun(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".maswe"],
      workdir,
    );
    if (status.exitCode !== 0) {
      throw gitCommandFailure("git status failed while inspecting MASWE control-plane paths", status);
    }
    if (status.stdout.length > 0) {
      throw new Error("Role publication refuses tracked .maswe control-plane changes");
    }
  }

  private async syncWorkspace(run: RunRecord): Promise<string | undefined> {
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return undefined;
    const workdir = workingDirectoryFor(run);
    await assertExpectedBranch(workdir, run.workspace.branch);
    const headSha = await refreshWorkspaceHead(run);
    if (headSha && invalidateStaleEvidence(run, headSha)) {
      await this.store.save(run);
    }
    return headSha;
  }

  private bindEvidence(
    run: RunRecord,
    kind: "quality" | "verification",
    headSha: string,
    passed: boolean,
  ): void {
    run.evidence = {
      ...(run.evidence ?? {}),
      [kind]: {
        headSha,
        passed,
        at: new Date().toISOString(),
      },
    };
  }

  private async advanceGitDependentAutomaticWork(
    run: RunRecord,
    headSha: string | undefined,
  ): Promise<
    | { kind: "completed"; run: RunRecord }
    | { kind: "retry"; run: RunRecord }
  > {
    return withRunMutationFence(
      run.repositoryPath,
      run.id,
      "publication",
      async (lease) => {
        const authoritative = await this.store.load(run.id);
        if (authoritative.repositoryPath !== run.repositoryPath) {
          throw new Error(`Run ${run.id} repository path changed before automatic work`);
        }
        if (
          authoritative.version !== run.version ||
          authoritative.state !== run.state
        ) {
          return { kind: "retry", run: authoritative };
        }
        const github = authoritative.github;
        if (github?.suspended !== true) {
          const currentTarget = this.currentWorkflowTarget(authoritative);
          if (github && !currentTarget) {
            throw new Error(
              `Run ${run.id} has no authoritative workflow target for committed GitHub HEAD ${github.headSha}`,
            );
          }
          if (github && github.headSha !== currentTarget) {
            return { kind: "retry", run: authoritative };
          }
        }
        await lease.assertNoQueuedTargetMutation();

        switch (run.state) {
          case "RESOLVING": {
            run.counters.commentResolutionCycles += 1;
            if (
              run.counters.commentResolutionCycles >
              run.config.policy.maxCommentResolutionCycles
            ) {
              return {
                kind: "completed",
                run: await this.failRun(
                  run,
                  "Maximum PR comment resolution cycles exceeded.",
                  undefined,
                  undefined,
                  { deferTerminalFinalization: true },
                ),
              };
            }
            try {
              return {
                kind: "completed",
                run: await this.executeResolverWithPublish(run, headSha, lease),
              };
            } catch (error) {
              if (error instanceof RunMutationSupersededError) throw error;
              await lease.assertNoQueuedTargetMutation();
              return {
                kind: "completed",
                run: await this.failRun(
                  run,
                  runFailureMessage(error),
                  runFailureCode(error),
                  runFailureRuntime(error),
                  {
                    deferTerminalFinalization: true,
                    ...optionalFailRunPreservation(run, error),
                  },
                ),
              };
            }
          }
          case "BUILDING": {
            run.counters.buildVerifyCycles += 1;
            if (run.counters.buildVerifyCycles > run.config.policy.maxBuildVerifyCycles) {
              return {
                kind: "completed",
                run: await this.failRun(
                  run,
                  "Maximum build/verify cycles exceeded.",
                  undefined,
                  undefined,
                  { deferTerminalFinalization: true },
                ),
              };
            }
            try {
              return {
                kind: "completed",
                run: await this.executeBuilderWithPublish(run, headSha, lease),
              };
            } catch (error) {
              if (error instanceof RunMutationSupersededError) throw error;
              // The speculative worktree is already gone. Give a queued target
              // priority over failure publication; otherwise fail while this
              // publication lease still owns the authoritative generation.
              await lease.assertNoQueuedTargetMutation();
              return {
                kind: "completed",
                run: await this.failRun(
                  run,
                  runFailureMessage(error),
                  runFailureCode(error),
                  runFailureRuntime(error),
                  {
                    deferTerminalFinalization: true,
                    ...optionalFailRunPreservation(run, error),
                  },
                ),
              };
            }
          }
          case "CI_RUNNING": {
            const workdir = workingDirectoryFor(run);
            const evaluatedSha =
              (await refreshWorkspaceHead(run)) ?? headSha ?? "not-a-git-repository";
            if (
              run.revalidation &&
              evaluatedSha !== run.revalidation.requestedHeadSha
            ) {
              throw new Error(
                `CI revalidation target ${run.revalidation.requestedHeadSha} does not match evaluated HEAD ${evaluatedSha}`,
              );
            }
            if (
              evaluatedSha !== "not-a-git-repository" &&
              !(await isGitWorkspaceClean(workdir))
            ) {
              throw new Error(`CI requires a clean worktree at ${evaluatedSha}`);
            }
            const report = await runQualityChecks(workdir, run.config.quality.commands, {
              timeoutMs: run.config.policy.commandTimeoutMs,
            });
            if (evaluatedSha !== "not-a-git-repository") {
              if (!(await isGitWorkspaceClean(workdir))) {
                throw new Error(
                  "Quality commands left the worktree dirty; evidence is not trustworthy.",
                );
              }
              const afterQualitySha = await gitRevParse(workdir);
              if (afterQualitySha !== evaluatedSha) {
                throw new Error(
                  `HEAD moved during quality commands (before ${evaluatedSha}, after ${afterQualitySha})`,
                );
              }
            }
            await this.store.writeArtifact(
              run,
              "05-quality-report.md",
              renderQualityReport(report),
            );
            const fence = this.captureOptionalRevalidationFence(run);
            const accepted = report.passed || !run.config.gates.requireCiPass;
            const completed = await this.withRunPublicationFence(
              run,
              "quality",
              fence,
              async () => {
                await this.assertExactGitPublicationState(
                  run,
                  evaluatedSha,
                  "Quality publication",
                );
                this.bindEvidence(run, "quality", evaluatedSha, report.passed);
                return this.store.applyEvent(
                  run,
                  accepted ? "CI_PASSED" : "CI_FAILED",
                  "quality-runner",
                  {
                    passed: report.passed,
                    required: run.config.gates.requireCiPass,
                    headSha: evaluatedSha,
                  },
                );
              },
              lease,
            );
            return { kind: "completed", run: completed };
          }
          case "VERIFYING": {
            const workdir = workingDirectoryFor(run);
            const evaluatedSha =
              (await refreshWorkspaceHead(run)) ?? headSha ?? "not-a-git-repository";
            if (
              run.revalidation &&
              evaluatedSha !== run.revalidation.requestedHeadSha
            ) {
              throw new Error(
                `Verifier revalidation target ${run.revalidation.requestedHeadSha} does not match evaluated HEAD ${evaluatedSha}`,
              );
            }
            if (
              evaluatedSha !== "not-a-git-repository" &&
              !(await isGitWorkspaceClean(workdir))
            ) {
              throw new Error(`Verifier requires a clean worktree at ${evaluatedSha}`);
            }
            if (run.config.gates.requireCiPass) {
              if (
                !run.evidence?.quality ||
                !run.evidence.quality.passed ||
                run.evidence.quality.headSha !== evaluatedSha
              ) {
                throw new Error(
                  "VERIFYING requires present, passing quality evidence for the current HEAD",
                );
              }
            } else if (
              run.evidence?.quality?.headSha &&
              run.evidence.quality.headSha !== evaluatedSha
            ) {
              throw new Error(
                `Quality evidence is stale for head SHA ${evaluatedSha}; re-run CI before verification.`,
              );
            }
            const prompt = await buildRolePrompt("verifier", run, this.store);
            const result = await this.executeAgent(run, "verifier", prompt);
            if (evaluatedSha !== "not-a-git-repository") {
              if (!(await isGitWorkspaceClean(workdir))) {
                throw new Error(
                  "Verifier left the worktree dirty; evidence is not trustworthy.",
                );
              }
              const afterVerifySha = await gitRevParse(workdir);
              if (afterVerifySha !== evaluatedSha) {
                throw new Error(
                  `HEAD moved during verification (before ${evaluatedSha}, after ${afterVerifySha})`,
                );
              }
            }
            const markers = parseRoleMarker("verifier", result.output);
            if (!markers.ok) throw new Error(markers.message);
            await this.store.writeArtifact(run, "06-verification-report.md", result.output);
            const passed = markers.value === "PASS";
            if (!passed && run.config.gates.requireVerifierPass) {
              await this.store.writeArtifact(
                run,
                "10-verifier-defects.md",
                extractVerifierDefects(result.output),
              );
            }
            const fence = this.captureOptionalRevalidationFence(run);
            const accepted = passed || !run.config.gates.requireVerifierPass;
            const completed = await this.withRunPublicationFence(
              run,
              "verifier",
              fence,
              async () => {
                await this.assertExactGitPublicationState(
                  run,
                  evaluatedSha,
                  "Verification publication",
                );
                this.bindEvidence(run, "verification", evaluatedSha, passed);
                const successEvent =
                  run.revalidation?.returnState === "PR_READY"
                    ? "VERIFY_PASSED"
                    : run.revalidation?.returnState === "PR_REVIEW"
                      ? "VERIFY_PASSED_AFTER_REVIEW"
                      : hasEnteredPullRequestReview(run)
                        ? "VERIFY_PASSED_AFTER_REVIEW"
                        : "VERIFY_PASSED";
                if (accepted && run.revalidation) delete run.revalidation;
                return this.store.applyEvent(
                  run,
                  accepted ? successEvent : "VERIFY_FAILED",
                  "verifier",
                  {
                    passed,
                    required: run.config.gates.requireVerifierPass,
                    ...runtimeEventIdentityDetails(result),
                    headSha: evaluatedSha,
                    marker: markers.marker,
                  },
                );
              },
              lease,
            );
            return { kind: "completed", run: completed };
          }
          default:
            throw new Error(`State ${run.state} is not Git-dependent automatic work`);
        }
      },
    );
  }

  async advance(runId: string): Promise<RunRecord> {
    let run = await this.store.load(runId);
    try {
      for (let entryAttempt = 0; ; entryAttempt += 1) {
        this.assertWithinBudget(run);
        let headSha: string | undefined;
        if (
          run.state === "BUILDING" ||
          run.state === "CI_RUNNING" ||
          run.state === "VERIFYING" ||
          run.state === "RESOLVING"
        ) {
          run = await this.preflightCommittedAssociationHead(run);
          if (
            run.state !== "BUILDING" &&
            run.state !== "CI_RUNNING" &&
            run.state !== "VERIFYING" &&
            run.state !== "RESOLVING"
          ) {
            return run;
          }
        }
        if (
          run.revalidation &&
          (run.state === "BUILDING" ||
            run.state === "CI_RUNNING" ||
            run.state === "VERIFYING" ||
            run.state === "RESOLVING")
        ) {
          const preflight = await this.preflightActiveRevalidation(run);
          run = preflight.run;
          headSha = preflight.headSha;
          if (preflight.alignmentError) throw preflight.alignmentError;
        } else {
          headSha = (await this.syncWorkspace(run)) ?? run.workspace?.headSha;
        }
        if (
          run.state === "BUILDING" ||
          run.state === "CI_RUNNING" ||
          run.state === "VERIFYING" ||
          run.state === "RESOLVING"
        ) {
          const attempt = await this.advanceGitDependentAutomaticWork(run, headSha);
          if (attempt.kind === "completed") {
            return isTerminal(attempt.run.state)
              ? this.finalizeTerminal(attempt.run)
              : attempt.run;
          }
          run = attempt.run;
          if (entryAttempt + 1 >= REVALIDATION_STABILITY_ATTEMPTS) {
            throw new Error(`Run ${run.id} automatic work authority did not stabilize`);
          }
          continue;
        }
        switch (run.state) {
        case "BRAINSTORMING": {
          const completed = await this.executeRole(
            run,
            "brainstormer",
            "02-brainstorm.md",
            "BRAINSTORM_COMPLETED",
            headSha,
          );
          if (!completed.config.gates.requireBrainstormApproval) {
            completed.approvals.brainstorm = true;
            return this.store.applyEvent(completed, "APPROVE_BRAINSTORM", "policy");
          }
          return completed;
        }
        case "DESIGNING": {
          const completed = await this.executeRole(
            run,
            "designer",
            "03-specification-and-design.md",
            "DESIGN_COMPLETED",
            headSha,
          );
          if (!completed.config.gates.requireDesignApproval) {
            completed.approvals.design = true;
            return this.store.applyEvent(completed, "APPROVE_DESIGN", "policy");
          }
          return completed;
        }
        case "CLASSIFYING_COMMENT": {
          const comment = (await this.store.readArtifact(run, "07-review-comment.md")) ?? "";
          const prompt = await buildCommentClassifierPrompt(run, this.store, comment);
          const result = await this.executeAgent(run, "prResolver", prompt, {
            permissionOverride: "read-only",
          });
          const markers = parseRoleMarker("prResolver", result.output, { mode: "classify" });
          if (!markers.ok) throw new Error(markers.message);
          await this.store.writeArtifact(run, "08-comment-classification.md", result.output);
          return this.store.applyEvent(
            run,
            markers.value === "IN_SCOPE" ? "COMMENT_IN_SCOPE" : "COMMENT_OUT_OF_SCOPE",
            "pr-comment-classifier",
            {
              marker: markers.marker,
              ...(headSha ? { headSha } : {}),
            },
          );
        }
        default:
          throw new Error(`State ${run.state} requires a user or integration event.`);
        }
      }
    } catch (error) {
      if (
        error instanceof RunMutationSupersededError ||
        error instanceof TerminalCleanupError
      ) {
        throw error;
      }
      return this.failRun(
        run,
        runFailureMessage(error),
        runFailureCode(error),
        runFailureRuntime(error),
        optionalFailRunPreservation(run, error),
      );
    }
  }

  private async executeBuilderWithPublish(
    run: RunRecord,
    inputHeadSha: string | undefined,
    ownedLease?: RunMutationLease,
  ): Promise<RunRecord> {
    return this.executeMutableRoleWithPublish(run, inputHeadSha, ownedLease, {
      role: "builder",
      phase: "builder",
      artifactName: "04-builder-report.md",
      commitMessage: "maswe: builder changes",
      successEvent: "BUILD_COMPLETED",
      actor: "builder",
      label: "Builder",
    });
  }

  private async executeResolverWithPublish(
    run: RunRecord,
    inputHeadSha: string | undefined,
    ownedLease?: RunMutationLease,
  ): Promise<RunRecord> {
    return this.executeMutableRoleWithPublish(run, inputHeadSha, ownedLease, {
      role: "prResolver",
      phase: "resolver",
      artifactName: "09-resolution-report.md",
      commitMessage: "maswe: resolve review comment",
      successEvent: "RESOLUTION_COMPLETED",
      actor: "prResolver",
      label: "Resolver",
    });
  }

  private async executeMutableRoleWithPublish(
    run: RunRecord,
    inputHeadSha: string | undefined,
    ownedLease: RunMutationLease | undefined,
    spec: MutableRolePublicationSpec,
  ): Promise<RunRecord> {
    const authoritativeWorkdir = workingDirectoryFor(run);
    const managedAuthoritativeWorkdir =
      path.resolve(authoritativeWorkdir) !== path.resolve(run.repositoryPath);
    const beforeSha =
      inputHeadSha ??
      (run.workspace && run.workspace.baseSha !== "not-a-git-repository"
        ? await gitRevParse(authoritativeWorkdir)
        : undefined);
    let speculative: SpeculativeRoleWorktree | undefined;
    let baselineTreeSha: string | undefined;
    let ignoredInputPaths: string[] = [];
    let authoritativeSourceFingerprint: string | undefined;
    let managedBaselineCaptured = false;
    let authoritativeWasClean = true;
    let completed: RunRecord | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;
    let cleanupError: unknown;
    let hasCleanupError = false;
    try {
      if (run.workspace && run.workspace.baseSha !== "not-a-git-repository" && beforeSha) {
        await this.assertExpectedGitPublicationInput(
          run,
          beforeSha,
          `${spec.label} speculative execution`,
        );
        authoritativeSourceFingerprint = await captureWorkspaceSourceFingerprint(
          authoritativeWorkdir,
        );
        managedBaselineCaptured = managedAuthoritativeWorkdir;
        authoritativeWasClean = await isGitWorkspaceClean(authoritativeWorkdir);
        speculative = await this.createSpeculativeRoleWorktree(
          authoritativeWorkdir,
          beforeSha,
          spec.role,
        );
        const speculativeBaseline = await this.seedSpeculativeRoleWorktree(
          speculative,
          beforeSha,
        );
        baselineTreeSha = speculativeBaseline.treeSha;
        ignoredInputPaths = speculativeBaseline.ignoredInputPaths;
        const stableSourceFingerprint = await captureWorkspaceSourceFingerprint(
          authoritativeWorkdir,
        );
        if (stableSourceFingerprint !== authoritativeSourceFingerprint) {
          throw new Error(
            `Authoritative ${spec.label.toLowerCase()} baseline changed while it was being captured`,
          );
        }
      }
      const roleWorkdir = speculative?.worktreePath ?? authoritativeWorkdir;
      const prompt = await buildRolePrompt(spec.role, run, this.store);
      const result = await this.executeAgent(
        run,
        spec.role,
        prompt,
        undefined,
        roleWorkdir,
        speculative !== undefined,
      );
      const markers = parseRoleMarker(spec.role, result.output);
      if (!markers.ok) throw new Error(markers.message);
      await this.store.writeArtifact(run, spec.artifactName, result.output);
      const fence = this.captureOptionalRevalidationFence(run);

      let outputHeadSha = beforeSha;
      if (speculative && beforeSha) {
        await assertExpectedBranch(roleWorkdir, speculative.branch);
        const afterRoleSha = await gitRevParse(roleWorkdir);
        if (afterRoleSha !== beforeSha) {
          throw new Error(
            `HEAD moved during ${spec.label.toLowerCase()} execution (model-created commit, reset, or rebase is not allowed)`,
          );
        }
        await this.prepareSpeculativeRoleIndex(
          speculative,
          beforeSha,
          ignoredInputPaths,
        );
        await this.assertNoMasweControlPlaneChanges(roleWorkdir);
        await assertWorkingTreeScope(roleWorkdir, run.config.policy.allowedPathGlobs);
      }
      completed = await this.withRunPublicationFence(run, spec.phase, fence, async () => {
        if (speculative && run.workspace && beforeSha) {
          const committed = await createDeterministicCommit(
            roleWorkdir,
            spec.commitMessage,
            {
              allowedPathGlobs: run.config.policy.allowedPathGlobs,
              expectedParentSha: beforeSha,
            },
          );
          if (!(await isGitWorkspaceClean(roleWorkdir))) {
            throw new Error(
              `Speculative ${spec.label.toLowerCase()} worktree remained dirty after deterministic commit`,
            );
          }
          if (committed.files.length > 0) {
            await assertChangeScope(
              roleWorkdir,
              run.workspace.baseSha,
              run.config.policy.allowedPathGlobs,
            );
          }
          let roleDelta = "";
          if (!baselineTreeSha) {
            throw new Error(
              `${spec.label} publication has no captured baseline tree`,
            );
          }
          const delta = await gitRun(
            [
              "diff",
              "--binary",
              "--full-index",
              "--no-ext-diff",
              "--no-renames",
              baselineTreeSha,
              committed.headSha,
              "--",
              ...MASWE_SOURCE_PATHSPEC,
            ],
            roleWorkdir,
          );
          if (delta.exitCode !== 0) {
            throw gitCommandFailure(
              `Failed to capture speculative ${spec.label.toLowerCase()} changes`,
              delta,
            );
          }
          roleDelta = delta.stdout;
          await this.cleanupSpeculativeRoleWorktree(speculative);
          await this.afterSpeculativeRoleCleanupBeforePublication?.();
          await this.assertExpectedGitPublicationInput(
            run,
            beforeSha,
            `${spec.label} commit publication`,
          );
          const currentSourceFingerprint = await captureWorkspaceSourceFingerprint(
            authoritativeWorkdir,
          );
          if (currentSourceFingerprint !== authoritativeSourceFingerprint) {
            throw new Error(
              `Authoritative ${spec.label.toLowerCase()} baseline changed before publication`,
            );
          }
          await this.assertNoMasweControlPlaneChanges(authoritativeWorkdir);
          let publishedHeadSha = committed.headSha;
          if (authoritativeWasClean) {
            if (!(await isGitWorkspaceClean(authoritativeWorkdir))) {
              throw new Error(
                `${spec.label} commit publication requires its captured clean baseline`,
              );
            }
          }
          if (committed.headSha !== beforeSha) {
            await this.publishRoleCommit(
              authoritativeWorkdir,
              run.workspace.branch,
              beforeSha,
              committed.headSha,
              roleDelta,
              !authoritativeWasClean,
              managedAuthoritativeWorkdir,
            );
          }
          outputHeadSha = publishedHeadSha;
          run.workspace.headSha = publishedHeadSha;
          invalidateStaleEvidence(run, publishedHeadSha);
          await this.assertExactGitPublicationState(
            run,
            publishedHeadSha,
            `${spec.label} event publication`,
          );
        }
        const evaluatedHeadSha = outputHeadSha ?? beforeSha ?? run.workspace?.headSha;
        return this.store.applyEvent(run, spec.successEvent, spec.actor, {
          ...runtimeEventIdentityDetails(result),
          marker: markers.marker,
          ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
          ...(evaluatedHeadSha
            ? { headSha: evaluatedHeadSha, outputHeadSha: evaluatedHeadSha }
            : {}),
        });
      }, ownedLease);
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    } finally {
      if (speculative && !speculative.cleaned) {
        try {
          await this.cleanupSpeculativeRoleWorktree(speculative);
        } catch (error) {
          cleanupError = error;
          hasCleanupError = true;
        }
      }
    }
    const preserveManagedFailure = (error: unknown): unknown =>
      managedBaselineCaptured && !requiresWorkspacePreservation(error)
        ? new RolePublicationOutcomeUnknownError(
            [error],
            `${runFailureMessage(error)}; ${spec.label} failed after the managed authoritative baseline was captured, so the workspace was preserved for operator reconciliation`,
          )
        : error;
    if (hasPrimaryError && hasCleanupError) {
      throw preserveManagedFailure(
        new AggregateError(
          [primaryError, cleanupError],
          `${spec.label} execution and speculative worktree cleanup failed`,
        ),
      );
    }
    if (hasCleanupError) throw preserveManagedFailure(cleanupError);
    if (hasPrimaryError) throw preserveManagedFailure(primaryError);
    if (!completed) {
      throw new Error(`${spec.label} publication completed without a run record`);
    }
    return completed;
  }

  private async failRun(
    run: RunRecord,
    message: string,
    code: RunFailureCode = "workflow-failure",
    runtime?: DurableRuntimeFailureSummary,
    options: {
      preservationReason?: TerminalCleanupPreservationReason;
      deferTerminalFinalization?: boolean;
    } = {},
  ): Promise<RunRecord> {
    const resumeState = isTerminal(run.state) ? undefined : run.state;
    if (options.preservationReason === "bootstrap-recovery" && resumeState !== "CREATED") {
      throw new Error("Workspace preservation is allowed only for a CREATED bootstrap failure");
    }
    const finishFailure = (record: RunRecord): Promise<RunRecord> =>
      options.preservationReason || options.deferTerminalFinalization
        ? Promise.resolve(record)
        : this.finalizeTerminal(record);
    const safeMessage = safeFailureMessage(message);
    const candidate = structuredClone(run);
    candidate.failure = {
      code,
      message: safeMessage,
      at: new Date().toISOString(),
      ...(resumeState ? { resumeState } : {}),
      ...(runtime ? { runtime } : {}),
    };
    attachTerminalCleanupIntent(candidate, options.preservationReason);
    if (isTerminal(candidate.state)) {
      await this.store.save(candidate);
      return finishFailure(candidate);
    }

    const prior = await this.store.load(run.id);
    const priorEventIds = new Set(prior.events.map((event) => event.id));
    let failed: RunRecord;
    try {
      failed = await this.store.applyEvent(candidate, "FAIL", "orchestrator", {
        ...runFailureDetails(code, safeMessage, runtime),
        ...(resumeState ? { resumeState } : {}),
      });
    } catch (error) {
      const observed = await this.store.load(run.id);
      const newEvents = observed.events.filter((event) => !priorEventIds.has(event.id));
      const observedEvent = newEvents[0];
      const expectedNewEvents = candidate.events.filter((event) => !priorEventIds.has(event.id));
      const expectedEvent = expectedNewEvents[0];
      const priorRecordIsUnchanged = this.recordsEqual(observed, prior);
      if (priorRecordIsUnchanged) throw error;

      const completePublication =
        this.recordsEqual(observed, candidate) &&
        newEvents.length === 1 &&
        expectedNewEvents.length === 1 &&
        observedEvent !== undefined &&
        expectedEvent !== undefined &&
        observedEvent.id === expectedEvent.id &&
        observedEvent.type === "FAIL" &&
        observedEvent.from === resumeState &&
        observedEvent.to === "FAILED";
      if (completePublication) return finishFailure(observed);

      throw new Error(
        "Failure publication outcome is ambiguous: authoritative state is neither unchanged nor a complete failed run.",
        { cause: error },
      );
    }
    return finishFailure(failed);
  }

  private async executeRole(
    run: RunRecord,
    role: RoleId,
    artifactName: string,
    successEvent: "BRAINSTORM_COMPLETED" | "DESIGN_COMPLETED",
    headSha?: string,
  ): Promise<RunRecord> {
    const prompt = await buildRolePrompt(role, run, this.store);
    const result = await this.executeAgent(run, role, prompt);
    const markers = parseRoleMarker(role, result.output);
    if (!markers.ok) throw new Error(markers.message);
    await this.store.writeArtifact(run, artifactName, result.output);
    const evaluatedSha = headSha ?? run.workspace?.headSha;
    return this.store.applyEvent(run, successEvent, role, {
      ...runtimeEventIdentityDetails(result),
      marker: markers.marker,
      ...(evaluatedSha ? { headSha: evaluatedSha } : {}),
    });
  }

  private async executeAgent(
    run: RunRecord,
    role: RoleId,
    prompt: string,
    executionOptions?: { permissionOverride?: PermissionMode },
    workdirOverride?: string,
    managedWorktreeOverride?: boolean,
  ): Promise<RuntimeFinishedResult> {
    const configured = run.config.roles[role];
    const permissions = resolveExecutionPermission(
      role,
      configured.permissions,
      executionOptions?.permissionOverride,
    );
    const effective = { ...configured, permissions };
    const candidates = run.config.policy.rejectModelFallback
      ? [effective.model]
      : [effective.model, ...(effective.fallbackModels ?? [])];
    let aggregate = `${role} failed for all configured models: `;
    let aggregateHasEntries = false;
    let aggregateFull = false;
    let aggregateOmittedAttempts = 0;
    let totalFailureAttempts = 0;
    const durableAttempts: DurableRuntimeFailureAttempt[] = [];
    const workdir = workdirOverride ?? workingDirectoryFor(run);

    for (const model of candidates) {
      let trustedModel = model;
      const before = permissions === "read-only"
        ? await captureReadOnlyExecutionState(workdir)
        : undefined;
      let runtimeOutcome:
        | { ok: true; result: Awaited<ReturnType<AgentRuntime["execute"]>> }
        | { ok: false; error: unknown };
      try {
        const catalogue = await this.runtime.listModels();
        if (catalogue.length > 0) {
          trustedModel = validatePersistedExactModel(model, catalogue);
        }
        runtimeOutcome = {
          ok: true,
          result: await this.runtime.execute({
            runId: run.id,
            role,
            prompt,
            cwd: workdir,
            roleConfig: { ...effective, model: trustedModel },
            timeoutMs: run.config.policy.roleTimeoutMs,
            managedWorktree: managedWorktreeOverride ?? Boolean(
              run.workspace?.worktreePath && path.resolve(workdir) === path.resolve(run.workspace.worktreePath),
            ),
          }),
        };
      } catch (error) {
        runtimeOutcome = { ok: false, error };
      }

      let fenceError: unknown;
      let fenceFailed = false;
      if (before) {
        try {
          await assertReadOnlyExecutionState(workdir, role, before);
        } catch (error) {
          fenceError = error;
          fenceFailed = true;
        }
      }

      const fencePolicyViolation = fenceFailed
        ? findPolicyViolationError(fenceError)
        : undefined;
      const runtimePolicyViolation = runtimeOutcome.ok
        ? undefined
        : findPolicyViolationError(runtimeOutcome.error);
      const policyViolation = fencePolicyViolation ?? runtimePolicyViolation;
      if (policyViolation) throw policyViolation;
      if (fenceFailed) throw fenceError;

      let attemptError: unknown;
      if (runtimeOutcome.ok) {
        const { result } = runtimeOutcome;
        try {
          assertRuntimeIdentity(result, role, trustedModel);
          ensureRuntimeSuccess(result, role);
          return result;
        } catch (error) {
          const resultPolicyViolation = findPolicyViolationError(error);
          if (resultPolicyViolation) throw resultPolicyViolation;
          attemptError = error;
        }
      } else {
        attemptError = runtimeOutcome.error;
      }

      totalFailureAttempts += 1;
      const failure = runtimeAttemptFailure(trustedModel, attemptError);
      if (
        durableAttempts.length <
        DURABLE_RUNTIME_FAILURE_ATTEMPT_LIMIT
      ) {
        durableAttempts.push(failure.durable);
      }
      if (aggregateFull) {
        aggregateOmittedAttempts += 1;
      } else {
        const appended = appendFailureAggregate(
          aggregate,
          failure.rendered,
          aggregateHasEntries,
        );
        aggregate = appended.text;
        aggregateFull = appended.full;
        aggregateHasEntries = true;
      }
    }
    const message = reportOmittedFailureAttempts(
      aggregate,
      aggregateOmittedAttempts,
    );
    throw new RuntimeModelsExhaustedError(
      message,
      makeDurableRuntimeFailureSummary(
        durableAttempts,
        totalFailureAttempts,
        aggregateFull,
      ),
    );
  }

  async markPrOpened(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    return this.store.applyEvent(run, "PR_OPENED", "user");
  }

  async receiveReviewComment(runId: string, comment: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    await this.store.writeArtifact(run, "07-review-comment.md", comment);
    await this.store.applyEvent(run, "REVIEW_COMMENT_RECEIVED", "github");
    return this.runUntilBlocked(run.id);
  }

  async resumeHumanReview(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    return this.store.applyEvent(run, "HUMAN_RESUME", "user");
  }

  private async assertExactCurrentHeadGate(
    run: RunRecord,
    gate: "merge-ready" | "complete",
  ): Promise<string> {
    const label = gate === "merge-ready" ? "Merge-ready" : "Complete";
    if (run.revalidation) {
      throw new Error(`${label} requires revalidation to finish for the current HEAD.`);
    }
    if (
      !run.workspace ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run.workspace.headSha)
    ) {
      throw new Error(`${label} requires a known exact workspace HEAD.`);
    }
    if (!run.config.policy.useIsolatedWorktree || !run.workspace.worktreePath) {
      throw new Error(`${label} requires an isolated MASWE-managed worktree.`);
    }

    const canonicalWorktreePath = path.resolve(externalWorktreePath(run.repositoryPath, run.id));
    if (run.workspace.worktreePath !== canonicalWorktreePath) {
      throw new Error(`${label} requires the canonical MASWE-managed worktree path.`);
    }
    const canonicalBranch = `maswe/${run.id}`;
    if (run.workspace.branch !== canonicalBranch) {
      throw new Error(`${label} requires the canonical MASWE-managed branch ${canonicalBranch}.`);
    }

    const registrations = await listGitWorktreeRegistrations(run.repositoryPath);
    const pathRegistration = registrations.find(
      (registration) => registration.worktreePath === canonicalWorktreePath,
    );
    if (!pathRegistration) {
      throw new Error(`${label} requires a registered canonical MASWE-managed worktree.`);
    }
    if (pathRegistration.prunable) {
      throw new Error(`${label} rejected the prunable canonical worktree registration.`);
    }
    const branchRegistration = registrations.find(
      (registration) => registration.branch === canonicalBranch,
    );
    if (
      pathRegistration.branch !== canonicalBranch ||
      branchRegistration?.worktreePath !== canonicalWorktreePath
    ) {
      throw new Error(`${label} requires the registered path and branch to identify the same worktree.`);
    }
    const expectedHeadSha = run.workspace.headSha;
    if (pathRegistration.headSha !== expectedHeadSha) {
      throw new Error(
        `${label} rejected: registered HEAD ${pathRegistration.headSha} does not match recorded workspace HEAD ${expectedHeadSha}.`,
      );
    }
    await this.assertExactGitPublicationState(run, expectedHeadSha, label);
    const headSha = expectedHeadSha;
    if (run.github && run.github.headSha !== headSha) {
      throw new Error(
        `${label} rejected: associated GitHub HEAD ${run.github.headSha} does not match workspace HEAD ${headSha}.`,
      );
    }
    if (
      (!run.evidence?.quality?.passed || run.evidence.quality.headSha !== headSha)
    ) {
      throw new Error(`${label} requires present, passing quality evidence for the current HEAD.`);
    }
    if (
      (!run.evidence?.verification?.passed || run.evidence.verification.headSha !== headSha)
    ) {
      throw new Error(
        `${label} requires present, passing verification evidence for the current HEAD.`,
      );
    }
    if (
      gate === "complete" &&
      (!run.evidence?.mergeReady?.passed || run.evidence.mergeReady.headSha !== headSha)
    ) {
      throw new Error("Complete requires current, passing merge-ready evidence for the current HEAD.");
    }
    await this.assertExactGitPublicationState(run, headSha, label);
    return headSha;
  }

  private async withFinalGatePublicationFence(
    runId: string,
    gate: "merge-ready" | "complete",
    publish: (run: RunRecord, headSha: string) => Promise<RunRecord>,
  ): Promise<RunRecord> {
    const loaded = await this.store.load(runId);
    const initial = await this.preflightCommittedAssociationHead(loaded);
    return withRunMutationFence(
      initial.repositoryPath,
      runId,
      "publication",
      async (lease) => {
        const authoritative = await this.store.load(runId);
        if (
          authoritative.repositoryPath !== initial.repositoryPath ||
          authoritative.version !== initial.version
        ) {
          throw new Error(
            `Run ${runId} changed before ${gate} publication: expected version ${initial.version}, authoritative ${authoritative.version}`,
          );
        }
        if (gate === "complete" && authoritative.state !== "MERGE_READY") {
          throw new Error(`complete requires MERGE_READY, currently ${authoritative.state}`);
        }
        await this.afterRunMutationReload?.(gate, authoritative);
        await lease.assertNoQueuedTargetMutation();
        const headSha = await this.assertExactCurrentHeadGate(authoritative, gate);
        return publish(authoritative, headSha);
      },
    );
  }

  async markMergeReady(runId: string): Promise<RunRecord> {
    return this.withFinalGatePublicationFence(runId, "merge-ready", async (run, headSha) => {
      run.evidence = {
        ...(run.evidence ?? {}),
        mergeReady: {
          headSha,
          passed: true,
          at: new Date().toISOString(),
        },
      };
      return this.store.applyEvent(run, "MARK_MERGE_READY", "user", {
        headSha,
      });
    });
  }

  async complete(runId: string): Promise<RunRecord> {
    const completed = await this.withFinalGatePublicationFence(
      runId,
      "complete",
      async (run, headSha) => {
        attachTerminalCleanupIntent(run);
        return this.store.applyEvent(run, "COMPLETE", "user", {
          headSha,
          mergeReadySha: headSha,
        });
      },
    );
    return this.finalizeTerminal(completed);
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    attachTerminalCleanupIntent(run);
    const cancelled = await this.store.applyEvent(run, "CANCEL", "user");
    return this.finalizeTerminal(cancelled);
  }

  private async reconcileFailedRevalidationTarget(
    prior: RunRecord,
    lease: RunMutationLease,
  ): Promise<RunRecord> {
    let snapshot = prior;
    for (let attempt = 0; attempt < REVALIDATION_STABILITY_ATTEMPTS; attempt += 1) {
      if (!snapshot.revalidation) return snapshot;
      const observed = structuredClone(snapshot);
      const observedHeadSha = await this.observeRevalidationWorkspace(observed);
      if (!observedHeadSha || !observed.workspace) {
        throw new Error(`Run ${prior.id} has no exact retry revalidation workspace`);
      }
      const exactWorkspace = await reconcileRetryWorkspace(this.cwd, observed);
      if (!exactWorkspace) {
        throw new Error(`Run ${prior.id} has no exact retry revalidation workspace`);
      }
      const source = snapshot.github ? "github" : "local-workspace";
      const requiredHeadSha = snapshot.github?.headSha ?? observedHeadSha;
      const workspaceForRoute =
        snapshot.revalidation.requestedHeadSha === requiredHeadSha &&
        exactWorkspace.headSha !== requiredHeadSha
          ? undefined
          : exactWorkspace;

      let routed: RunRecord;
      try {
        routed = await new RevalidationService(
          this.store,
        ).routeWithHeldTerminalRecoveryLease(
          prior.id,
          {
            source,
            previousHeadSha: snapshot.revalidation.requestedHeadSha,
            requestedHeadSha: requiredHeadSha,
            expectedRunVersion: snapshot.version,
            actor: source === "github" ? "github-app" : "local-runner",
            ...(workspaceForRoute ? { observedWorkspace: workspaceForRoute } : {}),
          },
          lease,
        );
      } catch (error) {
        if (!(error instanceof RevalidationOptimisticConflictError)) throw error;
        snapshot = await this.store.load(prior.id);
        continue;
      }

      const authoritative = await this.store.load(prior.id);
      if (!this.recordsEqual(authoritative, routed)) {
        snapshot = authoritative;
        continue;
      }
      if (!authoritative.revalidation) return authoritative;
      const stableRequiredHeadSha = authoritative.github?.headSha ?? observedHeadSha;
      if (authoritative.revalidation.requestedHeadSha !== stableRequiredHeadSha) {
        snapshot = authoritative;
        continue;
      }
      return authoritative;
    }
    throw new Error(`Run ${prior.id} retry revalidation target did not stabilize`);
  }

  async retryFromFailed(runId: string): Promise<RunRecord> {
    let resumed = await withRunMutationFence(
      this.cwd,
      runId,
      "terminal-recovery",
      async (lease) => {
        let authoritative = await this.store.load(runId);
        const requireRetryableFailure = (): void => {
          if (
            authoritative.state !== "FAILED" ||
            !authoritative.failure?.resumeState ||
            !authoritative.failure
          ) {
            throw new Error("retry requires a FAILED run with failure.resumeState");
          }
          if (authoritative.supersededBy) {
            throw new Error(
              `Run ${runId} was already superseded by ${authoritative.supersededBy}`,
            );
          }
        };
        requireRetryableFailure();
        authoritative = await this.reconcileFailedRevalidationTarget(
          authoritative,
          lease,
        );
        requireRetryableFailure();
        const failure = authoritative.failure;
        const resumeState = failure?.resumeState;
        if (!failure || !resumeState) {
          throw new Error("retry requires a FAILED run with failure.resumeState");
        }
        const previousFailure = structuredClone(failure);
        const priorEventIds = new Set(authoritative.events.map((event) => event.id));
        const retryFence = this.captureOptionalRevalidationFence(authoritative);
        const candidate = structuredClone(authoritative);
        const workspace = await reconcileRetryWorkspace(this.cwd, candidate);
        if (workspace) candidate.workspace = workspace;
        else delete candidate.workspace;
        delete candidate.failure;
        delete candidate.terminalCleanup;
        await this.beforeRetryPublication?.(candidate);
        await this.assertOptionalRevalidationFence(authoritative, retryFence);
        const publicationCandidate = structuredClone(candidate);

        try {
          return await this.store.applyEvent(candidate, "RETRY_FROM_FAILED", "user", {
            resumeState,
            previousFailure,
          });
        } catch (error) {
          const observed = await this.store.load(runId);
          const newEvents = observed.events.filter((event) => !priorEventIds.has(event.id));
          const retryEvent = newEvents.length === 1 ? newEvents[0] : undefined;
          const historicalPrefixExact =
            observed.events.length === authoritative.events.length + 1 &&
            this.recordsEqual(
              {
                ...authoritative,
                events: observed.events.slice(0, authoritative.events.length),
              },
              authoritative,
            );
          const expected = structuredClone(publicationCandidate);
          expected.state = resumeState;
          expected.version = observed.version;
          expected.updatedAt = observed.updatedAt;
          expected.events = observed.events;
          const completePublication =
            observed.version === authoritative.version + 1 &&
            areCanonicalFileStoreTimestamps(
              authoritative.updatedAt,
              retryEvent?.at,
              observed.updatedAt,
            ) &&
            historicalPrefixExact &&
            observed.failure === undefined &&
            retryEvent?.type === "RETRY_FROM_FAILED" &&
            retryEvent.actor === "user" &&
            retryEvent.from === "FAILED" &&
            retryEvent.to === resumeState &&
            this.recordsEqual(retryEvent.details, { resumeState, previousFailure }) &&
            this.recordsEqual(observed, expected);
          if (completePublication) {
            return observed;
          }
          const unchangedPrior = this.recordsEqual(observed, authoritative);
          const oneStepConflict = structuredClone(authoritative);
          oneStepConflict.version = authoritative.version + 1;
          oneStepConflict.updatedAt = observed.updatedAt;
          const validOneStepConflict =
            observed.version === authoritative.version + 1 &&
            areCanonicalFileStoreTimestamps(
              authoritative.updatedAt,
              undefined,
              observed.updatedAt,
            ) &&
            this.recordsEqual(observed, oneStepConflict);
          const originalRetryRemains =
            newEvents.length === 0 &&
            observed.state === "FAILED" &&
            this.recordsEqual(observed.failure, previousFailure) &&
            (unchangedPrior || validOneStepConflict);
          if (originalRetryRemains) throw error;
          throw new Error(
            "Retry publication outcome is inconsistent: authoritative state is neither the original retryable FAILED record nor one complete retry publication.",
            { cause: error },
          );
        }
      },
    );

    if (resumed.state === "CREATED") {
      resumed = await this.bootstrapCreatedRun(resumed.id);
    }
    return this.runUntilBlocked(resumed.id);
  }

  async supersede(runId: string): Promise<RunRecord> {
    const existing = await this.store.load(runId);
    if (existing.supersededBy) {
      throw new Error(`Run ${runId} was already superseded by ${existing.supersededBy}`);
    }
    const replacement = await this.createPlannedRun(
      existing.title,
      existing.request,
      existing.config,
      { supersedes: existing.id },
    );
    const abandoned = await withRunMutationFence(
      this.cwd,
      runId,
      "terminal-recovery",
      async () => {
        const authoritative = await this.store.load(runId);
        if (authoritative.supersededBy) {
          throw new Error(
            `Run ${runId} was already superseded by ${authoritative.supersededBy}`,
          );
        }
        authoritative.supersededBy = replacement.id;
        if (!isTerminal(authoritative.state)) {
          authoritative.failure = {
            message: `Superseded by ${replacement.id}`,
            at: new Date().toISOString(),
            resumeState: authoritative.state as WorkflowState,
          };
          attachTerminalCleanupIntent(authoritative);
          return this.store.applyEvent(authoritative, "CANCEL", "user", {
            reason: "superseded",
            supersededBy: replacement.id,
          });
        }
        if (
          authoritative.terminalCleanup === undefined ||
          authoritative.terminalCleanup.status === "preserved" ||
          authoritative.terminalCleanup.lastError?.code === "cleanup-legacy-state-ambiguous"
        ) {
          attachTerminalCleanupIntent(authoritative);
        }
        await this.store.save(authoritative);
        return this.store.load(runId);
      },
    );
    await this.finalizeTerminal(abandoned);
    await this.bootstrapCreatedRun(replacement.id);
    return this.runUntilBlocked(replacement.id);
  }
}
