# Issue #30 Terminal Cleanup Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MASWE production terminal-worktree cleanup durably observable, independently retryable, idempotent, and fail-closed without weakening Issue #28 recovery retention or workflow authority.

**Architecture:** Persist a separate `terminalCleanup` lifecycle in schema-v1 run records, but treat it as observability rather than deletion authority. A single exact-worktree reconciler in `src/git-workspace.ts` proves repository/path/branch/HEAD/type ownership before removal and re-inspects after every removal attempt. The orchestrator publishes cleanup intent atomically with terminal workflow events. Cleanup uses a `terminal-cleanup` claim, while retry/supersede predecessor decisions use a distinct `terminal-recovery` claim in the same `.mutation-journal-v1/`; no code path may recursively acquire that journal. Automatic cleanup and `maswe cleanup` share one reconciler.

**Tech Stack:** TypeScript 7, Node.js standard library, Node test runner, JSON Schema, Git worktrees, MASWE durable file/lock journals.

**Spec:** `docs/superpowers/specs/2026-08-24-issue-30-terminal-cleanup-recovery-design.md`

## Global Constraints

- Historical source baseline: `main@71252f0b996143085778d9fb64b22d8a90ed0fd1`.
- Approved design commit: `8c7799923b1d82ffd1d7ca461d3b14ae4f64f998`.
- Execute from `issue-30-terminal-cleanup-recovery` after creating an isolated worktree with `superpowers:using-git-worktrees`; do not implement from the operator checkout.
- Before code changes, verify the non-documentation tree matches the approved design commit.
- Canonical Node: exact `24.18.0`; blocking compatibility floor: exact `22.22.2`.
- Supported engine remains `>=22.22.2 <23 || >=24.18.0 <25`.
- Keep `RunRecord.schemaVersion === 1` and add no npm dependencies.
- Persist workflow terminal state plus cleanup disposition before destructive cleanup.
- Cleanup never appends a workflow event and never rewrites `run.failure`.
- Never delete the MASWE run branch in production terminal cleanup.
- Never use recursive filesystem deletion as a production fallback for an unregistered path.
- Never use unconstrained `git worktree prune` in production cleanup.
- Never add `cleanup --force` or another ownership/preservation bypass.
- Preserve SHA-bound quality, verification, merge-ready, and GitHub evidence.
- Preserve Issue #28 bootstrap, revalidation, retry, and publication-outcome-unknown semantics.
- Keep production cleanup tests separate from Issue #18 authenticated-smoke fixture cleanup.
- Every behavior change follows RED → GREEN → focused regression verification.
- Local commits are task checkpoints only. Do not push, open a PR, merge, delete remote branches, or alter Issue #27/#30 state without separate owner authorization.

---

### Task 1: Add the durable cleanup domain, migration, and schema contract

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/store.ts`
- Modify: `src/run-record-validation.ts`
- Modify: `schemas/run-record.schema.json`
- Create: `test/issue30-terminal-cleanup-state.test.ts`
- Modify: `test/schema.test.ts`

**Interfaces:**

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

- [ ] **Step 1: Write failing run-record tests**

Create `test/issue30-terminal-cleanup-state.test.ts`. Start from real `FileRunStore.create()` fixtures, then assert migration accepts all four legal forms and historical schema-v1 terminal records with no field.

Legal examples:

```ts
{ status: "pending", updatedAt: "2026-08-24T12:00:00.000Z" }
{ status: "complete", updatedAt: "2026-08-24T12:00:00.000Z" }
{
  status: "preserved",
  updatedAt: "2026-08-24T12:00:00.000Z",
  preservationReason: "bootstrap-recovery",
}
{
  status: "failed",
  updatedAt: "2026-08-24T12:00:00.000Z",
  lastError: {
    code: "cleanup-remove-failed",
    message: "exact worktree remained registered",
  },
}
```

Reject these combinations:

```ts
[
  { status: "pending", preservationReason: "bootstrap-recovery" },
  { status: "complete", lastError: { code: "cleanup-remove-failed", message: "x" } },
  { status: "preserved" },
  {
    status: "preserved",
    preservationReason: "bootstrap-recovery",
    lastError: { code: "cleanup-remove-failed", message: "x" },
  },
  { status: "failed" },
  {
    status: "failed",
    preservationReason: "revalidation-recovery",
    lastError: { code: "cleanup-remove-failed", message: "x" },
  },
]
```

Also prove any `terminalCleanup` field on a nonterminal state such as `PR_READY` fails migration.

- [ ] **Step 2: Extend the schema-test evaluator explicitly and verify RED**

`test/schema.test.ts` currently supports `if`/`then` but not `not`. Extend its local `JsonSchema` type with:

```ts
not?: JsonSchema;
```

In `assertMatches()`, add:

```ts
if (effective.not) {
  let forbiddenMatches = true;
  try {
    assertMatches(root, effective.not, value, `${label}.not`);
  } catch {
    forbiddenMatches = false;
  }
  assert.equal(forbiddenMatches, false, `${label} not`);
}
```

Use `not: { required: [...] }` in the run-record schema to prohibit `lastError`/`preservationReason` for statuses where they are illegal. Add schema cases matching the runtime migration cases.

Run:

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-state.test.ts \
  test/schema.test.ts
```

Expected: FAIL because the domain/migration/schema field does not exist.

- [ ] **Step 3: Implement exact domain and runtime validation**

In `src/store.ts`:

- add `"terminalCleanup"` to `RUN_RECORD_FIELDS`;
- keep historical omission valid;
- sanitize `terminalCleanup.lastError.message` independently with `sanitizeDiagnostic(message, FAILURE_AGGREGATE_MAX_CODE_POINTS).text`.

In `src/run-record-validation.ts`, implement `validateTerminalCleanup()` with `exactObject()`, canonical timestamp validation, exact enums, and the status-specific field rules. After constructing the run, enforce:

```ts
if (
  run.terminalCleanup &&
  !["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)
) {
  throw new Error("Run record terminalCleanup requires a terminal workflow state");
}
```

Mirror the same contract in `schemas/run-record.schema.json` with `additionalProperties: false`, exact enums, canonical timestamp pattern, and `allOf`/`if`/`then`/`not` constraints.

- [ ] **Step 4: Verify GREEN**

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-state.test.ts \
  test/schema.test.ts
npm run _typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add \
  src/domain.ts \
  src/store.ts \
  src/run-record-validation.ts \
  schemas/run-record.schema.json \
  test/issue30-terminal-cleanup-state.test.ts \
  test/schema.test.ts
git commit -m "feat: persist terminal cleanup lifecycle"
```

---

### Task 2: Build the exact physical worktree reconciler

**Files:**
- Modify: `src/git-workspace.ts`
- Create: `test/issue30-terminal-worktree-reconcile.test.ts`
- Regression: `test/failed-run-provenance.test.ts`

**Interfaces:**

```ts
export class TerminalCleanupError extends Error {
  readonly code: TerminalCleanupFailureCode;
}

export type TerminalCleanupPathState = "absent" | "directory" | "unsafe";

export interface TerminalCleanupDependencies {
  listRegistrations(repositoryPath: string): Promise<GitWorktreeRegistration[]>;
  inspectPath(candidatePath: string): Promise<TerminalCleanupPathState>;
  removeWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export function reconcileTerminalWorktreeCleanup(
  run: RunRecord,
  invocationRepositoryPath: string,
  dependencies?: Partial<TerminalCleanupDependencies>,
): Promise<void>;
```

- [ ] **Step 1: Write failing deterministic reconciliation tests**

Create a terminal isolated-worktree fixture whose branch is exactly `maswe/${run.id}` and whose path is exactly `externalWorktreePath(cwd, run.id)`. Inject `TerminalCleanupDependencies` to cover:

1. exact registration + directory → remove → absent/absent success;
2. absent registration + absent path → idempotent success without remove;
3. non-zero remove + absent/absent post-state → success;
4. non-zero remove + exact registration/directory remains → `cleanup-remove-failed`;
5. registration remains + path absent after attempt → `cleanup-postcondition-failed`;
6. unregistered present directory → `cleanup-ownership-mismatch`, no remove;
7. unsafe/symlink path → `cleanup-ownership-mismatch`;
8. branch mismatch;
9. HEAD mismatch;
10. expected branch registered at another path;
11. malformed/conflicting registration inspection → `cleanup-inspection-failed`;
12. operator checkout target rejected;
13. invocation repository root different from `run.repositoryPath` rejected;
14. successful cleanup leaves branch ref untouched.

Run:

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-worktree-reconcile.test.ts
```

Expected: FAIL because the reconciler does not exist.

- [ ] **Step 2: Implement safe path inspection and ownership preflight**

Production `inspectPath()` uses `lstat()`:

```ts
async function inspectTerminalCleanupPath(
  candidatePath: string,
): Promise<TerminalCleanupPathState> {
  try {
    const stat = await lstat(candidatePath);
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? "directory"
      : "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}
```

Before destructive work, require all of:

```ts
path.resolve(invocationRepositoryPath) === path.resolve(run.repositoryPath)
path.resolve(run.workspace!.worktreePath!) ===
  path.resolve(externalWorktreePath(run.repositoryPath, run.id))
path.resolve(run.workspace!.worktreePath!) !== path.resolve(run.repositoryPath)
run.workspace!.branch === `maswe/${run.id}`
```

Parse the complete registration set through `listGitWorktreeRegistrations()`. Reject target path, expected branch, or HEAD conflicts.

- [ ] **Step 3: Implement removal and authoritative post-inspection**

Only after ownership proof call exact:

```text
git worktree remove --force <recorded-worktree-path>
```

After every attempted remove, regardless of exit code, re-read registrations and path state.

Classification:

```text
registration absent + path absent -> success
exact registration + directory remains after non-zero remove -> cleanup-remove-failed
registration remains + path absent -> cleanup-postcondition-failed
changed/conflicting ownership or unsafe path -> cleanup-ownership-mismatch
inspection failure -> cleanup-inspection-failed
```

Do not use recursive `rm` or `git worktree prune` from this production reconciler.

- [ ] **Step 4: Verify GREEN + provenance regression**

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-worktree-reconcile.test.ts \
  test/failed-run-provenance.test.ts
npm run _typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add src/git-workspace.ts test/issue30-terminal-worktree-reconcile.test.ts
git commit -m "feat: reconcile terminal worktree cleanup exactly"
```

---

### Task 3: Publish cleanup intent atomically with terminal events

**Files:**
- Modify: `src/orchestrator.ts`
- Create: `test/issue30-terminal-publication.test.ts`
- Regression: `test/orchestrator.test.ts`
- Regression: `test/issue28-retry-publication.test.ts`

**Interfaces:**
- Internal `terminalCleanupIntent(run, preservationReason?)`.
- `failRun()` accepts `preservationReason?: TerminalCleanupPreservationReason` instead of boolean preservation flags.
- Cleanup metadata is already present on the candidate passed to `store.applyEvent()` for `COMPLETE`, `CANCEL`, and `FAIL`.

- [ ] **Step 1: Write failing atomic-publication tests**

Model the store wrapper after `RetryInjectionStore` in `test/issue28-retry-publication.test.ts`; intercept `applyEvent()` and inspect its input candidate before delegating.

Cover:

- isolated `COMPLETE` → `pending` before event persistence;
- isolated `CANCEL` → `pending` before event persistence;
- ordinary isolated `FAIL` → `pending` before event persistence;
- non-isolated or terminal path with no managed worktree → `complete`;
- bootstrap recovery **after a managed isolated-worktree checkpoint exists** → `preserved/bootstrap-recovery`;
- bootstrap failure before any managed worktree exists → `complete`;
- active/recoverable revalidation failure with retained managed worktree → `preserved/revalidation-recovery`;
- mutable-role publication outcome unknown → `preserved/publication-outcome-unknown`.

Run:

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-publication.test.ts
```

Expected: FAIL because cleanup intent is not part of terminal publication.

- [ ] **Step 2: Implement typed terminal intent**

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

Set the field on the candidate before `applyEvent()` for every terminal event. Map the existing preservation sites explicitly:

```ts
{ preservationReason: "bootstrap-recovery" }
{ preservationReason: "revalidation-recovery" }
{ preservationReason: "publication-outcome-unknown" }
```

Never infer a reason from error-message prose.

- [ ] **Step 3: Verify GREEN + Issue #28 regressions**

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-publication.test.ts \
  test/issue28-retry-publication.test.ts \
  test/orchestrator.test.ts
npm run _typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit checkpoint**

```bash
git add src/orchestrator.ts test/issue30-terminal-publication.test.ts
git commit -m "feat: persist terminal cleanup intent with terminal state"
```

---

### Task 4: Add shared automatic/manual cleanup and durable failure publication

**Files:**
- Modify: `src/run-mutation.ts`
- Modify: `src/orchestrator.ts`
- Modify: `test/run-mutation.test.ts`
- Create: `test/issue30-terminal-cleanup-orchestrator.test.ts`

**Interfaces:**

```ts
export type RunMutationRole =
  | "target"
  | "publication"
  | "terminal-cleanup"
  | "terminal-recovery";
```

Exact operation mapping:

```ts
const operationByRole = {
  target: "run-target-mutation",
  publication: "run-publication",
  "terminal-cleanup": "run-terminal-cleanup",
  "terminal-recovery": "run-terminal-recovery",
} as const;
```

`terminal-cleanup` is used only for physical cleanup/reconciliation. `terminal-recovery` is reserved for Task 5 retry/supersede predecessor decisions. `assertNoQueuedTargetMutation()` continues to treat only `run-target-mutation` as a target successor.

Produces public:

```ts
cleanupTerminal(runId: string): Promise<RunRecord>
```

- [ ] **Step 1: Write mutation-role RED tests**

Extend `test/run-mutation.test.ts` to acquire both new roles and assert their exact durable claim operations:

```ts
assert.equal(cleanupClaim.operation, "run-terminal-cleanup");
assert.equal(recoveryClaim.operation, "run-terminal-recovery");
```

Run:

```bash
node --experimental-strip-types --test test/run-mutation.test.ts
```

Expected: FAIL because the roles are unknown.

- [ ] **Step 2: Implement explicit role mapping**

Replace the current two-way ternary in `src/run-mutation.ts` with `operationByRole[role]`. Preserve all existing FIFO/recovery/release behavior.

- [ ] **Step 3: Write automatic/manual cleanup RED tests**

Create `test/issue30-terminal-cleanup-orchestrator.test.ts` with a real isolated Git repository and a deterministic `OrchestratorOptions.terminalCleanupDependencies?: Partial<TerminalCleanupDependencies>` seam.

Cover:

- automatic successful completion → `COMPLETED` + `terminalCleanup.complete`;
- injected completion cleanup failure → operation rejects, authoritative run stays `COMPLETED`, cleanup becomes `failed`, `run.failure` stays absent;
- equivalent behavior for `CANCELLED`;
- ordinary `FAILED` cleanup failure preserves the original engineering `run.failure` exactly;
- cleanup never changes quality/verification/mergeReady/GitHub evidence;
- physical success followed by cleanup-state publication failure is later reconciled to `complete`.

- [ ] **Step 4: Implement one shared cleanup path**

Add a private helper equivalent to:

```ts
private async reconcileTerminalCleanup(
  runId: string,
  options: { allowLegacy: boolean },
): Promise<RunRecord>
```

It must acquire `terminal-cleanup`, reload the authoritative run inside the claim, then:

1. reject nonterminal state;
2. return unchanged for explicit `complete`;
3. reject explicit `preserved`;
4. call `reconcileTerminalWorktreeCleanup()` for explicit `pending`/`failed`;
5. on success, save `{ status: "complete", updatedAt }` without a workflow event;
6. on `TerminalCleanupError`, save `{ status: "failed", updatedAt, lastError: { code, sanitized message } }` and rethrow;
7. if cleanup and failure-state persistence both fail, throw `AggregateError([cleanupError, persistenceError], ...)`.

`finalizeTerminal()` and public `cleanupTerminal()` must route through this same helper. `finalizeTerminal()` skips explicit `preserved` and returns explicit `complete` directly.

- [ ] **Step 5: Verify GREEN**

```bash
node --experimental-strip-types --test \
  test/run-mutation.test.ts \
  test/issue30-terminal-cleanup-orchestrator.test.ts \
  test/orchestrator.test.ts
npm run _typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add \
  src/run-mutation.ts \
  src/orchestrator.ts \
  test/run-mutation.test.ts \
  test/issue30-terminal-cleanup-orchestrator.test.ts
git commit -m "feat: make terminal cleanup retryable and durable"
```

---

### Task 5: Handle legacy records and serialize cleanup with retry/supersede

**Files:**
- Modify: `src/orchestrator.ts`
- Create: `test/issue30-terminal-cleanup-legacy.test.ts`
- Create: `test/issue30-terminal-cleanup-concurrency.test.ts`
- Regression: `test/issue28-retry-publication.test.ts`
- Regression: `test/failed-run-provenance.test.ts`

**Interfaces:**
- `cleanupTerminal()` may classify legacy records only inside its `terminal-cleanup` claim.
- Retry and supersede predecessor decisions acquire `terminal-recovery`.
- No code path may hold `terminal-recovery` while acquiring `terminal-cleanup`, `target`, or `publication` on the same run.
- No code path may hold `terminal-cleanup` while acquiring another role on the same run.
- Successful `RETRY_FROM_FAILED` deletes `terminalCleanup` from the candidate before the retry event is published.

- [ ] **Step 1: Write legacy RED tests**

Cover:

```text
legacy COMPLETED/CANCELLED + no managed target -> publish complete
legacy COMPLETED/CANCELLED + registration/path absent -> publish complete
legacy COMPLETED/CANCELLED + exact surviving owned worktree -> reconcile then complete
legacy FAILED + workspaceBootstrap recovery -> preserved/bootstrap-recovery and cleanup rejects
legacy FAILED + revalidation recovery -> preserved/revalidation-recovery and cleanup rejects
legacy FAILED + exact surviving worktree but no structural preservation proof -> failed/cleanup-legacy-state-ambiguous and cleanup rejects
legacy FAILED + registration/path absent -> publish complete
```

Do not match failure-message prose.

Run:

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-legacy.test.ts
```

Expected: FAIL until legacy classification exists.

- [ ] **Step 2: Implement conservative legacy classification**

Inside the `terminal-cleanup` claim, when `authoritative.terminalCleanup === undefined`:

```ts
if (!authoritative.workspace?.worktreePath) {
  // complete
} else if (authoritative.state === "FAILED" && authoritative.workspaceBootstrap) {
  // preserved/bootstrap-recovery, then reject manual cleanup
} else if (authoritative.state === "FAILED" && authoritative.revalidation) {
  // preserved/revalidation-recovery, then reject manual cleanup
} else {
  // inspect exact registration/path
  // COMPLETED/CANCELLED: normal adoption/reconciliation
  // FAILED + surviving target without structural proof: cleanup-legacy-state-ambiguous
  // absent registration+path: complete
}
```

Never synthesize `publication-outcome-unknown` for legacy records.

- [ ] **Step 3: Write deterministic concurrency RED tests**

Create promise/barrier-controlled tests for:

```text
cleanup wins -> cleanup releases terminal-cleanup; retry later acquires terminal-recovery, sees complete, reconstructs through existing retry reconciliation
retry wins -> retry under terminal-recovery publishes nonterminal state with terminalCleanup absent; queued cleanup later reloads and rejects nonterminal
supersede wins -> terminal-recovery serializes predecessor abandon; after release, predecessor cleanup may acquire terminal-cleanup
publication vs cleanup -> one FIFO journal owner at a time; no overlap
```

Also assert no duplicate `RETRY_FROM_FAILED`, no cleanup workflow event, and no cross-run deletion.

- [ ] **Step 4: Refactor retry using exact `terminal-recovery` boundaries**

If retry first needs Issue #28 revalidation target reconciliation, finish that existing target operation **before** acquiring `terminal-recovery`.

Then:

1. acquire `terminal-recovery`;
2. reload authoritative FAILED run;
3. re-check retryability and cleanup disposition;
4. reconcile/recreate the exact workspace through existing retry recovery;
5. build the one `RETRY_FROM_FAILED` candidate;
6. `delete candidate.terminalCleanup` before `store.applyEvent()`;
7. publish exactly one retry event;
8. release `terminal-recovery`;
9. only then call later automatic workflow execution that may acquire `publication`/`target`.

Do not call `withRunMutationFence()` recursively while the terminal-recovery claim is held.

- [ ] **Step 5: Refactor supersede using exact `terminal-recovery` boundaries**

For a preserved FAILED predecessor:

1. acquire predecessor `terminal-recovery`;
2. reload and confirm the predecessor is still the exact preserved run being abandoned;
3. convert preserved cleanup intent to ordinary cleanup eligibility as part of the explicit supersede decision and persist/transition according to existing supersede semantics;
4. release `terminal-recovery`;
5. invoke shared predecessor cleanup, which independently acquires `terminal-cleanup`;
6. only after that continue replacement bootstrap/execution.

Never hold `terminal-recovery` while calling shared cleanup.

- [ ] **Step 6: Verify GREEN + Issue #28 regressions**

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-legacy.test.ts \
  test/issue30-terminal-cleanup-concurrency.test.ts \
  test/issue28-retry-publication.test.ts \
  test/failed-run-provenance.test.ts
npm run _typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint**

```bash
git add \
  src/orchestrator.ts \
  test/issue30-terminal-cleanup-legacy.test.ts \
  test/issue30-terminal-cleanup-concurrency.test.ts \
  test/issue28-retry-publication.test.ts \
  test/failed-run-provenance.test.ts
git commit -m "fix: serialize terminal cleanup with retry and supersede"
```

---

### Task 6: Add CLI recovery and independent cleanup rendering

**Files:**
- Modify: `src/cli-args.ts`
- Modify: `src/cli-runner.ts`
- Modify: `src/run-rendering.ts`
- Modify: `test/issue29-cli-args.test.ts`
- Create: `test/issue30-cleanup-cli.test.ts`
- Create: `test/issue30-cleanup-rendering.test.ts`

- [ ] **Step 1: Write CLI grammar RED tests**

Add to documented command cases:

```ts
["cleanup", ["cleanup", "run-1"]]
```

Reject:

```ts
["cleanup missing run ID", ["cleanup"]]
["cleanup extra operand", ["cleanup", "r1", "r2"]]
["cleanup force forbidden", ["cleanup", "r1", "--force"]]
["cleanup json forbidden", ["cleanup", "r1", "--json"]]
```

Run:

```bash
node --experimental-strip-types --test test/issue29-cli-args.test.ts
```

Expected: FAIL because `cleanup` is unknown.

- [ ] **Step 2: Implement strict parser and dispatch**

Add:

```ts
cleanup: { minPositionals: 1, maxPositionals: 1, options: [] },
```

Add usage:

```text
maswe cleanup <run-id>
```

Dispatch through `orchestratorForRun()`:

```ts
case "cleanup": {
  const runId = values[0]!;
  const { orchestrator } = await orchestratorForRun(cwd, store, runId);
  console.log(renderRun(await orchestrator.cleanupTerminal(runId)));
  return;
}
```

Do not add cleanup to `PROJECT_CONFIG_COMMANDS`.

- [ ] **Step 3: Write rendering + snapshotted-config tests**

Require human output:

```text
Terminal cleanup: complete
Terminal cleanup: failed (cleanup-remove-failed): <sanitized message>
Terminal cleanup: preserved (publication-outcome-unknown)
Terminal cleanup: unknown (legacy record)
```

`test/issue30-cleanup-cli.test.ts` must create a persisted run snapshot, corrupt current project config/environment afterward, invoke cleanup, and prove existing-run snapshot semantics are retained.

- [ ] **Step 4: Implement independent rendering**

Add a focused `renderTerminalCleanup(run)` that returns no line for nonterminal runs, renders legacy terminal omission as `unknown (legacy record)`, sanitizes `failed` diagnostic text, and remains independent from `run.failure` rendering.

- [ ] **Step 5: Verify GREEN**

```bash
node --experimental-strip-types --test \
  test/issue29-cli-args.test.ts \
  test/issue30-cleanup-cli.test.ts \
  test/issue30-cleanup-rendering.test.ts
npm run _typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add \
  src/cli-args.ts \
  src/cli-runner.ts \
  src/run-rendering.ts \
  test/issue29-cli-args.test.ts \
  test/issue30-cleanup-cli.test.ts \
  test/issue30-cleanup-rendering.test.ts
git commit -m "feat: expose terminal cleanup recovery in cli"
```

---

### Task 7: Prove bounded resources and align documentation

**Files:**
- Create: `test/issue30-terminal-cleanup-resources.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md`
- Modify: `docs/PRD.md` only if current wording contradicts the new lifecycle
- Modify: `docs/ROADMAP.md` only if current Issue #27/#30 status wording needs alignment
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the AC-30.17 resource test**

Create a real Git repository and snapshot both:

```ts
const beforeRegistrations = await listGitWorktreeRegistrations(cwd);
const managedRoot = path.dirname(externalWorktreePath(cwd, "probe-id"));
const beforeEntries = await readdir(managedRoot).catch(
  (error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? [] : Promise.reject(error),
);
```

Run at least 20 sequential isolated-worktree runs with mock runtime, disabled approval gates, and empty quality commands. Terminalize each with successful cleanup and assert each recorded managed path is absent immediately afterward.

Finally assert registration set and managed-root directory entries equal the pre-test baseline. If the test also creates explicit `preserved` recovery fixtures, compute their exact path/registration set first and assert that set is the only allowed residual delta.

- [ ] **Step 2: Run the resource test**

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-resources.test.ts
```

Expected after Tasks 1–6: PASS. A leak is a correctness defect; repair it before documentation updates.

- [ ] **Step 3: Update architecture/artifact contracts**

Document explicitly:

```text
terminal workflow state is durable before deletion
terminalCleanup is separate operational lifecycle metadata
pending/failed is retryable through maswe cleanup
preserved retains governed Issue #28 recovery state and rejects cleanup
cleanup adds no workflow events and changes no workflow evidence
production cleanup retains the branch
ownership is re-proved from exact repository/path/registration/branch/HEAD/type
legacy omitted cleanup state is unknown until reconciled
```

`docs/ARTIFACT_CONTRACTS.md` must document the optional schema-v1 object and legacy omission semantics.

- [ ] **Step 4: Update operations/changelog**

Document:

```text
maswe status <run-id>
maswe cleanup <run-id>
```

Explain workflow failure vs cleanup failure, retryable statuses, preserved rejection, absence of `--force`, branch retention, and why manual `rm -rf`/branch deletion/global prune are not supported recovery procedures.

Add Issue #30 to `CHANGELOG.md` without claiming merge. Touch PRD/ROADMAP only if current text needs correction.

- [ ] **Step 5: Verify and commit**

```bash
node --experimental-strip-types --test \
  test/issue30-terminal-cleanup-resources.test.ts
git diff --check
```

Then:

```bash
git add \
  test/issue30-terminal-cleanup-resources.test.ts \
  docs/ARCHITECTURE.md \
  docs/OPERATIONS.md \
  docs/ARTIFACT_CONTRACTS.md \
  CHANGELOG.md
```

Add `docs/PRD.md` / `docs/ROADMAP.md` only if actually changed, then:

```bash
git commit -m "docs: document terminal cleanup recovery"
```

---

### Task 8: Run the complete dual-Node acceptance matrix

**Files:**
- No intended source changes. Repair validation defects in the task that owns them.

- [ ] **Step 1: Verify scope**

```bash
git status --short
git diff --stat 8c7799923b1d82ffd1d7ca461d3b14ae4f64f998...HEAD
git diff --name-only 8c7799923b1d82ffd1d7ca461d3b14ae4f64f998...HEAD
```

Expected: Issue #30 implementation/tests/docs plus approved spec/plan history only; no dependencies, workflows, Issue #18, GitHub Phase B, #34, or multi-harness changes.

- [ ] **Step 2: Run focused Issue #30 suite under exact Node 24.18.0**

Record:

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
```

Then:

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

- [ ] **Step 4: Run full compatibility gates under exact Node 22.22.2**

Record the same runtime identity fields, then:

```bash
npm ci
npm run check
npm run pack:dry
git diff --check
```

Expected: all exit 0.

- [ ] **Step 5: Map every acceptance criterion to evidence**

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

If any criterion lacks passing test/direct inspection evidence, add it in the owning task rather than substituting prose.

- [ ] **Step 6: Prepare the external-review handoff without remote mutation**

Capture the exact implementation head with:

```bash
IMPLEMENTATION_HEAD="$(git rev-parse HEAD)"
printf 'IMPLEMENTATION_HEAD=%s\n' "$IMPLEMENTATION_HEAD"
```

Copy the emitted 40-character SHA into the report. Include:

```text
BASE_SHA=71252f0b996143085778d9fb64b22d8a90ed0fd1
DESIGN_SHA=8c7799923b1d82ffd1d7ca461d3b14ae4f64f998
IMPLEMENTATION_HEAD=<copy the concrete SHA emitted by the command above into the actual report>
Node 24.18.0 focused/full/package/diff results
Node 22.22.2 full/package/diff results
changed-file list
AC-30.1..17 evidence map
known non-blocking follow-ups, if any
```

The angle-bracket line above is a report-format instruction, not a value to submit: the external agent must replace that line with the concrete emitted SHA before handing the report to the owner. Stop for owner authorization before any push/PR/review-request action.

---

## External Agent Execution Contract

1. Read the approved spec and this plan completely before editing.
2. Use an isolated Git worktree created through the Superpowers worktree workflow.
3. Execute tasks in order; do not batch unrelated work.
4. Demonstrate RED before implementation and GREEN after implementation for every behavior task.
5. Do not weaken/delete Issue #28 recovery tests to make #30 pass.
6. Do not change schema version 1.
7. Do not add dependencies, workflow files, GitHub Phase B behavior, Issue #18 smoke cleanup, #34 repository-rename behavior, or multi-harness work.
8. Treat new review findings as blocking until technically evaluated; do not silently defer correctness findings.
9. Local task commits are allowed only as plan checkpoints. No push or PR action is implied.
10. If implementation reveals a contradiction with the approved spec—especially mutation-journal nesting, legacy FAILED intent, or exact Git ownership—stop that task and report the concrete contradiction rather than inventing a new contract.
