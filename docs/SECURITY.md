# Security architecture and threat model

## Security objective

MASWE must prevent untrusted requests, model output, repository content, PR comments, runtime/harness output, and ambient execution state from crossing approval, permission, identity, shell, workspace, evidence, or publication boundaries without deterministic authorization.

The current implemented controls remain Cursor-first. MH-00 adds a planned security contract for future external harnesses; those controls are architecture requirements, not implemented adapter claims.

## Assets

- Source code and repository history.
- Credentials for Cursor, GitHub, package registries, cloud providers, CI, and future harness/provider integrations.
- Approved product requirements and architecture.
- Model, harness, profile/composition, and team policy configuration.
- Run artifacts and reviewer comments.
- Verification and merge-readiness evidence.
- Future raw/normalized harness-attempt evidence, qualification identity, and assurance metadata.
- Cost and quota associated with model/harness usage.

## Trust assumptions

- Project configuration and quality commands are controlled by trusted maintainers.
- The local operating system and current user account are trusted.
- Cursor CLI/SDK and model providers are external trusted dependencies, but their output is untrusted.
- Future external harness executables, transports, profiles, plugins, model providers, and their reported metadata are external dependencies and remain untrusted inputs to MASWE policy.
- Feature requests, repository text, dependency code, and PR comments may be malicious.
- A model or harness may misunderstand policy, hallucinate evidence, follow prompt injection, expose undeclared ambient state, or report incomplete identity/capability facts.

MASWE assumes a trusted local user and operating system. It does not claim to close every
same-user ancestor replacement race between filesystem checks; bounded no-follow reads and
post-read identity checks are the local fail-closed boundary, not a sandbox against a malicious
local peer.

The current execution dependencies are Cursor CLI and optional Cursor SDK. MH-00 defines future
harness capability, permission, identity, hidden-state, isolation, and evidence requirements, but
no external harness adapter is implemented by the architecture publication.

## Threats and controls

### T1 — Prompt injection from repository content

**Threat:** A source file or documentation tells an agent to ignore the approved task, reveal secrets, or perform unrelated actions.

**Controls:**

- System-level role prompts restate scope and permissions.
- Deterministic state and quality logic do not accept model-generated commands or transitions.
- Human approvals are outside the model.
- Verifier and comment classifier receive explicit untrusted-input warnings.

**Gap:** Prompt-level controls cannot fully neutralize injection. Future sandbox and tool policy should restrict file and network access per role.

### T2 — Read-only role modifies code

**Threat:** Brainstormer, designer, verifier, or classifier writes files or stages changes, including authoritative `.maswe` run state or artifacts hidden by Git excludes.

**Controls:**

- Cursor CLI omits `--force` for read-only roles.
- The orchestrator, outside runtime adapters, captures the workspace fingerprint and Git `HEAD`
  before every read-only invocation and checks both again in `finally` after either a normal return
  or a thrown runtime error.
- In Git checkouts the fingerprint covers git status, unstaged/staged diffs, and untracked content, with `.maswe/` excluded from those Git-plane probes via explicit pathspecs (independent of `.git/info/exclude`).
- In both Git and non-Git working directories the fingerprint also covers authoritative `.maswe` state under `cwd` (project config, `runs/*/run.json`, durable artifacts) via the MASWE-plane hashing contract.
- The orchestrator classifies its post-run state HEAD-first: a moved or unreadable Git `HEAD`
  fails with `policy-read-only-head-moved`, even when the fingerprint also changed; only a stable
  readable `HEAD` plus a fingerprint mismatch fails with
  `policy-read-only-workspace-mutation`. Adapter-local fingerprint checks remain defense in depth.

**Gap:** Detection occurs after the process runs; it is a mutation detector, not a preventive
OS-level sandbox. External side effects outside the fingerprinted working directory are not
covered. Ephemeral legacy locks, ordinary `*.tmp` staging files, and canonical synchronization
entries beneath exact `runs/<run-id>/.lock-journal-v3/` paths are intentionally excluded from the
fingerprint. Unexpected or malformed journal entries remain fingerprint-visible and fail journal
validation; the exclusion does not apply to similarly named paths elsewhere under `.maswe`.
Non-Git directories do not fingerprint ordinary files outside `.maswe` (there is no Git status/diff
plane); workspace identity fields still use the `not-a-git-repository` sentinel separately from
the digest fingerprint.

**Planned MH-00 rule:** Future read-only external harness attempts remain enclosed by the MASWE
outer exact-workspace/HEAD/fingerprint policy even if the harness reports an inner sandbox or
read-only mode. Inner enforcement is additional evidence, not authority to weaken the outer fence.

### T3 — Builder or resolver exceeds scope

**Threat:** A write role refactors unrelated code, changes APIs, or follows a reviewer request that broadens requirements.

**Controls:**

- Builder receives approved artifacts and explicit non-goals.
- PR comments require a read-only scope classification before resolution.
- Out-of-scope comments stop for a human.
- Deterministic quality and fresh independent verification follow edits.
- Writer-scope matching preserves Git-reported candidate path identity. Only configured glob
  separator syntax is normalized; a literal POSIX `\\` in a Git filename cannot be reinterpreted
  as `/` to enter an allowed subtree.

**Gap:** v0.2 isolates builders in a dedicated worktree and rejects commits outside `policy.allowedPathGlobs`. Fine-grained path policy derived from design artifacts remains future work.

**Planned MH-00 rule:** External harnesses start read-only. Any future external writer belongs to
MH-07 or another explicitly approved contract; MASWE keeps exact workspace ownership, deterministic
commit authority, scope checks, and Git/GitHub publication authority.

### T4 — Self-verification

**Threat:** The builder asserts success and the system accepts it.

**Controls:**

- Builder report is explicitly untrusted.
- A separate verifier role runs after deterministic quality checks.
- Resolver edits trigger a fresh verifier.
- Verifier is read-only and must emit a strict verdict.

**Planned MH-00 rule:** A successful harness exit or final-text verdict is insufficient when the
active assurance profile requires stronger exact-head, identity, hidden-state, or evidence-
completeness proof.

### T5 — Model, provider, transport, or profile substitution

**Threat:** A runtime or future harness silently uses a cheaper, blocked, less capable, or materially different model/provider/transport/profile than the governed request.

**Current controls:**

- The persisted model spelling is resolved to the trusted catalogue entry's canonical identity
  before execution. That value drives the request and comparison; runtime metadata cannot replace
  it.
- Default policy does not attempt configured fallbacks.
- Reported actual-model mismatch fails with `policy-runtime-identity-mismatch`.
- Policy failures bypass fallback selection and all-attempt aggregation; only ordinary runtime
  attempt failures may proceed to a configured fallback.
- Doctor checks available model catalogue with fail-closed structured row parsing. Empty or
  unparseable catalogues are failures. Logical names resolve only for new runs; existing runs
  resolve only a case-insensitive exact selector to the canonical catalogue entry, without
  family/provider/effort substitution.

**Planned MH-00 controls:**

- Harness, adapter/executable, transport/protocol, profile/composition, provider, requested model,
  runtime-resolved/reported identity, identity-evidence strength, effort, and permissions remain
  separate attempt facts.
- Qualification is bound to the exact executable/runtime and material profile/composition it
  observed; replacing either invalidates that qualification.
- Unknown, stale, contradictory, or insufficient required capability/identity facts fail closed.
- A material provider/model/profile/transport change is not silently absorbed inside one governed
  attempt; MASWE fallback creates a new MASWE-visible attempt.
- Harness-local model/provider retries or auxiliary calls do not become MASWE fallback merely
  because the harness labels them as retries.

**Gap:** Not every runtime or provider exposes strong actual-model identity. MH-00 therefore
requires explicit evidence-strength classification rather than treating requested/runtime-labelled
metadata as provider attestation.

### T6 — Shell injection

**Threat:** Issue text or a PR comment becomes a shell command.

**Controls:**

- Quality commands come only from trusted JSON configuration.
- Request and comment content is passed only as prompt text.
- Runtime command and model values are argument arrays rather than shell interpolation.

**Risk:** Quality commands execute with `shell: true`; malicious configuration is equivalent to local code execution. Protect config review and branch permissions.

**Planned MH-00 rule:** An external harness's model output, workflow text, skill/memory content,
tool proposal, or approval request does not become trusted shell/tool policy without deterministic
MASWE authorization.

### T7 — Secret leakage

**Threat:** Agents read `.env`, credentials, or CI secrets and include them in prompts, artifacts, logs, future raw harness evidence, or profile material.

**Controls:**

- Credentials come from environment variables.
- `.env*` is ignored except the example file.
- SDK API key is passed through process environment/options, not persisted in run config.
- Persisted workspace `remote` provenance is sanitized at capture time: HTTP(S)/`ssh://` userinfo is stripped; malformed credential-like remotes are omitted rather than stored raw.
- Raw Cursor CLI stderr is transient process-adapter data. Non-zero exits return only a structured
  failure code, process metadata, and a normalized/redacted/bounded operator diagnostic. Runtime
  metadata records `stderrPresent` rather than stderr content.
- Failure diagnostics normalize unsafe controls, redact, and then truncate. Individual diagnostics
  are at most 2,048 Unicode code points and all-model aggregates at most 8,192, including the
  `… [truncated]` marker.
- Diagnostic work is bounded before redaction. The sanitizer accepts at most the requested output
  budget plus 4,096 Unicode code points of lookahead, with an absolute 12,288-code-point inspection
  ceiling. The ordinary 2,048-code-point diagnostic therefore inspects at most 6,144 code points;
  the 8,192-code-point aggregate inspects at most 12,288. Long assignments and incomplete private
  key blocks are treated as secret through the accepted-window boundary, so truncation cannot
  expose a recognized secret prefix.
- The orchestrator and file store re-sanitize failure messages, `FAIL.details.reason`, and retry
  `previousFailure.message` before persistence. They also reconstruct the allowlisted durable
  runtime-attempt subset rather than serializing arbitrary adapter metadata. CLI status rendering
  applies the same focused safeguard. `FAIL` and retry event paths remove the raw runtime object
  before cloning other details, then sanitize only the first eight runtime attempt slots.
- Durable runtime failure state stores at most eight attempts. Attempt messages are capped at 512
  Unicode code points and model display fields at 256. Total and omitted attempt counts, aggregate
  truncation, stable code, exit/timeout/duration/transport fields, stderr presence, and truncation
  are retained where applicable. Re-sanitizing a loaded or tampered record inspects only its first
  eight raw attempt slots; invalid entries are discarded rather than triggering an unbounded search
  for later valid-looking data.
- Model identifiers used for execution remain unchanged. Their diagnostic display copies are
  separately redacted, capped, collapsed to one line, and stripped of aggregate framing
  delimiters before formatting or persistence.
- Successful runtime-backed workflow events apply that same 256-code-point model-display policy to
  `requestedModel` and `actualModel`. Optional `agentId` and `runtimeRunId` values use a separately
  named 256-code-point identifier-display policy at the same persistence boundary. These display
  copies do not alter runtime invocation, exact-model comparison, catalogue selection, or fallback
  ordering.
- The JSON Schema closes the nested durable runtime attempt and summary allowlists with
  `additionalProperties: false`. Historical schema-version-1 parent objects remain open where
  required for compatibility, and failures without runtime metadata remain valid.
- MASWE has no raw provider-debug artifact or log channel. It does not persist an encrypted copy or
  any digest or hash of raw stderr.
- Cursor CLI failure adapters sanitize the bounded stderr window before trimming or composing
  summaries; catalogue and doctor diagnostics use the same ordering.
- Documentation instructs teams not to commit run artifacts by default.
- The normal constrained-heap regression uses an 8,000,000-character one-byte input, a 48 MiB V8
  old-space limit, and an exact 128-code-point output assertion. It guards against sanitizer
  overhead proportional to every input code point; it is not an absolute bound on total process
  memory or the input representation itself.

**Gaps and future work:**

- Automatic secret redaction covers tested classic GitHub tokens, modern `github_pat_` fine-grained
  PAT shapes, OpenAI/Slack tokens, authorization and standalone bearer forms, URI userinfo, common
  API-key/token/AWS-secret assignments, private-key blocks, and sensitive query parameters.
  URI-userinfo recognition requires an explicit `http`, `https`, `ssh`, `git`, `git+https`,
  `git+ssh`, `sftp`, or `ftp` `scheme://` prefix; it redacts username-only and username/password
  forms while preserving the remaining URI. If a supported URI authority reaches a truncated
  inspection-window boundary before `@` or another authority delimiter, the incomplete authority
  is redacted fail-closed. SCP-like `user@host:path`, ordinary email, arbitrary schemes, and
  percent-decoded semantic interpretation are intentionally not inferred.
- The accepted grammar is deliberately narrow: classic GitHub prefixes and `github_pat_` require at
  least 20 token characters; authorization forms require an `Authorization: Bearer|Basic` header
  or standalone `Bearer`; assignment keys are ASCII identifier names ending in a tested
  API-key/token/secret/signature/AWS-secret suffix followed by `:` or `=` and a quoted or
  delimiter-terminated value (quoted values honor odd/even backslash escaping before a quote, and
  one JSON-encoded structural-quote layer is recognized); sensitive query values require a tested
  `?`/`&` parameter name; and private-key blocks require a `BEGIN … PRIVATE KEY` marker (an absent
  end marker redacts through the accepted window). The fixed-token-prefix scanner consumes only
  each prefix's documented ASCII token alphabet and redacts fail-closed if that candidate reaches
  the truncated accepted-window end, even before the complete-token minimum is observable.
- The fixed-token-prefix, assignment, URI-authority, and private-key scanners advance
  monotonically. The URI scanner records the last `@` during its forward authority pass; it does
  not search the already-consumed prefix again for each URI. That property also keeps the separate,
  potentially larger successful-artifact `redactSecrets()` path linear in the accepted text.
  Remaining regular expressions use non-overlapping grammars and failure diagnostics run them only
  on the bounded diagnostic window; none contains the former nested ambiguous provider-prefix
  repetition. Benchmarks guard scaling, but are supporting evidence rather than a formal
  complexity proof.
- Recognition remains pattern-based, best-effort protection, not a DLP product or a guarantee that
  arbitrary credentials can be recognized.
- Diagnostic framing replaces C0/C1 controls, Unicode line/paragraph separators, bidi overrides,
  and bidi isolates; CR/LF normalization and tab/newline preservation otherwise remain as
  documented.
- Default Cursor CLI prompt transport is stdin; argv remains available via `policy.promptTransport`.
- No provider-specific privacy controls beyond local redaction.
- Future raw harness/session evidence needs a separately approved bounded/redacted retention
  contract. Secrets, credentials, profile secrets, and arbitrary environment values must not be
  persisted merely because a structured harness event contains them.
- Future conformance profiles must explicitly disposition telemetry, persistent anonymous identity,
  provider/model-hidden headers, credential resolution, environment inheritance, persistence
  roots, and network egress where those surfaces exist.

Authentication-like stderr prose remains visible only after sanitization under the structured
non-zero classification. It does not drive control flow because Cursor CLI does not expose a typed
authentication field.

### T8 — Artifact tampering

**Threat:** A user or process changes a design or verification report after approval.

**Controls:**

- Artifacts have SHA-256 digests in the run record.
- Generated physical names use an injective escape namespace, and publication rejects a target
  already owned by another logical artifact or unexpectedly present on disk; distinct handoffs
  cannot silently overwrite one another.
- An artifact reference must name one portable direct child of its run's `artifacts/` directory.
  Reads reject symlink/non-directory ancestors and non-regular final objects, require no-follow
  support, bound content to 1 MiB, recheck the namespace, and verify the recorded digest.

**Gap:** Digests are revalidated on every read in v0.2 but are not cryptographically signed.
Same-user ancestor replacement races remain outside the trusted-local-user boundary. Future
versions should bind approvals to artifact digests with signatures where needed.

**Planned MH-00 rule:** Raw harness evidence and normalized projections remain distinguishable and
traceable by digest/version. A normalized projection cannot invent a stronger fact than its raw or
MASWE-observed source supports.

### T9 — Verification on stale code

**Threat:** New commits are added after verifier pass, but old evidence is treated as current.

**Controls:**

- Local read-only checks cover the workspace during the verifier execution.
- Quality, verification, and merge-ready evidence records bind to the evaluated git **head SHA**.
- Head-SHA movement after a successful stage invalidates stale evidence before merge-ready.

**Gap:** Digests and evidence are not yet cryptographically signed. Phase A mirrors SHA-bound evidence into GitHub Checks; Phase B still owns push/PR writes and comment replies.

**Planned MH-00 rule:** Future harness evidence is bound to the exact MASWE attempt and exact
workspace/head it evaluated. Harness success on another head/profile/generation is stale or foreign
evidence and cannot satisfy the current assurance gate.

### T10 — Webhook replay or forged GitHub event

**Threat:** An attacker replays or forges a GitHub webhook delivery.

**Controls (Phase A):**

- Verify `X-Hub-Signature-256` against the raw body (timing-safe); reject without state change.
- After exact-byte HMAC and strict UTF-8/JSON normalization, persist a lease-fenced normalized
  envelope under an immutable per-delivery journal. Completed duplicates return 200 without
  repeating side effects, queued/processing duplicates return 202, and same-ID digest conflicts
  return 409. Unsupported events are durably completed and acknowledged 200.
- Persist only the normalized event, event name, delivery ID, receive time, raw-body SHA-256, and
  operational lease fields. Raw payloads, signatures, headers, tokens, secrets, keys, and arbitrary
  exception text are excluded.
- Keep loopback as the listener default. Explicit wildcard binding requires TLS termination,
  network admission, one MiB proxy/application body ceilings, rate/concurrency controls, and
  header/body/request deadlines that preserve the application's sub-ten-second response budget.
- Acquire installation tokens only for the handling installation, scoped to a single stable
  repository ID (`repository_ids: [<repositoryId>]`) with the exact least-privilege permission set
  for the purpose (`metadata-reconcile`, `pull-request-read`, or `checks`). There is no
  name-scoped token path. Tokens are not persisted.
- Idempotency keys for check-run side effects under `.maswe/github/side-effects/`, keyed by stable
  repository ID rather than by mutable name.
- Repository authorization uses `githubApp.allowedRepositoryIds` only. A mutable `owner/repo` name
  never authorizes an association, credential mint, workflow mutation, or check publication, so a
  rename, a redirect, or an attacker-controlled repository reusing a released name cannot inherit
  authority. `allowedRepositories` is selection and display metadata only.
- The webhook listener refuses to reach readiness while `allowedRepositoryIds` is empty, so there
  is no supported window in which repository deliveries are accepted under name-only
  authorization.
- Repository-scoped dispatch that fails identity or policy checks is typed as permanent: zero
  authority-increasing mutation, a bounded typed reason, the durable delivery consumed rather than
  retried, no fallback to name-based authorization, and a process-local
  `permanentRepositoryDropsSinceStart` counter that is observability only. Ambiguous API or
  pagination failures stay retryable and are never treated as proof of revoked access.
- Installation removal suspends associations by persisted `installationId`, including for
  unresolved legacy records; it never establishes repository identity.
- Generic HTTP 500 responses contain no internal error text; internal failures go only to the local
  diagnostic callback. Every production GitHub HTTP request has a 30-second default deadline.
- Full-digest `external_id` values bind repository, PR, head SHA, check name, and attempt; bounded
  paginated reconciliation searches all advertised check pages before a replacement create.
- Startup migrates legacy delivery artifacts into hash-addressed retained evidence and recovers
  pending queue state before the listener accepts traffic. Active tombstones/journals are not
  silently pruned because removing replay evidence could re-enable a signed delivery.

**Boundary:** Phase A supports one listener/worker plus simultaneous manual publishers using
cooperative same-host locking on one coherent local filesystem with atomic no-clobber hard links.
Quiescent retained-path migration is required from legacy state; multiple listeners, mixed old/new
binaries, and network/distributed filesystems are unsupported. Stable repository identity requires
its own quiescent cutover: stop every pre-#34 listener and manual publisher, configure
`allowedRepositoryIds`, complete `maswe github-migrate-repository` for **every** repository holding
pre-#34 state, and only then start the new listener. After stable-identity state is written,
downgrade to a pre-#34 binary is unsupported and old binaries are expected to fail closed on exact
validation. Digest-bound GitHub approval authorization by repository role/team remains Phase B.
Phase B must not obtain GitHub write authority until Issue #34 is completed, independently
validated, merged, and post-merge `main` is revalidated.

### T11 — Resource and cost exhaustion

**Threat:** A loop or malicious comment triggers repeated expensive model calls.

**Controls:**

- Build/verify and comment-resolution cycles are bounded.
- Automatic loop has a hard transition limit.
- Fallback models are disabled by default.

**Future controls:** per-run token, time, and monetary budgets; concurrency quotas; organization-level kill switch. MH-00 additionally requires harness-local retries and auxiliary model calls to be disabled initially or bounded/accounted explicitly rather than hiding them from MASWE attempt accounting.

### T12 — Lock recovery releases a replacement owner

**Threat:** A delayed owner or forced recoverer validates a reusable lock pathname, another process
replaces it, and the delayed actor removes the replacement. Concurrent administrative recoverers
could similarly overlap.

**Controls:**

- Version-3 ownership is an immutable claim in a permanent append-only journal, never a reusable
  pathname or directory identity.
- Claims and releases are complete, canonical, digest-validated regular files published with an
  atomic no-clobber hard link.
- The owner is the smallest valid unreleased contiguous ticket; every claimant validates exact
  lower paths and its own release state immediately before protected work.
- Normal release and force publish one canonical marker for an exact claim identity. They never
  delete claims, releases, successors, or journal infrastructure.
- Administrative recoverers use their own ordered stream. A live recovery claim cannot be
  force-released.
- Links, detectable junctions/reparse points, unexpected types, gaps, malformed records, digest
  mismatch, unsupported filesystems, and ambiguous process identity fail closed.

**Boundary:** This is cooperative same-host locking on a coherent local filesystem. `--force` is
an operator assertion of quiescence, not process fencing; misuse cannot stop a genuinely active
process. Malicious same-user or OS-level replacement of permanent journal infrastructure is outside
the current threat model. NFS, SMB, distributed FUSE, object-store mounts, cross-host access, and
filesystems without coherent no-clobber hard links are unsupported. General Windows support is not
claimed without exact-head native NTFS validation.

### T13 — Harness-name capability confusion (planned MH-00)

**Threat:** MASWE or an operator assumes that a harness name implies a safe transport, provider,
model, profile, permission mode, sandbox, memory mode, retry policy, workflow surface, or delegation
behavior. Two materially different runtime compositions could then be treated as equivalent.

**Planned controls:**

- Route against an exact qualified execution plan and required capability/assurance facts, not a
  harness-name condition.
- Bind qualification to exact adapter/executable/runtime and material profile/composition identity,
  including protocol generation where available.
- Treat unknown/unproven required capabilities as a failure rather than a permissive default.
- Keep requested permissions and effective/observed permissions separate.
- Treat unexpected write-tool, workflow, retry, delegation, dynamic-profile/plugin, or equivalent
  events as policy violations when the active conformance profile forbids them.

**Status/gap:** Architecture requirement only. MH-01/MH-02 and each adapter tranche must implement
and test the exact type, qualification, invalidation, and policy semantics before an external
harness is supported.

### T14 — Hidden ambient state or nested authority (planned MH-00)

**Threat:** Persistent harness memory, user/project skills, mutable settings, workspace instructions,
sessions, task boards, jobs/goals, native workflows, provider retries, or subagents influence a
high-assurance result without appearing in MASWE's authoritative inputs. A harness could become a
second scheduler/approval/retry plane.

**Planned controls:**

- Record an ambient-input manifest and explicit hidden-state disposition where required by the
  assurance profile.
- Prefer fresh process/session/home/profile/persistence roots or memory-disabled semantics for
  reproducible and independent-verification attempts.
- Treat governed MASWE/Superpowers skills as immutable/digest-bound inputs; mutable harness-created
  skills/procedural memory are not authoritative policy.
- Disable native delegation, workflows/schedulers, internal retries, and dynamic policy/plugin
  modification initially where possible.
- Admit future child execution only through a MASWE-visible bounded delegation contract with exact
  parent/child identity, permissions, workspace scope, evidence, cancellation, cost, and failure
  semantics.
- Harness approvals/permission prompts are execution safety evidence or requests; they cannot
  satisfy MASWE brainstorm/design approval or authorize fallback/publication/privilege expansion.

**Status/gap:** Architecture requirement only. The exact assurance-profile and ambient-input schema
belongs to MH-01/MH-08 and harness-specific conformance work.

### T15 — Incomplete or overstated harness evidence; orphan execution (planned MH-00)

**Threat:** A harness returns plausible final text while prompt correlation, model identity, tool
trace, child lineage, cancellation, sandbox facts, or raw evidence is missing/inferred. A timeout or
cancel may also leave descendant processes running after MASWE has treated the attempt as over.

**Planned controls:**

- Preserve bounded/redacted raw structured session evidence where the assurance profile requires it
  and digest-bind normalized projections to the raw source.
- Record per-dimension evidence completeness/strength; never promote configured/requested/runtime-
  labelled metadata to stronger provider attestation without supporting evidence.
- A successful harness exit still fails the governed assurance contract when required evidence is
  missing or too weak.
- MASWE owns outer timeout/cancellation and process-tree quiescence even when the inner transport
  offers cancellation/sandboxing.
- Prompt-level cancellation support is an explicit capability; absent support does not remove the
  outer quiescence requirement.

**Status/gap:** Architecture requirement only. Exact persistence, retention bounds, process
supervision, and completeness enums must be approved/tested in later implementation tranches.

### T16 — Transitive product identity collapse (planned MH-00)

**Threat:** `MASWE -> DeepSeek Harness -> Codex` or `MASWE -> Hermes -> Claude` is recorded as if it
were a direct MASWE Codex/Claude adapter. That can overstate independence, permissions, transport,
and profile provenance.

**Planned controls:**

- Preserve every material harness/product layer and parent/child relationship in attempt evidence.
- A nested leaf product does not satisfy a direct-adapter assurance contract for that product.
- Differential verification treats harness and provider/model dimensions independently and
  preserves disagreement instead of converting multiple outputs into implicit consensus.

**Status/gap:** Architecture requirement only; child/transitive identity fields belong to MH-01 and
future governed delegation/adapters.

## Deterministic role authority

The enforced role-permission matrix is the authorization decision, independent of a model prompt:

| Role | Required permission | One-call exception |
|---|---|---|
| Brainstormer | `read-only` | None |
| Designer | `read-only` | None |
| Builder | `workspace-write` | None |
| Verifier | `read-only` | None |
| PR resolver | `workspace-write` | `read-only` for comment classification only |

Project configuration, persisted run snapshots, and execution overrides that violate this table
fail closed with `policy-role-permission-mismatch`.

Future harness adapters may narrow execution capabilities but must not broaden this MASWE authority
matrix. The initial external adapter direction is read-only; external writer behavior requires a
separately approved MH-07 contract.

## Least-privilege target design

| Role | Configured permission | Repository read | Repository write | Shell | Network/integrations |
|---|---|---:|---:|---:|---:|
| Brainstormer | `read-only` | Yes | No | Read-only inspection | Limited |
| Designer | `read-only` | Yes | No | Read-only inspection | Limited |
| Builder | `workspace-write` | Yes | Workspace | Project commands | Approved integrations |
| Verifier | `read-only` | Yes | No | Test commands only | None by default |
| PR resolver | `workspace-write` (or read-only while classifying) | Yes | Workspace except while classifying | Targeted tests | No GitHub reply in current Phase A |

Adapter flags and prompts supplement this deterministic matrix; the local read-only check remains
post-run detection rather than a preventive operating-system sandbox.

For future harnesses, least privilege is an exact-plan property: requested/effective harness tools,
sandbox policy, network/process capabilities, memory/skills, delegation, retries, and publication
surface are independently qualified/evidenced rather than inferred from the harness name.

## Dependency and supply-chain policy

- Pin released dependencies with a lock file when registry access is available.
- Keep `@cursor/sdk` optional and behind an adapter.
- Use Dependabot and CI.
- Review all GitHub Actions by commit SHA for high-assurance deployments; starter workflow uses major tags for maintainability and should be hardened before production.
- Do not execute code downloaded by an agent without review.
- Future external harness qualification must bind the executable/runtime build and material
  profile/composition generation it approved; replacement or protocol/profile drift invalidates
  qualification rather than inheriting trust from a stable harness name.
- A MASWE-owned conformance profile is preferred where a composable harness exposes broad stock
  profiles/plugins/tools; profile bytes/identity are digest-bound where reproducibility requires it.

## Incident response

1. Stop active runs/attempts and revoke affected GitHub, provider, and harness tokens or credentials.
2. Preserve `run.json`, artifacts, command logs, git reflog, provider request IDs, and—when later implemented—bounded raw harness evidence, normalized evidence, executable/profile qualification identities, and process/cancellation facts.
3. Determine whether workspace, process, network, child-agent, or remote side effects occurred.
4. Rotate exposed credentials and invalidate affected harness/profile qualification where applicable.
5. Revert unauthorized code and invalidate verification/check/assurance results bound to affected heads or attempts.
6. Patch policy or runtime/harness controls and add deterministic replay/regression coverage.
7. Document impact and notify affected users according to organizational policy.
