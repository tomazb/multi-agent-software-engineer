import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { WORKFLOW_STATES, type RunRecord, type RunTerminalCleanup } from "../src/domain.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";

const AT = "2026-08-24T12:00:00.000Z";
const TERMINAL_STATES = ["COMPLETED", "FAILED", "CANCELLED"] as const;

const LEGAL_FORMS: RunTerminalCleanup[] = [
  { status: "pending", updatedAt: AT },
  { status: "complete", updatedAt: AT },
  {
    status: "preserved",
    updatedAt: AT,
    preservationReason: "bootstrap-recovery",
  },
  {
    status: "failed",
    updatedAt: AT,
    lastError: {
      code: "cleanup-remove-failed",
      message: "exact worktree remained registered",
    },
  },
];

const ILLEGAL_FORMS: Array<Partial<RunTerminalCleanup> & { status: RunTerminalCleanup["status"] }> = [
  { status: "pending", updatedAt: AT, preservationReason: "bootstrap-recovery" },
  {
    status: "complete",
    updatedAt: AT,
    lastError: { code: "cleanup-remove-failed", message: "x" },
  },
  { status: "preserved", updatedAt: AT },
  {
    status: "preserved",
    updatedAt: AT,
    preservationReason: "bootstrap-recovery",
    lastError: { code: "cleanup-remove-failed", message: "x" },
  },
  { status: "failed", updatedAt: AT },
  {
    status: "failed",
    updatedAt: AT,
    preservationReason: "revalidation-recovery",
    lastError: { code: "cleanup-remove-failed", message: "x" },
  },
];

async function fixture(t: test.TestContext): Promise<{
  store: FileRunStore;
  raw: RunRecord;
  publish: (candidate: RunRecord) => Promise<void>;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-terminal-cleanup-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("terminal cleanup", "validate at load", DEFAULT_CONFIG);
  const runPath = path.join(store.root, run.id, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  return {
    store,
    raw,
    publish: (candidate) => writeFile(runPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8"),
  };
}

test("historical schema-v1 terminal records may omit terminalCleanup", async (t) => {
  const { store, raw, publish } = await fixture(t);
  for (const state of TERMINAL_STATES) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    delete candidate.terminalCleanup;
    await publish(candidate);
    const loaded = await store.load(candidate.id);
    assert.equal(loaded.state, state);
    assert.equal(loaded.terminalCleanup, undefined);
    assert.doesNotThrow(() => migrateRunRecord(candidate));
  }
});

test("migration accepts all four legal terminalCleanup forms on terminal states", async (t) => {
  const { store, raw, publish } = await fixture(t);
  for (const terminalCleanup of LEGAL_FORMS) {
    for (const state of TERMINAL_STATES) {
      const candidate = structuredClone(raw);
      candidate.state = state;
      candidate.terminalCleanup = structuredClone(terminalCleanup);
      await publish(candidate);
      const loaded = await store.load(candidate.id);
      assert.deepEqual(loaded.terminalCleanup, terminalCleanup);
      assert.doesNotThrow(() => migrateRunRecord(loaded));
    }
  }
});

test("migration rejects illegal terminalCleanup field combinations", async (t) => {
  const { store, raw, publish } = await fixture(t);
  for (const terminalCleanup of ILLEGAL_FORMS) {
    const candidate = structuredClone(raw);
    candidate.state = "COMPLETED";
    candidate.terminalCleanup = terminalCleanup as RunTerminalCleanup;
    await publish(candidate);
    await assert.rejects(store.load(candidate.id), /terminalCleanup|preservationReason|lastError/i);
    assert.throws(() => migrateRunRecord(candidate), /terminalCleanup|preservationReason|lastError/i);
  }
});

test("migration rejects terminalCleanup on nonterminal workflow states", async (t) => {
  const { store, raw, publish } = await fixture(t);
  const nonterminal = WORKFLOW_STATES.filter(
    (state) => !TERMINAL_STATES.includes(state as (typeof TERMINAL_STATES)[number]),
  );
  for (const state of nonterminal) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    candidate.terminalCleanup = { status: "pending", updatedAt: AT };
    await publish(candidate);
    await assert.rejects(
      store.load(candidate.id),
      /terminalCleanup requires a terminal workflow state/i,
    );
    assert.throws(
      () => migrateRunRecord(candidate),
      /terminalCleanup requires a terminal workflow state/i,
    );
  }
});
