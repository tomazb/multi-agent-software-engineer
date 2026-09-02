import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import {
  type GitHubPermanentRejectContext,
  nextPermanentRepositoryDropCount,
} from "../src/github/dispatch-disposition.ts";
import { GitHubWebhookWorker } from "../src/github/webhook-worker.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withWatchdog<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("an immediate wake requested during a scan runs before the existing delay", async (t) => {
  const firstScanStarted = deferred();
  const releaseFirstScan = deferred();
  const secondScanStarted = deferred();
  let claimCalls = 0;
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls === 1) {
        firstScanStarted.resolve();
        await releaseFirstScan.promise;
      } else if (claimCalls === 2) {
        secondScanStarted.resolve();
      }
      return { scanned: 0 };
    },
    async pendingCount() {
      return 0;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => ({ kind: "applied" as const }),
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await firstScanStarted.promise;
  worker.wake(0);
  releaseFirstScan.resolve();

  await withWatchdog(
    secondScanStarted.promise,
    250,
    "active worker lost its immediate wake",
  );
  assert.equal(claimCalls, 2);
});

test("retry persistence failure backs off before another queue scan", async (t) => {
  let claimCalls = 0;
  let resolveScheduled!: (delayMs: number) => void;
  const scheduled = new Promise<number>((resolve) => {
    resolveScheduled = resolve;
  });
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls === 1) {
        return {
          scanned: 1,
          claimed: {
            record: {
              format: 2,
              record: "github-delivery-inbox",
              deliveryId: "retry-write-failure",
              eventName: "push",
              receivedAt: "2026-08-10T00:00:00.000Z",
              rawBodyDigest: `sha256:${"a".repeat(64)}`,
              status: "processing",
              attempt: 1,
              leaseId: "lease-1",
              leaseExpiresAt: "2026-08-10T00:00:30.000Z",
              event: {
                eventId: "retry-write-failure",
                type: "push",
                repository: "owner/repo",
                installationId: 1,
                headSha: "head",
                branch: "feature",
                receivedAt: "2026-08-10T00:00:00.000Z",
              },
            },
          },
        };
      }
      return { scanned: 0 };
    },
    async heartbeat() {
      return true;
    },
    async retry() {
      throw new Error("simulated retry fsync failure");
    },
    async pendingCount() {
      return 1;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => {
      throw new Error("simulated dispatch failure");
    },
    onSchedule: resolveScheduled,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  const delayMs = await withWatchdog(
    scheduled,
    1_000,
    "worker retry backoff was not scheduled",
  );

  assert.equal(claimCalls, 1, "retry persistence failure rescanned before backoff");
  assert.ok(delayMs >= 250, `retry persistence failure scheduled only ${delayMs}ms backoff`);
});

test("claim failure backs off before another queue scan", async (t) => {
  let claimCalls = 0;
  let resolveScheduled!: (delayMs: number) => void;
  const scheduled = new Promise<number>((resolve) => {
    resolveScheduled = resolve;
  });
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls === 1) throw new Error("simulated queue scan failure");
      return { scanned: 0 };
    },
    async pendingCount() {
      return 1;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => ({ kind: "applied" as const }),
    onSchedule: resolveScheduled,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  const delayMs = await withWatchdog(
    scheduled,
    1_000,
    "worker scan backoff was not scheduled",
  );

  assert.equal(claimCalls, 1, "failed queue scan repeated before backoff");
  assert.ok(delayMs >= 250, `queue scan failure scheduled only ${delayMs}ms backoff`);
});

test("durable completion failure is not mislabeled as dispatch failure", async (t) => {
  const diagnostics: Array<{ code?: unknown }> = [];
  let claimCalls = 0;
  let resolveScheduled!: (delayMs: number) => void;
  const scheduled = new Promise<number>((resolve) => {
    resolveScheduled = resolve;
  });
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls > 1) return { scanned: 0 };
      return {
        scanned: 1,
        claimed: {
          record: {
            format: 2,
            record: "github-delivery-inbox",
            deliveryId: "completion-write-failure",
            eventName: "push",
            receivedAt: "2026-08-10T00:00:00.000Z",
            rawBodyDigest: `sha256:${"b".repeat(64)}`,
            status: "processing",
            attempt: 1,
            leaseId: "lease-complete",
            leaseExpiresAt: "2026-08-10T00:00:30.000Z",
            event: {
              eventId: "completion-write-failure",
              type: "push",
              repository: "owner/repo",
              installationId: 1,
              headSha: "head",
              branch: "feature",
              receivedAt: "2026-08-10T00:00:00.000Z",
            },
          },
        },
      };
    },
    async heartbeat() {
      return true;
    },
    async complete() {
      throw new Error("simulated completion fsync failure");
    },
    async retry() {
      return true;
    },
    async pendingCount() {
      return 1;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => ({ kind: "applied" as const }),
    onDiagnostic: (error) => diagnostics.push(error as { code?: unknown }),
    onSchedule: resolveScheduled,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await withWatchdog(
    scheduled,
    1_000,
    "completion failure schedule was not exposed",
  );

  assert.equal(diagnostics.some(({ code }) => code === "GITHUB_WEBHOOK_DISPATCH_FAILED"), false);
  assert.equal(diagnostics.some(({ code }) => code === "GITHUB_WEBHOOK_COMPLETION_FAILED"), true);
});

function claimedDelivery(deliveryId: string, attempt: number, leaseId: string) {
  return {
    scanned: 1,
    claimed: {
      record: {
        format: 2,
        record: "github-delivery-inbox",
        deliveryId,
        eventName: "pull_request",
        receivedAt: "2026-08-10T00:00:00.000Z",
        rawBodyDigest: `sha256:${"c".repeat(64)}`,
        status: "processing",
        attempt,
        leaseId,
        leaseExpiresAt: "2026-08-10T00:00:30.000Z",
        event: {
          eventId: deliveryId,
          type: "pull_request.synchronize",
          repository: "other/repo",
          repositoryId: 7_007,
          installationId: 44,
          pullRequestNumber: 9,
          headSha: "head",
          receivedAt: "2026-08-10T00:00:00.000Z",
        },
      },
    },
  };
}

test("a permanent repository rejection is consumed instead of retried", async (t) => {
  const completions: Array<[string, string]> = [];
  const retries: Array<[string, string]> = [];
  const counted: GitHubPermanentRejectContext[] = [];
  const countedOnce = deferred();
  let claimCalls = 0;
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls > 1) return { scanned: 0 };
      return claimedDelivery("permanent-consume", 1, "lease-permanent");
    },
    async heartbeat() {
      return true;
    },
    async complete(deliveryId: string, leaseId: string) {
      completions.push([deliveryId, leaseId]);
      return true;
    },
    async retry(deliveryId: string, leaseId: string) {
      retries.push([deliveryId, leaseId]);
      return true;
    },
    async pendingCount() {
      return 0;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => ({
      kind: "permanent-reject" as const,
      reason: "repository-not-allowlisted" as const,
    }),
    onPermanentRejectCompleted: (context) => {
      counted.push(context);
      countedOnce.resolve();
    },
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await withWatchdog(
    countedOnce.promise,
    1_000,
    "permanent repository rejection was never counted after completion",
  );

  assert.deepEqual(completions, [["permanent-consume", "lease-permanent"]]);
  assert.deepEqual(retries, [], "a permanent rejection must never be retried");
  assert.deepEqual(counted, [{
    deliveryId: "permanent-consume",
    eventName: "pull_request",
    attempt: 1,
    reason: "repository-not-allowlisted",
  }]);
});

test("an authority-reducing revocation applies without counting a permanent drop", async (t) => {
  const completions: Array<[string, string]> = [];
  const counted: GitHubPermanentRejectContext[] = [];
  let claimCalls = 0;
  let resolveScheduled!: (delayMs: number) => void;
  const scheduled = new Promise<number>((resolve) => {
    resolveScheduled = resolve;
  });
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls > 1) return { scanned: 0 };
      return claimedDelivery("revocation-applied", 1, "lease-revocation");
    },
    async heartbeat() {
      return true;
    },
    async complete(deliveryId: string, leaseId: string) {
      completions.push([deliveryId, leaseId]);
      return true;
    },
    async retry() {
      throw new Error("an applied disposition must never retry");
    },
    async pendingCount() {
      return 0;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    // A fully traversed authenticated absence whose affected association was
    // successfully suspended as `authorization-revoked` is an allowed
    // authority-reducing mutation, so dispatch reports `applied`.
    dispatch: async () => ({ kind: "applied" as const }),
    onPermanentRejectCompleted: (context) => counted.push(context),
    onSchedule: resolveScheduled,
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await withWatchdog(scheduled, 1_000, "worker never drained the applied delivery");

  assert.deepEqual(completions, [["revocation-applied", "lease-revocation"]]);
  assert.deepEqual(counted, [], "an applied authority reduction is not a permanent drop");
});

test("an ambiguous dispatch failure retries and is never counted as a permanent drop", async (t) => {
  const retries: Array<[string, string]> = [];
  const counted: GitHubPermanentRejectContext[] = [];
  const retried = deferred();
  let claimCalls = 0;
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls > 1) return { scanned: 0 };
      return claimedDelivery("ambiguous-retry", 1, "lease-ambiguous");
    },
    async heartbeat() {
      return true;
    },
    async complete() {
      throw new Error("an ambiguous failure must never complete the delivery");
    },
    async retry(deliveryId: string, leaseId: string) {
      retries.push([deliveryId, leaseId]);
      retried.resolve();
      return true;
    },
    async pendingCount() {
      return 0;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    // Rate limiting, transport failure, or pagination exhaustion: ambiguous,
    // never proof of authorization loss.
    dispatch: async () => {
      throw new Error("simulated rate-limited installation repository listing");
    },
    onPermanentRejectCompleted: (context) => counted.push(context),
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await withWatchdog(retried.promise, 1_000, "ambiguous dispatch failure was not retried");

  assert.deepEqual(retries, [["ambiguous-retry", "lease-ambiguous"]]);
  assert.deepEqual(counted, [], "an ambiguous failure must never count a permanent drop");
});

test("a permanent drop is counted only once, after a completion finally succeeds", async (t) => {
  const counted: GitHubPermanentRejectContext[] = [];
  const countedAfterRecovery = deferred();
  let completeCalls = 0;
  let retryCalls = 0;
  let countedAtRetry = -1;
  let claimCalls = 0;
  const inbox = {
    async claimNextPage() {
      claimCalls += 1;
      if (claimCalls > 2) return { scanned: 0 };
      return claimedDelivery("permanent-completion-recovery", claimCalls, `lease-${claimCalls}`);
    },
    async heartbeat() {
      return true;
    },
    async complete() {
      completeCalls += 1;
      if (completeCalls === 1) throw new Error("simulated completion fsync failure");
      return true;
    },
    async retry() {
      retryCalls += 1;
      countedAtRetry = counted.length;
      return true;
    },
    async pendingCount() {
      return 0;
    },
  } as unknown as GitHubDeliveryInbox;
  const worker = new GitHubWebhookWorker({
    inbox,
    dispatch: async () => ({
      kind: "permanent-reject" as const,
      reason: "repository-access-revoked" as const,
    }),
    onPermanentRejectCompleted: (context) => {
      counted.push(context);
      countedAfterRecovery.resolve();
    },
  });
  t.after(async () => worker.stop({ drainMs: 0 }));

  worker.start();
  await withWatchdog(
    countedAfterRecovery.promise,
    2_000,
    "a permanent drop was never counted after its completion recovered",
  );

  assert.equal(retryCalls, 1, "the failed completion must follow existing completion recovery");
  assert.equal(countedAtRetry, 0, "a failed completion must not count a permanent drop");
  assert.equal(completeCalls, 2);
  assert.deepEqual(counted, [{
    deliveryId: "permanent-completion-recovery",
    eventName: "pull_request",
    attempt: 2,
    reason: "repository-access-revoked",
  }], "a recovered completion counts the permanent drop exactly once");
});

test("the permanent drop counter is a saturating positive safe integer", () => {
  assert.equal(nextPermanentRepositoryDropCount(0), 1);
  assert.equal(nextPermanentRepositoryDropCount(41), 42);
  assert.equal(
    nextPermanentRepositoryDropCount(Number.MAX_SAFE_INTEGER - 1),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    nextPermanentRepositoryDropCount(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  assert.ok(Number.isSafeInteger(nextPermanentRepositoryDropCount(Number.MAX_SAFE_INTEGER)));
});
