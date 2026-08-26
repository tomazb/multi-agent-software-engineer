# Product Requirements Document

## Product

**Multi-Agent Software Engineer (MASWE)**

## Status

- Current implementation: v0.2 local hardening plus GitHub App Phase A
- Planned architecture: MH-00 capability-negotiated multi-harness execution
- MH-00 BASE_SHA: `23f06f3900598443dc40c65c35336aecda76ea2f`
- Date: 2026-08-26
- Owner: repository maintainer
- Intended first users: individual software engineers and small teams using Cursor and GitHub

## Executive summary

MASWE is a durable orchestration layer for software development performed by multiple specialized coding models. It assigns discovery, specification, implementation, verification, and pull-request resolution to separate roles while deterministic software owns state transitions, approvals, quality commands, permissions, retry limits, workspace/Git authority, and audit records.

The current usable release is a local TypeScript CLI with Cursor CLI and Cursor SDK runtime adapters plus a read-only GitHub App pilot. The long-term product adds authenticated GitHub workflow integration, capability-negotiated external harnesses, a remote control plane, durable database, and team policy administration without transferring workflow authority to models or harnesses.

The current implementation supports only the `mock`, `cursor-cli`, and `cursor-sdk` runtime kinds.
MH-00 / Issue #32 makes the owner-approved multi-harness direction normative planned architecture:
future execution is routed by exact capabilities and assurance evidence, not by harness-name
assumptions. External harness adapters are not implemented by MH-00.

## Problem statement

Coding agents are effective at isolated tasks but production software delivery has failure modes that a single conversation or opaque harness does not reliably control:

1. The model starts implementing before the problem and acceptance criteria are clear.
2. Long conversations accumulate assumptions, stale context, and self-confirming reasoning.
3. The same model that built a change verifies its own claims.
4. A provider, editor, or harness can silently use a different model, profile, or transport than the one selected.
5. PR comments can expand scope, change requirements, or cause unrelated edits.
6. Test, build, and merge readiness can be asserted without reproducible evidence.
7. A multi-day workflow cannot depend on one editor tab or harness session remaining alive.
8. Teams lack a durable record of who approved what, which harness/model/profile acted, and which code state was verified.
9. Harness-native approvals, retries, workflows, worktrees, memory, and subagents can accidentally become a second unrecorded control plane.
10. A product invoked transitively behind another harness can be misidentified as an equivalent direct adapter, weakening provenance and independence claims.

## Product vision

A developer should be able to submit a feature request and receive an implementation that has passed explicit product and technical approval gates, deterministic quality checks, independent verification, and controlled PR review resolution—with every handoff and governed execution attempt inspectable, attributable, and policy-bound.

## Target users

### Primary persona: senior individual contributor

Needs high-quality agent assistance but wants to retain control over requirements and architectural decisions. Works in Cursor, uses GitHub PRs, and is comfortable with a CLI.

### Secondary persona: engineering lead

Wants consistent delivery practices, harness/model policies, auditability, cost controls, and standardized verification across repositories.

### Future persona: platform team

Needs a hosted control plane, GitHub App, service accounts, multi-tenant isolation, observability, multiple qualified harnesses, and policy administration.

## Jobs to be done

- When I have an ambiguous feature idea, help me explore options before code is written.
- When an approach is approved, turn it into a complete, testable specification and plan.
- When implementation starts, use the explicitly governed execution identity and stay inside the approved scope.
- When implementation is reported complete, independently prove or reject that claim.
- When reviewers comment, resolve only requests that are within the approved change.
- When a run fails or pauses, let me inspect and resume it without losing context.
- When models, providers, harnesses, or access change, let me update explicit configuration rather than rewrite the workflow or accept silent substitution.
- When I use different agent harnesses, preserve which harness/profile/model actually executed and what evidence it supplied.

## Goals

### G1 — Durable workflow

Persist run state, events, configuration snapshots, artifacts, and later governed attempt/evidence records outside model context so work survives process, editor, and harness restarts.

### G2 — Separation of duties

Use distinct role executions for brainstorming, design, building, verification, and PR resolution. A writer must not approve its own edits.

### G3 — Configurable model and harness routing

Allow role-specific primary models, fallbacks, reasoning effort, permissions, and fail-closed model identity policy today. Under MH-00, evolve to explicit harness/transport/profile/provider/model routing matched against required capabilities and assurance facts without silent substitution.

### G4 — Deterministic gates

Keep approvals, transition rules, tests, builds, merge readiness, fallback choice, and evidence acceptance in deterministic MASWE software.

### G5 — Evidence-based verification

Require an acceptance-criteria matrix, actual code inspection, command evidence, blocking findings, and a machine-readable verdict. Future external verifiers also expose typed identity/evidence completeness rather than treating final text as sufficient provenance.

### G6 — Safe PR comment automation

Classify review comments before editing, escalate scope changes, re-run CI after edits, and use a fresh verifier.

### G7 — Cursor-first current experience and harness-neutral evolution

Support Cursor CLI immediately, Cursor SDK through an adapter, Superpowers practices in stage
prompts, and a Cursor plugin skill as the current editor entry point. Publish a harness-neutral
planned execution contract under Issues #31/#32 so Claude Code, Codex CLI, GitHub Copilot CLI,
OpenCode, Hermes Agent, and DeepSeek Harness can later be added without product-specific workflow
authority. External harness support remains unimplemented until its gated implementation tranches.

### G8 — Attributable multi-harness attempts

Future governed attempts shall distinguish harness, adapter/executable, transport/protocol,
profile/composition, requested provider/model/effort, runtime-reported identity, identity-evidence
strength, permissions, ambient/hidden state, isolation, retries/auxiliary calls, child lineage, and
raw/normalized evidence completeness.

### G9 — One authority plane

External harness approvals, schedulers, retries, worktrees, workflows, memory, and subagents shall
remain subordinate execution mechanics/evidence. MASWE remains authoritative for workflow state,
approvals, retry/fallback, workspace identity, evidence gates, deterministic commits, and
publication.

## Non-goals (historical v0.1) and remaining out of scope

The following were non-goals for the original v0.1 CLI and remain out of scope except where a later explicitly governed milestone says otherwise:

- Fully autonomous requirement approval.
- Automatic merging.
- Hosting a multi-user control plane in the current local release.
- Replacing GitHub Actions or a project's existing CI.
- General-purpose swarm or arbitrary recursive subagent framework.
- Guaranteeing provider model availability, identity evidence that a provider does not expose, or pricing.
- Sandboxing untrusted repositories beyond the permissions supplied by Cursor and the local operating system in the current release.
- Claiming that a harness sandbox alone provides complete operating-system isolation.
- Allowing an external harness to own authoritative worktrees, MASWE workflow state, retries/fallback, or Git/GitHub publication.
- Treating transitive Claude Code/Codex/etc. behind another harness as equivalent to MASWE's future direct adapter for that product.
- Creating pull requests or merging automatically in the current local product. GitHub Phase B may add governed PR publication, but automatic merge remains out of scope.

## Core principles

1. **Artifacts over conversation memory.** Every stage consumes approved files and repository state.
2. **One owner of orchestration.** Models and harnesses perform attempts; deterministic MASWE code decides what happens next.
3. **Human control at requirement boundaries.** Brainstorm and design approval are explicit by default.
4. **Independent verification.** The verifier is read-only and runs after deterministic checks.
5. **Fail closed.** Invalid transitions, identity/capability/evidence mismatches, excessive cycles, and permission violations stop the governed path.
6. **Minimal PR corrections.** Resolver edits must be the smallest correct response to an in-scope comment.
7. **Capability-negotiated portability.** Product-specific protocol code stays behind adapters; harness names do not imply permissions, provider/model, profile, memory, delegation, retry, or publication authority.
8. **Exact execution provenance.** Planned, reported, and attested execution facts remain distinct.
9. **MASWE-owned workspace and publication.** External harnesses consume assigned workspaces; deterministic commit/publication authority remains in MASWE unless a later explicit contract changes a bounded editing permission, not authority ownership.

## Functional requirements

### FR-1 — Project initialization

The CLI shall create a project-local `.maswe/config.json` without overwriting an existing file unless explicitly forced.

### FR-2 — Run creation

The user shall create a run with a title and request text or request file. The system shall snapshot effective configuration into the run record.

Every production-created run, including a superseding replacement, shall persist workspace
bootstrap intent before branch or worktree side effects and durably checkpoint the established
workspace before `START`.

### FR-3 — State machine

The system shall support explicit states for discovery, approval, design, implementation, CI, verification, PR review, comment classification, resolution, merge readiness, completion, failure, and cancellation.

Invalid state/event combinations shall fail without changing state. Future harness-native events shall not become workflow events without an explicit public MASWE operation/state-machine transition.

### FR-4 — Brainstorm stage

The brainstormer shall run read-only, inspect the request and repository as needed, compare viable approaches, identify risks and non-goals, propose acceptance criteria, and produce an approval artifact.

### FR-5 — Brainstorm approval

The workflow shall stop after brainstorming until a human records approval when `requireBrainstormApproval` is enabled. When explicitly disabled in trusted configuration, policy records the approval and proceeds automatically.

### FR-6 — Specification and design stage

The designer shall consume the approved brainstorm and produce product requirements, technical architecture, data flows, security considerations, acceptance criteria, test strategy, rollout strategy, and an ordered implementation plan.

### FR-7 — Design approval

The workflow shall stop after design until a human records approval when `requireDesignApproval` is enabled. When explicitly disabled in trusted configuration, policy records the approval and proceeds automatically.

### FR-8 — Builder stage

The builder shall receive only approved artifacts plus repository context, may modify the workspace under its governed writer policy, shall follow TDD practices, and shall produce a completion report with acceptance-criteria evidence and commands executed.

### FR-9 — Deterministic quality checks

The system shall execute configured commands sequentially outside the model and save stdout, stderr, exit codes, and durations. A failing command shall stop later commands in that quality pass and route the run back to building within policy limits.

`quality.commands: []` is valid and produces a passing empty quality report. If an entry is
present, it shall be a non-empty, non-whitespace string; blank entries are invalid configuration.

Before `PR_READY`, `gates.requireCiPass=false` may make a failed quality result nonblocking, but the
failed result remains SHA-bound evidence and does not satisfy either final workflow gate.

### FR-10 — Independent verifier

The verifier shall run read-only after quality checks, inspect the actual repository, map acceptance criteria to evidence, and end with exactly `VERDICT: PASS` or `VERDICT: FAIL`.

A failed verdict shall route to the builder within the configured cycle limit.

Before `PR_READY`, `gates.requireVerifierPass=false` may make a failed verdict nonblocking, but the
failed verdict remains SHA-bound evidence and does not satisfy either final workflow gate.

Future external verifier adapters shall additionally satisfy the active assurance profile for exact workspace/head, execution identity, hidden-state disposition, and required evidence completeness.

### FR-11 — PR readiness

Passing CI and verification produce `PR_READY`; explicitly nonblocking pre-PR policy may also
advance there while retaining the failed evidence. Until GitHub Phase B, the user or external integration creates the PR and signals `PR_OPENED`.

### FR-12 — Review comment classification

A review comment shall first be evaluated read-only. The classifier shall end with `SCOPE: IN_SCOPE` or `SCOPE: OUT_OF_SCOPE`.

### FR-13 — Review comment resolution

Only in-scope comments may enter the resolver. The resolver may edit the workspace, after which deterministic quality checks and a fresh verifier shall run before returning to the existing PR review state.

### FR-14 — Human escalation

Out-of-scope or ambiguous comments shall enter `WAITING_FOR_HUMAN`. The system shall not edit code until a human resumes or updates the approved scope.

### FR-15 — Model policy

Each role shall have a configurable model. When fail-closed model fallback is enabled, the system shall use only the primary model and reject a reported mismatch. When disabled, configured fallback models may be attempted in order.

A runtime-reported actual model different from the requested model is a policy failure. Policy
failures, including identity and permission violations, shall bypass fallback selection and
attempt aggregation. Existing-run model selectors shall resolve to the trusted catalogue entry's
canonical spelling before execution; that value, not runtime-reported metadata, shall drive the
request and identity comparison.

Under MH-00, requested provider/model, runtime-resolved provider/model, provider/runtime-reported
identity, and identity-evidence strength remain separate. A material provider/model/profile/
transport identity change is not silently absorbed inside one governed attempt.

### FR-16 — Read-only enforcement

The orchestrator shall fingerprint workspace state before and after every read-only role, outside
runtime adapters, and shall make the after check even when the runtime throws. In Git checkouts it
shall also compare the exact `HEAD` before and after the invocation. It shall classify post-run
state HEAD-first: a changed or unreadable `HEAD` fails before a fingerprint comparison; only a
stable/readable `HEAD` with a changed fingerprint is a workspace-mutation failure. Adapters may
retain local fingerprint checks as defense in depth. The fingerprint includes git-tracked, staged,
and untracked content; in both Git and non-Git working directories it also includes authoritative
`.maswe` run state, durable artifacts, and project config under the fingerprinted working directory
(independent of Git excludes). Ephemeral lock and `*.tmp` files under `.maswe` are excluded from
that fingerprint so normal orchestration churn does not false-fail.

Bootstrap source-drift checks shall exclude the orchestrator-owned `.maswe` namespace; read-only
role fingerprints shall continue to include authoritative `.maswe` state.

The persisted/project role-permission matrix shall be exact: brainstormer, designer, and verifier
are `read-only`; builder and prResolver are `workspace-write`. Only prResolver may be narrowed to
`read-only` for the comment-classification invocation. Every other mismatch shall fail before
runtime invocation.

`policy.allowedPathGlobs` shall use portable fully anchored matching: configured glob separators
normalize `\\` to `/`, while Git-reported candidate paths preserve their exact identity. A literal
POSIX `\\` in a candidate filename is not a directory separator. `*` is zero or more
non-separators; `?` is exactly one non-separator; `**` is zero or more characters including
separators; and `**/` is zero or more complete segments including zero.
`**` and `**/*` each allow every candidate path. Production working-tree candidates are non-empty
file paths, but the matcher special-cases both forms without a non-empty restriction. Dotfiles are
ordinary and regex metacharacters are literal.

Future external read-only harnesses remain enclosed by the MASWE outer HEAD/fingerprint fence even when the harness reports an inner sandbox. Unexpected mutation is a policy violation, not an ordinary provider failure.

### FR-17 — Run inspection

The user shall list runs, inspect one run in human-readable or JSON form, and see state, timestamps, approvals, cycle counters, artifacts, and failures. Future attempt inspection shall make exact harness/profile/model/permission/evidence identity inspectable without confusing it with workflow events.

### FR-18 — Recovery controls

The user shall be able to resume an actionable run, resume human review, cancel a nonterminal run, mark merge readiness, and mark completion.

A newer authenticated or local head shall retarget an active or recoverable failed revalidation
generation. Evidence from a superseded generation is unusable. Merge-ready and completion shall
both reject active revalidation, an unknown or mismatched head, a wrong or dirty managed worktree,
an associated GitHub head mismatch, and missing, failed, or stale required evidence. Completion
shall additionally require current passing merge-ready evidence; historical success events do not
recreate current evidence.

The quality and verification requirements at `MARK_MERGE_READY` and `COMPLETE` are unconditional:
both bindings must be present, passing, and bound to the exact current head regardless of the
`requireCiPass` and `requireVerifierPass` settings that govern progress before `PR_READY`.

GitHub association publication shall be event-free and rollback-capable. Workflow request and
retarget events shall publish only after association commit and shall never be rolled back.

Terminal workflow state shall remain independent from terminal worktree cleanup. Cleanup retry shall not create a harness attempt or imply engineering re-execution.

### FR-19 — Runtime adapters

The current core shall support a mock runtime, Cursor CLI runtime, and optional Cursor SDK runtime behind a common interface.

After #3 Phase B, MH-01 and MH-02 shall introduce a harness registry/capability contract while preserving current Cursor/mock semantics. External adapters shall not require harness-specific workflow branches.

### FR-20 — Environment diagnostics

The system shall provide a doctor command that checks runtime availability, credentials where applicable, and configured model slugs. For runtimes that implement catalogue discovery (currently Cursor CLI), doctor shall perform fail-closed catalogue discovery and project-style logical→exact resolution before the probe, and shall not report transport success when model resolution failed. Doctor does not create a run or persist a `run.config` snapshot. Runtimes without catalogue capability (currently Cursor SDK) are diagnosed without `agent models` resolution.

Future harness qualification/preflight shall bind its result to the exact executable/runtime and profile/composition generation observed; replacing either invalidates that qualification.

### FR-21 — CLI grammar

The CLI shall accept only its declared commands and long options, reject option abbreviations,
short options, duplicates, empty string values, option terminators, wrong-command options, and
wrong operand counts. Global `--config` and `--cwd` may appear before or after the command. Split
and equals forms are accepted for string options, but a dash-prefixed string value shall use equals
form so it cannot be parsed as another option.

### FR-22 — Prompt and artifact confinement

Prompt templates shall render declared placeholders once, insert values literally without
rescanning them, and reject unknown placeholders deterministically. An artifact path shall name
exactly one portable direct child of the run's artifact namespace. The physical leaf shall be ASCII
`[A-Za-z0-9._-]+`, neither `.` nor `..`, without a trailing `.`, and without a Windows reserved
device stem (including extension and superscript-number variants). Generated names shall be
injective for distinct logical artifact ownership, including on case-insensitive filesystems, and
publication shall reject an already-owned or unexpected existing physical target rather than
overwrite it. Reads shall require ordinary namespace directories and an
ordinary no-follow final file, remain bounded, and verify the recorded SHA-256 digest. The
trusted-local-user boundary does not claim to eliminate all concurrent same-user ancestor
replacement races.

### FR-23 — Planned capability-negotiated multi-harness execution

After its implementation gates are satisfied, MASWE shall authorize one immutable execution
attempt by matching required role capabilities and assurance facts against an exact qualified
harness execution plan.

The plan/evidence model shall distinguish at least:

- harness and adapter/executable identity;
- transport and protocol identity/version;
- profile/composition and digest;
- requested provider/model/effort;
- runtime-resolved/reported identity and evidence strength;
- requested/effective permissions;
- sandbox and MASWE outer-isolation facts;
- ambient inputs and hidden-state disposition;
- MASWE attempt versus harness-local retries/auxiliary calls;
- child/transitive execution lineage;
- raw versus normalized evidence; and
- evidence completeness.

Unknown or insufficient required capabilities/evidence shall fail closed. Harness-native approval,
retry, workflow, task-board, worktree, memory, or delegation state shall not authorize MASWE
workflow changes. MASWE shall retain exact workspace ownership and deterministic Git/publication
authority. Initial external harness adapters shall be read-only; writer authority requires a
separately approved MH-07 contract.

Direct and transitive product identities shall remain distinct, for example `MASWE -> Codex` versus
`MASWE -> DeepSeek Harness -> Codex`.

Hermes Agent and DeepSeek Harness are mandatory conformance examples for this requirement as
defined by ADR-0008 and the MH-00 design specification.

## Non-functional requirements

### NFR-1 — Reliability

- Run writes shall be atomic enough for a single local process and recoverable through JSON files.
- Automatic transition loops shall have a hard iteration limit.
- Retry loops shall be bounded by configuration and later distinguish MASWE attempts from admitted harness-local retries.
- Cancellation/timeout of a future external harness shall reach bounded process-tree quiescence or produce a typed failure/evidence result.

### NFR-2 — Security

- Secrets shall come from environment variables or external secret stores, not configuration committed to git.
- Read-only stages shall be mechanically checked by MASWE outer policy.
- Shell commands shall come only from trusted project configuration.
- Untrusted review comments shall never be interpolated into shell commands.
- Future required harness capabilities shall fail closed when unknown/unproven.
- Exact executable/profile qualification and ambient-input disposition shall be recorded where required by the assurance profile.
- No harness name alone shall imply permission, provider/model, sandbox, retry, workflow, delegation, or publication authority.

### NFR-3 — Auditability

Every transition shall record event type, actor, source and destination state, timestamp, and available model/runtime metadata. Artifacts shall include a SHA-256 digest.

Future governed attempts shall additionally retain attributable planned/reported/attested execution identity, raw-evidence references/digests where required, normalized evidence, and completeness. Attempt evidence shall not be confused with workflow authorization.

### NFR-4 — Portability

The local product shall run on macOS, Linux, and Windows with Node.js in the supported range `>=22.22.2 <23 || >=24.18.0 <25`, where the configured Cursor CLI command and project commands are available. Exact Node `24.18.0` is the canonical contributor and primary-CI baseline; exact Node `22.22.2` is the blocking compatibility floor.

Future adapter support may be platform-specific when a harness is not portable, but routing/qualification must expose that capability explicitly rather than silently selecting another harness.

### NFR-5 — Maintainability

- State transitions remain centralized.
- Runtime/harness dependencies remain isolated behind adapters.
- The orchestrator shall not accumulate harness-name conditionals for capability/policy semantics.
- Prompt templates are versioned files.
- New behavior includes tests and documentation.

### NFR-6 — Observability

The current product preserves command output, duration, failure reasons, and run events. Later versions shall add structured logs, metrics, traces, GitHub check summaries, attempt identity, token/cost accounting, and raw/normalized harness evidence with explicit completeness.

## MVP user journey

1. Developer installs and builds MASWE.
2. Developer installs Superpowers in Cursor.
3. Developer runs `maswe init` in a target repository.
4. Developer validates model slugs and quality commands with `maswe doctor`.
5. Developer starts a run from a feature request.
6. Brainstorm artifact is generated; developer reviews and approves it.
7. Specification/design artifact is generated; developer reviews and approves it.
8. Builder edits the active branch or worktree.
9. Quality commands execute.
10. Independent verifier passes or sends work back to the builder.
11. Developer opens a PR and signals it to MASWE.
12. Review comments can be classified and resolved through the loop.
13. Developer marks merge-ready and complete after external merge policy passes.

The MVP journey remains Cursor-first. MH-00 does not change it; later adapter tranches must preserve the same workflow authority and evidence gates.

## Success metrics

For a pilot set of repositories:

- At least 90% of runs retain complete brainstorm, design, build, CI, and verification artifacts.
- Zero verifier-approved runs where the verifier modified workspace files.
- Zero automatic resolver edits for comments classified out of scope.
- At least 80% of runs can resume after process restart using only persisted state.
- Median manual effort to inspect a run state is under two minutes.
- Model selection mismatches are surfaced in 100% of runtimes that report actual model identity.
- At least 70% of accepted feature PRs require no requirement clarification after design approval.

Future multi-harness qualification shall add metrics for evidence completeness, unexpected policy events, verifier precision/recall/false-blocking, cost, latency, and run-to-run variance on an approved MASWE corpus before making task-quality claims.

## Release acceptance criteria for v0.1

- AC-1: `npm run check` passes on Node 22.
- AC-2: Starting a run with the mock runtime reaches the brainstorm approval gate.
- AC-3: Approving brainstorm reaches the design approval gate.
- AC-4: Approving design with passing commands and verifier reaches `PR_READY`.
- AC-5: A failing quality command routes back to building and increments bounded cycles.
- AC-6: A verifier failure routes back to building.
- AC-7: An in-scope PR comment is resolved, quality-checked, and freshly verified.
- AC-8: An out-of-scope PR comment reaches `WAITING_FOR_HUMAN` without edits.
- AC-9: Invalid events and read-only workspace modifications fail closed.
- AC-10: README, operations, architecture, security, roadmap, and contribution documentation exist.

## Future requirements

Required delivery order is governed by the roadmap and MH-00 design:

- Complete or explicitly disposition #34 before GitHub Phase B obtains repository write authority.
- Complete Issue #3 Phase B: digest-bound approvals, deterministic branch/PR publication, human-approved review lifecycle, and Actions/artifact observation.
- MH-01: harness-neutral domain/configuration/capability/attempt/evidence contracts.
- MH-02: Cursor-preserving harness registry refactor.
- MH-03: deterministic global/project/private/invocation configuration hierarchy.
- Add direct read-only adapters for Claude Code, Codex CLI, Copilot CLI, OpenCode, Hermes Agent, and DeepSeek Harness only after the shared gates and each adapter's own entry gate/owner approval.
- MH-07: govern external writer authority while MASWE retains deterministic commit/publication authority.
- MH-08: assurance profiles and differential verification.
- MH-09 / Issue #4: PostgreSQL/object storage, queue/leases/outbox, API/MCP, and distributed qualified workers only after local attempt/evidence contracts and initial conformance are proven.
- Multi-repository and cross-service change plans.
- Stronger sandboxing and policy-as-code for commands, file scopes, network/process capabilities, and data classes.
