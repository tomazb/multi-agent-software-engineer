import {
  MalformedGitHubWebhookError,
  UnsupportedGitHubWebhookError,
  type GitHubInternalEvent,
  type GitHubInternalEventType,
  type GitHubRepositoryIdentity,
} from "./types.ts";

export interface NormalizeInput {
  deliveryId: string;
  eventName: string;
  payload: Record<string, unknown>;
  receivedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function installationId(payload: Record<string, unknown>): number | undefined {
  const installation = asRecord(payload.installation);
  return typeof installation?.id === "number" ? installation.id : undefined;
}

function repositoryFullName(payload: Record<string, unknown>): string | undefined {
  const repository = asRecord(payload.repository);
  return typeof repository?.full_name === "string" ? repository.full_name : undefined;
}

function malformed(message: string): never {
  throw new MalformedGitHubWebhookError(message);
}

function requireAction(
  eventName: string,
  action: string | undefined,
  supported: ReadonlySet<string>,
): string {
  if (!action) malformed(`${eventName} action is required`);
  if (!supported.has(action)) {
    throw new UnsupportedGitHubWebhookError(`Unsupported ${eventName} action: ${action}`);
  }
  return action;
}

function requireCompletedAction(eventName: string, action: string | undefined): "completed" {
  if (action !== "completed") {
    throw new UnsupportedGitHubWebhookError(
      `Unsupported ${eventName} action: ${String(action)}`,
    );
  }
  return action;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    malformed(`${field} must be a positive integer`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    malformed(`${field} must be a non-empty string`);
  }
  return value;
}

function requireRepository(payload: Record<string, unknown>): string {
  const repository = requireString(repositoryFullName(payload), "repository.full_name");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    malformed("repository.full_name must use owner/repository form");
  }
  return repository.toLowerCase();
}

function optionalRepository(payload: Record<string, unknown>): string | undefined {
  return repositoryFullName(payload) === undefined ? undefined : requireRepository(payload);
}

function requireInstallationId(payload: Record<string, unknown>): number {
  return requirePositiveInteger(installationId(payload), "installation.id");
}

/**
 * The single exact repository-identity extractor for every supported
 * repository-scoped event. Requires and returns a positive safe-integer
 * `repository.id` alongside the canonical `owner/repo` name. Never derives
 * one from the other: an ID is read from `repository.id`, a name is read
 * from `repository.full_name`, and neither call synthesizes the other.
 */
function requireRepositoryIdentity(payload: Record<string, unknown>): {
  repositoryId: number;
  repository: string;
} {
  const repository = asRecord(payload.repository);
  return {
    repositoryId: requirePositiveInteger(repository?.id, "repository.id"),
    repository: requireRepository(payload),
  };
}

/**
 * Extracts one exact `{ repositoryId, repository }` pair from a single
 * `installation_repositories` list item. Requires both a positive safe
 * integer id and a canonical owner/repo name on the item itself.
 */
function requireRepositoryIdentityItem(item: unknown, listKey: string): GitHubRepositoryIdentity {
  const record = asRecord(item);
  const fullName = requireString(record?.full_name, `${listKey}.full_name`);
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    malformed(`${listKey}.full_name must use owner/repository form`);
  }
  return {
    repositoryId: requirePositiveInteger(record?.id, `${listKey}.id`),
    repository: fullName.toLowerCase(),
  };
}

/**
 * Builds the deduplicated, order-preserving list of ID/name pairs for an
 * `installation_repositories` event. Identical duplicate pairs collapse to
 * one entry; the same numeric id appearing with a conflicting name is
 * malformed.
 */
function requireRepositoryIdentityPairs(
  listed: unknown[],
  listKey: string,
): GitHubRepositoryIdentity[] {
  const nameById = new Map<number, string>();
  const seenPairs = new Set<string>();
  const pairs: GitHubRepositoryIdentity[] = [];
  for (const item of listed) {
    const pair = requireRepositoryIdentityItem(item, listKey);
    const existingName = nameById.get(pair.repositoryId);
    if (existingName !== undefined && existingName !== pair.repository) {
      malformed(`${listKey} contains conflicting repository names for the same repository id`);
    }
    nameById.set(pair.repositoryId, pair.repository);
    const pairKey = `${pair.repositoryId}:${pair.repository}`;
    if (!seenPairs.has(pairKey)) {
      seenPairs.add(pairKey);
      pairs.push(pair);
    }
  }
  return pairs;
}

function withOptional(
  base: GitHubInternalEvent,
  extras: {
    repository?: string | undefined;
    repositoryId?: number | undefined;
    repositories?: GitHubRepositoryIdentity[] | undefined;
    installationId?: number | undefined;
    pullRequestNumber?: number | undefined;
    headSha?: string | undefined;
    baseSha?: string | undefined;
    branch?: string | undefined;
    observeOnly?: boolean | undefined;
    rawAction?: string | undefined;
  },
): GitHubInternalEvent {
  const event: GitHubInternalEvent = { ...base };
  if (extras.repository !== undefined) event.repository = extras.repository;
  if (extras.repositoryId !== undefined) event.repositoryId = extras.repositoryId;
  if (extras.repositories !== undefined) event.repositories = extras.repositories;
  if (extras.installationId !== undefined) event.installationId = extras.installationId;
  if (extras.pullRequestNumber !== undefined) {
    event.pullRequestNumber = extras.pullRequestNumber;
  }
  if (extras.headSha !== undefined) event.headSha = extras.headSha;
  if (extras.baseSha !== undefined) event.baseSha = extras.baseSha;
  if (extras.branch !== undefined) event.branch = extras.branch;
  if (extras.observeOnly !== undefined) event.observeOnly = extras.observeOnly;
  if (extras.rawAction !== undefined) event.rawAction = extras.rawAction;
  return event;
}

const PR_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "closed",
]);

export function normalizeGitHubWebhook(input: NormalizeInput): GitHubInternalEvent {
  if (!input.deliveryId?.trim()) {
    malformed("deliveryId is required");
  }
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const payload = input.payload ?? {};
  const action = typeof payload.action === "string" ? payload.action : undefined;

  if (input.eventName === "pull_request") {
    const supportedAction = requireAction("pull_request", action, PR_ACTIONS);
    const pr = asRecord(payload.pull_request);
    if (!pr) malformed("pull_request must be an object");
    const head = asRecord(pr?.head);
    if (!head) malformed("pull_request.head must be an object");
    const base = asRecord(pr?.base);
    if (!base) malformed("pull_request.base must be an object");
    const type = `pull_request.${supportedAction}` as GitHubInternalEventType;
    const identity = requireRepositoryIdentity(payload);
    return withOptional(
      { eventId: input.deliveryId, type, receivedAt },
      {
        repository: identity.repository,
        repositoryId: identity.repositoryId,
        installationId: requireInstallationId(payload),
        pullRequestNumber: requirePositiveInteger(pr.number, "pull_request.number"),
        headSha: requireString(head.sha, "pull_request.head.sha"),
        baseSha: requireString(base.sha, "pull_request.base.sha"),
        branch: requireString(head.ref, "pull_request.head.ref"),
        rawAction: supportedAction,
      },
    );
  }

  if (input.eventName === "push") {
    const ref = requireString(payload.ref, "ref");
    if (!ref.startsWith("refs/heads/") || ref.length === "refs/heads/".length) {
      malformed("ref must identify a branch");
    }
    const branch = ref.slice("refs/heads/".length);
    const identity = requireRepositoryIdentity(payload);
    return withOptional(
      { eventId: input.deliveryId, type: "push", receivedAt },
      {
        repository: identity.repository,
        repositoryId: identity.repositoryId,
        installationId: requireInstallationId(payload),
        headSha: requireString(payload.after, "after"),
        branch,
      },
    );
  }

  if (input.eventName === "installation") {
    const supportedAction = requireAction(
      "installation",
      action,
      new Set(["created", "deleted"]),
    );
    return withOptional(
      {
        eventId: input.deliveryId,
        type:
          supportedAction === "created" ? "installation.created" : "installation.deleted",
        receivedAt,
      },
      {
        installationId: requireInstallationId(payload),
        rawAction: supportedAction,
      },
    );
  }

  if (input.eventName === "installation_repositories") {
    const supportedAction = requireAction(
      "installation_repositories",
      action,
      new Set(["added", "removed"]),
    );
    const listKey =
      supportedAction === "removed" ? "repositories_removed" : "repositories_added";
    if (!Array.isArray(payload[listKey])) malformed(`${listKey} must be an array`);
    const listed = payload[listKey] as unknown[];
    const repositories = requireRepositoryIdentityPairs(listed, listKey);
    return withOptional(
      {
        eventId: input.deliveryId,
        type:
          supportedAction === "added"
            ? "installation_repositories.added"
            : "installation_repositories.removed",
        receivedAt,
      },
      {
        installationId: requireInstallationId(payload),
        repository: repositories[0]?.repository ?? optionalRepository(payload),
        repositories,
        rawAction: supportedAction,
      },
    );
  }

  if (input.eventName === "workflow_run") {
    const supportedAction = requireCompletedAction("workflow_run", action);
    const run = asRecord(payload.workflow_run);
    const workflowRunIdentity = requireRepositoryIdentity(payload);
    return withOptional(
      { eventId: input.deliveryId, type: "workflow_run.completed", receivedAt },
      {
        repository: workflowRunIdentity.repository,
        repositoryId: workflowRunIdentity.repositoryId,
        installationId: requireInstallationId(payload),
        headSha: requireString(run?.head_sha, "workflow_run.head_sha"),
        observeOnly: true,
        rawAction: supportedAction,
      },
    );
  }

  if (input.eventName === "check_run") {
    const supportedAction = requireCompletedAction("check_run", action);
    const checkRun = asRecord(payload.check_run);
    const suite = asRecord(checkRun?.check_suite);
    const headSha =
      typeof suite?.head_sha === "string"
        ? suite.head_sha
        : typeof checkRun?.head_sha === "string"
          ? checkRun.head_sha
          : undefined;
    const checkRunIdentity = requireRepositoryIdentity(payload);
    return withOptional(
      { eventId: input.deliveryId, type: "check_run.completed", receivedAt },
      {
        repository: checkRunIdentity.repository,
        repositoryId: checkRunIdentity.repositoryId,
        installationId: requireInstallationId(payload),
        headSha: requireString(headSha, "check_run.head_sha"),
        observeOnly: true,
        rawAction: supportedAction,
      },
    );
  }

  if (input.eventName === "check_suite") {
    const supportedAction = requireCompletedAction("check_suite", action);
    const suite = asRecord(payload.check_suite);
    const checkSuiteIdentity = requireRepositoryIdentity(payload);
    return withOptional(
      { eventId: input.deliveryId, type: "check_suite.completed", receivedAt },
      {
        repository: checkSuiteIdentity.repository,
        repositoryId: checkSuiteIdentity.repositoryId,
        installationId: requireInstallationId(payload),
        headSha: requireString(suite?.head_sha, "check_suite.head_sha"),
        observeOnly: true,
        rawAction: supportedAction,
      },
    );
  }

  throw new UnsupportedGitHubWebhookError(
    `Unsupported GitHub webhook event: ${input.eventName}`,
  );
}
