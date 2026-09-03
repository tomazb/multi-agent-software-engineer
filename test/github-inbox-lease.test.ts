import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import { RECORD_KIND, STATE_FORMAT } from "../src/github/delivery-inbox-record.ts";
import type { GitHubInternalEvent } from "../src/github/types.ts";

const RECEIVED_AT = "2026-08-10T00:00:00.000Z";
const BODY_DIGEST = `sha256:${"a".repeat(64)}`;

function event(deliveryId: string): GitHubInternalEvent {
  return {
    eventId: deliveryId,
    type: "push",
    repositoryId: 1308655205,
    repository: "owner/repo",
    installationId: 44,
    headSha: "sha",
    branch: "feature",
    receivedAt: RECEIVED_AT,
  };
}

async function enqueue(inbox: GitHubDeliveryInbox, deliveryId: string): Promise<void> {
  assert.equal(
    (await inbox.enqueue({
      deliveryId,
      eventName: "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
      event: event(deliveryId),
    })).outcome,
    "enqueued",
  );
}

test("inbox fails closed when no-follow queue-marker reads are unavailable", () => {
  assert.throws(
    () => new GitHubDeliveryInbox("/unused", { noFollowFlag: null }),
    /non-following|no-follow|unavailable/i,
  );
});

test("direct inbox ingress rejects unsafe delivery ids before initialization", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-invalid-delivery-id-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);
  const deliveryId = "unsafe/id";

  await assert.rejects(
    inbox.enqueue({
      deliveryId,
      eventName: "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
      event: event(deliveryId),
    }),
    { message: "Invalid GitHub delivery id" },
  );
  await assert.rejects(
    inbox.completeWithoutDispatch({
      deliveryId,
      eventName: "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
    }),
    { message: "Invalid GitHub delivery id" },
  );
  await assert.rejects(access(path.join(root, "inbox")), { code: "ENOENT" });
});

test("state reads detect post-stat growth instead of allocating past the bound", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-state-growth-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let grew = false;
  const inbox = new GitHubDeliveryInbox(root, {
    afterStateStat: async (statePath: string) => {
      if (grew) return;
      grew = true;
      await appendFile(statePath, Buffer.alloc(1_048_576, 0x20));
    },
  } as never);
  await enqueue(inbox, "state-grew-after-stat");

  await assert.rejects(inbox.claimNext(Date.now() + 1), /bounded|exceed|too large/i);
});

test("state writes reject oversized canonical records before publication", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-state-capacity-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);
  const deliveryId = "oversized-state";
  const oversized = event(deliveryId);
  oversized.headSha = "h".repeat(1_048_576);

  await assert.rejects(
    inbox.enqueue({
      deliveryId,
      eventName: "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
      event: oversized,
    }),
    /bounded|capacity|exceed|too large/i,
  );
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  await assert.rejects(
    readFile(path.join(root, "inbox", "state", hash.slice(0, 2), hash, "state.json")),
    { code: "ENOENT" },
  );
});

test("enqueue reserves enough state capacity for every delivery lifecycle transition", async (t) => {
  const stateCapacity = 1024 * 1024;
  const recordFor = (deliveryId: string, headSha: string) => ({
    format: STATE_FORMAT,
    record: RECORD_KIND,
    deliveryId,
    eventName: "push",
    receivedAt: RECEIVED_AT,
    rawBodyDigest: BODY_DIGEST,
    status: "queued" as const,
    attempt: 0,
    nextAttemptAt: RECEIVED_AT,
    event: { ...event(deliveryId), headSha },
  });
  const processingFor = (queued: ReturnType<typeof recordFor>) => {
    const processing: Record<string, unknown> = {
      ...queued,
      status: "processing",
      attempt: Number.MAX_SAFE_INTEGER,
      leaseId: "00000000-0000-4000-8000-000000000000",
      leaseExpiresAt: "+275760-09-13T00:00:00.000Z",
    };
    delete processing.nextAttemptAt;
    return processing;
  };
  const contentBytes = (record: unknown) =>
    Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");

  await t.test("an exactly-full queued record is rejected before it can become unclaimable", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-lifecycle-reject-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const deliveryId = "lifecycle-boundary-reject";
    const base = recordFor(deliveryId, "");
    const headSha = "h".repeat(stateCapacity - contentBytes(base));
    assert.equal(contentBytes(recordFor(deliveryId, headSha)), stateCapacity);

    const inbox = new GitHubDeliveryInbox(root);
    await assert.rejects(
      inbox.enqueue({
        deliveryId,
        eventName: "push",
        receivedAt: RECEIVED_AT,
        rawBodyDigest: BODY_DIGEST,
        event: { ...event(deliveryId), headSha },
      }),
      /lifecycle|bounded|capacity|exceed/i,
    );
    assert.equal((await inbox.enqueue({
      deliveryId,
      eventName: "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
      event: { ...event(deliveryId), headSha: "small-head" },
    })).outcome, "enqueued");
    assert.ok(await inbox.claimNext(Date.now() + 1));
  });

  await t.test("the largest accepted event can be claimed, retried, and completed", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-lifecycle-accept-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const deliveryId = "lifecycle-boundary-accept";
    const empty = recordFor(deliveryId, "");
    const headSha = "h".repeat(stateCapacity - contentBytes(processingFor(empty)));
    assert.equal(contentBytes(processingFor(recordFor(deliveryId, headSha))), stateCapacity);
    const inbox = new GitHubDeliveryInbox(root);
    assert.equal((await inbox.enqueue({
      deliveryId,
      eventName: "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
      event: { ...event(deliveryId), headSha },
    })).outcome, "enqueued");

    const base = Date.now() + 1;
    const first = await inbox.claimNext(base);
    assert.ok(first);
    assert.equal(await inbox.retry(deliveryId, first.record.leaseId, base), true);
    const second = await inbox.claimNext(base + 250);
    assert.ok(second);
    assert.equal(await inbox.complete(deliveryId, second.record.leaseId, base + 251), true);
    assert.equal(await inbox.claimNext(base + 252), undefined);
  });
});

test("heartbeat extends a lease and stale reclaim issues one successor lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-heartbeat-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root, { leaseMs: 1_000 });
  await enqueue(inbox, "lease-heartbeat");
  const base = Date.now() + 1;

  const first = await inbox.claimNext(base);
  assert.ok(first);
  assert.equal(await inbox.heartbeat("lease-heartbeat", first.record.leaseId, base + 500), true);
  assert.equal(await inbox.claimNext(base + 1_100), undefined);
  const successor = await inbox.claimNext(base + 1_501);
  assert.ok(successor);
  assert.notEqual(successor.record.leaseId, first.record.leaseId);
  assert.equal(await inbox.complete("lease-heartbeat", first.record.leaseId, base + 1_600), false);
  assert.equal(await inbox.complete("lease-heartbeat", successor.record.leaseId, base + 1_600), true);
});

test("retry backoff prevents an immediate redispatch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-backoff-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);
  await enqueue(inbox, "retry-backoff");
  const base = Date.now() + 1;
  const first = await inbox.claimNext(base);
  assert.ok(first);
  assert.equal(await inbox.retry("retry-backoff", first.record.leaseId, base), true);
  assert.equal(await inbox.claimNext(base + 249), undefined);
  const retry = await inbox.claimNext(base + 250);
  assert.ok(retry);
  assert.equal(retry.record.attempt, 2);
});

test("bounded queue pages expose the earliest deferred retry to a cursor consumer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-page-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);
  await enqueue(inbox, "due-early");
  await enqueue(inbox, "due-late");
  const base = Date.now() + 10;
  const early = await inbox.claimNext(base);
  assert.equal(early?.record.deliveryId, "due-early");
  assert.equal(await inbox.retry("due-early", early!.record.leaseId, base), true);
  const late = await inbox.claimNext(base + 1);
  assert.equal(late?.record.deliveryId, "due-late");
  assert.equal(await inbox.retry("due-late", late!.record.leaseId, base + 100), true);

  let cursor: string | undefined;
  let earliest = Number.POSITIVE_INFINITY;
  let pages = 0;
  do {
    const page = await inbox.claimNextPage(base + 200, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 1,
    });
    assert.equal(page.claimed, undefined);
    assert.ok(page.scanned <= 1);
    if (page.nextAttemptAt !== undefined) earliest = Math.min(earliest, page.nextAttemptAt);
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages <= 4, "bounded cursor did not complete one queue cycle");
  } while (cursor !== undefined);

  assert.equal(pages, 2);
  assert.equal(earliest, base + 250);

  cursor = undefined;
  let claimed: Awaited<ReturnType<GitHubDeliveryInbox["claimNext"]>>;
  do {
    const page = await inbox.claimNextPage(base + 250, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 1,
    });
    claimed = page.claimed;
    cursor = page.nextCursor;
  } while (!claimed && cursor !== undefined);
  assert.equal(claimed?.record.deliveryId, "due-early");
});

test("bounded queue pages expose a processing lease expiry without claiming it early", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-lease-page-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root, { leaseMs: 1_000 });
  await enqueue(inbox, "lease-page");
  const base = Date.now() + 10;
  const active = await inbox.claimNext(base);
  assert.ok(active);

  const page = await inbox.claimNextPage(base + 100, { limit: 1 });
  assert.equal(page.claimed, undefined);
  assert.equal(page.nextAttemptAt, base + 1_000);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.scanned, 1);
});

test("concurrent claimers publish exactly one processing lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-concurrent-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const firstInbox = new GitHubDeliveryInbox(root);
  const secondInbox = new GitHubDeliveryInbox(root);
  await enqueue(firstInbox, "concurrent-lease");

  const claims = await Promise.all([
    firstInbox.claimNext(Date.now() + 1),
    secondInbox.claimNext(Date.now() + 1),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.ok(claims.find(Boolean)?.record.leaseId);
});

test("orphan queue markers cannot turn terminal records into processing leases", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-terminal-marker-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = new GitHubDeliveryInbox(root);
  const deliveryId = "terminal-marker";
  await inbox.completeWithoutDispatch({
    deliveryId,
    eventName: "unsupported",
    receivedAt: RECEIVED_AT,
    rawBodyDigest: BODY_DIGEST,
  });
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  const queueDirectory = path.join(root, "inbox", "queue", hash.slice(0, 2));
  await mkdir(queueDirectory, { recursive: true });
  await writeFile(path.join(queueDirectory, `${hash}.queued`), "");

  assert.equal(await inbox.claimNext(Date.now() + 1), undefined);
});

test("startup rejects semantically corrupt normalized event state", async (t) => {
  for (const corruption of ["missing-installation", "event-name-mismatch"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `maswe-gh-inbox-corrupt-${corruption}-`));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const inbox = new GitHubDeliveryInbox(root);
    const deliveryId = `corrupt-${corruption}`;
    const normalized: GitHubInternalEvent = corruption === "missing-installation"
      ? {
          eventId: deliveryId,
          type: "installation.deleted",
          installationId: 44,
          receivedAt: RECEIVED_AT,
          rawAction: "deleted",
        }
      : event(deliveryId);
    await inbox.enqueue({
      deliveryId,
      eventName: corruption === "missing-installation" ? "installation" : "push",
      receivedAt: RECEIVED_AT,
      rawBodyDigest: BODY_DIGEST,
      event: normalized,
    });
    const hash = createHash("sha256").update(deliveryId).digest("hex");
    const statePath = path.join(root, "inbox", "state", hash.slice(0, 2), hash, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      eventName: string;
      event: Record<string, unknown>;
    };
    if (corruption === "missing-installation") delete state.event.installationId;
    else state.eventName = "installation";
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");

    await assert.rejects(new GitHubDeliveryInbox(root).initialize(), /durable inbox event/i);
  }
});
