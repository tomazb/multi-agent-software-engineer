import type { GitHubInternalEvent } from "./types.ts";
import { isSafeGitHubDeliveryId } from "./delivery-id.ts";

export const STATE_FORMAT = 2;
export const RECORD_KIND = "github-delivery-inbox";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type InboxDeliveryStatus =
  | "queued"
  | "processing"
  | "completed"
  | "awaiting-redelivery"
  | "legacy-completed";

export interface InboxDeliveryRecord {
  format: 2;
  record: "github-delivery-inbox";
  deliveryId: string;
  eventName?: string;
  receivedAt: string;
  rawBodyDigest?: string;
  legacy?: true;
  status: InboxDeliveryStatus;
  attempt: number;
  nextAttemptAt?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  event?: GitHubInternalEvent;
}

export type InboxEnqueueResult =
  | { outcome: "enqueued"; status: "queued" | "completed" }
  | { outcome: "duplicate"; status: InboxDeliveryStatus }
  | { outcome: "conflict"; status: InboxDeliveryStatus };

export interface ClaimedInboxDelivery {
  record: InboxDeliveryRecord & {
    status: "processing";
    event: GitHubInternalEvent;
    leaseId: string;
    leaseExpiresAt: string;
  };
}

export interface InboxClaimPage {
  claimed?: ClaimedInboxDelivery;
  /** Earliest retry or lease-reclaim time observed in this bounded page. */
  nextAttemptAt?: number;
  /** Opaque lexicographic queue cursor; absent after one complete queue cycle. */
  nextCursor?: string;
  scanned: number;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalRepository(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(value) &&
    value === value.toLowerCase()
  );
}

/**
 * Renames a pre-#34 `installation_repositories` name-only repository list
 * (`repositories: string[]`) to `legacyRepositories` at the durable-record
 * boundary, on load. New-form pair lists (`repositories: GitHubRepositoryIdentity[]`)
 * and already-migrated records (which no longer carry a `repositories` key)
 * pass through unchanged, so this is idempotent across re-reads and lifecycle
 * rewrites of the same in-memory record. Never synthesizes a repository id.
 */
function migrateLegacyEvent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (
    (value.type === "installation_repositories.added" ||
      value.type === "installation_repositories.removed") &&
    Array.isArray(value.repositories) &&
    value.repositories.every((item) => typeof item === "string")
  ) {
    const { repositories, ...rest } = value;
    return { ...rest, legacyRepositories: repositories };
  }
  return value;
}

function isRepositoryIdentityPair(
  item: unknown,
): item is { repositoryId: number; repository: string } {
  return (
    isRecord(item) &&
    Number.isSafeInteger(item.repositoryId) &&
    Number(item.repositoryId) > 0 &&
    canonicalRepository(item.repository)
  );
}

/**
 * Validates a normalized GitHub internal event, either as durably written by
 * this binary (`allowLegacy` false, the default -- used when enqueuing a
 * fresh event) or as loaded from a possibly pre-#34 durable record
 * (`allowLegacy` true -- used when parsing a persisted record). In legacy
 * mode, ordinary repo-scoped events may omit `repositoryId` and
 * `installation_repositories` events may carry a migrated `legacyRepositories`
 * name list instead of `repositories` pairs. A fresh write always requires
 * the stable identity; historical name-only records are the only ID-missing
 * shape ever accepted.
 */
export function validEvent(
  value: unknown,
  deliveryId: string,
  receivedAt: string,
  eventName: string,
  options?: { allowLegacy?: boolean },
): value is GitHubInternalEvent {
  const allowLegacy = options?.allowLegacy ?? false;
  if (!isRecord(value)) return false;
  if (
    value.eventId !== deliveryId ||
    value.receivedAt !== receivedAt ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  const exactFields = (fields: string[]): boolean => {
    const allowed = new Set(["eventId", "type", "receivedAt", ...fields]);
    return Object.keys(value).every((key) => allowed.has(key));
  };
  const nonEmpty = (field: string): boolean =>
    typeof value[field] === "string" && Boolean(value[field]);
  const positiveInteger = (field: string): boolean =>
    Number.isSafeInteger(value[field]) && Number(value[field]) > 0;
  const repositoryIdOk = (): boolean =>
    value.repositoryId === undefined ? allowLegacy : positiveInteger("repositoryId");

  if (value.type.startsWith("pull_request.")) {
    const action = value.type.slice("pull_request.".length);
    return (
      eventName === "pull_request" &&
      new Set(["opened", "synchronize", "reopened", "ready_for_review", "closed"]).has(action) &&
      exactFields([
        "repository",
        "repositoryId",
        "installationId",
        "pullRequestNumber",
        "headSha",
        "baseSha",
        "branch",
        "rawAction",
      ]) &&
      canonicalRepository(value.repository) &&
      repositoryIdOk() &&
      positiveInteger("installationId") &&
      positiveInteger("pullRequestNumber") &&
      nonEmpty("headSha") &&
      nonEmpty("baseSha") &&
      nonEmpty("branch") &&
      value.rawAction === action
    );
  }
  if (value.type === "push") {
    return (
      eventName === "push" &&
      exactFields(["repository", "repositoryId", "installationId", "headSha", "branch"]) &&
      canonicalRepository(value.repository) &&
      repositoryIdOk() &&
      positiveInteger("installationId") &&
      nonEmpty("headSha") &&
      nonEmpty("branch")
    );
  }
  if (value.type === "installation.created" || value.type === "installation.deleted") {
    const action = value.type.slice("installation.".length);
    return (
      eventName === "installation" &&
      exactFields(["installationId", "rawAction"]) &&
      positiveInteger("installationId") &&
      value.rawAction === action
    );
  }
  if (
    value.type === "installation_repositories.added" ||
    value.type === "installation_repositories.removed"
  ) {
    const action = value.type.slice("installation_repositories.".length);
    const pairs = value.repositories;
    const legacyNames = value.legacyRepositories;
    const hasPairs = pairs !== undefined;
    const hasLegacyNames = legacyNames !== undefined;
    if (hasPairs === hasLegacyNames) return false; // exactly one form must be present
    if (hasLegacyNames && !allowLegacy) return false;
    const validPairs = (): boolean => {
      if (!Array.isArray(pairs) || !pairs.every(isRepositoryIdentityPair)) return false;
      const typedPairs = pairs as { repositoryId: number; repository: string }[];
      const nameById = new Map<number, string>();
      for (const pair of typedPairs) {
        const existingName = nameById.get(pair.repositoryId);
        if (existingName !== undefined && existingName !== pair.repository) return false;
        nameById.set(pair.repositoryId, pair.repository);
      }
      const pairKeys = typedPairs.map((pair) => `${pair.repositoryId}:${pair.repository}`);
      return (
        new Set(pairKeys).size === pairKeys.length &&
        (typedPairs.length === 0 || value.repository === typedPairs[0]?.repository)
      );
    };
    const validLegacyNames = (): boolean => {
      if (!Array.isArray(legacyNames) || !legacyNames.every(canonicalRepository)) return false;
      return (
        new Set(legacyNames).size === legacyNames.length &&
        (legacyNames.length === 0 || value.repository === legacyNames[0])
      );
    };
    return (
      eventName === "installation_repositories" &&
      exactFields([
        "installationId",
        "repository",
        "repositories",
        "legacyRepositories",
        "rawAction",
      ]) &&
      positiveInteger("installationId") &&
      (value.repository === undefined || canonicalRepository(value.repository)) &&
      (hasPairs ? validPairs() : validLegacyNames()) &&
      value.rawAction === action
    );
  }
  const observeEventName = new Map([
    ["workflow_run.completed", "workflow_run"],
    ["check_run.completed", "check_run"],
    ["check_suite.completed", "check_suite"],
  ]).get(value.type);
  return (
    observeEventName !== undefined &&
    eventName === observeEventName &&
    exactFields(["repository", "repositoryId", "installationId", "headSha", "observeOnly", "rawAction"]) &&
    canonicalRepository(value.repository) &&
    repositoryIdOk() &&
    positiveInteger("installationId") &&
    nonEmpty("headSha") &&
    value.observeOnly === true &&
    value.rawAction === "completed"
  );
}

export function parseRecord(raw: string): InboxDeliveryRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.format !== STATE_FORMAT ||
    parsed.record !== RECORD_KIND ||
    !isSafeGitHubDeliveryId(parsed.deliveryId) ||
    !validTimestamp(parsed.receivedAt) ||
    (parsed.status !== "queued" &&
      parsed.status !== "processing" &&
      parsed.status !== "completed" &&
      parsed.status !== "awaiting-redelivery" &&
      parsed.status !== "legacy-completed") ||
    !Number.isSafeInteger(parsed.attempt) ||
    Number(parsed.attempt) < 0
  ) {
    throw new Error("Invalid GitHub durable inbox record");
  }
  const result = parsed as unknown as InboxDeliveryRecord;
  const allowedRecordKeys = new Set([
    "format",
    "record",
    "deliveryId",
    "eventName",
    "receivedAt",
    "rawBodyDigest",
    "status",
    "attempt",
    "nextAttemptAt",
    "leaseId",
    "leaseExpiresAt",
    "completedAt",
    "event",
    "legacy",
  ]);
  if (Object.keys(parsed).some((key) => !allowedRecordKeys.has(key))) {
    throw new Error("Invalid GitHub durable inbox record fields");
  }
  if (result.status === "awaiting-redelivery" || result.status === "legacy-completed") {
    if (
      result.legacy !== true ||
      result.eventName !== undefined ||
      result.rawBodyDigest !== undefined ||
      result.event !== undefined
    ) {
      throw new Error("Invalid legacy GitHub durable inbox record");
    }
  } else if (
    typeof result.eventName !== "string" ||
    !result.eventName ||
    !DIGEST_PATTERN.test(String(result.rawBodyDigest)) ||
    result.legacy !== undefined
  ) {
    throw new Error("Invalid GitHub durable inbox identity");
  }
  if (result.status === "completed" || result.status === "legacy-completed") {
    if (
      !validTimestamp(result.completedAt) ||
      result.event !== undefined ||
      result.nextAttemptAt !== undefined ||
      result.leaseId !== undefined ||
      result.leaseExpiresAt !== undefined
    ) {
      throw new Error("Invalid GitHub durable inbox tombstone");
    }
    return result;
  }
  if (result.status === "awaiting-redelivery") {
    if (
      result.event !== undefined ||
      result.nextAttemptAt !== undefined ||
      result.leaseId !== undefined ||
      result.leaseExpiresAt !== undefined ||
      result.completedAt !== undefined
    ) {
      throw new Error("Invalid GitHub awaiting-redelivery record");
    }
    return result;
  }
  const migratedEvent = migrateLegacyEvent(result.event);
  if (
    !validEvent(migratedEvent, result.deliveryId, result.receivedAt, result.eventName!, {
      allowLegacy: true,
    })
  ) {
    throw new Error("Invalid GitHub durable inbox event");
  }
  result.event = migratedEvent;
  if (result.status === "processing") {
    if (
      !result.leaseId ||
      !validTimestamp(result.leaseExpiresAt) ||
      result.nextAttemptAt !== undefined ||
      result.completedAt !== undefined
    ) {
      throw new Error("Invalid GitHub durable inbox lease");
    }
  } else if (
    !validTimestamp(result.nextAttemptAt) ||
    result.leaseId !== undefined ||
    result.leaseExpiresAt !== undefined ||
    result.completedAt !== undefined
  ) {
    throw new Error("Invalid GitHub durable inbox retry time");
  }
  return result;
}

export function parseLegacyCanonicalRecord(
  raw: string,
  deliveryId: string,
): {
  status: "processing" | "completed";
  claimedAt: string;
  completedAt?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid legacy GitHub delivery canonical record");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid legacy GitHub delivery canonical record");
  }
  const allowed = new Set([
    "deliveryId",
    "status",
    "claimedAt",
    "leaseId",
    "completedAt",
    "lastError",
  ]);
  if (
    Object.keys(parsed).some((key) => !allowed.has(key)) ||
    parsed.deliveryId !== deliveryId ||
    (parsed.status !== "processing" && parsed.status !== "completed") ||
    typeof parsed.leaseId !== "string" ||
    !parsed.leaseId ||
    !validTimestamp(parsed.claimedAt) ||
    (parsed.lastError !== undefined && typeof parsed.lastError !== "string") ||
    (parsed.status === "processing" && parsed.completedAt !== undefined) ||
    (parsed.status === "completed" &&
      (!validTimestamp(parsed.completedAt) ||
        Date.parse(parsed.completedAt) < Date.parse(parsed.claimedAt)))
  ) {
    throw new Error("Invalid legacy GitHub delivery canonical record");
  }
  return {
    status: parsed.status,
    claimedAt: parsed.claimedAt,
    ...(typeof parsed.completedAt === "string" ? { completedAt: parsed.completedAt } : {}),
  };
}
