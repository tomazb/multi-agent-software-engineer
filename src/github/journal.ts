import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  LockJournalError,
  formatLockTicket,
  initializeLockJournal,
  publishClaimRelease,
  publishLockClaim,
  recoverCurrentLock,
  scanLockJournal,
  validateClaimOwnership,
  type ClaimOperation,
  type JournalTransition,
  type JournalTransitionContext,
} from "../lock-journal.ts";

export type GitHubJournalKind =
  | "association"
  | "association-identity"
  | "check-create"
  | "delivery"
  | "publication"
  | "repository-identity";

export type GitHubJournalErrorCode =
  | "GITHUB_JOURNAL_INVALID_OPTIONS"
  | "GITHUB_JOURNAL_INITIALIZATION_FAILED"
  | "GITHUB_JOURNAL_LEGACY_BLOCKED"
  | "GITHUB_JOURNAL_LEGACY_CHANGED"
  | "GITHUB_JOURNAL_TIMEOUT"
  | "GITHUB_JOURNAL_OWNERSHIP_FAILED"
  | "GITHUB_JOURNAL_RELEASE_FAILED";

export class GitHubJournalError extends Error {
  readonly code: GitHubJournalErrorCode;
  readonly kind: GitHubJournalKind;

  constructor(
    code: GitHubJournalErrorCode,
    kind: GitHubJournalKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubJournalError";
    this.code = code;
    this.kind = kind;
  }
}

type LinkFile = typeof link;

export interface GitHubJournalOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  linkFile?: LinkFile;
  transition?: (
    event: JournalTransition,
    context: JournalTransitionContext,
  ) => Promise<void>;
  /** Deterministic test seam between the first and exact legacy observations. */
  afterLegacyObserved?: (legacyPath: string) => Promise<void>;
  /** Deterministic seam for legacy-owner liveness classification. */
  isProcessDefinitelyDead?: (pid: number) => boolean;
}

interface LegacyEvidence {
  path: string;
  relativePath: string;
  legacyType: "file" | "directory";
  evidenceBytes: Buffer;
  evidenceDigest: string;
  state: "dead" | "live" | "empty" | "malformed";
}

interface FileSnapshot {
  bytes: Buffer;
  identity: string;
}

interface LegacyMigrationRecord {
  format: 1;
  record: "github-legacy-lock-migration";
  kind: GitHubJournalKind;
  logicalKeyDigest: string;
  legacyPath: string;
  legacyType: "file" | "directory";
  evidenceDigest: string;
  migrationDigest: string;
}

const ASSOCIATION_KEY = "associations";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 1_000;
const MAX_LEGACY_BYTES = 1024 * 1024;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const JOURNAL_KINDS: GitHubJournalKind[] = [
  "association",
  "association-identity",
  "check-create",
  "delivery",
  "publication",
  "repository-identity",
];
const OPERATION_BY_KIND: Record<GitHubJournalKind, ClaimOperation> = {
  association: "github-association",
  "association-identity": "github-association",
  "check-create": "github-check-create",
  delivery: "github-delivery",
  publication: "github-publication",
  "repository-identity": "github-repository-identity",
};

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function logicalKeyDigest(logicalKey: string): string {
  return createHash("sha256").update(logicalKey).digest("hex");
}

function journalDirectory(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
): string {
  return path.join(githubRoot, "journals", kind, logicalKeyDigest(logicalKey));
}

function journalDirectoryForDigest(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalDigest: string,
): string {
  return path.join(githubRoot, "journals", kind, logicalDigest);
}

function publicError(
  code: GitHubJournalErrorCode,
  kind: GitHubJournalKind,
  message: string,
  cause?: unknown,
): GitHubJournalError {
  return new GitHubJournalError(
    code,
    kind,
    message,
    cause === undefined ? {} : { cause },
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function fileIdentity(stat: BigIntStats): string {
  if (stat.dev < 0n || stat.ino <= 0n) {
    throw new Error("stable filesystem identity is unavailable");
  }
  return `${stat.dev}:${stat.ino}`;
}

function directoryIdentity(stat: BigIntStats): string {
  if (stat.dev < 0n || stat.ino <= 0n || stat.ctimeNs <= 0n || stat.birthtimeNs < 0n) {
    throw new Error("stable filesystem identity is unavailable");
  }
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.birthtimeNs}`;
}

async function readHandleExactly(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) throw new Error("legacy ownership was truncated");
    offset += result.bytesRead;
  }
  return bytes;
}

async function readStableFile(filePath: string): Promise<FileSnapshot> {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (
    typeof noFollow !== "number" ||
    noFollow === 0 ||
    typeof nonBlock !== "number"
  ) {
    throw new Error("non-following legacy ownership reads are unavailable");
  }
  const before = await lstat(filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("legacy ownership is not an ordinary regular file");
  }
  const handle = await open(filePath, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const firstStat = await handle.stat({ bigint: true });
    if (
      !firstStat.isFile() ||
      fileIdentity(firstStat) !== fileIdentity(before) ||
      firstStat.size < 0n ||
      firstStat.size > BigInt(MAX_LEGACY_BYTES)
    ) {
      throw new Error("legacy ownership changed before stable read");
    }
    const size = Number(firstStat.size);
    const first = await readHandleExactly(handle, size);
    const second = await readHandleExactly(handle, size);
    const secondStat = await handle.stat({ bigint: true });
    const after = await lstat(filePath, { bigint: true });
    if (
      !first.equals(second) ||
      fileIdentity(secondStat) !== fileIdentity(firstStat) ||
      secondStat.size !== firstStat.size ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      fileIdentity(after) !== fileIdentity(firstStat)
    ) {
      throw new Error("legacy ownership changed during stable read");
    }
    return { bytes: first, identity: fileIdentity(firstStat) };
  } finally {
    await handle.close();
  }
}

function parseLegacyOwner(bytes: Buffer): { pid: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(STRICT_UTF8.decode(bytes));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  const hasToken = Object.hasOwn(candidate, "token");
  if (
    !exactKeys(candidate, hasToken ? ["pid", "token", "at"] : ["pid", "at"]) ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    !validTimestamp(candidate.at) ||
    (hasToken &&
      (typeof candidate.token !== "string" || candidate.token.length === 0))
  ) {
    return undefined;
  }
  return { pid: candidate.pid as number };
}

function processDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errno(error) === "ESRCH";
  }
}

function sameEvidence(left: LegacyEvidence, right: LegacyEvidence): boolean {
  return (
    left.path === right.path &&
    left.relativePath === right.relativePath &&
    left.legacyType === right.legacyType &&
    left.evidenceDigest === right.evidenceDigest &&
    left.evidenceBytes.equals(right.evidenceBytes) &&
    left.state === right.state
  );
}

async function inspectLegacyDirectory(
  legacyPath: string,
  relativePath: string,
  before: BigIntStats,
  isProcessDefinitelyDead: (pid: number) => boolean,
): Promise<LegacyEvidence> {
  const beforeIdentity = directoryIdentity(before);
  const firstEntries = (await readdir(legacyPath)).sort();
  if (
    firstEntries.length > 1 ||
    (firstEntries.length === 1 && firstEntries[0] !== "owner.json")
  ) {
    return {
      path: legacyPath,
      relativePath,
      legacyType: "directory",
      evidenceBytes: Buffer.from("malformed-directory\n", "utf8"),
      evidenceDigest: digest("malformed-directory\n"),
      state: "malformed",
    };
  }

  let owner: FileSnapshot | undefined;
  if (firstEntries.length === 1) {
    try {
      owner = await readStableFile(path.join(legacyPath, "owner.json"));
    } catch {
      return {
        path: legacyPath,
        relativePath,
        legacyType: "directory",
        evidenceBytes: Buffer.from("unstable-directory\n", "utf8"),
        evidenceDigest: digest("unstable-directory\n"),
        state: "malformed",
      };
    }
  }

  const secondEntries = (await readdir(legacyPath)).sort();
  const after = await lstat(legacyPath, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    directoryIdentity(after) !== beforeIdentity ||
    firstEntries.join("\0") !== secondEntries.join("\0")
  ) {
    throw new Error("legacy directory identity changed during inspection");
  }

  const evidenceBytes = Buffer.from(
    `${JSON.stringify({
      format: 1,
      record: "github-legacy-directory-evidence",
      identity: beforeIdentity,
      ownerIdentity: owner?.identity ?? null,
      ownerDigest: owner ? digest(owner.bytes) : null,
    })}\n`,
    "utf8",
  );
  if (!owner) {
    return {
      path: legacyPath,
      relativePath,
      legacyType: "directory",
      evidenceBytes,
      evidenceDigest: digest(evidenceBytes),
      state: "empty",
    };
  }
  const parsed = parseLegacyOwner(owner.bytes);
  return {
    path: legacyPath,
    relativePath,
    legacyType: "directory",
    evidenceBytes,
    evidenceDigest: digest(evidenceBytes),
    state: parsed
      ? isProcessDefinitelyDead(parsed.pid)
        ? "dead"
        : "live"
      : "malformed",
  };
}

async function inspectLegacy(
  legacyPath: string,
  relativePath: string,
  isProcessDefinitelyDead: (pid: number) => boolean,
): Promise<LegacyEvidence | undefined> {
  let stat: BigIntStats;
  try {
    stat = await lstat(legacyPath, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("legacy ownership path is a symbolic link");
  if (stat.isDirectory()) {
    return inspectLegacyDirectory(
      legacyPath,
      relativePath,
      stat,
      isProcessDefinitelyDead,
    );
  }
  if (!stat.isFile()) throw new Error("legacy ownership path has an unsafe type");
  let snapshot: FileSnapshot;
  try {
    snapshot = await readStableFile(legacyPath);
  } catch (error) {
    throw new Error("legacy ownership changed during inspection", { cause: error });
  }
  const parsed = parseLegacyOwner(snapshot.bytes);
  return {
    path: legacyPath,
    relativePath,
    legacyType: "file",
    evidenceBytes: snapshot.bytes,
    evidenceDigest: digest(snapshot.bytes),
    state: parsed
      ? isProcessDefinitelyDead(parsed.pid)
        ? "dead"
        : "live"
      : "malformed",
  };
}

function canonicalMigration(
  kind: GitHubJournalKind,
  logicalDigest: string,
  evidence: LegacyEvidence,
): { record: LegacyMigrationRecord; bytes: string } {
  const withoutDigest = {
    format: 1 as const,
    record: "github-legacy-lock-migration" as const,
    kind,
    logicalKeyDigest: `sha256:${logicalDigest}`,
    legacyPath: evidence.relativePath,
    legacyType: evidence.legacyType,
    evidenceDigest: evidence.evidenceDigest,
  };
  const migrationDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: LegacyMigrationRecord = { ...withoutDigest, migrationDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

function parseMigration(
  bytes: string,
  expected: { record: LegacyMigrationRecord; bytes: string },
): LegacyMigrationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    throw new Error("legacy migration marker is not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("legacy migration marker is not an object");
  }
  if (
    !exactKeys(parsed as Record<string, unknown>, [
      "format",
      "record",
      "kind",
      "logicalKeyDigest",
      "legacyPath",
      "legacyType",
      "evidenceDigest",
      "migrationDigest",
    ]) ||
    bytes !== expected.bytes
  ) {
    throw new Error("legacy migration marker conflicts with current evidence");
  }
  return expected.record;
}

async function createOrValidateDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("GitHub journal path is not an ordinary directory");
    }
    return false;
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("GitHub journal path is not an ordinary directory");
  }
  return true;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareJournalDirectoryForDigest(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalDigest: string,
): Promise<string> {
  const stateRoot = path.dirname(githubRoot);
  if (await createOrValidateDirectory(stateRoot)) {
    await syncDirectory(path.dirname(stateRoot));
  }
  if (await createOrValidateDirectory(githubRoot)) {
    await syncDirectory(stateRoot);
  }
  const rootStat = await lstat(githubRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("GitHub state root is not an ordinary directory");
  }
  const journals = path.join(githubRoot, "journals");
  const kindDirectory = path.join(journals, kind);
  const target = journalDirectoryForDigest(githubRoot, kind, logicalDigest);
  if (await createOrValidateDirectory(journals)) await syncDirectory(githubRoot);
  if (await createOrValidateDirectory(kindDirectory)) await syncDirectory(journals);
  if (await createOrValidateDirectory(target)) await syncDirectory(kindDirectory);
  return target;
}

function legacyLocation(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalDigest: string,
): { path: string; relativePath: string } | undefined {
  if (kind === "association") {
    return {
      path: path.join(githubRoot, "associations.lock"),
      relativePath: "associations.lock",
    };
  }
  if (kind === "check-create") {
    const relativePath = path.join(
      "side-effect-create-locks",
      `${logicalDigest}.json.lock`,
    );
    return { path: path.join(githubRoot, relativePath), relativePath };
  }
  return undefined;
}

async function readMarker(markerPath: string): Promise<string | undefined> {
  try {
    const stat = await lstat(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("legacy migration marker is not an ordinary file");
    }
    return STRICT_UTF8.decode((await readStableFile(markerPath)).bytes);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function publishMigration(
  journalRoot: string,
  expected: { record: LegacyMigrationRecord; bytes: string },
  linkFile: LinkFile,
): Promise<void> {
  const markerPath = path.join(journalRoot, "legacy-migration.json");
  const temporaryPath = path.join(
    journalRoot,
    `.legacy-migration.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    await handle.writeFile(expected.bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await chmod(temporaryPath, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    const prepared = STRICT_UTF8.decode((await readStableFile(temporaryPath)).bytes);
    if (prepared !== expected.bytes) throw new Error("prepared migration bytes changed");
    try {
      await linkFile(temporaryPath, markerPath);
    } catch (error) {
      const existing = await readMarker(markerPath);
      if (existing === undefined) {
        throw new Error("hard-link migration publication failed", { cause: error });
      }
      parseMigration(existing, expected);
    }
    await syncDirectory(journalRoot);
    const published = await readMarker(markerPath);
    if (published === undefined) throw new Error("migration marker disappeared");
    parseMigration(published, expected);
  } catch (error) {
    primaryError = error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (created) {
      try {
        await unlink(temporaryPath);
        await syncDirectory(journalRoot);
      } catch (error) {
        if (errno(error) !== "ENOENT") cleanupErrors.push(error);
      }
    }
  }
  const cleanupError =
    cleanupErrors.length > 1
      ? new AggregateError(cleanupErrors, "GitHub journal migration cleanup failed")
      : cleanupErrors[0];
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "GitHub journal migration and cleanup both failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function migrateLegacy(
  githubRoot: string,
  journalRoot: string,
  kind: GitHubJournalKind,
  logicalDigest: string,
  options: GitHubJournalOptions,
): Promise<void> {
  const classifyDead = options.isProcessDefinitelyDead ?? processDefinitelyDead;
  const location = legacyLocation(githubRoot, kind, logicalDigest);
  if (!location) return;
  const markerPath = path.join(journalRoot, "legacy-migration.json");
  let publishedMarker: string | undefined;
  try {
    publishedMarker = await readMarker(markerPath);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
      error,
    );
  }
  if (publishedMarker !== undefined) {
    let retained: LegacyEvidence | undefined;
    try {
      // Stable retained bytes and filesystem identity are marker-bound. PID liveness is not.
      retained = await inspectLegacy(location.path, location.relativePath, () => false);
      if (!retained) throw new Error("retained legacy ownership path is missing");
      parseMigration(
        publishedMarker,
        canonicalMigration(kind, logicalDigest, retained),
      );
    } catch (error) {
      throw publicError(
        "GITHUB_JOURNAL_LEGACY_CHANGED",
        kind,
        `GitHub ${kind} journal migration evidence changed`,
        error,
      );
    }
    return;
  }
  let observed: LegacyEvidence | undefined;
  try {
    observed = await inspectLegacy(location.path, location.relativePath, classifyDead);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
      error,
    );
  }
  if (!observed) {
    return;
  }
  if (observed.state === "live") {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_BLOCKED",
      kind,
      `GitHub ${kind} journal migration is blocked by legacy ownership`,
    );
  }
  if (observed.state === "malformed") {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_BLOCKED",
      kind,
      `GitHub ${kind} journal migration is blocked by malformed legacy ownership`,
    );
  }

  await options.afterLegacyObserved?.(location.path);
  let exact: LegacyEvidence | undefined;
  try {
    exact = await inspectLegacy(location.path, location.relativePath, classifyDead);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
      error,
    );
  }
  if (!exact || !sameEvidence(observed, exact)) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
    );
  }

  const canonical = canonicalMigration(kind, logicalDigest, exact);
  try {
    await publishMigration(journalRoot, canonical, options.linkFile ?? link);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_INITIALIZATION_FAILED",
      kind,
      `GitHub ${kind} journal initialization failed`,
      error,
    );
  }
  let after: LegacyEvidence | undefined;
  try {
    after = await inspectLegacy(location.path, location.relativePath, classifyDead);
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
      error,
    );
  }
  if (!after || !sameEvidence(exact, after)) {
    throw publicError(
      "GITHUB_JOURNAL_LEGACY_CHANGED",
      kind,
      `GitHub ${kind} journal migration evidence changed`,
    );
  }
}

async function initializeOne(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
  options: GitHubJournalOptions,
): Promise<string> {
  return initializeOneByDigest(
    githubRoot,
    kind,
    logicalKeyDigest(logicalKey),
    options,
  );
}

async function initializeOneByDigest(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalDigest: string,
  options: GitHubJournalOptions,
): Promise<string> {
  let target: string;
  try {
    target = await prepareJournalDirectoryForDigest(githubRoot, kind, logicalDigest);
    await initializeLockJournal(
      target,
      options.linkFile ? { linkFile: options.linkFile } : {},
    );
  } catch (error) {
    if (error instanceof GitHubJournalError) throw error;
    throw publicError(
      "GITHUB_JOURNAL_INITIALIZATION_FAILED",
      kind,
      `GitHub ${kind} journal initialization failed`,
      error,
    );
  }
  await migrateLegacy(githubRoot, target, kind, logicalDigest, options);
  return target;
}

export async function initializeGitHubJournals(
  githubRoot: string,
  options: GitHubJournalOptions = {},
): Promise<void> {
  await initializeOne(githubRoot, "association", ASSOCIATION_KEY, options);
}

/** Migrate every retained v1 per-check lock before listener/manual readiness. */
export async function initializeLegacyCheckCreateJournals(
  githubRoot: string,
  options: GitHubJournalOptions = {},
): Promise<void> {
  const legacyRoot = path.join(githubRoot, "side-effect-create-locks");
  let names: string[];
  try {
    const stat = await lstat(legacyRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("legacy check-create root is not an ordinary directory");
    }
    names = (await readdir(legacyRoot)).sort();
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw publicError(
      "GITHUB_JOURNAL_INITIALIZATION_FAILED",
      "check-create",
      "GitHub check-create journal initialization failed",
      error,
    );
  }
  for (const name of names) {
    const match = name.match(/^([0-9a-f]{64})\.json\.lock$/);
    if (!match) {
      throw publicError(
        "GITHUB_JOURNAL_INITIALIZATION_FAILED",
        "check-create",
        "GitHub check-create journal initialization failed",
      );
    }
    await initializeOneByDigest(githubRoot, "check-create", match[1]!, options);
  }
}

function validateOptions(
  kind: GitHubJournalKind,
  options: GitHubJournalOptions,
): { timeoutMs: number; pollIntervalMs: number } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw publicError(
      "GITHUB_JOURNAL_INVALID_OPTIONS",
      kind,
      `GitHub ${kind} journal options are invalid`,
    );
  }
  return { timeoutMs, pollIntervalMs };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isWaitingError(error: unknown): boolean {
  return (
    error instanceof LockJournalError &&
    (error.code === "LOCK_QUEUED" ||
      error.code === "LOCK_LIVE_OWNER" ||
      error.code === "LOCK_DEAD_OWNER")
  );
}

export async function withGitHubJournal<T>(
  githubRoot: string,
  kind: GitHubJournalKind,
  logicalKey: string,
  callback: () => Promise<T>,
  options: GitHubJournalOptions = {},
): Promise<T> {
  if (
    !JOURNAL_KINDS.includes(kind) ||
    typeof logicalKey !== "string" ||
    !logicalKey ||
    (kind === "association" && logicalKey !== ASSOCIATION_KEY)
  ) {
    throw publicError(
      "GITHUB_JOURNAL_INVALID_OPTIONS",
      kind,
      `GitHub ${kind} journal options are invalid`,
    );
  }
  const { timeoutMs, pollIntervalMs } = validateOptions(kind, options);
  await initializeGitHubJournals(githubRoot, options);
  const target =
    kind === "association"
      ? journalDirectory(githubRoot, kind, logicalKey)
      : await initializeOne(githubRoot, kind, logicalKey, options);
  const publishOptions = {
    ...(options.linkFile ? { linkFile: options.linkFile } : {}),
    ...(options.transition ? { transition: options.transition } : {}),
  };
  let handle;
  try {
    handle = await publishLockClaim(
      target,
      "data",
      OPERATION_BY_KIND[kind],
      publishOptions,
    );
  } catch (error) {
    throw publicError(
      "GITHUB_JOURNAL_OWNERSHIP_FAILED",
      kind,
      `GitHub ${kind} journal ownership failed`,
      error,
    );
  }

  const started = Date.now();
  let result: T | undefined;
  let primaryError: unknown;
  let releaseError: GitHubJournalError | undefined;
  try {
    for (;;) {
      try {
        await validateClaimOwnership(handle, publishOptions);
      } catch (error) {
        if (!(error instanceof LockJournalError) || error.code !== "LOCK_QUEUED") {
          throw publicError(
            "GITHUB_JOURNAL_OWNERSHIP_FAILED",
            kind,
            `GitHub ${kind} journal ownership failed`,
            error,
          );
        }
        try {
          await recoverCurrentLock(target, "data", {
            force: false,
            ownerDeathProof: "esrch-only",
            ...(options.linkFile ? { linkFile: options.linkFile } : {}),
            ...(options.transition ? { transition: options.transition } : {}),
          });
        } catch (recoveryError) {
          if (!isWaitingError(recoveryError)) {
            throw publicError(
              "GITHUB_JOURNAL_OWNERSHIP_FAILED",
              kind,
              `GitHub ${kind} journal ownership failed`,
              recoveryError,
            );
          }
        }

        if (Date.now() - started >= timeoutMs) {
          throw publicError(
            "GITHUB_JOURNAL_TIMEOUT",
            kind,
            `Timed out acquiring GitHub ${kind} journal`,
          );
        }
        await sleep(pollIntervalMs);
        continue;
      }
      result = await callback();
      break;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await publishClaimRelease(handle, publishOptions);
    } catch (error) {
      releaseError = publicError(
        "GITHUB_JOURNAL_RELEASE_FAILED",
        kind,
        `GitHub ${kind} journal release failed`,
        error,
      );
    }
  }
  if (primaryError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [primaryError, releaseError],
      `GitHub ${kind} journal operation and release both failed`,
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

export type LegacyGitHubJournalOwnershipState =
  | "absent"
  | "dead"
  | "live"
  | "malformed"
  | "ambiguous";

/**
 * Read-only pre-#34 legacy-journal ownership preflight (design §9.1). Classifies the current
 * name-keyed publication/association-identity lock conservatively without ever acquiring,
 * recovering, or otherwise disturbing it: no claim is published, no release is published, and
 * no dead owner is reclaimed. This is defense in depth only -- it cannot prove an idle old
 * process will not acquire the lock later. Operator/process quiescence of all pre-#34 binaries
 * remains a hard migration precondition (see §9.1); this function reports lock state only and
 * never claims or implies quiescence.
 */
export async function inspectLegacyGitHubJournalOwnership(options: {
  githubRoot: string;
  kind: "publication" | "association-identity";
  logicalKey: string;
  isProcessDefinitelyDead?: (pid: number) => boolean;
}): Promise<{ state: LegacyGitHubJournalOwnershipState }> {
  const { githubRoot, kind, logicalKey } = options;
  if (
    (kind !== "publication" && kind !== "association-identity") ||
    typeof githubRoot !== "string" ||
    githubRoot.length === 0 ||
    typeof logicalKey !== "string" ||
    logicalKey.length === 0
  ) {
    throw publicError(
      "GITHUB_JOURNAL_INVALID_OPTIONS",
      kind,
      `GitHub ${kind} journal options are invalid`,
    );
  }
  const isProcessDefinitelyDeadFn = options.isProcessDefinitelyDead ?? processDefinitelyDead;
  const target = journalDirectory(githubRoot, kind, logicalKey);

  let rootStat;
  try {
    rootStat = await lstat(target);
  } catch (error) {
    if (errno(error) === "ENOENT") return { state: "absent" };
    // Cannot exactly classify a stat failure we do not recognize; fail conservative.
    return { state: "ambiguous" };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { state: "malformed" };
  }

  // scanLockJournal()/initializeLockJournal() only complete idempotent journal scaffolding
  // (manifest/fixed directories) when missing; neither publishes a claim or a release, so no
  // ownership state is created, acquired, or disturbed by this read.
  let scan;
  try {
    scan = await scanLockJournal(target, "data", { allowUnresolvedRawClaims: true });
  } catch (error) {
    if (
      error instanceof LockJournalError &&
      (error.code === "LOCK_CORRUPT" || error.code === "LOCK_UNSAFE_PATH_TYPE")
    ) {
      return { state: "malformed" };
    }
    // An unrecognized failure is not proof of corruption; fail conservative rather than
    // guessing "absent" or "malformed".
    return { state: "ambiguous" };
  }

  if (scan.legacy && !scan.legacyRelease) {
    if (scan.legacy.state === "corrupt") return { state: "malformed" };
    if (scan.legacy.state === "valid-live") return { state: "live" };
    // state is "valid-dead": pidAliveConservative() folds any kill() errno other than EPERM
    // into "dead", including indeterminate probes such as EIO, so it is not an exact death
    // proof. Re-prove death exactly before ever reporting it, mirroring the esrch-only
    // reproof recoverCurrentLock performs before treating a legacy owner as releasable.
    if (scan.legacy.pid === undefined) return { state: "ambiguous" };
    let legacyDead: boolean;
    try {
      legacyDead = isProcessDefinitelyDeadFn(scan.legacy.pid);
    } catch {
      return { state: "ambiguous" };
    }
    return { state: legacyDead ? "dead" : "live" };
  }

  const claimsByTicket = new Map(scan.claims.map((claim) => [claim.ticket, claim]));
  for (let ticket = 1n; ticket <= scan.highestTicket; ticket += 1n) {
    const ticketText = formatLockTicket(ticket);
    const rawClaim = scan.rawClaims.get(ticketText);
    if (rawClaim) {
      if (scan.rawReleases.has(ticketText)) continue;
      return { state: "malformed" };
    }
    const claim = claimsByTicket.get(ticketText);
    if (!claim) return { state: "malformed" };
    if (scan.releases.has(ticketText)) continue;
    // This is the current (lowest unresolved) claim; any tickets behind it are queued and
    // irrelevant to blocking classification. Prove death exactly or default to live.
    let dead: boolean;
    try {
      dead = isProcessDefinitelyDeadFn(claim.pid);
    } catch {
      return { state: "ambiguous" };
    }
    return { state: dead ? "dead" : "live" };
  }
  return { state: "absent" };
}
