import path from "node:path";
import { ensureOrdinaryDirectory, requireOrdinaryDirectory } from "./durable-file.ts";
import {
  LockJournalError,
  publishClaimRelease,
  publishLockClaim,
  recoverCurrentLock,
  scanLockJournal,
  validateClaimOwnership,
  type JournalTransition,
  type JournalTransitionContext,
  type PublishClaimOptions,
  type PublishedClaimHandle,
} from "./lock-journal.ts";

export const RUN_MUTATION_JOURNAL_DIRECTORY = ".mutation-journal-v1";

export type RunMutationRole =
  | "target"
  | "publication"
  | "terminal-cleanup"
  | "terminal-recovery";

const operationByRole = {
  target: "run-target-mutation",
  publication: "run-publication",
  "terminal-cleanup": "run-terminal-cleanup",
  "terminal-recovery": "run-terminal-recovery",
} as const;

export interface RunMutationFenceOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  transition?: (
    event: JournalTransition,
    context: JournalTransitionContext,
  ) => Promise<void>;
}

export interface RunMutationLease {
  readonly repositoryPath: string;
  readonly runId: string;
  readonly role: RunMutationRole;
  /**
   * Publication linearization point. A target intent queued after the final
   * authority reload but before this scan wins; a target queued later observes
   * the completed publication before it mutates the run.
   */
  assertNoQueuedTargetMutation(): Promise<void>;
}

interface RunMutationLeaseOwnership {
  handle: PublishedClaimHandle;
  publishOptions: PublishClaimOptions;
  repositoryPath: string;
  runId: string;
  role: RunMutationRole;
}

const leaseOwnership = new WeakMap<RunMutationLease, RunMutationLeaseOwnership>();

export async function assertRunMutationLease(
  lease: RunMutationLease,
  repositoryPath: string,
  runId: string,
  role: RunMutationRole,
): Promise<void> {
  const ownership = leaseOwnership.get(lease);
  if (
    !ownership ||
    ownership.repositoryPath !== repositoryPath ||
    ownership.runId !== runId ||
    ownership.role !== role ||
    lease.repositoryPath !== repositoryPath ||
    lease.runId !== runId ||
    lease.role !== role
  ) {
    throw new Error(`Invalid ${role} mutation lease for run ${runId}`);
  }
  await validateClaimOwnership(ownership.handle, ownership.publishOptions);
}

export class RunMutationSupersededError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} publication was superseded by a queued target mutation`);
    this.name = "RunMutationSupersededError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireSafeRunId(runId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`Invalid run id for mutation fence: ${runId}`);
  }
}

function validateOptions(options: RunMutationFenceOptions): {
  timeoutMs: number;
  pollIntervalMs: number;
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > DEFAULT_TIMEOUT_MS ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 1_000
  ) {
    throw new Error("Run mutation fence options are invalid");
  }
  return { timeoutMs, pollIntervalMs };
}

function isWaitingError(error: unknown): boolean {
  return (
    error instanceof LockJournalError &&
    (error.code === "LOCK_QUEUED" ||
      error.code === "LOCK_LIVE_OWNER" ||
      error.code === "LOCK_DEAD_OWNER")
  );
}

export function runMutationJournalRoot(repositoryPath: string, runId: string): string {
  requireSafeRunId(runId);
  return path.join(
    repositoryPath,
    ".maswe",
    "runs",
    runId,
    RUN_MUTATION_JOURNAL_DIRECTORY,
  );
}

async function acquire(
  root: string,
  role: RunMutationRole,
  options: RunMutationFenceOptions,
): Promise<PublishedClaimHandle> {
  const { timeoutMs, pollIntervalMs } = validateOptions(options);
  const publishOptions: PublishClaimOptions = options.transition
    ? { transition: options.transition }
    : {};
  const handle = await publishLockClaim(
    root,
    "data",
    operationByRole[role],
    publishOptions,
  );
  const started = Date.now();
  try {
    for (;;) {
      try {
        await validateClaimOwnership(handle, publishOptions);
        return handle;
      } catch (error) {
        if (!(error instanceof LockJournalError) || error.code !== "LOCK_QUEUED") {
          throw error;
        }
        try {
          await recoverCurrentLock(root, "data", {
            force: false,
            ownerDeathProof: "esrch-only",
            ...(options.transition ? { transition: options.transition } : {}),
          });
        } catch (recoveryError) {
          if (!isWaitingError(recoveryError)) throw recoveryError;
        }
        if (Date.now() - started >= timeoutMs) {
          throw new Error(`Timed out acquiring durable run mutation fence at ${root}`);
        }
        await sleep(pollIntervalMs);
      }
    }
  } catch (acquisitionError) {
    try {
      await publishClaimRelease(handle, publishOptions);
    } catch (releaseError) {
      throw new AggregateError(
        [acquisitionError, releaseError],
        "Run mutation acquisition and queued-claim release both failed",
        { cause: acquisitionError },
      );
    }
    throw acquisitionError;
  }
}

export async function withRunMutationFence<T>(
  repositoryPath: string,
  runId: string,
  role: RunMutationRole,
  callback: (lease: RunMutationLease) => Promise<T>,
  options: RunMutationFenceOptions = {},
): Promise<T> {
  const root = runMutationJournalRoot(repositoryPath, runId);
  const runDirectory = path.dirname(root);
  await requireOrdinaryDirectory(runDirectory, "run mutation fence parent");
  await ensureOrdinaryDirectory(root, "run mutation fence root");
  const handle = await acquire(root, role, options);
  const publishOptions: PublishClaimOptions = options.transition
    ? { transition: options.transition }
    : {};
  let result: T | undefined;
  let primaryError: unknown;
  let releaseError: unknown;
  const lease: RunMutationLease = {
    repositoryPath,
    runId,
    role,
    assertNoQueuedTargetMutation: async () => {
      await validateClaimOwnership(handle, publishOptions);
      const scan = await scanLockJournal(root, "data");
      const queuedTarget = scan.claims.some(
        (claim) =>
          BigInt(claim.ticket) > handle.ticket &&
          claim.operation === "run-target-mutation" &&
          !scan.releases.has(claim.ticket),
      );
      if (queuedTarget) throw new RunMutationSupersededError(runId);
    },
  };
  try {
    leaseOwnership.set(lease, {
      handle,
      publishOptions,
      repositoryPath,
      runId,
      role,
    });
    result = await callback(lease);
  } catch (error) {
    primaryError = error;
  } finally {
    leaseOwnership.delete(lease);
    try {
      await publishClaimRelease(handle, publishOptions);
    } catch (error) {
      releaseError = error;
    }
  }
  if (primaryError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [primaryError, releaseError],
      `Run ${runId} mutation and fence release both failed`,
      { cause: primaryError },
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}
