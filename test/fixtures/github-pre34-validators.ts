/**
 * FROZEN pre-#34 compatibility evidence. Test-only.
 *
 * These functions are byte-faithful copies of the GitHub App config key set / validation rule
 * and the association index allowed-field/name-key parser as they existed at the pre-#34
 * baseline (commit `4565d1c`, before stable repository identity was introduced).
 *
 * They exist for exactly one purpose: to prove that a pre-#34 binary fails closed when it is
 * pointed at migrated state that carries stable repository identity, instead of silently
 * ignoring it and resuming name-authoritative behaviour.
 *
 * Rules:
 * - NEVER edit these to track new behaviour. If #34 changes production validation, this file
 *   must stay exactly as the old binary behaved; otherwise the downgrade evidence is worthless.
 * - NEVER import this file from production code. It must never become a parsing path.
 * - Rejected input returns `false` (or, for `pre34GitHubConfigRejection`, the frozen validator's
 *   own error message) rather than throwing, so callers assert on a plain value.
 *
 * In particular: do NOT add `allowedRepositoryIds` to `PRE34_GITHUB_APP_FIELDS`. That single edit
 * makes a pre-#34 binary silently ACCEPT migrated stable-identity config. The downgrade tests pin
 * the rejection reason precisely so that such an edit fails loudly instead of passing vacuously.
 */

/** Frozen pre-#34 shape of the normalized GitHub App config. */
interface Pre34GitHubAppConfig {
  enabled: boolean;
  readOnlyChecks: boolean;
  webhookSecretEnv: string;
  appIdEnv: string;
  privateKeyEnv: string;
  allowedRepositories: string[];
  webhookHost?: string;
  webhookPort?: number;
}

/** Frozen pre-#34 shape of a persisted association record. */
interface Pre34AssociationRecord {
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

/** Frozen copy of the pre-#34 `githubApp` key set (src/config.ts at baseline). */
const PRE34_GITHUB_APP_FIELDS = [
  "enabled",
  "readOnlyChecks",
  "webhookSecretEnv",
  "appIdEnv",
  "privateKeyEnv",
  "allowedRepositories",
  "webhookHost",
  "webhookPort",
] as const;

/** Frozen copy of the pre-#34 `exactObject` helper. */
function pre34ExactObject(
  raw: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unsupported) {
    throw new Error(`Unsupported config field: ${label}.${unsupported}`);
  }
  return value;
}

/** Frozen copy of the pre-#34 `assertGitHubAppConfig` rule. */
function pre34AssertGitHubAppConfig(githubApp: Pre34GitHubAppConfig | undefined): void {
  if (!githubApp || typeof githubApp !== "object") {
    throw new Error("githubApp must be an object when set");
  }
  if (typeof githubApp.enabled !== "boolean") {
    throw new Error("githubApp.enabled must be a boolean");
  }
  if (typeof githubApp.readOnlyChecks !== "boolean") {
    throw new Error("githubApp.readOnlyChecks must be a boolean");
  }
  if (githubApp.enabled && githubApp.readOnlyChecks !== true) {
    throw new Error(
      "githubApp.readOnlyChecks must be true when githubApp.enabled is true (Phase A pilot)",
    );
  }
  pre34ExactObject(githubApp, "githubApp", PRE34_GITHUB_APP_FIELDS);
  for (const key of ["webhookSecretEnv", "appIdEnv", "privateKeyEnv"] as const) {
    if (typeof githubApp[key] !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(githubApp[key])) {
      throw new Error(`githubApp.${key} must be a canonical environment variable name`);
    }
  }
  if (
    !Array.isArray(githubApp.allowedRepositories) ||
    !githubApp.allowedRepositories.every(
      (repo) => typeof repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(repo),
    )
  ) {
    throw new Error("githubApp.allowedRepositories must be an array of owner/repo strings");
  }
  if (githubApp.enabled && githubApp.allowedRepositories.length < 1) {
    throw new Error(
      "githubApp.allowedRepositories must contain at least one repository when enabled",
    );
  }
  if (
    githubApp.webhookHost !== undefined &&
    (typeof githubApp.webhookHost !== "string" || !githubApp.webhookHost.trim())
  ) {
    throw new Error("githubApp.webhookHost must be a non-empty string when set");
  }
  if (
    githubApp.webhookPort !== undefined &&
    (!Number.isInteger(githubApp.webhookPort) ||
      githubApp.webhookPort < 1 ||
      githubApp.webhookPort > 65535)
  ) {
    throw new Error("githubApp.webhookPort must be an integer between 1 and 65535 when set");
  }
}

/**
 * Why would a pre-#34 binary reject this normalized `githubApp` configuration object?
 * Returns the frozen validator's own error message, or `undefined` when it would accept.
 *
 * This only *observes* the frozen rules: it catches the error they already throw and never alters
 * their control flow or ordering. Downgrade tests use it to pin WHICH pre-#34 rule fired, so that a
 * future "sync" of the frozen field list cannot silently hollow out the evidence.
 */
export function pre34GitHubConfigRejection(raw: Record<string, unknown>): string | undefined {
  try {
    pre34ExactObject(raw, "githubApp", PRE34_GITHUB_APP_FIELDS);
    pre34AssertGitHubAppConfig(raw as unknown as Pre34GitHubAppConfig);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Would a pre-#34 binary accept this normalized `githubApp` configuration object?
 */
export function pre34AcceptsGitHubConfig(raw: Record<string, unknown>): boolean {
  return pre34GitHubConfigRejection(raw) === undefined;
}

/** Frozen copy of the pre-#34 name-based association key. */
function pre34AssociationKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

/** Frozen copy of the pre-#34 `isRecord` helper. */
function pre34IsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Frozen copy of the pre-#34 `validTimestamp` helper. */
function pre34ValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** Frozen copy of the pre-#34 `parseAssociationRecords` parser. */
function pre34ParseAssociationRecords(raw: string): Record<string, Pre34AssociationRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Invalid GitHub association index", { cause: error });
  }
  if (!pre34IsRecord(parsed)) throw new Error("Invalid GitHub association index");
  const result: Record<string, Pre34AssociationRecord> = {};
  const activeRuns = new Set<string>();
  const requiredFields = [
    "runId",
    "installationId",
    "repository",
    "pullRequestNumber",
    "baseSha",
    "headSha",
    "branch",
    "suspended",
    "updatedAt",
  ];
  const allowedFields = new Set([...requiredFields, "suspensionReason"]);
  for (const [key, value] of Object.entries(parsed)) {
    if (!pre34IsRecord(value)) throw new Error("Invalid GitHub association index");
    if (
      Object.keys(value).some((field) => !allowedFields.has(field)) ||
      requiredFields.some((field) => !Object.hasOwn(value, field)) ||
      typeof value.runId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(value.runId) ||
      !Number.isSafeInteger(value.installationId) ||
      Number(value.installationId) <= 0 ||
      typeof value.repository !== "string" ||
      !/^[^/\s]+\/[^/\s]+$/.test(value.repository) ||
      value.repository !== value.repository.toLowerCase() ||
      !Number.isSafeInteger(value.pullRequestNumber) ||
      Number(value.pullRequestNumber) <= 0 ||
      key !== pre34AssociationKey(value.repository, Number(value.pullRequestNumber)) ||
      typeof value.baseSha !== "string" ||
      !value.baseSha ||
      typeof value.headSha !== "string" ||
      !value.headSha ||
      typeof value.branch !== "string" ||
      !value.branch ||
      typeof value.suspended !== "boolean" ||
      (value.suspensionReason !== undefined &&
        (value.suspended !== true ||
          (value.suspensionReason !== "pull-request-closed" &&
            value.suspensionReason !== "authorization-revoked"))) ||
      !pre34ValidTimestamp(value.updatedAt)
    ) {
      throw new Error("Invalid GitHub association index");
    }
    if (!value.suspended) {
      if (activeRuns.has(value.runId)) {
        throw new Error("Invalid GitHub association index: duplicate active run id");
      }
      activeRuns.add(value.runId);
    }
    result[key] = value as unknown as Pre34AssociationRecord;
  }
  return result;
}

/**
 * Would a pre-#34 binary accept this persisted association index?
 *
 * Accepts either the raw file text or an already-parsed value; only the entry point is adapted,
 * the frozen validation logic is untouched.
 */
export function pre34AcceptsAssociationIndex(raw: unknown): boolean {
  try {
    pre34ParseAssociationRecords(typeof raw === "string" ? raw : JSON.stringify(raw));
    return true;
  } catch {
    return false;
  }
}
