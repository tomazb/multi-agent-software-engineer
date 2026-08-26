# Roadmap

The roadmap prioritizes a trustworthy local workflow before hosted autonomy.

The current implementation is Cursor-first. The repository and product scope now target a future harness-neutral MASWE control plane under Issues #31 and #32; planned support must not be read as implemented support.

## v0.1 — Local foundation

Status: implemented in the initial repository bootstrap.

- TypeScript CLI and strict domain contracts.
- Explicit workflow state machine.
- File-based run and artifact store.
- Configurable role models and bounded fallbacks.
- Cursor CLI runtime.
- Optional Cursor SDK runtime.
- Mock runtime and workflow tests.
- Brainstorm and design approval gates.
- Deterministic quality commands.
- Independent read-only verifier.
- PR comment scope classification and resolution loop.
- Workspace fingerprint enforcement.
- Cursor plugin manifest and skill.
- PRD, architecture, operations, security, GitHub design, roadmap, and ADRs.

## v0.2 — Local hardening and git isolation

Status: implemented, including the #27 correctness-hardening programme (#28, #29, and #30).

Accepted post-#27 baseline: `23f06f3900598443dc40c65c35336aecda76ea2f`.

- `RunStore` interface and atomic file writes with lock/version checks.
- Artifact digest validation on every read.
- Attempt-specific immutable artifact history.
- Persist repository remote, branch, base SHA, head SHA, and workspace fingerprint.
- Worktree/branch manager with unexpected branch-movement rejection.
- Deterministic commit creation and change-scope checks.
- SHA-bound quality/verification evidence that invalidates when head SHA changes.
- Pass verifier defects explicitly back to the builder.
- Strict validation of all required terminal markers.
- Redaction of common secrets in artifacts and logs.
- Prompt transport through stdin where Cursor CLI supports it.
- Budget and timeout controls.
- Retry-from-failed and supersede-run operations.
- Durable `CREATED` bootstrap/retry and explicit stale-head revalidation.
- Non-bypassable role policy and fail-closed read-only/identity boundaries.
- Retryable, idempotent terminal managed-worktree cleanup independent from terminal workflow state.
- JSON schemas for configuration and artifacts.
- Packaged CLI release and lock file.

## v0.3 — GitHub App pilot

Status: **Phase A (read-only checks) implemented**; Phase B remains on Issue #3. The #27 correctness-hardening entry gate is complete. Issue #34 must be completed or explicitly dispositioned before Phase B obtains GitHub write authority.

### Phase A (done)

- GitHub App webhook service in `src/github/` (`maswe github-webhook`).
- Signature verification and `X-GitHub-Delivery` deduplication.
- PR/head-SHA-bound run association (`RunRecord.github` + association index).
- Read-only MASWE check runs (four named checks; review-resolution stays `neutral`).
- Check invalidation on new head SHA.
- Integration tests for replay, forged signature, stale SHA, rate limit, and installation suspension.

### Phase B (remaining)

Required order within #3:

1. authenticated digest-bound approval workflow;
2. deterministic branch push and PR creation;
3. review comment ingestion and human-approved evidence replies/resolution; and
4. GitHub Actions terminal-state/artifact ingestion.

Cross-cutting requirements include exact repository/PR/head/artifact identity, stable idempotency keys, installation-scoped credentials, stale-head revalidation through the hardened core, and bounded crash/retry recovery.

Issue #34 must establish stable GitHub repository identity across owner/name renames, or be explicitly dispositioned, before Phase B obtains write authority.

## Multi-harness execution programme

Status: owner-approved direction under Issue #31. MH-00 architecture publication is the current tranche under Issue #32, based exactly on `23f06f3900598443dc40c65c35336aecda76ea2f`.

MH-00 publishes architecture only. External harness runtime support is not implemented by that publication.

Required order:

1. **Done:** complete Issue #27 and revalidate `main` at the accepted post-hardening SHA.
2. **Current:** publish, review, and approve MH-00 / Issue #32 and ADR-0008.
3. Complete Issue #34 before GitHub Phase B obtains write authority; complete the remaining Issue #3 Phase B before multi-harness runtime implementation.
4. MH-01: prove harness-neutral domain/configuration/capability/attempt/evidence contracts.
5. MH-02: refactor current Cursor/mock runtimes behind the harness registry without semantic drift.
6. MH-03: define deterministic global/project/private/invocation configuration hierarchy.
7. Add planned direct external harnesses as read-only workers after their individual entry gates and owner approval: Claude Code (MH-04), Codex CLI (MH-05), Copilot CLI/OpenCode (MH-06), Hermes Agent (MH-06H), and DeepSeek Harness (#36 / MH-06D).
8. MH-07: separately govern external writer authority; MASWE retains deterministic commit/publication authority.
9. MH-08: assurance profiles and differential verification.
10. MH-09 / #4: freeze distributed worker schemas only after local contracts and initial adapter conformance evidence exist.

Hermes Agent and DeepSeek Harness remain planning-only until their complete entry gates and owner approval are satisfied. MH-00 validates their architecture requirements but does not authorize either adapter or runtime implementation.

Routing is capability-negotiated: harness, transport/protocol, profile/composition, provider/model, permissions, ambient/hidden state, retry/delegation behavior, isolation, and evidence completeness remain separate facts. Unknown required capabilities fail closed.

Target harnesses include Cursor, Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, Hermes Agent, and DeepSeek Harness. Only Cursor CLI, optional Cursor SDK, and mock are implemented today.

## v0.4 — Durable multi-harness control plane

Entry gates:

- Issue #27 completed and post-hardening `main` revalidated at exact SHA `23f06f3900598443dc40c65c35336aecda76ea2f`.
- Issue #32 approved and merged.
- Remaining Issue #3 Phase B completed before multi-harness runtime implementation.
- Harness-neutral local contracts and the Cursor-preserving registry refactor proven.
- Initial external read-only adapter conformance evidence available before distributed worker schemas are frozen.

Planned capabilities:

- PostgreSQL run/event/attempt store.
- Object storage for immutable artifacts and bounded raw harness evidence.
- Queue, worker leases, retries, and transactional outbox.
- REST API and MCP server exposing authorized MASWE operations.
- Capability-negotiated local, cloud, and self-hosted harness adapters.
- Exact harness/transport/profile/provider/model/permission/assurance provenance.
- Team/repository policy hierarchy.
- Service-account and secret-manager integration.
- Structured logs, metrics, traces, cost, and token accounting.
- Web dashboard for approvals, artifacts, attempts/evidence, and intervention.

## v0.5 — Safe automated PR resolution

- File and change-scope policy engine.
- Risk categories for reviewer comments.
- Automatic low-risk in-scope resolutions.
- Fresh verifier and CI checks on every head SHA.
- Thread resolution after evidence gates.
- Merge-queue awareness.
- Reviewer disagreement and requirement-change workflows.
- Audit export and retention policies.

## v1.0 — Production release

Exit criteria:

- Multi-tenant isolation review and external security assessment.
- At-least-once event processing with idempotent side effects.
- Exact model and git provenance where providers expose it, with explicit evidence-strength classification where they do not.
- Zero silent fallback in fail-closed policy.
- Reliable recovery from worker, provider, harness, and GitHub outages.
- Supported database migrations and upgrade policy.
- Signed releases, pinned dependencies, and SBOM.
- Documented SLOs, incident response, backup, and disaster recovery.
- Pilot reliability and cost targets met across multiple repositories.

## Research backlog

- Automated acceptance-criteria traceability from design to tests and code.
- Differential verification using independent harness/model combinations for high-risk changes.
- Formal policy language for allowed files, commands, APIs, and data classes.
- Secure execution sandboxes with network and filesystem capability controls.
- Automated UI/browser evidence capture.
- Cross-repository plans and coordinated PRs.
- Model quality/cost routing based on task risk while preserving explicit user policy and no silent identity substitution.
