# ADR-0008: Use capability-negotiated multi-harness routing under MASWE authority

- Status: Accepted architecture direction; implementation gated by #3 Phase B, MH-01, and MH-02
- Date: 2026-08-26
- Issue: #32 / MH-00
- BASE_SHA: `23f06f3900598443dc40c65c35336aecda76ea2f`

## Context

MASWE currently executes through `mock`, Cursor CLI, and optional Cursor SDK runtimes while deterministic MASWE code owns workflow transitions, approvals, exact-head evidence, permissions, retries, workspace provenance, Git commits, and publication.

The planned multi-harness programme adds direct adapters for products including Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, Hermes Agent, and DeepSeek Harness. A design that routes only by harness name is unsafe and too weak: one harness can expose materially different transports, protocols, profiles/compositions, providers, models, permissions, memory, skills, sandboxes, retry behavior, workflow engines, and delegation surfaces.

Hermes makes this visible through multiple transports, provider-neutral routing, skills/memory, approvals, Kanban/task behavior, and native delegation. DeepSeek Harness makes it even more explicit through Cordis profiles/compositions, plugin-defined tools and sandboxes, persistence, internal retries, workflows, dynamic packages, and subagent providers. Therefore `harness = X` cannot itself prove what execution MASWE is authorizing.

The completed #27 hardening programme also establishes constraints that multi-harness execution must preserve: exact current-head evidence, explicit revalidation, durable recovery, non-retryable policy violations, exact role permissions, MASWE-owned worktrees, and serialized retry/supersede/cleanup/bootstrap behavior.

## Decision

MASWE will use **capability-negotiated routing over an exact, evidence-bearing attempt identity**.

### 1. MASWE remains the sole authority

Only MASWE authorizes workflow transitions, human approval satisfaction, retry/fallback, attempt creation, workspace identity, evidence acceptance, deterministic commits, Git/GitHub publication, and terminal cleanup policy.

Harness-local approvals, retries, jobs, workflows, task boards, goals, subagents, or completion states are execution evidence or requests. They do not become MASWE workflow authority.

### 2. Separate execution identity dimensions

The attempt contract keeps these dimensions distinct:

- harness;
- adapter generation/runtime executable;
- transport;
- protocol identity/version;
- harness profile/composition and digest;
- provider;
- requested model;
- runtime-resolved/reported model identity;
- model-identity evidence strength;
- reasoning effort;
- requested/effective permissions;
- sandbox and outer-isolation facts;
- ambient-input/hidden-state disposition; and
- evidence completeness.

No silent provider/model switching, transport fallback, profile drift, permission expansion, or unplanned fallback is allowed.

### 3. Route by required capabilities and assurance

A role produces required capabilities and an assurance profile. MASWE evaluates an exact qualified harness/transport/profile/provider/model candidate against those requirements. Unknown, stale, contradictory, or insufficient required facts fail closed.

Product-specific protocol handling belongs inside adapters. The orchestrator must not accumulate harness-name conditionals that imply capability or authority.

### 4. MASWE owns workspaces and publication

MASWE creates/selects the exact-base workspace/worktree, records provenance, assigns it to the attempt, performs outer read-only checks where required, and owns cleanup/recovery.

External harnesses consume that workspace and may not choose another authoritative base, branch, or worktree.

Initial external adapters are read-only. Git commit, push, PR, review, comment, check, and equivalent publication authority stays with MASWE. Future external writers require MH-07 or another explicitly approved contract.

### 5. Preserve raw and normalized evidence

Where available, raw structured harness/session evidence is retained as bounded, redacted, digest-bound evidence. MASWE separately normalizes only supported facts and records completeness/strength rather than inventing missing provenance.

A successful harness exit does not satisfy a role when its assurance profile requires evidence that is absent or too weak.

### 6. Preserve direct versus transitive identity

`MASWE -> Codex` and `MASWE -> DeepSeek Harness -> Codex` are different execution identities. A nested leaf product does not satisfy the direct adapter contract for that product. Every material harness/product layer remains attributable.

### 7. Deny nested authority by default

Native harness delegation, opaque recursive agents, harness workflows/schedulers, internal provider retry planes, mutable procedural memory, and ambient user profiles are disabled initially where possible. Future admission requires explicit, bounded, MASWE-visible contracts.

## Hermes validation

Hermes is the strongest first validation case for this decision.

- `hermes` remains one harness identity across ACP, richer JSON-RPC, or future HTTP/SSE transports.
- ACP is the preferred initial local structured transport direction, behind a Hermes-specific transport abstraction.
- Provider, model, permissions, memory, approval mode, and delegation support are qualified capabilities/profile facts, never assumptions from the harness name.
- Hermes-owned worktree creation is disabled; Hermes consumes the MASWE-owned workspace.
- Initial Hermes execution is read-only and has no Git/publication or native redelegation authority.
- Hermes approvals are subordinate execution safety events.
- Mutable Hermes skills/procedural memory are ambient state; high-assurance verification uses fresh/disabled memory unless explicitly admitted and digest-bound.
- Hermes Kanban/task state is not MASWE's scheduler, retry authority, approval plane, or durable source of truth.
- Differential verification may vary both Hermes and the underlying model/provider, with disagreement preserved as evidence.

If a routing design cannot represent those distinctions without `if harness == hermes` policy assumptions, it does not satisfy this ADR.

## DeepSeek Harness validation

DeepSeek Harness is the second mandatory validation case.

- `deepseek-harness` remains one harness identity across SDK JSON-RPC, ACP, headless, Web, or other transports.
- Cordis profile/composition identity and digest are first-class attempt facts.
- A MASWE-owned conformance profile is required initially; stock/example profiles do not automatically qualify.
- Exact DSH version/executable/source/protocol/profile and effective capability observations are attributable to each governed attempt.
- Fresh process/session/home/persistence/evidence state is required for high-assurance verification unless explicit ambient state is admitted and recorded.
- Initial DSH use is read-only independent verification: no write tools, Git/publication, workflows, native subagents, jobs/goals, dynamic packages/HMR, or internal provider retries.
- DSH sandbox reporting and MASWE outer isolation are separate facts.
- Requested provider/model, runtime-resolved identity, provider-labelled metadata, and stronger attestation are not collapsed.
- Provider retries, compaction/title/auxiliary calls, and nested agents are evidence/accounting facts, not MASWE fallback attempts.
- Raw session-event evidence is retained and normalized with explicit completeness.
- DSH-managed Claude Code/Codex remains transitive DSH execution, not a direct adapter.

If a routing design cannot distinguish two materially different DSH Cordis compositions under the same harness name, it does not satisfy this ADR.

## Consequences

### Positive

- New harnesses can be added without giving them workflow authority.
- Routing policy can express actual role/assurance needs rather than product-name folklore.
- Provider/model/profile drift is visible and policy-checkable.
- Cursor can be migrated behind a registry without changing workflow semantics.
- Hermes and DeepSeek Harness fit the same architecture despite very different composition models.
- Direct and nested product execution remain auditable.
- Local and future distributed workers can share one attempt/evidence vocabulary.
- Assurance profiles can evolve independently from product-specific adapter code.

### Negative

- Adapters must expose more provenance and evidence than a simple `run(prompt) -> text` interface.
- Capability qualification and evidence-completeness logic add implementation surface.
- Some harness features must initially be disabled even when useful, because their authority/evidence contracts are not yet governed.
- Provider/model identity may remain weaker than desired when a transport cannot provide provider-origin attestation; MASWE must report that limitation rather than infer stronger identity.
- Conformance profiles and replay fixtures become required maintenance as external harness protocols evolve.

## Rejected alternatives

### Static harness capability tables

Rejected. They become stale and cannot represent profile/composition, executable, protocol, or runtime drift. Static metadata may describe adapter expectations but cannot replace exact qualification/evidence.

### Product-specific orchestration branches

Rejected. `if hermes ...`, `if dsh ...`, etc. would move execution semantics into the workflow core and make authority/security assumptions difficult to audit.

### Let each harness own its scheduler/worktrees/retries

Rejected. That creates nested authoritative control planes and breaks MASWE's durable recovery, exact-workspace, retry, and cleanup invariants.

### Treat configured model strings as sufficient identity

Rejected. Requested identity, runtime resolution/reporting, and stronger provider evidence have different assurance strength.

### Treat nested Codex/Claude execution as direct adapter execution

Rejected. It hides the controlling harness/profile/permission layer and weakens provenance.

### Start external harnesses as writers

Rejected. Initial read-only adapters give MASWE a smaller qualification/evidence surface. Governed writer authority belongs to MH-07 after the local contracts are proven.

## Implementation ordering

This ADR does not authorize runtime implementation. The approved order is:

1. publish/approve MH-00 (#32);
2. complete #34 as required before GitHub Phase-B write authority;
3. complete remaining #3 Phase B;
4. implement MH-01 harness-neutral contracts;
5. implement MH-02 Cursor-preserving registry refactor;
6. add external read-only adapters;
7. add governed writers only under MH-07; and
8. freeze distributed #4/MH-09 schemas only after local contract/conformance evidence exists.

The detailed normative design is `docs/superpowers/specs/2026-08-26-mh-00-multi-harness-execution-architecture.md`.
