import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import type { RunGitHubAssociation, RunRecord } from "../src/domain.ts";
import { DurableAtomicWriteOutcomeUnknownError } from "../src/durable-file.ts";
import type { GitHubAssociationTransaction } from "../src/github/association.ts";
import { saveGitHubAssociationMutation } from "../src/github/association-mutation.ts";
import { FileRunStore, type RunStore } from "../src/store.ts";

const tempDirectories = new Set<string>();

after(async () => {
  await Promise.all([...tempDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function testConfig() {
  return mergeConfigForTest({ runtime: { kind: "mock" }, quality: { commands: [] } });
}

const ASSOCIATION: RunGitHubAssociation = {
  installationId: 44,
  repository: "owner/repo",
  pullRequestNumber: 9,
  baseSha: "base-sha",
  headSha: "head-sha",
  branch: "maswe/run-1",
};

/**
 * Records the compensation callbacks the mutation helper registers. The
 * callbacks themselves are real: each test invokes them and asserts the
 * durable run on disk, never the double.
 */
function transactionDouble(): {
  transaction: GitHubAssociationTransaction;
  rollbacks: Array<() => Promise<void>>;
} {
  const rollbacks: Array<() => Promise<void>> = [];
  const unsupported = (name: string) => (): never => {
    throw new Error(`transaction.${name} must not be used by saveGitHubAssociationMutation`);
  };
  const transaction: GitHubAssociationTransaction = {
    findStable: unsupported("findStable"),
    findLegacy: unsupported("findLegacy"),
    bindStable: unsupported("bindStable"),
    migrateLegacy: unsupported("migrateLegacy"),
    refreshCanonicalRepository: unsupported("refreshCanonicalRepository"),
    suspendStable: unsupported("suspendStable"),
    suspendLegacy: unsupported("suspendLegacy"),
    onRollback(callback) {
      rollbacks.push(callback);
    },
  };
  return { transaction, rollbacks };
}

async function harness(
  wrapSave?: (base: FileRunStore, run: RunRecord) => Promise<void>,
): Promise<{ store: RunStore; base: FileRunStore; run: RunRecord }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-assoc-mutation-"));
  tempDirectories.add(cwd);
  const base = new FileRunStore(cwd);
  const run = await base.create("association-mutation", "req", testConfig());
  const store: RunStore = wrapSave === undefined ? base : {
    create: base.create.bind(base),
    load: base.load.bind(base),
    list: base.list.bind(base),
    applyEvent: base.applyEvent.bind(base),
    writeArtifact: base.writeArtifact.bind(base),
    readArtifact: base.readArtifact.bind(base),
    save: (record) => wrapSave(base, record),
  };
  return { store, base, run };
}

function associate(run: RunRecord): RunRecord {
  const candidate = structuredClone(run);
  candidate.github = structuredClone(ASSOCIATION);
  return candidate;
}

test("saveGitHubAssociationMutation persists a github-only change and registers compensation", async () => {
  const { store, base, run } = await harness();
  const { transaction, rollbacks } = transactionDouble();

  await saveGitHubAssociationMutation({
    store,
    transaction,
    before: structuredClone(run),
    candidate: associate(run),
  });

  assert.deepEqual((await base.load(run.id)).github, ASSOCIATION);
  assert.equal(rollbacks.length, 1, "a known transaction failure must be compensable");

  await rollbacks[0]!();
  const compensated = await base.load(run.id);
  assert.equal(compensated.github, undefined, "compensation must delete an absent-before association");
  assert.equal("github" in compensated, false);
});

test("saveGitHubAssociationMutation compensation restores the previous github and evidence", async () => {
  const { store, base, run } = await harness();
  const { transaction, rollbacks } = transactionDouble();
  run.github = structuredClone(ASSOCIATION);
  run.evidence = { quality: { headSha: "head-sha", passed: true, at: "2026-01-01T00:00:00.000Z" } };
  await base.save(run);
  const before = await base.load(run.id);

  const candidate = structuredClone(before);
  candidate.github = { ...ASSOCIATION, headSha: "head-sha-2", suspended: true };
  delete candidate.evidence;

  await saveGitHubAssociationMutation({ store, transaction, before, candidate });
  assert.equal((await base.load(run.id)).github?.headSha, "head-sha-2");

  await rollbacks[0]!();
  const compensated = await base.load(run.id);
  assert.deepEqual(compensated.github, before.github);
  assert.deepEqual(compensated.evidence, before.evidence);
});

test("saveGitHubAssociationMutation rejects a candidate that changes fields outside github/evidence", async () => {
  const { store, base, run } = await harness();
  const { transaction, rollbacks } = transactionDouble();
  const before = structuredClone(run);

  const candidate = associate(run);
  candidate.title = "retitled outside the association mutation";

  await assert.rejects(
    saveGitHubAssociationMutation({ store, transaction, before, candidate }),
    /changed fields outside github\/evidence/,
  );
  const onDisk = await base.load(run.id);
  assert.equal(onDisk.github, undefined, "a rejected mutation must not reach disk");
  assert.equal(onDisk.title, run.title);
  assert.equal(rollbacks.length, 0);
});

test("saveGitHubAssociationMutation rejects a candidate that changes the event history", async () => {
  const { store, base, run } = await harness();
  const { transaction, rollbacks } = transactionDouble();
  const before = structuredClone(run);

  const candidate = associate(run);
  candidate.events = [
    ...candidate.events,
    {
      id: "evt-injected",
      at: "2026-01-01T00:00:00.000Z",
      type: "START",
      actor: "test",
      from: run.state,
      to: run.state,
    },
  ];

  await assert.rejects(
    saveGitHubAssociationMutation({ store, transaction, before, candidate }),
    /changed fields outside github\/evidence/,
  );
  assert.equal((await base.load(run.id)).events.length, run.events.length);
  assert.equal(rollbacks.length, 0);
});

test("saveGitHubAssociationMutation rethrows a known save failure that never reached disk", async () => {
  const { store, base, run } = await harness(async () => {
    throw new Error("simulated run save failure");
  });
  const { transaction, rollbacks } = transactionDouble();

  await assert.rejects(
    saveGitHubAssociationMutation({
      store,
      transaction,
      before: structuredClone(run),
      candidate: associate(run),
    }),
    /simulated run save failure/,
  );
  assert.equal((await base.load(run.id)).github, undefined);
  assert.equal((await base.load(run.id)).version, run.version);
  assert.equal(rollbacks.length, 0, "a failed save must not register compensation");
});

test("saveGitHubAssociationMutation compensates a known save failure that already reached disk", async () => {
  let rejectAfterSave = true;
  const { store, base, run } = await harness(async (baseStore, record) => {
    await baseStore.save(record);
    if (rejectAfterSave) {
      rejectAfterSave = false;
      throw new Error("simulated rejected save after durable write");
    }
  });
  const { transaction, rollbacks } = transactionDouble();

  await assert.rejects(
    saveGitHubAssociationMutation({
      store,
      transaction,
      before: structuredClone(run),
      candidate: associate(run),
    }),
    /simulated rejected save after durable write/,
  );
  assert.equal(
    (await base.load(run.id)).github,
    undefined,
    "a known failure whose write reached disk must be reconciled back",
  );
  assert.equal(rollbacks.length, 0);
});

test("saveGitHubAssociationMutation never rolls back a durable write whose outcome is unknown", async () => {
  const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError("Run record", new Error("sync failed"));
  let raised = false;
  const { store, base, run } = await harness(async (baseStore, record) => {
    await baseStore.save(record);
    if (!raised) {
      raised = true;
      throw outcomeUnknown;
    }
  });
  const { transaction, rollbacks } = transactionDouble();

  await assert.rejects(
    saveGitHubAssociationMutation({
      store,
      transaction,
      before: structuredClone(run),
      candidate: associate(run),
    }),
    (error: unknown) => {
      assert.equal(error, outcomeUnknown, "the outcome-unknown error must propagate unchanged");
      return true;
    },
  );
  assert.deepEqual(
    (await base.load(run.id)).github,
    ASSOCIATION,
    "an outcome-unknown write must be re-read and reconciled, never blindly rolled back",
  );
  assert.equal(rollbacks.length, 0);
});

test("saveGitHubAssociationMutation detects an outcome-unknown error nested in an aggregate", async () => {
  const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError("Run record", new Error("sync failed"));
  const aggregate = new AggregateError([new Error("outer"), outcomeUnknown], "run save failed");
  let raised = false;
  const { store, base, run } = await harness(async (baseStore, record) => {
    await baseStore.save(record);
    if (!raised) {
      raised = true;
      throw aggregate;
    }
  });
  const { transaction, rollbacks } = transactionDouble();

  await assert.rejects(
    saveGitHubAssociationMutation({
      store,
      transaction,
      before: structuredClone(run),
      candidate: associate(run),
    }),
    (error: unknown) => {
      assert.equal(error, aggregate);
      return true;
    },
  );
  assert.deepEqual((await base.load(run.id)).github, ASSOCIATION);
  assert.equal(rollbacks.length, 0);
});

test("saveGitHubAssociationMutation aggregates a compensation failure with the original error", async () => {
  let rejectAfterSave = true;
  const original = new Error("simulated rejected save after durable write");
  const { store, base, run } = await harness(async (baseStore, record) => {
    if (rejectAfterSave) {
      rejectAfterSave = false;
      await baseStore.save(record);
      throw original;
    }
    throw new Error("simulated compensation write failure");
  });
  const { transaction, rollbacks } = transactionDouble();

  await assert.rejects(
    saveGitHubAssociationMutation({
      store,
      transaction,
      before: structuredClone(run),
      candidate: associate(run),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError, `expected AggregateError, got ${error}`);
      assert.equal(error.errors[0], original);
      assert.match((error.errors[1] as Error).message, /simulated compensation write failure/);
      assert.equal(error.message, original.message);
      assert.equal(error.cause, original);
      return true;
    },
  );
  assert.deepEqual((await base.load(run.id)).github, ASSOCIATION);
  assert.equal(rollbacks.length, 0);
});

test("saveGitHubAssociationMutation compensation refuses a same-version record it no longer recognises", async () => {
  const { base, run } = await harness();
  const { transaction, rollbacks } = transactionDouble();
  const before = structuredClone(run);
  let tamper = false;
  const observing: RunStore = {
    create: base.create.bind(base),
    save: base.save.bind(base),
    list: base.list.bind(base),
    applyEvent: base.applyEvent.bind(base),
    writeArtifact: base.writeArtifact.bind(base),
    readArtifact: base.readArtifact.bind(base),
    async load(runId) {
      const record = await base.load(runId);
      if (tamper) record.title = "changed by another writer at the same version";
      return record;
    },
  };
  await saveGitHubAssociationMutation({
    store: observing,
    transaction,
    before,
    candidate: associate(run),
  });

  tamper = true;
  await assert.rejects(rollbacks[0]!(), /attempted snapshot no longer matches/);
  assert.deepEqual(
    (await base.load(run.id)).github,
    ASSOCIATION,
    "a refused compensation must leave the run untouched",
  );
});

test("saveGitHubAssociationMutation compensation refuses a run that changed after the mutation", async () => {
  const { store, base, run } = await harness();
  const { transaction, rollbacks } = transactionDouble();
  const before = structuredClone(run);
  await saveGitHubAssociationMutation({ store, transaction, before, candidate: associate(run) });

  const moved = await base.load(run.id);
  moved.title = "changed by another writer";
  await base.save(moved);

  await assert.rejects(rollbacks[0]!(), /changed before association rollback/);
  assert.deepEqual(
    (await base.load(run.id)).github,
    ASSOCIATION,
    "a refused compensation must leave the run untouched",
  );
});

test("saveGitHubAssociationMutation compensation refuses when a newer version is on disk", async () => {
  const { store, base, run } = await harness();
  const { transaction, rollbacks } = transactionDouble();
  const before = structuredClone(run);
  await saveGitHubAssociationMutation({ store, transaction, before, candidate: associate(run) });

  const moved = await base.load(run.id);
  moved.github = { ...ASSOCIATION, headSha: "head-sha-3" };
  await base.save(moved);

  await assert.rejects(rollbacks[0]!(), /changed before association rollback/);
  assert.equal((await base.load(run.id)).github?.headSha, "head-sha-3");
});
