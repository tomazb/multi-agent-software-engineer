# Issue #30 Terminal Cleanup Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MASWE production terminal-worktree cleanup durably observable, independently retryable, idempotent, and fail-closed without weakening Issue #28 recovery retention or workflow authority.

**Architecture:** Persist a separate `terminalCleanup` lifecycle in schema-v1 run records, but treat it as observability rather than deletion authority. A single exact-worktree reconciler in `src/git-workspace.ts` proves repository/path/branch/HEAD/type ownership before removal and re-inspects after every removal attempt. The orchestrator publishes cleanup intent atomically with terminal workflow events, serializes cleanup/retry/supersede through the existing `.mutation-journal-v1/`, and exposes one manual `cleanupTerminal()` path used by `maswe cleanup` and automatic terminal cleanup.

**Tech Stack:** TypeScript 7, Node.js standard library, Node test runner, JSON Schema, Git worktrees, MASWE durable file/lock journals.

**Spec:** `docs/superpowers/specs/2026-08-24-issue-30-terminal-cleanup-recovery-design.md`

## Global Constraints

- Historical source baseline is exactly `main@71252f0b996143085778d9fb64b22d8a90ed0fd1`.
- Approved design commit is exactly `8c7799923b1d82ffd1d7ca461d3b14ae4f64f998`.
- Begin execution from the current `issue-30-terminal-cleanup-recovery` branch containing the approved spec and this plan. Before code changes, verify the non-documentation tree still matches `8c7799923b1d82ffd1d7ca461d3b14ae4f64f998`.
- At execution time create an isolated worktree using `superpowers:using-git-worktrees`; do not implement from the operator checkout.
- Canonical Node baseline: exact `24.18.0`.
- Blocking compatibility floor: exact `22.22.2`.
- Supported engine range remains `>=22.22.2 <23 || >=24.18.0 <25`.
- Keep `RunRecord.schemaVersion` at `1`.
- Add no npm dependencies.
- Keep terminal workflow state authoritative before any physical worktree deletion.
- Never make cleanup a workflow event.
- Never delete the MASWE run branch as part of production terminal cleanup.
- Never use recursive filesystem deletion as a production fallback for an unregistered target path.
- Never use unconstrained `git worktree prune` in production cleanup.
- Never add `cleanup --force` or another ownership/preservation bypass.
- Preserve exact SHA-bound quality, verification, merge-ready, and GitHub evidence.
- Preserve Issue #28 bootstrap, revalidation, and publication-outcome-unknown recovery semantics.
- Separate production cleanup tests from authenticated-smoke fixture cleanup in Issue #18.
- Every behavioral task follows RED → GREEN → focused regression verification.
- Local commits are checkpoints only. Do not push, open a PR, merge, delete remote branches, or alter Issue #27/#30 state without explicit owner authorization.

---

### Task 1: Add the durable terminal-cleanup domain, migration, and schema contract

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/store.ts`
- Modify: `src/run-record-validation.ts`
- Modify: `schemas/run-record.schema.json`
- Create: `test/issue30-terminal-cleanup-state.test.ts`
- Modify: `test/schema.test.ts`

**Interfaces:**
- Produces `TerminalCleanupStatus`.
- Produces `TerminalCleanupPreservationReason`.
- Produces `TerminalCleanupFailureCode`.
- Produces `RunTerminalCleanup`.
- Adds optional `RunRecord.terminalCleanup?: RunTerminalCleanup`.
- `migrateRunRecord()` accepts historical schema-v1 records without `terminalCleanup` and exact new records with it.
- `exactRunRecord()` rejects illegal cleanup field combinations and any cleanup metadata on nonterminal runs.

- [ ] **Step 1: Write failing migration and lifecycle tests**

Create `test/issue30-terminal-cleanup-state.test.ts` using a real `FileRunStore` record as the base fixture:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";

async function makeRun(t: test.TestContext): Promise<RunRecord> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-state-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return new FileRunStore(cwd).create("cleanup state", "persist cleanup state", DEFAULT_CONFIG);
}

test("schema-v1 migration accepts exact terminal cleanup states", async (t) => {
  const run = await makeRun(t);
  run.state = "COMPLETED";
  run.terminalCleanup = {
    status: "failed",
    updatedAt: "2026-08-24T12:00:00.000Z",
    lastError: {
      code: "cleanup-remove-failed",
      message: "exact worktree remained registered",
    },
  };
  assert.deepEqual(migrateRunRecord(run).terminalCleanup, run.terminalCleanup);
});

test("legacy schema-v1 terminal records remain loadable without cleanup metadata", async (t) => {
  const run = await makeRun(t);
  run.state = "COMPLETED";
  delete run.terminalCleanup;
  assert.equal(migrateRunRecord(run).terminalCleanup, undefined);
});
```

Add table-driven rejection cases for:

```ts
[
  { status: "pending", preservationReason: "bootstrap-recovery" },
  { status: "complete", lastError: { code: "cleanup-remove-failed", message: "x" } },
  { status: "preserved" },
  { status: "preserved", preservationReason: "bootstrap-recovery", lastError: { code: "cleanup-remove-failed", message: "x" } },
  { status: "failed" },
  { status: "failed", preservationReason: "revalidation-recovery", lastError: { code: "cleanup-remove-failed", message: "x" } },
]
```

Also assert:

```ts
test("nonterminal runs reject terminalCleanup", async (t) => {
  const run = await makeRun(t);
  run.state = "PR_READY";
  run.terminalCleanup = {
    status: "complete",
    updatedAt: "2026-08-24T12:00:00.000Z",
  };
  assert.throws(() => migrateRunRecord(run), /terminalCleanup.*terminal/i);
});
```

- [ ] **Step 2: Extend schema tests and verify RED**

In `test/schema.test.ts`, extend the existing `JsonSchema` helper only if needed for the chosen conditional shape, then add a test that validates all four legal cleanup forms and rejects the illegal combinations above through both `assertMatches()` and `migrateRunRecord()`.

Run:

```bash
node --experimental-strip-types --test test/issue30-terminal-cleanup-state.test.ts test/schema.test.ts
```

Expected: FAIL because `RunRecord.terminalCleanup`, its migration, and schema shape do not exist.

- [ ] **Step 3: Add exact domain types**

Add to `src/domain.ts`:

```ts
export type TerminalCleanupStatus =
  | "pending"
  | "complete"
  | "failed"
  | "preserved";

export type TerminalCleanupPreservationReason =
  | "bootstrap-recovery"
  | "revalidation-recovery"
  | "publication-outcome-unknown";

export type TerminalCleanupFailureCode =
  | "cleanup-inspection-failed"
  | "cleanup-ownership-mismatch"
  | "cleanup-remove-failed"
  | "cleanup-postcondition-failed"
  | "cleanup-legacy-state-ambiguous";

export interface RunTerminalCleanup {
  status: TerminalCleanupStatus;
  updatedAt: string;
  preservationReason?: TerminalCleanupPreservationReason;
  lastError?: {
    code: TerminalCleanupFailureCode;
    message: string;
  };
}
```

Add `terminalCleanup?: RunTerminalCleanup` to `RunRecord`.

- [ ] **Step 4: Add exact migration, validation, and sanitization**

In `src/store.ts`:

- add `"terminalCleanup"` to `RUN_RECORD_FIELDS`;
- sanitize `terminalCleanup.lastError.message` with `sanitizeDiagnostic(message, FAILURE_AGGREGATE_MAX_CODE_POINTS).text` before persistence/load return, independently from `run.failure`;
- preserve omission for historical records.

In `src/run-record-validation.ts`, add a focused validator with this shape:

```ts
function validateTerminalCleanup(
  value: unknown,
): NonNullable<RunRecord["terminalCleanup"]> {
  // exactObject(... ["status", "updatedAt", "preservationReason", "lastError"], ["status", "updatedAt"])
  // canonical timestamp
  // exact status/reason/code enums
  // pending|complete => neither optional field
  // preserved => preservationReason required, lastError forbidden
  // failed => lastError required, preservationReason forbidden
}
```

After constructing `run` in `exactRunRecord()`, enforce:

```ts
if (run.terminalCleanup && !["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) {
  throw new Error("Run record terminalCleanup requires a terminal workflow state");
}
```

Mirror the exact shape in `schemas/run-record.schema.json` using `additionalProperties: false`, explicit enums, canonical timestamp pattern, and conditional requirements/prohibitions.

- [ ] **Step 5: Verify GREEN and commit checkpoint**

Run:

```bash
node --experimental-strip-types --test test/issue30-terminal-cleanup-state.test.ts test/schema.test.ts
npm run _typecheck
```

Expected: PASS.

After local commit authorization:

```bash
git add src/domain.ts src/store.ts src/run-record-validation.ts schemas/run-record.schema.json test/issue30-terminal-cleanup-state.test.ts test/schema.test.ts
git commit -m "feat: persist terminal cleanup lifecycle"
```

---

### Task 2: Build the exact physical worktree cleanup reconciler

**Files:**
- Modify: `src/git-workspace.ts`
- Create: `test/issue30-terminal-worktree-reconcile.test.ts`
- Regression: `test/failed-run-provenance.test.ts`

**Interfaces:**
- Produces `TerminalCleanupError extends Error` with `readonly code: TerminalCleanupFailureCode`.
- Produces `TerminalCleanupPathState = "absent" | "directory" | "unsafe"`.
- Produces `TerminalCleanupDependencies` for deterministic tests.
- Produces `reconcileTerminalWorktreeCleanup(run, invocationRepositoryPath, dependencies?)`.
- Leaves branch deletion outside this reconciler.

Define the test seam exactly:

```ts
export interface TerminalCleanupDependencies {
  listRegistrations(repositoryPath: string): Promise<GitWorktreeRegistration[]>;
  inspectPath(candidatePath: string): Promise<TerminalCleanupPathState>;
  removeWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
```

Production defaults use `listGitWorktreeRegistrations()`, `lstat()`, and `git worktree remove --force`.

- [ ] **Step 1: Write failing deterministic reconciliation tests**

Create fixtures around one terminal isolated-worktree `RunRecord` with:

```ts
const run = structuredClone(baseRun);
run.state = "COMPLETED";
run.workspace = {
  baseSha: HEAD,
  headSha: HEAD,
  branch: `maswe/${run.id}`,
  fingerprint: "f".repeat(64),
  worktreePath: externalWorktreePath(cwd, run.id),
};
```

Test the matrix with injected dependencies:

```ts
test("absent registration and absent path is idempotent success", async () => {
  await assert.doesNotReject(
    reconcileTerminalWorktreeCleanup(run, cwd, {
      listRegistrations: async () => [],
      inspectPath: async () => "absent",
      removeWorktree: async () => assert.fail("remove must not run"),
    }),
  );
});

test("unregistered present path fails closed without removal", async () => {
  await assert.rejects(
    reconcileTerminalWorktreeCleanup(run, cwd, {
      listRegistrations: async () => [],
      inspectPath: async () => "directory",
      removeWorktree: async () => assert.fail("remove must not run"),
    }),
    (error: unknown) =>
      error instanceof TerminalCleanupError &&
      error.code === "cleanup-ownership-mismatch",
  );
});
```

Also cover exact registration success, non-zero remove followed by absence, non-zero remove with exact registration/path still present, stale registration with missing directory, symlink/unsafe type, branch mismatch, HEAD mismatch, expected branch registered elsewhere, malformed registration inspection, operator checkout target, and invocation repository mismatch.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/issue30-terminal-worktree-reconcile.test.ts
```

Expected: FAIL because the reconciler and typed cleanup error do not exist.

- [ ] **Step 3: Implement ownership preflight and path inspection**

Add:

```ts
export class TerminalCleanupError extends Error {
  readonly code: TerminalCleanupFailureCode;

  constructor(
    code: TerminalCleanupFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TerminalCleanupError";
    this.code = code;
  }
}
```

Implement production `inspectPath()` with `lstat()`:

```ts
async function inspectTerminalCleanupPath(candidatePath: string): Promise<TerminalCleanupPathState> {
  try {
    const stat = await lstat(candidatePath);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}
```

Before removal, `reconcileTerminalWorktreeCleanup()` must check all of these exact identities:

```ts
path.resolve(invocationRepositoryPath) === path.resolve(run.repositoryPath)
path.resolve(run.workspace!.worktreePath!) === path.resolve(externalWorktreePath(run.repositoryPath, run.id))
path.resolve(run.workspace!.worktreePath!) !== path.resolve(run.repositoryPath)
run.workspace!.branch === `maswe/${run.id}`
```

Then inspect all registrations and reject any target/branch/HEAD conflict.

- [ ] **Step 4: Implement removal plus authoritative post-inspection**

Only when exact ownership is proven, call:

```ts
git worktree remove --force <exact-recorded-path>
```

After every attempted remove, regardless of exit code, call `listRegistrations()` and `inspectPath()` again.

Classify:

```text
registration absent + path absent -> success
exact registration + path directory after non-zero remove -> cleanup-remove-failed
registration remains + path absent -> cleanup-postcondition-failed
changed/conflicting registration or unsafe path -> cleanup-ownership-mismatch
inspection throws -> cleanup-inspection-failed
```

Do not call `rm(..., { recursive: true })` and do not call `git worktree prune` from this production path.

- [ ] **Step 5: Verify GREEN and regression safety**

```bash
node --experimental-strip-types --test test/issue30-terminal-worktree-reconcile.test.ts test/failed-run-provenance.test.ts
npm run _typecheck
```

Expected: PASS; existing retry provenance still preserves branches.

After local commit authorization:

```bash
git add src/git-workspace.ts test/issue30-terminal-worktree-reconcile.test.ts
git commit -m "feat: reconcile terminal worktree cleanup exactly"
```

---

### Task 3: Publish cleanup intent atomically with terminal workflow transitions

**Files:**
- Modify: `src/orchestrator.ts`
- Create: `test/issue30-terminal-publication.test.ts`
- Regression: `test/orchestrator.test.ts`
- Regression: `test/issue28-retry-publication.test.ts`

**Interfaces:**
- Produces internal `terminalCleanupIntent(run, preservationReason?)`.
- Replaces boolean workspace-preservation options in `failRun()` with typed `preservationReason?: TerminalCleanupPreservationReason`.
- Maps existing Issue #28 preservation sites to exact durable reasons.
- Terminal event publication receives cleanup metadata in the same candidate passed to `store.applyEvent()`.

- [ ] **Step 1: Write failing atomic-publication tests**

Use a `RunStore` wrapper modeled after `RetryInjectionStore` in `test/issue28-retry-publication.test.ts`. Intercept `applyEvent()` and assert the candidate already contains cleanup intent before delegating:

```ts
if (type === "COMPLETE") {
  assert.equal(run.terminalCleanup?.status, "pending");
}
```

Cover:

- isolated `COMPLETE` candidate contains `pending` before event persistence;
- isolated `CANCEL` candidate contains `pending` before event persistence;
- ordinary isolated `FAIL` candidate contains `pending` before event persistence;
- non-isolated terminal candidate contains `complete`;
- bootstrap recovery failure contains `preserved/bootstrap-recovery`;
- active/recoverable revalidation failure contains `preserved/revalidation-recovery`;
- mutable-role publication outcome unknown contains `preserved/publication-outcome-unknown`.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/issue30-terminal-publication.test.ts
```

Expected: FAIL because terminal event candidates do not contain cleanup metadata and `failRun()` still uses booleans.

- [ ] **Step 3: Implement typed terminal intent**

Add an internal helper equivalent to:

```ts
function terminalCleanupIntent(
  run: RunRecord,
  preservationReason?: TerminalCleanupPreservationReason,
): RunTerminalCleanup {
  const updatedAt = new Date().toISOString();
  if (!run.config.policy.useIsolatedWorktree || !run.workspace?.worktreePath) {
    return { status: "complete", updatedAt };
  }
  if (preservationReason) {
    return { status: "preserved", updatedAt, preservationReason };
  }
  return { status: "pending", updatedAt };
}
```

Change `failRun()` options to:

```ts
options: { preservationReason?: TerminalCleanupPreservationReason } = {}
```

Set `candidate.terminalCleanup = terminalCleanupIntent(candidate, options.preservationReason)` before `store.applyEvent(candidate, "FAIL", ...)`.

For `cancel()`, set cleanup intent on the loaded candidate before `CANCEL`.

For `complete()`, set cleanup intent inside the existing exact-head publication callback before `COMPLETE` so the event and cleanup intent share the same durable run publication.

- [ ] **Step 4: Map every existing preservation call site explicitly**

Replace current boolean preservation call sites with exact reasons:

```ts
{ preservationReason: "bootstrap-recovery" }
{ preservationReason: "revalidation-recovery" }
{ preservationReason: "publication-outcome-unknown" }
```

Do not infer reason from exception message text.

- [ ] **Step 5: Verify GREEN and Issue #28 regression**

```bash
node --experimental-strip-types --test test/issue30-terminal-publication.test.ts test/issue28-retry-publication.test.ts test/orchestrator.test.ts
npm run _typecheck
```

Expected: PASS.

After local commit authorization:

```bash
git add src/orchestrator.ts test/issue30-terminal-publication.test.ts
git commit -m "feat: persist terminal cleanup intent with terminal state"
```

---

### Task 4: Add shared automatic/manual cleanup execution and durable failure publication

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/run-mutation.ts`
- Modify: `test/run-mutation.test.ts`
- Create: `test/issue30-terminal-cleanup-orchestrator.test.ts`

**Interfaces:**
- `RunMutationRole` gains `"terminal-cleanup"`.
- That role publishes operation `run-terminal-cleanup` in the existing journal.
- Produces public `Orchestrator.cleanupTerminal(runId): Promise<RunRecord>`.
- Produces one private cleanup reconciler used by both `finalizeTerminal()` and `cleanupTerminal()`.
- Cleanup failure persistence uses `terminalCleanup.failed`; it never writes `run.failure`.

- [ ] **Step 1: Write failing mutation-role test**

Extend `test/run-mutation.test.ts`:

```ts
test("terminal cleanup uses the existing mutation journal with its own operation identity", async (t) => {
  // create run
  await withRunMutationFence(cwd, run.id, "terminal-cleanup", async () => undefined);
  const scan = await scanLockJournal(runMutationJournalRoot(cwd, run.id), "data");
  assert.equal(scan.claims.at(-1)?.operation, "run-terminal-cleanup");
});
```

Run:

```bash
node --experimental-strip-types --test test/run-mutation.test.ts
```

Expected: FAIL because `terminal-cleanup` is not a valid role.

- [ ] **Step 2: Extend the existing FIFO journal role mapping**

Change:

```ts
export type RunMutationRole = "target" | "publication" | "terminal-cleanup";
```

Map operations explicitly instead of the current two-way ternary:

```ts
const operationByRole = {
  target: "run-target-mutation",
  publication: "run-publication",
  "terminal-cleanup": "run-terminal-cleanup",
} as const;
```

Use `operationByRole[role]` in `publishLockClaim()`. Keep `assertNoQueuedTargetMutation()` semantics unchanged: only `run-target-mutation` is a target successor.

- [ ] **Step 3: Write failing orchestrator cleanup tests**

Create `test/issue30-terminal-cleanup-orchestrator.test.ts` with a real isolated Git repository and injectable low-level cleanup dependencies through a new `OrchestratorOptions.terminalCleanupDependencies?: Partial<TerminalCleanupDependencies>` seam.

Cover:

```ts
test("successful automatic cleanup persists complete after COMPLETED", async () => {
  // drive run to MERGE_READY; complete; reload
  assert.equal(run.state, "COMPLETED");
  assert.equal(run.terminalCleanup?.status, "complete");
});

test("cleanup failure leaves COMPLETED and persists independent cleanup error", async () => {
  // inject exact remove failure with worktree still present
  await assert.rejects(orchestrator.complete(run.id), /cleanup/i);
  const reloaded = await store.load(run.id);
  assert.equal(reloaded.state, "COMPLETED");
  assert.equal(reloaded.terminalCleanup?.status, "failed");
  assert.equal(reloaded.terminalCleanup?.lastError?.code, "cleanup-remove-failed");
  assert.equal(reloaded.failure, undefined);
});
```

Repeat equivalent assertions for ordinary `FAILED` and `CANCELLED`, including preservation of an existing engineering `run.failure` object byte-for-byte.

- [ ] **Step 4: Implement one shared cleanup path**

Add a helper with this contract:

```ts
private async reconcileTerminalCleanup(
  runId: string,
  options: { allowLegacy: boolean },
): Promise<RunRecord>
```

It must:

1. acquire `withRunMutationFence(repositoryPath, runId, "terminal-cleanup", ...)`;
2. reload the authoritative run inside the fence;
3. reject nonterminal state;
4. return unchanged on explicit `complete`;
5. reject explicit `preserved`;
6. call `reconcileTerminalWorktreeCleanup()` for `pending`/`failed`;
7. on success, save a candidate with `{ status: "complete", updatedAt }` and no workflow event;
8. on `TerminalCleanupError`, save `{ status: "failed", updatedAt, lastError: { code, sanitized message } }`, then rethrow the typed error;
9. if failure-state persistence also fails, throw `AggregateError([cleanupError, persistenceError], ...)`.

`finalizeTerminal(run)` must call this shared path for `pending`/`failed`, return explicit `complete`, and skip explicit `preserved`.

- [ ] **Step 5: Verify GREEN and commit checkpoint**

```bash
node --experimental-strip-types --test test/run-mutation.test.ts test/issue30-terminal-cleanup-orchestrator.test.ts test/orchestrator.test.ts
npm run _typecheck
```

Expected: PASS.

After local commit authorization:

```bash
git add src/run-mutation.ts src/orchestrator.ts test/run-mutation.test.ts test/issue30-terminal-cleanup-orchestrator.test.ts
git commit -m "feat: make terminal cleanup retryable and durable"
```

---

### Task 5: Implement legacy cleanup adoption and retry/supersede serialization

**Files:**
- Modify: `src/orchestrator.ts`
- Create: `test/issue30-terminal-cleanup-legacy.test.ts`
- Create: `test/issue30-terminal-cleanup-concurrency.test.ts`
- Regression: `test/issue28-retry-publication.test.ts`
- Regression: `test/failed-run-provenance.test.ts`

**Interfaces:**
- `cleanupTerminal()` handles legacy terminal records only when `allowLegacy: true`.
- Successful `RETRY_FROM_FAILED` clears `terminalCleanup` atomically with the retry event publication.
- Preserved predecessor cleanup is abandoned only through supersession.
- Retry/supersede and cleanup use the same mutation journal and never hold a claim while recursively acquiring another claim in that journal.

- [ ] **Step 1: Write failing legacy tests**

Cover exact cases:

```text
legacy COMPLETED/CANCELLED, no managed worktree -> publish complete
legacy COMPLETED/CANCELLED, registration/path absent -> publish complete
legacy COMPLETED/CANCELLED, exact surviving owned worktree -> reconcile then complete
legacy FAILED + workspaceBootstrap recovery -> publish preserved/bootstrap-recovery and reject cleanup
legacy FAILED + revalidation recovery -> publish preserved/revalidation-recovery and reject cleanup
legacy FAILED + surviving exact worktree but no structural preservation proof -> persist failed/cleanup-legacy-state-ambiguous and reject
legacy FAILED + registration/path absent -> publish complete
```

Do not use failure-message matching in the tests or implementation.

- [ ] **Step 2: Run legacy tests RED**

```bash
node --experimental-strip-types --test test/issue30-terminal-cleanup-legacy.test.ts
```

Expected: FAIL because manual legacy adoption is not implemented.

- [ ] **Step 3: Implement legacy classification inside the cleanup fence**

For `authoritative.terminalCleanup === undefined`:

```ts
if (!authoritative.workspace?.worktreePath) {
  // publish complete
} else if (authoritative.state === "FAILED" && authoritative.workspaceBootstrap) {
  // publish preserved/bootstrap-recovery, then reject cleanup
} else if (authoritative.state === "FAILED" && authoritative.revalidation) {
  // publish preserved/revalidation-recovery, then reject cleanup
} else {
  // inspect exact registration/path first
  // COMPLETED/CANCELLED => adopt normal reconciliation
  // FAILED with surviving target and no structural proof => cleanup-legacy-state-ambiguous
  // absent target+registration => complete
}
```

Never synthesize `publication-outcome-unknown` for a legacy record.

- [ ] **Step 4: Write concurrency tests before modifying retry/supersede**

Create `test/issue30-terminal-cleanup-concurrency.test.ts` using deterministic barriers/promises. Cover these orderings:

```text
cleanup wins: cleanup completes first; retry reloads complete and reconstructs through existing retry reconciliation
retry wins: retry publishes nonterminal state and clears terminalCleanup; queued cleanup reloads and rejects nonterminal
supersede wins: predecessor preservation is explicitly abandoned before cleanup; replacement proceeds without predecessor worktree race
publication versus cleanup: one journal owner at a time; cleanup cannot overlap a run publication mutation
```

Assert there is no duplicate `RETRY_FROM_FAILED`, no cleanup workflow event, and no cross-run deletion.

Run:

```bash
node --experimental-strip-types --test test/issue30-terminal-cleanup-concurrency.test.ts
```

Expected: FAIL until retry/supersede participate in the cleanup/recovery serialization contract.

- [ ] **Step 5: Refactor retry/supersede without nested-journal deadlock**

Do **not** wrap code that already acquires `.mutation-journal-v1/` in a second claim. Structure the implementation so the terminal predecessor decision is serialized, but release that claim before later `runUntilBlocked()` publication work.

For retry, the authoritative retry event candidate must contain:

```ts
delete candidate.terminalCleanup;
```

before `store.applyEvent(candidate, "RETRY_FROM_FAILED", ...)`.

If retry needs pre-existing revalidation target reconciliation, finish that existing target reconciliation first; then acquire the terminal predecessor serialization claim, reload, verify the retryable state is still authoritative, reconcile/recreate the exact workspace, publish one retry event with `terminalCleanup` absent, release the claim, and only then continue automatic workflow execution.

For supersede, when the predecessor is `FAILED` with `terminalCleanup.status === "preserved"`, the predecessor operation must serialize: reload, convert preserved intent to ordinary cleanup eligibility as part of the explicit abandon decision, persist/transition the predecessor according to existing supersede semantics, then invoke the shared cleanup reconciler after releasing any claim that would otherwise be recursively acquired.

- [ ] **Step 6: Verify concurrency + Issue #28 retry regression**

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-legacy.test.ts \
  test/issue30-terminal-cleanup-concurrency.test.ts \
  test/issue28-retry-publication.test.ts \
  test/failed-run-provenance.test.ts
npm run _typecheck
```

Expected: PASS.

After local commit authorization:

```bash
git add src/orchestrator.ts test/issue30-terminal-cleanup-legacy.test.ts test/issue30-terminal-cleanup-concurrency.test.ts test/issue28-retry-publication.test.ts test/failed-run-provenance.test.ts
git commit -m "fix: serialize terminal cleanup with retry and supersede"
```

---

### Task 6: Add the CLI command and independent cleanup rendering

**Files:**
- Modify: `src/cli-args.ts`
- Modify: `src/cli-runner.ts`
- Modify: `src/run-rendering.ts`
- Modify: `test/issue29-cli-args.test.ts`
- Create: `test/issue30-cleanup-cli.test.ts`
- Create: `test/issue30-cleanup-rendering.test.ts`

**Interfaces:**
- `MasweCommand` gains `cleanup` through `COMMAND_SPECS`.
- CLI grammar is exactly `maswe cleanup <run-id>` plus only global `--config`/`--cwd`; no command-specific options.
- `runCli()` dispatches to `orchestrator.cleanupTerminal(runId)` using existing-run snapshot semantics.
- `renderRun()` emits one `Terminal cleanup:` line for terminal records.

- [ ] **Step 1: Write CLI grammar RED tests**

Extend `documentedCommands` in `test/issue29-cli-args.test.ts`:

```ts
["cleanup", ["cleanup", "run-1"]],
```

Add invalid cases:

```ts
["cleanup missing run ID", ["cleanup"]],
["cleanup extra operand", ["cleanup", "r1", "r2"]],
["cleanup force forbidden", ["cleanup", "r1", "--force"]],
["cleanup json forbidden", ["cleanup", "r1", "--json"]],
```

Run:

```bash
node --experimental-strip-types --test test/issue29-cli-args.test.ts
```

Expected: FAIL because `cleanup` is unknown.

- [ ] **Step 2: Add strict parser and CLI dispatch**

Add to `COMMAND_SPECS`:

```ts
cleanup: { minPositionals: 1, maxPositionals: 1, options: [] },
```

Add usage line:

```text
maswe cleanup <run-id>
```

Add switch branch:

```ts
case "cleanup": {
  const runId = values[0]!;
  const { orchestrator } = await orchestratorForRun(cwd, store, runId);
  console.log(renderRun(await orchestrator.cleanupTerminal(runId)));
  return;
}
```

Do not add `cleanup` to `PROJECT_CONFIG_COMMANDS`.

- [ ] **Step 3: Write rendering and existing-config independence tests**

`test/issue30-cleanup-rendering.test.ts` must assert exact prefixes:

```ts
assert.match(renderRun(complete), /Terminal cleanup: complete/);
assert.match(renderRun(failed), /Terminal cleanup: failed \(cleanup-remove-failed\):/);
assert.match(renderRun(preserved), /Terminal cleanup: preserved \(publication-outcome-unknown\)/);
assert.match(renderRun(legacyTerminal), /Terminal cleanup: unknown \(legacy record\)/);
```

`test/issue30-cleanup-cli.test.ts` must create a persisted run snapshot, corrupt current project config/environment afterward, invoke `cleanup`, and prove it uses the run snapshot like existing `status/cancel/retry` commands.

- [ ] **Step 4: Implement independent rendering**

Add a focused renderer:

```ts
function renderTerminalCleanup(run: RunRecord): string | undefined {
  if (!["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) return undefined;
  const cleanup = run.terminalCleanup;
  if (!cleanup) return "Terminal cleanup: unknown (legacy record)";
  if (cleanup.status === "preserved") {
    return `Terminal cleanup: preserved (${cleanup.preservationReason})`;
  }
  if (cleanup.status === "failed") {
    const message = sanitizeDiagnostic(
      cleanup.lastError!.message,
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
    ).text;
    return `Terminal cleanup: failed (${cleanup.lastError!.code}): ${message}`;
  }
  return `Terminal cleanup: ${cleanup.status}`;
}
```

Insert this line independently from `run.failure` rendering.

- [ ] **Step 5: Verify GREEN and commit checkpoint**

```bash
node --experimental-strip-types --test \
  test/issue29-cli-args.test.ts \
  test/issue30-cleanup-cli.test.ts \
  test/issue30-cleanup-rendering.test.ts
npm run _typecheck
```

Expected: PASS.

After local commit authorization:

```bash
git add src/cli-args.ts src/cli-runner.ts src/run-rendering.ts test/issue29-cli-args.test.ts test/issue30-cleanup-cli.test.ts test/issue30-cleanup-rendering.test.ts
git commit -m "feat: expose terminal cleanup recovery in cli"
```

---

### Task 7: Prove bounded resources, cross-run isolation, and documentation alignment

**Files:**
- Create: `test/issue30-terminal-cleanup-resources.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md`
- Modify: `docs/PRD.md` only if its current terminal-cleanup wording requires correction
- Modify: `docs/ROADMAP.md` only if its current Issue #27/#30 status wording requires correction
- Modify: `CHANGELOG.md`

**Interfaces:**
- Adds the AC-30.17 repeated-run resource bound as executable regression evidence.
- Documents cleanup state as a lifecycle separate from workflow state/failure.
- Documents `maswe cleanup <run-id>` and preserved recovery behavior.

- [ ] **Step 1: Write the repeated-run resource test before docs**

Create a real Git repository fixture and capture baseline resources:

```ts
const beforeRegistrations = await listGitWorktreeRegistrations(cwd);
const managedRoot = path.dirname(externalWorktreePath(cwd, "probe-id"));
const beforeEntries = await readdir(managedRoot).catch(
  (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error),
);
```

Run at least 20 sequential isolated-worktree runs. Configure mock runtime, disabled approval gates, empty quality commands, drive each to a terminal state with successful cleanup, and after each run assert its `workspace.worktreePath` is absent.

At the end assert:

```ts
assert.deepEqual(
  await listGitWorktreeRegistrations(cwd),
  beforeRegistrations,
);
assert.deepEqual(
  (await readdir(managedRoot).catch(
    (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error),
  )).sort(),
  beforeEntries.sort(),
);
```

If the same test creates explicit `preserved` recovery fixtures, compute their exact expected path/registration set first and assert that it is the **only** residual delta from baseline.

- [ ] **Step 2: Run the resource test**

```bash
node --experimental-strip-types --test test/issue30-terminal-cleanup-resources.test.ts
```

Expected after Tasks 1–6: PASS. If it fails, treat the leak as a correctness bug and repair the implementation before documenting completion.

- [ ] **Step 3: Update architecture and artifact contracts**

Document these exact invariants:

```text
terminal workflow state is durable before deletion
terminalCleanup is independent operational lifecycle metadata
pending/failed cleanup is retryable through maswe cleanup
preserved means governed Issue #28 recovery retains the worktree and manual cleanup rejects
cleanup changes no workflow events/evidence
branch is retained
ownership is re-proved from exact run path + Git registration + branch + HEAD
```

`docs/ARTIFACT_CONTRACTS.md` must describe the optional schema-v1 `terminalCleanup` object and legacy omission semantics.

- [ ] **Step 4: Update operations and changelog**

Add operator commands/examples:

```text
maswe status <run-id>
maswe cleanup <run-id>
```

Describe:

- how to distinguish workflow failure from cleanup failure;
- retry behavior for `pending`/`failed`;
- why `preserved` rejects cleanup;
- why there is no `--force`;
- why manual `rm -rf`, branch deletion, and global `git worktree prune` are not recovery procedures.

Add an Issue #30 entry to `CHANGELOG.md` without claiming the PR is merged.

- [ ] **Step 5: Verify docs/resource regressions and commit checkpoint**

```bash
node --experimental-strip-types --test test/issue30-terminal-cleanup-resources.test.ts
git diff --check
```

Expected: PASS / no whitespace errors.

After local commit authorization:

```bash
git add test/issue30-terminal-cleanup-resources.test.ts docs/ARCHITECTURE.md docs/OPERATIONS.md docs/ARTIFACT_CONTRACTS.md docs/PRD.md docs/ROADMAP.md CHANGELOG.md
git commit -m "docs: document terminal cleanup recovery"
```

If `docs/PRD.md` or `docs/ROADMAP.md` did not require edits, omit them from `git add` rather than changing unrelated wording.

---

### Task 8: Run the complete acceptance matrix on both exact Node baselines

**Files:**
- No intended source changes; only repair defects discovered by validation in the task that owns them.

**Interfaces:**
- Produces final exact-head evidence for AC-30.1 through AC-30.17.
- Does not authorize push, PR creation, merge, or Issue closure.

- [ ] **Step 1: Verify repository scope before validation**

Run:

```bash
git status --short
git diff --stat 8c7799923b1d82ffd1d7ca461d3b14ae4f64f998...HEAD
git diff --name-only 8c7799923b1d82ffd1d7ca461d3b14ae4f64f998...HEAD
```

Expected: only Issue #30 implementation/tests/docs plus this plan/spec history; no dependency, workflow, GitHub Phase B, Issue #18, #34, or multi-harness scope.

- [ ] **Step 2: Run focused Issue #30 suite under Node 24.18.0**

Select exact Node `24.18.0`, record `command -v node`, `node --version`, `node -p 'process.execPath'`, and `npm --version`, then run:

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-state.test.ts \
  test/issue30-terminal-worktree-reconcile.test.ts \
  test/issue30-terminal-publication.test.ts \
  test/issue30-terminal-cleanup-orchestrator.test.ts \
  test/issue30-terminal-cleanup-legacy.test.ts \
  test/issue30-terminal-cleanup-concurrency.test.ts \
  test/issue30-cleanup-cli.test.ts \
  test/issue30-cleanup-rendering.test.ts \
  test/issue30-terminal-cleanup-resources.test.ts \
  test/run-mutation.test.ts \
  test/issue28-retry-publication.test.ts \
  test/failed-run-provenance.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run full canonical gates under Node 24.18.0**

```bash
npm ci
npm run check
npm run pack:dry
git diff --check
```

Expected: all exit 0.

- [ ] **Step 4: Run full compatibility gates under Node 22.22.2**

Select exact Node `22.22.2`, record the same runtime identity fields, then run:

```bash
npm ci
npm run check
npm run pack:dry
git diff --check
```

Expected: all exit 0.

- [ ] **Step 5: Perform acceptance-by-requirement review**

For each design criterion, point to concrete test evidence:

```text
AC-30.1  terminal event + cleanup intent atomic publication
AC-30.2  terminal state retained on cleanup failure
AC-30.3  manual retry path
AC-30.4  COMPLETED/FAILED/CANCELLED shared reconciler
AC-30.5  preserved Issue #28 worktrees reject cleanup
AC-30.6  already-absent idempotent success
AC-30.7  ownership conflicts fail closed
AC-30.8  operator/cross-run safety
AC-30.9  branch preservation
AC-30.10 evidence/failure immutability
AC-30.11 human + JSON visibility
AC-30.12 no cleanup workflow event
AC-30.13 conservative legacy behavior
AC-30.14 cleanup/retry/supersede serialization
AC-30.15 production vs smoke-fixture separation
AC-30.16 dual-Node/package/review gates
AC-30.17 >=20-run bounded-resource regression
```

If any criterion lacks a passing test or direct inspection, stop and add the missing evidence in the owning task; do not substitute prose.

- [ ] **Step 6: Prepare external review handoff without remote mutation**

Report:

```text
BASE_SHA=71252f0b996143085778d9fb64b22d8a90ed0fd1
DESIGN_SHA=8c7799923b1d82ffd1d7ca461d3b14ae4f64f998
IMPLEMENTATION_HEAD=<local exact HEAD reported by git rev-parse HEAD>
Node 24.18.0 focused/full/package/diff results
Node 22.22.2 full/package/diff results
changed-file list
AC-30.1..17 evidence map
known non-blocking follow-ups, if any
```

The executor must report the actual local `git rev-parse HEAD`; it must not fabricate a SHA in advance.

Stop here for owner authorization before push/PR/review-request actions.

---

## External Agent Execution Contract

The external implementation agent must follow these rules in addition to the task steps:

1. Read the approved spec and this plan completely before editing.
2. Use an isolated Git worktree created through the Superpowers worktree workflow.
3. Work task-by-task in order; do not batch unrelated tasks.
4. For every behavioral task, demonstrate RED before implementation and GREEN after implementation.
5. Do not weaken or delete Issue #28 recovery tests to make #30 pass.
6. Do not change `schemaVersion` from `1`.
7. Do not add dependencies, workflow files, GitHub Phase B behavior, Issue #18 smoke cleanup changes, repository-rename behavior, or multi-harness work.
8. Treat new review findings as blocking until technically evaluated; do not silently defer correctness findings.
9. Local commits may be made only at the plan checkpoints and only under the owner's existing local-commit authorization. No push or PR action is implied.
10. If the implementation reveals a conflict with the approved spec—especially around mutation-journal nesting, legacy FAILED intent, or exact Git ownership—stop that task and report the concrete contradiction instead of inventing a new contract.
