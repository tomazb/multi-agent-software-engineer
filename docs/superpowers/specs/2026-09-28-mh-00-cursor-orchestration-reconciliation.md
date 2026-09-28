# MH-00 reconciliation: Cursor-native orchestration

- Date: 2026-09-28
- Status: Planned architecture clarification for #51, #31, and MH-01 / #50; no runtime authorization
- Current `main` examined: `eccc98b3ffb858a988fb7c68c37c687882191540`
- Historical MH-00 baseline: `23f06f3900598443dc40c65c35336aecda76ea2f`
- Governing design: [MH-00](2026-08-26-mh-00-multi-harness-execution-architecture.md) and [ADR-0008](../../adr/0008-capability-negotiated-multi-harness-routing.md)

## Purpose and scope

Cursor is MASWE's existing execution runtime, but Cursor also exposes its own delegation,
workspace, cloud, context, hook, and event-triggered orchestration surfaces. This note tests the
already approved MH-00 authority and provenance rules against that concrete product. It does not
rewrite the historical MH-00 specification, authorize a new Cursor mode, alter current CLI/SDK
behavior, or change the order of #3 Phase B, post-merge exact-head revalidation, MH-01, and MH-02.
Issue #49 retains the separate current Cursor SDK deadline/quiescence defect; #42 retains its
planned-harness identity-list scope.

The two execution shapes have different governance implications:

```text
MASWE -> Cursor direct role invocation
MASWE -> Cursor parent/coordinator -> Cursor child -> Cursor grandchild
                               \-> Cursor background or cloud child
```

In the second shape, the parent is one MASWE-governed attempt. Its descendants are transitive
Cursor executions, never several independent MASWE role approvals or direct adapters. A later
approved delegation profile may expose children as MASWE-visible sub-attempts. Cursor Projects,
Automations, and subscriptions remain external schedulers/triggers; their decisions cannot
authorize MASWE transitions, retries, approvals, Git publication, or evidence acceptance.

## Cursor capabilities relevant to the contract

These are vendor-documented product capabilities, not assertions that the current MASWE adapters
expose them or that an operator can reliably disable each one in every transport.

| Cursor surface | Documented behavior | MH-00 contract exercised |
|---|---|---|
| Subagents | Foreground/background, parallel and bounded nested delegation; per-subagent model configuration can fall back under plan/admin limits | Parent/child/grandchild identity, observed model, concurrent settlement, accounting |
| Isolation and cloud | Subagents may use separate Git worktrees/branches or cloud VMs/clones | MASWE-owned exact-base workspace, branch/head provenance, mutation/publication boundaries |
| Projects | Coordinator delegates to agents; project files synchronize context across agents; subscriptions observe PR/CI/Slack/schedules | No nested authority, declared context, attributable external triggers |
| Automations | Schedules and GitHub/GitLab/Slack/webhook/Linear events can start Cloud Agents | External ingress through MASWE authorization; no implicit MASWE run or approval |
| Skills and rules | Project/user skills, including Claude/Codex compatible directories; personal Cursor skills can be cloud-synced | Effective context manifest and hidden-state disposition |
| Hooks | Tool/subagent lifecycle hooks can block some actions; `failClosed` is opt-in for hook failures | Hook observations as evidence; outer MASWE policy remains authoritative |
| Python SDK run | Local background-child results return in later turns; `run.wait()` drains those turns | Distinguish parent turn/terminal indication from governed attempt settlement |

Cursor's documented controls differ across local, cloud, IDE, CLI, and SDK surfaces. Qualification
must bind the exact product/version, transport, configuration, environment, and evidence source.
An undocumented or unproven denial/control is `unknown`, not an effective permission claim.

## Governing interpretation

1. **Authority.** MASWE chooses the role, approved artifacts, capability/assurance policy,
   attempt boundary, retry/fallback, and any publication. Cursor-owned coordinator or automation
   decisions are inputs or observations until a MASWE public operation validates them.
2. **Lineage and identity.** Record the parent/child relation, local/background/cloud mode,
   requested model and observed model with evidence strength, permission scope, runtime/executable
   and transport identity, and relevant session correlation. A configured model is not proof of
   the model actually used, especially when Cursor reports a fallback.
3. **Workspace.** MASWE selects the authoritative exact-base workspace. A Cursor-created
   branch/worktree or cloud clone cannot silently replace it or be published as the MASWE branch.
   If a later profile admits an isolated child workspace, its parent/base/branch/head, owner,
   mutation scope, integration boundary, and cleanup must be explicitly governed and observed.
4. **Context.** The attempt context manifest must identify the effective rules, `AGENTS.md`,
   project skills, inherited `.claude/skills/` and `.codex/skills/`, user/global skills, cloud
   synchronization, hook definitions, and Project shared-context inputs as applicable. Record
   disabled, fresh, declared/digest-bound, or unknown disposition for ambient inputs. A digest
   of repo files alone does not establish the absence of user or cloud context.
5. **Settlement.** A parent answer, a hook stop event, an SDK terminal status, a cancellation
   acknowledgement, or a child result alone cannot settle the governed attempt. MH-01 must
   classify admitted children, pending follow-up turns, late tools, cancellation propagation,
   process/workspace quiescence, raw-evidence flush, and post-execution workspace state before
   assurance acceptance. A child failure or local retry is recorded under the parent and does
   not itself create a MASWE fallback attempt.
6. **Evidence.** Hook output, SDK events, project/subagent state, and external trigger metadata
   are raw or normalized evidence at their actual strength. MASWE independently applies outer
   HEAD/fingerprint, policy, digest, and publication checks. A hook configured `failClosed` is
   useful inner enforcement, but does not attest that every transport ran it or that a process
   tree has stopped.

## Planned initial governed Cursor profile

This is a qualification target for MH-01/MH-02 and later profile work, not a change to the
implemented `cursor-cli` or `cursor-sdk` paths. MH-02 must preserve their approved observable
behavior. If the exact Cursor transport cannot demonstrate a required restriction, that candidate
is ineligible for the high-assurance profile; a prompt or self-report does not qualify it.

| Surface | Initial high-assurance policy target |
|---|---|
| Native child delegation and background work | Denied unless separately approved with MASWE-visible lineage, bounded cancellation, settlement, and evidence |
| Cursor-created worktree/branch/cloud clone | Denied as authoritative workspace; separately governed child isolation requires exact provenance and integration rules |
| Projects coordinator, subscriptions, Automations | No MASWE workflow/approval/retry authority; triggers enter through an authenticated MASWE operation |
| Persistent Project context; personal/global/cloud-synced skills and rules | Undeclared material input is ineligible; disable/freshen or explicitly declare and digest-bind under the assurance profile |
| Hooks | Allowed only as qualified inner evidence/enforcement; no reliance on default fail-open behavior for a required outer gate |
| Git commits, push, PR/review/comment publication | MASWE authority only; Cursor output is a proposed change/evidence until MASWE validates and publishes |

The enforcement mechanism and evidence required to qualify each target remain MH-01 design and
adapter-conformance decisions. Neither current Cursor adapter is asserted to implement this
profile, and no profile or schema is added here.

## MH-01 validation cases

The MH-01 design should use deterministic fixtures and capability claims for the following cases,
then MH-02 should map the current Cursor CLI/SDK behavior without semantic drift. Live Cursor
qualification is supplemental to deterministic contract tests.

| MH-01 area | Cursor case and required distinction |
|---|---|
| R1 identity | Direct local role versus parent/child/grandchild; local versus cloud; requested versus observed child model and permission; parent/base/head/worktree identity |
| R2 settlement | Parallel foreground and background children, one late follow-up turn after a parent answer, failed child, and raw evidence still draining; no premature parent settlement |
| R3 cancellation | Deadline during background work, child cancellation failure, late tool/write, and orphan/quiescence classification; #49 remains the current SDK fix |
| R4 context | Repo rules/skills, inherited Claude/Codex skills, personal/cloud-synced skills, hooks, and persistent Project files recorded or explicitly excluded |
| R5 invalidation | Changed skill, rule, Project file, hook, model entitlement/fallback, permission, workspace HEAD, or approved artifact invalidates relevant qualified context |
| R6 evidence | Missing child event, model fallback, hook failure, partial cloud trace, or unverifiable worktree yields typed completeness/strength rather than fabricated proof |
| R7 child boundary | Foreground/background/nested child creation and concurrent settlement only under an approved bounded delegation profile; unexpected children violate a no-delegation profile |
| R8 conformance | Replay terminal, late-turn, failure/retry, cancellation, unexpected child/worktree, and trigger events through the normal supervisor/normalizer/assurance path |
| R9 compatibility | Existing `mock`, Cursor CLI, and Cursor SDK paths preserve current exact-head, permissions, retries, worktree, terminal-marker, and publication semantics |

## Sources and follow-up

Cursor documentation checked 2026-09-28: [Subagents](https://cursor.com/docs/subagents),
[Worktrees](https://cursor.com/docs/configuration/worktrees),
[Projects](https://cursor.com/docs/agent/projects),
[Automations](https://cursor.com/docs/cloud-agent/automations),
[Skills](https://cursor.com/docs/skills), [Rules](https://cursor.com/docs/rules),
[Hooks](https://cursor.com/docs/hooks), [Cloud Agents](https://cursor.com/docs/cloud-agent), and
[Python SDK](https://cursor.com/docs/sdk/python). Product documentation establishes possible
behavior; it does not establish the current MASWE adapter's enforcement or evidence completeness.

The architecture and issue reconciliation under #51 should be approved before final MH-01 design
approval. It is not a Phase-B entry gate. #42 and #49 keep their separate scopes.
