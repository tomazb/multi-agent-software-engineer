import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export const LOCK_JOURNAL_DIRECTORY = ".lock-journal-v3";
export const MAX_LOCK_TICKET = 99_999_999_999_999_999_999n;
const TICKET_WIDTH = 20;
const MANIFEST_BYTES =
  '{"format":3,"protocol":"immutable-ticket-journal","ticketWidth":20}\n';

export type LockKind = "data" | "admin" | "admin-recovery";

export type LockJournalErrorCode =
  | "LOCK_LIVE_OWNER"
  | "LOCK_DEAD_OWNER"
  | "LOCK_QUEUED"
  | "LOCK_CORRUPT"
  | "LOCK_INCOMPLETE"
  | "LOCK_UNSAFE_PATH_TYPE"
  | "LOCK_OWNERSHIP_LOST"
  | "ADMIN_RECOVERY_CONCURRENT"
  | "LOCK_CLEANUP_FAILED"
  | "LOCK_UNSUPPORTED_FILESYSTEM"
  | "LOCK_TICKET_OVERFLOW";

export class LockJournalError extends Error {
  readonly code: LockJournalErrorCode;

  constructor(
    code: LockJournalErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LockJournalError";
    this.code = code;
  }
}

export interface LockJournalPaths {
  root: string;
  manifest: string;
  kind: string;
  claims: string;
  releases: string;
  tmp: string;
}

export type ClaimOperation =
  | "store-write"
  | "artifact-write"
  | "data-unlock"
  | "admin-serialize"
  | "admin-unlock"
  | "admin-recovery"
  | "queued-cancel"
  | "github-association"
  | "github-check-create"
  | "github-delivery"
  | "github-publication"
  | "github-repository-identity"
  | "run-target-mutation"
  | "run-publication"
  | "run-terminal-cleanup"
  | "run-terminal-recovery";

export interface ClaimProcessIdentity {
  startedAt: string;
  platformIdentity: string | null;
}

export interface ClaimRecordV3 {
  format: 3;
  record: "claim";
  kind: LockKind;
  ticket: string;
  owner: string;
  pid: number;
  process: ClaimProcessIdentity;
  at: string;
  operation: ClaimOperation;
  claimDigest: string;
}

export interface ReleaseRecordV3 {
  format: 3;
  record: "release";
  kind: LockKind;
  ticket: string;
  owner: string;
  claimDigest: string;
  targetMode: "claim";
  releaseDigest: string;
}

export interface LegacyReleaseRecordV3 {
  format: 3;
  record: "release";
  kind: LockKind;
  ticket: "00000000000000000000";
  targetMode: "legacy";
  legacyPath: ".lock" | ".admin.lock" | ".admin.lock.recovering";
  rawDigest: string;
  releaseDigest: string;
}

export interface RawClaimOverlay {
  ticket: string;
  basename: string;
  rawBytes: Buffer;
  rawDigest: string;
}

export interface RawClaimReleaseRecordV3 {
  format: 3;
  record: "release";
  kind: LockKind;
  ticket: string;
  targetMode: "raw-claim";
  claimPath: string;
  rawDigest: string;
  releaseDigest: string;
}

export interface LegacyLockOverlay {
  path: string;
  basename: LegacyReleaseRecordV3["legacyPath"];
  rawBytes: Buffer;
  rawDigest: string;
  state: "valid-live" | "valid-dead" | "corrupt";
  pid?: number;
  owner?: string;
  at?: string;
}

export interface CanonicalRecord<T> {
  record: T;
  bytes: string;
}

export interface JournalScan {
  claims: ClaimRecordV3[];
  releases: Map<string, ReleaseRecordV3>;
  rawClaims: Map<string, RawClaimOverlay>;
  rawReleases: Map<string, RawClaimReleaseRecordV3>;
  highestTicket: bigint;
  legacy?: LegacyLockOverlay;
  legacyRelease?: LegacyReleaseRecordV3;
}

export interface ScanLockJournalOptions {
  allowUnresolvedRawClaims?: boolean;
  /** Deterministic test seam after the claims namespace observation. */
  afterClaimsObserved?: () => Promise<void>;
  /** Deterministic test seam during exact-path reconciliation. */
  afterExactClaimFirstRead?: (claimPath: string) => Promise<void>;
}

export type JournalTransition =
  | "TEMP_READY"
  | "CLAIM_PARTIALLY_WRITTEN"
  | "CLAIM_TICKET_PROPOSED"
  | "CLAIM_PREPARED"
  | "CLAIM_LINK_ATTEMPT_READY"
  | "CLAIM_PUBLISHED"
  | "CLAIM_VALIDATED"
  | "TICKET_CONFLICT"
  | "TICKET_RESCAN"
  | "OWNERSHIP_CHECK_READY"
  | "OWNERSHIP_ENTERED"
  | "RELEASE_PREPARED"
  | "RELEASE_LINK_ATTEMPT_READY"
  | "RELEASE_PUBLISHED";

export interface JournalTransitionContext {
  kind: LockKind;
  ticket: string;
  owner: string;
}

export interface PublishedClaimHandle {
  runDirectory: string;
  kind: LockKind;
  ticket: bigint;
  owner: string;
  claimDigest: string;
  claim: ClaimRecordV3;
}

export interface PublishClaimOptions {
  transition?: (
    event: JournalTransition,
    context: JournalTransitionContext,
  ) => Promise<void>;
  /** Test seam for injected hard-link result semantics. */
  linkFile?: typeof link;
}

const LOCK_KINDS: LockKind[] = ["data", "admin", "admin-recovery"];
const CLAIM_OPERATIONS: ClaimOperation[] = [
  "store-write",
  "artifact-write",
  "data-unlock",
  "admin-serialize",
  "admin-unlock",
  "admin-recovery",
  "queued-cancel",
  "github-association",
  "github-check-create",
  "github-delivery",
  "github-publication",
  "github-repository-identity",
  "run-target-mutation",
  "run-publication",
  "run-terminal-cleanup",
  "run-terminal-recovery",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CLAIM_BASENAME_PATTERN = /^([0-9]{20})\.json$/;
const TEMP_BASENAME_PATTERN =
  /^\.(?:claim|release|link-probe|format)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.published)?\.tmp$/;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function pidAliveConservative(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === "EPERM";
  }
}

function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const MAX_AUTHORITATIVE_RECORD_BYTES = 1024 * 1024;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeCanonicalText(bytes: Uint8Array, recordPath: string): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch (error) {
    throw corrupt(`Published journal record is not valid UTF-8: ${recordPath}`, error);
  }
}

async function readHandleExactly(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) {
      throw corrupt("Published journal record was truncated during stable read");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

async function readStableOrdinaryBytes(
  recordPath: string,
  afterFirstRead?: (recordPath: string) => Promise<void>,
): Promise<Buffer> {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (
    typeof noFollow !== "number" ||
    noFollow === 0 ||
    typeof nonBlock !== "number"
  ) {
    throw new LockJournalError(
      "LOCK_UNSUPPORTED_FILESYSTEM",
      `Non-following authoritative record reads are unavailable on this platform`,
    );
  }

  let beforeOpen;
  try {
    beforeOpen = await lstat(recordPath);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw corrupt(`Published journal record disappeared during validation: ${recordPath}`);
    }
    throw error;
  }
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Published journal entry is not an ordinary regular file: ${recordPath}`,
    );
  }

  let handle;
  let primaryError: unknown;
  try {
    try {
      handle = await open(recordPath, constants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      if (errno(error) === "ELOOP") {
        throw new LockJournalError(
          "LOCK_UNSAFE_PATH_TYPE",
          `Published journal entry became a symbolic link during validation: ${recordPath}`,
          { cause: error },
        );
      }
      if (["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(errno(error) ?? "")) {
        throw new LockJournalError(
          "LOCK_UNSUPPORTED_FILESYSTEM",
          `Non-following authoritative record open is unsupported: ${recordPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    const firstStat = await handle.stat();
    if (!firstStat.isFile()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Opened journal entry is not an ordinary regular file: ${recordPath}`,
      );
    }
    if (
      firstStat.dev !== beforeOpen.dev ||
      firstStat.ino !== beforeOpen.ino
    ) {
      throw new LockJournalError(
        "LOCK_OWNERSHIP_LOST",
        `Published journal pathname changed before stable read: ${recordPath}`,
      );
    }
    if (
      !Number.isSafeInteger(firstStat.size) ||
      firstStat.size < 0 ||
      firstStat.size > MAX_AUTHORITATIVE_RECORD_BYTES
    ) {
      throw corrupt(`Published journal record size is outside the supported bound`);
    }
    const first = await readHandleExactly(handle, firstStat.size);
    await afterFirstRead?.(recordPath);
    const second = await readHandleExactly(handle, firstStat.size);
    const secondStat = await handle.stat();
    if (
      secondStat.size !== firstStat.size ||
      secondStat.dev !== firstStat.dev ||
      secondStat.ino !== firstStat.ino ||
      !first.equals(second)
    ) {
      throw new LockJournalError(
        "LOCK_OWNERSHIP_LOST",
        `Published journal record changed during stable read: ${recordPath}`,
      );
    }
    let afterRead;
    try {
      afterRead = await lstat(recordPath);
    } catch (error) {
      if (errno(error) === "ENOENT") {
        throw new LockJournalError(
          "LOCK_OWNERSHIP_LOST",
          `Published journal pathname disappeared during stable read: ${recordPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Published journal pathname became unsafe during stable read: ${recordPath}`,
      );
    }
    if (
      afterRead.dev !== firstStat.dev ||
      afterRead.ino !== firstStat.ino
    ) {
      throw new LockJournalError(
        "LOCK_OWNERSHIP_LOST",
        `Published journal pathname was replaced during stable read: ${recordPath}`,
      );
    }
    return first;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (cleanupError) {
        const cleanup = new LockJournalError(
          "LOCK_CLEANUP_FAILED",
          `Could not close authoritative journal record handle`,
          { cause: cleanupError },
        );
        if (primaryError !== undefined) {
          throw new AggregateError(
            [primaryError, cleanup],
            `Journal record validation and handle cleanup both failed`,
          );
        }
        throw cleanup;
      }
    }
  }
}

async function readOrdinaryRecord(recordPath: string): Promise<string> {
  return decodeCanonicalText(await readStableOrdinaryBytes(recordPath), recordPath);
}

async function requirePreparedBytes(
  temporaryPath: string,
  expected: string,
): Promise<void> {
  const actual = await readStableOrdinaryBytes(temporaryPath);
  if (!actual.equals(Buffer.from(expected, "utf8"))) {
    throw corrupt(`Prepared journal temporary bytes changed before publication`);
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function corrupt(message: string, cause?: unknown): LockJournalError {
  return new LockJournalError(
    "LOCK_CORRUPT",
    message,
    cause === undefined ? {} : { cause },
  );
}

export function formatLockTicket(ticket: bigint): string {
  if (ticket > MAX_LOCK_TICKET) {
    throw new LockJournalError(
      "LOCK_TICKET_OVERFLOW",
      `Lock ticket exceeds the maximum ${MAX_LOCK_TICKET}`,
    );
  }
  if (ticket < 1n) throw corrupt("Published lock tickets begin at one");
  return ticket.toString(10).padStart(TICKET_WIDTH, "0");
}

function parseLockTicket(value: unknown, options: { allowZero?: boolean } = {}): bigint {
  if (typeof value !== "string" || !/^[0-9]{20}$/.test(value)) {
    throw corrupt(`Lock ticket is not a canonical ${TICKET_WIDTH}-digit decimal string`);
  }
  const ticket = BigInt(value);
  if (ticket > MAX_LOCK_TICKET) {
    throw new LockJournalError("LOCK_TICKET_OVERFLOW", `Lock ticket overflows protocol range`);
  }
  if (ticket === 0n && options.allowZero) return ticket;
  if (ticket < 1n || formatLockTicket(ticket) !== value) {
    throw corrupt("Lock ticket encoding is noncanonical or reserved");
  }
  return ticket;
}

function validateClaimInput(input: {
  kind: LockKind;
  ticket: bigint;
  owner: string;
  pid: number;
  process: ClaimProcessIdentity;
  at: string;
  operation: ClaimOperation;
}): void {
  if (!LOCK_KINDS.includes(input.kind)) throw corrupt("Claim kind is invalid");
  formatLockTicket(input.ticket);
  if (!UUID_PATTERN.test(input.owner)) throw corrupt("Claim owner is not a canonical UUID");
  if (!Number.isInteger(input.pid) || input.pid <= 0) throw corrupt("Claim PID is invalid");
  if (
    !validTimestamp(input.process.startedAt) ||
    (input.process.platformIdentity !== null &&
      (typeof input.process.platformIdentity !== "string" ||
        input.process.platformIdentity.length === 0))
  ) {
    throw corrupt("Claim process identity is invalid");
  }
  if (!validTimestamp(input.at)) throw corrupt("Claim timestamp is invalid");
  if (!CLAIM_OPERATIONS.includes(input.operation)) throw corrupt("Claim operation is invalid");
}

export function canonicalClaim(input: {
  kind: LockKind;
  ticket: bigint;
  owner: string;
  pid: number;
  process: ClaimProcessIdentity;
  at: string;
  operation: ClaimOperation;
}): CanonicalRecord<ClaimRecordV3> {
  validateClaimInput(input);
  const withoutDigest = {
    format: 3 as const,
    record: "claim" as const,
    kind: input.kind,
    ticket: formatLockTicket(input.ticket),
    owner: input.owner,
    pid: input.pid,
    process: {
      startedAt: input.process.startedAt,
      platformIdentity: input.process.platformIdentity,
    },
    at: input.at,
    operation: input.operation,
  };
  const claimDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: ClaimRecordV3 = { ...withoutDigest, claimDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

export function parseClaimBytes(
  bytes: string,
  expectedKind: LockKind,
  expectedTicket: bigint,
): ClaimRecordV3 {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw corrupt("Corrupt claim is not valid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("Corrupt claim is not a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "format",
      "record",
      "kind",
      "ticket",
      "owner",
      "pid",
      "process",
      "at",
      "operation",
      "claimDigest",
    ]) ||
    candidate.format !== 3 ||
    candidate.record !== "claim" ||
    candidate.kind !== expectedKind ||
    typeof candidate.ticket !== "string" ||
    parseLockTicket(candidate.ticket) !== expectedTicket ||
    typeof candidate.owner !== "string" ||
    typeof candidate.pid !== "number" ||
    !candidate.process ||
    typeof candidate.process !== "object" ||
    Array.isArray(candidate.process) ||
    typeof candidate.at !== "string" ||
    typeof candidate.operation !== "string" ||
    typeof candidate.claimDigest !== "string"
  ) {
    throw corrupt("Claim schema, kind, or ticket is invalid");
  }
  const processIdentity = candidate.process as Record<string, unknown>;
  if (
    !exactKeys(processIdentity, ["startedAt", "platformIdentity"]) ||
    typeof processIdentity.startedAt !== "string" ||
    (processIdentity.platformIdentity !== null &&
      typeof processIdentity.platformIdentity !== "string")
  ) {
    throw corrupt("Claim process identity schema is invalid");
  }
  const rebuilt = canonicalClaim({
    kind: expectedKind,
    ticket: expectedTicket,
    owner: candidate.owner,
    pid: candidate.pid,
    process: {
      startedAt: processIdentity.startedAt,
      platformIdentity: processIdentity.platformIdentity,
    },
    at: candidate.at,
    operation: candidate.operation as ClaimOperation,
  });
  if (
    candidate.claimDigest !== rebuilt.record.claimDigest ||
    bytes !== rebuilt.bytes
  ) {
    throw corrupt("Claim bytes are noncanonical or digest-mismatched");
  }
  return rebuilt.record;
}

export function canonicalRelease(
  claim: ClaimRecordV3,
): CanonicalRecord<ReleaseRecordV3> {
  if (!DIGEST_PATTERN.test(claim.claimDigest)) throw corrupt("Claim digest is invalid");
  const ticket = parseLockTicket(claim.ticket);
  const validatedClaim = parseClaimBytes(canonicalClaim({
    kind: claim.kind,
    ticket,
    owner: claim.owner,
    pid: claim.pid,
    process: claim.process,
    at: claim.at,
    operation: claim.operation,
  }).bytes, claim.kind, ticket);
  if (validatedClaim.claimDigest !== claim.claimDigest) {
    throw corrupt("Release target claim digest is inconsistent");
  }
  const withoutDigest = {
    format: 3 as const,
    record: "release" as const,
    kind: claim.kind,
    ticket: claim.ticket,
    owner: claim.owner,
    claimDigest: claim.claimDigest,
    targetMode: "claim" as const,
  };
  const releaseDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: ReleaseRecordV3 = { ...withoutDigest, releaseDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

export function releaseBasename(claim: ClaimRecordV3): string {
  if (!UUID_PATTERN.test(claim.owner) || !DIGEST_PATTERN.test(claim.claimDigest)) {
    throw corrupt("Cannot derive release pathname from an invalid claim identity");
  }
  return `${claim.kind}.${claim.ticket}.${claim.owner}.${claim.claimDigest.slice("sha256:".length)}.json`;
}

export function parseReleaseBytes(
  bytes: string,
  expectedClaim: ClaimRecordV3,
): ReleaseRecordV3 {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw corrupt("Release is not valid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("Release is not a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "format",
      "record",
      "kind",
      "ticket",
      "owner",
      "claimDigest",
      "targetMode",
      "releaseDigest",
    ]) ||
    candidate.format !== 3 ||
    candidate.record !== "release" ||
    candidate.kind !== expectedClaim.kind ||
    candidate.ticket !== expectedClaim.ticket ||
    candidate.owner !== expectedClaim.owner ||
    candidate.claimDigest !== expectedClaim.claimDigest ||
    candidate.targetMode !== "claim" ||
    typeof candidate.releaseDigest !== "string"
  ) {
    throw corrupt("Release target or schema is invalid");
  }
  const rebuilt = canonicalRelease(expectedClaim);
  if (
    candidate.releaseDigest !== rebuilt.record.releaseDigest ||
    bytes !== rebuilt.bytes
  ) {
    throw corrupt("Release bytes are noncanonical or digest-mismatched");
  }
  return rebuilt.record;
}

function legacyBasename(kind: LockKind): LegacyReleaseRecordV3["legacyPath"] {
  if (kind === "data") return ".lock";
  if (kind === "admin") return ".admin.lock";
  return ".admin.lock.recovering";
}

function legacyDirectoryIdentityBytes(stat: BigIntStats): Buffer {
  if (
    stat.dev < 0n ||
    stat.ino <= 0n ||
    stat.ctimeNs <= 0n ||
    stat.birthtimeNs < 0n
  ) {
    throw new LockJournalError(
      "LOCK_UNSUPPORTED_FILESYSTEM",
      `Stable identity is unavailable for the legacy administrative-recovery directory`,
    );
  }
  return Buffer.from(
    `${JSON.stringify({
      format: 3,
      record: "legacy-directory-identity",
      dev: stat.dev.toString(10),
      ino: stat.ino.toString(10),
      ctimeNs: stat.ctimeNs.toString(10),
      birthtimeNs: stat.birthtimeNs.toString(10),
    })}\n`,
    "utf8",
  );
}

async function inspectLegacyLock(
  runDirectory: string,
  kind: LockKind,
): Promise<LegacyLockOverlay | undefined> {
  const basename = legacyBasename(kind);
  const legacyPath = path.join(runDirectory, basename);
  let stat;
  try {
    stat = await lstat(legacyPath, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Legacy ticket-zero path is a symbolic link or reparse point`,
    );
  }
  if (kind === "admin-recovery" && stat.isDirectory()) {
    const entries = await readdir(legacyPath);
    if (entries.length !== 0) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Legacy administrative-recovery marker is a non-empty directory`,
      );
    }
    const rawBytes = legacyDirectoryIdentityBytes(stat);
    let afterRead;
    try {
      afterRead = await lstat(legacyPath, { bigint: true });
    } catch (error) {
      if (errno(error) === "ENOENT") {
        throw new LockJournalError(
          "LOCK_OWNERSHIP_LOST",
          `Legacy administrative-recovery directory disappeared during inspection`,
          { cause: error },
        );
      }
      throw error;
    }
    if (afterRead.isSymbolicLink() || !afterRead.isDirectory()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Legacy administrative-recovery marker became an unsafe path type`,
      );
    }
    if (!rawBytes.equals(legacyDirectoryIdentityBytes(afterRead))) {
      throw new LockJournalError(
        "LOCK_OWNERSHIP_LOST",
        `Legacy administrative-recovery directory changed during inspection`,
      );
    }
    return {
      path: legacyPath,
      basename,
      rawBytes,
      rawDigest: digest(rawBytes),
      state: "corrupt",
    };
  }
  if (!stat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Legacy ticket-zero path has an unsupported object type`,
    );
  }
  const rawBytes = await readStableOrdinaryBytes(legacyPath);
  const rawDigest = digest(rawBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeCanonicalText(rawBytes, legacyPath));
  } catch {
    return { path: legacyPath, basename, rawBytes, rawDigest, state: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { path: legacyPath, basename, rawBytes, rawDigest, state: "corrupt" };
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    typeof candidate.owner !== "string" ||
    candidate.owner.length === 0 ||
    !validTimestamp(candidate.at)
  ) {
    return { path: legacyPath, basename, rawBytes, rawDigest, state: "corrupt" };
  }
  const pid = candidate.pid as number;
  return {
    path: legacyPath,
    basename,
    rawBytes,
    rawDigest,
    state: pidAliveConservative(pid) ? "valid-live" : "valid-dead",
    pid,
    owner: candidate.owner,
    at: candidate.at,
  };
}

function canonicalLegacyRelease(
  legacy: LegacyLockOverlay,
  kind: LockKind,
): CanonicalRecord<LegacyReleaseRecordV3> {
  if (!DIGEST_PATTERN.test(legacy.rawDigest)) {
    throw corrupt("Legacy ticket-zero digest is invalid");
  }
  const withoutDigest = {
    format: 3 as const,
    record: "release" as const,
    kind,
    ticket: "00000000000000000000" as const,
    targetMode: "legacy" as const,
    legacyPath: legacy.basename,
    rawDigest: legacy.rawDigest,
  };
  const releaseDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: LegacyReleaseRecordV3 = { ...withoutDigest, releaseDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

function legacyReleaseBasename(
  legacy: LegacyLockOverlay,
  kind: LockKind,
): string {
  return `${kind}.00000000000000000000.raw.${legacy.rawDigest.slice("sha256:".length)}.json`;
}

function parseLegacyReleaseBytes(
  bytes: string,
  legacy: LegacyLockOverlay,
  kind: LockKind,
): LegacyReleaseRecordV3 {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw corrupt("Legacy release is not valid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("Legacy release is not a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "format",
      "record",
      "kind",
      "ticket",
      "targetMode",
      "legacyPath",
      "rawDigest",
      "releaseDigest",
    ])
  ) {
    throw corrupt("Legacy release schema is invalid");
  }
  const canonical = canonicalLegacyRelease(legacy, kind);
  if (bytes !== canonical.bytes) {
    throw corrupt("Legacy release target, digest, or canonical bytes are invalid");
  }
  return canonical.record;
}

function canonicalRawClaimRelease(
  rawClaim: RawClaimOverlay,
  kind: LockKind,
): CanonicalRecord<RawClaimReleaseRecordV3> {
  parseLockTicket(rawClaim.ticket);
  if (
    rawClaim.basename !== `${rawClaim.ticket}.json` ||
    rawClaim.rawDigest !== digest(rawClaim.rawBytes)
  ) {
    throw corrupt("Raw claim recovery target is inconsistent");
  }
  const withoutDigest = {
    format: 3 as const,
    record: "release" as const,
    kind,
    ticket: rawClaim.ticket,
    targetMode: "raw-claim" as const,
    claimPath: rawClaim.basename,
    rawDigest: rawClaim.rawDigest,
  };
  const releaseDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: RawClaimReleaseRecordV3 = { ...withoutDigest, releaseDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

function rawClaimReleaseBasename(
  rawClaim: RawClaimOverlay,
  kind: LockKind,
): string {
  return `${kind}.${rawClaim.ticket}.raw.${rawClaim.rawDigest.slice("sha256:".length)}.json`;
}

function parseRawClaimReleaseBytes(
  bytes: string,
  rawClaim: RawClaimOverlay,
  kind: LockKind,
): RawClaimReleaseRecordV3 {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw corrupt("Raw-claim release is not valid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("Raw-claim release is not a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "format",
      "record",
      "kind",
      "ticket",
      "targetMode",
      "claimPath",
      "rawDigest",
      "releaseDigest",
    ])
  ) {
    throw corrupt("Raw-claim release schema is invalid");
  }
  const canonical = canonicalRawClaimRelease(rawClaim, kind);
  if (bytes !== canonical.bytes) {
    throw corrupt("Raw-claim release target, digest, or canonical bytes are invalid");
  }
  return canonical.record;
}

export function journalPaths(runDirectory: string, kind: LockKind): LockJournalPaths {
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const kindDirectory = path.join(root, kind);
  return {
    root,
    manifest: path.join(root, "format.json"),
    kind: kindDirectory,
    claims: path.join(kindDirectory, "claims"),
    releases: path.join(kindDirectory, "releases"),
    tmp: path.join(kindDirectory, "tmp"),
  };
}

async function inspectOrdinaryDirectory(
  directory: string,
  options: { allowMissing: boolean },
): Promise<"present" | "missing"> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Lock journal path is not an ordinary directory: ${directory}`,
      );
    }
    return "present";
  } catch (error) {
    if (error instanceof LockJournalError) throw error;
    if (errno(error) === "ENOENT" && options.allowMissing) return "missing";
    throw error;
  }
}

async function createOrValidateDirectory(directory: string): Promise<void> {
  const state = await inspectOrdinaryDirectory(directory, { allowMissing: true });
  if (state === "present") return;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  await inspectOrdinaryDirectory(directory, { allowMissing: false });
}

async function readManifest(manifestPath: string): Promise<"missing" | "valid"> {
  let stat;
  try {
    stat = await lstat(manifestPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return "missing";
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Lock journal manifest is not an ordinary regular file: ${manifestPath}`,
    );
  }
  const bytes = await readOrdinaryRecord(manifestPath);
  if (bytes !== MANIFEST_BYTES) {
    throw new LockJournalError(
      "LOCK_CORRUPT",
      `Lock journal manifest is malformed or unsupported: ${manifestPath}`,
    );
  }
  return "valid";
}

type LinkFile = typeof link;

async function reconcileExactPublication(
  finalPath: string,
  expectedBytes: string,
  publicationError: unknown,
  context: string,
): Promise<void> {
  let finalStat;
  try {
    finalStat = await lstat(finalPath);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw new LockJournalError(
        "LOCK_UNSUPPORTED_FILESYSTEM",
        `${context} was not published by the failed hard-link operation`,
        { cause: publicationError },
      );
    }
    throw error;
  }
  if (finalStat.isSymbolicLink() || !finalStat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `${context} final path is not an ordinary regular file`,
    );
  }
  try {
    const existing = await readOrdinaryRecord(finalPath);
    if (existing !== expectedBytes) {
      throw corrupt(`${context} has conflicting bytes`);
    }
  } catch (error) {
    if (error instanceof LockJournalError) throw error;
    throw new LockJournalError(
      "LOCK_UNSUPPORTED_FILESYSTEM",
      `${context} could not be reconciled after hard-link publication failed`,
      { cause: publicationError },
    );
  }
}

async function publishManifest(
  manifestPath: string,
  linkFile: LinkFile,
): Promise<void> {
  const temporary = path.join(
    path.dirname(manifestPath),
    "data",
    "tmp",
    `.format.${randomUUID()}.tmp`,
  );
  let handle;
  let created = false;
  let primaryError: unknown;
  try {
    handle = await open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(MANIFEST_BYTES, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await chmod(temporary, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    await requirePreparedBytes(temporary, MANIFEST_BYTES);
    try {
      await linkFile(temporary, manifestPath);
    } catch (error) {
      await reconcileExactPublication(
        manifestPath,
        MANIFEST_BYTES,
        error,
        "Lock journal manifest",
      );
    }
    await readManifest(manifestPath);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finishTemporaryCleanup(
      handle,
      created ? [temporary] : [],
      primaryError,
      "Journal manifest publication",
    );
  }
}

async function probeHardLink(
  tmpDirectory: string,
  linkFile: LinkFile,
): Promise<void> {
  const id = randomUUID();
  const source = path.join(tmpDirectory, `.link-probe.${id}.tmp`);
  const published = path.join(tmpDirectory, `.link-probe.${id}.published.tmp`);
  let handle;
  let sourceCreated = false;
  let publishedCreated = false;
  let primaryError: unknown;
  try {
    handle = await open(source, "wx", 0o600);
    sourceCreated = true;
    await handle.writeFile("maswe-lock-journal-link-probe\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await requirePreparedBytes(source, "maswe-lock-journal-link-probe\n");
    await linkFile(source, published);
    publishedCreated = true;
    const bytes = await readOrdinaryRecord(published);
    if (bytes !== "maswe-lock-journal-link-probe\n") {
      throw new LockJournalError(
        "LOCK_UNSUPPORTED_FILESYSTEM",
        `Hard-link publication produced incoherent contents in ${tmpDirectory}`,
      );
    }
  } catch (error) {
    primaryError =
      error instanceof LockJournalError
        ? error
        : new LockJournalError(
            "LOCK_UNSUPPORTED_FILESYSTEM",
            `Hard-link publication is unavailable in ${tmpDirectory}`,
            { cause: error },
          );
    throw primaryError;
  } finally {
    await finishTemporaryCleanup(
      handle,
      [
        ...(publishedCreated ? [published] : []),
        ...(sourceCreated ? [source] : []),
      ],
      primaryError,
      "Hard-link capability probe",
    );
  }
}

function allFixedDirectories(runDirectory: string): string[] {
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const directories = [root];
  for (const kind of LOCK_KINDS) {
    const paths = journalPaths(runDirectory, kind);
    directories.push(paths.kind, paths.claims, paths.releases, paths.tmp);
  }
  return directories;
}

async function rejectUnexpectedEntry(
  directory: string,
  basename: string,
): Promise<never> {
  const unexpectedPath = path.join(directory, basename);
  let stat;
  try {
    stat = await lstat(unexpectedPath);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw corrupt(`Unexpected journal entry changed during validation: ${unexpectedPath}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Unexpected journal namespace entry has an unsafe type: ${unexpectedPath}`,
    );
  }
  throw corrupt(`Unexpected journal namespace entry: ${unexpectedPath}`);
}

async function validatePermanentNamespace(runDirectory: string): Promise<void> {
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const allowedRoot = new Set(["format.json", ...LOCK_KINDS]);
  for (const basename of await readdir(root)) {
    if (!allowedRoot.has(basename)) {
      await rejectUnexpectedEntry(root, basename);
    }
  }
  for (const kind of LOCK_KINDS) {
    const paths = journalPaths(runDirectory, kind);
    const allowedKind = new Set(["claims", "releases", "tmp"]);
    for (const basename of await readdir(paths.kind)) {
      if (!allowedKind.has(basename)) {
        await rejectUnexpectedEntry(paths.kind, basename);
      }
    }
    await validateTemporaryEntries(paths.tmp);
  }
}

async function hasPreManifestPublishedRecords(
  runDirectory: string,
): Promise<boolean> {
  for (const kind of LOCK_KINDS) {
    const paths = journalPaths(runDirectory, kind);
    if (
      (await readdir(paths.claims)).length > 0 ||
      (await readdir(paths.releases)).length > 0
    ) {
      return true;
    }
  }
  return false;
}

export async function initializeLockJournal(
  runDirectory: string,
  options: { linkFile?: LinkFile } = {},
): Promise<void> {
  const linkFile = options.linkFile ?? link;
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const manifestPath = path.join(root, "format.json");
  const rootState = await inspectOrdinaryDirectory(root, { allowMissing: true });
  if (rootState === "missing") await createOrValidateDirectory(root);

  const manifestState = await readManifest(manifestPath);
  const fixedDirectories = allFixedDirectories(runDirectory);
  if (manifestState === "valid") {
    for (const directory of fixedDirectories) {
      const state = await inspectOrdinaryDirectory(directory, { allowMissing: true });
      if (state === "missing") {
        throw new LockJournalError(
          "LOCK_CORRUPT",
          `Lock journal is missing permanent component after manifest publication: ${directory}`,
        );
      }
    }
    await validatePermanentNamespace(runDirectory);
    return;
  }

  for (const directory of fixedDirectories) {
    await createOrValidateDirectory(directory);
  }
  await validatePermanentNamespace(runDirectory);
  if (await hasPreManifestPublishedRecords(runDirectory)) {
    // Another initializer may have completed the manifest and a claimant may then have
    // published while this actor was creating components. That is a valid completed journal,
    // not pre-manifest state.
    if ((await readManifest(manifestPath)) === "valid") {
      for (const directory of fixedDirectories) {
        await inspectOrdinaryDirectory(directory, { allowMissing: false });
      }
      return;
    }
    throw corrupt(
      "Lock journal contains published records before initialization manifest publication",
    );
  }
  for (const kind of LOCK_KINDS) {
    await probeHardLink(journalPaths(runDirectory, kind).tmp, linkFile);
  }
  await publishManifest(manifestPath, linkFile);
  await validatePermanentNamespace(runDirectory);
}

async function validateTemporaryEntries(tmpDirectory: string): Promise<void> {
  const entries = await readdir(tmpDirectory);
  for (const basename of entries) {
    const temporaryPath = path.join(tmpDirectory, basename);
    let stat;
    try {
      stat = await lstat(temporaryPath);
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Journal temporary entry is not an ordinary regular file: ${temporaryPath}`,
      );
    }
    if (!TEMP_BASENAME_PATTERN.test(basename)) {
      throw corrupt(`Journal temporary entry has an ambiguous name: ${basename}`);
    }
  }
}

function addClaimInterpretation(
  rawBytes: Buffer,
  claimPath: string,
  basename: string,
  ticket: bigint,
  kind: LockKind,
  claimsByTicket: Map<bigint, ClaimRecordV3>,
  rawClaimsByTicket: Map<bigint, RawClaimOverlay>,
): void {
  if (claimsByTicket.has(ticket) || rawClaimsByTicket.has(ticket)) {
    throw corrupt(`Published claim ticket has a duplicate interpretation: ${ticket}`);
  }
  try {
    const bytes = decodeCanonicalText(rawBytes, claimPath);
    claimsByTicket.set(ticket, parseClaimBytes(bytes, kind, ticket));
  } catch (error) {
    if (!(error instanceof LockJournalError) || error.code !== "LOCK_CORRUPT") {
      throw error;
    }
    rawClaimsByTicket.set(ticket, {
      ticket: formatLockTicket(ticket),
      basename,
      rawBytes,
      rawDigest: digest(rawBytes),
    });
  }
}

async function mergeClaimEntries(
  paths: LockJournalPaths,
  kind: LockKind,
  entries: string[],
  claimsByTicket: Map<bigint, ClaimRecordV3>,
  rawClaimsByTicket: Map<bigint, RawClaimOverlay>,
  afterFirstRead?: (claimPath: string) => Promise<void>,
): Promise<void> {
  for (const basename of entries) {
    const match = CLAIM_BASENAME_PATTERN.exec(basename);
    if (!match) throw corrupt(`Published claim filename is malformed: ${basename}`);
    const ticket = parseLockTicket(match[1]);
    if (claimsByTicket.has(ticket) || rawClaimsByTicket.has(ticket)) continue;
    const claimPath = path.join(paths.claims, basename);
    const rawBytes = await readStableOrdinaryBytes(claimPath, afterFirstRead);
    addClaimInterpretation(
      rawBytes,
      claimPath,
      basename,
      ticket,
      kind,
      claimsByTicket,
      rawClaimsByTicket,
    );
  }
}

async function reconcileExactClaimPath(
  paths: LockJournalPaths,
  kind: LockKind,
  ticket: bigint,
  claimsByTicket: Map<bigint, ClaimRecordV3>,
  rawClaimsByTicket: Map<bigint, RawClaimOverlay>,
  options: ScanLockJournalOptions,
): Promise<void> {
  if (claimsByTicket.has(ticket) || rawClaimsByTicket.has(ticket)) return;
  const ticketText = formatLockTicket(ticket);
  const basename = `${ticketText}.json`;
  const claimPath = path.join(paths.claims, basename);
  let stat;
  try {
    stat = await lstat(claimPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Release target claim is not an ordinary regular file: ${claimPath}`,
    );
  }
  const rawBytes = await readStableOrdinaryBytes(
    claimPath,
    options.afterExactClaimFirstRead,
  );
  addClaimInterpretation(
    rawBytes,
    claimPath,
    basename,
    ticket,
    kind,
    claimsByTicket,
    rawClaimsByTicket,
  );
}

function orderedClaimTickets(
  claimsByTicket: Map<bigint, ClaimRecordV3>,
  rawClaimsByTicket: Map<bigint, RawClaimOverlay>,
): bigint[] {
  return [
    ...claimsByTicket.keys(),
    ...rawClaimsByTicket.keys(),
  ].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function claimRangeHasGap(
  claimsByTicket: Map<bigint, ClaimRecordV3>,
  rawClaimsByTicket: Map<bigint, RawClaimOverlay>,
): boolean {
  return orderedClaimTickets(claimsByTicket, rawClaimsByTicket).some(
    (ticket, index) => ticket !== BigInt(index + 1),
  );
}

function validateContiguousClaimRange(
  claimsByTicket: Map<bigint, ClaimRecordV3>,
  rawClaimsByTicket: Map<bigint, RawClaimOverlay>,
): bigint[] {
  const orderedTickets = orderedClaimTickets(claimsByTicket, rawClaimsByTicket);
  for (let index = 0; index < orderedTickets.length; index += 1) {
    const expected = BigInt(index + 1);
    if (orderedTickets[index] !== expected) {
      throw corrupt(
        `Published claim range is not contiguous: expected ${formatLockTicket(expected)}`,
      );
    }
  }
  return orderedTickets;
}

export async function scanLockJournal(
  runDirectory: string,
  kind: LockKind,
  options: ScanLockJournalOptions = {},
): Promise<JournalScan> {
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, kind);
  await validateTemporaryEntries(paths.tmp);
  const legacy = await inspectLegacyLock(runDirectory, kind);

  const claimEntries = await readdir(paths.claims);
  await options.afterClaimsObserved?.();
  const claimsByTicket = new Map<bigint, ClaimRecordV3>();
  const rawClaimsByTicket = new Map<bigint, RawClaimOverlay>();
  await mergeClaimEntries(
    paths,
    kind,
    claimEntries,
    claimsByTicket,
    rawClaimsByTicket,
  );

  const releases = new Map<string, ReleaseRecordV3>();
  const rawReleases = new Map<string, RawClaimReleaseRecordV3>();
  let legacyRelease: LegacyReleaseRecordV3 | undefined;
  const releaseEntries = await readdir(paths.releases);
  if (
    releaseEntries.length > 0 ||
    claimRangeHasGap(claimsByTicket, rawClaimsByTicket)
  ) {
    await mergeClaimEntries(
      paths,
      kind,
      await readdir(paths.claims),
      claimsByTicket,
      rawClaimsByTicket,
      options.afterExactClaimFirstRead,
    );
  }
  for (const basename of releaseEntries) {
    const releasePath = path.join(paths.releases, basename);
    const bytes = await readOrdinaryRecord(releasePath);
    let preliminary: unknown;
    try {
      preliminary = JSON.parse(bytes);
    } catch (error) {
      throw corrupt(`Published release is not valid JSON: ${basename}`, error);
    }
    if (!preliminary || typeof preliminary !== "object" || Array.isArray(preliminary)) {
      throw corrupt(`Published release is not a JSON object: ${basename}`);
    }
    const candidate = preliminary as Record<string, unknown>;
    const ticket = parseLockTicket(candidate.ticket, { allowZero: true });
    if (ticket === 0n) {
      if (!legacy) {
        throw corrupt(`Legacy release exists after the ticket-zero path disappeared`);
      }
      const expectedBasename = legacyReleaseBasename(legacy, kind);
      if (
        candidate.targetMode !== "legacy" ||
        basename !== expectedBasename ||
        legacyRelease
      ) {
        throw corrupt(`Legacy release pathname is conflicting or noncanonical: ${basename}`);
      }
      legacyRelease = parseLegacyReleaseBytes(bytes, legacy, kind);
      continue;
    }
    if (candidate.targetMode === "raw-claim") {
      if (!rawClaimsByTicket.has(ticket) && !claimsByTicket.has(ticket)) {
        await reconcileExactClaimPath(
          paths,
          kind,
          ticket,
          claimsByTicket,
          rawClaimsByTicket,
          options,
        );
      }
      const rawClaim = rawClaimsByTicket.get(ticket);
      if (!rawClaim) {
        throw corrupt(`Raw-claim release targets a missing or valid claim: ${basename}`);
      }
      const expectedBasename = rawClaimReleaseBasename(rawClaim, kind);
      if (basename !== expectedBasename || rawReleases.has(rawClaim.ticket)) {
        throw corrupt(`Raw-claim release pathname is conflicting or noncanonical: ${basename}`);
      }
      rawReleases.set(
        rawClaim.ticket,
        parseRawClaimReleaseBytes(bytes, rawClaim, kind),
      );
      continue;
    }
    if (!claimsByTicket.has(ticket) && !rawClaimsByTicket.has(ticket)) {
      await reconcileExactClaimPath(
        paths,
        kind,
        ticket,
        claimsByTicket,
        rawClaimsByTicket,
        options,
      );
    }
    const claim = claimsByTicket.get(ticket);
    if (!claim) {
      throw corrupt(`Published release targets a missing claim: ${basename}`);
    }
    const expectedBasename = releaseBasename(claim);
    if (basename !== expectedBasename || releases.has(claim.ticket)) {
      throw corrupt(`Published release pathname is conflicting or noncanonical: ${basename}`);
    }
    releases.set(claim.ticket, parseReleaseBytes(bytes, claim));
  }

  const orderedTickets = validateContiguousClaimRange(
    claimsByTicket,
    rawClaimsByTicket,
  );

  if (!options.allowUnresolvedRawClaims) {
    const unresolved = [...rawClaimsByTicket.values()].find(
      (rawClaim) => !rawReleases.has(rawClaim.ticket),
    );
    if (unresolved) {
      throw corrupt(
        `Published claim ${unresolved.basename} is corrupt and has no exact raw resolution`,
      );
    }
  }

  return {
    claims: orderedTickets.flatMap((ticket) => {
      const claim = claimsByTicket.get(ticket);
      return claim ? [claim] : [];
    }),
    releases,
    rawClaims: new Map(
      [...rawClaimsByTicket].map(([ticket, rawClaim]) => [
        formatLockTicket(ticket),
        rawClaim,
      ]),
    ),
    rawReleases,
    highestTicket: orderedTickets.at(-1) ?? 0n,
    ...(legacy ? { legacy } : {}),
    ...(legacyRelease ? { legacyRelease } : {}),
  };
}

/**
 * Return true only when one exact path is validated as non-authoritative v3
 * synchronization infrastructure or an immutable canonical protocol record.
 * Fingerprinting callers use false to keep malformed and unsafe lookalikes
 * visible to the read-only verification boundary.
 */
export async function isCanonicalJournalFingerprintEntry(
  runDirectory: string,
  journalSegments: string[],
): Promise<boolean> {
  try {
    if (journalSegments.length === 0) {
      await inspectOrdinaryDirectory(
        path.join(runDirectory, LOCK_JOURNAL_DIRECTORY),
        { allowMissing: false },
      );
      return true;
    }
    if (journalSegments.length === 1) {
      if (journalSegments[0] === "format.json") {
        return (
          (await readManifest(
            path.join(runDirectory, LOCK_JOURNAL_DIRECTORY, "format.json"),
          )) === "valid"
        );
      }
      if (!LOCK_KINDS.includes(journalSegments[0] as LockKind)) return false;
      await inspectOrdinaryDirectory(
        journalPaths(runDirectory, journalSegments[0] as LockKind).kind,
        { allowMissing: false },
      );
      return true;
    }

    const kind = journalSegments[0] as LockKind;
    if (!LOCK_KINDS.includes(kind)) return false;
    const paths = journalPaths(runDirectory, kind);
    const stream = journalSegments[1];
    if (journalSegments.length === 2) {
      const directory =
        stream === "claims"
          ? paths.claims
          : stream === "releases"
            ? paths.releases
            : stream === "tmp"
              ? paths.tmp
              : undefined;
      if (!directory) return false;
      await inspectOrdinaryDirectory(directory, { allowMissing: false });
      return true;
    }
    if (journalSegments.length !== 3) return false;

    const basename = journalSegments[2]!;
    if (stream === "tmp") {
      if (!TEMP_BASENAME_PATTERN.test(basename)) return false;
      const stat = await lstat(path.join(paths.tmp, basename));
      return !stat.isSymbolicLink() && stat.isFile();
    }
    if (stream === "claims") {
      const match = CLAIM_BASENAME_PATTERN.exec(basename);
      if (!match) return false;
      const ticket = parseLockTicket(match[1]);
      const bytes = await readOrdinaryRecord(path.join(paths.claims, basename));
      parseClaimBytes(bytes, kind, ticket);
      return true;
    }
    if (stream !== "releases") return false;

    const releasePath = path.join(paths.releases, basename);
    const bytes = await readOrdinaryRecord(releasePath);
    const preliminary = JSON.parse(bytes) as Record<string, unknown>;
    const ticket = parseLockTicket(preliminary.ticket, { allowZero: true });
    if (ticket === 0n) {
      const legacy = await inspectLegacyLock(runDirectory, kind);
      if (
        !legacy ||
        basename !== legacyReleaseBasename(legacy, kind)
      ) {
        return false;
      }
      parseLegacyReleaseBytes(bytes, legacy, kind);
      return true;
    }

    const ticketText = formatLockTicket(ticket);
    const claimPath = path.join(paths.claims, `${ticketText}.json`);
    const rawBytes = await readStableOrdinaryBytes(claimPath);
    try {
      const claimBytes = decodeCanonicalText(rawBytes, claimPath);
      const claim = parseClaimBytes(claimBytes, kind, ticket);
      if (basename !== releaseBasename(claim)) return false;
      parseReleaseBytes(bytes, claim);
      return true;
    } catch (error) {
      if (!(error instanceof LockJournalError) || error.code !== "LOCK_CORRUPT") {
        throw error;
      }
      const rawClaim: RawClaimOverlay = {
        ticket: ticketText,
        basename: `${ticketText}.json`,
        rawBytes,
        rawDigest: digest(rawBytes),
      };
      if (basename !== rawClaimReleaseBasename(rawClaim, kind)) return false;
      parseRawClaimReleaseBytes(bytes, rawClaim, kind);
      return true;
    }
  } catch {
    return false;
  }
}

const PROCESS_STARTED_AT = new Date(
  Date.now() - Math.max(0, process.uptime()) * 1_000,
).toISOString();

async function currentPlatformProcessIdentity(): Promise<string | null> {
  return platformProcessIdentity(process.pid);
}

async function platformProcessIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    const boot = bootId.trim().toLowerCase();
    if (!startTicks || !/^[0-9]+$/.test(startTicks) || !UUID_PATTERN.test(boot)) {
      return null;
    }
    return `linux:${boot}:${startTicks}`;
  } catch {
    return null;
  }
}

async function claimIsLive(claim: ClaimRecordV3): Promise<boolean> {
  if (!pidAliveConservative(claim.pid)) return false;
  if (claim.process.platformIdentity === null) return true;
  const current = await platformProcessIdentity(claim.pid);
  if (current === null) return true;
  return current === claim.process.platformIdentity;
}

function pidIsLiveUnlessEsrch(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

async function cleanupExactTemporary(temporaryPath: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(temporaryPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw new LockJournalError(
      "LOCK_CLEANUP_FAILED",
      `Could not inspect exact journal temporary path`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Exact journal temporary path changed to an unsafe type`,
    );
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    throw new LockJournalError(
      "LOCK_CLEANUP_FAILED",
      `Could not unlink exact journal temporary path`,
      { cause: error },
    );
  }
}

type OpenFileHandle = Awaited<ReturnType<typeof open>>;

async function finishTemporaryCleanup(
  handle: OpenFileHandle | undefined,
  exactPaths: string[],
  primaryError: unknown,
  context: string,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(
        new LockJournalError(
          "LOCK_CLEANUP_FAILED",
          `Could not close ${context} temporary handle`,
          { cause: error },
        ),
      );
    }
  }
  for (const exactPath of exactPaths) {
    try {
      await cleanupExactTemporary(exactPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) return;
  if (primaryError !== undefined) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `${context} failed and its exact temporary cleanup also failed`,
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, `${context} temporary cleanup failed`);
}

async function reconcileClaimPublication(
  finalPath: string,
  canonical: CanonicalRecord<ClaimRecordV3>,
  publicationError: unknown,
): Promise<"published" | "conflict"> {
  let finalBytes: string;
  try {
    finalBytes = await readOrdinaryRecord(finalPath);
  } catch (validationError) {
    try {
      await lstat(finalPath);
    } catch (inspectionError) {
      if (errno(inspectionError) === "ENOENT") {
        throw new LockJournalError(
          "LOCK_UNSUPPORTED_FILESYSTEM",
          `Atomic no-clobber claim publication failed without a final record`,
          { cause: publicationError },
        );
      }
      throw inspectionError;
    }
    throw validationError;
  }
  const existing = parseClaimBytes(
    finalBytes,
    canonical.record.kind,
    parseLockTicket(canonical.record.ticket),
  );
  if (
    finalBytes === canonical.bytes &&
    existing.owner === canonical.record.owner &&
    existing.claimDigest === canonical.record.claimDigest
  ) {
    return "published";
  }
  return "conflict";
}

async function prepareAndPublishClaim(
  paths: LockJournalPaths,
  canonical: CanonicalRecord<ClaimRecordV3>,
  options: PublishClaimOptions,
): Promise<"published" | "conflict"> {
  const temporaryPath = path.join(paths.tmp, `.claim.${randomUUID()}.tmp`);
  const finalPath = path.join(paths.claims, `${canonical.record.ticket}.json`);
  const context: JournalTransitionContext = {
    kind: canonical.record.kind,
    ticket: canonical.record.ticket,
    owner: canonical.record.owner,
  };
  let handle;
  let created = false;
  let primaryError: unknown;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    await options.transition?.("TEMP_READY", context);
    const midpoint = Math.max(1, Math.floor(canonical.bytes.length / 2));
    await handle.writeFile(canonical.bytes.slice(0, midpoint), "utf8");
    await options.transition?.("CLAIM_PARTIALLY_WRITTEN", context);
    await handle.writeFile(canonical.bytes.slice(midpoint), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await chmod(temporaryPath, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    await options.transition?.("CLAIM_PREPARED", context);
    await requirePreparedBytes(temporaryPath, canonical.bytes);
    await options.transition?.("CLAIM_LINK_ATTEMPT_READY", context);
    try {
      await (options.linkFile ?? link)(temporaryPath, finalPath);
    } catch (error) {
      const reconciliation = await reconcileClaimPublication(
        finalPath,
        canonical,
        error,
      );
      if (reconciliation === "published") {
        await options.transition?.("CLAIM_PUBLISHED", context);
      }
      return reconciliation;
    }
    await options.transition?.("CLAIM_PUBLISHED", context);
    const finalBytes = await readOrdinaryRecord(finalPath);
    const validated = parseClaimBytes(
      finalBytes,
      canonical.record.kind,
      parseLockTicket(canonical.record.ticket),
    );
    if (
      finalBytes !== canonical.bytes ||
      validated.claimDigest !== canonical.record.claimDigest
    ) {
      throw corrupt(`Published claim differs from the prepared claim`);
    }
    await options.transition?.("CLAIM_VALIDATED", context);
    return "published";
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finishTemporaryCleanup(
      handle,
      created ? [temporaryPath] : [],
      primaryError,
      "Claim publication",
    );
  }
}

async function exactPublishedClaimHandle(
  runDirectory: string,
  kind: LockKind,
  ticket: bigint,
  canonical: CanonicalRecord<ClaimRecordV3>,
): Promise<PublishedClaimHandle | undefined> {
  const finalPath = path.join(
    journalPaths(runDirectory, kind).claims,
    `${formatLockTicket(ticket)}.json`,
  );
  // Initial absence means there is no final pathname available to release.
  // Once existence is observed, any disappearance or replacement is
  // indeterminate and must not release another owner's claim.
  try {
    await lstat(finalPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  const finalBytes = await readOrdinaryRecord(finalPath);
  const published = parseClaimBytes(finalBytes, kind, ticket);
  if (
    finalBytes !== canonical.bytes ||
    published.ticket !== canonical.record.ticket ||
    published.owner !== canonical.record.owner ||
    published.claimDigest !== canonical.record.claimDigest
  ) {
    throw new LockJournalError(
      "LOCK_OWNERSHIP_LOST",
      `Published ${kind} claim does not exactly match the failed publication attempt`,
    );
  }
  return {
    runDirectory,
    kind,
    ticket,
    owner: published.owner,
    claimDigest: published.claimDigest,
    claim: published,
  };
}

async function releaseExactClaimAfterPublicationFailure(
  runDirectory: string,
  kind: LockKind,
  ticket: bigint,
  canonical: CanonicalRecord<ClaimRecordV3>,
  publicationError: unknown,
  options: PublishClaimOptions,
): Promise<never> {
  let handle: PublishedClaimHandle | undefined;
  try {
    handle = await exactPublishedClaimHandle(runDirectory, kind, ticket, canonical);
  } catch (reconciliationError) {
    throw new AggregateError(
      [publicationError, reconciliationError],
      "Lock claim publication failed and exact claim reconciliation was indeterminate",
      { cause: publicationError },
    );
  }
  if (!handle) throw publicationError;

  const releaseOptions: PublishClaimOptions = {
    ...(options.transition ? { transition: options.transition } : {}),
    ...(options.linkFile ? { linkFile: options.linkFile } : {}),
  };
  try {
    await publishClaimRelease(handle, releaseOptions);
  } catch (releaseError) {
    throw new AggregateError(
      [publicationError, releaseError],
      "Lock claim publication and exact claim release both failed",
      { cause: publicationError },
    );
  }
  throw publicationError;
}

export async function publishLockClaim(
  runDirectory: string,
  kind: LockKind,
  operation: ClaimOperation,
  options: PublishClaimOptions = {},
): Promise<PublishedClaimHandle> {
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, kind);
  const owner = randomUUID();
  const processIdentity: ClaimProcessIdentity = {
    startedAt: PROCESS_STARTED_AT,
    platformIdentity: await currentPlatformProcessIdentity(),
  };

  for (;;) {
    const scan = await scanLockJournal(runDirectory, kind);
    if (scan.highestTicket >= MAX_LOCK_TICKET) {
      throw new LockJournalError(
        "LOCK_TICKET_OVERFLOW",
        `No further ${kind} lock ticket can be allocated`,
      );
    }
    const ticket = scan.highestTicket + 1n;
    const context: JournalTransitionContext = {
      kind,
      ticket: formatLockTicket(ticket),
      owner,
    };
    await options.transition?.("CLAIM_TICKET_PROPOSED", context);
    const canonical = canonicalClaim({
      kind,
      ticket,
      owner,
      pid: process.pid,
      process: processIdentity,
      at: new Date().toISOString(),
      operation,
    });
    try {
      const result = await prepareAndPublishClaim(paths, canonical, options);
      if (result === "conflict") {
        await options.transition?.("TICKET_CONFLICT", context);
        await options.transition?.("TICKET_RESCAN", context);
        continue;
      }
      const finalScan = await scanLockJournal(runDirectory, kind);
      const published = finalScan.claims.find(
        (claim) => claim.ticket === canonical.record.ticket,
      );
      if (
        !published ||
        published.owner !== owner ||
        published.claimDigest !== canonical.record.claimDigest
      ) {
        throw new LockJournalError(
          "LOCK_OWNERSHIP_LOST",
          `Published ${kind} claim failed final journal validation`,
        );
      }
      return {
        runDirectory,
        kind,
        ticket,
        owner,
        claimDigest: published.claimDigest,
        claim: published,
      };
    } catch (error) {
      return releaseExactClaimAfterPublicationFailure(
        runDirectory,
        kind,
        ticket,
        canonical,
        error,
        options,
      );
    }
  }
}

async function readExactClaim(
  runDirectory: string,
  kind: LockKind,
  ticket: bigint,
): Promise<ClaimRecordV3> {
  const ticketText = formatLockTicket(ticket);
  const claimPath = path.join(
    journalPaths(runDirectory, kind).claims,
    `${ticketText}.json`,
  );
  return parseClaimBytes(await readOrdinaryRecord(claimPath), kind, ticket);
}

async function readExactRelease(
  runDirectory: string,
  claim: ClaimRecordV3,
): Promise<ReleaseRecordV3 | undefined> {
  const releasePath = path.join(
    journalPaths(runDirectory, claim.kind).releases,
    releaseBasename(claim),
  );
  try {
    const stat = await lstat(releasePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Canonical release path is not an ordinary regular file`,
      );
    }
  } catch (error) {
    if (error instanceof LockJournalError) throw error;
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  return parseReleaseBytes(await readOrdinaryRecord(releasePath), claim);
}

function requireHandleMatchesClaim(
  handle: PublishedClaimHandle,
  claim: ClaimRecordV3,
): void {
  if (
    handle.kind !== claim.kind ||
    handle.claim.ticket !== claim.ticket ||
    handle.ticket !== parseLockTicket(claim.ticket) ||
    handle.owner !== claim.owner ||
    handle.claimDigest !== claim.claimDigest
  ) {
    throw new LockJournalError(
      "LOCK_OWNERSHIP_LOST",
      `Retained lock claim identity no longer matches its exact published record`,
    );
  }
}

export async function validateClaimOwnership(
  handle: PublishedClaimHandle,
  options: PublishClaimOptions = {},
): Promise<void> {
  const fullScan = await scanLockJournal(handle.runDirectory, handle.kind);
  if (handle.ticket > fullScan.highestTicket) {
    throw new LockJournalError(
      "LOCK_OWNERSHIP_LOST",
      `Retained ${handle.kind} ticket is outside the published contiguous range`,
    );
  }
  const context: JournalTransitionContext = {
    kind: handle.kind,
    ticket: handle.claim.ticket,
    owner: handle.owner,
  };
  await options.transition?.("OWNERSHIP_CHECK_READY", context);

  if (fullScan.legacy && !fullScan.legacyRelease) {
    if (fullScan.legacy.state === "corrupt") {
      throw new LockJournalError(
        "LOCK_CORRUPT",
        `Legacy ticket zero is corrupt and blocks ${handle.kind} ownership`,
      );
    }
    throw new LockJournalError(
      "LOCK_QUEUED",
      `${handle.kind} ticket ${handle.claim.ticket} is queued behind legacy ticket zero`,
    );
  }

  for (let ticket = 1n; ticket < handle.ticket; ticket += 1n) {
    const ticketText = formatLockTicket(ticket);
    const rawClaim = fullScan.rawClaims.get(ticketText);
    if (rawClaim) {
      if (!fullScan.rawReleases.has(ticketText)) {
        throw new LockJournalError(
          "LOCK_CORRUPT",
          `Corrupt lower ${handle.kind} ticket ${ticketText} has no exact resolution`,
        );
      }
      continue;
    }
    const lowerClaim = await readExactClaim(handle.runDirectory, handle.kind, ticket);
    if (!(await readExactRelease(handle.runDirectory, lowerClaim))) {
      throw new LockJournalError(
        "LOCK_QUEUED",
        `${handle.kind} ticket ${handle.claim.ticket} is queued behind ${lowerClaim.ticket}`,
      );
    }
  }

  const ownClaim = await readExactClaim(
    handle.runDirectory,
    handle.kind,
    handle.ticket,
  );
  requireHandleMatchesClaim(handle, ownClaim);
  if (await readExactRelease(handle.runDirectory, ownClaim)) {
    throw new LockJournalError(
      "LOCK_OWNERSHIP_LOST",
      `${handle.kind} ticket ${ownClaim.ticket} was released before protected entry`,
    );
  }

  // Immediate final exact-path recheck. No enumeration or unrelated await occurs between this
  // check and returning ownership to the caller.
  if (await readExactRelease(handle.runDirectory, ownClaim)) {
    throw new LockJournalError(
      "LOCK_OWNERSHIP_LOST",
      `${handle.kind} ticket ${ownClaim.ticket} lost ownership at protected entry`,
    );
  }
  await options.transition?.("OWNERSHIP_ENTERED", context);
}

export async function publishClaimRelease(
  handle: PublishedClaimHandle,
  options: PublishClaimOptions = {},
): Promise<CanonicalRecord<ReleaseRecordV3>> {
  await initializeLockJournal(handle.runDirectory);
  const exactClaim = await readExactClaim(
    handle.runDirectory,
    handle.kind,
    handle.ticket,
  );
  requireHandleMatchesClaim(handle, exactClaim);
  const canonical = canonicalRelease(exactClaim);
  const paths = journalPaths(handle.runDirectory, handle.kind);
  const temporaryPath = path.join(paths.tmp, `.release.${randomUUID()}.tmp`);
  const finalPath = path.join(paths.releases, releaseBasename(exactClaim));
  const context: JournalTransitionContext = {
    kind: handle.kind,
    ticket: exactClaim.ticket,
    owner: exactClaim.owner,
  };
  let fileHandle;
  let created = false;
  let primaryError: unknown;
  try {
    fileHandle = await open(temporaryPath, "wx", 0o600);
    created = true;
    await fileHandle.writeFile(canonical.bytes, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    try {
      await chmod(temporaryPath, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    await options.transition?.("RELEASE_PREPARED", context);
    await requirePreparedBytes(temporaryPath, canonical.bytes);
    await options.transition?.("RELEASE_LINK_ATTEMPT_READY", context);
    try {
      await (options.linkFile ?? link)(temporaryPath, finalPath);
    } catch (error) {
      await reconcileExactPublication(
        finalPath,
        canonical.bytes,
        error,
        "Canonical claim release",
      );
    }
    const finalBytes = await readOrdinaryRecord(finalPath);
    const validated = parseReleaseBytes(finalBytes, exactClaim);
    if (
      finalBytes !== canonical.bytes ||
      validated.releaseDigest !== canonical.record.releaseDigest
    ) {
      throw corrupt(`Existing canonical release path has conflicting bytes`);
    }
    await options.transition?.("RELEASE_PUBLISHED", context);
    return canonical;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finishTemporaryCleanup(
      fileHandle,
      created ? [temporaryPath] : [],
      primaryError,
      "Claim release publication",
    );
  }
}

async function publishLegacyRelease(
  runDirectory: string,
  kind: LockKind,
  observed: LegacyLockOverlay,
  linkFile: LinkFile = link,
): Promise<CanonicalRecord<LegacyReleaseRecordV3>> {
  const current = await inspectLegacyLock(runDirectory, kind);
  if (
    !current ||
    current.basename !== observed.basename ||
    !current.rawBytes.equals(observed.rawBytes) ||
    current.rawDigest !== observed.rawDigest
  ) {
    throw new LockJournalError(
      "LOCK_OWNERSHIP_LOST",
      `Legacy ticket-zero bytes changed before exact release publication`,
    );
  }
  const canonical = canonicalLegacyRelease(current, kind);
  const paths = journalPaths(runDirectory, kind);
  const temporaryPath = path.join(paths.tmp, `.release.${randomUUID()}.tmp`);
  const finalPath = path.join(paths.releases, legacyReleaseBasename(current, kind));
  let fileHandle;
  let created = false;
  let primaryError: unknown;
  try {
    fileHandle = await open(temporaryPath, "wx", 0o600);
    created = true;
    await fileHandle.writeFile(canonical.bytes, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    try {
      await chmod(temporaryPath, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    await requirePreparedBytes(temporaryPath, canonical.bytes);
    try {
      await linkFile(temporaryPath, finalPath);
    } catch (error) {
      await reconcileExactPublication(
        finalPath,
        canonical.bytes,
        error,
        "Canonical legacy release",
      );
    }
    const finalBytes = await readOrdinaryRecord(finalPath);
    if (
      finalBytes !== canonical.bytes ||
      parseLegacyReleaseBytes(finalBytes, current, kind).releaseDigest !==
        canonical.record.releaseDigest
    ) {
      throw corrupt(`Existing legacy release path has conflicting bytes`);
    }
    const publishedTarget = await inspectLegacyLock(runDirectory, kind);
    if (
      !publishedTarget ||
      publishedTarget.basename !== current.basename ||
      !publishedTarget.rawBytes.equals(current.rawBytes) ||
      publishedTarget.rawDigest !== current.rawDigest
    ) {
      throw new LockJournalError(
        "LOCK_OWNERSHIP_LOST",
        `Legacy ticket-zero identity changed during exact release publication`,
      );
    }
    return canonical;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finishTemporaryCleanup(
      fileHandle,
      created ? [temporaryPath] : [],
      primaryError,
      "Legacy release publication",
    );
  }
}

async function publishRawClaimRelease(
  runDirectory: string,
  kind: LockKind,
  observed: RawClaimOverlay,
  options: Pick<PublishClaimOptions, "transition" | "linkFile"> = {},
): Promise<CanonicalRecord<RawClaimReleaseRecordV3>> {
  const claimPath = path.join(
    journalPaths(runDirectory, kind).claims,
    observed.basename,
  );
  const requireUnchangedTarget = async (): Promise<void> => {
    const currentBytes = await readStableOrdinaryBytes(claimPath);
    if (
      !currentBytes.equals(observed.rawBytes) ||
      digest(currentBytes) !== observed.rawDigest
    ) {
      throw new LockJournalError(
        "LOCK_OWNERSHIP_LOST",
        `Corrupt ${kind} claim bytes changed before exact raw resolution`,
      );
    }
  };
  await requireUnchangedTarget();
  const canonical = canonicalRawClaimRelease(observed, kind);
  const paths = journalPaths(runDirectory, kind);
  const temporaryPath = path.join(paths.tmp, `.release.${randomUUID()}.tmp`);
  const finalPath = path.join(paths.releases, rawClaimReleaseBasename(observed, kind));
  const context: JournalTransitionContext = {
    kind,
    ticket: observed.ticket,
    owner: observed.rawDigest,
  };
  let fileHandle;
  let created = false;
  let primaryError: unknown;
  try {
    fileHandle = await open(temporaryPath, "wx", 0o600);
    created = true;
    await fileHandle.writeFile(canonical.bytes, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    try {
      await chmod(temporaryPath, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    await requirePreparedBytes(temporaryPath, canonical.bytes);
    await options.transition?.("RELEASE_PREPARED", context);
    await options.transition?.("RELEASE_LINK_ATTEMPT_READY", context);
    await requireUnchangedTarget();
    try {
      await (options.linkFile ?? link)(temporaryPath, finalPath);
    } catch (error) {
      await reconcileExactPublication(
        finalPath,
        canonical.bytes,
        error,
        "Canonical corrupt-claim resolution",
      );
    }
    const finalBytes = await readOrdinaryRecord(finalPath);
    if (
      finalBytes !== canonical.bytes ||
      parseRawClaimReleaseBytes(finalBytes, observed, kind).releaseDigest !==
        canonical.record.releaseDigest
    ) {
      throw corrupt(`Existing corrupt-claim resolution path has conflicting bytes`);
    }
    return canonical;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finishTemporaryCleanup(
      fileHandle,
      created ? [temporaryPath] : [],
      primaryError,
      "Corrupt-claim resolution publication",
    );
  }
}

export async function recoverCurrentLock(
  runDirectory: string,
  kind: LockKind,
  options: {
    force: boolean;
    transition?: PublishClaimOptions["transition"];
    linkFile?: LinkFile;
    ownerDeathProof?: "process-identity" | "esrch-only";
  },
): Promise<void> {
  const scan = await scanLockJournal(runDirectory, kind, {
    allowUnresolvedRawClaims: true,
  });
  if (scan.legacy && !scan.legacyRelease) {
    if (scan.legacy.state === "corrupt") {
      if (!options.force) {
        throw new LockJournalError(
          "LOCK_CORRUPT",
          `Legacy ${kind} ticket zero is corrupt; force requires operator quiescence`,
        );
      }
    } else if (
      scan.legacy.state === "valid-live" ||
      (options.ownerDeathProof === "esrch-only" &&
        scan.legacy.pid !== undefined &&
        pidIsLiveUnlessEsrch(scan.legacy.pid))
    ) {
      if (kind === "admin-recovery") {
        throw new LockJournalError(
          "ADMIN_RECOVERY_CONCURRENT",
          `A live legacy administrative-recovery marker cannot be force-released`,
        );
      }
      if (!options.force) {
        throw new LockJournalError(
          "LOCK_LIVE_OWNER",
          `Legacy ${kind} ticket zero is held by live pid ${scan.legacy.pid}`,
        );
      }
    } else if (kind === "admin-recovery" && !options.force) {
      throw new LockJournalError(
        "LOCK_DEAD_OWNER",
        `Dead legacy administrative-recovery ticket zero requires force`,
      );
    }
    await publishLegacyRelease(
      runDirectory,
      kind,
      scan.legacy,
      options.linkFile,
    );
    return;
  }

  const validClaims = new Map(scan.claims.map((claim) => [claim.ticket, claim]));
  for (let ticket = 1n; ticket <= scan.highestTicket; ticket += 1n) {
    const ticketText = formatLockTicket(ticket);
    const rawClaim = scan.rawClaims.get(ticketText);
    if (rawClaim) {
      if (scan.rawReleases.has(ticketText)) continue;
      if (kind === "admin-recovery" || !options.force) {
        throw new LockJournalError(
          "LOCK_CORRUPT",
          `Corrupt ${kind} ticket ${ticketText} cannot be resolved under the current policy`,
        );
      }
      await publishRawClaimRelease(
        runDirectory,
        kind,
        rawClaim,
        {
          ...(options.transition ? { transition: options.transition } : {}),
          ...(options.linkFile ? { linkFile: options.linkFile } : {}),
        },
      );
      return;
    }

    const claim = validClaims.get(ticketText);
    if (!claim) {
      throw corrupt(`Contiguous ${kind} ticket ${ticketText} has no stable interpretation`);
    }
    if (scan.releases.has(ticketText)) continue;
    const live =
      options.ownerDeathProof === "esrch-only"
        ? pidIsLiveUnlessEsrch(claim.pid)
        : await claimIsLive(claim);
    if (live) {
      if (kind === "admin-recovery") {
        throw new LockJournalError(
          "ADMIN_RECOVERY_CONCURRENT",
          `Live administrative-recovery ticket ${claim.ticket} cannot be force-released`,
        );
      }
      if (!options.force) {
        throw new LockJournalError(
          "LOCK_LIVE_OWNER",
          `${kind} ticket ${claim.ticket} is held by live pid ${claim.pid}`,
        );
      }
    }
    if (!live && kind === "admin-recovery" && !options.force) {
      throw new LockJournalError(
        "LOCK_DEAD_OWNER",
        `Dead administrative-recovery ticket ${claim.ticket} requires force`,
      );
    }
    await publishClaimRelease(
      {
        runDirectory,
        kind,
        ticket: parseLockTicket(claim.ticket),
        owner: claim.owner,
        claimDigest: claim.claimDigest,
        claim,
      },
      options.transition ? { transition: options.transition } : {},
    );
    return;
  }
}
