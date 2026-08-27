# Issue #34 Stable GitHub Repository Identity and Rename Reconciliation Design

## Status

- **Issue:** #34 — Handle GitHub repository renames with stable repository identity
- **Related:** #3 — v0.3 GitHub App Phase B
- **Predecessor:** #27 — correctness hardening, completed
- **Date:** 2026-08-27
- **Exact baseline:** `main@4565d1c0661ff6cf20185f718b59c40d9c837c77`
- **Branch:** `issue-34-stable-repository-identity-design`
- **Design status:** owner-approved architecture; two external validation rounds incorporated; awaiting owner final review
- **Implementation authority:** none yet. This branch contains design only. Runtime, schema, CLI, migration, test, documentation, and issue implementation require a separately approved implementation plan.

This is a design specification. Proposed behavior remains unverified until implemented and tested.

## 1. Problem and objective

Phase A currently treats mutable `owner/repository` text as primary identity in the allowlist, run association, webhook normalization, association index, repository/PR fences, suspension/branch lookup, installation-token scope, local unassociated-run matching, and check idempotency. A GitHub rename therefore breaks local identity even though the underlying repository is unchanged.

Issue #34 makes GitHub's stable numeric repository ID authoritative for repository authorization, association, locking, reconciliation, credential scope, and side-effect ownership, while retaining current canonical `owner/repo` as mutable routing/display metadata.

Required invariants:

1. Stable numeric ID is authoritative; a name never proves equivalence or authorization.
2. Canonical `owner/repo` may change without changing an already stable association.
3. Future Phase B writes may target only explicitly allowlisted repository IDs.
4. HTTP redirects are never repository-identity evidence.
5. Installation, PR target, PR number, exact head SHA, and check-resource ownership remain independently proven.
6. Legacy schema-v1 state remains readable by the #34 binary but cannot authorize repository-scoped operations until reconciled.
7. Migration is explicit, authenticated, idempotent, restartable, and never hand-edits authoritative state or immutable journals.
8. Unknown/conflicting identity fails closed.
9. Correctness does not depend on receiving a dedicated rename webhook.
10. #34 adds no Phase B write authority; current `readOnlyChecks` restrictions remain.
11. Mixed pre-#34/#34 binaries are unsupported during the identity cutover; old processes must be quiescent before migration.
12. Authority-reducing legacy signals may reduce unresolved legacy authority, but a name-only signal may never grant, restore, migrate, or redirect authority.

## 2. Selected architecture

Use **dual identity with in-place restartable migration**:

```text
repositoryId      = immutable GitHub repository identity / authorization key
repository        = current canonical owner/name for REST routing and display
installationId    = GitHub App installation authority boundary
pullRequestNumber = PR identity within repositoryId
headSha           = exact evidence/publication revision
```

Rejected alternatives:

- separate GitHub-state v2: unnecessary schema/persistence churn before later MH-01/MH-02 evolution;
- name-primary index plus secondary ID map: leaves competing authoritative identities and complicates crash recovery/locking.

`repositoryId` is a positive JavaScript safe integer and becomes authoritative for allowlisting, association keys, repository/PR fences, repository suspension, token repository restriction, check idempotency, rename reconciliation, and later Phase B repository authority.

`repository` remains lowercase canonical `owner/repo` and may be updated only after authenticated live reconciliation for the already-authorized ID.

## 3. Configuration, authorization, and compatibility

Normalized GitHub App configuration becomes conceptually:

```ts
interface GitHubAppConfig {
  enabled: boolean;
  readOnlyChecks: boolean;
  webhookSecretEnv: string;
  appIdEnv: string;
  privateKeyEnv: string;
  allowedRepositoryIds: number[];
  allowedRepositories: string[]; // legacy selector/display only
  webhookHost?: string;
  webhookPort?: number;
}
```

Raw historical/project config may omit either allowlist. Config migration normalizes missing arrays to `[]` in memory without rewriting historical persisted run snapshots.

### 3.1 Enabled-time validation rule

The current baseline requires a non-empty `allowedRepositories` whenever `githubApp.enabled` is true. #34 deliberately replaces that rule.

After #34, an enabled GitHub App configuration is valid only when **at least one** of these arrays is non-empty:

```text
allowedRepositoryIds.length > 0
OR
allowedRepositories.length > 0
```

This preserves loadability of existing name-only configurations and permits the target ID-only configuration. An enabled config with both arrays empty is invalid.

`allowedRepositoryIds` entries must be unique positive safe integers. `allowedRepositories` entries retain canonical owner/repo validation and are normalized to lowercase.

This is only a configuration-load rule. Operational authorization is stricter.

### 3.2 Operational authorization rule

Any repository-scoped association, reconciliation, credential mint, workflow mutation, check publication, or future Phase B write requires:

1. a non-empty live `allowedRepositoryIds`;
2. the exact target `repositoryId` in that list.

`allowedRepositories` remains accepted only to:

- load historical/project configuration during migration;
- select/diagnose unresolved legacy local records;
- display operator context.

It cannot authorize webhook-driven run mutation, check publication, rename reconciliation, credential scope, future Phase B writes, or old/new-name equivalence.

A GitHub-enabled name-only project config remains loadable for offline inspection and migration preparation, but the documented cutover in §9.1 requires `allowedRepositoryIds` to be configured **before any #34 webhook listener starts**. There is therefore no intentional listener window in which repository deliveries are accepted under name-only authorization.

If an operator violates that ordering and starts a #34 listener with name-only configuration, signed ingress may still be durably accepted, but repository-scoped dispatch receives a permanent `stable-repository-authorization-required` disposition, cannot mutate authority, and is counted in the bounded diagnostic counter defined in §16. Correctness never depends on replaying such consumed deliveries; migration and later manual publication re-read authoritative live repository/PR state.

`installation.deleted` may still reduce authority by persisted `installationId`, including for unresolved legacy associations; it never establishes repository identity.

### 3.3 Schema and downgrade posture

Keep `config.version: 1` and `RunRecord.schemaVersion: 1`. `allowedRepositoryIds` and run-association `repositoryId` are additive schema-v1 fields for the #34 binary.

This is **forward migration compatibility, not backward-binary compatibility**. Once #34 writes the new fields/stable association form, downgrade to a pre-#34 binary is unsupported. Existing exact-object/association validation should cause old binaries to fail closed rather than silently ignore stable identity and resume name-authoritative behavior.

All pre-#34 GitHub listeners/manual publishers must therefore be stopped before migration/cutover and must not be restarted against migrated state.

## 4. Installation-token identity and least privilege

Current token creation scopes by mutable repository name. #34 moves every repository-restricted token to GitHub's numeric `repository_ids` request field. There is no name fallback.

Use explicit token purposes:

```ts
type GitHubInstallationTokenPurpose =
  | "metadata-reconcile"
  | "pull-request-read"
  | "checks";
```

- `metadata-reconcile`: `repository_ids: [repositoryId]`, `metadata: read` only. Used to prove installation access and discover current canonical name.
- `pull-request-read`: same ID scope, `pull_requests: read` plus `metadata: read`. Used by association/migration PR ownership proof without granting check write.
- `checks`: same ID scope, existing Phase A permissions `checks: write`, `pull_requests: read`, `metadata: read`. Used only for current check publication/reconciliation.

Future Phase B token purposes require separate #3 authorization; #34 must not broaden these purposes implicitly.

## 5. Authenticated canonical repository lookup

MASWE uses the documented `GET /installation/repositories` endpoint with the ID-scoped `metadata-reconcile` installation token and requires an object with exactly the requested numeric ID and a valid current `full_name`.

The old repository URL is never queried to infer redirect equivalence.

### 5.1 Bounded pagination is part of correctness

GitHub documents this endpoint as paginated, defaulting to 30 results per page with a maximum `per_page` of 100. #34 must not assume the target appears on page 1.

Use `per_page=100` and bounded pagination with an explicit maximum of 100 pages. Pagination handling must:

- pin origin to the adapter's **hardcoded** GitHub API origin (currently `https://api.github.com`); #34 does not introduce API-origin configurability;
- pin path to `/installation/repositories`;
- allow only the expected `per_page` and `page` query keys;
- reject user-info, fragments, unexpected query parameters, malformed/duplicate `rel` values, multiple `next` links, loops, and unsafe origins/paths;
- deduplicate repository IDs across pages and reject the same ID with conflicting names;
- stop immediately when the exact requested ID is found and validate its canonical name;
- distinguish successful terminal exhaustion from incomplete/ambiguous traversal.

A fully successful traversal that reaches the terminal page without the requested ID is positive evidence that the scoped installation token cannot currently see that repository and may feed authorization-revoked handling.

Page-limit exhaustion, malformed pagination, an unsafe next link, loop detection, rate limiting, transport failure, or GitHub 5xx is **not** proof of revocation. It is a retryable/operationally blocked reconciliation failure and performs no authorization suspension.

The 100-page × 100-row bound deliberately caps one reconciliation traversal at 10,000 returned rows. Hitting that bound must surface a typed operator-facing limit error and leave authorization unchanged. Operations guidance should direct the operator to narrow the GitHub App installation repository scope or use a later MASWE version with a qualified direct-ID lookup rather than increasing the bound ad hoc.

The implementation may exploit the fact that the token itself is requested with `repository_ids: [repositoryId]`, but must not make correctness depend on an undocumented assumption that the listing will always contain at most one row.

### 5.2 Direct numeric repository lookup alternative

Current official REST documentation used for #34 documents the installation repository listing and owner/name repository lookup, but does not expose a qualified singular `GET /repositories/{repository_id}` contract for this installation-token flow. #34 therefore uses the documented listing with bounded pagination.

If GitHub later documents and qualifies a direct numeric-ID lookup for installation access tokens, it may replace the listing implementation without changing MASWE's stable-identity contract.

## 6. Webhook normalization and durable inbox compatibility

Every currently supported repository-scoped event normalized by the new binary requires and persists:

```ts
repositoryId: number;
repository: string;
```

This includes pull request, push, workflow run completed, check run completed, and check suite completed. Missing, zero, negative, fractional, unsafe, or otherwise malformed `repository.id` fails normalization.

`installation_repositories` must preserve ID/name pairs rather than parallel arrays:

```ts
interface GitHubRepositoryIdentity {
  repositoryId: number;
  repository: string;
}
```

Identical duplicate pairs deduplicate deterministically. Duplicate numeric ID with conflicting names is malformed.

### 6.1 Historical ID-less durable events

Historical durable normalized repository events may lack `repositoryId` because old binaries discarded it before enqueue. Transitional readers may load those records, but they must never upgrade identity from name.

For ordinary repository events and authority-granting signals, an ID-less legacy event receives permanent `legacy-repository-identity-missing`, mutates nothing, and is consumed rather than retried forever.

### 6.2 Legacy authority-reducing removal

`installation_repositories.removed` is the one name-only repository event allowed to reduce unresolved legacy authority.

For a historical ID-less removal event, MASWE may select **only unresolved legacy associations** that:

- have no `repositoryId`;
- have the same `installationId`;
- have the exact normalized legacy repository name carried by the historical event.

Those unresolved associations may be marked/synchronized as `authorization-revoked`. The event must not:

- assign a repository ID;
- refresh a canonical name;
- suspend a stable-ID association by name;
- authorize a replacement repository with the same name;
- clear an existing suspension.

A historical ID-less `installation_repositories.added` event cannot grant or restore authority and is consumed with zero authority increase. New ID-bearing add/remove events operate by stable repository ID.

This preserves the fail-closed revocation signal without allowing name-only events to establish continuity.

**Legacy-only synchronization rule:** §6.2 does **not** use either a name-keyed repository/PR fence or the stable `repository-identity(repositoryId)` fence, because the unresolved record has no trustworthy repository ID. The initial name/installation match is only an advisory candidate selection. For each candidate MASWE acquires the run target-mutation fence for `runId`, then enters `GitHubAssociationIndex.withTransaction()` under the existing single global association journal, reloads/revalidates that the association is still unresolved and matches the same installation/name tuple, and applies the authority-reducing run/index update through the normal transaction/rollback semantics. This is the legacy-only lock branch documented in §9 and shares the same `run fence -> association transaction` suffix as stable association mutation.

## 7. Local Git remote semantics

The local remote remains workspace provenance/candidate metadata, never repository authorization.

For an already stable-associated run, a stale pre-rename `workspace.remote` does not invalidate the GitHub association and #34 does not rewrite the operator's remote.

For a run with no GitHub association, existing exact current-remote + branch matching may remain only as a candidate selector. Before binding, MASWE must prove:

1. incoming stable ID is live-allowlisted;
2. live PR target/base repository ID equals that stable ID;
3. installation, branch, and head conditions pass.

If rename happened before first association and the local remote still contains the old slug, MASWE does not infer equivalence from redirect behavior. The operator must update the remote before candidate matching.

## 8. Association/index model

Add `repositoryId` to `RunGitHubAssociation` and `AssociationRecord`. Every newly bound association requires it. Historical persisted associations may omit it only at deserialization/migration boundaries.

Operational code uses a helper equivalent to `requireStableGitHubAssociation()` and rejects unresolved legacy state before any stable repository/PR publication fence is acquired.

New association key:

```text
<repositoryId>#<pullRequestNumber>
```

During migration, `associations.json` may contain:

- legacy `<owner/repo>#<pr>` entries without `repositoryId`;
- stable `<repositoryId>#<pr>` entries with `repositoryId`.

The transitional parser must reject malformed keys, key/record mismatch, duplicate active run IDs, duplicate stable PR identity, inconsistent stable/legacy claims for the same run, unsupported fields, and malformed timestamps.

Normal lookup, branch lookup, and repository suspension become stable-ID based. Migration gets an explicit exact-name legacy enumeration path.

## 9. Stable fences, cutover, and lock order

Add a new `repository-identity` GitHub journal/fence kind keyed by `repositoryId`. The implementation must add it explicitly to:

- `GitHubJournalKind`;
- `JOURNAL_KINDS`;
- operation/validation mappings;
- journal initialization/recovery coverage;
- focused journal tests and operations documentation.

It serializes legacy migration, canonical-name reconciliation, repository authorization suspension/recovery, and repository-scoped publication entry for stable-ID records.

PR publication/association fences use `<repositoryId>#<pr>`.

Stable-ID lock order:

```text
repository-identity(repositoryId)
  -> PR/publication identity(repositoryId, pr)
    -> run target mutation fence(runId), when required
      -> global association transaction / check-create lock
```

Legacy ID-less authority reduction from §6.2 uses the common suffix only:

```text
run target mutation fence(runId)
  -> global association transaction (association / associations)
```

The legacy branch must never acquire a name-keyed publication/association-identity fence and must never invent/acquire a repository-ID fence. Selection by legacy name is advisory; the exact unresolved tuple is re-proved after both governing locks are held. No code path may invert `association transaction -> run target fence`.

Helpers operating under an already-held identity context must not reacquire the same journal.

### 9.1 Name-key/ID-key transition window and cutover order

A pre-#34 name-keyed lock and a #34 ID-keyed lock are different lock identities and do not mutually exclude. Stable fences alone therefore cannot make mixed old/new binaries safe.

The documented cutover is explicit and quiescent:

1. stop every pre-#34 `github-webhook` listener and manual GitHub publisher;
2. install/select the #34 binary and update the live configuration with the approved `allowedRepositoryIds` **before starting any #34 listener**;
3. while GitHub listeners/manual publishers remain stopped, run a read-only legacy-journal ownership preflight and refuse migration while a live legacy name-keyed publication/association-identity owner is observed;
4. run the required repository-identity migrations to completion under the #34 binary;
5. only after migration completes, start the #34 webhook listener and resume manual GitHub publication;
6. the #34 binary removes name-keyed publication/association fence acquisition from operational paths in the same change that introduces stable fences; §6.2 instead uses its explicit run-fence/global-association legacy branch;
7. after migrated state/new fields are written, old binaries are unsupported and expected to fail closed on exact validation.

The preflight requires a new **read-only legacy GitHub journal inspection API**. It should follow the existing legacy-enumeration/recovery patterns (including the shape used by legacy check-create initialization), validate/classify legacy ownership evidence without acquiring the old logical publication/association-identity lock, and report live/dead/malformed/ambiguous ownership conservatively. The implementation plan must name the exact API and tests; §20 includes this as an explicit synchronization surface.

The live-lock preflight is defense in depth; it cannot prove that an idle old process will never acquire a legacy lock later. **Operator/process quiescence of all old binaries is a hard migration precondition**, not merely a lock-state observation.

Because the documented sequence configures stable IDs and completes migration before the #34 listener starts, there is no intended maintenance window in which repository deliveries are consumed only because stable authorization/migration is incomplete. Operations documentation must nevertheless instruct the operator to inspect GitHub delivery history after the deliberate listener outage and redeliver any delivery GitHub reports as failed during maintenance; MASWE must not claim such transport-failed deliveries were durably received.

Concurrency tests must include the transition case: a live legacy name-keyed publication/association lock blocks migration, and no repository mutation occurs until it is gone/recovered under the documented old-process shutdown rule.

## 10. Live canonical-name reconciliation

Correctness does not depend on a dedicated rename webhook. Reconciliation runs when a repository-bearing event has the correct ID but a different name, manual publication begins, migration verifies legacy state, or another repository-scoped operation requires a possibly stale route.

Under repository identity fence:

1. require stable ID live-allowlisted;
2. require expected installation;
3. mint ID-scoped metadata token;
4. perform bounded authenticated canonical lookup from §5;
5. require the exact requested ID and current valid `full_name`;
6. synchronize run/index canonical name recoverably if changed;
7. reload and re-prove stable identity before using the route.

An old-name replay with the same ID can locate the same association but cannot roll the canonical name backward; live ID reconciliation decides the current name. Same text with a different ID is a permanent conflict.

## 11. Pull request ownership proof

Any live PR read used for association, migration, or publication must prove the PR target. The helper validates state, head SHA, target/base repository ID (`base.repo.id`), base canonical name where available, and base/head refs/SHAs where callers depend on them.

**Repository ownership is checked against `base.repo.id`, not `head.repo.id`.** Fork PRs legitimately have a different head repository. A different/missing base repository ID is a permanent identity conflict.

Migration/association proof uses the ID-scoped `pull-request-read` token. Check publication may use its already-required ID-scoped `checks` token for the same live PR read.

## 12. Explicit legacy migration

Concrete flat CLI command:

```text
maswe github-migrate-repository \
  --from <legacy-owner/repo> \
  --repository-id <positive-safe-integer>
```

Optional `--json` may provide deterministic operator output; global `--cwd` and `--config` keep current semantics.

`--from` is only a local selector and never identity proof. It is parsed with the same owner/repo grammar as repository metadata, normalized to lowercase before exact legacy selection, and its normalized form is used in checkpoint identity/output.

Migration requires:

- GitHub App enabled;
- supplied ID live-allowlisted;
- valid normalized legacy selector;
- credentials available;
- no Phase B writer authority;
- mandatory pre-#34 process quiescence and cutover ordering from §9.1;
- repository identity fence held;
- affected installation IDs derived from authoritative migration candidates rather than guessed from name.

For each affected installation:

1. mint metadata token scoped to supplied ID;
2. perform bounded canonical lookup;
3. require the same ID/current canonical name;
4. require consistent stable identity across successful proofs.

For each selected legacy association:

- require run/index equality on installation, legacy name, PR number, base/head SHA, branch, and suspension state, except already-idempotent same-ID migration;
- use ID-scoped `pull-request-read` credential/current canonical route;
- require live `base.repo.id === repositoryId`;
- compare live PR state/head/base/branch with stored state;
- route head drift through existing #28 revalidation semantics.

Stale/missing/conflicting run/index state stops migration. MASWE never chooses one persisted copy as probably correct.

## 13. Migration checkpoint, candidate universe, and crash recovery

Persist a bounded restart-intent/status record under GitHub authoritative state, protected by repository identity journal:

```ts
interface RepositoryIdentityMigrationRecord {
  version: 1;
  repositoryId: number;
  legacyRepository: string;
  canonicalRepository: string;
  status: "in-progress" | "complete";
  startedAt: string;
  updatedAt: string;
}
```

The checkpoint is observability/restart intent, not authorization. Every invocation revalidates live config and GitHub access.

### 13.1 Restart candidate universe

No per-run completed list is required, but restart must not derive candidates only from still-legacy records because a partially migrated run would disappear from that set.

On every pass, candidate universe is the union of:

1. unresolved legacy run/index associations whose normalized repository equals `legacyRepository`;
2. stable run/index associations whose `repositoryId` equals the checkpoint/supplied `repositoryId`.

The distinct installation-ID proof set is re-derived from that union on every pass. Therefore a run that changes from legacy to stable during a partial migration remains in the next restart scan. The repository identity fence prevents concurrent same-repository association creation/mutation from changing this universe while one migration pass owns it.

Each candidate is classified as legacy, already migrated to same ID, same-ID canonical-refresh-needed, suspended, or conflict. A stable record with the same ID but unrelated current canonical name is still part of the stable-ID proof set and must reconcile by ID, not by migration history guesswork.

### 13.2 Durable write uncertainty

Migration/live rename synchronization reuses current association transactions and optimistic run persistence. Known failures may use existing rollback where safe; outcome-unknown writes require re-read/reconciliation rather than blind rollback.

On any atomic-write outcome unknown, re-read run, index, checkpoint, and affected side-effect alias; continue only when the exact intended stable identity is provably on disk.

Final success requires a full candidate-universe rescan showing:

- no selected unresolved legacy association remains;
- all same-ID run/index records agree on stable identity/current canonical metadata;
- required installation proofs succeeded;
- any required stale-head revalidation/cancellation intent is durably represented.

Re-running the same completed migration is a no-op after live proof. Same normalized selector with a different ID conflicts and mutates nothing.

Immutable workflow events and immutable GitHub journals are never rewritten.

## 14. SHA evidence and PR lifecycle

If live head is unchanged, migration may preserve existing SHA-bound evidence because only routing metadata changed.

If live head differs, stable identity migration may complete but old success becomes unusable, pending check cancellation state is updated, and the run enters existing GitHub-origin #28 revalidation before merge-ready/completion evidence can be reused.

If the live PR is closed, apply existing pull-request-closed suspension under stable identity.

## 15. Check idempotency and existing check ownership

Replace mutable key:

```text
check-run:<owner/repo>/<pr>/<head>/<check>/<attempt>
```

with stable key:

```text
check-run:<repositoryId>/<pr>/<head>/<check>/<attempt>
```

The derived external ID then remains stable across future renames.

### 15.1 Legacy production attempt scope

On the validated baseline, production `GitHubAppAdapter` constructs `CheckPublisher` without an attempt override and `CheckPublisher` defaults to attempt `1`. Existing non-1 values (for example the concurrency fixture using attempt `7`) are explicit test/internal seams, not a production publication path.

Therefore #34 migrates only legacy production attempt `1` for operationally relevant heads:

```text
{ association.headSha } U association.pendingCancellationHeadShas
```

Before implementation is considered complete, code search/tests must prove that no production caller supplies `attempt != 1`. If a production non-1 path is introduced before #34 merges, the migration contract must be expanded and re-reviewed rather than silently leaving duplicate-check risk.

Historical test/internal non-1 side-effect keys are intentionally not migration authority and may remain untouched. The stable key format itself retains `<attempt>` for future explicitly governed production evolution.

### 15.2 Alias existing production checks

For each operational head and MASWE check name:

1. compute legacy name-derived attempt-1 key/external ID and stable-ID key;
2. inspect exact legacy side-effect record if present;
3. authenticate under stable ID/current canonical route;
4. verify referenced GitHub check matches expected name/head/legacy external ID before mapping the same resource ID to stable local key;
5. if local legacy record is absent, reconcile exact head/name/legacy external ID through GitHub;
6. require uniqueness; multiple matches conflict;
7. if no legacy check is proven, do not manufacture an alias.

Old side-effect records remain historical recovery evidence. A second rename needs no side-effect-key migration.

## 16. Permanent versus retryable dispatch failures

The current worker retries thrown dispatch failures. #34 introduces typed disposition so permanent identity/policy rejection cannot become a poison delivery.

Permanent examples:

- missing/malformed stable ID in a new normalized event;
- ID not live-allowlisted;
- stable authorization not configured because the operator violated §9.1 cutover ordering;
- same name/conflicting ID;
- ordinary historical event missing stable ID;
- run/index stable identity conflict;
- authenticated live result positively proving different identity;
- fully and safely exhausted installation-repository listing with target ID absent.

Permanent disposition:

- zero authority-increasing run/index/check/workflow mutation;
- bounded safe diagnostic;
- durable delivery consumed rather than retried;
- no fallback to name-based authorization.

Each permanently consumed **repository-scoped** delivery emits a typed reason plus a process-local `permanentRepositoryDropsSinceStart` counter. The counter is a saturating positive safe integer capped at `Number.MAX_SAFE_INTEGER`, resets on process restart, and is observability only: it never changes dispatch, retry, authorization, or migration behavior. This makes any accidental maintenance-order violation visible without turning permanent failures into retryable poison deliveries.

The special §6.2 legacy removal path may only reduce unresolved legacy authority.

Background worker and synchronous deterministic dispatch seam use the same classification.

Retryable/operationally blocked examples:

- rate limit;
- transient GitHub/network errors;
- temporary token/API failure without proven authorization loss;
- pagination page-limit exhaustion;
- malformed/unsafe pagination response;
- lock contention;
- recoverable durable I/O.

When authenticated, completely traversed GitHub state positively proves repository access was revoked, apply existing authorization-revoked suspension under stable ID. Ambiguous API/pagination failure is not proof of revocation.

## 17. Manual publication after rename

`github-publish-checks` becomes:

1. load run and require stable association;
2. require stable ID live-allowlisted;
3. acquire stable repository/PR fences;
4. reconcile canonical name through bounded metadata lookup;
5. reload/re-prove run/index identity;
6. mint checks token scoped by repository ID;
7. read live PR and require `base.repo.id === repositoryId`;
8. preserve current stale-head invalidation/revalidation;
9. publish/reconcile using stable check keys.

Redirect behavior is never accepted as identity proof.

## 18. Security properties

#34 must prove that:

- reuse of an authorized old name by a different repository ID cannot inherit authority;
- old webhook replay cannot roll canonical metadata backward;
- rename cannot create a second local check identity;
- credential scope is numeric-ID based;
- future GitHub writes have a stable repository authority anchor;
- stale SHA evidence remains independent from repository identity migration;
- installation/removal signals remain fail-closed without allowing name-based grants;
- local Git remote remains candidate/provenance metadata only;
- immutable history cannot be edited to manufacture continuity;
- mixed pre-#34/#34 writers are excluded by hard quiescent cutover plus exact-validation downgrade failure;
- unresolved legacy authority reduction has an explicit lock branch and never relies on a name-keyed repository fence.

A signed webhook authenticates transport. It never overrides stable allowlist, association, installation, PR target repository ID, PR number, or SHA evidence.

## 19. Required regression matrix

Extend existing normalization, remote-match, association, suspension, authoritative-state, concurrency, adapter-integration, check, journal, config, and #28 reconciliation suites.

### 19.1 Normalization/inbox

- every new repository event persists positive ID + name;
- installation repository changes preserve ID/name pairs;
- malformed IDs fail;
- identical pairs dedupe; same ID/conflicting name fails;
- ordinary historical event missing ID permanently rejects with zero mutation;
- legacy removal may suspend only unresolved same-installation/name legacy associations;
- legacy removal cannot touch stable-ID associations;
- legacy add cannot grant/restore authority;
- delivery replay semantics remain unchanged.

### 19.2 Config/authorization and downgrade fixture

- current baseline name-only enabled config remains loadable;
- ID-only enabled config becomes valid;
- enabled config with both allowlists empty is invalid;
- stable allowlist accepts only unique positive safe integers;
- malformed/duplicate IDs fail;
- name-only config cannot authorize repository mutation/publication/token scope;
- allowed old name + unauthorized ID fails;
- authorized ID + changed name succeeds after live reconciliation;
- Phase A `readOnlyChecks` stays intact;
- pre-#34 binary downgrade against migrated config/association state fails closed.

The downgrade assertion is implemented without executing an old binary: freeze test-only copies/fixtures of the exact pre-#34 GitHub config key set/validation rule and pre-#34 association allowed-field/key parser from baseline `4565d1c`, then assert that representative migrated config and association golden fixtures are rejected by those frozen legacy validators. These frozen validators are compatibility-test evidence only and must not become production parsing paths.

### 19.3 Canonical lookup/pagination

- repository on page 1 succeeds;
- repository on page 2+ succeeds;
- `per_page=100` is used;
- valid terminal exhaustion without target is positive no-access;
- page-limit exhaustion is retryable/not revocation and emits the operator-facing traversal-limit diagnostic;
- malformed/unsafe next URL, duplicate next rel, loop, wrong origin/path/query are rejected without suspension;
- transient API/rate-limit failure is not revocation;
- duplicate ID/conflicting full names across pages fail closed.

### 19.4 Token scope

- all restricted token requests use `repository_ids`, never repository names;
- metadata token has only metadata read;
- PR-read token has pull-request + metadata read and no check write;
- checks token retains only current Phase A permissions;
- no name fallback occurs.

### 19.5 Remote/first association

- stable-associated run survives rename with stale `workspace.remote`;
- unassociated current-remote + branch binds only after allowlist/live PR base-ID proof;
- stale old remote does not auto-associate through redirect;
- same text remote cannot authorize another repository ID.

### 19.6 Association/index

- key is `<repositoryId>#<pr>`;
- same ID/new name resolves same run;
- old-name replay same ID cannot restore old name;
- same name/different ID conflicts;
- transitional parser exactness/mixed-key failures;
- duplicate stable PR/run identity rejected;
- branch lookup/repository suspension by ID.

### 19.7 PR ownership

- matching `base.repo.id` succeeds;
- different/missing base repo ID fails;
- fork PR with different `head.repo.id` remains valid when base matches.

### 19.8 Migration/crash recovery

Inject failure before checkpoint; after checkpoint; after run mutation before index; after index before checkpoint refresh; during stable check alias; after all associations stable before completion; and outcome-unknown for run/index/checkpoint/side-effect alias. Restart must finish idempotently or fail closed on a concrete conflict.

Also prove:

- completed rerun no-op;
- `--from Owner/Repo` normalizes to lowercase selector;
- normalized selector/different-ID conflict;
- stale/missing run/index failure;
- authorization loss;
- another same-ID rename during restart;
- candidate universe includes already-migrated same-ID records after partial progress;
- affected installation proof set remains complete after partial mutation.

### 19.9 SHA/PR lifecycle

- unchanged head preserves valid evidence;
- changed head enters #28 revalidation;
- closed PR receives closure suspension;
- PR base repository mismatch fails migration.

### 19.10 Check ownership/attempt scope

- production adapter constructs attempt-1 publication only;
- pre-rename production check maps to same resource under stable key;
- no duplicate on first post-rename publication;
- wrong head/name/external ownership rejected;
- multiple legacy external-ID matches conflict;
- current + pending-cancellation heads reconciled;
- second rename needs no side-effect migration;
- explicit non-1 test/internal keys are not treated as production migration authority.

### 19.11 Concurrency/cutover/legacy reduction

- webhook reconciliation vs migration;
- manual publication vs migration;
- installation deletion/removal vs migration;
- canonical reconciliation vs publication;
- same-ID migrations serialize;
- conflicting migrations fail deterministically;
- no recursive same-key lock/deadlock;
- live pre-#34 name-keyed publication/association lock blocks cutover/migration;
- read-only legacy-journal preflight classifies live/dead/malformed/ambiguous ownership without acquiring the old operational lock;
- new binary does not acquire name-keyed operational publication/association-identity fences;
- unresolved legacy state cannot enter stable publication while migration owns the repository ID fence;
- §6.2 legacy removal acquires `run target fence -> global association transaction`, re-proves the unresolved tuple under those locks, and acquires neither a name-keyed nor ID-keyed repository fence;
- concurrent stable/run mutation cannot race a §6.2 update into a split run/index suspension state.

### 19.12 Worker disposition and maintenance observability

- permanent identity error consumes delivery with zero authority-increasing mutation/no retry loop;
- transient GitHub/pagination failure retries;
- synchronous path uses same classification;
- diagnostic callback cannot alter durable disposition;
- completion failure after permanent reject follows existing completion recovery;
- poison legacy event cannot starve unrelated queue items;
- `permanentRepositoryDropsSinceStart` increments once per permanently consumed repository delivery, saturates safely, is reason-coded, and does not affect behavior;
- documented cutover test starts the #34 listener only after stable IDs are configured/migration is complete.

## 20. Contract/document synchronization

Implementation must synchronize at minimum:

- `src/domain.ts` and `src/config.ts`;
- `src/cli-args.ts` plus CLI dispatch/help;
- `schemas/config.schema.json` and `schemas/run-record.schema.json`;
- GitHub types/normalization/durable inbox compatibility;
- token creation and token-purpose permissions;
- authenticated repository-list pagination helper using the current hardcoded GitHub API origin;
- adapter identity helpers;
- association/index;
- adapter routing/publication;
- checks/side-effect ownership;
- `src/github/journal.ts`, including `GitHubJournalKind`, `JOURNAL_KINDS`, operation mappings, initialization, recovery, and a new read-only legacy ownership inspection/preflight API;
- worker diagnostics/disposition, including the bounded permanent-drop counter;
- migration/checkpoint modules;
- frozen pre-#34 validator fixtures used only for downgrade regression evidence;
- affected focused/integration tests including remote-match and journal cutover;
- `docs/GITHUB_APP.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, and `CHANGELOG.md`.

Historical Superpowers specs/plans remain historical evidence. Issue #3 must be updated so #34 completion is an explicit Phase B entry gate before write authority is enabled.

## 21. Non-goals

#34 does not implement Phase B approvals/pushes/PR writes/replies/Actions artifacts, automatic merge, workflow redesign, MH-01/MH-02, PostgreSQL, general owner/account migration, local Git remote rewriting, GitHub API-origin configurability, or #33 identity wording cleanup.

Repository URLs, redirects, remotes, branch names, PR SHAs, and check resources are never substitutes for repository ID. Immutable workflow events/GitHub journals and historical run config snapshots are not rewritten to manufacture identity history.

#34 also does not promise backward compatibility with a pre-#34 binary after stable-ID state has been written.

## 22. Implementation sequencing constraints

A future plan should preserve this order:

1. failing config compatibility/normalization/token/PR-ownership/pagination tests;
2. stable domain/config/schema primitives preserving legacy reads while adding the explicit at-least-one-allowlist enabled rule;
3. ID-scoped least-privilege token purposes plus bounded installation-repository pagination;
4. stable association/index APIs and transitional parser;
5. stable journal kinds/fences, read-only legacy-lock inspection, hard mixed-binary cutover preflight, and permanent/retryable dispatch classification;
6. canonical reconciliation plus PR base-ID proof;
7. authority-reducing legacy repository-removal handling under the explicit `run fence -> global association transaction` legacy branch;
8. stable check idempotency plus legacy production-attempt-1 ownership aliasing;
9. explicit restartable migration command/checkpoint with union candidate-universe scanning;
10. #28 stale-head plus installation-suspension integration;
11. maintenance/downgrade diagnostics, documentation, and #3 Phase B gate synchronization;
12. exact supported-baseline validation and independent review.

Work test-first. Never temporarily authorize by name to make migration tests pass.

## 23. Completion gate

Issue #34 is complete only when:

- [ ] stable numeric repository ID is authoritative in normalized events, associations, index, authorization, token scope, locks, and side-effect ownership;
- [ ] canonical name can change without breaking an existing stable association;
- [ ] `allowedRepositoryIds` is the operational authorization source;
- [ ] current name-only config and target ID-only config both load under the explicit enabled validation rule, while name-only config cannot authorize repository-scoped operations or Phase B writes;
- [ ] documented cutover configures stable IDs and completes required migration before the #34 listener starts;
- [ ] legacy associations migrate explicitly without manual state editing;
- [ ] authenticated canonical lookup handles pagination safely and distinguishes complete absence from ambiguous/incomplete traversal;
- [ ] traversal-limit exhaustion is operator-visible and never interpreted as revocation;
- [ ] stale unassociated remotes never become redirect-based identity proof;
- [ ] live PR target ownership is base-repository-ID bound and fork PRs remain valid;
- [ ] migration is idempotent/crash-recoverable under injected durable uncertainty;
- [ ] restart candidate-universe/installation proofs remain complete after partial migration;
- [ ] old-name replay, new-name delivery, conflicting ID, missing-ID legacy delivery, legacy repository removal, stale association, installation removal, and check ownership are covered;
- [ ] §6.2 legacy authority reduction is serialized only by `run target fence -> global association transaction` and never acquires a name-keyed repository fence;
- [ ] unknown/conflicting identity causes zero authority-increasing workflow/GitHub mutation;
- [ ] permanent identity failures do not poison the durable retry queue and emit bounded reason-coded drop observability;
- [ ] ambiguous pagination/API failure never becomes authorization-revoked evidence;
- [ ] mixed pre-#34/#34 GitHub writers are excluded by hard quiescent cutover plus read-only live legacy-lock preflight;
- [ ] downgrade below #34 is documented unsupported and frozen pre-#34 validators reject migrated golden fixtures;
- [ ] unchanged head preserves valid SHA evidence and changed head enters #28 revalidation;
- [ ] existing production attempt-1 checks reconcile without duplicate post-rename creation and no production non-1 legacy attempt path exists;
- [ ] active contracts/docs/changelog are synchronized, including explicit `repository-identity` journal registration and legacy-lock inspection API;
- [ ] #3 lists #34 as explicit Phase B entry gate;
- [ ] `npm run check` passes on exact Node `24.18.0` and `22.22.2`;
- [ ] `npm run pack:dry` passes on both supported baselines as required by repository policy;
- [ ] `git diff --check` passes;
- [ ] exact-head CI passes including unsupported-Node negative gate;
- [ ] independent exact-head validation passes;
- [ ] substantive review threads are resolved or owner-dispositioned;
- [ ] post-merge `main` CI is revalidated before #3 Phase B begins.

## 24. External GitHub references

Official GitHub documentation used to validate external assumptions:

- **Generating/Create an installation access token for a GitHub App** — tokens may be restricted by `repository_ids` and permissions may be reduced.
- **List repositories accessible to the app installation** — `GET /installation/repositories` supports GitHub App installation tokens and is paginated (`per_page` max 100, default 30).
- **Get a pull request** — installation tokens can read PRs with suitable read permission and PR objects expose base/head repository information.
- **Webhook events and payloads** — repository-scoped payloads contain repository objects; #34 requires their stable numeric IDs during normalization.

GitHub behavior is external input evidence only. MASWE's authorization and migration rules above are intentionally stricter and fail closed if external behavior is ambiguous.