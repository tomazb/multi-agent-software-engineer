import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DurableAtomicWriteOutcomeUnknownError,
  MAX_AUTHORITATIVE_FILE_BYTES,
  readBoundedOrdinaryFile,
  removeDurableFile,
  requireOrdinaryDirectory,
  syncDurableDirectory,
  writeDurableAtomic,
  type DurableFileOptions,
} from "./durable-file.ts";
import type {
  ArtifactReference,
  MasweConfig,
  RunRecord,
  WorkspaceBootstrapIntent,
  WorkflowEventType,
  WorkflowState,
} from "./domain.ts";
import { assertConfig, migrateConfig } from "./config.ts";
import { assertSafeRunId } from "./git-workspace.ts";
import {
  LockJournalError,
  publishClaimRelease,
  publishLockClaim,
  recoverCurrentLock,
  validateClaimOwnership,
  type ClaimOperation,
  type PublishClaimOptions,
  type PublishedClaimHandle,
} from "./lock-journal.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  redactSecrets,
  sanitizeDiagnostic,
} from "./redaction.ts";
import { sanitizeDurableRuntimeFailureSummary } from "./failure-diagnostics.ts";
import {
  exactRunRecord,
  nonNegativeRunRecordInteger,
  requiredRunRecordString,
} from "./run-record-validation.ts";
import { transition } from "./state-machine.ts";
import {
  canonicalArtifactReferencePath,
  generatedArtifactFileName,
  validateArtifactReferencePath,
} from "./artifact-path.ts";

function now(): string {
  return new Date().toISOString();
}

function makeRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LockMeta {
  pid: number;
  owner: string;
  at: string;
}

export interface ReclaimLockOptions {
  /** @deprecated Automatic reclaim is removed; use FileRunStore.unlock. */
  afterInspect?: (meta: LockMeta) => Promise<void>;
}

async function readLockMeta(lockPath: string): Promise<LockMeta | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    if (!raw.trim()) return undefined;
    const meta = JSON.parse(raw) as Partial<LockMeta>;
    if (typeof meta.pid !== "number" || typeof meta.owner !== "string" || typeof meta.at !== "string") {
      return undefined;
    }
    return { pid: meta.pid, owner: meta.owner, at: meta.at };
  } catch {
    return undefined;
  }
}

export interface RunStore {
  create(
    title: string,
    request: string,
    config: MasweConfig,
    options?: CreateRunOptions,
  ): Promise<RunRecord>;
  save(run: RunRecord): Promise<void>;
  load(runId: string): Promise<RunRecord>;
  list(): Promise<RunRecord[]>;
  applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord>;
  writeArtifact(run: RunRecord, name: string, content: string): Promise<ArtifactReference>;
  readArtifact(run: RunRecord, name: string): Promise<string | undefined>;
}

export interface CreateRunOptions {
  workspaceBootstrap?: WorkspaceBootstrapIntent;
  supersedes?: string;
}

function sanitizePersistedFailureMessage(message: string): string {
  return sanitizeDiagnostic(
    message,
    FAILURE_AGGREGATE_MAX_CODE_POINTS,
  ).text;
}

function cloneRecordWithout(
  source: Record<string, unknown>,
  omittedKey: string,
): Record<string, unknown> {
  const cloneable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== omittedKey) cloneable[key] = value;
  }
  return structuredClone(cloneable);
}

function sanitizeEventDetails(
  type: WorkflowEventType,
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  if (
    type === "FAIL" &&
    (typeof details.reason === "string" || "runtime" in details)
  ) {
    const safe = cloneRecordWithout(details, "runtime");
    if (typeof details.reason === "string") {
      safe.reason = sanitizePersistedFailureMessage(details.reason);
    }
    if ("runtime" in details) {
      const runtime = sanitizeDurableRuntimeFailureSummary(details.runtime);
      if (runtime) safe.runtime = runtime;
      else delete safe.runtime;
    }
    return safe;
  }
  const previousFailure = details.previousFailure;
  if (
    type === "RETRY_FROM_FAILED" &&
    previousFailure &&
    typeof previousFailure === "object"
  ) {
    const rawPrevious = previousFailure as Record<string, unknown>;
    const safe = cloneRecordWithout(details, "previousFailure");
    const previous = cloneRecordWithout(rawPrevious, "runtime");
    if (typeof rawPrevious.message === "string") {
      previous.message = sanitizePersistedFailureMessage(
        rawPrevious.message,
      );
    }
    if ("runtime" in rawPrevious) {
      const runtime = sanitizeDurableRuntimeFailureSummary(
        rawPrevious.runtime,
      );
      if (runtime) previous.runtime = runtime;
      else delete previous.runtime;
    }
    safe.previousFailure = previous;
    return safe;
  }
  return details;
}

function sanitizeRunFailureState(run: RunRecord): RunRecord {
  if (run.failure) {
    run.failure.message = sanitizePersistedFailureMessage(run.failure.message);
    if ("runtime" in run.failure) {
      const runtime = sanitizeDurableRuntimeFailureSummary(
        run.failure.runtime,
      );
      if (runtime) run.failure.runtime = runtime;
      else delete run.failure.runtime;
    }
  }
  if (run.terminalCleanup?.lastError) {
    run.terminalCleanup.lastError.message = sanitizePersistedFailureMessage(
      run.terminalCleanup.lastError.message,
    );
  }
  for (const event of run.events) {
    const safeDetails = sanitizeEventDetails(event.type, event.details);
    if (safeDetails) event.details = safeDetails;
    else delete event.details;
  }
  return run;
}

const RUN_RECORD_FIELDS = new Set([
  "schemaVersion",
  "version",
  "id",
  "title",
  "request",
  "repositoryPath",
  "state",
  "createdAt",
  "updatedAt",
  "approvals",
  "counters",
  "config",
  "artifacts",
  "events",
  "workspace",
  "workspaceBootstrap",
  "revalidation",
  "evidence",
  "github",
  "supersedes",
  "supersededBy",
  "failure",
  "terminalCleanup",
]);

export function migrateRunRecord(raw: unknown): RunRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error("Run record is not a JSON object");
  }
  const candidate = raw as Record<string, unknown>;
  const unsupported = Object.keys(candidate).find((key) => !RUN_RECORD_FIELDS.has(key));
  if (unsupported) {
    throw new Error(`Unsupported run record field: ${unsupported}`);
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error(
      `Unsupported run schemaVersion ${String(candidate.schemaVersion)}; expected 1`,
    );
  }
  if (!("config" in candidate)) {
    throw new Error("Run record config is required");
  }

  const runId = requiredRunRecordString(candidate.id, "Run record id", false);
  assertSafeRunId(runId);

  if (candidate.artifacts !== undefined && !Array.isArray(candidate.artifacts)) {
    throw new Error("Run record artifacts must be an array");
  }
  // Schema-v1 records from the earliest release omitted artifacts and version.
  const artifactsRaw = candidate.artifacts ?? [];
  const artifacts: ArtifactReference[] = artifactsRaw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Run artifact[${index}] must be an object`);
    }
    const artifact = item as Record<string, unknown>;
    const allowedArtifactFields = new Set([
      "name",
      "logicalName",
      "attempt",
      "path",
      "sha256",
      "createdAt",
    ]);
    const unsupportedArtifact = Object.keys(artifact).find(
      (key) => !allowedArtifactFields.has(key),
    );
    if (unsupportedArtifact) {
      throw new Error(`Unsupported run artifact[${index}] field: ${unsupportedArtifact}`);
    }
    for (const field of ["name", "path", "sha256"] as const) {
      if (!(field in artifact)) throw new Error(`Run artifact[${index}].${field} is required`);
    }
    const name = requiredRunRecordString(
      artifact.name,
      `Run artifact[${index}].name`,
      false,
    );
    const logicalName = artifact.logicalName === undefined
      ? name
      : requiredRunRecordString(
          artifact.logicalName,
          `Run artifact[${index}].logicalName`,
          false,
        );
    const attempt = artifact.attempt === undefined
      ? 1
      : nonNegativeRunRecordInteger(artifact.attempt, `Run artifact[${index}].attempt`);
    if (attempt < 1) throw new Error(`Run artifact[${index}].attempt must be positive`);
    const digest = requiredRunRecordString(
      artifact.sha256,
      `Run artifact[${index}].sha256`,
    );
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Run artifact[${index}].sha256 is invalid`);
    }
    const persistedPath = requiredRunRecordString(
      artifact.path,
      `Run artifact[${index}].path`,
    );
    const { canonicalPath } = validateArtifactReferencePath(runId, persistedPath);
    return {
      name,
      logicalName,
      attempt,
      path: canonicalPath,
      sha256: digest,
      createdAt: artifact.createdAt === undefined
        ? now()
        : requiredRunRecordString(artifact.createdAt, `Run artifact[${index}].createdAt`),
    };
  });

  const migratedConfig = migrateConfig(candidate.config);
  // Same type/range assertion as project config load — never apply env overrides here.
  assertConfig(migratedConfig);

  const github = candidate.github;
  if (github !== undefined) {
    if (!github || typeof github !== "object" || Array.isArray(github)) {
      throw new Error("Run record github association is invalid");
    }
    const association = github as Record<string, unknown>;
    const allowed = new Set([
      "installationId",
      "repository",
      "pullRequestNumber",
      "baseSha",
      "headSha",
      "branch",
      "suspended",
      "suspensionReason",
      "pendingCancellationHeadShas",
    ]);
    const unsupported = Object.keys(association).find((key) => !allowed.has(key));
    if (unsupported) {
      throw new Error(`Unsupported run record github field: ${unsupported}`);
    }
    const installationId = association.installationId;
    if (!Number.isSafeInteger(installationId) || (installationId as number) < 1) {
      throw new Error("Run record github.installationId must be a positive integer");
    }
    if (
      typeof association.repository !== "string" ||
      !/^[^/\s]+\/[^/\s]+$/.test(association.repository) ||
      association.repository !== association.repository.toLowerCase()
    ) {
      throw new Error("Run record github.repository must be a canonical owner/repo string");
    }
    const pullRequestNumber = association.pullRequestNumber;
    if (!Number.isSafeInteger(pullRequestNumber) || (pullRequestNumber as number) < 1) {
      throw new Error("Run record github.pullRequestNumber must be a positive integer");
    }
    for (const key of ["baseSha", "headSha", "branch"] as const) {
      if (typeof association[key] !== "string" || !association[key].trim()) {
        throw new Error(`Run record github.${key} must be a non-empty string`);
      }
    }
    if (association.suspended !== undefined && typeof association.suspended !== "boolean") {
      throw new Error("Run record github.suspended must be a boolean when set");
    }
    if (
      association.suspensionReason !== undefined &&
      (association.suspended !== true ||
        (association.suspensionReason !== "pull-request-closed" &&
          association.suspensionReason !== "authorization-revoked"))
    ) {
      throw new Error("Run record github.suspensionReason is invalid");
    }
    const pending = association.pendingCancellationHeadShas;
    if (pending !== undefined) {
      if (
        !Array.isArray(pending) ||
        pending.length < 1 ||
        pending.length > 64 ||
        pending.some((headSha) => typeof headSha !== "string" || !headSha) ||
        new Set(pending).size !== pending.length ||
        pending.includes(association.headSha)
      ) {
        throw new Error("Run record github.pendingCancellationHeadShas is invalid");
      }
    }
  }

  const version = candidate.version ?? 1;
  if (!Number.isSafeInteger(version) || Number(version) < 1) {
    throw new Error("Run record version is missing or invalid (fail-closed)");
  }
  return sanitizeRunFailureState(
    exactRunRecord(candidate, Number(version), migratedConfig, artifacts),
  );
}

export class FileRunStore implements RunStore {
  readonly root: string;
  private readonly cwd: string;
  private readonly lockRetries: number;
  private readonly durableOptions: DurableFileOptions;
  private readonly maxRunFileBytes: number;

  constructor(
    cwd: string,
    options: {
      lockStaleMs?: number;
      lockRetries?: number;
      maxRunFileBytes?: number;
    } & DurableFileOptions = {},
  ) {
    this.cwd = cwd;
    this.root = path.join(cwd, ".maswe", "runs");
    // lockStaleMs retained for API compatibility; reclaim is ownership/PID based, not age based.
    void options.lockStaleMs;
    this.lockRetries = options.lockRetries ?? 50;
    this.durableOptions = options;
    this.maxRunFileBytes = options.maxRunFileBytes ?? MAX_AUTHORITATIVE_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxRunFileBytes) || this.maxRunFileBytes < 1) {
      throw new Error("Run record capacity must be a positive integer");
    }
  }

  private runDirectory(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.root, runId);
  }

  private runFile(runId: string): string {
    return path.join(this.runDirectory(runId), "run.json");
  }

  private lockFile(runId: string): string {
    return path.join(this.runDirectory(runId), ".lock");
  }

  private adminLockFile(runId: string): string {
    return path.join(this.runDirectory(runId), ".admin.lock");
  }

  private async requireOrdinaryRunNamespace(runId: string): Promise<void> {
    await requireOrdinaryDirectory(path.dirname(this.root), "MASWE state namespace");
    await requireOrdinaryDirectory(this.root, "run store namespace");
    await requireOrdinaryDirectory(this.runDirectory(runId), "run record namespace");
  }

  private async requireOrdinaryArtifactNamespace(runId: string): Promise<string> {
    await this.requireOrdinaryRunNamespace(runId);
    const artifactDirectory = path.join(this.runDirectory(runId), "artifacts");
    await requireOrdinaryDirectory(artifactDirectory, "run artifact namespace");
    return artifactDirectory;
  }

  private async readRunFile(runId: string): Promise<RunRecord> {
    try {
      await this.requireOrdinaryRunNamespace(runId);
      const raw = await readBoundedOrdinaryFile(
        this.runFile(runId),
        "run record",
        this.maxRunFileBytes,
      );
      const record = migrateRunRecord(JSON.parse(raw));
      if (record.id !== runId) {
        throw new Error(`Run record id ${record.id} does not match requested run id ${runId}`);
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const missing = new Error(`Run ${runId} not found`, { cause: error }) as NodeJS.ErrnoException;
        missing.code = "ENOENT";
        throw missing;
      }
      throw error;
    }
  }

  private prepareRunRecord(run: RunRecord): { record: RunRecord; content: string } {
    const exact = migrateRunRecord(run);
    const content = `${JSON.stringify(exact, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.maxRunFileBytes) {
      throw new Error(`Run record exceeds its bounded ${this.maxRunFileBytes}-byte capacity`);
    }
    return { record: exact, content };
  }

  private async writePreparedRunRecord(
    prepared: { record: RunRecord; content: string },
  ): Promise<void> {
    await writeDurableAtomic(
      this.runFile(prepared.record.id),
      prepared.content,
      "run record",
      this.durableOptions,
    );
  }

  private adoptRunRecord(target: RunRecord, source: RunRecord): void {
    const mutable = target as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutable)) delete mutable[key];
    Object.assign(mutable, source);
  }

  private adoptArtifactPublication(target: RunRecord, source: RunRecord): void {
    target.version = source.version;
    target.updatedAt = source.updatedAt;
    target.artifacts = source.artifacts;
  }

  private async matchingCanonicalRecord(
    prepared: { record: RunRecord; content: string },
  ): Promise<RunRecord | undefined> {
    try {
      const observed = await this.readRunFile(prepared.record.id);
      const observedContent = `${JSON.stringify(observed, null, 2)}\n`;
      return observedContent === prepared.content ? observed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Same-invocation recovery for artifact DurableAtomicWriteOutcomeUnknownError.
   * Provenance is limited to this write: exact path, redacted bytes, and digest.
   * Foreign/mismatched targets are never adopted, overwritten, or blindly deleted.
   */
  private async confirmUncertainArtifactPublication(
    runId: string,
    absolutePath: string,
    expectedContent: string,
    expectedDigest: string,
    publicationError: DurableAtomicWriteOutcomeUnknownError,
  ): Promise<void> {
    let recovered: string;
    try {
      await this.requireOrdinaryArtifactNamespace(runId);
      recovered = await readBoundedOrdinaryFile(
        absolutePath,
        "run artifact",
        MAX_AUTHORITATIVE_FILE_BYTES,
      );
      await this.requireOrdinaryArtifactNamespace(runId);
    } catch (verifyError) {
      throw new AggregateError(
        [publicationError, verifyError],
        `Run ${runId} artifact publication outcome is unknown and the published target could not be verified`,
        { cause: publicationError },
      );
    }

    const recoveredDigest = sha256(recovered);
    if (recovered !== expectedContent || recoveredDigest !== expectedDigest) {
      throw new AggregateError(
        [
          publicationError,
          new Error(
            `Run ${runId} artifact publication outcome is unknown and the published target content/digest mismatch`,
          ),
        ],
        `Run ${runId} artifact publication outcome is unknown and the published target content/digest mismatch`,
        { cause: publicationError },
      );
    }

    try {
      await syncDurableDirectory(path.dirname(absolutePath), this.durableOptions);
    } catch (resyncError) {
      try {
        await removeDurableFile(
          absolutePath,
          "orphaned run artifact",
          this.durableOptions,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [publicationError, resyncError, cleanupError],
          `Run ${runId} artifact publication outcome unknown, durability reconfirmation failed, and durable cleanup also failed`,
          { cause: publicationError },
        );
      }
      throw new AggregateError(
        [publicationError, resyncError],
        `Run ${runId} artifact publication outcome unknown and durability could not be reconfirmed`,
        { cause: publicationError },
      );
    }
  }

  private async writeAndReconcile(
    target: RunRecord,
    prepared: { record: RunRecord; content: string },
  ): Promise<void> {
    try {
      await this.writePreparedRunRecord(prepared);
      this.adoptRunRecord(target, prepared.record);
    } catch (error) {
      if (error instanceof DurableAtomicWriteOutcomeUnknownError) {
        const observed = await this.matchingCanonicalRecord(prepared);
        if (observed) this.adoptRunRecord(target, observed);
      }
      throw error;
    }
  }

  /**
   * Ordered administrative journal shared by data-claim publication/release and unlock.
   * Dead or corrupt predecessors are never auto-released.
   */
  private async withAdminLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    return this.withJournalClaim(
      runId,
      "admin",
      "admin-serialize",
      fn,
      Math.max(this.lockRetries * 4, 8),
    );
  }

  /** Test hook exposing the admin critical section with barrier-friendly acquisition. */
  async withAdminLockForTest<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.withAdminLock(runId, fn);
  }

  /**
   * Explicit administrative recovery serialized by the immutable admin-recovery journal.
   * Recovery publishes exact releases and never deletes a claim or replacement owner.
   */
  async unlockAdmin(
    runId: string,
    options: {
      force?: boolean;
      /** Test hook after observing the current admin lock, before recovery proceeds. */
      afterObserve?: (meta: LockMeta | undefined) => Promise<void>;
      /** Test hook for deterministic child-process journal barriers. */
      transition?: PublishClaimOptions["transition"];
    } = {},
  ): Promise<void> {
    assertSafeRunId(runId);
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const observed = await readLockMeta(this.adminLockFile(runId));
    await options.afterObserve?.(observed);
    const transitionOptions: PublishClaimOptions = options.transition
      ? { transition: options.transition }
      : {};

    const recovery = await publishLockClaim(
      directory,
      "admin-recovery",
      "admin-recovery",
      transitionOptions,
    );
    let primaryError: unknown;
    try {
      for (;;) {
        try {
          await validateClaimOwnership(recovery, transitionOptions);
          break;
        } catch (error) {
          if (
            !(error instanceof LockJournalError) ||
            !["LOCK_QUEUED", "LOCK_CORRUPT"].includes(error.code)
          ) {
            throw error;
          }
          await recoverCurrentLock(directory, "admin-recovery", {
            force: options.force ?? false,
            ...transitionOptions,
          });
        }
      }
      // Recovery-stream ownership is freshly validated before inspecting admin state.
      await recoverCurrentLock(directory, "admin", {
        force: options.force ?? false,
        ...transitionOptions,
      });
    } catch (error) {
      primaryError = error;
    }

    let releaseError: unknown;
    try {
      await publishClaimRelease(recovery, transitionOptions);
    } catch (error) {
      releaseError = error;
    }
    if (primaryError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [primaryError, releaseError],
        `Run ${runId} admin recovery and exact recovery-claim release both failed`,
      );
    }
    if (primaryError !== undefined) throw primaryError;
    if (releaseError !== undefined) throw releaseError;
  }

  private async waitForJournalOwnership(
    runId: string,
    handle: PublishedClaimHandle,
    retries: number,
  ): Promise<void> {
    const effectiveRetries = Math.max(retries, 1);
    for (let attempt = 0; attempt < effectiveRetries; attempt += 1) {
      try {
        await validateClaimOwnership(handle);
        return;
      } catch (error) {
        if (!(error instanceof LockJournalError) || error.code !== "LOCK_QUEUED") {
          throw error;
        }
        if (attempt === effectiveRetries - 1) {
          throw new LockJournalError(
            "LOCK_QUEUED",
            `Run ${runId} ${handle.kind} ticket ${handle.claim.ticket} remained queued. ` +
              `Use explicit recovery if a lower owner is dead: ` +
              `${handle.kind === "data" ? `maswe unlock ${runId}` : `maswe unlock-admin ${runId}`}.`,
            { cause: error },
          );
        }
        await sleep(5 + attempt * 2);
      }
    }
  }

  private async withJournalClaim<T>(
    runId: string,
    kind: "admin" | "admin-recovery",
    operation: ClaimOperation,
    fn: () => Promise<T>,
    retries: number,
  ): Promise<T> {
    const handle = await publishLockClaim(
      this.runDirectory(runId),
      kind,
      operation,
    );
    let result: T | undefined;
    let primaryError: unknown;
    try {
      await this.waitForJournalOwnership(runId, handle, retries);
      // validateClaimOwnership's final exact release check is the last await before entry.
      result = await fn();
    } catch (error) {
      primaryError = error;
    }

    let releaseError: unknown;
    try {
      await publishClaimRelease(handle);
    } catch (error) {
      releaseError = error;
    }
    if (primaryError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [primaryError, releaseError],
        `Run ${runId} ${kind} protected work and exact release both failed`,
      );
    }
    if (primaryError !== undefined) throw primaryError;
    if (releaseError !== undefined) throw releaseError;
    return result as T;
  }

  private async acquireLock(runId: string): Promise<PublishedClaimHandle> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const handle = await this.withAdminLock(runId, () =>
      publishLockClaim(directory, "data", "store-write")
    );
    try {
      await this.waitForJournalOwnership(runId, handle, this.lockRetries);
      return handle;
    } catch (primaryError) {
      try {
        await this.withAdminLock(runId, () => publishClaimRelease(handle));
      } catch (releaseError) {
        throw new AggregateError(
          [primaryError, releaseError],
          `Run ${runId} data acquisition and queued-claim cancellation both failed`,
        );
      }
      throw primaryError;
    }
  }

  /**
   * Explicit recovery for abandoned data claims. Force is an operator quiescence
   * assertion; every path publishes an exact release under admin serialization.
   */
  async unlock(
    runId: string,
    options: {
      force?: boolean;
      /** Test hook after initial validation, before the admin-protected remove. */
      afterValidate?: (meta: LockMeta | undefined) => Promise<void>;
    } = {},
  ): Promise<void> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const meta = await readLockMeta(this.lockFile(runId));
    await options.afterValidate?.(meta);
    await this.withAdminLock(runId, async () => {
      // Discard the pre-admin observation and classify the current exact journal state.
      await recoverCurrentLock(directory, "data", {
        force: options.force ?? false,
      });
    });
  }

  private async releaseLock(
    runId: string,
    handle: PublishedClaimHandle,
  ): Promise<void> {
    await this.withAdminLock(runId, () => publishClaimRelease(handle));
  }

  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const handle = await this.acquireLock(runId);
    let result: T | undefined;
    let primaryError: unknown;
    try {
      // acquireLock returned only after exact-range and immediate own-release validation.
      result = await fn();
    } catch (error) {
      primaryError = error;
    }
    let releaseError: unknown;
    try {
      await this.releaseLock(runId, handle);
    } catch (error) {
      releaseError = error;
    }
    if (primaryError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [primaryError, releaseError],
        `Run ${runId} protected work and exact data release both failed`,
      );
    }
    if (primaryError !== undefined) throw primaryError;
    if (releaseError !== undefined) throw releaseError;
    return result as T;
  }

  async create(
    title: string,
    request: string,
    config: MasweConfig,
    options: CreateRunOptions = {},
  ): Promise<RunRecord> {
    const createdAt = now();
    const run: RunRecord = {
      schemaVersion: 1,
      version: 1,
      id: makeRunId(),
      title,
      request,
      repositoryPath: this.cwd,
      state: "CREATED",
      createdAt,
      updatedAt: createdAt,
      approvals: { brainstorm: false, design: false },
      counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
      config: structuredClone(config),
      artifacts: [],
      events: [],
      ...(options.workspaceBootstrap !== undefined
        ? { workspaceBootstrap: structuredClone(options.workspaceBootstrap) }
        : {}),
      ...(options.supersedes !== undefined ? { supersedes: options.supersedes } : {}),
    };
    await this.withLock(run.id, async () => {
      const prepared = this.prepareRunRecord(run);
      await this.writeAndReconcile(run, prepared);
    });
    return run;
  }

  async save(run: RunRecord): Promise<void> {
    await this.withLock(run.id, async () => {
      const onDisk = await this.readRunFile(run.id);
      if (onDisk.version !== run.version) {
        throw new Error(
          `Run ${run.id} version conflict: expected ${run.version}, on disk ${onDisk.version}`,
        );
      }
      const candidate = {
        ...run,
        version: run.version + 1,
        updatedAt: now(),
      } satisfies RunRecord;
      const prepared = this.prepareRunRecord(candidate);
      await this.writeAndReconcile(run, prepared);
    });
  }

  async load(runId: string): Promise<RunRecord> {
    return this.readRunFile(runId);
  }

  async list(): Promise<RunRecord[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        runs.push(await this.load(entry.name));
      } catch {
        // A partially written or manually removed run should not hide healthy runs.
      }
    }
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    const from = run.state;
    const safeDetails = sanitizeEventDetails(type, details);
    const requestedHeadSha = run.revalidation?.requestedHeadSha;
    const evidenceBindings = Object.values(run.evidence ?? {});
    const sameTargetEvidenceRecovery =
      run.revalidation?.originHeadSha === requestedHeadSha &&
      (from === "PR_READY" || from === "PR_REVIEW" || from === "MERGE_READY") &&
      (run.evidence?.quality?.headSha !== requestedHeadSha ||
        run.evidence?.verification?.headSha !== requestedHeadSha);
    const associatedHeadRecovery =
      run.github !== undefined &&
      run.revalidation?.source === "github" &&
      run.github.headSha === requestedHeadSha &&
      (sameTargetEvidenceRecovery ||
        (run.revalidation.originHeadSha !== requestedHeadSha &&
          evidenceBindings.every((binding) => binding?.headSha === requestedHeadSha)));
    const to = transition(from, type, {
      ...(safeDetails?.resumeState !== undefined
        ? { retryResumeState: safeDetails.resumeState as WorkflowState }
        : {}),
      ...(run.failure?.resumeState !== undefined
        ? { failureResumeState: run.failure.resumeState }
        : {}),
      hasRevalidation: run.revalidation !== undefined,
      associatedHeadRecovery,
      ...(run.revalidation?.returnState !== undefined
        ? { revalidationReturnState: run.revalidation.returnState }
        : {}),
    });
    run.state = to;
    run.events.push({
      id: randomUUID(),
      at: now(),
      type,
      actor,
      from,
      to,
      ...(safeDetails ? { details: safeDetails } : {}),
    });
    await this.save(run);
    return run;
  }

  async writeArtifact(run: RunRecord, name: string, content: string): Promise<ArtifactReference> {
    assertSafeRunId(run.id);
    const redacted = redactSecrets(content);
    const persistedBytes = Buffer.byteLength(redacted, "utf8");
    if (persistedBytes > MAX_AUTHORITATIVE_FILE_BYTES) {
      throw new Error(
        `Run artifact exceeds the authoritative file byte limit of ${MAX_AUTHORITATIVE_FILE_BYTES} bytes`,
      );
    }

    return this.withLock(run.id, async () => {
      const onDisk = await this.readRunFile(run.id);
      if (onDisk.version !== run.version) {
        throw new Error(
          `Run ${run.id} version conflict: stale artifact writer (caller ${run.version}, on disk ${onDisk.version})`,
        );
      }

      const next = structuredClone(onDisk);
      const logicalName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const priorAttempts = next.artifacts.filter((artifact) => artifact.logicalName === logicalName);
      const attempt = priorAttempts.reduce((max, artifact) => Math.max(max, artifact.attempt), 0) + 1;
      const candidateFileName = `${logicalName.replace(/\.md$/i, "")}.attempt-${attempt}.md`;
      const fileName = generatedArtifactFileName(candidateFileName);
      const relativePath = canonicalArtifactReferencePath(run.id, fileName);
      const absolutePath = path.join(this.root, run.id, "artifacts", fileName);

      const conflictingOwner = next.artifacts.find(
        (artifact) => artifact.path === relativePath && artifact.logicalName !== logicalName,
      );
      if (conflictingOwner) {
        throw new Error(
          `Artifact physical path ${relativePath} is already owned by logical artifact ${conflictingOwner.logicalName}`,
        );
      }
      try {
        await lstat(absolutePath);
        throw new Error(`Artifact physical path ${relativePath} already exists`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const reference: ArtifactReference = {
        name: logicalName,
        logicalName,
        attempt,
        path: relativePath,
        sha256: sha256(redacted),
        createdAt: now(),
      };

      const historical = priorAttempts.map((artifact) =>
        artifact.name === logicalName
          ? { ...artifact, name: `${logicalName}.attempt-${artifact.attempt}` }
          : artifact,
      );
      next.artifacts = [
        ...next.artifacts.filter((artifact) => artifact.logicalName !== logicalName),
        ...historical,
        reference,
      ];
      next.version += 1;
      next.updatedAt = now();
      // The authoritative record capacity is known before artifact publication, so a
      // deterministic record overflow cannot leave an orphaned artifact behind.
      const prepared = this.prepareRunRecord(next);
      try {
        await writeDurableAtomic(
          absolutePath,
          redacted,
          "run artifact",
          this.durableOptions,
        );
      } catch (error) {
        if (!(error instanceof DurableAtomicWriteOutcomeUnknownError)) throw error;
        await this.confirmUncertainArtifactPublication(
          run.id,
          absolutePath,
          redacted,
          reference.sha256,
          error,
        );
      }
      try {
        await this.writePreparedRunRecord(prepared);
        this.adoptArtifactPublication(run, prepared.record);
      } catch (error) {
        if (error instanceof DurableAtomicWriteOutcomeUnknownError) {
          const observed = await this.matchingCanonicalRecord(prepared);
          if (observed) this.adoptArtifactPublication(run, observed);
        } else {
          try {
            await removeDurableFile(
              absolutePath,
              "orphaned run artifact",
              this.durableOptions,
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Run ${run.id} artifact record publication and durable cleanup both failed`,
              { cause: error },
            );
          }
        }
        throw error;
      }

      return reference;
    });
  }

  async readArtifact(run: RunRecord, name: string): Promise<string | undefined> {
    const reference =
      run.artifacts.find((artifact) => artifact.name === name) ??
      run.artifacts.find((artifact) => artifact.logicalName === name && artifact.name === name);
    if (!reference) return undefined;
    const { fileName } = validateArtifactReferencePath(run.id, reference.path);
    const artifactDirectory = await this.requireOrdinaryArtifactNamespace(run.id);
    const content = await readBoundedOrdinaryFile(
      path.join(artifactDirectory, fileName),
      "run artifact",
      MAX_AUTHORITATIVE_FILE_BYTES,
    );
    await this.requireOrdinaryArtifactNamespace(run.id);
    const digest = sha256(content);
    if (digest !== reference.sha256) {
      throw new Error(
        `Artifact ${reference.name} digest mismatch: expected ${reference.sha256}, got ${digest}`,
      );
    }
    return content;
  }
}
