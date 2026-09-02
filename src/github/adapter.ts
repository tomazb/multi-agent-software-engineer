import type { GitHubAppConfig, MasweConfig, RunRecord } from "../domain.ts";
import { invalidateStaleEvidence } from "../git-workspace.ts";
import {
  requiresSameTargetEvidenceRecovery,
  RevalidationService,
} from "../revalidation.ts";
import { withRunMutationFence } from "../run-mutation.ts";
import type { RunStore } from "../store.ts";
import {
  GitHubAssociationIndex,
  type GitHubAssociationTransaction,
} from "./association.ts";
import { saveGitHubAssociationMutation } from "./association-mutation.ts";
import {
  githubStateRoot,
  isRepositoryIdAllowed,
  isStableRepositoryId,
  parseOwnerRepo,
  pendingCancellationHeads,
  remoteMatchesRepository,
  requireStableGitHubAssociation,
} from "./adapter-identities.ts";
export { remoteMatchesRepository } from "./adapter-identities.ts";
import { CheckPublisher, type GitHubHttpClient } from "./checks.ts";
import { readGitHubPullRequestSnapshot } from "./pull-request.ts";
import { lookupCanonicalGitHubRepository } from "./repository-identity.ts";
import type {
  GitHubInstallationTokenPurpose,
  GitHubRepositoryTokenProvider,
} from "./token.ts";
import { GitHubDeliveryInbox } from "./delivery-inbox.ts";
import {
  type GitHubDispatchResult,
  type GitHubPermanentRejectContext,
  type GitHubPermanentRepositoryRejectReason,
  GitHubPermanentRepositoryDropDiagnostic,
  nextPermanentRepositoryDropCount,
  settleGitHubDispatchResult,
} from "./dispatch-disposition.ts";
import { GitHubSideEffectStore } from "./side-effect-store.ts";
import {
  initializeGitHubJournals,
  initializeLegacyCheckCreateJournals,
  withGitHubJournal,
} from "./journal.ts";
import type { AssociationRecord, GitHubInternalEvent } from "./types.ts";
import {
  prepareWebhookRequest,
  type WebhookHandleResult,
  type WebhookRequest,
} from "./webhook-request.ts";
export type { WebhookHandleResult, WebhookRequest } from "./webhook-request.ts";
import { GitHubWebhookDiagnosticError } from "./webhook-diagnostic.ts";
import { GitHubWebhookWorker } from "./webhook-worker.ts";
export {
  GitHubWebhookDiagnosticError,
  type GitHubWebhookDiagnosticCode,
} from "./webhook-diagnostic.ts";

type AssociationRoutingIdentity = Pick<
  AssociationRecord,
  "runId" | "installationId" | "repository" | "pullRequestNumber" | "headSha"
> & { repositoryId: number };

/** A stable association record whose `repositoryId` is proven present. */
type StableAssociationRecord = AssociationRecord & { repositoryId: number };

function requireStableAssociationRecord(record: AssociationRecord): StableAssociationRecord {
  if (!isStableRepositoryId(record.repositoryId)) {
    throw new Error(
      `GitHub association ${record.repository}#${record.pullRequestNumber} is missing its stable repository id; explicit migration is required`,
    );
  }
  return record as StableAssociationRecord;
}

/** Outcome of the live canonical-name reconciliation described in design doc §10. */
type CanonicalReconciliation =
  | { kind: "reconciled"; repository: string }
  | { kind: "absent" };

export class GitHubAppAdapter {
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly store: RunStore;
  private readonly http: GitHubHttpClient;
  /**
   * Transitional compile seam only (design doc §4, §9.1 cutover step 6).
   *
   * No stable operational path in this adapter reads it: every repository
   * credential is minted through {@link repositoryTokenProvider}, scoped by
   * stable repository ID. Kept so untouched callers still typecheck until
   * Issue #34 Task 11 deletes it.
   */
  private readonly tokenProvider:
    ((installationId: number, repository: string) => Promise<string>) | undefined;
  /** The only credential source for stable repository operations; no name fallback exists. */
  private readonly repositoryTokenProvider: GitHubRepositoryTokenProvider | undefined;
  private readonly inbox: GitHubDeliveryInbox;
  private readonly sideEffects: GitHubSideEffectStore;
  private readonly associations: GitHubAssociationIndex;
  private readonly root: string;
  private readonly afterManualRunLoaded: ((runId: string) => Promise<void>) | undefined;
  private readonly beforeAssociationTransaction: ((deliveryId: string) => Promise<void>) | undefined;
  private readonly afterAssociationCommitBeforeRouting:
    ((runId: string) => Promise<void>) | undefined;
  private readonly afterAssociationValidatedBeforeRouting:
    ((runId: string) => Promise<void>) | undefined;
  private readonly afterAssociationRoutedBeforeChecks:
    ((runId: string) => Promise<void>) | undefined;
  private journalInitialization: Promise<void> | undefined;
  private inboxInitialization: Promise<void> | undefined;
  private readonly webhookWorker: GitHubWebhookWorker;
  private readonly synchronousWebhookDispatch: boolean;
  private readonly beforeInboxEnqueue: (() => Promise<void>) | undefined;
  private readonly onWebhookDiagnostic: ((error: unknown) => void) | undefined;
  /**
   * Process-local `permanentRepositoryDropsSinceStart` (design doc §16).
   *
   * Saturating positive safe integer, reset by process restart, never
   * persisted and never exposed through `doctor`: its only defined reader is
   * the listener diagnostic callback. Observability only -- it never changes
   * dispatch, retry, authorization, or migration behavior.
   */
  private permanentRepositoryDropsSinceStart = 0;

  constructor(options: {
    cwd: string;
    config: MasweConfig;
    store: RunStore;
    http: GitHubHttpClient;
    /**
     * Transitional name-scoped token seam. Accepted so untouched callers keep
     * compiling; never consulted by a stable operational path. Task 11 removes it.
     */
    tokenProvider?: (installationId: number, repository: string) => Promise<string>;
    /** Stable operational credential source: `(installationId, repositoryId, purpose)`. */
    repositoryTokenProvider?: GitHubRepositoryTokenProvider;
    /** Test/embedded seam; the CLI starts recovery explicitly before listening. */
    autoStartWebhookWorker?: boolean;
    /** Deterministic legacy-dispatch seam used only by focused adapter tests. */
    synchronousWebhookDispatch?: boolean;
    /** Deterministic seam for durable handoff write/journal failures. */
    beforeInboxEnqueue?: () => Promise<void>;
    inboxOptions?: ConstructorParameters<typeof GitHubDeliveryInbox>[1];
    onWebhookDiagnostic?: (error: unknown) => void;
    /** Deterministic seam exposing due-aware worker sleeps. */
    onWebhookWorkerSchedule?: (delayMs: number) => void;
    /** Deterministic barrier after the manual command's initial snapshot, before its fence. */
    afterManualRunLoaded?: (runId: string) => Promise<void>;
    /** Deterministic barrier before a PR association transaction is acquired. */
    beforeAssociationTransaction?: (deliveryId: string) => Promise<void>;
    /** Deterministic crash seam after association commit and before workflow routing. */
    afterAssociationCommitBeforeRouting?: (runId: string) => Promise<void>;
    /** Deterministic concurrency seam after the advisory validation, before identity fencing. */
    afterAssociationValidatedBeforeRouting?: (runId: string) => Promise<void>;
    /** Deterministic concurrency seam while identity-fenced after routing, before checks. */
    afterAssociationRoutedBeforeChecks?: (runId: string) => Promise<void>;
    /** Deterministic test seam for association index commit failures. */
    associationWriteRecords?: (filePath: string, content: string) => Promise<void>;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.http = options.http;
    this.tokenProvider = options.tokenProvider;
    this.repositoryTokenProvider = options.repositoryTokenProvider;
    this.afterManualRunLoaded = options.afterManualRunLoaded;
    this.beforeAssociationTransaction = options.beforeAssociationTransaction;
    this.afterAssociationCommitBeforeRouting = options.afterAssociationCommitBeforeRouting;
    this.afterAssociationValidatedBeforeRouting =
      options.afterAssociationValidatedBeforeRouting;
    this.afterAssociationRoutedBeforeChecks = options.afterAssociationRoutedBeforeChecks;
    const root = githubStateRoot(options.cwd);
    this.root = root;
    this.inbox = new GitHubDeliveryInbox(root, options.inboxOptions);
    this.synchronousWebhookDispatch = options.synchronousWebhookDispatch ?? false;
    this.beforeInboxEnqueue = options.beforeInboxEnqueue;
    this.onWebhookDiagnostic = options.onWebhookDiagnostic;
    this.sideEffects = new GitHubSideEffectStore(root);
    this.associations = new GitHubAssociationIndex(
      root,
      options.associationWriteRecords
        ? { writeRecords: options.associationWriteRecords }
        : {},
    );
    this.webhookWorker = new GitHubWebhookWorker({
      inbox: this.inbox,
      enabled: options.autoStartWebhookWorker ?? false,
      dispatch: (event) => this.dispatch(event, this.githubApp()),
      onDiagnostic: (error) => this.emitWebhookDiagnostic(error),
      onPermanentRejectCompleted: (context) => this.recordPermanentRepositoryDrop(context),
      ...(options.onWebhookWorkerSchedule
        ? { onSchedule: options.onWebhookWorkerSchedule }
        : {}),
    });
  }

  /** Fail-closed journal preflight shared by webhook and manual publication. */
  private async initializePublicationJournals(): Promise<void> {
    this.journalInitialization ??= (async () => {
      await initializeGitHubJournals(this.root);
      await initializeLegacyCheckCreateJournals(this.root);
      await withGitHubJournal(this.root, "check-create", "preflight", async () => undefined);
      await withGitHubJournal(this.root, "publication", "preflight", async () => undefined);
    })();
    try {
      await this.journalInitialization;
    } catch (error) {
      this.journalInitialization = undefined;
      throw error;
    }
  }

  /**
   * Recover durable ingress only for the listener topology. A simultaneous manual publisher
   * preflights its own journals without reclaiming the listener's active delivery lease.
   */
  async initialize(): Promise<void> {
    void this.webhookSecret();
    this.inboxInitialization ??= (async () => {
      await this.initializePublicationJournals();
      await this.inbox.initialize();
    })();
    try {
      await this.inboxInitialization;
    } catch (error) {
      this.inboxInitialization = undefined;
      throw error;
    }
  }

  /** Fail-closed preflight for the manual check publisher's local journals. */
  async initializeManualPublisher(): Promise<void> {
    await this.initializePublicationJournals();
  }

  private githubApp(): GitHubAppConfig {
    const app = this.config.githubApp;
    if (!app?.enabled) {
      throw new Error("githubApp is not enabled in configuration");
    }
    return app;
  }

  private webhookSecret(): string {
    const envName = this.githubApp().webhookSecretEnv;
    const secret = process.env[envName];
    if (!secret) throw new Error("GitHub App webhook secret is missing");
    return secret;
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookHandleResult> {
    this.githubApp();
    const prepared = prepareWebhookRequest(request, this.webhookSecret());
    if (prepared.kind === "reject") return prepared.result;
    if (prepared.kind === "unsupported") {
      let ignored;
      try {
        await this.initialize();
        await this.beforeInboxEnqueue?.();
        ignored = await this.inbox.completeWithoutDispatch({
          deliveryId: prepared.deliveryId,
          eventName: prepared.eventName,
          receivedAt: prepared.receivedAt,
          rawBodyDigest: prepared.rawBodyDigest,
        });
      } catch (handoffError) {
        this.emitWebhookDiagnostic(new GitHubWebhookDiagnosticError(
          "GITHUB_WEBHOOK_HANDOFF_FAILED",
          {
            deliveryId: prepared.deliveryId,
            eventName: prepared.eventName,
            attempt: 0,
          },
          handoffError,
        ));
        return {
          status: 503,
          body: { ok: false, message: "durable webhook handoff unavailable" },
        };
      }
      if (ignored.outcome === "conflict") {
        return { status: 409, body: { ok: false, message: "delivery id conflict" } };
      }
      return { status: 200, body: { ok: true, message: "unsupported webhook ignored" } };
    }
    let enqueue;
    try {
      await this.initialize();
      await this.beforeInboxEnqueue?.();
      enqueue = await this.inbox.enqueue({
        deliveryId: prepared.deliveryId,
        eventName: prepared.eventName,
        receivedAt: prepared.event.receivedAt,
        rawBodyDigest: prepared.rawBodyDigest,
        event: prepared.event,
      });
    } catch (handoffError) {
      this.emitWebhookDiagnostic(new GitHubWebhookDiagnosticError(
        "GITHUB_WEBHOOK_HANDOFF_FAILED",
        {
          deliveryId: prepared.deliveryId,
          eventName: prepared.eventName,
          attempt: 0,
        },
        handoffError,
      ));
      return {
        status: 503,
        body: { ok: false, message: "durable webhook handoff unavailable" },
      };
    }
    if (enqueue.outcome === "conflict") {
      return { status: 409, body: { ok: false, message: "delivery id conflict" } };
    }
    if (enqueue.status === "completed" || enqueue.status === "legacy-completed") {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    if (this.synchronousWebhookDispatch) {
      const claimed = await this.inbox.claimNext();
      if (!claimed) {
        return { status: 202, body: { ok: true, duplicate: true } };
      }
      try {
        const result = await this.dispatch(claimed.record.event, this.githubApp());
        // Same classification and same post-completion ordering as the
        // background worker (design doc §16).
        await settleGitHubDispatchResult({
          result,
          complete: () =>
            this.inbox.complete(claimed.record.deliveryId, claimed.record.leaseId),
          onPermanentRejectCompleted: (reason) => this.recordPermanentRepositoryDrop({
            deliveryId: claimed.record.deliveryId,
            eventName: claimed.record.eventName ?? prepared.eventName,
            attempt: claimed.record.attempt,
            reason,
          }),
        });
        return { status: 200, body: { ok: true } };
      } catch (error) {
        await this.inbox.retry(claimed.record.deliveryId, claimed.record.leaseId);
        throw error;
      }
    }
    this.webhookWorker.wake();
    return {
      status: 202,
      body: {
        ok: true,
        ...(enqueue.outcome === "duplicate" ? { duplicate: true } : {}),
      },
    };
  }

  async startWebhookWorker(): Promise<void> {
    await this.initialize();
    this.webhookWorker.start();
  }

  /**
   * Counts one permanently consumed repository-scoped delivery and emits its
   * bounded diagnostic. Only ever reached after `inbox.complete()` succeeded,
   * so a failed completion is never counted and its later successful
   * completion counts exactly once.
   */
  private recordPermanentRepositoryDrop(context: GitHubPermanentRejectContext): void {
    this.permanentRepositoryDropsSinceStart = nextPermanentRepositoryDropCount(
      this.permanentRepositoryDropsSinceStart,
    );
    this.emitWebhookDiagnostic(new GitHubPermanentRepositoryDropDiagnostic({
      ...context,
      count: this.permanentRepositoryDropsSinceStart,
    }));
  }

  private emitWebhookDiagnostic(error: unknown): void {
    try {
      this.onWebhookDiagnostic?.(error);
    } catch {
      // Diagnostics never alter durable queue state.
    }
  }

  async waitForWebhookIdle(timeoutMs = 10_000): Promise<void> {
    return this.webhookWorker.waitForIdle(timeoutMs);
  }

  async stopWebhookWorker(options: { drainMs?: number } = {}): Promise<void> {
    return this.webhookWorker.stop(options);
  }

  /**
   * Manual publication after rename (design doc §17).
   *
   * Load run -> require a stable association -> require the stable ID live
   * allowlisted -> stable repository fence -> canonical-name reconciliation ->
   * PR/publication fence -> reload/re-prove -> ID-scoped PR read proving
   * `base.repo.id` -> stale-head invalidation -> publish.
   */
  async publishChecksForRun(runId: string): Promise<RunRecord> {
    await this.initializeManualPublisher();
    const app = this.githubApp();
    const initial = await this.store.load(runId);
    if (!initial.github) {
      throw new Error(`Run ${runId} has no github association`);
    }
    const stable = requireStableGitHubAssociation(initial.github);
    const { repositoryId, pullRequestNumber, installationId } = stable;
    if (!isRepositoryIdAllowed(app, repositoryId)) {
      throw new Error(`Repository id ${repositoryId} is not allowlisted`);
    }
    await this.afterManualRunLoaded?.(runId);
    // §9/§17: the repository-identity fence covers publication ENTRY -- the
    // canonical-name reconciliation -- and is released before the per-pull-request
    // publication fence, so unrelated pull requests in the same repository stay
    // independent while the acquisition order stays exact.
    const reconciliation = await this.withRepositoryIdentityFence(repositoryId, () =>
      this.reconcileCanonicalRepository(repositoryId, installationId));
    if (reconciliation.kind === "absent") {
      throw new Error(
        `Repository id ${repositoryId} is no longer accessible to installation ${installationId}`,
      );
    }
    const repository = reconciliation.repository;
    return this.withPublicationFence(repositoryId, pullRequestNumber, async () => {
      const beforeLiveHead = await this.store.load(runId);
      if (!beforeLiveHead.github) {
        throw new Error(`Run ${runId} has no github association`);
      }
      const reloaded = requireStableGitHubAssociation(beforeLiveHead.github);
      if (
        reloaded.repositoryId !== repositoryId ||
        reloaded.pullRequestNumber !== pullRequestNumber
      ) {
        throw new Error(`Run ${runId} github association changed during publication`);
      }
      if (reloaded.suspended) {
        throw new Error(`Run ${runId} github association is suspended`);
      }
      if (!isRepositoryIdAllowed(app, reloaded.repositoryId)) {
        throw new Error(`Repository id ${reloaded.repositoryId} is not allowlisted`);
      }
      const readToken = await this.repositoryToken(
        installationId,
        repositoryId,
        "pull-request-read",
      );
      const snapshot = await readGitHubPullRequestSnapshot({
        http: this.http,
        token: readToken,
        repository,
        pullRequestNumber,
      });
      if (snapshot.baseRepositoryId !== repositoryId) {
        throw new Error(
          `Pull request ${repository}#${pullRequestNumber} targets repository id ${snapshot.baseRepositoryId}, not ${repositoryId}`,
        );
      }
      if (snapshot.state !== "open") {
        throw new Error(`Pull request ${repository}#${pullRequestNumber} is not open`);
      }
      const liveHead = snapshot.headSha;
      const publication = await this.withAssociationIdentityFence(
        repositoryId,
        pullRequestNumber,
        () =>
          this.withRunTargetMutationFence(runId, () =>
            this.associations.withTransaction(async (transaction) => {
              const indexed = transaction.findStable(repositoryId, pullRequestNumber);
              if (
                indexed?.suspended === true &&
                indexed.suspensionReason === "authorization-revoked"
              ) {
                throw new Error(
                  `GitHub association ${indexed.repository}#${indexed.pullRequestNumber} is suspended because authorization was revoked`,
                );
              }
              const run = await this.store.load(runId);
              if (!run.github) {
                throw new Error(`Run ${runId} has no github association`);
              }
              const current = requireStableGitHubAssociation(run.github);
              if (
                current.repositoryId !== repositoryId ||
                current.pullRequestNumber !== pullRequestNumber
              ) {
                throw new Error(`Run ${runId} github association changed during publication`);
              }
              if (current.suspended) {
                throw new Error(`Run ${runId} github association is suspended`);
              }
              const previousHeadSha = run.github.headSha || run.workspace?.headSha;
              if (!previousHeadSha) {
                throw new Error(`Run ${runId} has no head SHA for checks`);
              }
              const pendingHeadShas = pendingCancellationHeads(
                run.github.pendingCancellationHeadShas,
                previousHeadSha,
                liveHead,
              );
              if (liveHead !== previousHeadSha) {
                const before = structuredClone(run);
                invalidateStaleEvidence(run, liveHead);
                run.github = {
                  ...run.github,
                  headSha: liveHead,
                  ...(pendingHeadShas.length > 0
                    ? { pendingCancellationHeadShas: pendingHeadShas }
                    : {}),
                };
                if (pendingHeadShas.length === 0) {
                  delete run.github.pendingCancellationHeadShas;
                }
                await this.saveAssociationMutation(before, run, transaction);
              }
              const committedAssociation = transaction.bindStable({
                runId: run.id,
                installationId: run.github.installationId,
                repositoryId,
                repository: run.github.repository,
                pullRequestNumber: run.github.pullRequestNumber,
                baseSha: run.github.baseSha,
                headSha: liveHead,
                branch: run.github.branch,
              });
              return {
                run,
                previousHeadSha,
                pendingHeadShas,
                committedAssociation: requireStableAssociationRecord(committedAssociation),
              };
            }),
          ),
      );
      return this.publishCommittedAssociation(
        publication.committedAssociation,
        publication.pendingHeadShas,
      );
    });
  }

  /**
   * Outermost stable fence (design doc §9). Keyed by the stable repository ID
   * only; a mutable name never keys an operational fence after #34. Helpers
   * that already run under this fence must not reacquire it.
   */
  private async withRepositoryIdentityFence<T>(
    repositoryId: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    return withGitHubJournal(
      this.root,
      "repository-identity",
      String(repositoryId),
      callback,
      { timeoutMs: 60_000 },
    );
  }

  private async withPublicationFence<T>(
    repositoryId: number,
    pullRequestNumber: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    return withGitHubJournal(
      this.root,
      "publication",
      `${repositoryId}#${pullRequestNumber}`,
      callback,
      { timeoutMs: 60_000 },
    );
  }

  private async withAssociationIdentityFence<T>(
    repositoryId: number,
    pullRequestNumber: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    return withGitHubJournal(
      this.root,
      "association-identity",
      `${repositoryId}#${pullRequestNumber}`,
      callback,
      { timeoutMs: 60_000 },
    );
  }

  /**
   * Mints an ID-scoped installation credential. There is deliberately no
   * fallback to the transitional name-scoped `tokenProvider`: a stable
   * operation without the ID provider fails closed here, before any GitHub
   * request, and the failure is thrown (retryable) rather than classified as
   * a permanent identity rejection -- a missing provider is a deployment
   * misconfiguration, never evidence about repository identity.
   */
  private async repositoryToken(
    installationId: number,
    repositoryId: number,
    purpose: GitHubInstallationTokenPurpose,
  ): Promise<string> {
    const provider = this.repositoryTokenProvider;
    if (!provider) {
      throw new Error(
        "GitHub stable repository operations require a repository-id-scoped token provider",
      );
    }
    return provider(installationId, repositoryId, purpose);
  }

  private async withRunTargetMutationFence<T>(
    runId: string,
    callback: (authoritative: RunRecord) => Promise<T>,
  ): Promise<T> {
    const location = await this.store.load(runId);
    return withRunMutationFence(
      location.repositoryPath,
      runId,
      "target",
      async () => {
        const authoritative = await this.store.load(runId);
        if (authoritative.repositoryPath !== location.repositoryPath) {
          throw new Error(`Run ${runId} repository path changed before target mutation`);
        }
        return callback(authoritative);
      },
    );
  }

  private async saveAssociationMutation(
    before: RunRecord,
    run: RunRecord,
    transaction: GitHubAssociationTransaction,
  ): Promise<void> {
    await saveGitHubAssociationMutation({
      store: this.store,
      transaction,
      before,
      candidate: run,
    });
  }

  private async routeAssociationHead(
    expected: AssociationRoutingIdentity,
  ): Promise<RunRecord> {
    const authoritative = await this.loadActiveCommittedAssociation(expected);
    const requestedHeadSha = expected.headSha;
    if (
      authoritative.revalidation === undefined &&
      authoritative.state !== "PR_READY" &&
      authoritative.state !== "PR_REVIEW" &&
      authoritative.state !== "BUILDING" &&
      authoritative.state !== "CI_RUNNING" &&
      authoritative.state !== "VERIFYING" &&
      authoritative.state !== "RESOLVING" &&
      authoritative.state !== "MERGE_READY"
    ) {
      return authoritative;
    }
    const routingPreviousHeadSha =
      authoritative.revalidation?.requestedHeadSha ?? authoritative.workspace?.headSha;
    if (!routingPreviousHeadSha) {
      throw new Error(
        `Associated run ${expected.runId} has no authoritative workflow target for GitHub head ${requestedHeadSha}`,
      );
    }
    if (
      authoritative.revalidation === undefined &&
      routingPreviousHeadSha === requestedHeadSha &&
      !requiresSameTargetEvidenceRecovery(authoritative, requestedHeadSha)
    ) {
      return authoritative;
    }
    await new RevalidationService(this.store).route(expected.runId, {
      source: "github",
      previousHeadSha: routingPreviousHeadSha,
      requestedHeadSha,
      expectedRunVersion: authoritative.version,
      actor: "github-app",
    });
    return this.loadActiveCommittedAssociation(expected);
  }

  private async publishCommittedAssociation(
    expected: AssociationRoutingIdentity,
    pendingHeadShas: readonly string[],
  ): Promise<RunRecord> {
    await this.afterAssociationCommitBeforeRouting?.(expected.runId);
    await this.loadActiveCommittedAssociation(expected);
    await this.afterAssociationValidatedBeforeRouting?.(expected.runId);
    return this.withAssociationIdentityFence(
      expected.repositoryId,
      expected.pullRequestNumber,
      async () => {
        const routed = await this.routeAssociationHead(expected);
        await this.afterAssociationRoutedBeforeChecks?.(expected.runId);
        await this.publishChecks(routed, expected, pendingHeadShas);
        return this.clearPublishedCancellationHeads(expected, pendingHeadShas);
      },
    );
  }

  private async loadActiveCommittedAssociation(
    expected: AssociationRoutingIdentity,
  ): Promise<RunRecord> {
    const authoritative = await this.store.load(expected.runId);
    const github = authoritative.github;
    if (
      !github ||
      github.suspended === true ||
      github.installationId !== expected.installationId ||
      github.repositoryId !== expected.repositoryId ||
      github.repository !== expected.repository ||
      github.pullRequestNumber !== expected.pullRequestNumber ||
      github.headSha !== expected.headSha
    ) {
      throw new Error(
        `Run ${expected.runId} GitHub association changed before routing`,
      );
    }
    const indexed = await this.associations.findStable(
      expected.repositoryId,
      expected.pullRequestNumber,
    );
    if (
      !indexed ||
      indexed.suspended ||
      indexed.runId !== expected.runId ||
      indexed.installationId !== expected.installationId ||
      indexed.repositoryId !== expected.repositoryId ||
      indexed.repository !== expected.repository ||
      indexed.pullRequestNumber !== expected.pullRequestNumber ||
      indexed.headSha !== expected.headSha
    ) {
      throw new Error(
        `Run ${expected.runId} GitHub association index changed before routing`,
      );
    }
    return authoritative;
  }

  private async clearPublishedCancellationHeads(
    expected: AssociationRoutingIdentity,
    cancelledHeadShas: readonly string[],
  ): Promise<RunRecord> {
    const runId = expected.runId;
    if (cancelledHeadShas.length === 0) return this.store.load(runId);
    const cancelled = new Set(cancelledHeadShas);
    return this.associations.withTransaction(async (transaction) => {
      const run = await this.store.load(runId);
      if (
        !run.github ||
        run.github.repositoryId !== expected.repositoryId ||
        run.github.pullRequestNumber !== expected.pullRequestNumber ||
        run.github.headSha !== expected.headSha
      ) {
        throw new Error(`Run ${runId} github association changed during publication`);
      }
      const currentPending = run.github.pendingCancellationHeadShas ?? [];
      const remaining = currentPending.filter((headSha) => !cancelled.has(headSha));
      if (remaining.length !== currentPending.length) {
        const before = structuredClone(run);
        run.github = {
          ...run.github,
          ...(remaining.length > 0 ? { pendingCancellationHeadShas: remaining } : {}),
        };
        if (remaining.length === 0) delete run.github.pendingCancellationHeadShas;
        await this.saveAssociationMutation(before, run, transaction);
      }
      transaction.bindStable({
        runId: run.id,
        installationId: run.github.installationId,
        repositoryId: expected.repositoryId,
        repository: run.github.repository,
        pullRequestNumber: run.github.pullRequestNumber,
        baseSha: run.github.baseSha,
        headSha: run.github.headSha,
        branch: run.github.branch,
        ...(run.github.suspended !== undefined ? { suspended: run.github.suspended } : {}),
      });
      return run;
    });
  }

  /**
   * Typed dispatch disposition (design doc §16). A permanent identity/policy
   * rejection is reported so the delivery is durably consumed with zero
   * authority-increasing mutation; every transient or ambiguous failure is
   * thrown instead and keeps the existing retry path.
   *
   * Operational authorization is stable-ID only (§3.2): a mutable `owner/repo`
   * name is routing/display/candidate metadata and never authorizes anything.
   */
  private async dispatch(
    event: GitHubInternalEvent,
    app: GitHubAppConfig,
  ): Promise<GitHubDispatchResult> {
    if (event.type === "installation.deleted") {
      // §3.2: installation deletion may reduce authority by persisted
      // `installationId` alone -- including for unresolved legacy associations
      // -- so it deliberately runs before the stable authorization gate and
      // never establishes repository identity.
      if (event.installationId !== undefined) {
        await this.suspendInstallationAssociations(event.installationId);
      }
      return { kind: "applied" };
    }

    if (event.type === "installation_repositories.removed") {
      if (event.installationId === undefined) return { kind: "applied" };
      await this.suspendRemovedRepositories(event, event.installationId);
      // An authority-reducing suspension is an allowed mutation, so the
      // delivery completes normally and is never a permanent drop.
      return { kind: "applied" };
    }

    if (event.type === "installation_repositories.added") {
      // §6.2: an add event -- historical name-only or new ID-bearing -- never
      // grants or restores authority here, so it is consumed with zero change.
      return { kind: "applied" };
    }

    if (event.observeOnly) {
      return { kind: "applied" };
    }

    if (event.type !== "push" && !event.type.startsWith("pull_request.")) {
      return { kind: "applied" };
    }

    // §3.2 operational authorization: a non-empty live `allowedRepositoryIds`
    // AND the exact target id in it. Checked in that order so a cutover-order
    // violation is reported as a configuration fault rather than as a
    // repository-specific policy decision.
    if (app.allowedRepositoryIds.length === 0) {
      return {
        kind: "permanent-reject",
        reason: "stable-repository-authorization-required",
      };
    }
    if (event.repositoryId === undefined) {
      // §6.1 historical ID-less durable event: identity is never upgraded from
      // a name, so this is permanently consumed rather than retried forever.
      return { kind: "permanent-reject", reason: "legacy-repository-identity-missing" };
    }
    if (!isRepositoryIdAllowed(app, event.repositoryId)) {
      // Retrying can never make the id allowlisted, so the delivery is
      // permanently consumed instead of becoming a poison redelivery.
      return { kind: "permanent-reject", reason: "repository-not-allowlisted" };
    }
    const installationId = event.installationId;
    if (installationId === undefined || installationId <= 0) {
      throw new Error(`${event.type} event missing installation id`);
    }
    const repositoryId = event.repositoryId;

    // §9: the repository-identity fence serializes repository-scoped
    // publication ENTRY -- canonical reconciliation and repository-wide
    // authority reduction -- and is released before the per-pull-request
    // fences, so an unrelated pull request in the same repository is never
    // stalled behind another pull request's publication. The acquisition order
    // repository-identity -> publication/association-identity -> run target
    // fence -> global association transaction is still exact and is never
    // inverted.
    const entry = await this.withRepositoryIdentityFence(repositoryId, async () => {
      const reconciliation = await this.reconcileCanonicalRepository(
        repositoryId,
        installationId,
      );
      if (reconciliation.kind === "absent") {
        return {
          kind: "settled" as const,
          result: await this.applyProvenRepositoryAbsence(repositoryId, installationId),
        };
      }
      return { kind: "route" as const, repository: reconciliation.repository };
    });
    if (entry.kind === "settled") return entry.result;
    const repository = entry.repository;

    if (
      event.type.startsWith("pull_request.") &&
      event.pullRequestNumber !== undefined &&
      event.headSha
    ) {
      return this.handlePullRequestEvent(event, {
        repositoryId,
        repository,
        installationId,
        pullRequestNumber: event.pullRequestNumber,
        headSha: event.headSha,
      });
    }
    if (event.type === "push" && event.branch && event.headSha) {
      return this.handlePushEvent(event, {
        repositoryId,
        repository,
        installationId,
        branch: event.branch,
        headSha: event.headSha,
      });
    }
    return { kind: "applied" };
  }

  /**
   * Live canonical-name reconciliation (design doc §10).
   *
   * Must be called with `repository-identity(repositoryId)` already held; it
   * never reacquires that journal. The caller has already proven the id is
   * live-allowlisted; this then mints an ID-scoped metadata token, performs the
   * bounded authenticated canonical lookup, and recoverably synchronizes every
   * stale run/index canonical name for that id. An ambiguous lookup failure
   * throws (retryable) and can never be read as absence.
   */
  private async reconcileCanonicalRepository(
    repositoryId: number,
    installationId: number,
  ): Promise<CanonicalReconciliation> {
    const token = await this.repositoryToken(
      installationId,
      repositoryId,
      "metadata-reconcile",
    );
    const lookup = await lookupCanonicalGitHubRepository({
      http: this.http,
      token,
      repositoryId,
    });
    if (lookup.kind === "not-found") return { kind: "absent" };
    const repository = lookup.repository;
    const stale = (await this.associations.findAllStableByRepositoryId(repositoryId)).filter(
      (record) => record.repository !== repository,
    );
    for (const record of stale) {
      await this.refreshCanonicalRepositoryName(
        requireStableAssociationRecord(record),
        repository,
      );
    }
    return { kind: "reconciled", repository };
  }

  /**
   * Recoverable run/index canonical-name synchronization for one stable
   * association. An old-name replay cannot roll a name backward here: the name
   * written is always the one the live authenticated lookup just returned for
   * this exact repository id.
   */
  private async refreshCanonicalRepositoryName(
    record: StableAssociationRecord,
    repository: string,
  ): Promise<void> {
    await this.withAssociationIdentityFence(
      record.repositoryId,
      record.pullRequestNumber,
      async () => {
        const apply = () =>
          this.associations.withTransaction(async (transaction) => {
            const current = transaction.findStable(
              record.repositoryId,
              record.pullRequestNumber,
            );
            if (!current || current.repository === repository) return;
            const run = await this.loadRunIfPresent(current.runId);
            if (
              run?.github &&
              run.github.repositoryId === current.repositoryId &&
              run.github.pullRequestNumber === current.pullRequestNumber &&
              run.github.repository !== repository
            ) {
              const before = structuredClone(run);
              run.github = { ...run.github, repository };
              await this.saveAssociationMutation(before, run, transaction);
            }
            transaction.refreshCanonicalRepository(
              record.repositoryId,
              current.pullRequestNumber,
              repository,
            );
          });
        // The run target fence is always acquired OUTSIDE the global
        // association transaction. A truly missing run reconciles only the
        // index; it never invents a run.
        if ((await this.loadRunIfPresent(record.runId)) === undefined) {
          await apply();
          return;
        }
        await this.withRunTargetMutationFence(record.runId, () => apply());
      },
    );
  }

  /**
   * Positive authorization-loss evidence (design doc §16). A fully and safely
   * traversed installation listing that reached its terminal page without the
   * target id is the only input to this method; ambiguous failures throw
   * upstream and never arrive here.
   *
   * Case A -- at least one stable association exists for the id under this
   * installation: reduce each to `authorization-revoked` and report `applied`,
   * so the permanent-drop counter does not move. Case B -- nothing can be
   * authority-reduced: permanently consume as `repository-access-revoked`.
   *
   * Runs under the already-held `repository-identity` fence.
   */
  private async applyProvenRepositoryAbsence(
    repositoryId: number,
    installationId: number,
  ): Promise<GitHubDispatchResult> {
    const affected = (await this.associations.findAllStableByRepositoryId(repositoryId)).filter(
      (record) => record.installationId === installationId,
    );
    if (affected.length === 0) {
      return { kind: "permanent-reject", reason: "repository-access-revoked" };
    }
    const failures: unknown[] = [];
    for (const record of affected) {
      try {
        await this.suspendStableAssociationUnderIdentity(
          requireStableAssociationRecord(record),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Authorization suspension failed for ${failures.length} association(s)`,
      );
    }
    return { kind: "applied" };
  }

  /**
   * `installation.deleted` mixed fan-out.
   *
   * Every affected record is classified FIRST -- stable (`repositoryId`
   * present) versus unresolved legacy -- and only then chooses its lock path.
   * A failure on one record never skips a later record; all attempts are
   * aggregated afterwards.
   */
  private async suspendInstallationAssociations(installationId: number): Promise<void> {
    const associations = await this.associations.findAllByInstallation(installationId);
    const classified = associations.map((record) => ({
      record,
      stable: record.repositoryId !== undefined,
    }));
    const failures: unknown[] = [];
    for (const { record, stable } of classified) {
      try {
        if (stable) {
          await this.suspendStableAssociation(requireStableAssociationRecord(record));
        } else {
          await this.suspendLegacyAssociation(record, {
            installationId: record.installationId,
            repository: record.repository,
          });
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Authorization suspension failed for ${failures.length} association(s)`,
      );
    }
  }

  /**
   * `installation_repositories.removed` fan-out.
   *
   * A new ID-bearing event selects stable records BY stable id. A historical
   * ID-less event selects ONLY unresolved legacy records by exact installation
   * plus exact legacy name match (design doc §6.2): it can neither assign an
   * id, refresh a canonical name, nor touch a stable-ID association by name.
   */
  private async suspendRemovedRepositories(
    event: GitHubInternalEvent,
    installationId: number,
  ): Promise<void> {
    const failures: unknown[] = [];
    const identities = event.repositories ?? [];
    if (identities.length > 0) {
      for (const identity of identities) {
        try {
          const records = (
            await this.associations.findAllStableByRepositoryId(identity.repositoryId)
          ).filter((record) => record.installationId === installationId);
          for (const record of records) {
            try {
              await this.suspendStableAssociation(requireStableAssociationRecord(record));
            } catch (error) {
              failures.push(error);
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
    } else {
      const legacyNames =
        event.legacyRepositories && event.legacyRepositories.length > 0
          ? event.legacyRepositories
          : event.repository
            ? [event.repository]
            : [];
      for (const repository of legacyNames) {
        try {
          const records = (
            await this.associations.findAllLegacyByRepository(repository)
          ).filter((record) => record.installationId === installationId);
          for (const record of records) {
            try {
              await this.suspendLegacyAssociation(record, { installationId, repository });
            } catch (error) {
              failures.push(error);
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Authorization suspension failed for ${failures.length} repository association operation(s)`,
      );
    }
  }

  /** Full stable chain: repository-identity -> PR identity -> run fence -> transaction. */
  private async suspendStableAssociation(record: StableAssociationRecord): Promise<void> {
    await this.withRepositoryIdentityFence(record.repositoryId, () =>
      this.suspendStableAssociationUnderIdentity(record));
  }

  /**
   * The stable chain below an already-held `repository-identity` fence, so a
   * caller that already owns the repository id never reacquires that journal.
   */
  private async suspendStableAssociationUnderIdentity(
    record: StableAssociationRecord,
  ): Promise<void> {
    await this.withAssociationIdentityFence(
      record.repositoryId,
      record.pullRequestNumber,
      async () => {
        const apply = () =>
          this.associations.withTransaction(async (transaction) => {
            const current = transaction.findStable(
              record.repositoryId,
              record.pullRequestNumber,
            );
            if (!current || current.installationId !== record.installationId) return;
            const run = await this.loadRunIfPresent(current.runId);
            if (run) await this.suspendAssociatedRun(run, current, transaction);
            transaction.suspendStable(
              record.repositoryId,
              record.pullRequestNumber,
              "authorization-revoked",
            );
          });
        if ((await this.loadRunIfPresent(record.runId)) === undefined) {
          // An index record pointing at a truly missing run reconciles only the
          // authority-reducing index suspension, under the global association
          // transaction. No run and no repository id is ever invented.
          await apply();
          return;
        }
        await this.withRunTargetMutationFence(record.runId, () => apply());
      },
    );
  }

  /**
   * Legacy ID-less authority reduction (design doc §6.2, §9).
   *
   * Acquires ONLY the common suffix `run target fence(runId) -> global
   * association transaction`. It never acquires a name-keyed
   * publication/association-identity fence and never invents or acquires a
   * repository-ID fence. The initial name/installation match is advisory
   * candidate selection; the exact unresolved tuple -- no `repositoryId`, same
   * run, same installation, same normalized name -- is re-proved once both
   * governing locks are held.
   */
  private async suspendLegacyAssociation(
    record: AssociationRecord,
    expected: { installationId: number; repository: string },
  ): Promise<void> {
    const apply = () =>
      this.associations.withTransaction(async (transaction) => {
        const current = transaction.findLegacy(record.repository, record.pullRequestNumber);
        if (
          !current ||
          current.repositoryId !== undefined ||
          current.runId !== record.runId ||
          current.installationId !== expected.installationId ||
          current.repository !== expected.repository
        ) {
          return;
        }
        const run = await this.loadRunIfPresent(current.runId);
        if (run) await this.suspendAssociatedRun(run, current, transaction);
        transaction.suspendLegacy(
          current.repository,
          current.pullRequestNumber,
          "authorization-revoked",
        );
      });
    if ((await this.loadRunIfPresent(record.runId)) === undefined) {
      await apply();
      return;
    }
    await this.withRunTargetMutationFence(record.runId, () => apply());
  }

  /**
   * Applies `authorization-revoked` to the run half of one association from
   * inside its association transaction, so a crash can never leave a split
   * run/index suspension state that a later redelivery cannot reconcile.
   */
  private async suspendAssociatedRun(
    run: RunRecord,
    association: AssociationRecord,
    transaction: GitHubAssociationTransaction,
  ): Promise<void> {
    const github = run.github;
    if (!github) return;
    if (
      github.installationId !== association.installationId ||
      github.pullRequestNumber !== association.pullRequestNumber
    ) {
      return;
    }
    if (association.repositoryId === undefined) {
      // Legacy half: the run must itself still be unresolved and carry the
      // exact same mutable name. A name never resolves a stable record here.
      if (github.repositoryId !== undefined || github.repository !== association.repository) {
        return;
      }
    } else if (github.repositoryId !== association.repositoryId) {
      return;
    }
    if (github.suspended && github.suspensionReason === "authorization-revoked") return;
    const before = structuredClone(run);
    run.github = {
      ...github,
      suspended: true,
      suspensionReason: "authorization-revoked",
    };
    await this.saveAssociationMutation(before, run, transaction);
  }

  private async loadRunIfPresent(runId: string): Promise<RunRecord | undefined> {
    try {
      return await this.store.load(runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // A non-ENOENT run load failure is ambiguous and must propagate.
      throw error;
    }
  }

  /**
   * Push fan-out. Targets are selected by stable id and branch, never by the
   * mutable repository name. Runs after the `repository-identity` entry fence
   * has been released, with the reconciled canonical name; it must not assume
   * repository-wide serialization.
   */
  private async handlePushEvent(
    event: GitHubInternalEvent,
    context: {
      repositoryId: number;
      repository: string;
      installationId: number;
      branch: string;
      headSha: string;
    },
  ): Promise<GitHubDispatchResult> {
    const associations = await this.associations.findAllStableByRepositoryBranch(
      context.repositoryId,
      context.branch,
    );
    const failures: unknown[] = [];
    let applied = 0;
    let permanent: GitHubDispatchResult | undefined;
    for (const association of associations) {
      if (association.suspended) continue;
      const synthetic: GitHubInternalEvent = {
        ...event,
        type: "pull_request.synchronize",
        pullRequestNumber: association.pullRequestNumber,
        headSha: context.headSha,
        branch: context.branch,
        repository: context.repository,
        repositoryId: context.repositoryId,
        installationId: association.installationId,
      };
      try {
        const result = await this.handlePullRequestEvent(synthetic, {
          repositoryId: context.repositoryId,
          repository: context.repository,
          installationId: association.installationId,
          pullRequestNumber: association.pullRequestNumber,
          headSha: context.headSha,
        });
        if (result.kind === "permanent-reject") permanent ??= result;
        else applied += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Push invalidation failed for ${failures.length} pull request association(s)`,
      );
    }
    // A per-PR permanent identity rejection consumes the delivery only when no
    // fan-out target applied; otherwise real work happened for this delivery.
    if (applied === 0 && permanent) return permanent;
    return { kind: "applied" };
  }

  /**
   * Stable pull request handling. Runs after the `repository-identity` entry
   * fence has been released, with the reconciled canonical name; it must not
   * assume repository-wide serialization. Acquires
   * `publication(repositoryId#pr)` -> `association-identity(repositoryId#pr)`
   * -> run target fence -> global association transaction, in exactly that
   * order.
   */
  private async handlePullRequestEvent(
    event: GitHubInternalEvent,
    context: {
      repositoryId: number;
      repository: string;
      installationId: number;
      pullRequestNumber: number;
      headSha: string;
    },
  ): Promise<GitHubDispatchResult> {
    const { repositoryId, repository, installationId, pullRequestNumber, headSha } = context;
    // §8: unresolved legacy index state is rejected BEFORE any stable
    // repository/PR publication fence is acquired, and is never upgraded here.
    if (
      (await this.associations.findStable(repositoryId, pullRequestNumber)) === undefined &&
      (await this.associations.findLegacy(repository, pullRequestNumber)) !== undefined
    ) {
      return { kind: "permanent-reject", reason: "legacy-repository-identity-missing" };
    }
    return this.withPublicationFence(repositoryId, pullRequestNumber, async () => {
      const readToken = await this.repositoryToken(
        installationId,
        repositoryId,
        "pull-request-read",
      );
      const snapshot = await readGitHubPullRequestSnapshot({
        http: this.http,
        token: readToken,
        repository,
        pullRequestNumber,
      });
      if (snapshot.baseRepositoryId !== repositoryId) {
        // §11: ownership is proven by `base.repo.id` only. A fork's head
        // repository is irrelevant; a different base repository is a permanent
        // identity conflict with zero authority increase.
        return { kind: "permanent-reject", reason: "repository-identity-conflict" } as const;
      }
      if (snapshot.headSha !== headSha) {
        // Stale or out-of-order delivery: current PR head has already moved on.
        return { kind: "applied" } as const;
      }
      const expectsClosed = event.type === "pull_request.closed";
      if (
        (expectsClosed && snapshot.state !== "closed") ||
        (!expectsClosed && snapshot.state !== "open")
      ) {
        // Same-SHA out-of-order lifecycle deliveries cannot invert the live PR state.
        return { kind: "applied" } as const;
      }

      await this.beforeAssociationTransaction?.(event.eventId);
      const publication = await this.withAssociationIdentityFence(
        repositoryId,
        pullRequestNumber,
        async () => {
          const identityAssociation = await this.associations.findStable(
            repositoryId,
            pullRequestNumber,
          );
          const closureRecoverable =
            event.type === "pull_request.closed" || event.type === "pull_request.reopened";
          let identityRun: RunRecord | undefined;
          if (identityAssociation) {
            identityRun = await this.store.load(identityAssociation.runId);
          } else {
            const candidate = await this.findMatchingRun(
              repositoryId,
              repository,
              pullRequestNumber,
              event.branch,
              { allowPullRequestClosedSuspension: closureRecoverable },
            );
            if (candidate.kind === "conflict") {
              return { kind: "conflict", reason: candidate.reason } as const;
            }
            identityRun = candidate.run;
          }
          const transact = (targetRun: RunRecord | undefined) =>
            this.associations.withTransaction(async (transaction) => {
              const association = transaction.findStable(repositoryId, pullRequestNumber);
              if (association?.runId !== identityAssociation?.runId) {
                throw new Error(
                  `GitHub association ${repositoryId}#${pullRequestNumber} changed before target mutation`,
                );
              }
              const reopeningClosure =
                event.type === "pull_request.reopened" &&
                association?.suspended === true &&
                association.suspensionReason === "pull-request-closed";
              if (association?.suspended && !reopeningClosure) {
                return { kind: "ignore" } as const;
              }

              if (event.type === "pull_request.closed") {
                if (targetRun?.github) {
                  const before = structuredClone(targetRun);
                  targetRun.github = {
                    ...targetRun.github,
                    suspended: true,
                    suspensionReason: "pull-request-closed",
                  };
                  await this.saveAssociationMutation(before, targetRun, transaction);
                }
                if (association) {
                  transaction.suspendStable(
                    repositoryId,
                    pullRequestNumber,
                    "pull-request-closed",
                  );
                } else if (targetRun?.github) {
                  transaction.bindStable({
                    runId: targetRun.id,
                    installationId,
                    repositoryId,
                    repository,
                    pullRequestNumber,
                    baseSha: targetRun.github.baseSha,
                    headSha,
                    branch: targetRun.github.branch,
                    suspended: true,
                    suspensionReason: "pull-request-closed",
                  });
                }
                return { kind: "ignore" } as const;
              }

              if (!targetRun) return { kind: "unassociated" } as const;
              const reopeningRunClosure =
                event.type === "pull_request.reopened" &&
                targetRun.github?.suspended === true &&
                targetRun.github.suspensionReason === "pull-request-closed";
              if (
                targetRun.github?.suspended &&
                !(reopeningClosure || reopeningRunClosure)
              ) {
                return { kind: "ignore" } as const;
              }
              const before = structuredClone(targetRun);
              const previousHeadSha = targetRun.github?.headSha ?? association?.headSha;
              const pendingHeadShas = pendingCancellationHeads(
                targetRun.github?.pendingCancellationHeadShas,
                previousHeadSha,
                headSha,
              );
              invalidateStaleEvidence(targetRun, headSha);
              targetRun.github = {
                installationId,
                repositoryId,
                repository,
                pullRequestNumber,
                baseSha:
                  event.baseSha ??
                  targetRun.github?.baseSha ??
                  targetRun.workspace?.baseSha ??
                  headSha,
                headSha,
                branch:
                  event.branch ??
                  targetRun.github?.branch ??
                  targetRun.workspace?.branch ??
                  "unknown",
                suspended: false,
                ...(pendingHeadShas.length > 0
                  ? { pendingCancellationHeadShas: pendingHeadShas }
                  : {}),
              };
              await this.saveAssociationMutation(before, targetRun, transaction);
              const committedAssociation = transaction.bindStable({
                runId: targetRun.id,
                installationId,
                repositoryId,
                repository,
                pullRequestNumber,
                baseSha: targetRun.github.baseSha,
                headSha,
                branch: targetRun.github.branch,
              });
              return {
                kind: "publish",
                run: targetRun,
                previousHeadSha,
                pendingHeadShas,
                committedAssociation: requireStableAssociationRecord(committedAssociation),
              } as const;
            });
          if (!identityRun) return transact(undefined);
          return this.withRunTargetMutationFence(identityRun.id, async (authoritative) => {
            if (identityAssociation) return transact(authoritative);
            const currentMatch = await this.findMatchingRun(
              repositoryId,
              repository,
              pullRequestNumber,
              event.branch,
              { allowPullRequestClosedSuspension: closureRecoverable },
            );
            if (currentMatch.kind === "conflict") {
              return { kind: "conflict", reason: currentMatch.reason } as const;
            }
            if (currentMatch.run?.id !== authoritative.id) {
              return transact(undefined);
            }
            return transact(currentMatch.run);
          });
        },
      );

      if (publication.kind === "conflict") {
        return { kind: "permanent-reject", reason: publication.reason } as const;
      }
      if (publication.kind === "publish") {
        await this.publishCommittedAssociation(
          publication.committedAssociation,
          publication.pendingHeadShas,
        );
        return { kind: "applied" } as const;
      }
      if (publication.kind === "ignore") return { kind: "applied" } as const;

      const synthetic: RunRecord = {
        schemaVersion: 1,
        version: 1,
        id: "unassociated",
        title: "unassociated",
        request: "",
        repositoryPath: this.cwd,
        state: "PR_REVIEW",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        approvals: { brainstorm: false, design: false },
        counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
        config: this.config,
        artifacts: [],
        events: [],
        github: {
          installationId,
          repositoryId,
          repository,
          pullRequestNumber,
          baseSha: event.baseSha ?? headSha,
          headSha,
          branch: event.branch ?? "unknown",
          suspended: false,
        },
      };
      await this.publishChecks(synthetic, {
        repositoryId,
        repository,
        pullRequestNumber,
        headSha,
        installationId,
      });
      return { kind: "applied" } as const;
    });
  }

  /**
   * Candidate selection for a not-yet-associated stable pull request.
   *
   * Stable identity decides: an exact `(repositoryId, pullRequestNumber)` claim
   * on a run wins. A run holding a claim on the same mutable name with a
   * different -- or absent -- stable id is never stolen and never upgraded; it
   * is reported as the corresponding permanent identity rejection. Only after
   * those guards may the current remote plus branch act as a candidate
   * selector, matched against the freshly reconciled canonical name, so a stale
   * pre-rename remote can never first-associate automatically.
   */
  private async findMatchingRun(
    repositoryId: number,
    repository: string,
    pullRequestNumber: number,
    branch: string | undefined,
    options: { allowPullRequestClosedSuspension?: boolean } = {},
  ): Promise<
    | { kind: "match"; run: RunRecord | undefined }
    | { kind: "conflict"; reason: GitHubPermanentRepositoryRejectReason }
  > {
    const runs = await this.store.list();
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
    const selectable = (run: RunRecord): boolean => {
      if (terminal.has(run.state)) return false;
      const recoverableClosure =
        options.allowPullRequestClosedSuspension === true &&
        run.github?.suspended === true &&
        run.github.suspensionReason === "pull-request-closed";
      return !(run.github?.suspended && !recoverableClosure);
    };

    // Exact stable PR association on the run record wins.
    for (const run of runs) {
      if (!selectable(run)) continue;
      if (
        run.github?.repositoryId === repositoryId &&
        run.github.pullRequestNumber === pullRequestNumber
      ) {
        return { kind: "match", run };
      }
    }

    // Identity guards before any name-based candidate selection.
    for (const run of runs) {
      const github = run.github;
      if (!github || !selectable(run)) continue;
      if (
        github.pullRequestNumber !== pullRequestNumber ||
        github.repository !== repository
      ) {
        continue;
      }
      if (github.repositoryId === undefined) {
        return { kind: "conflict", reason: "legacy-repository-identity-missing" };
      }
      if (github.repositoryId !== repositoryId) {
        return { kind: "conflict", reason: "repository-identity-conflict" };
      }
    }

    // Otherwise require exact current remote + branch match (never repository-only),
    // and never steal a run that already holds a GitHub association.
    if (!branch) return { kind: "match", run: undefined };
    for (const run of runs) {
      if (terminal.has(run.state) || run.github) continue;
      if (
        remoteMatchesRepository(run.workspace?.remote, repository) &&
        run.workspace?.branch === branch
      ) {
        return { kind: "match", run };
      }
    }
    return { kind: "match", run: undefined };
  }

  private async publishChecks(
    run: RunRecord,
    target: {
      repositoryId: number;
      repository: string;
      pullRequestNumber: number;
      headSha: string;
      installationId: number;
    },
    previousHeadShas: readonly string[] = [],
  ): Promise<void> {
    const app = this.githubApp();
    const { owner, repo } = parseOwnerRepo(target.repository);
    const token = await this.repositoryToken(
      target.installationId,
      target.repositoryId,
      "checks",
    );
    const publisher = new CheckPublisher({
      http: this.http,
      sideEffects: this.sideEffects,
      readOnlyChecks: app.readOnlyChecks,
      owner,
      repo,
      pullRequestNumber: target.pullRequestNumber,
      token,
    });
    const options = previousHeadShas.length > 0 ? { previousHeadShas } : {};
    await publisher.publishForHeadSha(run, target.headSha, options);
  }
}
