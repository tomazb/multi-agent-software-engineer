/**
 * Permanent versus retryable webhook dispatch disposition (design doc §16).
 *
 * A permanent disposition means the delivery is durably CONSUMED instead of
 * retried forever: zero authority-increasing run/index/check/workflow
 * mutation, a bounded safe diagnostic, and no fallback to name-based
 * authorization. Anything transient or ambiguous -- rate limits, transient
 * GitHub/network errors, temporary token/API failures without proven
 * authorization loss, pagination page-limit exhaustion, malformed/unsafe
 * pagination responses, lock contention, recoverable durable I/O -- is thrown
 * instead, so the existing retry path keeps ownership of it. Ambiguous
 * failure is never evidence of authorization loss.
 *
 * A missing/malformed `repository.id` in a NEW webhook payload is rejected
 * during normalization before durable enqueue (HTTP 400 through the existing
 * request-preparation path). It is deliberately not a member of the permanent
 * reject vocabulary here and never increments the permanent-drop counter.
 *
 * The background worker and the synchronous deterministic dispatch seam share
 * this vocabulary and `settleGitHubDispatchResult`, so both classify and
 * order post-completion observability identically.
 */

/**
 * Reason vocabulary for a permanently consumed repository-scoped delivery.
 *
 * `repository-access-revoked` is reserved for positive authorization-loss
 * evidence: a fully and safely traversed authenticated installation
 * repository listing that reached its terminal page without the target ID,
 * AND no existing association that could be authority-reduced. When such a
 * traversal instead lets an existing association be suspended/reconciled as
 * `authorization-revoked`, the dispatch result is `{ kind: "applied" }` --
 * an allowed authority-reducing mutation occurred, the delivery completes
 * normally, and the permanent-drop counter does not move.
 */
export const GITHUB_PERMANENT_REPOSITORY_REJECT_REASONS = [
  "stable-repository-authorization-required",
  "repository-not-allowlisted",
  "legacy-repository-identity-missing",
  "repository-identity-conflict",
  "repository-access-revoked",
] as const;

export type GitHubPermanentRepositoryRejectReason =
  typeof GITHUB_PERMANENT_REPOSITORY_REJECT_REASONS[number];

export type GitHubDispatchResult =
  | { kind: "applied" }
  | { kind: "permanent-reject"; reason: GitHubPermanentRepositoryRejectReason };

export function isGitHubPermanentRepositoryRejectReason(
  value: unknown,
): value is GitHubPermanentRepositoryRejectReason {
  return (GITHUB_PERMANENT_REPOSITORY_REJECT_REASONS as readonly unknown[]).includes(value);
}

/** Context shared by the permanent-drop callback and its emitted diagnostic. */
export type GitHubPermanentRejectContext = {
  deliveryId: string;
  eventName: string;
  attempt: number;
  reason: GitHubPermanentRepositoryRejectReason;
};

/**
 * Process-local `permanentRepositoryDropsSinceStart` successor value.
 *
 * Saturating positive safe integer capped at `Number.MAX_SAFE_INTEGER`; the
 * counter resets on process restart and is observability only -- it never
 * changes dispatch, retry, authorization, or migration behavior.
 */
export function nextPermanentRepositoryDropCount(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0) return 1;
  return current >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : current + 1;
}

/**
 * Bounded safe diagnostic for one permanently consumed repository delivery.
 *
 * Carries only sanitized, self-produced fields; it deliberately has no cause,
 * so nothing arbitrary can travel with it to a renderer.
 */
export class GitHubPermanentRepositoryDropDiagnostic extends Error {
  readonly code = "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP";
  readonly deliveryId: string;
  readonly eventName: string;
  readonly attempt: number;
  readonly reason: GitHubPermanentRepositoryRejectReason;
  readonly count: number;

  constructor(context: GitHubPermanentRejectContext & { count: number }) {
    super("GitHub webhook delivery was permanently rejected for repository identity");
    this.name = "GitHubPermanentRepositoryDropDiagnostic";
    this.deliveryId = context.deliveryId;
    this.eventName = context.eventName;
    this.attempt = context.attempt;
    this.reason = context.reason;
    this.count = context.count;
  }
}

/**
 * Durable settlement shared by the worker and the synchronous dispatch seam.
 *
 * A permanent rejection is completed, never retried, and the post-completion
 * observability callback runs ONLY after `complete()` resolves. A completion
 * failure propagates to the caller's existing completion-recovery path with
 * the callback un-invoked, so a later successful completion counts the drop
 * exactly once. The callback itself can never alter durable disposition.
 */
export async function settleGitHubDispatchResult(options: {
  result: GitHubDispatchResult;
  complete: () => Promise<void>;
  onPermanentRejectCompleted?: (reason: GitHubPermanentRepositoryRejectReason) => void;
}): Promise<void> {
  await options.complete();
  if (options.result.kind !== "permanent-reject") return;
  const { reason } = options.result;
  try {
    options.onPermanentRejectCompleted?.(reason);
  } catch {
    // Observability never alters durable queue state.
  }
}
