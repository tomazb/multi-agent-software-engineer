# B1: authenticated GitHub approval comments

Status: **proposed design for owner review; no B1 runtime implementation is included**.

Date: 2026-11-03. Governing issue: [#3](https://github.com/tomazb/multi-agent-software-engineer/issues/3).

Implementation baseline: `adad3664ba4d536547f857328e610426548d03c4`.

[Inference] The decisions below are the proposed bounded B1 design. Descriptions of existing behavior are tied to the inspected baseline. Earlier approved programme constraints are retained; this document does not claim that a prior conversation approved these detailed implementation choices. Owner approval of this specification precedes its implementation plan.

## 1. Purpose and delivery boundary

Allow an authorized GitHub user to approve the exact brainstorm or design artifact of an existing MASWE run through a PR conversation comment. MASWE commits that approval through its deterministic core, with attributable evidence and replay-safe outcomes.

B1 completes only the authenticated approval tranche of #3. The order remains B1 approvals, B2 branch/PR publication, B3 human-approved review resolution, then B4 Actions/artifact ingestion. Multi-harness runtime implementation and the distributed control plane retain their existing entry gates.

The smallest supported pilot is a run already associated with an open PR through the existing authenticated Phase A association flow. B1 neither creates an association from a command nor selects a run by topic, repository name, or model judgment. The command's run ID must match the existing numeric-repository/PR association.

This is a real setup limitation: a new run's managed branch may have no changes from its base and therefore may not yet have a PR. An operator must arrange a suitable existing PR/branch and the ordinary Phase A association before using B1. There is no existing `github-associate` CLI to invoke. Unassociated runs continue to use the local approval command. B2/manual setup supplies PR publication; B1 does not promise a complete new-request-to-new-PR workflow.

### Success outcome

An accepted remote approval atomically records its gate transition and receipt, moving:

| Gate | Required state | Existing event | Resulting state |
|---|---|---|---|
| `brainstorm` | `WAITING_FOR_BRAINSTORM_APPROVAL` | `APPROVE_BRAINSTORM` | `DESIGNING` |
| `design` | `WAITING_FOR_DESIGN_APPROVAL` | `APPROVE_DESIGN` | `BUILDING` |

The webhook worker does not invoke a model or execute the newly authorized phase. The operator subsequently runs `maswe run <run-id>` through the existing CLI. This keeps approval application and long-running execution separate without adding a continuation queue. The existing local `maswe approve <run-id> <gate>` retains its approve-and-run behavior through a wrapper around the same commit operation.

## 2. Baseline observations

The current [approval method](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/orchestrator.ts#L904-L913) sets an approval Boolean, calls `applyEvent`, and immediately calls `runUntilBlocked`. It accepts no artifact digest or GitHub actor proof. There are no separate `approveBrainstorm` or `approveDesign` methods.

The current [event types](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/github/types.ts) and normalizer do not admit `issue_comment`. The [durable worker](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/github/webhook-worker.ts) retries unsettled dispatch and completion failures. Delivery tombstones identify consumed deliveries, but are not stable comment-operation receipts across distinct delivery IDs.

`RunStore.applyEvent` saves the approval fields, state, and event in one version-checked durable `run.json` replacement. Its [outcome-unknown handling](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/store.ts#L602-L614) can observe the intended record and still throw. A rejected promise therefore does not establish that the write was absent.

The current artifact reader verifies confined paths and persisted SHA-256 against the actual stored bytes. The [association mutation helper](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/github/association-mutation.ts) permits only `github`/`evidence` changes and protects event history; it cannot be used to commit or compensate an approval transition.

## 3. Approaches and selected direction

| Approach | Tradeoff | Disposition |
|---|---|---|
| Explicit PR comment with run, gate, and digest | Exact target is visible and can be checked through the existing PR association | Selected for this proposed B1 design, following the agreed comment-first direction |
| Approval labels | A label alone does not identify an immutable artifact or distinguish repeated application to newer work; a separate binding contract would be needed | Deferred |
| General issue/chat intake with an attention service | Supports new-work creation and multi-channel conversation, but needs additional authority, lifecycle, and persistence contracts | Separate future design |

The design adds a narrow comment-operation receipt store using existing durable-file and ownership-journal primitives. A successful approval receipt is also part of the authoritative run event. This is required because delivery-ID deduplication and success-only run events cannot preserve a finalized rejection/no-change outcome when the same comment arrives under another delivery ID. A generic outbox, scheduler, or new workflow state is unnecessary for B1.

## 4. Explicit enablement and permissions

Add the optional `githubApp.approvalComments` configuration:

```json
{
  "enabled": false,
  "commandPrefix": "/maswe",
  "allowedActorIds": [1279460]
}
```

The numeric ID is illustrative, not a default authorization grant. Omission means disabled. `allowedActorIds` is optional: omitted permits accounts satisfying the repository permission rule; an empty list permits nobody; a supplied list further restricts eligible numeric user IDs. The mandatory repository permission rule remains `write` or `admin`. No organization membership lookup or custom-role-name interpretation is introduced.

Validate the object as a closed schema, all IDs as unique positive safe integers, and `commandPrefix` as one ASCII slash token matching `^/[a-z][a-z0-9-]{0,31}$`. The prefix is a literal parser token, never a regular expression or shell fragment supplied by configuration. Prefix and parser bounds are fixed pilot choices, not performance findings.

Both the effective listener configuration and the immutable run configuration must explicitly enable approval comments and admit the actor. Their command prefixes must agree. A live restriction can narrow the run snapshot; a broader live configuration cannot widen it. Historical runs with no opt-in stay disabled; B1 adds no mutation of historical configuration snapshots. Normal configuration restart/loading behavior remains in effect; this design adds no hot-reload service.

`githubApp.readOnlyChecks` stays `true`. It continues to limit GitHub resource mutations to the existing Phase A check behavior. The separately enabled B1 operation mutates local MASWE approval state. Documentation and operator output must make that distinction explicit; a historical Phase A configuration alone does not enable remote approvals.

### App registration versus narrowed REST tokens

- GitHub documents **Issues: read** as necessary to subscribe an App to `issue_comment`, including PR conversation comments. Enabling B1 therefore requires an explicit App/installation permission and event-subscription change.
- Reading the live comment accepts Issues: read or Pull requests: read. Reading a collaborator's effective repository permission requires Metadata: read.
- The existing ID-scoped `pull-request-read` token purpose already carries Metadata: read and Pull requests: read and can serve those REST reads. Do not broaden its minted permissions or add Issues/Contents/Pull requests write authority.
- Existing repository allowlisting remains numeric-ID based. Owner/name is current routing metadata only.

These distinctions follow GitHub's [webhook documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment), [comment read API](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment), and [repository permission API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user). Live installation qualification remains implementation validation, not evidence supplied by this design.

## 5. Command and ingress contract

Accepted command form, using the configured prefix:

```text
/maswe approve <brainstorm|design> <run-id> <run-version> <sha256>
```

Accept exactly one command line with single ASCII spaces and, optionally, one final LF or CRLF. Reject leading/trailing prose, Markdown quoting/fences, mentions, multiple commands, abbreviations, extra fields, uppercase/shortened digests, Unicode lookalikes, and path-like run IDs. Reuse `assertSafeRunId` and the existing safe ID contract. `run-version` is the displayed `RunRecord.version`, encoded as a positive safe decimal integer without leading zeros. SHA-256 is exactly 64 lowercase hexadecimal characters. Bound the complete command to 512 UTF-8 bytes; ordinary comments are not retained as command text.

The requested version is immutable input, never replaced by the newest version on retry. Every [run save](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/store.ts#L893-L908), including artifact publication and association changes, increments that version. It therefore binds the displayed artifact attempt and recorded PR/workspace context without a new persisted approval-request lifecycle. A benign run/name reconciliation can make a command stale; this conservative pilot tradeoff requires a refreshed status and a new comment. Exact historical receipt lookup precedes the version check, so an approval's own save does not defeat replay.

Only a signed `issue_comment.created` on a PR conversation is eligible. Ordinary issue comments, inline review comments, reactions, labels, edits, and deletions cannot grant B1 approval. An edited/deleted approval comment does not revoke an already committed approval; stopping work continues through existing operator controls. Before application, an edit or deletion makes the original request ineligible or unresolved as described below. The operator posts a new comment for a corrected command.

Extend closed normalized-event and durable-inbox validation together. Retain only bounded typed fields needed for the command and its provenance: delivery identity/body digest, repository and installation IDs, PR number, comment ID, numeric sender/author IDs and account types, routing login, comment timestamps, parsed command tuple including prefix and requested run version, and SHA-256 of the exact comment body. Existing raw-byte signature verification and body-size/UTF-8 validation remain before normalization.

Recognize this bounded candidate grammar independently of the configured prefix, feature flag, allowlist, and current run eligibility. Syntactically valid candidates with a disabled feature or mismatched prefix reach the semantic receipt path and receive a durable rejection. Otherwise a delivery-only drop could allow the same comment to gain an effect under a later configuration and different delivery ID. Ordinary non-candidate prose stays unsupported and is not retained as command text.

`comment.user` and `sender` must identify the same non-placeholder `User` account for a created command. An App/Bot, absent account, or ambiguous actor is not eligible. GitHub account authentication is the trust boundary; an ordinary account's `User` type does not prove that a human personally typed the command. Tokens, raw webhook bodies, unrelated comments, and raw model output must not enter approval receipts.

Capture the originating body digest before redaction and compare it with the digest of the authenticated live comment body. A material body change is detected even if the provider timestamp did not change. The body digest is provenance, not a bearer capability: possessing the digest or run ID grants no authority.

## 6. Application checks

For an unresolved operation, use the existing canonical-repository and association paths, then perform fresh authenticated reads within the application ownership boundary:

1. Confirm active B1 opt-in and numeric repository allowlisting, installation scope, and the ordinary non-suspended association. Both association index and `run.github` must identify the same installation/repository/PR/run tuple.
2. Require the command run ID to equal that existing association. Do not call candidate matching to create/rebind an association from approval text. Reject legacy ID-less and conflicting bindings through existing identity handling.
3. Read the current open PR using a deterministically built API route. Verify stable base-repository identity, PR number, head branch, and base/head SHAs against both `run.github` and the association index. A B1-specific observation must also require numeric `head.repo.id` equal to the base repository ID. The current [Phase A PR snapshot](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/github/pull-request.ts#L7-L21) intentionally does not read `head.repo`; preserve its existing fork support outside B1. A head/base change is stale approval context, not permission to replace workspace or evidence. Existing authenticated PR-event reconciliation remains separate.
4. Read the comment by numeric ID from the reconciled repository. Verify its returned ID, containing issue/PR, numeric author ID/type, created/updated timestamps, and exact body digest against the admitted event. Treat URLs returned by GitHub as data to validate; never execute a payload-provided URL or shell command.
5. Query current repository permission for the freshly fetched author's login. Verify the response's numeric user ID matches the admitted actor. Only base `write`/`admin` qualifies; GitHub maps maintain to write and triage to read. `author_association`, display names, `role_name`, PR ownership, and review prose are insufficient.
6. Reload the authoritative run after lock acquisition. Require its version to equal the command's requested version, no supersession, matching active association, both configuration opt-ins and their effective actor restrictions, and the exact waiting gate. Observe the local managed-workspace identity, branch, and HEAD near commit through existing ownership/Git proof primitives; compare them with recorded workspace context and the PR head branch/SHA. Preserve the applicable existing dirty-workspace/content policy rather than introducing a blanket clean-tree rule. `workspace.baseSha` is the [operator source HEAD captured at bootstrap](https://github.com/tomazb/multi-agent-software-engineer/blob/adad3664ba4d536547f857328e610426548d03c4/src/workspace-bootstrap.ts#L57-L69), while `run.github.baseSha` is the PR target-branch base: they are distinct facts and need not be equal. Select the artifact deterministically from the gate: `02-brainstorm.md` or `03-specification-and-design.md`.
7. Resolve the current immutable artifact reference, verify its bytes through `RunStore.readArtifact`, and compare the requested SHA-256 with that reference. Record logical name, immutable attempt, and digest. No command-selected file path is admitted.
8. Apply the public commit-only core operation using the command's expected run version, artifact identity, context, and validated bounded source provenance. A version conflict discards the prepared authorization observation. Reacquire ownership and check for an exact committed receipt first; if none exists and the current version differs, finalize a stale rejection. Never rebase the request onto a newer version. Any otherwise eligible retry rechecks external facts.

Rate limits, timeouts, malformed responses, ambiguous authorization/404 responses, unavailable artifacts, uncertain writes, and lock contention do not become permanent acceptance or rejection. They leave the operation unsettled with a bounded diagnostic and use existing delivery retry/operator intervention. A definitive authenticated insufficient permission, stale artifact, wrong gate, disabled policy, or mismatched immutable identity produces a final rejection. Receipt replay, described next, is checked before considering a new transition.

Remote permission and PR state can change after an API observation. B1 promises fresh execution-time observation and local version/ownership checks; it does not claim an atomic transaction spanning GitHub authorization and the local filesystem. Store observation times, and do not reuse authorization across a released/reacquired lock or retry.

## 7. Core ownership and commit boundary

Introduce a public commit-only approval operation in `src/orchestrator.ts`. Its exact TypeScript method name is an implementation choice; its contract is not:

- Accept expected run/gate/artifact/context identity and a validated, typed provenance record.
- Establish/reuse the existing run target mutation fence without recursive acquisition; reload the run and reassert the local preconditions within it.
- Check for an exact prior accepted operation before rejecting a now-advanced state.
- Commit the approval Boolean, existing transition, and typed approval receipt in one `RunStore.applyEvent`/save CAS.
- Return a typed applied/already-applied/rejected result without starting the next role.

The adapter owns authenticated GitHub reads and routing. The core owns artifact/state/transition validation and durable approval acceptance. Neither a webhook handler nor an LLM writes approval fields directly. A typed argument alone is not proof of remote authorization: the only production GitHub entry path must perform the checks above, and this internal core method is not exposed as an unauthenticated RPC.

The local CLI wrapper supplies local-user provenance and the current verified artifact, calls the same commit-only operation, then preserves its existing `runUntilBlocked` behavior. Explicitly test this reconciliation: local approval now uses the same verified artifact commit boundary, while remote approval stops at the next phase state.

### Lock ordering

Use one `approval-operation` ownership journal per semantic operation as the outermost B1 lock. Inside it, preserve the existing order:

1. Repository-identity entry/reconciliation fence, released before longer PR work.
2. PR publication fence keyed by numeric repository ID and PR number.
3. PR association-identity fence for the same tuple.
4. Run target mutation fence.
5. Global association transaction only for a bounded snapshot/check if needed, then the run store's data CAS at commit.

No existing path acquires an approval-operation lock while holding an inner lock. The implementation must reuse/extract the existing fence helpers so no callback reacquires a held journal. Do not hold the global association transaction during network requests or model execution. Re-read the index and run before approval commit, and serialize/reject changes through the same existing ownership and CAS boundaries used by association/recovery work.

Do not put approval writes inside `saveGitHubAssociationMutation` or register them for its rollback. An accepted approval event is monotone historical evidence; an unrelated association settlement failure cannot undo it. The local CLI path and remote path must converge on the same run-fenced core operation; cancellation/supersession or another run writer still wins or loses by the existing version check, never by overwriting a newer record.

## 8. Semantic receipts and recovery

### Two identities

`deliveryId` identifies an authenticated webhook delivery. A semantic approval operation is keyed by the pair `(numeric repository ID, numeric comment ID)`, independent of delivery ID, mutable repository name, and later installation/name changes.

Define its stable key as SHA-256 of the UTF-8 JSON array `["github-approval-comment",1,repositoryId,commentId]`. Validate each record's embedded tuple against the filename/key. Compare an immutable request identity containing originating installation, PR, actor ID, created/updated timestamps, command prefix/run/requested-version/gate/artifact digest, and exact comment-body digest. Whole webhook body digests remain per-delivery provenance; they do not redefine semantic identity across delivery IDs.

### Feature-specific operation record

Persist a closed, versioned record under `<githubRoot>/approval-comments/<key>.json`, using existing ordinary-file checks, authoritative byte limits, durable atomic writes, and the shared ownership-journal library with a distinct typed namespace. The record has only `pending` and `final` lifecycle states; these are receipt states, not new MASWE workflow states.

A pending record binds the immutable request and first delivery before application. A final record contains one outcome: applied, already satisfied with exact existing approval evidence, or rejected with a bounded reason code. Applied/already-satisfied outcomes name the run and exact approval event/receipt that justifies them. Record actor, policy observation identity, run/artifact/head context, and timestamps in bounded typed fields; never retain credential material. A rejection does not change workflow state.

Final records are immutable. A replay with identical request identity returns that final outcome; a different tuple/body for the same key is a conflict and cannot overwrite the record. This rule also applies when an earlier rejection preceded association creation or a permission/configuration change. Existing run Booleans or current state alone cannot establish an already-satisfied outcome. If exact earlier approval evidence is unavailable, reject the new request without inventing that evidence.

An `APPROVE_*` event stores the authoritative successful receipt in the same run write as the gate transition. Its receipt includes schema version, semantic key/request identity digest, requested run version, source actor and delivery reference, approved artifact name/attempt/digest, evaluated association and separate PR/workspace base/head facts, and authorization observation. Extend durable event validation with this closed typed shape. Historical events remain readable but are never upgraded into remote approval receipts.

### Ordered protocol

Route typed B1 candidates to this protocol before the adapter's ordinary unsupported-type and mutable repository-policy early exits; existing observe-only event kinds retain their behavior. Recovery of an earlier accepted effect requires the original authenticated bounded identity, not current permission, an active association, or a surviving managed worktree. Terminal cleanup may already have removed that worktree. This recovery branch only reports history; all fresh application remains subject to section 6.

1. Acquire the semantic operation lock; load any record. Return an identical final outcome or reject a conflicting identity without dispatching new work. For an applied outcome, validate its exact authoritative run receipt reference; missing/corrupt evidence is unresolved, not permission to reconstruct an approval.
2. Persist the pending identity durably before changing run state. An uncertain intent write is reconciled before proceeding.
3. Use the existing confirmed-absence handling when locating the requested run. A definitively absent run has no prior receipt and receives a final `no-such-run` rejection without creating a run or run fence; an unreadable, corrupt, or ambiguously absent run remains unsettled. For an existing run, search its validated approval receipts under the run target fence before ordinary live eligibility routing. An exact committed receipt settles the operation as applied even if state has advanced or current authorization has since changed; this is reporting an earlier fact, not granting new authority. Release this recovery-only run fence before acquiring the full ordered application fences for any fresh effect.
4. If no committed receipt exists, perform fresh application checks. A valid request commits one approval event/Boolean/state atomically. A definitive rejection/no-change result is finalized in the operation record without a gate transition.
5. Settle the operation record from the committed run receipt. If that write fails or is outcome-unknown, keep the delivery retryable. Never compensate the committed run event.
6. Complete the delivery only after the operation outcome is durably known. A bounded completion outcome/reference may be added to the existing inbox tombstone for inspection; it is not the semantic receipt authority.

On an ambiguous run save, reload the authoritative run and validate the exact receipt. Its presence reconciles the completed approval; confirmed absence permits a fully revalidated retry; an unreadable/ambiguous result remains blocked/retryable. Never infer absence from a thrown save or infer success from a Boolean.

Receipts must not be evicted or expired in a way that reactivates an old operation. B1 reuses existing bounded file/ingress handling, and introduces no automatic receipt GC. Storage failure, malformed records, or quota exhaustion produce explicit unsettled/operator-visible failure. Decommissioning/reset of a state namespace is an operator procedure outside replay-preserving B1 operation.

### Failure matrix

| Interruption or race | Required result |
|---|---|
| Before pending intent is durable | No approval; retry admission under current facts |
| Pending intent exists, before core save | Revalidate and apply at most one matching transition |
| Core save landed but caller saw an error | Re-read exact run receipt; settle that historical result |
| Core save landed, operation settlement or inbox completion failed | Replay returns the same approval; no second event or automatic execution |
| Final no-change/rejection, replay under a new delivery ID after state/permission changes | Original final outcome; no new authority |
| Same semantic key with different run, gate, body, or actor | Conflict; original record remains unchanged |
| Two comments or CLI/remote approval race | One matching gate transition; losing request has an explicit evidenced no-change or rejection |
| Cancellation, supersession, association change, or artifact replacement races application | Ownership/CAS and fresh checks reject stale application |
| Remote lookup uncertainty or unreadable receipt/run | No authority increase; retry/explicit intervention |

## 9. Operator experience

Expose B1 decisions through the existing status/JSON and bounded local delivery diagnostics. An accepted result identifies the run, gate, immutable artifact, actor, receipt, resulting phase, and the existing `maswe run <run-id>` continuation command. It must say that approval was recorded and execution awaits that command. It must not report implementation or verification success.

The approval presentation is a projection of authoritative state, for example:

```text
Decision needed: approve design
Run: <run-id>, version <v>
Artifact: 03-specification-and-design.md, attempt <n>, SHA-256 <digest>
Context: repository <numeric-id>, PR <number>, head <sha>
Action: /maswe approve design <run-id> <v> <digest>
After acceptance: BUILDING; continue with maswe run <run-id>
```

Render only an action valid for the current state and verified artifact. A status view is advisory; application rechecks all authoritative preconditions. Do not silently fabricate retry eligibility from a terminal-state label; the independently scoped [#48](https://github.com/tomazb/multi-agent-software-engineer/issues/48) contract correction remains separate.

B1 sends no new GitHub replies/reactions and creates no dashboard, question lifecycle, notification queue, assignment/snooze state, or autonomous intake. Existing checks remain Phase A behavior. External communication features retain their later tranche scope.

## 10. Acceptance criteria and test matrix

All rows are proposed implementation tests, not tests executed by this design PR. Tests must exercise the production normalizer, durable inbox, adapter checks, core commit operation, and store boundary as applicable.

| ID | Scenario | Required evidence |
|---|---|---|
| B1-01 | No opt-in, historical configuration, mismatched prefix, or only one of listener/run enabled | Candidate receives durable rejection; replay after configuration changes gains no effect; unchanged Phase A behavior |
| B1-02 | Valid created comment for each gate | One approval event/Boolean/state commit, exact artifact receipt, no runtime execution |
| B1-03 | Ordinary issue, label, reaction, review comment, edit/delete, prose/quoted/multiple command | No approval; explicit supported/ignored/rejected classification |
| B1-04 | Invalid ID/digest/prefix/encoding/size or extra fields | Fail closed before core mutation; no command execution or raw secret persistence |
| B1-05 | Bot/placeholder, sender-author mismatch, reused login, user-ID mismatch | Rejection without authority increase |
| B1-06 | Base permissions read/none versus write/admin; optional actor restrictions | Only the effective intersection admits the actor; custom role_name alone grants nothing |
| B1-07 | Permission/configuration changes while waiting for locks | Fresh application-time policy applies |
| B1-08 | Wrong repository/install/PR/run; missing, conflicting, legacy, suspended, or fork association | No new/rebound association or approval |
| B1-09 | PR head/base/branch changes after ingestion or run version changes before application | Reject stale context without rebasing the command; preserve existing revalidation protocol |
| B1-10 | Comment edit with changed body but unchanged timestamp; delete before first application | No approval from changed/unavailable evidence |
| B1-11 | Stale artifact reference, identical-content replacement attempt, corrupt bytes, path escape, or symlink | Requested version and verified artifact checks reject; no receipt of approval |
| B1-12 | Duplicate same delivery and same comment under different delivery IDs | Original final outcome; one accepted transition |
| B1-13 | Final no-change/rejection followed by later valid gate, association, or permission | Replay cannot acquire a new effect |
| B1-14 | Distinct request identity under an existing semantic key | Conflict; no overwrite or second approval |
| B1-15 | Crash/ambiguous write at every pending/run/final/inbox boundary, followed by policy revocation or terminal worktree cleanup | Exact historical receipt settles before live eligibility checks; no new effect or surviving worktree required |
| B1-16 | Two remote comments and CLI-versus-remote race | Store/fence integration proves one transition and correct losing outcome |
| B1-17 | Concurrent cancellation, supersession, association mutation, and artifact mutation | No stale overwrite, deadlock, or approval compensation |
| B1-18 | Rate limit, timeout, 404 ambiguity, malformed permission response, or storage failure | Unsettled retry/diagnostic, no invented permanent outcome |
| B1-19 | Tampered/corrupt/oversized operation or run receipt | Validation rejects and does not recreate authority |
| B1-20 | Status and completion diagnostics | Exact subject/result/next action, stable correlation, redaction, no external reply |
| B1-21 | Existing local approve CLI | Same approve-and-run behavior through verified core approval boundary |
| B1-22 | Permission and installation qualification | App subscription Issues:read is documented/tested; narrowed REST token permissions remain exact |
| B1-23 | Phase A and broader workflow regressions | Existing ingress, identity, revalidation, cleanup, and check-publication behavior remains valid |

Use fault injection and deterministic barriers for concurrency/crash tests; elapsed sleeps alone do not establish ordering. Test normalizer and persisted event validation together so unsupported records cannot bypass ingress checks through disk replay.

## 11. Implementation surface and validation

Expected implementation areas after owner approval:

- `src/domain.ts`, `src/config.ts`, and `schemas/config.schema.json`: explicit opt-in, closed actor policy, and persisted configuration rules.
- `src/github/types.ts`, `normalize.ts`, and `delivery-inbox-record.ts`: bounded comment command event and validation.
- A narrow approval parser/reader/operation-record module under `src/github/`, built on existing HTTP, durable-file, and journal primitives, including B1-only head repository observation without changing Phase A fork eligibility.
- `src/github/adapter.ts`, dispatch disposition and inbox inspection: application checks and durable typed outcomes; reuse existing association and ownership boundaries.
- `src/orchestrator.ts`, approval event validation, and relevant artifact contracts: public commit-only operation and atomic typed receipt; preserve CLI wrapper behavior.
- `src/run-rendering.ts` and existing CLI inspection: decision context and recorded outcome only.
- Focused regression/integration tests and the GitHub App/operations documentation.

Do not widen the current check-run side-effect record union into an arbitrary job framework. Any additive journal kind, receipt format, event shape, or configuration field is explicitly part of this proposed B1 contract and must receive closed validation and focused tests. Schema identifiers change only through a separately justified version decision; absent B1 optional fields mean disabled, not inferred approval.

Implementation validation must use the repository's canonical Node `24.18.0` and compatibility Node `22.22.2`, recording executable identity and npm version. Run the relevant focused tests, `npm run check`, `npm run pack:dry`, and `git diff --check`; confirm CI and independent review against the exact implementation head. The design PR itself changes documentation only and must report its actual validation evidence without presenting unrun implementation tests as passing.

## 12. Deliberate deferrals and decision log

The following remain outside B1: PR/branch creation; GitHub replies and thread resolution; approval labels; regular-issue-to-run binding; organization/team-specific policy APIs; automatic execution after remote approval; approval revocation through comment edits; full attention lifecycle; cross-thread subscriptions; proactive admission; external harnesses; distributed storage/outbox; automatic merge. Existing runtime timeout work [#49](https://github.com/tomazb/multi-agent-software-engineer/issues/49) remains independently scoped.

These are proposed builder decisions for owner review: PR-only created comments; exact single-line grammar; both listener/run opt-in; fixed repository write/admin floor with optional numeric allowlist; commit-only remote approval; a feature-specific stable comment receipt paired with the authoritative run event; no automatically expiring receipts; and explicit App Issues:read subscription permission. Any change that expands these boundaries returns to design review.

## 13. Prior art and source disposition

The DeepSeek prototype was inspected at [`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4). This is source/test inspection, not a live qualification or measured benefit claim.

- Its [attention/report handling](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/assignments.ts) and [stage classifier](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/stage.ts) motivate a concrete decision view. B1 derives that view from MASWE facts; it does not adopt the ticket lifecycle.
- Its [authorization model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md) separates context and work admission. MASWE retains separate human artifact approval; mandate text or a model judgment does not supply it.
- Its [delivery/read distinctions](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/delivery.ts) inform explicit acknowledgement versus durable-effect tests. General harness consumption/settlement belongs to [#50](https://github.com/tomazb/multi-agent-software-engineer/issues/50), and distributed effects/views belong to [#4](https://github.com/tomazb/multi-agent-software-engineer/issues/4).
- Existing T3 and Zeroshot references in #3/#50 remain in force, particularly accepted no-change receipts, execution-time provenance, and evaluated-content identity. This document does not incorporate their source code or authorize their frameworks.

Governing local references: [GitHub App design](../../GITHUB_APP.md), [architecture](../../ARCHITECTURE.md), [artifact contracts](../../ARTIFACT_CONTRACTS.md), [roadmap](../../ROADMAP.md), and [ADR-0005](../../adr/0005-deterministic-git-and-github-side-effects.md). The owner-approved MASWE authority and one-writer rules in [AGENTS.md](../../../AGENTS.md) remain governing constraints.
