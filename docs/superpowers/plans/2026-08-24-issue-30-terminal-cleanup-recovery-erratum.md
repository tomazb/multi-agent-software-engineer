# Issue #30 Terminal Cleanup Recovery Implementation Plan — Task 4 Fence Erratum

> **Normative amendment:** This file is part of the Issue #30 implementation plan. It overrides Task 4/Task 5 wording in `docs/superpowers/plans/2026-08-24-issue-30-terminal-cleanup-recovery.md` where that wording could cause same-run `.mutation-journal-v1/` re-entry or route a cleanup failure back through workflow failure publication. The external implementation agent MUST read the approved design, the main implementation plan, and this erratum before editing.

**Applies to:** planning head derived from `aed0750b46b6ce7e3ca422da7c4d8d7ab19bab2c`.

**Design authority:** unchanged. This is a plan correction only; it does not change `docs/superpowers/specs/2026-08-24-issue-30-terminal-cleanup-recovery-design.md`.

## 1. Verified defects

### 1.1 Same-journal re-entry

`advanceGitDependentAutomaticWork()` holds the same run's `publication` mutation claim for the full callback. Inside that callback, BUILDING/RESOLVING paths can publish `FAILED` through `failRun()`. Today `failRun()` may immediately call `finalizeTerminal()` for a non-preserved failure.

Task 4 of the main plan changes `finalizeTerminal()` to use the shared cleanup path, and that shared path acquires a new `terminal-cleanup` claim in the same FIFO `.mutation-journal-v1/`. Calling it before the existing `publication` claim is released would self-queue behind the live claim owned by the same process and eventually time out.

The affected rule is broader than only the cycle-limit branches: any `failRun()` invocation executed inside `advanceGitDependentAutomaticWork()` can be non-preserving when its preservation condition is false. Therefore all terminal finalization originating inside that publication-fence callback must be deferred until after the callback returns and the claim is released.

The existing `complete()` flow is the model: publish the terminal transition under its publication fence, let the fence release, then call `finalizeTerminal()`.

### 1.2 Cleanup errors must bypass workflow-failure publication

The current outer `advance()` catch explicitly rethrows `RunMutationSupersededError` and routes every other error to `failRun()`.

Task 4 moves automatic terminal cleanup to the post-publication-fence boundary in `advance()`. If `finalizeTerminal()` rejects with a typed `TerminalCleanupError`, that error is an operational cleanup failure, not a new engineering workflow failure. It must never be passed to `failRun()`.

A literal `return this.finalizeTerminal(...)` exits the `try` before a later rejection is observed by the catch, but `return await this.finalizeTerminal(...)` would expose the rejection to the catch. The implementation contract therefore must not depend on return-vs-await syntax. `advance()` must explicitly rethrow `TerminalCleanupError` just as it already rethrows `RunMutationSupersededError`.

## 2. Normative Task 4 amendment

### 2.1 `failRun()` gains an execution-only deferral flag

In addition to Task 3's durable preservation reason, use this internal option shape:

```ts
options: {
  preservationReason?: TerminalCleanupPreservationReason;
  deferTerminalFinalization?: boolean;
} = {}
```

`deferTerminalFinalization` is **not** persisted and does not change cleanup eligibility. It only controls whether the current call is allowed to invoke `finalizeTerminal()` before returning.

The failure completion helper must behave equivalently to:

```ts
const finishFailure = (record: RunRecord): Promise<RunRecord> =>
  options.preservationReason || options.deferTerminalFinalization
    ? Promise.resolve(record)
    : this.finalizeTerminal(record);
```

The terminal event candidate still carries the exact durable cleanup disposition required by Task 3:

- ordinary managed failure -> `terminalCleanup.pending`;
- governed retained recovery -> `terminalCleanup.preserved` with the exact reason;
- no managed cleanup target -> `terminalCleanup.complete`.

### 2.2 Every `failRun()` inside `advanceGitDependentAutomaticWork()` defers finalization

For every `failRun()` call made while the outer `publication` lease is held, pass:

```ts
{ deferTerminalFinalization: true, ...preservationOptions }
```

This includes at least:

- maximum PR comment-resolution cycle failure;
- resolver execution/publication failure;
- maximum build/verify cycle failure;
- builder execution/publication failure.

Where Task 3 maps existing preservation logic to an exact `preservationReason`, include both fields, for example:

```ts
{
  deferTerminalFinalization: true,
  ...(preservationReason ? { preservationReason } : {}),
}
```

Do not call shared cleanup, `finalizeTerminal()`, `cleanupTerminal()`, or another `withRunMutationFence()` role from inside the held `publication` claim.

### 2.3 `advance()` performs terminal finalization only after the fence returns

`advanceGitDependentAutomaticWork()` returns its completed record normally. `withRunMutationFence(..., "publication", ...)` releases its claim in `finally` before the wrapper resolves or rejects, so `advance()` is the post-fence finalization boundary.

Replace the direct completed return with logic equivalent to:

```ts
const attempt = await this.advanceGitDependentAutomaticWork(run, headSha);
if (attempt.kind === "completed") {
  return isTerminal(attempt.run.state)
    ? this.finalizeTerminal(attempt.run)
    : attempt.run;
}
```

At this point no `publication` claim from `advanceGitDependentAutomaticWork()` is held.

Task 4's `finalizeTerminal()` behavior remains:

- `complete` -> return unchanged;
- `preserved` -> return unchanged without cleanup;
- `pending` / `failed` -> invoke the shared cleanup path, which acquires `terminal-cleanup`.

Thus a preserved Issue #28 recovery path remains preserved even though `advance()` invokes `finalizeTerminal()` after the fence.

### 2.4 Exceptions that escape the publication callback remain fence-safe

CI/verification or other errors that escape `advanceGitDependentAutomaticWork()` cause `withRunMutationFence()` to release its publication claim before the outer `advance()` catch executes. The outer catch may therefore publish an engineering failure unless the error is one of the explicit rethrow classes in Section 2.5 or another same-run mutation claim is explicitly held at that call site.

The governing rule is structural, not name-based:

> A call path that currently owns any same-run `.mutation-journal-v1/` claim may publish terminal intent/state, but it must not acquire another role in that journal. Physical terminal cleanup begins only after the owning claim has been released.

### 2.5 `advance()` explicitly rethrows cleanup failures

Import/use the Task 2 `TerminalCleanupError` type in `src/orchestrator.ts` and make the outer `advance()` catch structurally equivalent to:

```ts
} catch (error) {
  if (
    error instanceof RunMutationSupersededError ||
    error instanceof TerminalCleanupError
  ) {
    throw error;
  }
  return this.failRun(
    run,
    runFailureMessage(error),
    runFailureCode(error),
    runFailureRuntime(error),
    preservationOptions,
  );
}
```

The exact preservation-option expression remains governed by Task 3; the important rule here is that `TerminalCleanupError` never reaches `failRun()`.

This carve-out is required even if Section 2.3 is implemented with a bare returned promise. It makes cleanup-error classification invariant under an ordinary `return await` refactor and enforces design §16 directly.

Do not add `TerminalCleanupFailureCode` values to `RunFailureCode`. Cleanup failure remains represented only by `terminalCleanup.failed` plus the surfaced typed cleanup error.

## 3. Required Task 4 RED test additions

Add both regressions to `test/issue30-terminal-cleanup-orchestrator.test.ts` before implementing the deferral/carve-out.

### 3.1 Publication claim is released before advance-driven cleanup

Construct an isolated run already in `BUILDING` with `counters.buildVerifyCycles === config.policy.maxBuildVerifyCycles`, so the next `advance()` deterministically enters the in-fence maximum-cycle `FAIL` branch without requiring a model failure.

Inject `terminalCleanupDependencies.removeWorktree`. At the instant physical removal begins, inspect the run's mutation journal without acquiring another claim:

```ts
const scan = await scanLockJournal(
  runMutationJournalRoot(cwd, run.id),
  "data",
);

const unreleasedPublication = scan.claims.some(
  (claim) =>
    claim.operation === "run-publication" &&
    !scan.releases.has(claim.ticket),
);

assert.equal(
  unreleasedPublication,
  false,
  "automatic FAIL cleanup must start only after the publication claim is released",
);
```

Then allow exact removal to complete and assert:

```ts
const authoritative = await store.load(run.id);
assert.equal(authoritative.state, "FAILED");
assert.equal(authoritative.terminalCleanup?.status, "complete");
assert.equal(
  authoritative.events.filter((event) => event.type === "FAIL").length,
  1,
);
```

The same test must fail RED under the pre-correction Task 4 implementation by observing the unreleased publication claim or by timing out on nested cleanup if the test runs through actual claim acquisition.

Also add one ordinary BUILDING or RESOLVING execution-error case whose preservation condition is false, proving that non-cycle-limit `failRun()` paths inside the publication fence use the same deferral boundary.

### 3.2 Cleanup failure is never converted into a second workflow failure

Use the same advance-driven maximum-cycle engineering failure, but inject cleanup dependencies so exact physical cleanup fails with `TerminalCleanupError("cleanup-remove-failed", ...)` and the owned worktree remains registered/present.

Capture the engineering failure after the first `FAIL` publication, then require the public `advance()` call to reject with the cleanup error itself:

```ts
await assert.rejects(
  orchestrator.advance(run.id),
  (error: unknown) =>
    error instanceof TerminalCleanupError &&
    error.code === "cleanup-remove-failed",
);
```

Reload and assert all four planes independently:

```ts
const authoritative = await store.load(run.id);

assert.equal(authoritative.state, "FAILED");
assert.equal(authoritative.failure?.code, "workflow-failure");
assert.match(
  authoritative.failure?.message ?? "",
  /Maximum build\/verify cycles exceeded/,
);
assert.equal(authoritative.terminalCleanup?.status, "failed");
assert.equal(
  authoritative.terminalCleanup?.lastError?.code,
  "cleanup-remove-failed",
);
assert.equal(
  authoritative.events.filter((event) => event.type === "FAIL").length,
  1,
);
```

Also snapshot the original engineering `run.failure` immediately after its publication if the test seam exposes that boundary, and assert it is deep-equal after cleanup failure persistence. Quality, verification, merge-ready, artifact, approval, counter, and GitHub evidence remain governed by the main Task 4 immutability tests.

This regression must pass whether Section 2.3 uses `return this.finalizeTerminal(...)` or `return await this.finalizeTerminal(...)`. Its purpose is to prove the `advance()` catch classification, not a JavaScript promise-control-flow accident.

## 4. Task 5 interaction

Task 5's `terminal-recovery` rules remain unchanged:

- retry/supersede predecessor decisions use `terminal-recovery`;
- cleanup uses `terminal-cleanup`;
- no same-run mutation role is recursively acquired;
- supersede releases `terminal-recovery` before invoking shared cleanup.

This erratum adds the same release-before-cleanup discipline to the pre-existing `publication` claim used by automatic BUILDING/RESOLVING work and an explicit cleanup-error carve-out at the outer `advance()` catch.

## 5. Verification additions

Task 4 focused GREEN verification remains:

```bash
node --experimental-strip-types --test \
  test/run-mutation.test.ts \
  test/issue30-terminal-cleanup-orchestrator.test.ts \
  test/orchestrator.test.ts
npm run _typecheck
```

The Task 4 test file must contain all of:

1. the journal-inspection regression proving an advance-driven `FAIL` has no unreleased `run-publication` claim when physical cleanup begins;
2. an ordinary non-cycle-limit BUILDING/RESOLVING failure using the same deferral boundary;
3. the injected cleanup-failure regression proving `TerminalCleanupError` surfaces unchanged, the engineering `run.failure` remains intact, cleanup becomes independently `failed`, and exactly one `FAIL` event exists; and
4. the automatic/manual cleanup lifecycle tests from the main plan.

Task 8 AC-30.14 evidence must cite the fence-release regression in addition to the cleanup/retry/supersede concurrency suite. AC-30.2, AC-30.10, and AC-30.12 evidence must cite the cleanup-failure regression.

## 6. Handoff rule

The external implementation handoff is not valid unless the agent acknowledges all three documents:

```text
docs/superpowers/specs/2026-08-24-issue-30-terminal-cleanup-recovery-design.md
docs/superpowers/plans/2026-08-24-issue-30-terminal-cleanup-recovery.md
docs/superpowers/plans/2026-08-24-issue-30-terminal-cleanup-recovery-erratum.md
```

If implementation reveals another path that owns a same-run mutation claim and then attempts terminal cleanup before releasing it, apply the structural rule above and report the newly discovered call path. Do not solve it with nested claims or by weakening the distinct cleanup/recovery operation identities.

If a typed `TerminalCleanupError` reaches another workflow-level catch that would route it through `FAIL`, add an equivalent explicit rethrow at that boundary and report the call path. Cleanup failures are never workflow-failure inputs.
