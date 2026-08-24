import type { RunRecord } from "./domain.ts";
import { isTerminal } from "./state-machine.ts";
import {
  normalizeModelDisplay,
  sanitizeDurableRuntimeFailureSummary,
} from "./failure-diagnostics.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";

export function renderTerminalCleanup(run: RunRecord): string | undefined {
  if (!isTerminal(run.state)) return undefined;
  const cleanup = run.terminalCleanup;
  if (!cleanup) {
    return "Terminal cleanup: unknown (legacy record)";
  }
  if (cleanup.status === "complete") {
    return "Terminal cleanup: complete";
  }
  if (cleanup.status === "preserved") {
    return `Terminal cleanup: preserved (${cleanup.preservationReason})`;
  }
  if (cleanup.status === "failed" && cleanup.lastError) {
    const message = sanitizeDiagnostic(
      cleanup.lastError.message,
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
    ).text;
    return `Terminal cleanup: failed (${cleanup.lastError.code}): ${message}`;
  }
  return undefined;
}

function renderRuntimeFailure(run: RunRecord): string[] {
  const runtime = sanitizeDurableRuntimeFailureSummary(
    run.failure?.runtime,
  );
  if (!runtime) return [];
  const lines = [
    `Runtime attempts: ${runtime.totalAttempts} total, ${runtime.attempts.length} stored, ${runtime.omittedAttempts} omitted by durable cap${runtime.aggregateTruncated ? ", aggregate truncated" : ""}`,
  ];
  for (const attempt of runtime.attempts) {
    const fields = [
      `code=${attempt.code}`,
      ...(attempt.exitCode !== undefined
        ? [`exit=${attempt.exitCode}`]
        : []),
      ...(attempt.timedOut !== undefined
        ? [`timeout=${attempt.timedOut ? "yes" : "no"}`]
        : []),
      ...(attempt.durationMs !== undefined
        ? [`duration=${attempt.durationMs}ms`]
        : []),
      ...(attempt.promptTransport
        ? [`transport=${attempt.promptTransport}`]
        : []),
      `stderr=${attempt.stderrPresent ? "yes" : "no"}`,
      `truncated=${attempt.truncated ? "yes" : "no"}`,
    ];
    lines.push(
      `  - ${normalizeModelDisplay(attempt.model)}: ${fields.join(", ")}`,
    );
  }
  return lines;
}

function renderRecoverySha(value: string): string {
  const safe = sanitizeDiagnostic(value, 256).text;
  return safe.includes("[REDACTED]") ? "[REDACTED]" : safe.slice(0, 12);
}

export function renderRun(run: RunRecord): string {
  const artifacts = run.artifacts.length
    ? run.artifacts.map((artifact) => `  - ${artifact.name}: ${artifact.path}`).join("\n")
    : "  - none";
  const workspace = run.workspace
    ? `Workspace: branch=${run.workspace.branch}, head=${run.workspace.headSha.slice(0, 12)}, worktree=${run.workspace.worktreePath ?? "(repo)"}`
    : "Workspace: (unset)";
  const bootstrap = run.workspaceBootstrap
    ? `Bootstrap: mode=${run.workspaceBootstrap.mode}, source=${renderRecoverySha(run.workspaceBootstrap.sourceBaseSha)}, workspace=${run.workspace ? "checkpointed" : "pending"}`
    : undefined;
  const revalidation = run.revalidation
    ? `Revalidation: source=${run.revalidation.source}, target=${renderRecoverySha(run.revalidation.requestedHeadSha)}, generation=${run.revalidation.generation}, return=${run.revalidation.returnState}`
    : undefined;
  const terminalCleanup = renderTerminalCleanup(run);
  return [
    `Run: ${run.id}`,
    `Title: ${run.title}`,
    `State: ${run.state}`,
    `Updated: ${run.updatedAt}`,
    workspace,
    ...(bootstrap ? [bootstrap] : []),
    ...(revalidation ? [revalidation] : []),
    `Approvals: brainstorm=${run.approvals.brainstorm}, design=${run.approvals.design}`,
    `Cycles: build/verify=${run.counters.buildVerifyCycles}, comments=${run.counters.commentResolutionCycles}`,
    "Artifacts:",
    artifacts,
    ...(run.failure
      ? [
          `Failure: ${sanitizeDiagnostic(
            run.failure.message,
            FAILURE_AGGREGATE_MAX_CODE_POINTS,
          ).text}`,
          ...(run.failure.code ? [`Failure code: ${run.failure.code}`] : []),
          ...renderRuntimeFailure(run),
        ]
      : []),
    ...(terminalCleanup ? [terminalCleanup] : []),
    ...(run.supersedes ? [`Supersedes: ${run.supersedes}`] : []),
    ...(run.supersededBy ? [`Superseded by: ${run.supersededBy}`] : []),
  ].join("\n");
}
