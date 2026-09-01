# Agent instructions

This repository implements a deterministic multi-agent software delivery orchestrator. Preserve the boundary between orchestration and model behavior.

## Repository identity and scope

- Canonical repository: `tomazb/multi-agent-software-engineer`.
- Canonical product name: Multi-Agent Software Engineer (MASWE).
- Current runtime kinds are `mock`, `cursor-cli`, and `cursor-sdk`.
- Multi-harness execution is planned through Issues #31 and #32; do not claim external harness support or add adapter code before its entry gates.
- Preserve historical design and plan artifacts even when they contain the former repository slug.
- The existing schema URLs remain stable compatibility identifiers until a separately governed schema-version change.

## Required engineering behavior

- Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, and relevant ADRs before changing architecture.
- Use Superpowers skills when available: brainstorming for product decisions, writing-plans for design, test-driven-development for implementation, and verification-before-completion before claiming success.
- Write or update tests for every behavioral change.
- Select a supported Node runtime and run `npm run check` before completion.
- Never weaken approval, read-only, model, scope, or verification policies merely to make a test pass.
- Keep runtime-specific code in `src/runtimes/`; core workflow code must not import a provider SDK directly.
- Keep state transitions centralized in `src/state-machine.ts`.
- Persist handoffs through artifacts; do not add hidden cross-agent conversation state.
- Do not store credentials, model responses containing secrets, or repository tokens in committed files.

## Engineering decision and authority policy

Correctness, safety, security, concurrency, recovery, idempotency, audit, evidence, compatibility, approved observable behavior, and operator-facing contracts take precedence over YAGNI, KISS, and DRY.

Apply engineering decisions in this order:

1. Preserve governing requirements and approved behavior.
2. Do not add requirements that do not exist.
3. Implement required behavior with the smallest clear and explicit model.
4. Share authoritative knowledge only where doing so reduces duplication without adding coupling, hidden conditionals, or a broader abstraction.

Fewer lines, states, files, or concepts do not justify weakening a required contract.

### Orchestration and methodology authority

- MASWE is the durable orchestration authority for workflow state and transitions, approvals, retry/fallback boundaries, attempt identity, workspace/worktree ownership, evidence acceptance, recovery, Git mutation, and publication.
- Superpowers is responsible for the engineering methodology an agent uses while performing its assigned role.
- Neither Superpowers nor an external harness may become a second durable MASWE control plane.

### Writer authority and bounded parallelism

One designated writer owns each mutable branch and worktree at a time.

- Parallel agents may perform read-only investigation or review against shared state.
- Parallel writers must use separate isolated worktrees/branches with a controlled integration boundary.
- A writer handoff requires the previous writer to stop mutation and the new writer to refresh repository state and verify the exact current branch and HEAD before mutation.
- Do not parallelize work that edits the same files, mutates the same external resource, depends on an unresolved interface, or can invalidate another task's evidence.
- Require dependency or serialization metadata only where meaningful parallel execution is plausible; do not create boilerplate for trivial tasks.

### Evidence-backed review and complexity firewall

Every blocking verifier or review finding must identify:

1. The governing requirement, acceptance criterion, invariant, or approved behavior that is violated.
2. The concrete reachable failure or impact.
3. Supporting code, test, diff, or execution evidence.
4. The smallest safe remediation known to the reviewer.

Labels such as "best practice", "more robust", "production grade", or a theoretically stronger design are not sufficient by themselves to make a finding blocking. Report uncertainty or missing evidence explicitly rather than inventing certainty.

Treat a demonstrated defect and the reviewer's proposed remediation as separate decisions. A proposed correction is architectural when it adds or materially expands beyond the approved design any of the following: persisted state or persistence format; workflow state, transition, event, or approval action; configuration surface; compatibility or legacy behavior; retry, reconciliation, takeover, or recovery protocol; abstraction layer, framework, or generic subsystem; backend, lifecycle mode, execution mode, or supported variant; dependency or long-running service/controller; or security mechanism or threat model.

Do not implement an architectural proposal inside an ordinary review-fix loop merely because the reviewer assigned high severity. The underlying defect may be accepted, but an architecture-expanding remediation returns to specification and owner approval unless the current approved design already requires it.

A complexity-increasing proposal must state the violated requirement, concrete reachable failure, supporting evidence, smallest safe remediation, and why deletion, narrower scope, fail-closed behavior, an existing primitive, or explicit operator resolution is insufficient.

## Builder simplification gate

Before declaring the implementation ready for deterministic CI and subsequent independent verification, the builder must review the changed code and the directly affected collaborators needed to understand the change for avoidable complexity introduced or materially worsened by the implementation.

Apply safe, behavior-preserving simplifications when they are local, within the approved scope, and materially improve the changed implementation. Examples include duplicated logic, unnecessarily complex control flow, unclear local interfaces, avoidable indirection, and mixed responsibilities directly involved in the change.

- Inspection may extend to directly affected collaborators when necessary to understand the changed implementation, but this does not expand edit authority. Do not edit outside the governing scope. Record worthwhile out-of-scope simplifications for disposition under the governing issue, design, or plan rather than implementing them.
- Do not turn a scoped feature, correctness, safety, or review fix into a general refactoring effort. Pre-existing complexity alone is not authorization to restructure it.
- Do not weaken safety, security, concurrency, recovery, idempotency, audit, evidence, parity, compatibility, or operator-facing guarantees for the sake of fewer lines, files, branches, or abstractions.
- Preserve public and operator-facing interfaces, persisted state and checkpoint contracts, errors, and observable outcomes unless the approved change explicitly includes their revision.
- Prefer readability, explicit control flow, and clear responsibilities over minimizing line count or abstraction count.
- After any simplification, rerun targeted tests first, then every verification gate invalidated by the resulting changes. Do not declare builder completion while the required local gate set is failing.
- Record the simplification review in the builder completion report. Summarize simplifications applied, or state that no safe in-scope simplification was identified. If a later integration creates a pull request, propagate that outcome into the PR description when practical.

## Definition of done

A change is complete only when requirements are mapped to tests, tests pass on the required Node baselines, type checking passes, the build succeeds, documentation is updated, and no unrelated files are changed.

## Cursor Cloud specific instructions

This is a self-contained TypeScript ESM CLI (`maswe`). There are no databases, servers, or external services to run; the only dependencies are dev-only (`typescript`, `@types/node`). Standard commands live in `package.json` scripts, `README.md`, and `docs/DEVELOPMENT.md` — use those.

Non-obvious caveats:

- Node policy: the canonical contributor and primary-CI baseline is exact Node `24.18.0` from `.nvmrc`. The supported runtime range is `>=22.22.2 <23 || >=24.18.0 <25`; exact Node `22.22.2` remains the blocking compatibility floor. NVM is optional and is not a product dependency; when available, use `nvm install && nvm use` rather than a host-specific Node path. Unsupported runtimes fail early with `MASWE_UNSUPPORTED_NODE_VERSION`.
- Validation evidence must identify `command -v node`, `node --version`, `node -p 'process.execPath'`, and `npm --version`, and must label Node 24 canonical evidence separately from Node 22 compatibility evidence. A successful exploratory run outside the supported range is not support evidence.
- Tests and `npm run dev` execute TypeScript directly via Node's `--experimental-strip-types`; only `npm run build` uses `tsc`. Avoid TS syntax unsupported by strip-only mode (no enums/parameter properties), per `docs/DEVELOPMENT.md`.
- Running the workflow end-to-end without Cursor credentials: set the runtime to `mock` (either `runtime.kind: "mock"` in the config or `MASWE_RUNTIME=mock`). The default `cursor-cli` runtime requires the authenticated `agent` executable, which is not present in this environment.
- The orchestrator acts on a separate target repository passed via `--cwd`, not on this repo. That target must be a clean git checkout (or set `policy.allowDirtyWorkspace=true`), and the config's `quality.commands` are executed inside that target directory.
- This repository commits `package-lock.json`. Keep its root package metadata synchronized with `package.json`; do not delete or silently regenerate unrelated dependency state.
