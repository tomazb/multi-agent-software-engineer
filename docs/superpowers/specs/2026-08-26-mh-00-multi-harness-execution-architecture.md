# MH-00: MASWE Multi-Harness Execution Architecture

- Status: Owner-approved architecture publication for Issue #32
- Date: 2026-08-26
- Parent programme: #31
- Related: #3, #4, #13, #27, #34, #36
- BASE_SHA: `23f06f3900598443dc40c65c35336aecda76ea2f`
- Scope: design and planned contracts only; no runtime, schema, adapter, profile, dependency, or control-plane implementation

## 1. Purpose

MASWE is currently a Cursor-first deterministic software-delivery orchestrator. The next architectural step is not to add product-specific branches for Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, Hermes Agent, or DeepSeek Harness. It is to define one harness-neutral execution contract that preserves MASWE as the sole authority for workflow state, approvals, retries and fallback, workspace ownership, evidence acceptance, Git mutation, and publication.

MH-00 publishes that contract. It deliberately separates **what MASWE authorizes** from **how an external harness executes one governed attempt**.

This specification is normative planned-state architecture for later MH-01/MH-02 work. It does not claim that any external harness adapter is implemented today.

## 2. Baseline and post-#27 reconciliation

This document is based exactly on accepted post-hardening `main`:

`23f06f3900598443dc40c65c35336aecda76ea2f`

That baseline contains the completed #28, #29, and #30 hardening programme and is the authority that MH-00 must preserve. In particular:

1. workflow transitions remain centralized and deterministic;
2. evidence is bound to exact current repository/head identity;
3. stale evidence enters explicit revalidation rather than being reused;
4. `CREATED` bootstrap and failed retry have durable recovery semantics;
5. terminal workflow state is distinct from retryable terminal worktree cleanup;
6. read-only mutation, runtime identity mismatch, permission mismatch, and forbidden/unverifiable HEAD movement fail closed outside ordinary model fallback;
7. role permissions are mechanically constrained;
8. prompt insertion and artifact reads are confined and deterministic;
9. isolated-worktree ownership, planned path, recovery, and cleanup are durable and serialized against supersede/cancel/retry races; and
10. deterministic quality, independent verification, merge-ready, and completion evidence remain exact-head requirements.

Multi-harness execution must compose with those semantics; it must not create a second authority plane beside them.

## 3. Scope

MH-00 defines the planned architecture for:

- harness-neutral domain vocabulary;
- capability-negotiated routing;
- exact execution identity and provenance;
- attempt and evidence contracts;
- configuration hierarchy boundaries;
- runtime/profile qualification;
- outer supervision, cancellation, and quiescence;
- ambient-input and hidden-state disposition;
- read-only external harnesses;
- future governed external writers;
- assurance profiles and differential verification;
- local-to-distributed compatibility; and
- concrete validation against Hermes Agent and DeepSeek Harness.

### 3.1 Explicit non-goals

MH-00 does not:

- add an external harness adapter;
- change `src/**`, `test/**`, `schemas/**`, package metadata, workflows, or dependencies;
- authorize Git/GitHub write authority for external harnesses;
- authorize automatic merge;
- choose a final persistence-schema migration strategy for MH-01;
- implement #3 Phase B or #34;
- implement the PostgreSQL/API/MCP control plane in #4;
- adopt any external harness scheduler, retry engine, worktree manager, memory store, approval state, or workflow engine as MASWE authority; or
- treat a nested invocation of Claude Code/Codex/etc. behind another harness as equivalent to MASWE's future direct adapter for that product.

## 4. Architectural principles

### 4.1 MASWE remains the sole control plane

Only MASWE may authorize:

- workflow transitions;
- human approval satisfaction;
- retry and fallback boundaries;
- attempt creation and replacement;
- scope changes;
- workspace/worktree identity;
- deterministic commit creation;
- push/PR/review/comment/check publication;
- evidence acceptance for workflow gates; and
- terminal workflow and cleanup policy.

External harness events are observations, results, requests, or policy violations. They are never workflow events merely because the harness labels them as approvals, retries, tasks, jobs, goals, workflow steps, or completion.

### 4.2 Harness identity is not capability identity

`harness = hermes`, `harness = deepseek-harness`, or any other harness name says only which adapter/runtime family is being used. It does not authorize or imply:

- transport;
- protocol version;
- provider;
- requested or effective model;
- reasoning effort;
- filesystem/network/process permissions;
- profile or composition;
- sandbox strength;
- persistent memory;
- skills/instructions;
- approval behavior;
- retries;
- workflows;
- delegation/subagents;
- Git or publication authority; or
- evidence completeness.

Routing therefore matches **required capabilities and assurance facts** against an exact qualified execution plan, not against a harness-name switch statement.

### 4.3 Exact identity, no silent substitution

Provider, requested model, runtime-resolved model, runtime-reported/provider-reported identity, model-identity evidence strength, harness, transport, protocol, profile/composition, effort, and permissions are distinct fields.

A material identity change during a governed attempt must not be silently absorbed. Unless a later approved contract explicitly models an in-attempt identity transition, a provider/model/profile/transport change ends or invalidates the current attempt and requires a new MASWE-visible attempt.

### 4.4 MASWE owns the workspace

For governed attempts MASWE creates/selects the exact-base workspace or isolated worktree, records its provenance, assigns it to the adapter, fingerprints where required, and owns cleanup/recovery semantics.

An external harness must consume that workspace. It must not create or choose a second authoritative worktree, branch, base, or repository state.

### 4.5 Evidence is attributable, typed, and completeness-aware

Final text is not sufficient evidence for high-assurance roles. MASWE must distinguish raw harness evidence from normalized evidence and record what evidence is complete, partial, inferred, unavailable, or unsupported.

Missing evidence required by the active assurance profile fails closed; it is not converted into successful final text.

## 5. Planned domain vocabulary

The following terms are intentionally separate.

### Harness

The product/runtime family directly invoked by MASWE, such as `cursor-cli`, `claude-code`, `codex-cli`, `copilot-cli`, `opencode`, `hermes`, or `deepseek-harness`.

### Transport

The mechanism by which MASWE communicates with that harness, for example process CLI/stdin, ACP, SDK JSON-RPC over stdio, or a future authenticated HTTP/SSE transport.

Transport is adapter-specific but represented independently from harness identity.

### Protocol identity

The exact protocol name/version or adapter protocol generation used over a transport. Developer-preview or drifting protocols must not hide behind a stable harness name.

### Harness profile / composition

A digest-bound effective configuration that materially determines harness behavior: enabled plugins, tools, skills, sandbox, persistence, model routes, delegation, workflows, retries, approval mode, and other composition facts.

For DeepSeek Harness this includes the Cordis profile/composition. For Hermes it may include a MASWE-owned profile plus explicit skill/memory disposition.

### Provider and model

The requested provider/model and any runtime/provider-reported identity remain distinct. A model string is not provider attestation.

### Capability

A typed property required or observed for one execution plan, such as read-only filesystem policy, structured event stream, cancellation, model identity reporting, tool chronology, fresh profile, or no delegation.

Capabilities have evidence strength; they are not just booleans asserted by configuration.

### Attempt

One MASWE-authorized execution of one role against one exact input state, using one planned harness/transport/profile/provider/model/permission identity.

Fallback creates another MASWE attempt. Harness-local retries or auxiliary calls remain inside the parent attempt only if the active contract explicitly permits and records them.

### Sub-attempt / child execution

A future MASWE-visible child execution created under an approved delegation contract. Opaque harness-native child execution does not become authoritative merely because it exists.

### Ambient input

Any execution input not already represented as explicit role prompt/artifact/workspace data: user/project skills, profile files, instructions, persistent memory, environment-derived settings, sessions, caches, credentials/config selectors, or other mutable state.

### Hidden-state disposition

A typed statement of whether relevant ambient/persistent state is disabled, fresh/empty, declared and digest-bound, isolated but uninspectable, or unknown.

### Model-identity evidence strength

A planned classification that distinguishes at least:

1. **requested-only** — MASWE knows what it asked for;
2. **runtime-resolved** — the harness reports its selected route/model;
3. **runtime-reported/provider-labelled** — the transport/session reports provider/model metadata attributable to the request;
4. **provider-attested** — stronger provider-origin evidence is available; and
5. **cryptographically/externally attested** — future stronger identity evidence where a provider supports it.

Names for levels may be refined in MH-01, but the distinction must remain.

### Evidence completeness

A typed per-dimension assessment, at minimum for prompt correlation, model identity, tool trace, token/accounting data, child lineage, cancellation/quiescence, hidden-state disposition, sandbox enforcement, and raw-log capture.

### Assurance profile

A policy bundle defining the minimum acceptable capability and evidence facts for a role or verification purpose.

## 6. Planned component architecture

```text
Human / GitHub adapter / CLI
            |
            v
+-----------------------------+
| MASWE Orchestrator          |
| state / approvals / policy  |
+-----------------------------+
            |
            v
+-----------------------------+
| Attempt Planner             |
| role requirements + config  |
+-----------------------------+
            |
            v
+-----------------------------+
| Harness Registry            |
| adapters + qualification    |
+-----------------------------+
            |
            v
+-----------------------------+
| Governed Attempt Supervisor |
| workspace / process / time  |
+-----------------------------+
            |
            v
+-----------------------------+
| Harness Adapter             |
| transport-specific bridge   |
+-----------------------------+
            |
            v
      External harness
            |
            v
+-----------------------------+
| Raw evidence + normalizer   |
+-----------------------------+
            |
            v
+-----------------------------+
| Assurance evaluator         |
+-----------------------------+
            |
            v
      Orchestrator result
```

These are logical boundaries. MH-01/MH-02 may map them to a small number of modules initially; they must not introduce unnecessary service boundaries locally.

### 6.1 Orchestrator

The existing orchestrator remains the workflow authority. It asks for an execution result through a harness-neutral operation and consumes only a typed MASWE result/evidence object.

It must not branch on Hermes-, DSH-, Claude-, Codex-, Copilot-, or OpenCode-specific workflow behavior.

### 6.2 Attempt planner

The planner combines:

- role identity;
- exact workspace/head inputs;
- effective MASWE configuration;
- assurance profile;
- requested harness/provider/model/effort;
- required capabilities;
- permissions; and
- permitted fallback candidates.

It produces an immutable planned attempt identity before execution.

### 6.3 Harness registry

The registry maps harness IDs to adapters and exposes qualification/capability facts. It replaces implicit Cursor-specific runtime selection without weakening existing Cursor behavior.

The registry does not decide workflow transitions or fallback. It answers whether a requested exact execution plan can satisfy a required contract.

### 6.4 Qualification/preflight

Qualification is bound to the exact executable/runtime and profile generation it observed. At minimum, planned qualification identity should include where available:

- harness adapter generation;
- harness version;
- executable path and digest;
- source revision/build identity;
- transport/protocol identity and version;
- profile/composition digest;
- plugin/tool-set identity;
- observed capability set; and
- timestamp/expiry or invalidation inputs where policy needs them.

Replacing the executable or material profile invalidates the qualification result.

### 6.5 Governed attempt supervisor

MASWE retains outer supervision even if a harness exposes its own sandbox or lifecycle manager. The supervisor owns:

- exact working directory;
- environment allow/deny policy;
- process-tree lifetime;
- timeout;
- cancellation;
- bounded output/evidence collection;
- before/after fingerprints where required;
- quiescence/orphan checks; and
- final result classification.

### 6.6 Harness adapter

An adapter translates one immutable MASWE attempt into harness-specific transport calls and normalizes returned/session evidence. It may not:

- create MASWE workflow events directly;
- silently choose fallback candidates;
- silently change transport/profile/provider/model;
- claim approval authority;
- claim publication authority; or
- adopt a harness-local workspace as authoritative.

### 6.7 Evidence normalizer

Raw harness evidence is retained when policy requires it and separately projected into a stable MASWE vocabulary. Normalized evidence must be traceable to the raw evidence digest/source and must not overstate absent facts.

### 6.8 Assurance evaluator

The evaluator compares normalized evidence/capabilities to the role's assurance profile. A successful harness exit can still fail the governed attempt if required evidence is absent, inferred when stronger proof is required, or contradicts the planned identity.

## 7. Capability-negotiated routing

Routing is a deterministic policy operation.

### 7.1 Inputs

A routing request includes:

- role;
- requested harness or allowed harness candidates;
- requested provider/model/effort when specified;
- permission profile;
- assurance profile;
- required capabilities;
- exact workspace/head identity;
- allowed fallback sequence; and
- effective configuration source identities.

### 7.2 Algorithm

For each MASWE-authorized candidate in order:

1. Resolve the exact harness adapter.
2. Resolve the exact transport/protocol and profile/composition required by policy.
3. Resolve provider/model/effort without silent substitution.
4. Load or perform qualification bound to that exact executable/profile.
5. Compare required capabilities against qualified/observed capabilities.
6. Compare assurance-profile requirements against available evidence strength.
7. Reject unknown, contradictory, stale, or insufficient facts fail closed.
8. Persist/construct the immutable planned attempt identity.
9. Execute through the governed supervisor.
10. Classify the result as success, retryable runtime failure, non-retryable policy failure, or another explicit planned outcome.
11. Only MASWE decides whether another configured candidate becomes a new attempt.

### 7.3 No harness-name conditionals

Product-specific adapters naturally contain product-specific protocol code. The orchestrator and routing policy must not encode rules such as:

```text
if harness == hermes then allow delegation
if harness == deepseek-harness then assume JSON-RPC
```

Those properties are capabilities/profile facts of an exact execution plan.

## 8. Planned configuration hierarchy

MH-03 will define the precise file/API grammar. MH-00 sets these constraints:

1. configuration may have global, project, private/local, and invocation layers;
2. precedence must be deterministic and inspectable;
3. security-reducing overrides must be constrained by policy, not merely precedence;
4. the effective attempt configuration is snapshotted/digest-bound where reproducibility requires it;
5. secrets remain references/environment/secret-store inputs, not durable plaintext profile artifacts;
6. ambient harness user configuration is not implicitly authoritative; and
7. no layer may silently substitute provider/model/transport/profile when the higher-level request is exact.

A likely precedence is invocation > private/local > project > global for ordinary preferences, with non-overridable policy ceilings/floors applied separately. MH-03 owns the final syntax and merge semantics.

## 9. Planned attempt contract

MH-01 will choose exact TypeScript/schema representation. The planned contract must be able to express at least:

### MASWE identity

- run ID;
- stage/state generation;
- role;
- attempt ID and ordinal;
- parent attempt/sub-attempt identity where applicable;
- created/started/completed timestamps.

### Repository/workspace identity

- repository identity;
- workspace/worktree path;
- branch where applicable;
- source/base SHA;
- input HEAD;
- evaluated/output HEAD;
- pre/post fingerprints appropriate to the role;
- workspace ownership/isolation mode.

### Harness identity

- harness ID;
- adapter generation/version;
- executable identity and digest where available;
- source/build revision where available;
- transport;
- protocol identity/version;
- profile/composition identity and digest;
- plugin/tool-set identity where relevant.

### Model route identity

- requested provider;
- requested model;
- requested effort;
- runtime-resolved provider/model/effort;
- provider/runtime-reported identity;
- identity-evidence strength;
- provider request/session IDs where safely available.

### Policy and capabilities

- requested permissions;
- effective permissions;
- required capabilities;
- qualified/observed capabilities and evidence source;
- sandbox policy/backend;
- sandbox enforcement completeness;
- MASWE outer-isolation profile;
- approval behavior;
- retry policy;
- delegation/workflow policy.

### Ambient/hidden state

- ambient-input manifest or digest;
- skill/instruction identities where admitted;
- memory/session/profile state disposition;
- environment disposition;
- fresh-home/fresh-session facts where required.

### Execution accounting

- prompt/session correlation;
- provider calls;
- harness-local retries if admitted;
- auxiliary model calls;
- token/cost usage where available;
- tool chronology/evidence;
- child lineage;
- cancellation outcome;
- process quiescence outcome.

### Evidence

- raw evidence/log references and digests;
- normalized evidence version;
- per-dimension completeness;
- final harness result;
- MASWE policy/assurance verdict.

The contract must preserve the difference between **planned**, **reported**, and **attested** facts.

## 10. Raw and normalized evidence

### 10.1 Raw evidence

Where a harness provides structured session/event output, MASWE should retain a bounded, redacted, immutable raw evidence object/file and its digest. It must not persist secrets merely because a harness emitted them.

### 10.2 Normalized evidence

The normalizer projects only facts supported by the raw transport or MASWE's own observation. Examples:

- prompt/session correlation;
- model/provider route;
- tool calls and results;
- permission/approval requests;
- retries and auxiliary calls;
- token usage;
- child creation;
- cancellation;
- terminal result.

### 10.3 Completeness

Each dimension records one of a small explicit set such as `complete`, `partial`, `inferred`, `unavailable`, or `not-applicable`. Exact enum names belong to MH-01.

A verifier profile might require complete prompt correlation and raw-log capture while accepting runtime-reported model identity; an adversarial profile might require stronger identity evidence and fresh-state proof.

## 11. Read-only policy and future writer authority

### 11.1 Initial external adapters

Claude Code, Codex CLI, Copilot CLI, OpenCode, Hermes, and DeepSeek Harness all begin with read-only roles/qualification. Exact initial role enablement may differ per adapter, but no external writer is implied by adding an adapter.

MASWE's existing outer read-only fingerprint and HEAD fence remains authoritative. An inner harness sandbox is defense in depth/evidence, not a replacement.

### 11.2 Governed writers (MH-07)

Writer authority requires a separate approved contract. It must address at least:

- exact allowed file/path scope;
- single-writer worktree ownership;
- before/after provenance;
- tool/command permissions;
- deterministic commit authority remaining in MASWE;
- unexpected Git mutation classification;
- publication remaining in MASWE/GitHub adapter; and
- concurrency with retry/supersede/cleanup.

The external harness may edit files under policy, but MASWE remains the commit and publication authority.

## 12. Approval semantics

Harness permission prompts and approvals are subordinate execution safety interactions.

A harness may report:

- a requested permission;
- a denied/approved local operation;
- an approval requirement it cannot satisfy; or
- a blocked operation.

MASWE records these as attempt evidence/request outcomes. They do not satisfy brainstorm/design approval, authorize fallback, expand permissions, approve publication, or transition workflow state.

If future integration requires human mediation of a harness permission request, MASWE must expose that request through an explicit MASWE operation and resume the same governed execution only when the contract can preserve correlation and authority.

## 13. Skills, instructions, memory, and hidden state

### 13.1 Governed skills

MASWE/Superpowers governance skills or prompts used as authoritative instructions are versioned/digest-bound inputs. A harness must not rewrite those and then rely on the modified version as authoritative policy.

### 13.2 Mutable harness skills/procedural memory

Harness-created skills, procedural memories, user profiles, cached instructions, and similar state are ambient input unless explicitly admitted. High-assurance attempts should disable them or use a fresh profile/home.

### 13.3 Workspace instructions

Workspace-local instructions may affect execution. They must either be part of explicit repository/workspace input and fingerprint/provenance, or be disabled/declared according to the assurance profile. A harness must not load additional unrecorded instruction roots silently.

## 14. Delegation and nested execution

Native redelegation is denied by default.

A future governed delegation contract must make each material child execution MASWE-visible with:

- parent/child identity;
- harness/product chain;
- provider/model identity;
- permissions;
- workspace scope;
- cost/accounting;
- cancellation;
- evidence;
- failure semantics; and
- bounded depth/count.

Opaque recursive swarms are outside the architecture.

### 14.1 Direct versus transitive identity

These are different:

```text
MASWE -> Codex
MASWE -> DeepSeek Harness -> Codex
```

The second is a DeepSeek Harness attempt with a nested Codex product execution. It does not satisfy the future direct Codex adapter contract. Evidence retains all layers rather than collapsing to the leaf product.

The same rule applies to Hermes or any harness that can delegate to another agent/product.

## 15. No nested authoritative scheduler

Harness-native task boards, workflow engines, jobs, goals, retry planes, or schedulers must not become MASWE's workflow engine.

Initially these surfaces are disabled where possible. Unexpected use under a profile that forbids them is a policy violation.

Later admission can expose them only as bounded execution mechanics whose events are attributable within a MASWE attempt. MASWE still owns transition state, retry/idempotency, approvals, attempt creation, evidence acceptance, and publication.

## 16. Assurance profiles

MH-08 will define exact profiles. MH-00 requires at least these conceptual modes:

### Standard

Suitable for ordinary bounded role execution where configured/runtime-reported identity and normal outer supervision are sufficient.

### Reproducible

Requires stronger configuration/profile digest binding, declared ambient inputs, deterministic/fresh execution state where practical, and complete raw evidence needed to reproduce the attempt conditions.

### Independent verification

Requires read-only execution, fresh/isolated state from the builder where practical, no undeclared persistent memory, no native delegation, and evidence adequate to establish which code/head was inspected and which model route produced the verdict.

### Adversarial verification

Adds stronger isolation/identity/completeness requirements and may intentionally vary harness and provider/model to reduce correlated failure modes.

A profile is a minimum contract. A harness is eligible only when its exact qualified execution plan can satisfy every required fact.

## 17. Differential verification

MASWE should preserve disagreements, not collapse them into implicit consensus.

MH-08 must support experiments that vary independently:

- model while holding harness approximately constant;
- harness while holding model family/provider approximately constant where possible;
- harness profile/composition while holding other factors constant; and
- both harness and model.

Each verifier produces attributable evidence and a separate verdict. MASWE policy decides whether disagreement blocks, escalates, or requests another verification attempt.

## 18. Hermes Agent validation case

Hermes is the strongest concrete MH-00 validation case because one harness can expose multiple transports, providers, models, skills/memory modes, approvals, and native delegation.

### 18.1 Initial transport direction

Prefer ACP as the initial local structured transport direction, behind a Hermes-specific transport abstraction. The adapter contract must allow later evaluation of richer JSON-RPC and future HTTP/SSE transports without changing `harness = hermes` or the harness-neutral attempt contract.

Transport changes are material execution identity facts, not separate harness identities.

### 18.2 Workspace authority

Hermes-owned automatic worktree creation is disabled for governed attempts. Hermes starts in the exact MASWE-assigned workspace and may not select another base/branch/worktree.

### 18.3 Initial permissions

Hermes starts read-only from MASWE's authority perspective. It has no commit, push, PR, review/comment/check publication, or native redelegation authority.

### 18.4 Model/provider route

The exact requested provider/model remains distinct from Hermes runtime-reported identity. Hidden provider/model switching is forbidden. A material identity change requires a new MASWE attempt unless a later approved identity-transition contract exists.

### 18.5 Approvals

Hermes permission/approval requests are execution evidence subordinate to MASWE. They cannot authorize a workflow transition or privilege expansion.

### 18.6 Skills and memory

Governed MASWE/Superpowers skills remain immutable/digest-bound inputs. Hermes mutable procedural memory or self-created skills are ambient state and are disabled/fresh for high-assurance verification unless explicitly admitted and recorded.

### 18.7 Delegation and Kanban

Hermes native delegation is denied initially. Hermes Kanban/task-board state is not MASWE scheduler, workflow authority, retry authority, durable source of truth, or approval plane.

### 18.8 Differential verification

Hermes can later be an independent verifier where the assurance profile proves the exact harness/provider/model/profile identity and hidden-state disposition. Disagreement with other harnesses remains evidence for MASWE adjudication.

## 19. DeepSeek Harness validation case

DeepSeek Harness (DSH) is the second mandatory validation case. Its Cordis composition makes explicit why one harness name cannot define capabilities.

### 19.1 Harness, transport, and profile

`deepseek-harness` remains one harness identity across SDK JSON-RPC, ACP, headless, Web, or future transports. Cordis profile/composition identity is a first-class digest-bound attempt fact.

Stock Web, headless, Python SDK, bundled-default, or example JSON-RPC profiles do not automatically qualify as governed profiles.

### 19.2 Initial transport/process direction

Use an external process boundary. Prefer structured SDK JSON-RPC over stdio, or a narrowly scoped MASWE-specific bridge if the stock protocol cannot satisfy prompt correlation, cancellation/evidence, and identity requirements.

### 19.3 Runtime/profile provenance

Every governed attempt must be able to record the selected exact DSH version, executable digest, source/build revision where available, protocol identity/version, Cordis profile digest, plugin set where available, and effective capability set.

Qualification is invalid if the executable or profile changes.

### 19.4 MASWE-owned conformance profile

The initial adapter uses a dedicated MASWE-owned profile with a minimal plugin/tool surface. Profile bytes/identity are digest-bound into attempt evidence.

### 19.5 Fresh-state discipline

Independent/reproducible attempts use a fresh process, session, home, persistence root, and evidence directory. Ambient user/project skills, mutable settings, persistent session reuse, and workspace instruction loading are disabled initially unless later admitted by explicit digest-bound policy.

### 19.6 Permissions and sandbox

Initial DSH use is read-only independent verification. Filesystem writes, Bash/write tools, Git mutation, publication, workflows, native subagents, jobs, goals, dynamic Cordis packages, HMR, and internal provider retries are disabled initially.

DSH sandbox facts are recorded separately from MASWE outer isolation. An inner filesystem sandbox does not itself prove network/process/OS isolation.

Unexpected write-tool, retry, workflow, delegation, or dynamic-package events are policy violations under the initial profile.

### 19.7 Model identity evidence

Requested provider/model, DSH runtime-resolved provider/model, provider-labelled metadata, and stronger provider attestation are distinct. Request headers or assistant/session provenance must not be overstated as independent provider attestation.

### 19.8 Retries and auxiliary calls

Provider retries, compaction calls, title-generation calls, or similar auxiliary requests are not MASWE fallback attempts. They must be visible/accounted if admitted. Initial DSH profile disables internal provider retries to keep the first contract unambiguous.

### 19.9 Structured evidence

Retain a bounded/redacted raw DSH session-event log and digest. Normalize prompt/session correlation, request identities, assistant/tool chronology, token use, provider request IDs where available, retries, auxiliary calls, child events, approval/sandbox facts, and terminal state.

### 19.10 Cancellation and quiescence

The contract records whether prompt-level cancellation is supported. Regardless, MASWE owns bounded outer cancellation and process-tree quiescence. A fresh one-process/one-session/one-prompt profile is an acceptable initial direction if its limitation is explicit.

### 19.11 Transitive products

DSH-managed Claude Code/Codex children remain nested under a DSH attempt. They do not satisfy direct Claude Code or Codex adapter assurance.

### 19.12 Privacy and telemetry

The conformance profile explicitly dispositions telemetry, persistent anonymous identity, provider/model-hidden headers, credential resolution, environment inheritance, persistence roots, and network egress. Custom gateways are treated as recipients of adapter-added transport metadata unless proven otherwise. Secrets do not enter durable profile artifacts/evidence.

## 20. Other planned direct adapters

### Cursor

MH-02 first refactors the current runtime selection into the harness registry without semantic drift. Existing `mock`, `cursor-cli`, and optional `cursor-sdk` behavior remains the compatibility oracle.

### Claude Code

Initial direct adapter is read-only. The adapter must qualify exact CLI/protocol capabilities, deny native delegation/write/publication not covered by the role, preserve direct-vs-transitive identity, and normalize available model/tool/session evidence without assuming it is complete.

### Codex CLI

Initial direct adapter is read-only. MASWE controls the assigned workspace, permissions, attempt boundary, and evidence acceptance. A direct Codex attempt is distinct from Codex invoked behind another harness.

### GitHub Copilot CLI and OpenCode

Both begin read-only and must expose exact capability/profile facts through the same registry contract. Product-specific feature differences are adapter capabilities, not orchestrator branches.

## 21. Error and retry model

MH-01 must preserve the #29 distinction between policy failures and retryable runtime/provider failures.

Planned classes include:

- qualification/capability mismatch — non-retryable for that planned candidate;
- identity mismatch or unplanned substitution — policy failure;
- permission or unexpected mutation — policy failure;
- evidence-completeness failure — assurance/policy failure;
- malformed protocol/evidence — typed adapter/runtime failure, normally not silently retried through a different identity unless MASWE fallback policy says so;
- provider unavailable/transient execution failure — potentially retry/fallback eligible under bounded MASWE policy;
- timeout/cancellation/quiescence failure — typed and evidence-bearing; and
- unexpected nested retry/workflow/delegation — policy failure when forbidden by profile.

Harness-local error labels do not decide MASWE retry policy.

## 22. Security and privacy model

The multi-harness boundary expands the attack and drift surface. Planned security requirements are:

1. exact executable/profile qualification;
2. fail-closed unknown capabilities;
3. least privilege per role;
4. MASWE-owned workspace and outer read-only verification;
5. no hidden model/provider/transport/profile substitution;
6. explicit ambient-input/hidden-state disposition;
7. no ungoverned native delegation/workflows/retries;
8. bounded/redacted evidence collection;
9. secrets separated from durable profiles/evidence;
10. no external publication authority before MH-07;
11. transitive execution identity retained; and
12. cancellation reaches bounded process-tree quiescence or the attempt fails.

A harness-reported sandbox is evidence about one enforcement layer, not a blanket security claim.

## 23. Local and distributed compatibility

The local attempt/evidence contract is the architecture boundary that MH-09/#4 later transports across workers.

Distributed execution may add:

- leases;
- queue delivery;
- transactional state transitions;
- object storage;
- service identity;
- remote cancellation;
- outbox/idempotency; and
- API/MCP authorization.

It must not change the semantic distinction between MASWE workflow authority and harness execution. A local ACP/stdio attempt and a future remote HTTP/SSE attempt should normalize into the same domain contract where their capabilities overlap.

Do not freeze distributed worker schemas until MH-01/MH-02 and initial adapter conformance demonstrate which facts are truly stable.

## 24. Conformance testing strategy

Every external adapter must qualify deterministically before live-provider claims.

### 24.1 Common adapter conformance

At minimum:

- success and explicit failure;
- unknown capability;
- executable/profile drift;
- requested/reported identity mismatch;
- malformed/truncated protocol;
- early exit;
- hang/timeout;
- cancellation;
- orphan prevention/quiescence;
- read-only mutation attempt;
- unexpected tool exposure;
- missing required evidence;
- raw/normalized evidence traceability; and
- fallback boundary producing a new MASWE attempt rather than hidden substitution.

### 24.2 Replay/fake runtime first

Adapters with structured protocols should have replay fixtures or fake runtimes so protocol/evidence normalization is testable without credentials.

### 24.3 Live qualification

Live provider tests come only after deterministic conformance. Published quality claims should report a MASWE-specific corpus and metrics such as precision/recall for verifier findings, false blocking, cost, latency, evidence completeness, and run-to-run variance.

## 25. Delivery programme and ordering

The approved order is:

1. **MH-00 / #32** — publish this architecture and ADR-0008.
2. Complete **#34** before #3 Phase B relies on stable repository identity for GitHub write authority.
3. Complete remaining **#3 Phase B** before multi-harness runtime implementation.
4. **MH-01** — harness-neutral domain/config/capability/attempt/evidence contracts.
5. **MH-02** — Cursor-preserving registry refactor; no behavior expansion.
6. **MH-03** — global/project/private/invocation configuration hierarchy.
7. **MH-04** — Claude Code read-only adapter.
8. **MH-05** — Codex read-only adapter.
9. **MH-06** — Copilot CLI and OpenCode read-only adapters.
10. **MH-06H** — Hermes read-only adapter.
11. **MH-06D / #36** — DeepSeek Harness read-only adapter and MASWE conformance profile.
12. **MH-07** — governed external writers.
13. **MH-08** — assurance profiles and differential verification.
14. **MH-09 / #4 alignment** — distributed PostgreSQL/API/MCP execution plane after local contracts are proven.

Independent adapter tranches may be ordered differently among MH-04/MH-05/MH-06/MH-06H/MH-06D once their shared gates are complete, but no adapter may bypass MH-01/MH-02 or #3 Phase B.

## 26. Reconciliation matrix against final #27 behavior

| Final #27 invariant | MH-00 preservation rule | Later implementation home |
| --- | --- | --- |
| Centralized workflow transitions | Harness results never mutate workflow directly | MH-01/MH-02 |
| Exact current-head evidence | Every attempt records exact workspace/head identity; assurance evidence binds to it | MH-01 |
| Explicit revalidation after head movement | Harness execution cannot reuse stale generation evidence | MH-01 + existing core |
| Durable CREATED bootstrap/retry | External harness consumes MASWE-owned recovered workspace only after core recovery | MH-02/adapters |
| Non-retryable policy violations | Identity/permission/mutation/evidence violations bypass ordinary fallback | MH-01 |
| Exact role-permission matrix | Harness permissions derive from role policy/capabilities and cannot expand it | MH-01/MH-02 |
| Read-only HEAD/fingerprint fence | MASWE outer fence remains authoritative around read-only harness attempts | MH-02/adapters |
| Single-pass prompt/artifact confinement | Adapters receive already-governed inputs; raw evidence has separate bounded storage rules | MH-01/adapters |
| Exact glob/write scope | Future external writers are subordinate to MASWE path/write policy | MH-07 |
| Terminal state independent of cleanup | Harness completion does not own worktree cleanup | existing core + MH-02 |
| Durable planned worktree ownership | Harness cannot replace/relocate the assigned workspace | MH-02/adapters |
| Serialized cleanup/retry/supersede/bootstrap | External execution acquires no parallel cleanup/workspace authority | existing core + MH-02 |
| Exact merge-ready/completion evidence | Harness success alone never satisfies final gates | existing core + MH-08 |

No MH-00 rule weakens these existing contracts.

## 27. Planned documentation reconciliation

The repository's planned-state documents should align on these statements:

### PRD

Add a multi-harness product requirement that routing is capability-negotiated, attempt identity is explicit, external harnesses are subordinate execution workers, and initial adapters are read-only. Clarify that current implemented runtimes remain Cursor/mock only.

### Architecture

Add the harness registry/attempt planner/supervisor/evidence-normalizer/assurance boundary and preserve the existing orchestrator/state/store/GitHub authority layers.

### Security

Add exact harness/profile/executable provenance, ambient-state discipline, outer isolation, transitive identity, no hidden fallback/delegation/workflow/retry planes, and evidence-completeness failure behavior.

### Roadmap

Mark #27 complete, MH-00 as the current architecture tranche, #34 before GitHub write authority, #3 Phase B before multi-harness runtime implementation, then MH-01/MH-02 and read-only adapters.

### Artifact contracts

Planned attempt/evidence vocabulary must distinguish planned/requested/reported/attested facts; raw versus normalized evidence; harness/transport/profile identity; ambient state; nested product chain; local retry/auxiliary calls; isolation; and completeness. Existing schema-v1 run/artifact semantics remain authoritative until an implementation issue approves exact persistence changes.

## 28. Exact proposed amendment for Issue #4

After MH-00 approval, update #4 so its durable-control-plane scope is explicitly harness-neutral and depends on proven local contracts. Proposed amendment:

> ### Multi-harness dependency and execution contract
> 
> Issue #4 / MH-09 implements distributed persistence and execution **after** MH-01 and MH-02 establish the local harness-neutral attempt/evidence contract and at least initial read-only adapter conformance exists. The distributed plane must persist and transport the same separation of MASWE workflow authority from harness execution.
> 
> Distributed run/attempt records must preserve exact harness, adapter, transport/protocol, profile/composition, provider/model, permission, workspace/head, ambient-input, isolation, retry/auxiliary-call, raw-evidence, normalized-evidence, child-lineage, and evidence-completeness facts required by the active assurance profile. Direct and transitive product identity must remain distinct.
> 
> Workers may execute qualified harness adapters under leases, but external harnesses do not gain workflow-transition, approval, fallback, Git-publication, or scheduler authority. Transactional outbox/idempotency applies to MASWE side effects; a harness-native scheduler/workflow/retry plane is not a substitute.
> 
> The API and MCP surface expose authorized MASWE operations and attempt/evidence inspection, not raw authority to mutate workflow state through harness-specific commands. Distributed transport may support local/cloud/self-hosted adapters, including future HTTP/SSE transports, without changing harness identity or the common attempt contract.
> 
> Do not freeze PostgreSQL/worker schemas until local MH-01/MH-02 contracts and initial conformance evidence have demonstrated the stable fields and completeness semantics.

No #4 implementation is authorized by MH-00.

## 29. Decisions deliberately deferred

The following are implementation-design decisions, not MH-00 architecture gaps:

- exact TypeScript type names and JSON schema layout;
- whether new persisted attempt data is additive schema-v1-compatible or requires a later schema version/migration;
- exact capability enum/ontology;
- exact evidence-completeness enum names;
- exact model-identity evidence-level names;
- final config file locations/syntax for MH-03;
- exact transport selected for each adapter after qualification;
- whether Hermes ACP meets all correlation/evidence requirements without a bridge;
- whether stock DSH JSON-RPC is sufficient or a MASWE bridge is needed;
- exact sandbox technology for each platform;
- distributed wire/storage schema; and
- future bounded delegation contract.

Each must be resolved in its owning implementation/design tranche without weakening the invariants here.

## 30. MH-00 acceptance mapping

| Issue #32 requirement | Coverage |
| --- | --- |
| Exact post-#27 baseline | Header and §2 |
| Harness-neutral design | §§4–10 |
| Hermes mandatory validation | §18 |
| DeepSeek Harness mandatory validation | §19 |
| Capability-negotiated routing | §7 |
| Exact profile/transport/provider/model separation | §§5, 7, 9 |
| Workspace/Git/publication authority | §§4.4, 11 |
| Approval semantics | §12 |
| Skills/memory/ambient state | §13 |
| Delegation/transitive identity | §14 |
| No nested scheduler | §15 |
| Assurance profiles/differential verification | §§16–17 |
| Raw/normalized evidence and completeness | §§9–10 |
| Cancellation/quiescence | §§6.5, 19.10, 24 |
| Privacy/telemetry | §§22, 19.12 |
| Deterministic conformance | §24 |
| Final #27 reconciliation matrix | §26 |
| PRD/architecture/security/roadmap/artifact wording | §27 plus aligned repository docs in this tranche |
| Exact proposed #4 amendment | §28 |
| Runtime implementation not authorized | §§1, 3, 25 |

## 31. Conclusion

MASWE should evolve from Cursor-first runtime adapters to a **capability-negotiated, evidence-bearing harness execution layer**, not to a collection of product-specific control planes.

The durable boundary is:

> MASWE authorizes one exact attempt; a qualified harness executes it inside the assigned workspace; MASWE observes and evaluates attributable evidence; only MASWE decides what workflow action follows.

That boundary accommodates simple CLIs and composable agent harnesses such as Hermes and DeepSeek Harness without surrendering the workflow, security, provenance, and exact-head guarantees established by #27.
