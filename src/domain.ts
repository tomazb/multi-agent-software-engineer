export const ROLE_IDS = [
  "brainstormer",
  "designer",
  "builder",
  "verifier",
  "prResolver",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];
export type PermissionMode = "read-only" | "workspace-write";
export type RuntimeKind = "mock" | "cursor-cli" | "cursor-sdk";
export type ReasoningEffort = "low" | "medium" | "high";
export type PromptTransport = "stdin" | "argv";

export interface RoleConfig {
  model: string;
  fallbackModels?: string[];
  reasoning: ReasoningEffort;
  permissions: PermissionMode;
}

export interface GitHubAppConfig {
  enabled: boolean;
  /** Phase A pilot requires true; write side effects are deferred. */
  readOnlyChecks: boolean;
  webhookSecretEnv: string;
  appIdEnv: string;
  privateKeyEnv: string;
  /** Authoritative stable repository allowlist; unique positive safe integers. */
  allowedRepositoryIds: number[];
  /** Legacy selector/display only; an enabled config needs at least one non-empty allowlist. */
  allowedRepositories: string[];
  webhookHost?: string;
  webhookPort?: number;
}

export interface RunGitHubAssociation {
  installationId: number;
  repositoryId?: number; // legacy-read boundary only
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  branch: string;
  suspended?: boolean;
  suspensionReason?: "pull-request-closed" | "authorization-revoked";
  /** Old heads whose published checks must be cancelled before this publication is complete. */
  pendingCancellationHeadShas?: string[];
}

/** A run association whose stable repository identity is already resolved. */
export type StableRunGitHubAssociation = RunGitHubAssociation & { repositoryId: number };

export interface MasweConfig {
  version: 1;
  runtime: {
    kind: RuntimeKind;
    command: string;
    outputFormat: "json" | "text" | "stream-json";
  };
  roles: Record<RoleId, RoleConfig>;
  gates: {
    requireBrainstormApproval: boolean;
    requireDesignApproval: boolean;
    requireCiPass: boolean;
    requireVerifierPass: boolean;
  };
  quality: {
    commands: string[];
  };
  policy: {
    rejectModelFallback: boolean;
    maxBuildVerifyCycles: number;
    maxCommentResolutionCycles: number;
    allowDirtyWorkspace: boolean;
    useIsolatedWorktree: boolean;
    /** Pass Cursor CLI `--trust` for MASWE-managed worktrees. */
    trustManagedWorktrees: boolean;
    promptTransport: PromptTransport;
    commandTimeoutMs: number;
    roleTimeoutMs: number;
    doctorProbeTimeoutMs: number;
    maxRunDurationMs?: number;
    allowedPathGlobs: string[];
  };
  githubApp?: GitHubAppConfig;
}

export const WORKFLOW_STATES = [
  "CREATED",
  "BRAINSTORMING",
  "WAITING_FOR_BRAINSTORM_APPROVAL",
  "DESIGNING",
  "WAITING_FOR_DESIGN_APPROVAL",
  "BUILDING",
  "CI_RUNNING",
  "VERIFYING",
  "PR_READY",
  "PR_REVIEW",
  "CLASSIFYING_COMMENT",
  "RESOLVING",
  "WAITING_FOR_HUMAN",
  "MERGE_READY",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_EVENTS = [
  "START",
  "BRAINSTORM_COMPLETED",
  "APPROVE_BRAINSTORM",
  "DESIGN_COMPLETED",
  "APPROVE_DESIGN",
  "BUILD_COMPLETED",
  "CI_PASSED",
  "CI_FAILED",
  "VERIFY_PASSED",
  "VERIFY_PASSED_AFTER_REVIEW",
  "VERIFY_FAILED",
  "PR_OPENED",
  "REVIEW_COMMENT_RECEIVED",
  "COMMENT_IN_SCOPE",
  "COMMENT_OUT_OF_SCOPE",
  "RESOLUTION_COMPLETED",
  "HUMAN_RESUME",
  "MARK_MERGE_READY",
  "COMPLETE",
  "FAIL",
  "CANCEL",
  "RETRY_FROM_FAILED",
  "REVALIDATE_REQUESTED",
  "REVALIDATION_RETARGETED",
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENTS)[number];

export interface WorkflowEvent {
  id: string;
  at: string;
  type: WorkflowEventType;
  actor: string;
  from: WorkflowState;
  to: WorkflowState;
  details?: Record<string, unknown>;
}

export interface ArtifactReference {
  name: string;
  logicalName: string;
  attempt: number;
  path: string;
  sha256: string;
  createdAt: string;
}

export interface RunWorkspace {
  remote?: string;
  baseSha: string;
  headSha: string;
  branch: string;
  fingerprint: string;
  worktreePath?: string;
}

export type RevalidationReturnState = "PR_READY" | "PR_REVIEW";
export type RevalidationSource = "local-workspace" | "github";

export interface WorkspaceBootstrapIntent {
  mode: "operator-checkout" | "isolated-worktree";
  sourceBaseSha: string;
  sourceBranch: string;
  sourceTreeFingerprint: string;
  remote?: string;
  plannedAt: string;
  /**
   * Exact absolute path chosen for an isolated worktree before any branch or
   * worktree side effect. Durable authority for recovery; never recompute from
   * the current process TMPDIR/TMP/TEMP once published.
   */
  plannedWorktreePath?: string;
}

export interface RunRevalidation {
  returnState: RevalidationReturnState;
  source: RevalidationSource;
  originHeadSha: string;
  requestedHeadSha: string;
  generation: number;
  requestedAt: string;
  updatedAt: string;
}

export interface EvidenceBinding {
  headSha: string;
  passed: boolean;
  at: string;
}

export interface RunEvidence {
  quality?: EvidenceBinding;
  verification?: EvidenceBinding;
  mergeReady?: EvidenceBinding;
}

export type RunFailureCode =
  | "runtime-models-exhausted"
  | "workflow-failure"
  | "automatic-transition-limit-exceeded"
  | PolicyViolationCode;

export type PolicyViolationCode =
  | "policy-read-only-workspace-mutation"
  | "policy-runtime-identity-mismatch"
  | "policy-role-permission-mismatch"
  | "policy-read-only-head-moved";

export interface DurableRuntimeFailureAttempt {
  model: string;
  code: RuntimeFailureCode;
  message: string;
  requestedModel?: string;
  configuredModel?: string;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  promptTransport?: PromptTransport;
  stderrPresent: boolean;
  truncated: boolean;
}

export interface DurableRuntimeFailureSummary {
  attempts: DurableRuntimeFailureAttempt[];
  totalAttempts: number;
  omittedAttempts: number;
  aggregateTruncated: boolean;
}

export interface RunFailure {
  code?: RunFailureCode;
  message: string;
  at: string;
  resumeState?: WorkflowState;
  runtime?: DurableRuntimeFailureSummary;
}

export type TerminalCleanupStatus =
  | "pending"
  | "complete"
  | "failed"
  | "preserved";

export type TerminalCleanupPreservationReason =
  | "bootstrap-recovery"
  | "revalidation-recovery"
  | "publication-outcome-unknown";

export type TerminalCleanupFailureCode =
  | "cleanup-inspection-failed"
  | "cleanup-ownership-mismatch"
  | "cleanup-remove-failed"
  | "cleanup-postcondition-failed"
  | "cleanup-legacy-state-ambiguous";

export interface RunTerminalCleanup {
  status: TerminalCleanupStatus;
  updatedAt: string;
  preservationReason?: TerminalCleanupPreservationReason;
  lastError?: {
    code: TerminalCleanupFailureCode;
    message: string;
  };
}

export interface RunRecord {
  schemaVersion: 1;
  version: number;
  id: string;
  title: string;
  request: string;
  repositoryPath: string;
  state: WorkflowState;
  createdAt: string;
  updatedAt: string;
  approvals: {
    brainstorm: boolean;
    design: boolean;
  };
  counters: {
    buildVerifyCycles: number;
    commentResolutionCycles: number;
  };
  config: MasweConfig;
  artifacts: ArtifactReference[];
  events: WorkflowEvent[];
  workspace?: RunWorkspace;
  workspaceBootstrap?: WorkspaceBootstrapIntent;
  revalidation?: RunRevalidation;
  evidence?: RunEvidence;
  github?: RunGitHubAssociation;
  supersedes?: string;
  supersededBy?: string;
  failure?: RunFailure;
  terminalCleanup?: RunTerminalCleanup;
}

export interface RuntimeRequest {
  runId: string;
  role: RoleId;
  prompt: string;
  cwd: string;
  roleConfig: RoleConfig;
  timeoutMs?: number;
  /** True when cwd is a MASWE-created isolated worktree. */
  managedWorktree?: boolean;
}

export type RuntimeFailureCode =
  | "cursor-cli-non-zero"
  | "cursor-cli-timeout"
  | "cursor-cli-spawn"
  | "cursor-sdk-error"
  | "runtime-error"
  | "invalid-transport-json"
  | "unsupported-response-shape"
  | "missing-logical-output";

export interface RuntimeFailureDiagnostic {
  code: RuntimeFailureCode;
  message: string;
  requestedModel: string;
  configuredModel?: string;
  promptTransport?: PromptTransport;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  stderrPresent: boolean;
  truncated: boolean;
}

interface RuntimeResultBase {
  output: string;
  requestedModel: string;
  actualModel?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeFinishedResult extends RuntimeResultBase {
  status: "finished";
}

export interface RuntimeErrorResult extends RuntimeResultBase {
  status: "error";
  failure: RuntimeFailureDiagnostic;
}

export type RuntimeResult = RuntimeFinishedResult | RuntimeErrorResult;

export type DoctorCheckCode =
  | "ok"
  | "cursor-executable-unavailable"
  | "cursor-version-check-failure"
  | "catalogue-discovery-failure"
  | "model-resolution-failure"
  | "skipped-prerequisite-failure"
  | "probe-invocation-failure"
  | "probe-transport-timeout"
  | "cleanup-failure"
  | "doctor-unexpected-error"
  | "cursor-sdk-credential-missing"
  | "cursor-sdk-unavailable"
  | "auth-failure"
  | "process-termination-failure"
  | "probe-malformed-output"
  | "probe-invalid-terminal-marker";

export type DoctorCheckPrerequisite =
  | "cursor-cli"
  | "model-catalogue"
  | "model-brainstormer";

export interface RuntimeDoctorResult {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
    code: DoctorCheckCode;
    prerequisite?: DoctorCheckPrerequisite;
  }>;
}

export interface AgentRuntime {
  execute(request: RuntimeRequest): Promise<RuntimeResult>;
  doctor(): Promise<RuntimeDoctorResult>;
  /** Local provider model catalogue IDs for logical→exact resolution. */
  listModels(): Promise<string[]>;
}

export interface QualityCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface QualityReport {
  passed: boolean;
  commands: QualityCommandResult[];
}
