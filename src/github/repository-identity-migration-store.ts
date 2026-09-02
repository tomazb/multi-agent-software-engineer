import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  ensureOrdinaryDirectory,
  readBoundedOrdinaryFile,
  requireOrdinaryDirectory,
  writeDurableAtomic,
  type DurableFileOptions,
} from "../durable-file.ts";

/**
 * Bounded restart-intent/status checkpoint for one explicit repository
 * identity migration (design doc §13).
 *
 * The checkpoint is observability and restart intent only. It never
 * authorizes anything: every migration invocation revalidates live config and
 * live GitHub access before it touches run or index state. Its only
 * fail-closed use is *blocking* -- a sibling checkpoint proving the same
 * normalized selector was already migrated under a different repository id.
 */
export interface RepositoryIdentityMigrationRecord {
  version: 1;
  repositoryId: number;
  legacyRepository: string;
  canonicalRepository: string;
  status: "in-progress" | "complete";
  startedAt: string;
  updatedAt: string;
}

const LABEL = "GitHub repository identity migration checkpoint";
const DIRECTORY_NAME = "repository-identity-migrations";
/** A checkpoint record is ~250 bytes; anything near this bound is already corrupt. */
const MAX_CHECKPOINT_BYTES = 4096;
const FILENAME_PATTERN = /^[0-9a-f]{64}\.json$/;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const RECORD_FIELDS = [
  "version",
  "repositoryId",
  "legacyRepository",
  "canonicalRepository",
  "status",
  "startedAt",
  "updatedAt",
] as const;

function invalid(cause?: unknown): Error {
  return new Error(`Invalid ${LABEL}`, cause === undefined ? undefined : { cause });
}

function isCanonicalLowercaseRepository(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REPOSITORY_PATTERN.test(value) &&
    value === value.toLowerCase()
  );
}

function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** `sha256(repositoryId + "\0" + legacyRepository)` hex, plus `.json`. */
export function repositoryIdentityMigrationFilename(
  repositoryId: number,
  legacyRepository: string,
): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw invalid();
  }
  if (!isCanonicalLowercaseRepository(legacyRepository)) {
    throw invalid();
  }
  const digest = createHash("sha256")
    .update(`${repositoryId}\0${legacyRepository}`)
    .digest("hex");
  return `${digest}.json`;
}

/**
 * Validates every field exactly. A record is never partially accepted and a
 * missing/extra key, a non-lowercase selector, a non-positive id, or a
 * non-round-tripping timestamp all fail closed.
 */
function parseRecord(raw: string): RepositoryIdentityMigrationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw invalid(error);
  }
  return validateRecord(parsed);
}

function validateRecord(candidate: unknown): RepositoryIdentityMigrationRecord {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw invalid();
  }
  const value = candidate as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.length !== RECORD_FIELDS.length ||
    RECORD_FIELDS.some((field) => !Object.hasOwn(value, field))
  ) {
    throw invalid();
  }
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.repositoryId) ||
    Number(value.repositoryId) <= 0 ||
    !isCanonicalLowercaseRepository(value.legacyRepository) ||
    !isCanonicalLowercaseRepository(value.canonicalRepository) ||
    (value.status !== "in-progress" && value.status !== "complete") ||
    !isExactTimestamp(value.startedAt) ||
    !isExactTimestamp(value.updatedAt)
  ) {
    throw invalid();
  }
  return {
    version: 1,
    repositoryId: Number(value.repositoryId),
    legacyRepository: value.legacyRepository,
    canonicalRepository: value.canonicalRepository,
    status: value.status,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
}

export class RepositoryIdentityMigrationStore {
  private readonly githubRoot: string;
  private readonly directory: string;
  private readonly durableOptions: DurableFileOptions;
  private readonly maxFileBytes: number;

  constructor(
    githubRoot: string,
    options: DurableFileOptions & { maxFileBytes?: number } = {},
  ) {
    this.githubRoot = githubRoot;
    this.directory = path.join(githubRoot, DIRECTORY_NAME);
    const { maxFileBytes, ...durableOptions } = options;
    this.durableOptions = durableOptions;
    this.maxFileBytes = maxFileBytes ?? MAX_CHECKPOINT_BYTES;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1) {
      throw new Error(`${LABEL} capacity must be a positive integer`);
    }
  }

  /** Absolute path of the checkpoint file for one `(repositoryId, legacyRepository)` pair. */
  recordPath(repositoryId: number, legacyRepository: string): string {
    return path.join(
      this.directory,
      repositoryIdentityMigrationFilename(repositoryId, legacyRepository),
    );
  }

  async read(
    repositoryId: number,
    legacyRepository: string,
  ): Promise<RepositoryIdentityMigrationRecord | undefined> {
    const filePath = this.recordPath(repositoryId, legacyRepository);
    let raw: string;
    try {
      await requireOrdinaryDirectory(this.githubRoot, "GitHub state namespace");
      await requireOrdinaryDirectory(this.directory, `${LABEL} namespace`);
      raw = await readBoundedOrdinaryFile(filePath, LABEL, this.maxFileBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const record = parseRecord(raw);
    if (
      record.repositoryId !== repositoryId ||
      record.legacyRepository !== legacyRepository
    ) {
      throw invalid();
    }
    return record;
  }

  async write(record: RepositoryIdentityMigrationRecord): Promise<void> {
    const validated = validateRecord(record);
    await requireOrdinaryDirectory(this.githubRoot, "GitHub state namespace");
    await ensureOrdinaryDirectory(this.directory, `${LABEL} namespace`, this.durableOptions);
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.maxFileBytes) {
      throw new Error(`${LABEL} exceeds the bounded ${this.maxFileBytes}-byte limit`);
    }
    await writeDurableAtomic(
      this.recordPath(validated.repositoryId, validated.legacyRepository),
      content,
      LABEL,
      this.durableOptions,
    );
  }

  /**
   * Every persisted checkpoint; a malformed sibling fails closed.
   *
   * A conflict scan cannot prove "no other id claims this selector" while any
   * sibling record is unreadable, so an unexpected entry is an error rather
   * than a skipped row.
   */
  async list(): Promise<RepositoryIdentityMigrationRecord[]> {
    let entries: string[];
    try {
      await requireOrdinaryDirectory(this.githubRoot, "GitHub state namespace");
      await requireOrdinaryDirectory(this.directory, `${LABEL} namespace`);
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: RepositoryIdentityMigrationRecord[] = [];
    for (const entry of [...entries].sort()) {
      if (!FILENAME_PATTERN.test(entry)) throw invalid();
      const raw = await readBoundedOrdinaryFile(
        path.join(this.directory, entry),
        LABEL,
        this.maxFileBytes,
      );
      const record = parseRecord(raw);
      if (
        repositoryIdentityMigrationFilename(record.repositoryId, record.legacyRepository) !==
        entry
      ) {
        throw invalid();
      }
      records.push(record);
    }
    return records;
  }
}
