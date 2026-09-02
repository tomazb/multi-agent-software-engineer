import { isDeepStrictEqual } from "node:util";
import type {
  MasweConfig,
  RunGitHubAssociation,
  RunRecord,
  WorkflowState,
} from "../domain.ts";
import { containsDurableAtomicWriteOutcomeUnknown } from "../durable-file.ts";
import { invalidateStaleEvidence } from "../git-workspace.ts";
import { RevalidationService } from "../revalidation.ts";
import { withRunMutationFence } from "../run-mutation.ts";
import type { RunStore } from "../store.ts";
import {
  githubStateRoot,
  isRepositoryIdAllowed,
  parseOwnerRepo,
  pendingCancellationHeads,
} from "./adapter-identities.ts";
import type { GitHubAssociationIndex, GitHubAssociationTransaction } from "./association.ts";
import { saveGitHubAssociationMutation } from "./association-mutation.ts";
import { aliasLegacyAttemptOneChecks } from "./check-identity-migration.ts";
import { checkRunIdempotencyKey, type GitHubHttpClient } from "./checks.ts";
import { inspectLegacyGitHubJournalOwnership, withGitHubJournal } from "./journal.ts";
import { readGitHubPullRequestSnapshot } from "./pull-request.ts";
import { lookupCanonicalGitHubRepository } from "./repository-identity.ts";
import {
  RepositoryIdentityMigrationStore,
  type RepositoryIdentityMigrationRecord,
} from "./repository-identity-migration-store.ts";
import type { GitHubSideEffectStore } from "./side-effect-store.ts";
import type { GitHubRepositoryTokenProvider } from "./token.ts";
import { MASWE_CHECK_NAMES, type AssociationRecord, type SuspensionReason } from "./types.ts";

/** Deterministic crash/restart seam names (design doc §19.8). */
export type RepositoryIdentityMigrationStep =
  | "checkpoint-started"
  | "association-published"
  | "revalidation-routed"
  | "check-aliases-published"
  | "before-complete"
  | "complete";

export type RepositoryIdentityMigrationErrorCode =
  | "github-app-disabled"
  | "invalid-repository-id"
  | "invalid-legacy-selector"
  | "repository-id-not-allowlisted"
  | "write-authority-enabled"
  | "token-provider-missing"
  | "selector-identity-conflict"
  | "no-migration-candidates"
  | "installation-proof-failed"
  | "legacy-lock-blocked"
  | "run-index-conflict"
  | "pull-request-identity-conflict"
  | "outcome-unknown-unreconciled"
  | "rescan-not-converged";

export class RepositoryIdentityMigrationError extends Error {
  readonly code: RepositoryIdentityMigrationErrorCode;

  constructor(code: RepositoryIdentityMigrationErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RepositoryIdentityMigrationError";
    this.code = code;
  }
}

export interface RepositoryIdentityMigrationCandidateOutcome {
  runId: string;
  pullRequestNumber: number;
  /** True when this pass turned an unresolved legacy index record into a stable one. */
  migratedFromLegacy: boolean;
  canonicalRefreshed: boolean;
  headChanged: boolean;
  revalidationRouted: boolean;
  suspended: boolean;
  aliasedHeadShas: string[];
}

export interface RepositoryIdentityMigrationResult {
  repositoryId: number;
  legacyRepository: string;
  canonicalRepository: string;
  status: "complete";
  /** Candidate-universe passes performed, including the final converged rescan pass. */
  passes: number;
  installationIds: number[];
  candidates: RepositoryIdentityMigrationCandidateOutcome[];
}

/**
 * Bounded pass budget. Every pass re-derives the whole candidate universe and
 * only performs work that is still missing, so a quiescent repository
 * converges in two passes (one working pass, one clean rescan). More passes
 * mean something kept binding associations underneath the migration; failing
 * closed beats looping forever.
 */
const MAX_PASSES = 8;

/**
 * Workflow states whose GitHub-origin head drift enters Issue #28
 * revalidation. Mirrors the adapter's publication gate exactly -- routing a
 * run outside this set throws inside `RevalidationService`, so migration must
 * gate identically rather than discovering it as a failure.
 */
const ROUTABLE_STATES: readonly WorkflowState[] = [
  "PR_READY",
  "PR_REVIEW",
  "BUILDING",
  "CI_RUNNING",
  "VERIFYING",
  "RESOLVING",
  "MERGE_READY",
];

interface PassOutcome {
  canonicalRepository: string;
  installationIds: number[];
  outcomes: RepositoryIdentityMigrationCandidateOutcome[];
  performedWork: boolean;
}

function normalizeSelector(selector: string): string {
  if (typeof selector !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(selector)) {
    throw new RepositoryIdentityMigrationError(
      "invalid-legacy-selector",
      `Legacy repository selector must use the owner/repo form: ${String(selector)}`,
    );
  }
  const normalized = selector.toLowerCase();
  // Reuses the shared owner/repo grammar so the selector cannot diverge from
  // repository metadata parsing.
  parseOwnerRepo(normalized);
  return normalized;
}

/**
 * Explicit, restartable legacy repository identity migration (design doc
 * §12-§15).
 *
 * `legacyRepository` is only a local selector: it selects unresolved legacy
 * records and derives pre-#34 lock/check keys, and it never authorizes
 * anything. The stable `repositoryId` is the sole identity anchor, proven live
 * on every invocation through bounded canonical lookup and `base.repo.id`.
 */
export class RepositoryIdentityMigrationService {
  private readonly config: MasweConfig;
  private readonly store: RunStore;
  private readonly associations: GitHubAssociationIndex;
  private readonly sideEffects: GitHubSideEffectStore;
  private readonly http: GitHubHttpClient;
  private readonly tokenProvider: GitHubRepositoryTokenProvider;
  private readonly afterStep: ((step: RepositoryIdentityMigrationStep) => Promise<void>) | undefined;
  private readonly checkpoints: RepositoryIdentityMigrationStore;
  private readonly githubRoot: string;

  constructor(options: {
    cwd: string;
    config: MasweConfig;
    store: RunStore;
    associations: GitHubAssociationIndex;
    sideEffects: GitHubSideEffectStore;
    http: GitHubHttpClient;
    tokenProvider: GitHubRepositoryTokenProvider;
    afterStep?: (step: RepositoryIdentityMigrationStep) => Promise<void>;
    /** Durability/test seam; defaults to the checkpoint store under the GitHub state root. */
    checkpoints?: RepositoryIdentityMigrationStore;
  }) {
    this.config = options.config;
    this.store = options.store;
    this.associations = options.associations;
    this.sideEffects = options.sideEffects;
    this.http = options.http;
    this.tokenProvider = options.tokenProvider;
    this.afterStep = options.afterStep;
    this.githubRoot = githubStateRoot(options.cwd);
    this.checkpoints =
      options.checkpoints ?? new RepositoryIdentityMigrationStore(this.githubRoot);
  }

  async migrate(input: {
    legacyRepository: string;
    repositoryId: number;
  }): Promise<RepositoryIdentityMigrationResult> {
    const { repositoryId } = input;
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new RepositoryIdentityMigrationError(
        "invalid-repository-id",
        "GitHub repository id must be a positive safe integer",
      );
    }
    const legacyRepository = normalizeSelector(input.legacyRepository);

    // The checkpoint is never authorization: live config and live GitHub access
    // are revalidated here on every invocation, restart or not.
    const app = this.config.githubApp;
    if (!app?.enabled) {
      throw new RepositoryIdentityMigrationError(
        "github-app-disabled",
        "githubApp is not enabled in configuration",
      );
    }
    if (app.readOnlyChecks !== true) {
      throw new RepositoryIdentityMigrationError(
        "write-authority-enabled",
        "Repository identity migration requires the read-only checks policy",
      );
    }
    if (!isRepositoryIdAllowed(app, repositoryId)) {
      throw new RepositoryIdentityMigrationError(
        "repository-id-not-allowlisted",
        `Repository id ${repositoryId} is not allowlisted`,
      );
    }
    if (typeof this.tokenProvider !== "function") {
      throw new RepositoryIdentityMigrationError(
        "token-provider-missing",
        "Repository identity migration requires a repository-id-scoped token provider",
      );
    }

    return withGitHubJournal(
      this.githubRoot,
      "repository-identity",
      String(repositoryId),
      () => this.runMigration(repositoryId, legacyRepository),
      { timeoutMs: 60_000 },
    );
  }

  /** Everything below runs with `repository-identity(repositoryId)` held for the whole pass set. */
  private async runMigration(
    repositoryId: number,
    legacyRepository: string,
  ): Promise<RepositoryIdentityMigrationResult> {
    // Runs inside the repository-identity journal's scaffolding (already created
    // by `migrate()`'s `withGitHubJournal` call), but before any run, index, or
    // checkpoint state is written: prove no other repository id already claimed
    // this exact normalized selector.
    await this.assertNoConflictingSelector(repositoryId, legacyRepository);

    const existing = await this.checkpoints.read(repositoryId, legacyRepository);
    const startedAt = existing?.startedAt ?? new Date().toISOString();

    const outcomes = new Map<string, RepositoryIdentityMigrationCandidateOutcome>();
    let canonicalRepository = "";
    let installationIds: number[] = [];
    let passes = 0;
    for (;;) {
      passes += 1;
      if (passes > MAX_PASSES) {
        throw new RepositoryIdentityMigrationError(
          "rescan-not-converged",
          `Repository identity migration for ${legacyRepository} -> ${repositoryId} did not converge in ${MAX_PASSES} candidate-universe passes`,
        );
      }
      const pass = await this.runPass(repositoryId, legacyRepository, startedAt);
      canonicalRepository = pass.canonicalRepository;
      installationIds = pass.installationIds;
      for (const outcome of pass.outcomes) {
        const key = `${outcome.runId}#${outcome.pullRequestNumber}`;
        const previous = outcomes.get(key);
        outcomes.set(key, {
          ...outcome,
          migratedFromLegacy: outcome.migratedFromLegacy || (previous?.migratedFromLegacy ?? false),
          canonicalRefreshed:
            outcome.canonicalRefreshed || (previous?.canonicalRefreshed ?? false),
          headChanged: outcome.headChanged || (previous?.headChanged ?? false),
          revalidationRouted:
            outcome.revalidationRouted || (previous?.revalidationRouted ?? false),
        });
      }
      // A pass that performed no work is the §13.2 full candidate-universe rescan:
      // it re-derived the union, re-proved every installation, re-proved every
      // pull request, and found every run/index record already agreeing on the
      // stable identity and the current canonical metadata.
      if (!pass.performedWork) break;
    }

    await this.afterStep?.("before-complete");
    await this.writeCheckpoint({
      version: 1,
      repositoryId,
      legacyRepository,
      canonicalRepository,
      status: "complete",
      startedAt,
      updatedAt: new Date().toISOString(),
    });
    await this.afterStep?.("complete");

    return {
      repositoryId,
      legacyRepository,
      canonicalRepository,
      status: "complete",
      passes,
      installationIds,
      candidates: [...outcomes.values()].sort(
        (left, right) =>
          left.pullRequestNumber - right.pullRequestNumber ||
          left.runId.localeCompare(right.runId),
      ),
    };
  }

  /**
   * §13.2: the same normalized selector migrated under a different repository
   * id is a conflict that must mutate nothing. The checkpoint is used purely to
   * *block* here, never to authorize; an unreadable sibling record fails closed
   * because it cannot prove the absence of a conflict.
   */
  private async assertNoConflictingSelector(
    repositoryId: number,
    legacyRepository: string,
  ): Promise<void> {
    for (const record of await this.checkpoints.list()) {
      if (record.legacyRepository !== legacyRepository) continue;
      if (record.repositoryId === repositoryId) continue;
      throw new RepositoryIdentityMigrationError(
        "selector-identity-conflict",
        `Legacy selector ${legacyRepository} was already migrated to repository id ${record.repositoryId}, not ${repositoryId}`,
      );
    }
  }

  private async runPass(
    repositoryId: number,
    legacyRepository: string,
    startedAt: string,
  ): Promise<PassOutcome> {
    const candidates = await this.deriveCandidates(repositoryId, legacyRepository);
    if (candidates.length === 0) {
      throw new RepositoryIdentityMigrationError(
        "no-migration-candidates",
        `No unresolved legacy or stable association exists for ${legacyRepository} / repository id ${repositoryId}`,
      );
    }
    const installationIds = [
      ...new Set(candidates.map((candidate) => candidate.installationId)),
    ].sort((left, right) => left - right);
    const canonicalRepository = await this.proveCanonicalRepository(
      installationIds,
      repositoryId,
    );
    await this.preflightLegacyLocks(legacyRepository, candidates);

    if (await this.ensureProgressCheckpoint(
      repositoryId,
      legacyRepository,
      canonicalRepository,
      startedAt,
    )) {
      await this.afterStep?.("checkpoint-started");
    }

    const outcomes: RepositoryIdentityMigrationCandidateOutcome[] = [];
    let performedWork = false;
    for (const candidate of candidates) {
      const outcome = await this.processCandidate({
        repositoryId,
        legacyRepository,
        canonicalRepository,
        candidate,
      });
      outcomes.push(outcome.outcome);
      if (outcome.performedWork) {
        performedWork = true;
        // Restart-intent refresh after each completed unit of work: `updatedAt`
        // advances even though status/canonical are unchanged.
        await this.writeCheckpoint(
          {
            version: 1,
            repositoryId,
            legacyRepository,
            canonicalRepository,
            status: "in-progress",
            startedAt,
            updatedAt: new Date().toISOString(),
          },
          { force: true },
        );
      }
    }
    return { canonicalRepository, installationIds, outcomes, performedWork };
  }

  /**
   * §13.1 union: unresolved legacy records selected by normalized name, plus
   * every stable record carrying the target id. Re-derived on every pass so a
   * run that flipped legacy -> stable mid-migration stays visible.
   */
  private async deriveCandidates(
    repositoryId: number,
    legacyRepository: string,
  ): Promise<AssociationRecord[]> {
    const legacy = await this.associations.findAllLegacyByRepository(legacyRepository);
    const stable = await this.associations.findAllStableByRepositoryId(repositoryId);
    // Which key currently holds each candidate is deliberately NOT cached here:
    // it is re-resolved inside the association transaction, under the lock, where
    // it is authoritative rather than a stale scan result.
    return [...legacy, ...stable].sort(
      (left, right) =>
        left.pullRequestNumber - right.pullRequestNumber ||
        left.runId.localeCompare(right.runId),
    );
  }

  /**
   * §12: every affected installation mints an ID-scoped metadata credential and
   * proves the id through the bounded canonical lookup. A clean absence is an
   * authorization/identity failure; an ambiguous lookup failure keeps its own
   * typed, retryable identity and is never downgraded to absence here.
   */
  private async proveCanonicalRepository(
    installationIds: readonly number[],
    repositoryId: number,
  ): Promise<string> {
    let canonical: string | undefined;
    for (const installationId of installationIds) {
      const token = await this.tokenProvider(
        installationId,
        repositoryId,
        "metadata-reconcile",
      );
      const lookup = await lookupCanonicalGitHubRepository({
        http: this.http,
        token,
        repositoryId,
      });
      if (lookup.kind === "not-found") {
        throw new RepositoryIdentityMigrationError(
          "installation-proof-failed",
          `Installation ${installationId} cannot see repository id ${repositoryId}`,
        );
      }
      if (canonical !== undefined && canonical !== lookup.repository) {
        throw new RepositoryIdentityMigrationError(
          "installation-proof-failed",
          `Installations disagree on the canonical name for repository id ${repositoryId}: '${canonical}' and '${lookup.repository}'`,
        );
      }
      canonical = lookup.repository;
    }
    if (canonical === undefined) {
      throw new RepositoryIdentityMigrationError(
        "installation-proof-failed",
        `No installation proved repository id ${repositoryId}`,
      );
    }
    return canonical;
  }

  /**
   * §9.1 pre-#34 lock preflight. The inspected keys are built from the `--from`
   * selector, never from the reconciled canonical name: only the legacy name
   * could ever have keyed a pre-#34 journal. This is defence in depth and never
   * claims operator quiescence -- that stays a CLI/operator precondition.
   */
  private async preflightLegacyLocks(
    legacyRepository: string,
    candidates: readonly AssociationRecord[],
  ): Promise<void> {
    const pullRequestNumbers = [
      ...new Set(candidates.map((candidate) => candidate.pullRequestNumber)),
    ].sort((left, right) => left - right);
    for (const pullRequestNumber of pullRequestNumbers) {
      const legacyKey = `${legacyRepository}#${pullRequestNumber}`;
      for (const kind of ["publication", "association-identity"] as const) {
        const { state } = await inspectLegacyGitHubJournalOwnership({
          githubRoot: this.githubRoot,
          kind,
          logicalKey: legacyKey,
        });
        if (state === "live" || state === "malformed" || state === "ambiguous") {
          throw new RepositoryIdentityMigrationError(
            "legacy-lock-blocked",
            `Pre-#34 ${kind} journal for ${legacyKey} is ${state}; migration cannot proceed`,
          );
        }
      }
    }
  }

  private async ensureProgressCheckpoint(
    repositoryId: number,
    legacyRepository: string,
    canonicalRepository: string,
    startedAt: string,
  ): Promise<boolean> {
    const existing = await this.checkpoints.read(repositoryId, legacyRepository);
    if (existing && existing.canonicalRepository === canonicalRepository) {
      // Never downgrade a completed checkpoint, and never rewrite an identical
      // in-progress one: a converged rerun must mutate nothing.
      return false;
    }
    await this.writeCheckpoint({
      version: 1,
      repositoryId,
      legacyRepository,
      canonicalRepository,
      status: "in-progress",
      startedAt,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Writes the checkpoint, skipping an identical status/canonical pair so a
   * converged rerun performs zero writes. An outcome-unknown durable write is
   * reconciled by re-reading the exact intended record, never rolled back.
   */
  private async writeCheckpoint(
    record: RepositoryIdentityMigrationRecord,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const existing = await this.checkpoints.read(
      record.repositoryId,
      record.legacyRepository,
    );
    if (
      options.force !== true &&
      existing &&
      existing.status === record.status &&
      existing.canonicalRepository === record.canonicalRepository &&
      existing.startedAt === record.startedAt
    ) {
      return;
    }
    try {
      await this.checkpoints.write(record);
    } catch (error) {
      if (!containsDurableAtomicWriteOutcomeUnknown(error)) throw error;
      const reread = await this.checkpoints.read(
        record.repositoryId,
        record.legacyRepository,
      );
      if (!reread || !isDeepStrictEqual(reread, record)) {
        throw new RepositoryIdentityMigrationError(
          "outcome-unknown-unreconciled",
          `Repository identity migration checkpoint for ${record.legacyRepository} -> ${record.repositoryId} is not provably on disk after an outcome-unknown write`,
          error,
        );
      }
    }
  }

  private async processCandidate(context: {
    repositoryId: number;
    legacyRepository: string;
    canonicalRepository: string;
    candidate: AssociationRecord;
  }): Promise<{
    outcome: RepositoryIdentityMigrationCandidateOutcome;
    performedWork: boolean;
  }> {
    const { repositoryId, legacyRepository, candidate } = context;
    const { runId, pullRequestNumber } = candidate;
    try {
      // §9 order: repository-identity (already held) -> publication -> association-identity
      // -> run target -> global association transaction.
      return await this.withPullRequestFences(repositoryId, pullRequestNumber, async () =>
        this.migrateOnePullRequest(context));
    } catch (error) {
      if (!containsDurableAtomicWriteOutcomeUnknown(error)) throw error;
      // §13.2: never blindly roll back an outcome-unknown write. Re-read run,
      // index, checkpoint, and side-effect aliases, then let the next pass prove
      // and finish the exact intended stable identity.
      await this.reconcileOutcomeUnknown({
        repositoryId,
        legacyRepository,
        runId,
        pullRequestNumber,
        cause: error,
      });
      return {
        performedWork: true,
        outcome: {
          runId,
          pullRequestNumber,
          migratedFromLegacy: false,
          canonicalRefreshed: false,
          headChanged: false,
          revalidationRouted: false,
          suspended: candidate.suspended,
          aliasedHeadShas: [],
        },
      };
    }
  }

  private async migrateOnePullRequest(context: {
    repositoryId: number;
    legacyRepository: string;
    canonicalRepository: string;
    candidate: AssociationRecord;
  }): Promise<{
    outcome: RepositoryIdentityMigrationCandidateOutcome;
    performedWork: boolean;
  }> {
    const { repositoryId, legacyRepository, canonicalRepository, candidate } = context;
    const { runId, pullRequestNumber, installationId } = candidate;

    // §12/§14: ID-scoped pull-request-read credential, current canonical route,
    // and an exact `base.repo.id` ownership proof for every candidate.
    const readToken = await this.tokenProvider(
      installationId,
      repositoryId,
      "pull-request-read",
    );
    const snapshot = await readGitHubPullRequestSnapshot({
      http: this.http,
      token: readToken,
      repository: canonicalRepository,
      pullRequestNumber,
    });
    if (snapshot.baseRepositoryId !== repositoryId) {
      throw new RepositoryIdentityMigrationError(
        "pull-request-identity-conflict",
        `Pull request ${canonicalRepository}#${pullRequestNumber} targets repository id ${snapshot.baseRepositoryId}, not ${repositoryId}`,
      );
    }
    const liveHead = snapshot.headSha;
    const closed = snapshot.state === "closed";

    const mutation = await this.withRunTargetFence(runId, () =>
      this.associations.withTransaction(async (transaction) =>
        this.publishStableAssociation({
          transaction,
          repositoryId,
          legacyRepository,
          canonicalRepository,
          candidate,
          liveHead,
          closed,
        })));
    await this.afterStep?.("association-published");

    const revalidationRouted = mutation.suspended
      ? false
      : await this.routeStaleHead(runId, liveHead);
    await this.afterStep?.("revalidation-routed");

    // §15.2: only after revalidation state is durable may check ownership work run.
    const aliasedHeadShas = await this.aliasChecks({
      repositoryId,
      legacyRepository,
      canonicalRepository,
      installationId,
      runId,
      pullRequestNumber,
    });
    await this.afterStep?.("check-aliases-published");

    return {
      performedWork: mutation.performedWork || revalidationRouted,
      outcome: {
        runId,
        pullRequestNumber,
        migratedFromLegacy: mutation.migratedFromLegacy,
        canonicalRefreshed: mutation.canonicalRefreshed,
        headChanged: mutation.headChanged,
        revalidationRouted,
        suspended: mutation.suspended,
        aliasedHeadShas,
      },
    };
  }

  /**
   * The single durable identity mutation, run under the run target fence and
   * the global association transaction. The transaction and the run fence are
   * both released before any revalidation routing, because `RevalidationService`
   * reacquires the run target fence itself.
   */
  private async publishStableAssociation(options: {
    transaction: GitHubAssociationTransaction;
    repositoryId: number;
    legacyRepository: string;
    canonicalRepository: string;
    candidate: AssociationRecord;
    liveHead: string;
    closed: boolean;
  }): Promise<{
    performedWork: boolean;
    migratedFromLegacy: boolean;
    canonicalRefreshed: boolean;
    headChanged: boolean;
    suspended: boolean;
  }> {
    const {
      transaction,
      repositoryId,
      legacyRepository,
      canonicalRepository,
      candidate,
      liveHead,
      closed,
    } = options;
    const { runId, pullRequestNumber } = candidate;

    const legacyRecord = transaction.findLegacy(legacyRepository, pullRequestNumber);
    const stableRecord = transaction.findStable(repositoryId, pullRequestNumber);
    const indexRecord =
      legacyRecord?.runId === runId
        ? legacyRecord
        : stableRecord?.runId === runId
          ? stableRecord
          : undefined;
    if (!indexRecord) {
      throw new RepositoryIdentityMigrationError(
        "run-index-conflict",
        `GitHub association index no longer holds a record for run ${runId} on pull request ${pullRequestNumber}`,
      );
    }
    const fromLegacy = indexRecord === legacyRecord;

    const run = await this.store.load(runId);
    const github = this.requireAgreement({
      run,
      record: indexRecord,
      fromLegacy,
      repositoryId,
      legacyRepository,
    });

    const previousHeadSha = github.headSha;
    const headChanged = liveHead !== previousHeadSha;
    const pending = pendingCancellationHeads(
      github.pendingCancellationHeadShas,
      previousHeadSha,
      liveHead,
    );
    const suspended = (github.suspended ?? false) || closed;
    // Only a genuinely closed PR justifies defaulting to "pull-request-closed":
    // a run suspended-without-reason on an open PR must carry no reason rather
    // than inventing one the evidence does not support.
    const suspensionReason: SuspensionReason | undefined = suspended
      ? (github.suspensionReason ?? (closed ? "pull-request-closed" : undefined))
      : undefined;

    const before = structuredClone(run);
    if (headChanged) {
      // §14: a changed head makes old success unusable; existing #28 semantics own
      // the recovery from here.
      invalidateStaleEvidence(run, liveHead);
    }
    const next: RunGitHubAssociation = {
      ...github,
      repositoryId,
      repository: canonicalRepository,
      headSha: liveHead,
      suspended,
    };
    if (suspensionReason === undefined) delete next.suspensionReason;
    else next.suspensionReason = suspensionReason;
    if (pending.length === 0) delete next.pendingCancellationHeadShas;
    else next.pendingCancellationHeadShas = pending;
    run.github = next;

    const runChanged =
      !isDeepStrictEqual(before.github, run.github) ||
      !isDeepStrictEqual(before.evidence, run.evidence);
    if (runChanged) {
      await saveGitHubAssociationMutation({
        store: this.store,
        transaction,
        before,
        candidate: run,
      });
    }

    const desiredRecord = {
      runId,
      installationId: next.installationId,
      repositoryId,
      repository: canonicalRepository,
      pullRequestNumber,
      baseSha: next.baseSha,
      headSha: liveHead,
      branch: next.branch,
      suspended,
      ...(suspensionReason !== undefined ? { suspensionReason } : {}),
    };
    const canonicalRefreshed = indexRecord.repository !== canonicalRepository;
    let indexChanged = false;
    if (fromLegacy) {
      transaction.migrateLegacy({ legacyRepository, stable: desiredRecord });
      indexChanged = true;
    } else if (
      indexRecord.repository !== canonicalRepository ||
      indexRecord.headSha !== liveHead ||
      indexRecord.suspended !== suspended ||
      indexRecord.suspensionReason !== suspensionReason
    ) {
      transaction.bindStable(desiredRecord);
      indexChanged = true;
    }

    return {
      performedWork: runChanged || indexChanged,
      migratedFromLegacy: fromLegacy,
      canonicalRefreshed,
      headChanged,
      suspended,
    };
  }

  /**
   * §12: run and index must agree on installation, legacy name, PR number,
   * base/head SHA, branch, and suspension state -- except for an already
   * idempotent same-ID record, and except for the exact partial shape a crash
   * between the run publication and the index commit leaves behind (run already
   * stable, index still legacy). Everything else stops the migration; MASWE
   * never picks one persisted copy as probably correct.
   */
  private requireAgreement(options: {
    run: RunRecord;
    record: AssociationRecord;
    fromLegacy: boolean;
    repositoryId: number;
    legacyRepository: string;
  }): RunGitHubAssociation {
    const { run, record, fromLegacy, repositoryId, legacyRepository } = options;
    const conflict = (detail: string): never => {
      throw new RepositoryIdentityMigrationError(
        "run-index-conflict",
        `Run ${run.id} and GitHub association ${record.repository}#${record.pullRequestNumber} disagree: ${detail}`,
      );
    };
    const github = run.github;
    if (!github) conflict("the run has no github association");
    const association = github as RunGitHubAssociation;
    if (association.installationId !== record.installationId) conflict("installation id");
    if (association.pullRequestNumber !== record.pullRequestNumber) {
      conflict("pull request number");
    }
    if (association.baseSha !== record.baseSha) conflict("base SHA");
    if (association.branch !== record.branch) conflict("branch");
    if (
      association.repositoryId !== undefined &&
      association.repositoryId !== repositoryId
    ) {
      conflict(`run holds foreign stable repository id ${association.repositoryId}`);
    }
    if (fromLegacy) {
      if (association.repositoryId === undefined) {
        if (association.repository !== legacyRepository) conflict("legacy repository name");
        if (association.headSha !== record.headSha) conflict("head SHA");
        if ((association.suspended ?? false) !== record.suspended) conflict("suspension state");
      }
      // Otherwise the run is already exactly the intended stable identity and only
      // the index commit is missing; nothing further to compare.
      return association;
    }
    if (association.repositoryId === undefined) {
      conflict("the index record is stable while the run is still legacy");
    }
    if (association.repository !== record.repository) conflict("canonical repository name");
    if (association.headSha !== record.headSha) conflict("head SHA");
    if ((association.suspended ?? false) !== record.suspended) conflict("suspension state");
    if ((association.suspensionReason ?? undefined) !== (record.suspensionReason ?? undefined)) {
      conflict("suspension reason");
    }
    return association;
  }

  /**
   * §14 head drift enters the existing Issue #28 revalidation, and only after
   * the run target fence and global association transaction are released, so
   * `RevalidationService.route()` acquires the run fence in the documented
   * order. Still runs under the repository-identity and pull-request fences.
   */
  private async routeStaleHead(runId: string, liveHead: string): Promise<boolean> {
    const run = await this.store.load(runId);
    if (run.github?.suspended === true) return false;
    if (run.revalidation === undefined && !ROUTABLE_STATES.includes(run.state)) return false;
    const previousHeadSha = run.revalidation?.requestedHeadSha ?? run.workspace?.headSha;
    if (!previousHeadSha) {
      throw new RepositoryIdentityMigrationError(
        "run-index-conflict",
        `Run ${runId} has no authoritative workflow target for GitHub head ${liveHead}`,
      );
    }
    // Migration is not a publication: it routes only genuine head drift, and never
    // manufactures a same-target evidence-recovery revalidation of its own.
    if (previousHeadSha === liveHead) return false;
    await new RevalidationService(this.store).route(runId, {
      source: "github",
      previousHeadSha,
      requestedHeadSha: liveHead,
      expectedRunVersion: run.version,
      actor: "github-app",
    });
    return true;
  }

  /**
   * §15.1/§15.2 check ownership. Runs for every repository carrying legacy
   * attempt-1 state, including one whose name never changed: `upsertCheck`
   * derives its idempotency key from `repositoryId`, so every pre-#34 check is
   * unfindable under the stable key until it is aliased.
   */
  private async aliasChecks(options: {
    repositoryId: number;
    legacyRepository: string;
    canonicalRepository: string;
    installationId: number;
    runId: string;
    pullRequestNumber: number;
  }): Promise<string[]> {
    const run = await this.store.load(options.runId);
    const github = run.github;
    if (!github) return [];
    const headShas = [
      ...new Set([github.headSha, ...(github.pendingCancellationHeadShas ?? [])]),
    ];
    const token = await this.tokenProvider(
      options.installationId,
      options.repositoryId,
      "checks",
    );
    await aliasLegacyAttemptOneChecks({
      repositoryId: options.repositoryId,
      legacyRepository: options.legacyRepository,
      repository: options.canonicalRepository,
      pullRequestNumber: options.pullRequestNumber,
      headShas,
      token,
      http: this.http,
      sideEffects: this.sideEffects,
    });
    return headShas;
  }

  /**
   * §13.2 outcome-unknown reconciliation: re-read run, index, checkpoint, and
   * the affected side-effect aliases. Anything unreadable, or a run that now
   * carries a foreign stable id, is a concrete conflict; otherwise the next
   * candidate-universe pass proves and finishes the exact intended state.
   */
  private async reconcileOutcomeUnknown(options: {
    repositoryId: number;
    legacyRepository: string;
    runId: string;
    pullRequestNumber: number;
    cause: unknown;
  }): Promise<void> {
    const { repositoryId, legacyRepository, runId, pullRequestNumber, cause } = options;
    const unreconciled = (detail: string): never => {
      throw new RepositoryIdentityMigrationError(
        "outcome-unknown-unreconciled",
        `Outcome-unknown durable write for run ${runId} on pull request ${pullRequestNumber} could not be reconciled: ${detail}`,
        cause,
      );
    };
    const run = await this.store.load(runId);
    const repositoryIdOnDisk = run.github?.repositoryId;
    if (repositoryIdOnDisk !== undefined && repositoryIdOnDisk !== repositoryId) {
      unreconciled(`run holds foreign stable repository id ${repositoryIdOnDisk}`);
    }
    const legacyRecord = await this.associations.findLegacy(
      legacyRepository,
      pullRequestNumber,
    );
    const stableRecord = await this.associations.findStable(
      repositoryId,
      pullRequestNumber,
    );
    if (legacyRecord === undefined && stableRecord === undefined) {
      unreconciled("neither a legacy nor a stable association record is on disk");
    }
    await this.checkpoints.read(repositoryId, legacyRepository);
    const github = run.github;
    if (github) {
      for (const headSha of new Set([
        github.headSha,
        ...(github.pendingCancellationHeadShas ?? []),
      ])) {
        for (const checkName of MASWE_CHECK_NAMES) {
          await this.sideEffects.get(
            checkRunIdempotencyKey(repositoryId, pullRequestNumber, headSha, checkName, 1),
          );
        }
      }
    }
  }

  private async withPullRequestFences<T>(
    repositoryId: number,
    pullRequestNumber: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    const key = `${repositoryId}#${pullRequestNumber}`;
    return withGitHubJournal(
      this.githubRoot,
      "publication",
      key,
      () =>
        withGitHubJournal(this.githubRoot, "association-identity", key, callback, {
          timeoutMs: 60_000,
        }),
      { timeoutMs: 60_000 },
    );
  }

  private async withRunTargetFence<T>(runId: string, callback: () => Promise<T>): Promise<T> {
    const location = await this.store.load(runId);
    return withRunMutationFence(location.repositoryPath, runId, "target", async () => {
      const authoritative = await this.store.load(runId);
      if (authoritative.repositoryPath !== location.repositoryPath) {
        throw new RepositoryIdentityMigrationError(
          "run-index-conflict",
          `Run ${runId} repository path changed before target mutation`,
        );
      }
      return callback();
    });
  }
}
