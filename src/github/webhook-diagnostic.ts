export type GitHubWebhookDiagnosticCode =
  | "GITHUB_WEBHOOK_HANDOFF_FAILED"
  | "GITHUB_WEBHOOK_DISPATCH_FAILED"
  | "GITHUB_WEBHOOK_COMPLETION_FAILED"
  | "GITHUB_WEBHOOK_HEARTBEAT_FAILED"
  | "GITHUB_WEBHOOK_RETRY_FAILED"
  | "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP";

/** Safe local recovery context; the arbitrary cause is never persisted. */
export class GitHubWebhookDiagnosticError extends Error {
  readonly code: GitHubWebhookDiagnosticCode;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly attempt: number;

  constructor(
    code: GitHubWebhookDiagnosticCode,
    context: { deliveryId: string; eventName: string; attempt: number },
    cause: unknown,
  ) {
    super("GitHub webhook delivery operation failed", { cause });
    this.name = "GitHubWebhookDiagnosticError";
    this.code = code;
    this.deliveryId = context.deliveryId;
    this.eventName = context.eventName;
    this.attempt = context.attempt;
  }
}
