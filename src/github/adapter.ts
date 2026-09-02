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
  isRepoAllowed,
  githubStateRoot,
  parseOwnerRepo,
  pendingCancellationHeads,
  remoteMatchesRepository,
} from "./adapter-identities.ts";
export { remoteMatchesRepository } from "./adapter-identities.ts";
import { CheckPublisher, type GitHubHttpClient } from "./checks.ts";
import { GitHubDeliveryInbox } from "./delivery-inbox.ts";
import {
  type GitHubDispatchResult,
  type GitHubPermanentRejectContext,
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
>;

export class GitHubAppAdapter {
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly store: RunStore;
  private readonly http: GitHubHttpClient;
  private readonly tokenProvider: (installationId: number, repository: string) => Promise<string>;
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
    tokenProvider: (installationId: number, repository: string) => Promise<string>;
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
            this.inbox
              .complete(claimed.record.deliveryId, claimed.record.leaseId)
              .then(() => undefined),
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

  async publishChecksForRun(runId: string): Promise<RunRecord> {
    await this.initializeManualPublisher();
    const app = this.githubApp();
    const initial = await this.store.load(runId);
    if (!initial.github) {
      throw new Error(`Run ${runId} has no github association`);
    }
    await this.afterManualRunLoaded?.(runId);
    return this.withPublicationFence(
      initial.github.repository,
      initial.github.pullRequestNumber,
      async () => {
        const beforeLiveHead = await this.store.load(runId);
        if (!beforeLiveHead.github) {
          throw new Error(`Run ${runId} has no github association`);
        }
        if (
          beforeLiveHead.github.repository !== initial.github!.repository ||
          beforeLiveHead.github.pullRequestNumber !== initial.github!.pullRequestNumber
        ) {
          throw new Error(`Run ${runId} github association changed during publication`);
        }
        if (beforeLiveHead.github.suspended) {
          throw new Error(`Run ${runId} github association is suspended`);
        }
        if (!isRepoAllowed(app, beforeLiveHead.github.repository)) {
          throw new Error(`Repository ${beforeLiveHead.github.repository} is not allowlisted`);
        }
        const livePullRequest = await this.currentPullRequest(
          beforeLiveHead.github.repository,
          beforeLiveHead.github.pullRequestNumber,
          beforeLiveHead.github.installationId,
        );
        if (livePullRequest.state !== "open") {
          throw new Error(`Pull request ${beforeLiveHead.github.repository}#${beforeLiveHead.github.pullRequestNumber} is not open`);
        }
        const liveHead = livePullRequest.headSha;
        const publication = await this.withAssociationIdentityFence(
          beforeLiveHead.github.repository,
          beforeLiveHead.github.pullRequestNumber,
          () =>
            this.withRunTargetMutationFence(runId, () =>
              this.associations.withTransaction(async (transaction) => {
                const indexed = transaction.find(
                  beforeLiveHead.github!.repository,
                  beforeLiveHead.github!.pullRequestNumber,
                );
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
                if (
                  run.github.repository !== beforeLiveHead.github!.repository ||
                  run.github.pullRequestNumber !== beforeLiveHead.github!.pullRequestNumber
                ) {
                  throw new Error(`Run ${runId} github association changed during publication`);
                }
                if (run.github.suspended) {
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
                const committedAssociation = transaction.bind({
                  runId: run.id,
                  installationId: run.github.installationId,
                  repository: run.github.repository,
                  pullRequestNumber: run.github.pullRequestNumber,
                  baseSha: run.github.baseSha,
                  headSha: liveHead,
                  branch: run.github.branch,
                });
                return { run, previousHeadSha, pendingHeadShas, committedAssociation };
              }),
            ),
        );
        return this.publishCommittedAssociation(
          publication.committedAssociation,
          publication.pendingHeadShas,
        );
      },
    );
  }

  private async withPublicationFence<T>(
    repository: string,
    pullRequestNumber: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    return withGitHubJournal(
      this.root,
      "publication",
      `${repository.toLowerCase()}#${pullRequestNumber}`,
      callback,
      { timeoutMs: 60_000 },
    );
  }

  private async withAssociationIdentityFence<T>(
    repository: string,
    pullRequestNumber: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    return withGitHubJournal(
      this.root,
      "association-identity",
      `${repository.toLowerCase()}#${pullRequestNumber}`,
      callback,
      { timeoutMs: 60_000 },
    );
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
      expected.repository,
      expected.pullRequestNumber,
      async () => {
        const routed = await this.routeAssociationHead(expected);
        await this.afterAssociationRoutedBeforeChecks?.(expected.runId);
        await this.publishChecks(
          routed,
          expected.repository,
          expected.pullRequestNumber,
          expected.headSha,
          expected.installationId,
          pendingHeadShas,
        );
        return this.clearPublishedCancellationHeads(
          expected.runId,
          expected.repository,
          expected.pullRequestNumber,
          expected.headSha,
          pendingHeadShas,
        );
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
      github.repository !== expected.repository ||
      github.pullRequestNumber !== expected.pullRequestNumber ||
      github.headSha !== expected.headSha
    ) {
      throw new Error(
        `Run ${expected.runId} GitHub association changed before routing`,
      );
    }
    const indexed = await this.associations.find(
      expected.repository,
      expected.pullRequestNumber,
    );
    if (
      !indexed ||
      indexed.suspended ||
      indexed.runId !== expected.runId ||
      indexed.installationId !== expected.installationId ||
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
    runId: string,
    repository: string,
    pullRequestNumber: number,
    publishedHeadSha: string,
    cancelledHeadShas: readonly string[],
  ): Promise<RunRecord> {
    if (cancelledHeadShas.length === 0) return this.store.load(runId);
    const cancelled = new Set(cancelledHeadShas);
    return this.associations.withTransaction(async (transaction) => {
      const run = await this.store.load(runId);
      if (
        !run.github ||
        run.github.repository !== repository ||
        run.github.pullRequestNumber !== pullRequestNumber ||
        run.github.headSha !== publishedHeadSha
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
      transaction.bind({
        runId: run.id,
        installationId: run.github.installationId,
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
   */
  private async dispatch(
    event: GitHubInternalEvent,
    app: GitHubAppConfig,
  ): Promise<GitHubDispatchResult> {
    if (event.type === "installation.deleted") {
      if (event.installationId !== undefined) {
        const associations = await this.associations.findAllByInstallation(
          event.installationId,
        );
        await this.suspendAssociations(associations);
      }
      return { kind: "applied" };
    }

    if (event.type === "installation_repositories.removed") {
      if (event.installationId === undefined) return { kind: "applied" };
      // #34 ingress (Task 2) carries repository names either as new ID/name
      // pairs or, for historical durable records, as a migrated
      // `legacyRepositories` name list; this name-based lookup is unchanged
      // pre-#34 behavior and is superseded by stable-ID authority reduction
      // in a later task (see spec §6.2).
      const repositories =
        event.repositories && event.repositories.length > 0
          ? event.repositories.map((identity) => identity.repository)
          : event.legacyRepositories && event.legacyRepositories.length > 0
            ? event.legacyRepositories
            : event.repository
              ? [event.repository]
              : [];
      const failures: unknown[] = [];
      for (const repository of repositories) {
        try {
          const associations = await this.associations.findAllByInstallation(
            event.installationId,
            repository,
          );
          await this.suspendAssociations(associations);
        } catch (error) {
          if (error instanceof AggregateError) failures.push(...error.errors);
          else failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Authorization suspension failed for ${failures.length} repository association operation(s)`,
        );
      }
      // An authority-reducing suspension is an allowed mutation, so the
      // delivery completes normally and is never a permanent drop.
      return { kind: "applied" };
    }

    if (event.observeOnly) {
      return { kind: "applied" };
    }

    if (event.repository && !isRepoAllowed(app, event.repository)) {
      // The repository is not operator-allowlisted: retrying can never make
      // it allowlisted, so the delivery is permanently consumed instead of
      // becoming a poison redelivery.
      return { kind: "permanent-reject", reason: "repository-not-allowlisted" };
    }

    if (
      event.type.startsWith("pull_request.") &&
      event.repository &&
      event.pullRequestNumber !== undefined &&
      event.headSha
    ) {
      await this.handlePullRequestEvent(event);
      return { kind: "applied" };
    }

    if (event.type === "push" && event.repository && event.branch && event.headSha) {
      await this.handlePushEvent(event);
    }
    return { kind: "applied" };
  }

  private async suspendAssociations(
    associations: readonly AssociationRecord[],
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const expected of associations) {
      try {
        await this.withAssociationIdentityFence(
          expected.repository,
          expected.pullRequestNumber,
          async () => {
            const association = await this.associations.find(
              expected.repository,
              expected.pullRequestNumber,
            );
            if (!association || association.installationId !== expected.installationId) return;
            const suspended = await this.associations.suspend(
              association.repository,
              association.pullRequestNumber,
              "authorization-revoked",
            );
            if (suspended) await this.suspendRunRecord(suspended);
          },
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
  }

  private async suspendRunRecord(association: AssociationRecord): Promise<void> {
    const runId = association.runId;
    let run: RunRecord;
    try {
      run = await this.store.load(runId);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
    if (!run.github) return;
    if (
      run.github.installationId !== association.installationId ||
      run.github.repository !== association.repository ||
      run.github.pullRequestNumber !== association.pullRequestNumber
    ) {
      return;
    }
    if (
      run.github.suspended &&
      run.github.suspensionReason === "authorization-revoked"
    ) {
      return;
    }
    run.github = {
      ...run.github,
      suspended: true,
      suspensionReason: "authorization-revoked",
    };
    await this.store.save(run);
  }

  private async handlePushEvent(event: GitHubInternalEvent): Promise<void> {
    const repository = event.repository!;
    const branch = event.branch!;
    const headSha = event.headSha!;
    const associations = await this.associations.findAllByRepositoryBranch(repository, branch);
    const failures: unknown[] = [];
    for (const association of associations) {
      if (association.suspended) continue;
      const synthetic: GitHubInternalEvent = {
        ...event,
        type: "pull_request.synchronize",
        pullRequestNumber: association.pullRequestNumber,
        headSha,
        branch,
        repository,
        installationId: association.installationId,
      };
      try {
        await this.handlePullRequestEvent(synthetic);
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
  }

  private async currentPullRequest(
    repository: string,
    pullRequestNumber: number,
    installationId: number,
  ): Promise<{ headSha: string; state: "open" | "closed" }> {
    const { owner, repo } = parseOwnerRepo(repository);
    const token = await this.tokenProvider(installationId, repository);
    const response = await this.http.request(
      "GET",
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullRequestNumber}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "maswe-github-app",
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Failed to resolve current PR head for ${repository}#${pullRequestNumber}: HTTP ${response.status}`,
      );
    }
    const body = response.body as { head?: { sha?: string }; state?: unknown };
    const head = body.head;
    if (typeof head?.sha !== "string" || !head.sha) {
      throw new Error(
        `Failed to resolve current PR head for ${repository}#${pullRequestNumber}: missing head.sha`,
      );
    }
    if (body.state !== "open" && body.state !== "closed") {
      throw new Error(
        `Failed to resolve current PR state for ${repository}#${pullRequestNumber}`,
      );
    }
    return { headSha: head.sha, state: body.state };
  }

  private async handlePullRequestEvent(event: GitHubInternalEvent): Promise<void> {
    const repository = event.repository!;
    const pullRequestNumber = event.pullRequestNumber!;
    const headSha = event.headSha!;
    const installationId = event.installationId;
    if (installationId === undefined || installationId <= 0) {
      throw new Error("pull_request event missing installation id");
    }
    await this.withPublicationFence(repository, pullRequestNumber, async () => {
      const livePullRequest = await this.currentPullRequest(
        repository,
        pullRequestNumber,
        installationId,
      );
      const liveHead = livePullRequest.headSha;
      if (liveHead !== headSha) {
        // Stale or out-of-order delivery: current PR head has already moved on.
        return;
      }
      const expectsClosed = event.type === "pull_request.closed";
      if (
        (expectsClosed && livePullRequest.state !== "closed") ||
        (!expectsClosed && livePullRequest.state !== "open")
      ) {
        // Same-SHA out-of-order lifecycle deliveries cannot invert the live PR state.
        return;
      }

      await this.beforeAssociationTransaction?.(event.eventId);
      const publication = await this.withAssociationIdentityFence(
        repository,
        pullRequestNumber,
        async () => {
          const identityAssociation = await this.associations.find(
            repository,
            pullRequestNumber,
          );
          const identityRun = identityAssociation
            ? await this.store.load(identityAssociation.runId)
            : await this.findMatchingRun(repository, pullRequestNumber, event.branch, {
                allowPullRequestClosedSuspension:
                  event.type === "pull_request.closed" ||
                  event.type === "pull_request.reopened",
              });
          const transact = (targetRun: RunRecord | undefined) =>
            this.associations.withTransaction(async (transaction) => {
              const association = transaction.find(repository, pullRequestNumber);
              if (association?.runId !== identityAssociation?.runId) {
                throw new Error(
                  `GitHub association ${repository}#${pullRequestNumber} changed before target mutation`,
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
                  transaction.suspend(
                    repository,
                    pullRequestNumber,
                    "pull-request-closed",
                  );
                } else if (targetRun?.github) {
                  transaction.bind({
                    runId: targetRun.id,
                    installationId,
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
              const committedAssociation = transaction.bind({
                runId: targetRun.id,
                installationId,
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
                committedAssociation,
              } as const;
            });
          if (!identityRun) return transact(undefined);
          return this.withRunTargetMutationFence(identityRun.id, async (authoritative) => {
            if (identityAssociation) return transact(authoritative);
            const currentMatch = await this.findMatchingRun(
              repository,
              pullRequestNumber,
              event.branch,
              {
                allowPullRequestClosedSuspension:
                  event.type === "pull_request.closed" ||
                  event.type === "pull_request.reopened",
              },
            );
            if (currentMatch?.id !== authoritative.id) {
              return transact(undefined);
            }
            return transact(currentMatch);
          });
        },
      );

      if (publication.kind === "publish") {
        await this.publishCommittedAssociation(
          publication.committedAssociation,
          publication.pendingHeadShas,
        );
        return;
      }
      if (publication.kind === "ignore") return;

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
          repository,
          pullRequestNumber,
          baseSha: event.baseSha ?? headSha,
          headSha,
          branch: event.branch ?? "unknown",
          suspended: false,
        },
      };
      await this.publishChecks(synthetic, repository, pullRequestNumber, headSha, installationId);
    });
  }

  private async findMatchingRun(
    repository: string,
    pullRequestNumber: number,
    branch: string | undefined,
    options: { allowPullRequestClosedSuspension?: boolean } = {},
  ): Promise<RunRecord | undefined> {
    const runs = await this.store.list();
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

    // Exact PR association on the run record wins.
    for (const run of runs) {
      const recoverableClosure =
        options.allowPullRequestClosedSuspension === true &&
        run.github?.suspended === true &&
        run.github.suspensionReason === "pull-request-closed";
      if (terminal.has(run.state) || (run.github?.suspended && !recoverableClosure)) continue;
      if (
        run.github?.repository === repository &&
        run.github.pullRequestNumber === pullRequestNumber
      ) {
        return run;
      }
    }

    // Otherwise require exact remote + branch match (never repository-only).
    if (!branch) return undefined;
    for (const run of runs) {
      if (terminal.has(run.state) || run.github?.suspended) continue;
      if (run.github && run.github.repository === repository) {
        // Already associated to a different PR — do not steal.
        if (run.github.pullRequestNumber !== pullRequestNumber) continue;
      }
      if (
        remoteMatchesRepository(run.workspace?.remote, repository) &&
        run.workspace?.branch === branch
      ) {
        return run;
      }
    }
    return undefined;
  }

  private async publishChecks(
    run: RunRecord,
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    installationId: number,
    previousHeadShas: readonly string[] = [],
  ): Promise<void> {
    const app = this.githubApp();
    const { owner, repo } = parseOwnerRepo(repository);
    const token = await this.tokenProvider(installationId, repository);
    const publisher = new CheckPublisher({
      http: this.http,
      sideEffects: this.sideEffects,
      readOnlyChecks: app.readOnlyChecks,
      owner,
      repo,
      pullRequestNumber,
      token,
    });
    const options = previousHeadShas.length > 0 ? { previousHeadShas } : {};
    await publisher.publishForHeadSha(run, headSha, options);
  }
}
