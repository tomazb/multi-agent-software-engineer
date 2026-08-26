# Changelog

All notable changes will be documented in this file.

The project follows semantic versioning once a public release process is established.

## [Unreleased]

### Added

- Issue #30 terminal worktree cleanup recovery: durable terminal workflow publication before
  deletion; independent `terminalCleanup` lifecycle (`pending`, `complete`, `failed`,
  `preserved`); retryable `maswe cleanup <run-id>` for `pending`/`failed`; Issue #28 preserved
  recovery rejection; exact repository/path/registration/branch/HEAD/type ownership re-proof;
  production branch retention; no `--force`; and a 20-run bounded-resource regression. Not merged.
- Issue #29 policy boundaries: enforced fixed role-permission matrix, policy-classified runtime
  identity mismatch, orchestrator-owned read-only fingerprint and exact-HEAD fence around both
  runtime returns and throws, and direct policy propagation outside fallback aggregation.
- Strict CLI grammar coverage for declared long options, duplicate/empty-value rejection, global
  option placement, and equals-form dash-prefixed string values; portable path-glob semantics;
  valid empty quality-command lists with blank entries rejected; single-pass prompt rendering; and
  direct-child, no-follow bounded artifact reads with digest revalidation.

- GitHub App Phase A read-only pilot (`src/github/`): webhook signature verification,
  `X-GitHub-Delivery` deduplication, event normalization, PR/run association, SHA-bound check
  publishing for four MASWE checks, installation suspension, and CLI commands
  `maswe github-webhook` / `maswe github-publish-checks`.
- Optional `githubApp` config (enabled only with `readOnlyChecks: true`) and `RunRecord.github`
  association fields with schema and artifact-contract updates.
- Integration coverage for forged signatures, delivery replay, stale SHA invalidation, rate limits,
  and installation removal.
- Immutable hash-addressed GitHub association, check-create, and delivery journals with startup
  hard-link probing, quiescent retained-path legacy migration, and same-host coherent-filesystem
  support boundaries.
- Retained migration of legacy delivery/recovery evidence, full-digest check identity, bounded
  paginated reconciliation, and a 30-second default deadline per GitHub HTTP request.
- Hash-addressed normalized webhook inbox with file/directory-synced acknowledgement, exact leases,
  heartbeat/backoff, pre-listener restart recovery, terminal tombstones, and quiescent migration of
  legacy delivery evidence without persisting raw bodies or credentials.
- Review hardening for Phase A: canonical `03-specification-and-design.md` check binding, real
  installation tokens for unassociated PRs, delivery complete-after-success, exact PR association
  matching, scoped checks tokens, PATCH without `head_sha`, webhook body limits, rate-limit
  backoff, push invalidation, out-of-order SHA rejection, and association index locking.
- GitHub delivery-ID validation at every ingress boundary, with malformed IDs rejected before
  durable mutation and malformed installation-token responses using the stable
  `Installation token response missing token` error.
- `policy.doctorProbeTimeoutMs` configuration contract (default `60_000`, integer bounds
  `1_000..300_000`) with fail-closed validation and schema coverage.
- Typed doctor check codes across runtimes plus CLI `maswe doctor --json` output of full
  `RuntimeDoctorResult` (`code` and optional `prerequisite` per check).
- Deterministic Issue #17 doctor/runtime/CLI/SDK regressions including typed prerequisite skips,
  timeout propagation, and Cursor SDK import-seam coverage.
- Version-3 per-run immutable ticket journals for data, administrative, and administrative-recovery
  locking. Claims and exact-target releases use canonical digest-bound records and atomic
  no-clobber hard-link publication.
- Deterministic real-process barrier tests for ticket contention, crash boundaries, exact release
  convergence, recovery ordering, and late-owner/successor safety.
- Focused model-catalogue grammar and smoke-model allowlist regression tests.
- JSON→marker pipeline regression coverage for Cursor CLI structured output decoding and
  terminal-marker diagnostics.
- Thermos blocker regressions covering bracketed default badges, partial-catalogue rejection,
  cardinality-correct typed weak matches, ordered approved-family continuation, actionable
  preferred-hint errors, and operator-visible structured decode failures.
- Typed runtime failure diagnostics and focused persistence/leak regressions for non-zero Cursor
  CLI stderr, fallback aggregation, retry/supersede history, and CLI rendering.
- Optional schema-version-1 durable runtime failure summaries with up to eight bounded attempts,
  explicit total/omitted counts, safe operational fields, single-line model displays, and an
  eight-slot inspection bound when sanitizing malformed persisted attempt arrays.
- Successful-event identity framing regressions covering brainstorm, design, build, verifier
  success/failure, post-review verification, resolution, retry/supersede state, and human/JSON
  rendering.
- Governed Node runtime support with exact `.nvmrc` baseline `24.18.0`, bounded Node 22/24 package
  engines, strict npm engine policy, dependency-free install/script and CLI guards, zero-side-effect
  unsupported-runtime rejection tests, and same-runtime child-process selection proof.
- Exact Node `22.22.2` compatibility coverage and exact unsupported Node `25.9.0` negative CI
  alongside the canonical Node `24.18.0` job.

### Changed

- Renamed the canonical repository and active product identity from Cursor Multi-Agent Software
  Engineer to Multi-Agent Software Engineer (MASWE), including package, Cursor plugin, CLI,
  installation, and contributor surfaces.
- Documented the Cursor-first current implementation and the separately governed multi-harness
  direction under Issues #31 and #32 without advertising unimplemented adapters.
- The primary blocking CI runtime is now exact Node `24.18.0` from `.nvmrc`; exact Node `22.22.2`
  remains the blocking compatibility floor. Floating blocking Node aliases are removed.
- Repository npm entry points and direct CLI execution now reject unsupported Node versions before
  substantive validation, package creation, configuration/state access, worktree creation, provider
  invocation, or target quality commands. Failures use `MASWE_UNSUPPORTED_NODE_VERSION` and report
  the active version, supported range, canonical baseline, and an optional NVM recovery command.
- Cursor CLI doctor probe timeout now uses `policy.doctorProbeTimeoutMs` instead of the former
  implicit 5-second cap (`Math.min(5_000, commandTimeoutMs)`).
- Phase A webhook acknowledgement now returns 202 only after durable normalized handoff, 200 for
  completed/unsupported deliveries, 202 for same-ID queued/processing duplicates, 409 for a
  same-ID content conflict, and 503 for handoff failure. Internal failures emit sanitized local
  diagnostics and expose only a generic HTTP 500 body.
- Enabled `githubApp` JSON Schema validation now matches runtime policy by requiring
  `readOnlyChecks: true` and at least one allowed repository; disabled configuration may retain an
  empty repository list.
- Cursor CLI doctor classification now separates executable-unavailable, version-check failures,
  catalogue failures, role-resolution failures, skipped-prerequisite failures, probe invocation
  failures, probe transport timeouts, cleanup failures, and doctor unexpected errors.
- Doctor probe resource creation is now gated to real stdin-probe execution paths only; skipped
  probes and argv transport do not create probe worktrees/branches.
- `maswe unlock` and `maswe unlock-admin` now publish an exact immutable release rather than
  deleting a reusable owner pathname. Force remains an explicit operator-quiescence assertion,
  not process fencing.
- PR #10 regular-file locks are read as virtual ticket zero during a quiescent upgrade. New code
  never writes or deletes the legacy path; mixed old/new execution and rollback after v3
  publication are unsupported.
- Preferred exact smoke-model IDs must now be present in the live catalogue and satisfy the same
  approved-family and effort policy as automatic selection; invalid exact preferences fail closed
  without falling back. A literal allowlist token remains available only as a bounded family hint.
- Cursor catalogue parsing now accepts only documented row structures, including `(default)` and
  `[default]`, and rejects single-space leading-ID prose. Any malformed ID-shaped row rejects the
  complete discovery result even when valid IDs survive, preventing resolution from a silently
  incomplete catalogue.
- Logical model weak matches use typed, cardinality-correct failures: one weak candidate is inexact,
  multiple candidates are ambiguous, and effort-unavailable remains distinct. Smoke selection no
  longer matches error prose and continues through later approved families after a family-specific
  failure.
- Cursor CLI `json` / `stream-json` extraction now fails closed on malformed or unsupported
  envelopes instead of falling back to raw stdout. Exit-zero decode failures expose sanitized
  `invalid-transport-json`, `unsupported-response-shape`, or `missing-logical-output` diagnostics
  through the runtime output consumed by the orchestrator.
- Marker validation reports distinct quoted / embedded / duplicate / conflict / non-final
  diagnostics with logical line numbers.
- Role prompts harden the terminal-marker contract so models must not repeat the machine token in
  checklists, examples, or other body text.
- Non-zero Cursor CLI stderr is now normalized, redacted, and bounded before leaving the runtime
  adapter. Raw stderr is omitted from runtime metadata and cannot enter run failures, events,
  artifacts, retry history, or normal CLI output. The orchestrator and store apply focused
  defense-in-depth sanitization; individual diagnostics are capped at 2,048 Unicode code points
  and all-model aggregates at 8,192, with an omitted-attempt count when later fallback diagnostics
  cannot fit.
- Failure redaction now recognizes tested synthetic `github_pat_` fine-grained PAT shapes and
  username-only/user-password URI userinfo for explicit Git/provider schemes without treating
  ordinary email as credentials.
- Diagnostic sanitization now bounds inspection before pattern application (4,096 code points of
  lookahead, 12,288 absolute ceiling) and uses monotonic fixed-token-prefix, assignment,
  URI-authority, and private-key scanners instead of the former ambiguous nested assignment
  expression. Quoted assignments honor escaped delimiters and one JSON-encoded structural-quote
  layer, incomplete token candidates and supported URI authorities fail closed at the inspection
  boundary, and Unicode line/paragraph and bidi framing controls are neutralized.
- Runtime fallback metadata now survives into `run.failure.runtime`, applicable `FAIL` details,
  retry history, superseded runs, and human/JSON status output. Durable attempt messages are capped
  at 512 code points, model display fields at 256, raw runtime arrays are sanitized before event
  detail cloning, and arbitrary adapter metadata remains excluded.
- Successful runtime-backed events now persist bounded, single-line, delimiter-neutral display
  copies of model and runtime identifiers while leaving invocation and exact-model checks
  unchanged.
- The nested durable runtime attempt and summary JSON Schema definitions now reject additional
  properties while retaining historical schema-version-1 compatibility.
- Test child-process result transport is deterministic on Node `22.22.2`: compact machine results
  use synchronous writes and CLI capture uses unique file-backed descriptors. The production CLI
  output contract is unchanged.
- The 48 MiB constrained-heap sanitizer regression now uses an empirically supported
  8,000,000-character input and retains its exact 128-code-point bound, hard timeout, and ability to
  distinguish the historical full-code-point-array implementation.
- Cursor stderr is bounded and redacted before trimming or summary interpolation. Historical
  schema-version-1 failure messages remain schema-compatible and are bounded during migration.
- URI-userinfo redaction now records the last `@` during the forward authority scan, preventing
  quadratic rescans on repeated credential-free URLs in successful artifact content.

### Planned

- GitHub App Phase B: push/PR writes, review-thread replies, digest-bound GitHub approvals, Actions artifact ingestion.
- SQLite and PostgreSQL stores.
- Remote control-plane API and MCP server.

## [0.2.0] - 2026-07-22

### Added

- `RunStore` interface with atomic file writes, exclusive data locks (temp+`link` complete `{pid,owner,at}` records), a dedicated `.admin.lock` serializing acquire/unlock, **no automatic stale reclaim** for data or admin locks (use `maswe unlock` / `maswe unlock-admin`), and optimistic `version` checks.
- Artifact digest revalidation on every read and attempt-scoped immutable artifact history.
- Persisted workspace provenance: remote, base SHA, head SHA, branch, fingerprint, optional external worktree path.
- Git worktree/branch manager with deterministic commits (input/output SHA provenance), change-scope checks (NUL-delimited path parsing), unexpected branch-movement rejection, and worktree cleanup on terminal runs.
- Strict final-line terminal marker parsing with typed results; conflicting/duplicate/embedded markers fail closed.
- SHA-bound quality/verification evidence; new commits invalidate prior verification before merge-ready.
- Explicit verifier defect artifacts passed back into builder prompts.
- Secret redaction for artifacts and quality command output.
- Cursor CLI stdin prompt transport with doctor probe (argv fallback retained).
- Command/role/run timeout budgets.
- `maswe retry` and `maswe supersede` recovery commands.
- v0.1 run-record migration (synthesize `version` / attempt metadata) with full config assertion after migration, or fail-closed on invalid records.
- JSON schemas for configuration and run records under `schemas/`.
- Packaged CLI dry-run verification in CI via `npm ci` and `npm pack --dry-run`.
- Strict separation of project model resolution (`resolveProjectModels`) vs existing-run exact validation (`validatePersistedExactModel`); structured fail-closed Cursor catalogue row parsing; approved-family smoke model selection.

### Changed

- Default policy enables isolated worktrees and stdin prompt transport.
- Builder prompt includes `{{VERIFIER_DEFECTS}}` on verification retries.
- Cursor `stream-json` extraction accepts only terminal `type: "result"` events; stderr is never successful assistant content.
- Doctor probe cleanup is identity-based (branch + worktree) and runs in `finally` after partial creation failures.
- Logical model resolution requires matching effort suffixes (`-high`/`-medium`/`-low`); missing effort fails closed.
- Read-only workspace fingerprints include authoritative `.maswe` run/artifact state (locks/`*.tmp` excluded) for both Git and non-Git working directories; non-Git no longer returns the invariant `not-a-git-repository` fingerprint sentinel.
- Project-level model resolution errors identify the failing role.
- `runtime.outputFormat` contracts accept `stream-json` in TypeScript types and `schemas/config.schema.json`.
- Shell command timeouts terminate the process tree (POSIX process group / Windows `taskkill /T`) and bound Promise settlement when descendants hold pipes.
- Workspace remote provenance strips URL userinfo before persistence; SCP-style `git@host:path` remotes remain intact.
- Git-plane fingerprint probes pathspec-exclude `.maswe/` explicitly and no longer rely on `.git/info/exclude` for that isolation.

## [0.1.0] - 2026-07-22

### Added

- Product requirements, architecture, security, operations, roadmap, and ADRs.
- TypeScript workflow state machine and file-based event/artifact store.
- Configurable brainstorming, design, build, verify, and PR resolver roles.
- Cursor CLI, optional Cursor SDK, and mock runtime adapters.
- Human approval gates and fail-closed transition policy.
- Deterministic quality command runner.
- Read-only workspace fingerprint enforcement.
- PR comment classification, scoped resolution, CI rerun, and fresh verification loop.
- Cursor plugin manifest and `maswe` skill.
- Unit and end-to-end workflow tests plus GitHub Actions CI.
