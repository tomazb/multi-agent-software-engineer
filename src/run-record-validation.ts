import { assertSafeRunId } from "./git-workspace.ts";
import path from "node:path";
import {
  WORKFLOW_EVENTS,
  WORKFLOW_STATES,
  type ArtifactReference,
  type MasweConfig,
  type RunRecord,
  type RunTerminalCleanup,
  type TerminalCleanupFailureCode,
  type TerminalCleanupPreservationReason,
  type TerminalCleanupStatus,
  type WorkflowEvent,
  type WorkflowEventType,
  type WorkflowState,
} from "./domain.ts";

function exactObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unsupported) throw new Error(`Unsupported ${label} field: ${unsupported}`);
  const missing = required.find((key) => !(key in record));
  if (missing) throw new Error(`${label}.${missing} is required`);
  return record;
}

export function requiredRunRecordString(
  value: unknown,
  label: string,
  allowEmpty = true,
): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

export function nonNegativeRunRecordInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function validateWorkspace(value: unknown): NonNullable<RunRecord["workspace"]> {
  const workspace = exactObject(
    value,
    "run record workspace",
    ["remote", "baseSha", "headSha", "branch", "fingerprint", "worktreePath"],
    ["baseSha", "headSha", "branch", "fingerprint"],
  );
  return {
    ...(workspace.remote !== undefined
      ? { remote: requiredRunRecordString(workspace.remote, "Run record workspace.remote") }
      : {}),
    baseSha: requiredRunRecordString(workspace.baseSha, "Run record workspace.baseSha"),
    headSha: requiredRunRecordString(workspace.headSha, "Run record workspace.headSha"),
    branch: requiredRunRecordString(workspace.branch, "Run record workspace.branch"),
    fingerprint: requiredRunRecordString(
      workspace.fingerprint,
      "Run record workspace.fingerprint",
    ),
    ...(workspace.worktreePath !== undefined
      ? {
          worktreePath: requiredRunRecordString(
            workspace.worktreePath,
            "Run record workspace.worktreePath",
          ),
        }
      : {}),
  };
}

function validateWorkspaceBootstrap(
  value: unknown,
): NonNullable<RunRecord["workspaceBootstrap"]> {
  const bootstrap = exactObject(
    value,
    "run record workspaceBootstrap",
    [
      "mode",
      "sourceBaseSha",
      "sourceBranch",
      "sourceTreeFingerprint",
      "remote",
      "plannedAt",
      "plannedWorktreePath",
    ],
    ["mode", "sourceBaseSha", "sourceBranch", "sourceTreeFingerprint", "plannedAt"],
  );
  if (bootstrap.mode !== "operator-checkout" && bootstrap.mode !== "isolated-worktree") {
    throw new Error("Run record workspaceBootstrap.mode is invalid");
  }
  return {
    mode: bootstrap.mode,
    sourceBaseSha: canonicalGitObjectName(
      bootstrap.sourceBaseSha,
      "Run record workspaceBootstrap.sourceBaseSha",
      true,
    ),
    sourceBranch: canonicalNonEmptyString(
      bootstrap.sourceBranch,
      "Run record workspaceBootstrap.sourceBranch",
    ),
    sourceTreeFingerprint: canonicalLowerHex(
      bootstrap.sourceTreeFingerprint,
      "Run record workspaceBootstrap.sourceTreeFingerprint",
      [64],
    ),
    ...(bootstrap.remote !== undefined
      ? {
          remote: canonicalNonEmptyString(
            bootstrap.remote,
            "Run record workspaceBootstrap.remote",
          ),
        }
      : {}),
    plannedAt: canonicalTimestamp(
      bootstrap.plannedAt,
      "Run record workspaceBootstrap.plannedAt",
    ),
    ...(bootstrap.plannedWorktreePath !== undefined
      ? {
          plannedWorktreePath: canonicalPortableDurableAbsolutePath(
            bootstrap.plannedWorktreePath,
            "Run record workspaceBootstrap.plannedWorktreePath",
          ),
        }
      : {}),
  };
}

function canonicalNonEmptyString(value: unknown, label: string): string {
  const result = requiredRunRecordString(value, label, false);
  if (result !== result.trim()) throw new Error(`${label} must be canonical`);
  return result;
}

/**
 * Host-independent durable absolute-path grammar for plannedWorktreePath.
 * Kept in lockstep with schemas/run-record.schema.json plannedWorktreePath.pattern:
 * POSIX absolute, Windows drive-letter absolute, and UNC; rejects drive-less
 * rooted Windows paths and any complete string ending in canonical whitespace.
 */
export const PORTABLE_DURABLE_ABSOLUTE_PATH_PATTERN =
  /^(?:\/.*|[A-Za-z]:[\\/].*|\\\\[^\\/]+\\[^\\/]+(?:[\\/].*)?)(?<!\s)$/;

export function isPortableDurableAbsolutePath(value: string): boolean {
  return PORTABLE_DURABLE_ABSOLUTE_PATH_PATTERN.test(value);
}

function canonicalPortableDurableAbsolutePath(value: unknown, label: string): string {
  const result = canonicalNonEmptyString(value, label);
  if (!isPortableDurableAbsolutePath(result)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return result;
}

function canonicalLowerHex(
  value: unknown,
  label: string,
  lengths: readonly number[],
): string {
  const result = canonicalNonEmptyString(value, label);
  if (!lengths.includes(result.length) || !/^[a-f0-9]+$/.test(result)) {
    throw new Error(`${label} must be a canonical lowercase hexadecimal value`);
  }
  return result;
}

function canonicalGitObjectName(
  value: unknown,
  label: string,
  allowNonGit: boolean,
): string {
  const result = canonicalNonEmptyString(value, label);
  if (allowNonGit && result === "not-a-git-repository") return result;
  return canonicalLowerHex(result, label, [40, 64]);
}

function canonicalTimestamp(value: unknown, label: string): string {
  const result = canonicalNonEmptyString(value, label);
  const epoch = Date.parse(result);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== result) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return result;
}

function canonicalTerminalCleanupTimestamp(value: unknown, label: string): string {
  const result = canonicalTimestamp(value, label);
  if (!/^\d{4}-/.test(result)) {
    throw new Error(`${label} must use an unsigned four-digit year`);
  }
  return result;
}

function validateRevalidation(value: unknown): NonNullable<RunRecord["revalidation"]> {
  const revalidation = exactObject(
    value,
    "run record revalidation",
    [
      "returnState",
      "source",
      "originHeadSha",
      "requestedHeadSha",
      "generation",
      "requestedAt",
      "updatedAt",
    ],
  );
  if (revalidation.returnState !== "PR_READY" && revalidation.returnState !== "PR_REVIEW") {
    throw new Error("Run record revalidation.returnState is invalid");
  }
  if (revalidation.source !== "local-workspace" && revalidation.source !== "github") {
    throw new Error("Run record revalidation.source is invalid");
  }
  const generation = nonNegativeRunRecordInteger(
    revalidation.generation,
    "Run record revalidation.generation",
  );
  if (generation < 1) {
    throw new Error("Run record revalidation.generation must be a positive integer");
  }
  return {
    returnState: revalidation.returnState,
    source: revalidation.source,
    originHeadSha: canonicalGitObjectName(
      revalidation.originHeadSha,
      "Run record revalidation.originHeadSha",
      false,
    ),
    requestedHeadSha: canonicalGitObjectName(
      revalidation.requestedHeadSha,
      "Run record revalidation.requestedHeadSha",
      false,
    ),
    generation,
    requestedAt: canonicalTimestamp(
      revalidation.requestedAt,
      "Run record revalidation.requestedAt",
    ),
    updatedAt: canonicalTimestamp(
      revalidation.updatedAt,
      "Run record revalidation.updatedAt",
    ),
  };
}

const ACTIVE_REVALIDATION_STATES = new Set<WorkflowState>([
  "BUILDING",
  "CI_RUNNING",
  "VERIFYING",
]);

function validateRecoveryLifecycle(run: RunRecord): void {
  if (run.workspaceBootstrap && run.revalidation) {
    throw new Error("Run record cannot contain both workspaceBootstrap and revalidation lifecycles");
  }

  if (run.workspaceBootstrap) {
    const expectedMode = run.config.policy.useIsolatedWorktree
      ? "isolated-worktree"
      : "operator-checkout";
    if (run.workspaceBootstrap.mode !== expectedMode) {
      throw new Error(
        `Run record workspaceBootstrap mode conflicts with policy mode ${expectedMode}`,
      );
    }
    if (
      run.workspaceBootstrap.mode === "operator-checkout" &&
      run.workspaceBootstrap.plannedWorktreePath !== undefined
    ) {
      throw new Error(
        "Run record operator-checkout workspaceBootstrap cannot include plannedWorktreePath",
      );
    }
    if (
      run.workspace?.worktreePath !== undefined &&
      run.workspaceBootstrap.plannedWorktreePath !== undefined &&
      path.resolve(run.workspace.worktreePath) !==
        path.resolve(run.workspaceBootstrap.plannedWorktreePath)
    ) {
      throw new Error(
        "Run record workspace.worktreePath disagrees with workspaceBootstrap.plannedWorktreePath",
      );
    }
    const resumeState = run.failure?.resumeState;
    const legal =
      (run.state === "CREATED" && run.failure === undefined) ||
      (run.state === "FAILED" && resumeState === "CREATED") ||
      (run.state === "CANCELLED" &&
        (run.failure === undefined || resumeState === "CREATED"));
    if (!legal) {
      throw new Error(
        `Run record workspaceBootstrap state ${run.state} has an invalid bootstrap resume state`,
      );
    }
  }

  if (run.revalidation) {
    const resumeState = run.failure?.resumeState;
    const legal =
      (ACTIVE_REVALIDATION_STATES.has(run.state) && run.failure === undefined) ||
      (run.state === "FAILED" &&
        resumeState !== undefined &&
        ACTIVE_REVALIDATION_STATES.has(resumeState)) ||
      (run.state === "CANCELLED" &&
        (run.failure === undefined ||
          (resumeState !== undefined && ACTIVE_REVALIDATION_STATES.has(resumeState))));
    if (!legal) {
      throw new Error(
        `Run record revalidation state ${run.state} has an invalid revalidation resume state`,
      );
    }
  }
}

function validateEvidence(value: unknown): NonNullable<RunRecord["evidence"]> {
  const evidence = exactObject(
    value,
    "run record evidence",
    ["quality", "verification", "mergeReady"],
    [],
  );
  const result: NonNullable<RunRecord["evidence"]> = {};
  for (const key of ["quality", "verification", "mergeReady"] as const) {
    if (evidence[key] === undefined) continue;
    const binding = exactObject(
      evidence[key],
      `run record evidence.${key}`,
      ["headSha", "passed", "at"],
    );
    if (typeof binding.passed !== "boolean") {
      throw new Error(`Run record evidence.${key}.passed must be a boolean`);
    }
    result[key] = {
      headSha: requiredRunRecordString(
        binding.headSha,
        `Run record evidence.${key}.headSha`,
      ),
      passed: binding.passed,
      at: requiredRunRecordString(binding.at, `Run record evidence.${key}.at`),
    };
  }
  return result;
}

function validateEvents(value: unknown): WorkflowEvent[] {
  if (!Array.isArray(value)) throw new Error("Run record events must be an array");
  return value.map((item, index) => {
    const event = exactObject(
      item,
      `run record event[${index}]`,
      ["id", "at", "type", "actor", "from", "to", "details"],
      ["id", "at", "type", "actor", "from", "to"],
    );
    if (!WORKFLOW_EVENTS.includes(event.type as WorkflowEventType)) {
      throw new Error(`Run record event[${index}].type is invalid`);
    }
    if (!WORKFLOW_STATES.includes(event.from as WorkflowState)) {
      throw new Error(`Run record event[${index}].from is invalid`);
    }
    if (!WORKFLOW_STATES.includes(event.to as WorkflowState)) {
      throw new Error(`Run record event[${index}].to is invalid`);
    }
    if (
      event.details !== undefined &&
      (!event.details || typeof event.details !== "object" || Array.isArray(event.details))
    ) {
      throw new Error(`Run record event[${index}].details must be an object`);
    }
    return {
      id: requiredRunRecordString(event.id, `Run record event[${index}].id`, false),
      at: requiredRunRecordString(event.at, `Run record event[${index}].at`),
      type: event.type as WorkflowEventType,
      actor: requiredRunRecordString(event.actor, `Run record event[${index}].actor`),
      from: event.from as WorkflowState,
      to: event.to as WorkflowState,
      ...(event.details !== undefined
        ? { details: event.details as Record<string, unknown> }
        : {}),
    };
  });
}

function validateFailure(value: unknown): NonNullable<RunRecord["failure"]> {
  const failure = exactObject(
    value,
    "run record failure",
    ["code", "message", "at", "resumeState", "runtime"],
    ["message", "at"],
  );
  if (
    failure.code !== undefined &&
    failure.code !== "runtime-models-exhausted" &&
    failure.code !== "workflow-failure" &&
    failure.code !== "automatic-transition-limit-exceeded" &&
    failure.code !== "policy-read-only-workspace-mutation" &&
    failure.code !== "policy-runtime-identity-mismatch" &&
    failure.code !== "policy-role-permission-mismatch" &&
    failure.code !== "policy-read-only-head-moved"
  ) {
    throw new Error("Run record failure.code is invalid");
  }
  if (
    failure.resumeState !== undefined &&
    !WORKFLOW_STATES.includes(failure.resumeState as WorkflowState)
  ) {
    throw new Error("Run record failure.resumeState is invalid");
  }
  return {
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    message: requiredRunRecordString(failure.message, "Run record failure.message"),
    at: requiredRunRecordString(failure.at, "Run record failure.at"),
    ...(failure.resumeState !== undefined
      ? { resumeState: failure.resumeState as WorkflowState }
      : {}),
    ...(failure.runtime !== undefined
      ? {
          runtime: failure.runtime as NonNullable<
            NonNullable<RunRecord["failure"]>["runtime"]
          >,
        }
      : {}),
  };
}

const TERMINAL_CLEANUP_STATUSES = [
  "pending",
  "complete",
  "failed",
  "preserved",
] as const satisfies readonly TerminalCleanupStatus[];

const TERMINAL_CLEANUP_PRESERVATION_REASONS = [
  "bootstrap-recovery",
  "revalidation-recovery",
  "publication-outcome-unknown",
] as const satisfies readonly TerminalCleanupPreservationReason[];

const TERMINAL_CLEANUP_FAILURE_CODES = [
  "cleanup-inspection-failed",
  "cleanup-ownership-mismatch",
  "cleanup-remove-failed",
  "cleanup-postcondition-failed",
  "cleanup-legacy-state-ambiguous",
] as const satisfies readonly TerminalCleanupFailureCode[];

function validateTerminalCleanup(value: unknown): NonNullable<RunRecord["terminalCleanup"]> {
  const cleanup = exactObject(
    value,
    "run record terminalCleanup",
    ["status", "updatedAt", "preservationReason", "lastError"],
    ["status", "updatedAt"],
  );
  if (
    !TERMINAL_CLEANUP_STATUSES.includes(cleanup.status as TerminalCleanupStatus)
  ) {
    throw new Error("Run record terminalCleanup.status is invalid");
  }
  const status = cleanup.status as TerminalCleanupStatus;
  const updatedAt = canonicalTerminalCleanupTimestamp(
    cleanup.updatedAt,
    "Run record terminalCleanup.updatedAt",
  );
  const hasPreservationReason = cleanup.preservationReason !== undefined;
  const hasLastError = cleanup.lastError !== undefined;

  if (status === "pending" || status === "complete") {
    if (hasPreservationReason) {
      throw new Error(
        "Run record terminalCleanup must not include preservationReason for pending or complete status",
      );
    }
    if (hasLastError) {
      throw new Error(
        "Run record terminalCleanup must not include lastError for pending or complete status",
      );
    }
    return { status, updatedAt };
  }

  if (status === "preserved") {
    if (!hasPreservationReason) {
      throw new Error(
        "Run record terminalCleanup.preservationReason is required for preserved status",
      );
    }
    if (hasLastError) {
      throw new Error(
        "Run record terminalCleanup must not include lastError for preserved status",
      );
    }
    if (
      !TERMINAL_CLEANUP_PRESERVATION_REASONS.includes(
        cleanup.preservationReason as TerminalCleanupPreservationReason,
      )
    ) {
      throw new Error("Run record terminalCleanup.preservationReason is invalid");
    }
    return {
      status,
      updatedAt,
      preservationReason:
        cleanup.preservationReason as TerminalCleanupPreservationReason,
    };
  }

  if (hasPreservationReason) {
    throw new Error(
      "Run record terminalCleanup must not include preservationReason for failed status",
    );
  }
  if (!hasLastError) {
    throw new Error("Run record terminalCleanup.lastError is required for failed status");
  }
  const lastError = exactObject(
    cleanup.lastError,
    "run record terminalCleanup.lastError",
    ["code", "message"],
  );
  if (
    !TERMINAL_CLEANUP_FAILURE_CODES.includes(
      lastError.code as TerminalCleanupFailureCode,
    )
  ) {
    throw new Error("Run record terminalCleanup.lastError.code is invalid");
  }
  return {
    status,
    updatedAt,
    lastError: {
      code: lastError.code as TerminalCleanupFailureCode,
      message: requiredRunRecordString(
        lastError.message,
        "Run record terminalCleanup.lastError.message",
      ),
    },
  };
}

export function exactRunRecord(
  candidate: Record<string, unknown>,
  version: number,
  config: MasweConfig,
  artifacts: ArtifactReference[],
): RunRecord {
  const id = requiredRunRecordString(candidate.id, "Run record id", false);
  assertSafeRunId(id);
  if (!WORKFLOW_STATES.includes(candidate.state as WorkflowState)) {
    throw new Error("Run record state is invalid");
  }
  const approvals = exactObject(
    candidate.approvals,
    "run record approvals",
    ["brainstorm", "design"],
  );
  if (typeof approvals.brainstorm !== "boolean" || typeof approvals.design !== "boolean") {
    throw new Error("Run record approvals must contain booleans");
  }
  const counters = exactObject(
    candidate.counters,
    "run record counters",
    ["buildVerifyCycles", "commentResolutionCycles"],
  );
  const run: RunRecord = {
    schemaVersion: 1,
    version,
    id,
    title: requiredRunRecordString(candidate.title, "Run record title"),
    request: requiredRunRecordString(candidate.request, "Run record request"),
    repositoryPath: requiredRunRecordString(
      candidate.repositoryPath,
      "Run record repositoryPath",
    ),
    state: candidate.state as WorkflowState,
    createdAt: requiredRunRecordString(candidate.createdAt, "Run record createdAt"),
    updatedAt: requiredRunRecordString(candidate.updatedAt, "Run record updatedAt"),
    approvals: {
      brainstorm: approvals.brainstorm,
      design: approvals.design,
    },
    counters: {
      buildVerifyCycles: nonNegativeRunRecordInteger(
        counters.buildVerifyCycles,
        "Run record counters.buildVerifyCycles",
      ),
      commentResolutionCycles: nonNegativeRunRecordInteger(
        counters.commentResolutionCycles,
        "Run record counters.commentResolutionCycles",
      ),
    },
    config,
    artifacts,
    events: validateEvents(candidate.events),
    ...(candidate.workspace !== undefined
      ? { workspace: validateWorkspace(candidate.workspace) }
      : {}),
    ...(candidate.workspaceBootstrap !== undefined
      ? { workspaceBootstrap: validateWorkspaceBootstrap(candidate.workspaceBootstrap) }
      : {}),
    ...(candidate.revalidation !== undefined
      ? { revalidation: validateRevalidation(candidate.revalidation) }
      : {}),
    ...(candidate.evidence !== undefined
      ? { evidence: validateEvidence(candidate.evidence) }
      : {}),
    ...(candidate.github !== undefined
      ? { github: candidate.github as NonNullable<RunRecord["github"]> }
      : {}),
    ...(candidate.supersedes !== undefined
      ? {
          supersedes: requiredRunRecordString(candidate.supersedes, "Run record supersedes"),
        }
      : {}),
    ...(candidate.supersededBy !== undefined
      ? {
          supersededBy: requiredRunRecordString(
            candidate.supersededBy,
            "Run record supersededBy",
          ),
        }
      : {}),
    ...(candidate.failure !== undefined
      ? { failure: validateFailure(candidate.failure) }
      : {}),
    ...(candidate.terminalCleanup !== undefined
      ? { terminalCleanup: validateTerminalCleanup(candidate.terminalCleanup) }
      : {}),
  };
  validateRecoveryLifecycle(run);
  if (
    run.terminalCleanup &&
    !["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)
  ) {
    throw new Error("Run record terminalCleanup requires a terminal workflow state");
  }
  return run;
}
