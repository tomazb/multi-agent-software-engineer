import type { RunRecord } from "../domain.ts";
import { containsDurableAtomicWriteOutcomeUnknown } from "../durable-file.ts";
import type { RunStore } from "../store.ts";
import type { GitHubAssociationTransaction } from "./association.ts";

/**
 * Shared association-coupled run mutation safety (design doc §13.2).
 *
 * An association mutation may change only `github` and `evidence` on the run.
 * A *known* transaction failure may compensate the run by restoring those two
 * fields; a durable write whose outcome is *unknown* is never blindly rolled
 * back -- it is rethrown so the caller re-reads and reconciles.
 */

export function eventHistoryIdentity(events: RunRecord["events"]): string {
  return JSON.stringify(events.map((event) => ({
    id: event.id,
    at: event.at,
    type: event.type,
    actor: event.actor,
    from: event.from,
    to: event.to,
    details: event.details,
  })));
}

export function associationRollbackInvariant(run: RunRecord): string {
  const record = structuredClone(run) as unknown as Record<string, unknown>;
  delete record.version;
  delete record.updatedAt;
  delete record.github;
  delete record.evidence;
  return JSON.stringify(record);
}

/**
 * Compensates a *known* association failure by restoring only `github` and
 * `evidence` onto whatever is authoritatively on disk now.
 *
 * Silently does nothing when the attempted save never landed. Refuses -- and
 * changes nothing -- when the run has moved on since `attempted`, because the
 * compensation would then overwrite another writer's decision.
 */
export async function rollbackGitHubAssociationRunMutation(options: {
  store: RunStore;
  before: RunRecord;
  attempted: RunRecord;
}): Promise<void> {
  const { store, before, attempted } = options;
  const current = await store.load(before.id);
  if (current.version === before.version) return;
  if (current.version !== attempted.version) {
    throw new Error(
      `Run ${before.id} changed before association rollback: expected ${attempted.version}, on disk ${current.version}`,
    );
  }
  if (
    eventHistoryIdentity(current.events) !== eventHistoryIdentity(attempted.events) ||
    associationRollbackInvariant(current) !== associationRollbackInvariant(attempted)
  ) {
    throw new Error(
      `Run ${before.id} changed before association rollback: attempted snapshot no longer matches`,
    );
  }
  const rollback = structuredClone(current);
  if (before.github === undefined) delete rollback.github;
  else rollback.github = structuredClone(before.github);
  if (before.evidence === undefined) delete rollback.evidence;
  else rollback.evidence = structuredClone(before.evidence);
  await store.save(rollback);
}

/**
 * Persists an association-coupled run mutation and registers its compensation.
 *
 * `candidate` may differ from `before` only in `github` and `evidence`. On a
 * known save failure the run is compensated immediately and the original error
 * rethrown; on an outcome-unknown durable write nothing is compensated and the
 * error propagates so the caller re-reads and reconciles. Only after the save
 * is certain is a rollback registered on `transaction`, against a snapshot
 * taken at that moment -- callers keep mutating the live record afterwards.
 */
export async function saveGitHubAssociationMutation(options: {
  store: RunStore;
  transaction: GitHubAssociationTransaction;
  before: RunRecord;
  candidate: RunRecord;
}): Promise<void> {
  const { store, transaction, before, candidate } = options;
  if (
    eventHistoryIdentity(candidate.events) !== eventHistoryIdentity(before.events) ||
    associationRollbackInvariant(candidate) !== associationRollbackInvariant(before)
  ) {
    throw new Error(
      `Run ${before.id} association transaction changed fields outside github/evidence`,
    );
  }
  try {
    await store.save(candidate);
  } catch (error) {
    if (containsDurableAtomicWriteOutcomeUnknown(error)) throw error;
    try {
      await rollbackGitHubAssociationRunMutation({ store, before, attempted: candidate });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        error instanceof Error ? error.message : "Run save failed",
        { cause: error },
      );
    }
    throw error;
  }
  const attempted = structuredClone(candidate);
  transaction.onRollback(() =>
    rollbackGitHubAssociationRunMutation({ store, before, attempted }));
}
