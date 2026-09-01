import path from "node:path";
import {
  containsDurableAtomicWriteOutcomeUnknown,
  MAX_AUTHORITATIVE_FILE_BYTES,
  readBoundedOrdinaryFile,
  requireOrdinaryDirectory,
  writeDurableAtomic,
  type DurableFileOptions,
} from "../durable-file.ts";
import type { AssociationRecord, SuspensionReason } from "./types.ts";
import { withGitHubJournal } from "./journal.ts";

export type { SuspensionReason } from "./types.ts";

function associationKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

function stableAssociationKey(repositoryId: number, pullRequestNumber: number): string {
  return `${repositoryId}#${pullRequestNumber}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseAssociationRecords(raw: string): Record<string, AssociationRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Invalid GitHub association index", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("Invalid GitHub association index");
  const result: Record<string, AssociationRecord> = {};
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
  const allowedFields = new Set([...requiredFields, "suspensionReason", "repositoryId"]);
  // Tracks, per run id, every (shape, repository, pullRequestNumber) claim seen so far so a
  // migration that inserted a stable record without atomically removing its legacy twin is
  // caught: the same run must never simultaneously hold a legacy and a stable claim on the
  // exact same (repository, pullRequestNumber) tuple.
  const claimsByRun = new Map<
    string,
    Array<{ stable: boolean; repository: string; pullRequestNumber: number }>
  >();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) throw new Error("Invalid GitHub association index");
    const hasRepositoryId = value.repositoryId !== undefined;
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
      (hasRepositoryId &&
        (!Number.isSafeInteger(value.repositoryId) || Number(value.repositoryId) <= 0)) ||
      key !==
        (hasRepositoryId
          ? stableAssociationKey(Number(value.repositoryId), Number(value.pullRequestNumber))
          : associationKey(value.repository, Number(value.pullRequestNumber))) ||
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
      !validTimestamp(value.updatedAt)
    ) {
      throw new Error("Invalid GitHub association index");
    }
    if (!value.suspended) {
      if (activeRuns.has(value.runId)) {
        throw new Error("Invalid GitHub association index: duplicate active run id");
      }
      activeRuns.add(value.runId);
    }
    const claims = claimsByRun.get(value.runId) ?? [];
    claims.push({
      stable: hasRepositoryId,
      repository: value.repository,
      pullRequestNumber: Number(value.pullRequestNumber),
    });
    claimsByRun.set(value.runId, claims);
    result[key] = value as unknown as AssociationRecord;
  }
  for (const [runId, claims] of claimsByRun) {
    const stableClaims = claims.filter((claim) => claim.stable);
    const legacyClaims = claims.filter((claim) => !claim.stable);
    for (const stableClaim of stableClaims) {
      for (const legacyClaim of legacyClaims) {
        if (
          stableClaim.repository === legacyClaim.repository &&
          stableClaim.pullRequestNumber === legacyClaim.pullRequestNumber
        ) {
          throw new Error(
            `Invalid GitHub association index: inconsistent stable/legacy claims for run ${runId}`,
          );
        }
      }
    }
  }
  return result;
}

function assertUniqueActiveRun(
  records: Record<string, AssociationRecord>,
  key: string,
  runId: string,
  suspended: boolean,
): void {
  if (suspended) return;
  const conflict = Object.entries(records).find(
    ([candidateKey, record]) =>
      candidateKey !== key && record.runId === runId && !record.suspended,
  );
  if (conflict) {
    throw new Error(`Run ${runId} is already associated to an active pull request`);
  }
}

/**
 * A stable `<repositoryId>#<pullRequestNumber>` key is a distinct pull request identity.
 * Binding must not silently reassign an already-active stable identity to a different run.
 */
function assertUniqueStablePrIdentity(
  records: Record<string, AssociationRecord>,
  key: string,
  runId: string,
  suspended: boolean,
): void {
  if (suspended) return;
  const existing = records[key];
  if (existing && !existing.suspended && existing.runId !== runId) {
    throw new Error(
      `Stable pull request ${key} is already associated with a different active run`,
    );
  }
}

type AssociationBindInput = Omit<AssociationRecord, "suspended" | "updatedAt"> & {
  suspended?: boolean;
};

/** Bind input for a stable, ID-primary association. Carries both the stable ID and the mutable name. */
export type StableAssociationBindInput = Omit<
  AssociationRecord,
  "repositoryId" | "suspended" | "updatedAt"
> & {
  repositoryId: number;
  suspended?: boolean;
};

export interface GitHubAssociationTransaction {
  // Transitional baseline methods retained through Task 10:
  find(repository: string, pullRequestNumber: number): AssociationRecord | undefined;
  bind(input: AssociationBindInput): AssociationRecord;
  suspend(
    repository: string,
    pullRequestNumber: number,
    reason: SuspensionReason,
  ): AssociationRecord | undefined;

  // New explicit stable/legacy APIs:
  findStable(repositoryId: number, pullRequestNumber: number): AssociationRecord | undefined;
  findLegacy(repository: string, pullRequestNumber: number): AssociationRecord | undefined;
  bindStable(input: StableAssociationBindInput): AssociationRecord;
  migrateLegacy(input: {
    legacyRepository: string;
    stable: StableAssociationBindInput;
  }): AssociationRecord;
  refreshCanonicalRepository(
    repositoryId: number,
    pullRequestNumber: number,
    repository: string,
  ): AssociationRecord | undefined;
  suspendStable(
    repositoryId: number,
    pullRequestNumber: number,
    reason: SuspensionReason,
  ): AssociationRecord | undefined;
  suspendLegacy(
    repository: string,
    pullRequestNumber: number,
    reason: SuspensionReason,
  ): AssociationRecord | undefined;
  /** Compensate only a known transaction failure; callbacks run in reverse registration order. */
  onRollback(callback: () => Promise<void>): void;
}

type WriteRecords = (filePath: string, content: string) => Promise<void>;

/** Serialize association index mutations with immutable journal ownership. */
export class GitHubAssociationIndex {
  private readonly githubRoot: string;
  private readonly filePath: string;
  private readonly writeRecords: WriteRecords;
  private readonly maxFileBytes: number;

  constructor(
    githubRoot: string,
    options: {
      lockStaleMs?: number;
      writeRecords?: WriteRecords;
      maxFileBytes?: number;
    } & DurableFileOptions = {},
  ) {
    this.githubRoot = githubRoot;
    this.filePath = path.join(githubRoot, "associations.json");
    this.writeRecords = options.writeRecords ?? ((filePath, content) =>
      writeDurableAtomic(filePath, content, "GitHub association index", options));
    this.maxFileBytes = options.maxFileBytes ?? MAX_AUTHORITATIVE_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1) {
      throw new Error("GitHub association index capacity must be a positive integer");
    }
    void options.lockStaleMs;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withGitHubJournal(
      this.githubRoot,
      "association",
      "associations",
      fn,
      { timeoutMs: 5_000 },
    );
  }

  private async readAll(): Promise<Record<string, AssociationRecord>> {
    try {
      await requireOrdinaryDirectory(this.githubRoot, "GitHub state namespace");
      const raw = await readBoundedOrdinaryFile(
        this.filePath,
        "GitHub association index",
        this.maxFileBytes,
      );
      return parseAssociationRecords(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(records: Record<string, AssociationRecord>): Promise<void> {
    const content = `${JSON.stringify(records, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.maxFileBytes) {
      throw new Error(
        `GitHub association index exceeds its bounded ${this.maxFileBytes}-byte capacity`,
      );
    }
    await this.writeRecords(this.filePath, content);
  }

  async withTransaction<T>(
    callback: (transaction: GitHubAssociationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withLock(async () => {
      const records = await this.readAll();
      let dirty = false;
      const rollbacks: Array<() => Promise<void>> = [];
      const transaction: GitHubAssociationTransaction = {
        find(repository, pullRequestNumber) {
          const record = records[associationKey(repository, pullRequestNumber)];
          return record ? { ...record } : undefined;
        },
        bind(input) {
          const key = associationKey(input.repository, input.pullRequestNumber);
          const suspended = input.suspended ?? false;
          assertUniqueActiveRun(records, key, input.runId, suspended);
          const record: AssociationRecord = {
            runId: input.runId,
            installationId: input.installationId,
            repository: input.repository,
            pullRequestNumber: input.pullRequestNumber,
            baseSha: input.baseSha,
            headSha: input.headSha,
            branch: input.branch,
            suspended,
            ...(input.suspensionReason !== undefined
              ? { suspensionReason: input.suspensionReason }
              : {}),
            updatedAt: new Date().toISOString(),
          };
          parseAssociationRecords(`${JSON.stringify({ [key]: record })}\n`);
          records[key] = record;
          dirty = true;
          return { ...record };
        },
        suspend(repository, pullRequestNumber, reason) {
          const record = records[associationKey(repository, pullRequestNumber)];
          if (!record) return undefined;
          if (!record.suspended) {
            record.suspended = true;
            record.suspensionReason = reason;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          } else if (record.suspensionReason !== reason) {
            record.suspensionReason = reason;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          }
          return { ...record };
        },
        findStable(repositoryId, pullRequestNumber) {
          const record = records[stableAssociationKey(repositoryId, pullRequestNumber)];
          return record ? { ...record } : undefined;
        },
        findLegacy(repository, pullRequestNumber) {
          const record = records[associationKey(repository, pullRequestNumber)];
          return record ? { ...record } : undefined;
        },
        bindStable(input) {
          const key = stableAssociationKey(input.repositoryId, input.pullRequestNumber);
          const suspended = input.suspended ?? false;
          assertUniqueActiveRun(records, key, input.runId, suspended);
          assertUniqueStablePrIdentity(records, key, input.runId, suspended);
          const record: AssociationRecord = {
            runId: input.runId,
            installationId: input.installationId,
            repositoryId: input.repositoryId,
            repository: input.repository,
            pullRequestNumber: input.pullRequestNumber,
            baseSha: input.baseSha,
            headSha: input.headSha,
            branch: input.branch,
            suspended,
            ...(input.suspensionReason !== undefined
              ? { suspensionReason: input.suspensionReason }
              : {}),
            updatedAt: new Date().toISOString(),
          };
          parseAssociationRecords(`${JSON.stringify({ [key]: record })}\n`);
          records[key] = record;
          dirty = true;
          return { ...record };
        },
        migrateLegacy(input) {
          const { legacyRepository, stable } = input;
          const legacyKey = associationKey(legacyRepository, stable.pullRequestNumber);
          const legacyRecord = records[legacyKey];
          if (!legacyRecord) {
            throw new Error(`No legacy association found for ${legacyKey}`);
          }
          if (legacyRecord.runId !== stable.runId) {
            throw new Error(
              `Legacy association ${legacyKey} belongs to run ${legacyRecord.runId}, not ${stable.runId}`,
            );
          }
          const stableKey = stableAssociationKey(stable.repositoryId, stable.pullRequestNumber);
          const suspended = stable.suspended ?? false;
          assertUniqueStablePrIdentity(records, stableKey, stable.runId, suspended);
          const record: AssociationRecord = {
            runId: stable.runId,
            installationId: stable.installationId,
            repositoryId: stable.repositoryId,
            repository: stable.repository,
            pullRequestNumber: stable.pullRequestNumber,
            baseSha: stable.baseSha,
            headSha: stable.headSha,
            branch: stable.branch,
            suspended,
            ...(stable.suspensionReason !== undefined
              ? { suspensionReason: stable.suspensionReason }
              : {}),
            updatedAt: new Date().toISOString(),
          };
          // Remove the legacy key before the run-uniqueness recheck so the record's own prior
          // legacy entry (same run id) is not mistaken for a conflicting active duplicate.
          delete records[legacyKey];
          assertUniqueActiveRun(records, stableKey, record.runId, suspended);
          parseAssociationRecords(`${JSON.stringify({ [stableKey]: record })}\n`);
          records[stableKey] = record;
          dirty = true;
          return { ...record };
        },
        refreshCanonicalRepository(repositoryId, pullRequestNumber, repository) {
          const key = stableAssociationKey(repositoryId, pullRequestNumber);
          const existing = records[key];
          if (!existing) return undefined;
          if (existing.repository === repository) return { ...existing };
          const record: AssociationRecord = {
            ...existing,
            repository,
            updatedAt: new Date().toISOString(),
          };
          parseAssociationRecords(`${JSON.stringify({ [key]: record })}\n`);
          records[key] = record;
          dirty = true;
          return { ...record };
        },
        suspendStable(repositoryId, pullRequestNumber, reason) {
          const record = records[stableAssociationKey(repositoryId, pullRequestNumber)];
          if (!record) return undefined;
          if (!record.suspended) {
            record.suspended = true;
            record.suspensionReason = reason;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          } else if (record.suspensionReason !== reason) {
            record.suspensionReason = reason;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          }
          return { ...record };
        },
        suspendLegacy(repository, pullRequestNumber, reason) {
          const record = records[associationKey(repository, pullRequestNumber)];
          if (!record) return undefined;
          if (!record.suspended) {
            record.suspended = true;
            record.suspensionReason = reason;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          } else if (record.suspensionReason !== reason) {
            record.suspensionReason = reason;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          }
          return { ...record };
        },
        onRollback(callback) {
          rollbacks.push(callback);
        },
      };
      try {
        const result = await callback(transaction);
        if (dirty) await this.writeAll(records);
        return result;
      } catch (error) {
        if (containsDurableAtomicWriteOutcomeUnknown(error)) {
          // Rename already published the exact intended index. Retrying is required because the
          // parent sync failed, but rolling back the run would create known cross-file divergence.
          throw error;
        }
        const rollbackErrors: unknown[] = [];
        for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
          try {
            await rollbacks[index]!();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            error instanceof Error ? error.message : "Association transaction failed",
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  async bind(
    input: AssociationBindInput,
  ): Promise<AssociationRecord> {
    return this.withTransaction(async (transaction) => transaction.bind(input));
  }

  async find(
    repository: string,
    pullRequestNumber: number,
  ): Promise<AssociationRecord | undefined> {
    const records = await this.readAll();
    return records[associationKey(repository, pullRequestNumber)];
  }

  async findAllByRepositoryBranch(
    repository: string,
    branch: string,
  ): Promise<AssociationRecord[]> {
    const records = await this.readAll();
    return Object.values(records)
      .filter(
        (record) =>
          record.repository === repository && record.branch === branch && !record.suspended,
      )
      .map((record) => ({ ...record }))
      .sort(
        (left, right) =>
          left.pullRequestNumber - right.pullRequestNumber || left.runId.localeCompare(right.runId),
      );
  }

  async findStable(
    repositoryId: number,
    pullRequestNumber: number,
  ): Promise<AssociationRecord | undefined> {
    const records = await this.readAll();
    return records[stableAssociationKey(repositoryId, pullRequestNumber)];
  }

  /** All stable-keyed associations for a repository id, regardless of suspension state. */
  async findAllStableByRepositoryId(repositoryId: number): Promise<AssociationRecord[]> {
    const records = await this.readAll();
    return Object.values(records)
      .filter((record) => record.repositoryId === repositoryId)
      .map((record) => ({ ...record }))
      .sort(
        (left, right) =>
          left.pullRequestNumber - right.pullRequestNumber || left.runId.localeCompare(right.runId),
      );
  }

  /** Active, id-less legacy associations for a repository name: the explicit migration candidate universe. */
  async findAllLegacyByRepository(repository: string): Promise<AssociationRecord[]> {
    const records = await this.readAll();
    return Object.values(records)
      .filter(
        (record) =>
          record.repositoryId === undefined &&
          record.repository === repository &&
          !record.suspended,
      )
      .map((record) => ({ ...record }))
      .sort(
        (left, right) =>
          left.pullRequestNumber - right.pullRequestNumber || left.runId.localeCompare(right.runId),
      );
  }

  async findAllStableByRepositoryBranch(
    repositoryId: number,
    branch: string,
  ): Promise<AssociationRecord[]> {
    const records = await this.readAll();
    return Object.values(records)
      .filter(
        (record) =>
          record.repositoryId === repositoryId && record.branch === branch && !record.suspended,
      )
      .map((record) => ({ ...record }))
      .sort(
        (left, right) =>
          left.pullRequestNumber - right.pullRequestNumber || left.runId.localeCompare(right.runId),
      );
  }

  async findAllByInstallation(
    installationId: number,
    repository?: string,
  ): Promise<AssociationRecord[]> {
    const records = await this.readAll();
    return Object.values(records)
      .filter(
        (record) =>
          record.installationId === installationId &&
          (repository === undefined || record.repository === repository),
      )
      .map((record) => ({ ...record }))
      .sort(
        (left, right) =>
          left.repository.localeCompare(right.repository) ||
          left.pullRequestNumber - right.pullRequestNumber ||
          left.runId.localeCompare(right.runId),
      );
  }

  async suspend(
    repository: string,
    pullRequestNumber: number,
    reason: "pull-request-closed" | "authorization-revoked" = "authorization-revoked",
  ): Promise<AssociationRecord | undefined> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const key = associationKey(repository, pullRequestNumber);
      const record = records[key];
      if (!record) return undefined;
      if (!record.suspended) {
        record.suspended = true;
        record.suspensionReason = reason;
        record.updatedAt = new Date().toISOString();
        await this.writeAll(records);
      } else if (record.suspensionReason !== reason) {
        record.suspensionReason = reason;
        record.updatedAt = new Date().toISOString();
        await this.writeAll(records);
      }
      return { ...record };
    });
  }

  async suspendInstallation(installationId: number): Promise<AssociationRecord[]> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const affected: AssociationRecord[] = [];
      let dirty = false;
      for (const record of Object.values(records)) {
        if (record.installationId !== installationId) continue;
        if (!record.suspended) {
          record.suspended = true;
          record.suspensionReason = "authorization-revoked";
          record.updatedAt = new Date().toISOString();
          dirty = true;
        } else if (record.suspensionReason !== "authorization-revoked") {
          record.suspensionReason = "authorization-revoked";
          record.updatedAt = new Date().toISOString();
          dirty = true;
        }
        affected.push({ ...record });
      }
      if (dirty) await this.writeAll(records);
      return affected;
    });
  }

  async suspendRepository(
    installationId: number,
    repository: string,
  ): Promise<AssociationRecord[]> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const affected: AssociationRecord[] = [];
      let dirty = false;
      for (const record of Object.values(records)) {
        if (record.installationId !== installationId || record.repository !== repository) {
          continue;
        }
        if (!record.suspended) {
          record.suspended = true;
          record.suspensionReason = "authorization-revoked";
          record.updatedAt = new Date().toISOString();
          dirty = true;
        } else if (record.suspensionReason !== "authorization-revoked") {
          record.suspensionReason = "authorization-revoked";
          record.updatedAt = new Date().toISOString();
          dirty = true;
        }
        affected.push({ ...record });
      }
      if (dirty) await this.writeAll(records);
      return affected;
    });
  }
}
