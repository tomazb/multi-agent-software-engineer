# Artifact contracts

Artifacts are the durable handoff protocol between roles. A later API or database may change storage, but these meanings should remain stable.

## General rules

- Every artifact is UTF-8 Markdown in v0.1+.
- The store records logical name, attempt number, repository-relative path, creation timestamp, and SHA-256 digest.
- Retries write attempt-scoped immutable files (`*.attempt-<n>.md`) and keep a latest logical pointer by name.
- Digests are recomputed and compared on every read; mismatches fail closed.
- A stored reference names exactly one portable direct child of
  `.maswe/runs/<run-id>/artifacts/`. Its physical leaf is ASCII `[A-Za-z0-9._-]+`, neither `.` nor
  `..`, does not end in `.`, and has no Windows reserved device stem, including a stem before an
  extension or an `¹`/`²`/`³` device-number variant. The writer preserves lowercase portable
  generated leaves and uses an injective hexadecimal escape namespace for all other generated
  leaves, including names already shaped like that namespace. This keeps distinct logical names
  distinct on case-insensitive filesystems. Publication rejects any physical path owned by another
  logical artifact and any unexpected existing target instead of overwriting it. Existing
  schema-version-1 physical names remain valid. Absolute paths, nested paths, separator tricks,
  and other non-portable physical filenames are rejected; historical `\\` separators are
  normalized to `/` before validation.
- Artifact publication redacts content first, then measures the exact UTF-8 bytes that would be
  stored. Post-redaction content above the shared 1 MiB authoritative-file bound is rejected before
  artifact-file or run-record publication; content at exactly 1 MiB is allowed. Artifact reads use
  the same 1 MiB bound, so an artifact accepted by the writer cannot later be rejected solely for
  exceeding it. Reads still require every namespace ancestor to be an ordinary directory, require
  an ordinary final file opened with no-follow support, recheck the namespace after the bounded
  read, then recompute and compare the recorded SHA-256 digest. This independent read-side check
  protects against tampering, historical malformed data, filesystem replacement, and bypassed
  writers. Lack of no-follow support fails closed. The trusted-local-user boundary does not claim
  to prevent every concurrent same-user ancestor-replacement race between filesystem operations.
- Artifact-file publication precedes its run-record reference. Modeled outcomes:
  - Determinate artifact write failure leaves no published artifact; ordinary retry may start again.
  - Artifact outcome-unknown (rename observed, directory durability unconfirmed) is reconciled only
    within the same invocation: bounded no-follow verification of the exact expected bytes and
    digest, then a second directory sync. Successful reconfirmation continues to run-record
    publication. Failed reconfirmation after verified same-invocation ownership durably removes the
    artifact when possible so retry can start cleanly. Mismatched or unverifiable targets are not
    adopted, overwritten, or blindly deleted. Cross-process recovery of an orphaned matching file
    without durable publication intent is outside this contract.
  - Determinate run-record write failure removes the just-published ordinary artifact and syncs the
    artifact directory before returning the original error.
  - Run-record outcome-unknown retains the artifact and reconciles an exact matching canonical
    record; it never triggers determinate cleanup.
- Agents must not rely on prior chat messages that are absent from the supplied prompt.
- Model output cannot authorize a transition unless the orchestrator recognizes the required terminal marker after structured response decoding: exactly one bare marker token on the final logical line of the authoritative assistant text (no backticks, quotes, earlier mentions, duplicates, or conflicting markers).
- For Cursor CLI `json` / `stream-json` modes, marker validation runs only on the decoded authoritative `result` string. Transport JSON quoting is not treated as embedded model content. Malformed envelopes, unsupported shapes, and missing `result` fields fail closed before marker validation.
- Operator-visible marker diagnostics distinguish quoted examples, embedded tokens, duplicates, conflicts, non-final markers, and content after a marker, without echoing the full model output.
- Common secrets are redacted before persistence. Successful model output follows the artifact
  redaction contract; its URI-authority scanner advances once forwards without rescanning prior
  content. Failure diagnostics additionally follow the bounded failure contract below.
- JSON schemas live under `schemas/` for configuration and run records.
- Persisted `run.config.roles.*.model` values are exact executable catalogue selectors after
  `start`. Before execution, a catalogue-capable runtime resolves a case-insensitive exact selector
  to the trusted catalogue entry's canonical spelling, without family/provider/effort
  substitution. That canonical value drives the request and identity comparison; runtime metadata
  cannot replace it. Loading a run migrates defaults then runs the same config assertions as
  project load (without applying process environment overrides).
- `RuntimeDoctorResult` (including `maswe doctor --json` output) is not a persisted artifact and is not governed by run-record schemas. It is an in-process report surface with typed doctor `code` values and optional skipped-check `prerequisite` constrained by `DoctorCheckPrerequisite` to `cursor-cli`, `model-catalogue`, or `model-brainstormer`.

## Run record

`run.json` contains:

```json
{
  "schemaVersion": 1,
  "version": 3,
  "id": "20260722120000-1a2b3c4d",
  "title": "Add organization audit trail",
  "request": "...",
  "repositoryPath": "/workspace/project",
  "state": "WAITING_FOR_DESIGN_APPROVAL",
  "createdAt": "2026-07-22T12:00:00.000Z",
  "updatedAt": "2026-07-22T12:20:00.000Z",
  "approvals": {
    "brainstorm": true,
    "design": false
  },
  "counters": {
    "buildVerifyCycles": 0,
    "commentResolutionCycles": 0
  },
  "workspace": {
    "remote": "https://github.com/example/repo.git",
    "baseSha": "abc...",
    "headSha": "abc...",
    "branch": "maswe/20260722120000-1a2b3c4d",
    "fingerprint": "...",
    "worktreePath": "/tmp/maswe-worktrees/<repoKey>/20260722120000-1a2b3c4d"
  },
  "evidence": {
    "quality": { "headSha": "abc...", "passed": true, "at": "..." },
    "verification": { "headSha": "abc...", "passed": true, "at": "..." }
  },
  "github": {
    "installationId": 12345,
    "repository": "owner/repo",
    "pullRequestNumber": 42,
    "baseSha": "abc...",
    "headSha": "def...",
    "branch": "maswe/20260722120000-1a2b3c4d",
    "suspended": false
  },
  "config": {},
  "artifacts": [],
  "events": []
}
```

Build, quality, and verification events include the evaluated `headSha`. When `headSha` changes, prior quality/verification evidence is invalidated and merge-ready fails closed until CI and verification are re-run.

`requireCiPass` and `requireVerifierPass` govern whether failed evidence blocks progress before
`PR_READY`. They do not change the final artifact contract: `MARK_MERGE_READY` and `COMPLETE`
always require present, passing quality and verification bindings for the exact current head, and
`COMPLETE` also requires a present, passing merge-ready binding for that head.

Optional `github` association binds a run to a GitHub App installation, repository, and pull request for check-run mirroring. `suspended` is set when the installation loses access; Phase A does not auto-start runs from webhooks.

The run's configuration is a snapshot. Changing `.maswe/config.json` affects only later runs unless a future migration command explicitly updates a run.

Every production-created run, including a superseding replacement, persists workspace bootstrap
intent before branch or worktree side effects and durably checkpoints the established workspace
before `START`. During that recoverable `CREATED` window the relevant record shape is:

```json
{
  "state": "CREATED",
  "workspaceBootstrap": {
    "mode": "isolated-worktree",
    "sourceBaseSha": "1111111111111111111111111111111111111111",
    "sourceBranch": "main",
    "sourceTreeFingerprint": "2222222222222222222222222222222222222222222222222222222222222222",
    "remote": "https://github.com/example/repo.git",
    "plannedAt": "2026-08-18T12:00:00.000Z"
  },
  "workspace": {
    "remote": "https://github.com/example/repo.git",
    "baseSha": "1111111111111111111111111111111111111111",
    "headSha": "1111111111111111111111111111111111111111",
    "branch": "maswe/20260722120000-1a2b3c4d",
    "fingerprint": "...",
    "worktreePath": "/tmp/maswe-worktrees/repository-key/20260722120000-1a2b3c4d"
  }
}
```

`workspaceBootstrap` remains present through the durable workspace checkpoint and is removed by
the single `START` publication. Bootstrap source-drift checks exclude the orchestrator-owned
`.maswe` namespace; read-only role fingerprints continue to include authoritative `.maswe` state.

An active current-head generation uses this optional shape:

```json
{
  "state": "CI_RUNNING",
  "revalidation": {
    "returnState": "PR_REVIEW",
    "source": "github",
    "originHeadSha": "3333333333333333333333333333333333333333",
    "requestedHeadSha": "4444444444444444444444444444444444444444",
    "generation": 2,
    "requestedAt": "2026-08-18T12:01:00.000Z",
    "updatedAt": "2026-08-18T12:02:00.000Z"
  }
}
```

A newer authenticated or local head retargets an active or recoverable failed revalidation
generation. Evidence from a superseded generation is unusable. Retargeting invalidates the
current evidence bindings but preserves historical workflow events verbatim.

### Failure record

New failures may include `failure.code`, currently one of `runtime-models-exhausted`,
`workflow-failure`, `automatic-transition-limit-exceeded`,
`policy-read-only-workspace-mutation`, `policy-runtime-identity-mismatch`,
`policy-role-permission-mismatch`, or `policy-read-only-head-moved`, alongside the existing
message, timestamp, and optional resume state. The code is optional for backward compatibility
with existing schema-version-1 records. They may also include the optional
schema-version-1-compatible object:

```json
{
  "runtime": {
    "attempts": [
      {
        "model": "cursor-grok-4.5-high",
        "code": "cursor-cli-non-zero",
        "message": "Cursor CLI exited non-zero.",
        "requestedModel": "cursor-grok-4.5-high",
        "configuredModel": "cursor-grok-4.5-high",
        "exitCode": 7,
        "timedOut": false,
        "durationMs": 42,
        "promptTransport": "stdin",
        "stderrPresent": true,
        "truncated": false
      }
    ],
    "totalAttempts": 1,
    "omittedAttempts": 0,
    "aggregateTruncated": false
  }
}
```

`attempts` stores at most eight entries. `totalAttempts` counts every executed fallback;
`omittedAttempts` is the difference between the total and stored entries. Attempt messages are
bounded to 512 Unicode code points and `model`, `requestedModel`, and `configuredModel` display
fields to 256. All fields except `model`, `code`, `message`, `stderrPresent`, and `truncated` are
optional per attempt. Arbitrary runtime metadata is not part of this contract. The
`durableRuntimeFailureAttempt` and `durableRuntimeFailureSummary` schema definitions both set
`additionalProperties: false`, so nested raw stderr, adapter metadata, and unknown summary fields
are rejected.
Store and migration safeguards inspect only the first eight raw attempt slots and discard invalid
entries, keeping sanitization work bounded even for malformed historical input.

Policy failures are discovered through nested `Error.cause` and `AggregateError.errors` wrappers,
with cycle protection, so their durable code survives wrapped execution errors. They intentionally
persist without `failure.runtime` or a runtime-attempt summary: policy failures bypass fallback
selection and are not model attempts.

Failure messages and `FAIL.details.reason` are normalized, redacted, and bounded to 8,192 Unicode
code points including `… [truncated]`. `RETRY_FROM_FAILED.details.previousFailure.message` receives
the same safeguard. `FAIL.details.runtime` and
`RETRY_FROM_FAILED.details.previousFailure.runtime` use the same bounded durable subset. Loading an
older record with no runtime object preserves the old shape; loading a record with the optional
object reconstructs and sanitizes only the documented fields before status/inspection rendering.
The existing schema-version-1 `failure.message` field keeps its historical unconstrained schema
shape; migration and every new write enforce the current 8,192-code-point runtime policy.

### Terminal cleanup record

Optional schema-version-1 object `terminalCleanup` is operational lifecycle metadata, not workflow
evidence. Terminal workflow state is durable before any worktree deletion. Cleanup retries append
no workflow events and change no artifacts, approvals, counters, GitHub association, or
engineering `failure` classification. Production cleanup retains the `maswe/<run-id>` branch.
Ownership is re-proved from the exact repository, recorded path, Git worktree registration,
branch, HEAD, and type before deletion.

```json
{
  "status": "pending",
  "updatedAt": "2026-08-24T12:04:00.000Z"
}
```

Allowed `status` values:

- `pending` and `complete` permit neither `preservationReason` nor `lastError`.
- `preserved` requires exactly one `preservationReason`
  (`bootstrap-recovery`, `revalidation-recovery`, or `publication-outcome-unknown`) and
  forbids `lastError`.
- `failed` requires `lastError` (`code` plus `message`) and forbids `preservationReason`.
  Durable codes are `cleanup-inspection-failed`, `cleanup-ownership-mismatch`,
  `cleanup-remove-failed`, `cleanup-postcondition-failed`, and
  `cleanup-legacy-state-ambiguous`.

`pending` and `failed` are retryable through `maswe cleanup`. `preserved` retains governed
Issue #28 recovery state and rejects cleanup. Legacy terminal records may omit `terminalCleanup`;
that omission is unknown until reconciled and must not be inferred as `complete` or `preserved`.
Ambiguous legacy `FAILED` preservation fails closed as `cleanup-legacy-state-ambiguous`.

Cursor CLI runtime error results are not artifacts. Raw stderr, raw error metadata, and stderr
digests are never part of the run or artifact contract. Safe runtime diagnostics expose a stable
code plus applicable exit code, timeout, duration, requested/configured model, prompt transport,
`stderrPresent`, and `truncated`. Individual diagnostics are capped at 2,048 Unicode code points
before the 8,192-code-point fallback aggregate is built.

## `02-brainstorm.md`

Required content:

- Problem and desired outcome.
- Users, constraints, assumptions, and non-goals.
- Multiple viable approaches and trade-offs.
- Recommended approach.
- Risks and open questions.
- Draft measurable acceptance criteria.
- Approval checklist in ordinary language (must not quote or repeat the machine terminal marker token).

Required terminal marker:

```text
READY_FOR_BRAINSTORM_APPROVAL
```

Strict marker validation rejects missing, quoted, embedded, duplicate, conflicting, or non-final-line markers. Diagnostics identify the violated contract after structured response decoding.

## `03-specification-and-design.md`

Required content:

- Product requirements.
- User-visible and failure behavior.
- Stable acceptance criterion IDs.
- System context, component impact, interfaces, and data flows.
- Security, privacy, reliability, and observability requirements.
- Migration, compatibility, and rollout strategy.
- Test strategy mapped to acceptance criteria.
- Ordered implementation tasks and verification commands.
- Alternatives and unresolved decisions.

Required terminal marker:

```text
READY_FOR_DESIGN_APPROVAL
```

## `04-builder-report.md`

Required content:

- Summary of behavior implemented.
- Files changed.
- Acceptance criteria evidence.
- Tests and commands run.
- Simplification review outcome: safe in-scope simplifications applied, or a statement that no safe in-scope simplification was identified.
- Deviations and limitations.
- Git status and commit SHA when available.

Required terminal marker:

```text
BUILD_COMPLETE
```

The report is not proof. The quality runner and verifier must inspect the actual workspace.

## `05-quality-report.md`

Generated by deterministic code, not a model.

For every command it contains:

- Command string.
- Exit code.
- Duration.
- stdout.
- stderr.

The report's overall result is `PASS` only when every configured command ran and returned zero. With an empty command list, the result is pass; production repositories should configure meaningful commands.

This stderr is output from trusted project quality commands and is redacted through the existing
artifact contract. It is distinct from provider/Cursor runtime stderr, which never becomes an
artifact.

## `06-verification-report.md`

Required content:

- Workspace or commit verified.
- Acceptance criteria matrix.
- Commands and evidence inspected.
- Blocking findings.
- Non-blocking warnings.
- Final decision.

The final line must be exactly one of:

```text
VERDICT: PASS
VERDICT: FAIL
```

Only `VERDICT: PASS` advances to `PR_READY`.

## `07-review-comment.md`

Raw review comment text supplied by a user or future GitHub integration. Treat this artifact as untrusted input. It may contain prompt injection, code blocks, links, shell text, or misleading instructions.

It must never be executed as a command or used to bypass approved requirements.

## `08-comment-classification.md`

Required content:

- Rationale.
- Likely files involved.
- Minimal permitted change.
- Risks and ambiguity.

The final line must be exactly one of:

```text
SCOPE: IN_SCOPE
SCOPE: OUT_OF_SCOPE
```

Only `IN_SCOPE` permits resolver edits.

## `09-resolution-report.md`

Required content:

- Reviewer concern verified.
- Minimal changes made.
- Tests added or changed.
- Commands executed.
- Remaining ambiguity or limitation.

Required terminal marker:

```text
RESOLUTION_COMPLETE
```

After this artifact is written, the workflow always runs deterministic quality checks and a fresh verifier.

## Event metadata

Each transition event includes:

```json
{
  "id": "uuid",
  "at": "2026-07-22T12:30:00.000Z",
  "type": "VERIFY_PASSED",
  "actor": "verifier",
  "from": "VERIFYING",
  "to": "PR_READY",
  "details": {
    "requestedModel": "gpt-5.6-sol-high",
    "actualModel": "gpt-5.6-sol-high",
    "agentId": "...",
    "runtimeRunId": "..."
  }
}
```

Runtime fields are optional because not every adapter exposes them.

For runtime-backed successful transitions, `requestedModel` and `actualModel` are display-only
copies normalized with the same single-line, aggregate-delimiter-neutral, 256-code-point policy as
durable failure model fields. Optional `agentId` and `runtimeRunId` use a separately named bounded
identifier-display policy. Runtime invocation, catalogue selection, fallback ordering, and
requested-versus-actual comparison use the original values and are not changed by event
persistence.

SHA-bearing event details have current-operation semantics. Build, quality, and verification
events record the exact evaluated head. `MARK_MERGE_READY` records the exact head returned by the
shared current-head gate. `COMPLETE` records that same exact head as both `headSha` and
`mergeReadySha`. These details are audit history only: an earlier passing event never recreates
missing, failed, or stale `evidence`, and completion never falls back to a historical
`MARK_MERGE_READY` event.

Every Git-dependent authoritative publication performs its final branch, clean-worktree, and
exact-expected-HEAD assertion inside the same per-run mutation section that writes the event or
evidence. Builder and resolver commits additionally prove the exact expected parent and publish
the branch ref with an expected-old-SHA compare-and-swap.

GitHub association publication is event-free and rollback-capable; workflow request and retarget
events publish only after association commit and are never rolled back. Association-only saves may
change the `github` and invalidated `evidence` fields, but do not append a workflow event.

For `FAIL`, details may also include the durable failure `code`, bounded safe `reason`, and optional
bounded `runtime` summary. For `RETRY_FROM_FAILED`, `previousFailure` is the already-safe failure
record and its message/runtime subset is re-sanitized at the store boundary. For both events, the
raw runtime object is excluded before other detail fields are cloned; its bounded allowlisted
replacement is attached afterward.

## Future schema hardening

Planned additions:

- JSON Schema files with CI validation.
- Immutable attempt-specific artifact names.
- Git base and head SHA on all build, CI, and verification artifacts.
- Prompt-template version and content hash.
- Token usage, cost, latency, and provider request IDs.
- Redaction and data-classification labels.
- Cryptographic signing or provenance attestations for CI and verification.
