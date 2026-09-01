export const MASWE_CHECK_NAMES = [
  "MASWE / specification compliance",
  "MASWE / deterministic quality",
  "MASWE / independent verification",
  "MASWE / review comments resolved",
] as const;

export type MasweCheckName = (typeof MASWE_CHECK_NAMES)[number];

export type GitHubInternalEventType =
  | "pull_request.opened"
  | "pull_request.synchronize"
  | "pull_request.reopened"
  | "pull_request.ready_for_review"
  | "pull_request.closed"
  | "push"
  | "installation.created"
  | "installation.deleted"
  | "installation_repositories.added"
  | "installation_repositories.removed"
  | "workflow_run.completed"
  | "check_run.completed"
  | "check_suite.completed";

export class UnsupportedGitHubWebhookError extends Error {
  readonly code = "UNSUPPORTED_GITHUB_WEBHOOK";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedGitHubWebhookError";
  }
}

export class MalformedGitHubWebhookError extends Error {
  readonly code = "MALFORMED_GITHUB_WEBHOOK";

  constructor(message: string) {
    super(message);
    this.name = "MalformedGitHubWebhookError";
  }
}

/** A stable numeric repository ID paired with its current canonical name. */
export interface GitHubRepositoryIdentity {
  repositoryId: number;
  repository: string;
}

export interface GitHubInternalEvent {
  eventId: string;
  type: GitHubInternalEventType;
  repository?: string;
  /** Stable numeric identity for the single repository this event is scoped to. */
  repositoryId?: number;
  /** ID/name pairs affected by a new installation_repositories event. */
  repositories?: GitHubRepositoryIdentity[];
  /**
   * Pre-#34 name-only installation_repositories repository list, migrated at the
   * durable-record boundary from the historical `repositories: string[]` shape.
   * Never produced by normalization of a new webhook payload.
   */
  legacyRepositories?: string[];
  installationId?: number;
  pullRequestNumber?: number;
  headSha?: string;
  baseSha?: string;
  branch?: string;
  observeOnly?: boolean;
  receivedAt: string;
  rawAction?: string;
}

export interface AssociationRecord {
  runId: string;
  installationId: number;
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  branch: string;
  suspended: boolean;
  suspensionReason?: "pull-request-closed" | "authorization-revoked";
  updatedAt: string;
}
