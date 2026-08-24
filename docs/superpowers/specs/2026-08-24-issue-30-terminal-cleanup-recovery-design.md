# Issue #30 Idempotent Terminal Worktree Cleanup Recovery Design

## Status

- **Issue:** #30 — Add idempotent terminal worktree cleanup recovery
- **Parent:** #27 — Correctness hardening
- **Date:** 2026-08-24
- **Exact baseline:** `main@71252f0b996143085778d9fb64b22d8a90ed0fd1`
- **Branch:** `issue-30-terminal-cleanup-recovery`
- **Predecessor:** Issue #29 / PR #38
- **Design status:** owner-approved design direction; committed specification awaiting owner review
- **Implementation authority:** none yet. This document does not authorize runtime, schema, CLI, test, or documentation implementation beyond this specification commit.

## 1. Baseline review

Issue #30 remains applicable on the post-#29 baseline.

The current terminal path has the correct safety ordering but incomplete recovery semantics:

1. `COMPLETE`, `CANCEL`, or `FAIL` is persisted first.
2. `Orchestrator.finalizeTerminal()` then calls `cleanupRunWorkspace()`.
3. `cleanupRunWorkspace()` preserves the MASWE branch and attempts `git worktree remove --force` for the recorded worktree path.
4. If cleanup fails, the caller receives an error after the workflow has already become terminal.
5. A repeated `complete` is invalid because the run is no longer `MERGE_READY`; there is no public cleanup-retry operation.
6. `RunRecord` has no cleanup lifecycle, so `status` cannot distinguish terminal-and-cleaned from terminal-with-cleanup-pending/failed.

The merged Issue #28 work adds a second constraint: **some `FAILED` runs intentionally preserve their managed worktree for recovery**. Current `failRun()` skips terminal cleanup for bootstrap recovery, active revalidation recovery, and mutable-role publication outcome-unknown cases. Therefore Issue #30 must not implement the simplistic rule `terminal => cleanup`. A cleanup operation must distinguish ordinary terminal cleanup from deliberately retained recovery state.

The current repository already provides useful primitives that should be composed rather than replaced:

- deterministic isolated worktree paths through `externalWorktreePath(repositoryPath, runId)`;
- durable run records with optimistic versioning and strict migration/validation;
- exact Git worktree registration parsing through `listGitWorktreeRegistrations()`;
- branch-preserving production cleanup behavior;
- append-only per-run mutation serialization under `.mutation-journal-v1/`;
- bounded/redacted durable diagnostics;
- centralized CLI grammar in `src/cli-args.ts`.

## 2. Objective

Make production terminal-worktree cleanup independently observable, retryable, idempotent, and fail-closed while preserving the existing rule that the workflow terminal transition is authoritative before any destructive cleanup begins.

The design must satisfy five invariants:

1. **Workflow authority and cleanup authority are separate.** A cleanup failure never rewrites `COMPLETED`, `FAILED`, or `CANCELLED` into another workflow state.
2. **Ownership is re-proved before deletion.** Persisted cleanup metadata is observability, not permission to delete a path.
3. **Issue #28 recovery retention cannot be bypassed.** A worktree preserved for governed retry/revalidation/publication recovery is not eligible for `maswe cleanup`.
4. **Cleanup is idempotently reconcilable from observable Git/filesystem state.** MASWE never invents success after an uncertain external side effect.
5. **Cleanup never becomes a workflow event.** Retrying cleanup cannot imply that engineering work, quality checks, verification, or review resolution ran again.

## 3. Approaches considered

### 3.1 Persisted lifecycle plus authoritative reconciliation — selected

Persist cleanup disposition in the run record, but require every destructive cleanup attempt to reload authoritative state and prove exact Git/filesystem ownership.

Advantages:

- restart-safe operator visibility;
- durable distinction between cleanup failure and engineering failure;
- explicit representation of Issue #28 preserved recovery worktrees;
- idempotent retry after process crash or uncertain `git worktree remove` outcome;
- no dependence on diagnostic prose to infer prior cleanup intent.

Cost: additive run-record/schema changes.

### 3.2 Purely derived cleanup state — rejected

Inspect Git/filesystem state on every `status` or cleanup operation without persisting cleanup disposition.

This cannot reliably distinguish an ordinary failed cleanup from a `FAILED` run whose worktree Issue #28 intentionally preserved. It also cannot retain bounded/redacted cleanup diagnostics across restart. Derivation remains part of the cleanup algorithm, but not the sole observability model.

### 3.3 Dedicated cleanup journal/outbox — rejected for #30

Add a new immutable journal specifically for terminal cleanup.

The physical side effect here has a strong observable postcondition: exact Git registration and exact filesystem path state. A new journal would duplicate existing run/mutation durability machinery and add operational complexity without a proportionate correctness gain. #30 reuses the existing run record and per-run mutation journal.

## 4. Durable cleanup lifecycle

### 4.1 Run-record shape

Add an optional top-level `terminalCleanup` field:

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

`terminalCleanup` is deliberately separate from `RunFailure` and `RunFailureCode`.

Validation rules are exact:

- `pending` and `complete` permit neither `preservationReason` nor `lastError`;
- `preserved` requires exactly one `preservationReason` and forbids `lastError`;
- `failed` requires `lastError` and forbids `preservationReason`;
- `updatedAt` is a canonical ISO timestamp;
- `lastError.message` is sanitized/redacted and bounded before persistence;
- unknown status/reason/code values fail closed.

No attempt counter or cleanup event history is added in #30. The run record records current cleanup disposition; workflow event history remains reserved for engineering workflow transitions.

### 4.2 Schema version

Keep `schemaVersion: 1` and add `terminalCleanup` as an optional schema-v1 field, consistent with the repository's existing additive schema-v1 evolution for recovery metadata.

The TypeScript domain, `RUN_RECORD_FIELDS`, migration, exact run-record validation, and `schemas/run-record.schema.json` must be updated together. New records written by #30 use the new field; historical records may legitimately omit it.

## 5. Terminalization ordering and atomic intent publication

The existing safety ordering remains mandatory:

```text
persist terminal workflow state + cleanup disposition
                    |
                    v
          attempt physical cleanup
                    |
          +---------+---------+
          |                   |
       complete              failed
```

The cleanup disposition must be part of the same authoritative run publication that creates the terminal workflow transition. Do not publish the terminal event first and add `terminalCleanup: pending` in a second run-record save.

The orchestrator prepares the terminal candidate before `applyEvent()`:

- no managed isolated worktree exists -> `terminalCleanup.status = "complete"`;
- ordinary managed terminal worktree -> `terminalCleanup.status = "pending"`;
- Issue #28 governed preservation -> `terminalCleanup.status = "preserved"` with an exact preservation reason.

This closes the crash window where a terminal state exists durably but MASWE has no durable statement that cleanup is outstanding.

`COMPLETE`, `CANCEL`, and `FAIL` retain their existing workflow semantics. No `CLEANUP_*` workflow events are introduced.

## 6. Governed preservation from Issue #28

### 6.1 Preservation is explicit, not inferred from terminal state

`FAILED` does not by itself mean cleanup is eligible.

The current boolean preservation paths should become explicit durable reasons:

- CREATED/bootstrap recovery preservation -> `bootstrap-recovery`;
- failed active/recoverable revalidation -> `revalidation-recovery`;
- mutable-role publication outcome unknown -> `publication-outcome-unknown`.

The implementation may refactor the internal `failRun()` preservation options so callers pass a typed reason instead of only a boolean. The reason is persisted atomically with `FAIL`.

### 6.2 Preserved worktrees are not cleanup candidates

For `terminalCleanup.status === "preserved"`:

- automatic post-terminal cleanup does nothing;
- `maswe cleanup <run-id>` rejects without changing the run or filesystem;
- `retry` may consume the retained worktree through the existing governed recovery path;
- successful return to a nonterminal workflow state removes `terminalCleanup` from the run record;
- superseding the failed run is the explicit operator action that abandons its recovery path and may convert preservation into ordinary cleanup eligibility.

#30 does not add `cleanup --force`, `cleanup --abandon`, or another authority-bypass flag.

## 7. Public cleanup operation

Add one public orchestrator operation and one CLI command:

```text
Orchestrator.cleanupTerminal(runId)
maswe cleanup <run-id>
```

`cleanup` is an existing-run command. It loads and executes using the persisted run snapshot rather than current project configuration or environment overrides.

### 7.1 State behavior

After acquiring the cleanup/recovery serialization fence and reloading the authoritative run:

- nonterminal run -> reject without mutation;
- `terminalCleanup.status === "complete"` -> idempotent success;
- `terminalCleanup.status === "preserved"` -> reject without mutation;
- `pending` or `failed` -> run exact physical reconciliation;
- terminal legacy record with no `terminalCleanup` -> apply the legacy rules in Section 11.

On successful reconciliation, persist `complete` and return the updated terminal run.

On a physical cleanup failure whose state can be classified safely, persist `failed` with a stable cleanup code/message and throw a cleanup-specific operator error so CLI exit status is non-zero.

## 8. Exact ownership and cleanup reconciliation

### 8.1 Preconditions

Cleanup must never delete from a path string alone.

For a run with a recorded managed worktree, derive and validate all of the following before destructive work:

1. `run.state` is terminal.
2. `run.config.policy.useIsolatedWorktree` is true.
3. `run.workspace.worktreePath` exists in the record.
4. The recorded worktree path resolves exactly to `externalWorktreePath(run.repositoryPath, run.id)`.
5. The target path is not the operator checkout (`path.resolve(run.repositoryPath)`).
6. The recorded branch is exactly the MASWE-owned branch expected for this run (`maswe/<run-id>`).
7. Git worktree registrations for `run.repositoryPath` can be parsed completely and unambiguously.
8. No other worktree registration uses the expected run branch.
9. If a registration exists for the target path, its branch and HEAD match the run's recorded workspace identity.
10. If the target filesystem object exists, it is an ordinary directory and not a symlink or another unsafe path type.

A branch/head/path/repository conflict is `cleanup-ownership-mismatch`. Failure to inspect Git or required filesystem state is `cleanup-inspection-failed`.

Cleanup does **not** require a clean working tree or an unchanged workspace fingerprint. The existing production policy already permits `git worktree remove --force` for an owned terminal worktree; uncommitted terminal contents are not promoted into authoritative provenance. Ownership proof, not cleanliness, controls deletion.

### 8.2 Reconciliation matrix

| Git registration | Target filesystem path | Result |
|---|---|---|
| none | absent | idempotent cleanup success |
| none | present | fail closed: ownership mismatch; never recursively delete |
| exact expected registration | ordinary target directory | attempt exact `git worktree remove --force <path>` |
| exact expected registration | absent | attempt only exact path-scoped Git removal/reconciliation; re-inspect afterward |
| target path registered to different branch/head | any | fail closed: ownership mismatch |
| expected branch registered at another path | any | fail closed: ownership mismatch |
| malformed/conflicting Git registration data | any | fail closed: inspection failure |
| unsafe target filesystem type | any | fail closed: ownership mismatch |

Production #30 cleanup must not fall back to `rm -rf` for an unregistered directory and must not use unconstrained `git worktree prune`, because either could affect state whose exact ownership is no longer proven.

The MASWE branch is never deleted by production terminal cleanup.

## 9. Outcome-unknown handling

`git worktree remove --force` is an external side effect. Its exit status is evidence, not the final authority.

After every attempted removal—whether the command reports success or failure—MASWE re-inspects:

- exact Git worktree registrations;
- exact target filesystem path state.

Classification:

- registration absent **and** path absent -> physical cleanup succeeded;
- exact expected registration/path still intact after a failed remove -> `cleanup-remove-failed`;
- registration remains but path is absent, or another post-state prevents a unique safe conclusion -> `cleanup-postcondition-failed`;
- changed/conflicting ownership -> `cleanup-ownership-mismatch`.

If physical cleanup succeeds but publishing `terminalCleanup.status = "complete"` fails, leave the durable record at its last known disposition and propagate the persistence error. A later `maswe cleanup` observes registration/path absence and idempotently publishes `complete`.

If both the physical cleanup attempt and publication of its durable failure status fail, surface both errors (for example through `AggregateError`) rather than replacing one with the other.

## 10. Cleanup-state publication

Every post-terminal change to `terminalCleanup` is an authoritative run mutation:

- reload authoritative run state under the cleanup/recovery serialization fence;
- create a new candidate from that exact version;
- increment the run version according to the store's existing optimistic concurrency contract;
- update `updatedAt` and `terminalCleanup.updatedAt`;
- preserve workflow state, events, artifacts, approvals, counters, evidence, GitHub association, supersession metadata, and `run.failure` byte-for-byte except for ordinary canonicalization already performed by the store;
- publish through existing durable run-record persistence.

Cleanup state changes do not append workflow events.

## 11. Legacy schema-v1 records

Historical terminal runs can omit `terminalCleanup`. Do not silently rewrite all legacy records during load.

### 11.1 Safe cases

For a terminal legacy run with no managed worktree target, `cleanupTerminal()` may treat cleanup as already complete and publish explicit `complete` if invoked.

For a terminal legacy `COMPLETED` or `CANCELLED` run with a recorded managed worktree, the cleanup command may adopt cleanup as `pending` only inside the cleanup operation and only after exact ownership/reconciliation checks. If registration and path are already absent, publish `complete` directly.

### 11.2 Legacy FAILED runs

A legacy `FAILED` run with a surviving worktree is more constrained because pre-#30 state may represent either:

- a cleanup failure; or
- deliberate Issue #28 recovery preservation.

Where durable structure already proves preservation, classify it explicitly:

- recoverable `workspaceBootstrap` state -> `preserved/bootstrap-recovery`;
- recoverable `revalidation` state -> `preserved/revalidation-recovery`.

Do not infer `publication-outcome-unknown` from failure-message prose.

If a legacy `FAILED` record has a surviving exact worktree but lacks structural evidence sufficient to distinguish cleanup failure from intentional preservation, `maswe cleanup` fails closed with `cleanup-legacy-state-ambiguous`. The operator may use the governed retry/supersede path rather than an ownership-bypass cleanup flag.

If both exact registration and target path are already absent, cleanup may publish `complete` because no destructive action remains.

## 12. Concurrency and serialization

Cleanup, retry, and supersede can otherwise race over the same managed worktree. #30 therefore reuses the existing per-run `.mutation-journal-v1/` rather than creating another journal.

Add a distinct mutation operation identity for terminal cleanup (for example `run-terminal-cleanup`) in the same FIFO journal. Cleanup must acquire this durable per-run fence before authoritative reload and hold it through physical reconciliation and the resulting cleanup-state publication.

`retryFromFailed()` and `supersede()` must participate in compatible serialization before they inspect, recreate, consume, or abandon a terminal run's managed worktree. The implementation may extend the existing `RunMutationRole` vocabulary or provide a focused wrapper over the same journal, but it must not introduce an independent lock whose ordering can deadlock with `.mutation-journal-v1/`.

Required ordering properties:

- cleanup wins first -> it may remove an eligible failed worktree; a later retry sees `complete` and reconstructs through the existing retry reconciliation path;
- retry wins first -> it returns the run to nonterminal state and clears terminal cleanup metadata; a later cleanup reload rejects the nonterminal run;
- supersede wins first -> it explicitly abandons the predecessor's recoverability before predecessor cleanup;
- cleanup never runs concurrently with a publication mutation for the same run.

The existing mutation journal remains immutable and is not compacted or deleted by #30.

## 13. Retry and supersede integration

### 13.1 Retry

A successful `RETRY_FROM_FAILED` transition returns the run to nonterminal workflow state. `terminalCleanup` must be removed atomically with the successful retry publication.

This applies whether the failed worktree had previously been:

- cleaned successfully and must be recreated;
- left pending/failed and is still exactly owned;
- intentionally preserved for recovery.

Retry continues to validate branch/head/worktree provenance according to Issue #28. #30 does not weaken those gates.

### 13.2 Supersede

Superseding a terminal `FAILED` run is an explicit operator decision to stop recovering that predecessor. If its cleanup state is `preserved`, supersession may convert the predecessor to ordinary cleanup eligibility before invoking the same cleanup reconciler.

The predecessor branch remains preserved. Cleanup failure must not be hidden by the supersession path.

No new automatic branch deletion policy is introduced.

## 14. Automatic post-terminal cleanup

Automatic cleanup after `COMPLETE`, `CANCEL`, ordinary `FAIL`, or supersession must invoke the same reconciliation implementation as `maswe cleanup`; there must not be separate "best effort" and "manual recovery" deletion algorithms.

Behavior:

- `complete` / `cancel` terminal publication succeeds, then automatic cleanup is attempted;
- automatic cleanup success returns the terminal run with `terminalCleanup.complete`;
- automatic cleanup failure persists `terminalCleanup.failed` and returns a non-zero operator failure while leaving the workflow state terminal;
- a preserved failure skips automatic cleanup and returns/records the terminal run as preserved;
- if the triggering engineering operation also failed, `run.failure` remains the engineering diagnostic and `terminalCleanup.lastError` remains the cleanup diagnostic. Neither overwrites the other.

## 15. Operator rendering and CLI contract

`renderRun()` must make terminal cleanup visible independently from workflow failure.

Examples:

```text
State: COMPLETED
Terminal cleanup: complete
```

```text
State: FAILED
Failure: <engineering diagnostic>
Failure code: <engineering code>
Terminal cleanup: failed (cleanup-remove-failed): <bounded cleanup diagnostic>
```

```text
State: FAILED
Terminal cleanup: preserved (publication-outcome-unknown)
```

For a terminal legacy record without explicit cleanup metadata, human rendering should identify cleanup as `unknown (legacy record)` rather than claiming success.

JSON output naturally exposes the new `terminalCleanup` object.

CLI usage adds:

```text
maswe cleanup <run-id>
```

No `--force` option is added for cleanup.

## 16. Error model

Cleanup failures are operational lifecycle failures, not workflow failures.

Stable durable cleanup codes:

- `cleanup-inspection-failed` — Git/filesystem state cannot be inspected reliably;
- `cleanup-ownership-mismatch` — observed repository/path/branch/HEAD/type conflicts with recorded ownership;
- `cleanup-remove-failed` — exact removal was attempted and the exact owned worktree remains;
- `cleanup-postcondition-failed` — removal outcome cannot be reconciled to a confirmed safe terminal postcondition;
- `cleanup-legacy-state-ambiguous` — a legacy FAILED run lacks sufficient durable intent to decide whether a surviving worktree is cleanup-eligible.

Messages are sanitized/redacted using the repository's existing diagnostic boundary and bounded to a fixed durable size. Error control flow must use typed codes/classes, not message matching.

A cleanup error never writes `run.failure`, changes `failure.code`, changes `failure.resumeState`, or publishes `FAIL`.

## 17. File and interface impact

### Domain and validation

- `src/domain.ts`
  - terminal cleanup status/reason/error types;
  - optional `RunRecord.terminalCleanup`.
- `src/store.ts`
  - permit/migrate/persist the new field;
  - preserve optimistic version semantics for cleanup metadata updates.
- `src/run-record-validation.ts`
  - exact cleanup object validation and lifecycle consistency checks.
- `schemas/run-record.schema.json`
  - exact optional cleanup shape and conditional field requirements.

### Cleanup execution

- `src/git-workspace.ts`
  - focused inspection/reconciliation helpers around exact worktree registration and target path;
  - branch-preserving, path-scoped removal only.
- `src/orchestrator.ts`
  - terminal cleanup intent preparation;
  - public `cleanupTerminal()`;
  - one shared automatic/manual reconciliation path;
  - preserved-recovery reason integration;
  - retry/supersede serialization and cleanup metadata lifecycle.
- `src/run-mutation.ts`
  - reuse the existing journal with a cleanup operation/role as required for serialization.

### CLI and rendering

- `src/cli-args.ts` — add strict `cleanup` command with exactly one run ID and no command-specific options.
- `src/cli-runner.ts` — dispatch cleanup using existing-run configuration semantics.
- `src/run-rendering.ts` — independent cleanup status/diagnostic rendering.

### Documentation

At minimum reconcile:

- `docs/ARCHITECTURE.md`;
- `docs/OPERATIONS.md`;
- `docs/ARTIFACT_CONTRACTS.md` where run-record lifecycle semantics are described;
- relevant PRD/roadmap wording if it currently describes terminal cleanup behavior;
- `CHANGELOG.md` when implementation is later authorized.

#30 does not modify #18 authenticated-smoke fixture ownership semantics.

## 18. Test strategy

Implementation must be TDD-first and separate production cleanup tests from authenticated-smoke cleanup tests.

### 18.1 Low-level cleanup reconciliation

Use deterministic seams around:

- Git worktree registration inspection;
- target `lstat`/filesystem inspection;
- exact `git worktree remove --force` outcome;
- post-removal registration/path reinspection.

Cover at least:

1. exact registration + exact target directory -> success;
2. registration/path already absent -> idempotent success;
3. non-zero remove but registration/path become absent -> success after reconciliation;
4. non-zero remove and exact worktree remains -> `cleanup-remove-failed`;
5. stale registration with missing directory -> deterministic exact-path attempt followed by confirmed success or `cleanup-postcondition-failed`;
6. unregistered directory at the recorded path -> fail closed without recursive deletion;
7. symlink or unsafe target type -> fail closed;
8. branch mismatch;
9. HEAD mismatch;
10. expected branch registered at another path;
11. malformed/conflicting worktree-list output;
12. operator checkout can never be selected;
13. two runs in the same repository cannot delete each other's worktree;
14. run branch survives successful cleanup.

### 18.2 Orchestrator lifecycle

Cover:

- `COMPLETE` is persisted with `terminalCleanup.pending` before physical cleanup;
- successful automatic completion cleanup -> `COMPLETED` + `complete`;
- injected completion cleanup failure -> `COMPLETED` + `failed` and retryable `maswe cleanup`;
- equivalent behavior for `CANCELLED`;
- ordinary `FAILED` run cleanup failure retains original `run.failure` and separate cleanup diagnostic;
- bootstrap/revalidation/publication-outcome-unknown failures persist `preserved` and are rejected by cleanup;
- successful retry clears terminal cleanup metadata atomically with return to nonterminal state;
- supersede explicitly abandons preserved predecessor recovery before cleanup;
- repeated cleanup after success is idempotent;
- cleanup does not mutate quality, verification, merge-ready, or GitHub evidence;
- physical success followed by cleanup-state publication failure is recovered by a later cleanup invocation;
- concurrent cleanup versus retry/supersede follows the serialized outcomes in Section 12.

### 18.3 Persistence, schema, CLI, and rendering

Cover:

- exact terminal cleanup migration/validation;
- illegal status/reason/error combinations;
- bounded/redacted cleanup diagnostics;
- historical records with no cleanup field remain loadable;
- safe legacy completed/cancelled adoption;
- structurally provable legacy preservation;
- ambiguous legacy FAILED surviving worktree fails closed;
- `maswe cleanup <run-id>` grammar and dispatch;
- nonterminal cleanup rejection;
- existing-run command independence from current project config/env;
- human cleanup rendering and JSON representation;
- no cleanup workflow events are added.

### 18.4 Validation gates

The implementation PR must pass on both supported exact Node baselines:

- Node `24.18.0` canonical;
- Node `22.22.2` compatibility floor.

Required repository gates remain:

```text
npm run check
npm run pack:dry
git diff --check
```

Also require exact-head CI, independent exact-head review, and zero unresolved actionable review threads before merge.

## 19. Acceptance criteria mapping

- **AC-30.1:** Terminal workflow publication always precedes physical cleanup; cleanup intent is part of that terminal publication.
- **AC-30.2:** Injected cleanup failure leaves workflow state terminal and persists independent cleanup failure metadata.
- **AC-30.3:** `maswe cleanup <run-id>` retries `pending`/`failed` terminal cleanup idempotently.
- **AC-30.4:** `COMPLETED`, ordinary `FAILED`, and `CANCELLED` all use the same cleanup reconciler.
- **AC-30.5:** Preserved Issue #28 recovery worktrees reject cleanup until their recovery is consumed or explicitly abandoned through supersession.
- **AC-30.6:** Already-absent registration/path is a confirmed idempotent success.
- **AC-30.7:** Repository/path/branch/HEAD/type conflicts fail closed without deleting anything.
- **AC-30.8:** Operator checkout and another run's worktree are never cleanup targets.
- **AC-30.9:** Successful cleanup preserves the MASWE branch.
- **AC-30.10:** Cleanup never changes workflow evidence, GitHub association evidence, artifacts, approvals, counters, or engineering failure classification.
- **AC-30.11:** Human and JSON status expose cleanup disposition independently from workflow state.
- **AC-30.12:** Cleanup retry does not append workflow events.
- **AC-30.13:** Legacy terminal records are handled conservatively; ambiguous legacy FAILED preservation fails closed.
- **AC-30.14:** Cleanup/retry/supersede races are serialized through the existing per-run mutation journal.
- **AC-30.15:** Production cleanup tests remain separate from #18 smoke-fixture cleanup ownership.
- **AC-30.16:** Supported Node baselines, package checks, exact-head CI, independent review, and review-thread gates pass before merge.

## 20. Non-goals

- Automatic deletion of nonterminal human-gated worktrees.
- Automatic deletion of MASWE branches.
- A `--force` cleanup bypass for ambiguous ownership or preserved recovery state.
- General Git worktree garbage collection or global `git worktree prune`.
- Authenticated-smoke fixture cleanup tracked by #18.
- Redesigning Issue #28 workflow/revalidation semantics.
- Changing merge-ready/completion evidence requirements.
- GitHub App Phase B behavior.
- Repository-rename identity work from #34.
- Multi-harness execution work from #31/#32/#36.
- Database/outbox/distributed-control-plane implementation from #4.

## 21. Implementation handoff boundary

After the owner approves this committed specification, the next step is a separate implementation-plan pass using the Superpowers writing-plans workflow.

That plan must:

- start from this exact design branch/specification;
- work TDD-first;
- preserve the scope and non-goals above;
- make implementation tasks independently reviewable;
- include exact acceptance-test commands and supported Node baselines;
- be suitable for handoff to an external implementation agent.

No implementation work is authorized merely by this design commit.
