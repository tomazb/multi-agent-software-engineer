# Issue #34 Stable GitHub Repository Identity and Rename Reconciliation Design

## Status

- **Issue:** #34 — Handle GitHub repository renames with stable repository identity
- **Related:** #3 — v0.3 GitHub App pilot, Phase B
- **Ordering predecessor:** #27 — correctness hardening, completed
- **Date:** 2026-08-27
- **Exact baseline:** `main@4565d1c0661ff6cf20185f718b59c40d9c837c77`
- **Branch:** `issue-34-stable-repository-identity-design`
- **Design status:** owner-approved architecture; committed specification awaiting owner review
- **Implementation authority:** none yet. This commit authorizes only this design specification. Runtime, schema, CLI, migration, test, documentation, and GitHub issue implementation changes require a separately approved implementation plan.

This document is a design specification. Its implementation behavior is not yet verified. GitHub API facts cited here were checked against current official GitHub documentation on 2026-08-27.

## 1. Baseline review

Issue #34 remains applicable on the exact post-#27, post-MH-00 baseline.

The Phase A GitHub integration currently treats mutable `owner/repository` text as the primary repository identity in several authoritative places:

1. `GitHubAppConfig.allowedRepositories` authorizes repositories by `owner/repo` string.
2. `RunGitHubAssociation` persists `repository` but no stable numeric GitHub repository ID.
3. `GitHubInternalEvent` persists `repository` and, for installation repository changes, `repositories` as names without ID/name pairing.
4. `normalizeGitHubWebhook()` requires `repository.full_name` but discards `repository.id`.
5. `GitHubAssociationIndex` keys records as `<owner/repo>#<pull-request-number>`.
6. Repository suspension and branch lookup select records by repository name.
7. Publication and association fences are derived from repository name and pull request number.
8. Check-run idempotency keys contain `owner/repo`, so a rename changes the local idempotency identity for the same GitHub repository/check resource.
9. `createInstallationAccessToken()` scopes installation credentials through GitHub's mutable `repositories: [name]` parameter.

A GitHub repository rename therefore creates an identity discontinuity even though the underlying GitHub repository is unchanged. Redirect behavior cannot safely repair that discontinuity because a redirect is routing behavior, not MASWE's authorization proof.

The existing system already provides primitives that should be composed rather than replaced:

- authenticated webhook signature verification before normalization;
- durable delivery inbox and replay protection;
- installation-scoped GitHub credentials;
- append-only GitHub ownership journals and file locks;
- optimistic run persistence with exact validation;
- association transactions with rollback handling for known write failure;
- explicit handling of durable atomic-write outcome-unknown conditions;
- exact SHA-bound evidence and stale-head revalidation from #28;
- publication and target mutation fences;
- bounded GitHub side-effect records;
- centralized CLI grammar.

## 2. Objective

Make GitHub's stable numeric repository ID the authoritative repository identity for authorization, association, locking, reconciliation, and GitHub side-effect ownership while retaining the current canonical `owner/repo` as mutable API-routing and display metadata.

The design must satisfy these invariants:

1. **Stable numeric ID is authoritative.** A mutable name can never establish repository equivalence or authorization.
2. **Canonical name is mutable metadata.** Renaming a repository or owner must not break the run/PR association.
3. **Authorization is ID-based.** Future Phase B writes may only target explicitly allowlisted repository IDs.
4. **Redirects are never identity evidence.** MASWE does not derive old-name/new-name equivalence from HTTP 301/302 behavior.
5. **Exact PR/head/check ownership remains intact.** Rename handling cannot weaken PR number, head SHA, installation, or check-resource ownership checks.
6. **Legacy state remains readable but not authoritative.** Historical schema-v1 records may omit repository IDs, but normal repository-scoped GitHub operations refuse unresolved legacy identity.
7. **Migration is explicit, authenticated, idempotent, and restartable.** MASWE never hand-edits run records, the association index, side-effect state, or immutable GitHub journals.
8. **Unknown/conflicting identity fails closed.** Matching text is never used to repair a numeric identity conflict.
9. **Rename correctness does not depend on one webhook.** Repository-bearing events and manual publication trigger authenticated live reconciliation by stable ID when needed.
10. **Issue #34 introduces no Phase B write authority.** Current Phase A `readOnlyChecks` restrictions remain in force until #3 authorizes later work.

## 3. Approaches considered

### 3.1 Dual identity with in-place, restartable migration — selected

Add stable `repositoryId` identity to normalized events, run associations, association records, authorization, token scoping, locks, and side-effect ownership while keeping `repository` as the current canonical name. Temporarily accept both legacy name-keyed persisted state and stable-ID-keyed persisted state at deserialization boundaries.

Advantages:

- directly closes the rename correctness/security gap;
- minimizes unrelated schema/version churn;
- preserves existing run history and schema-v1 compatibility;
- composes with Phase A recovery machinery rather than replacing it;
- gives #3 Phase B a stable repository authorization primitive.

Cost: transitional readers must distinguish legacy unresolved records from stable operational records.

### 3.2 Parallel GitHub state v2 — rejected

Create a separate v2 association/config/run model and migrate all GitHub state wholesale.

This gives a clean cutover but introduces disproportionate schema and persistence churn immediately before later MH-01/MH-02 domain evolution. Issue #34 does not require a repository-wide schema-v2 programme.

### 3.3 Name-primary index plus secondary ID lookup — rejected

Keep `owner/repo` as the primary key and add an ID-to-name lookup table.

This retains two competing authoritative identities and makes crash recovery, locking, authorization, and rename conflict handling harder. Stable repository ID must be primary rather than advisory.

## 4. Canonical identity contract

For every repository-scoped GitHub operation, MASWE treats the identity tuple as:

```text
repositoryId      = immutable GitHub repository identity and authorization key
repository        = current canonical owner/name for API routing and display
installationId    = GitHub App installation authority boundary
pullRequestNumber = PR identity within repositoryId
headSha           = exact evidence/publication revision
```

### 4.1 Stable repository ID

`repositoryId` is a positive JavaScript safe integer.

It is used for:

- allowlist decisions;
- association primary keys;
- publication/association/repository identity fence keys;
- repository suspension selection;
- repository-scoped installation-token restriction;
- check-run idempotency ownership;
- rename reconciliation;
- Phase B repository authority after #34 is complete.

### 4.2 Canonical repository name

`repository` remains a normalized lowercase `owner/repo` string.

It is used only where GitHub's REST paths or operator-facing output require a name. A name change is not a new repository association when `repositoryId` remains equal.

The stored canonical name may be changed only after authenticated live reconciliation for the already-authorized `repositoryId`. A signed webhook name mismatch is a reconciliation signal, not by itself permission to mutate canonical routing metadata.

### 4.3 Installation identity

A repository association retains its `installationId`. Incoming repository-scoped events must match both the stable repository ID and the expected installation authority for the operation.

A different installation is not silently substituted. Reinstallation/installation migration is outside #34 unless the current association can be independently reconciled under existing installation lifecycle semantics.

## 5. Configuration and authorization

### 5.1 New authoritative allowlist

Extend `GitHubAppConfig` with:

```ts
allowedRepositoryIds?: number[];
```

Validation rules:

- every entry is a positive safe integer;
- entries are unique;
- order is not semantically meaningful;
- normal repository-scoped GitHub processing requires a non-empty stable-ID allowlist;
- Phase B may not start unless the target ID is present in the live project configuration.

`allowedRepositories` remains accepted for compatibility with historical/project configuration but becomes non-authoritative.

### 5.2 Meaning of legacy `allowedRepositories`

After #34, a name-only allowlist may be used only for:

- loading historical schema-v1 configuration snapshots;
- identifying which legacy local records the explicit migration command should inspect;
- operator diagnostics/display during migration.

It cannot authorize:

- webhook-driven workflow changes;
- check publication;
- repository identity reconciliation;
- installation credential scope;
- future Phase B push/PR/comment/review writes;
- old-name/new-name equivalence.

A project configuration that enables the GitHub App but has only `allowedRepositories` remains parseable so the operator can inspect and migrate state. Repository-scoped adapter initialization/publication fails with an explicit stable-authorization-required error until `allowedRepositoryIds` is configured.

This distinction preserves compatibility without converting mutable text back into security authority.

### 5.3 Persisted run configuration snapshots

Do not rewrite historical `run.config.githubApp.allowedRepositories` snapshots merely to add stable IDs. Configuration snapshots remain historical evidence of what the run was created with.

Live repository authorization uses the current project GitHub App configuration, not inferred changes to historical snapshots.

### 5.4 Schema version

Keep `config.version: 1` and `RunRecord.schemaVersion: 1` for #34.

`allowedRepositoryIds` and run-association `repositoryId` are additive schema-v1 fields. Historical records may omit them. Stable GitHub operations use a type guard/accessor that rejects unresolved legacy associations rather than treating an optional persisted field as optional authority.

## 6. GitHub installation-token identity

The current token helper scopes installation access tokens by repository **name** through GitHub's `repositories` request field. #34 must remove this mutable-name dependency.

GitHub documents that installation access-token creation accepts `repository_ids` as a restriction, and that the token cannot receive access to a repository the installation was not granted. GitHub also permits reducing the token permission set.

### 6.1 Token purposes

Refactor token minting around an explicit purpose:

```ts
type GitHubInstallationTokenPurpose =
  | "metadata-reconcile"
  | "checks";
```

Both purposes receive `installationId` and `repositoryId`, never a repository name as credential scope.

`metadata-reconcile`:

- uses `repository_ids: [repositoryId]`;
- requests only `metadata: read`;
- is used to prove installation access and discover the current canonical name.

`checks`:

- uses `repository_ids: [repositoryId]`;
- preserves Phase A permissions required by the current checks pilot (`checks: write`, `pull_requests: read`, `metadata: read`);
- remains blocked from other write-side behavior by `readOnlyChecks` policy.

No fallback from ID scoping to name scoping is allowed.

### 6.2 Authenticated repository lookup

With a metadata-reconcile installation token restricted to the candidate repository ID, MASWE calls GitHub's `GET /installation/repositories` endpoint and requires a repository object with exactly the requested numeric ID and a valid current `full_name`.

The endpoint is documented to work with GitHub App installation access tokens. Its result is the live identity proof used by migration/reconciliation.

MASWE does not call the old repository URL to discover whether GitHub redirects it.

## 7. Normalized webhook identity

### 7.1 Single-repository events

Every supported repository-scoped webhook event normalized by the new binary must require and persist both:

```ts
repositoryId: number;
repository: string;
```

This applies to the current supported repository-scoped event families:

- pull request events;
- push;
- workflow run completed;
- check run completed;
- check suite completed.

The incoming payload's `repository.id` must be a positive safe integer. Missing, zero, negative, fractional, unsafe, or otherwise malformed IDs are malformed webhooks and are never normalized into operational events.

GitHub's webhook documentation defines a `repository` object for repository-scoped events; #34 uses the numeric repository identifier in that object rather than discarding it.

### 7.2 Installation repository changes

Do not retain independent parallel arrays of repository names and IDs.

Normalize `installation_repositories` entries as identity pairs:

```ts
interface GitHubRepositoryIdentity {
  repositoryId: number;
  repository: string;
}
```

The internal event contains a bounded/deduplicated array of these pairs. Duplicate numeric IDs with conflicting names are malformed. Duplicate identical pairs collapse deterministically.

### 7.3 Non-repository installation events

`installation.created` and `installation.deleted` remain installation-scoped events and need no invented repository identity.

### 7.4 Durable inbox backward compatibility

New inbox records persist stable repository IDs. Transitional inbox deserialization may read historical normalized repository events that lack `repositoryId`, because older binaries discarded the field before durable enqueue.

Such a legacy event is **not upgraded from its name**. It is classified as a permanent `legacy-repository-identity-missing` dispatch rejection with zero run/index/GitHub mutation.

Migration performs live reconciliation of affected runs, so skipping an unrecoverable normalized legacy event cannot be used as a shortcut for identity mutation. New GitHub deliveries/redeliveries normalized by the new binary include the repository ID.

## 8. Association and index model

### 8.1 Stable association shape

Add `repositoryId` to `RunGitHubAssociation` and `AssociationRecord`.

Persisted schema-v1 records may temporarily omit the field, but all newly created associations require it.

GitHub-specific operational code must call a helper equivalent to:

```ts
requireStableGitHubAssociation(run.github)
```

which returns an association with a required positive `repositoryId` or throws a typed migration-required error.

### 8.2 Stable index key

The new primary key is:

```text
<repositoryId>#<pullRequestNumber>
```

not `<owner/repo>#<pullRequestNumber>`.

`repository` remains inside the record as current canonical routing metadata.

### 8.3 Transitional parser

During the migration period, `associations.json` may contain:

- legacy entries keyed by `<owner/repo>#<pr>` with no `repositoryId`;
- stable entries keyed by `<repositoryId>#<pr>` with `repositoryId`.

The parser validates each form exactly and rejects:

- malformed keys;
- a stable record whose key does not match its `repositoryId`/PR;
- a legacy record that unexpectedly contains a stable key;
- duplicate active run IDs;
- two active stable entries for the same `repositoryId`/PR;
- stable/legacy combinations that claim the same run inconsistently;
- unsupported fields or malformed timestamps.

Normal association lookup APIs become stable-ID based. A migration-specific API may enumerate legacy records by exact old name.

### 8.4 Repository suspension and branch lookup

Repository branch lookup and repository authorization suspension use `repositoryId` as the selector. `repository` may be included only for output and routing.

Installation-wide suspension remains keyed by `installationId`.

## 9. Stable fences and concurrency identity

Any lock/fence whose purpose is to serialize operations against one GitHub repository or PR must use stable identity.

### 9.1 Repository identity journal

Add a repository-identity journal/fence keyed by `repositoryId`. It serializes:

- legacy migration;
- canonical-name reconciliation;
- repository-level authorization suspension/recovery;
- repository-scoped publication entry before narrower PR/check locks.

### 9.2 PR publication/association fences

Fences for one PR use:

```text
<repositoryId>#<pullRequestNumber>
```

A repository rename cannot change the lock identity for the same PR.

### 9.3 Lock ordering

The required acquisition order is:

```text
repository-identity(repositoryId)
  -> PR/publication identity(repositoryId, pr)
    -> run target mutation fence(runId), when required
      -> association transaction / check-create lock
```

Do not acquire repository identity recursively from inside a lower-level operation. Helpers receiving an already-held identity context must not reacquire the same journal.

This order must be covered by concurrency tests so migration, webhook reconciliation, manual publication, and installation suspension cannot deadlock or publish split identity.

## 10. Live canonical-name reconciliation

Rename correctness does not depend on a dedicated repository rename webhook.

### 10.1 Trigger conditions

Authenticated reconciliation runs when:

- a repository-bearing event's stable ID matches an association but its supplied name differs from the stored canonical name;
- manual check publication begins;
- migration verifies a legacy association;
- another repository-scoped operation requires an API path and stored canonical metadata may be stale.

A repository/account rename-specific webhook may be supported later as an eager trigger, but it is not required for correctness.

### 10.2 Reconciliation algorithm

Under the repository identity fence:

1. require the candidate `repositoryId` in live `allowedRepositoryIds`;
2. require the expected `installationId`;
3. mint a metadata-reconcile token scoped by `repositoryId`;
4. query repositories accessible to that installation token;
5. require exactly the requested numeric ID and a valid canonical `full_name`;
6. compare the live canonical name with stored metadata;
7. if unchanged, continue;
8. if changed, atomically/recoverably synchronize the run association and index record without changing repository ID, PR number, branch, or SHA evidence;
9. reload/re-prove the resulting stable identity before using the new name for a REST path.

### 10.3 Stale event replay

An old-name replay carrying the correct stable ID may locate the same association, but it cannot roll the canonical name backward.

If the event name differs from stored metadata, live reconciliation by ID decides the current name. Therefore:

- correct ID + stale old name -> current live name wins;
- correct ID + current new name -> current live name is confirmed;
- same text + different ID -> permanent identity conflict;
- missing ID -> permanent rejection/migration-required path.

## 11. Explicit legacy migration command

Because MASWE's CLI grammar uses flat commands, the concrete operator command is:

```text
maswe github-migrate-repository \
  --from <legacy-owner/repo> \
  --repository-id <positive-safe-integer>
```

`--json` may be supported for deterministic operator output. Global `--cwd` and `--config` retain their existing semantics.

The old name is only a **local selector** for unresolved persisted records. It is not identity proof.

### 11.1 Preconditions

Migration requires:

- #27-completed baseline or descendant;
- GitHub App enabled;
- `repositoryId` present in live `allowedRepositoryIds`;
- exact valid `--from` owner/repo selector;
- GitHub App credentials available;
- no Phase B writer implementation enabled;
- repository identity fence acquired;
- affected installation IDs derived from existing association records, not guessed from the name.

The webhook listener need not have an empty durable inbox, but active dispatch for the target stable ID must be excluded by the identity fence. Operations documentation should recommend stopping the listener for an operationally quiescent migration and starting it after verification.

### 11.2 Authenticated proof

For every distinct installation ID referenced by affected legacy associations:

1. mint a metadata-only installation token scoped by the operator-supplied repository ID;
2. query installation-accessible repositories;
3. require the same numeric repository ID;
4. obtain the current canonical `full_name`;
5. require consistent canonical identity across all successful proofs.

If an installation can no longer prove access, migration does not invent continuity from the old name. The affected association remains unresolved and the command fails with a typed reason. Existing installation-removal/suspension operations may subsequently disposition authorization, but cannot synthesize a repository ID.

### 11.3 Per-association proof

For each legacy association selected by `--from`:

- load its run by `runId`;
- require the run's current GitHub association to match the legacy index entry exactly on installation ID, old repository name, PR number, base SHA, head SHA, and branch, except for already-completed stable migration of the same ID;
- use the authenticated canonical name and stable-ID-scoped credential to load the live pull request;
- require that the live PR belongs to the requested repository ID;
- compare live PR state/head/base/branch with stored state;
- classify any head movement through the existing #28 revalidation semantics rather than treating migration as evidence reuse.

A stale or conflicting run/index pair stops migration. MASWE never chooses one persisted copy as "probably correct."

## 12. Migration checkpoint and restart semantics

### 12.1 Checkpoint purpose

Persist a bounded migration intent/status record under the GitHub state namespace, e.g.:

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

The exact on-disk location is an implementation-plan detail, but it must be under the existing GitHub authoritative state root and protected by the repository identity journal.

The checkpoint is observability/restart intent, not repository authorization. Every invocation revalidates live configuration and GitHub installation access.

### 12.2 No per-run completed list required

Restart scans authoritative run/index state and classifies each candidate as:

- still-legacy and eligible;
- already migrated to the exact same stable ID and current canonical name;
- migrated to the same ID but needing a newer canonical-name refresh;
- conflicting and therefore fail-closed.

This avoids a second source of truth for per-run migration progress.

### 12.3 Durable write uncertainty

If any durable atomic write reports outcome unknown:

- do not roll forward based on an exception message;
- re-read the run, association index, checkpoint, and any new side-effect alias state;
- compare them with the exact intended stable identity;
- continue only when authoritative files prove an idempotently reconcilable state;
- otherwise stop with a typed recovery error.

Migration is successful only when a final full rescan finds no selected unresolved legacy association and the stable run/index state agrees.

### 12.4 Re-run after completion

Re-running the same migration command against a completed state is a no-op after live ID authorization/reconciliation is re-proved.

The same legacy selector with a different numeric ID conflicts and performs zero mutation.

## 13. Run/index synchronization

Migration and live rename reconciliation reuse the existing association transaction model rather than hand-editing files.

For a given run:

1. acquire stable repository/PR and run mutation fences in the documented order;
2. load and validate both run and index snapshots;
3. prepare the exact stable association candidate;
4. publish one side of the pair using existing optimistic/durable semantics;
5. publish the matching association index candidate;
6. use the transaction rollback mechanism for known failures where rollback is safe;
7. for durable outcome-unknown errors, do not blindly roll back; re-read and reconcile exact intended state;
8. reload and require run/index equality on the stable identity tuple before releasing the fence.

The migration checkpoint makes a process crash between file publications restartable without inventing a cross-file transaction primitive.

Immutable workflow event history and immutable GitHub journals are never rewritten.

## 14. SHA evidence and PR state during migration

Repository identity migration must not imply that old engineering evidence is current.

### 14.1 Unchanged live head

If the live PR head SHA equals the stored associated head SHA, migration may preserve existing quality/verification/merge-ready evidence exactly as-is. The evidence remains bound to the same immutable SHA; only repository routing metadata changed.

### 14.2 Changed live head

If the live PR head differs:

- stable identity migration may still complete;
- old SHA success becomes unusable;
- pending check cancellation state is updated through the existing hardened logic;
- the run enters the existing GitHub-origin revalidation path from #28 before merge-ready/completion evidence can be reused.

Migration must never overwrite `headSha` silently without the revalidation transition/evidence invalidation contract.

### 14.3 Closed PR

If live reconciliation shows the PR closed, apply existing pull-request-closed suspension semantics under the stable identity. Do not preserve an active association merely because the legacy record was active.

## 15. Check-run idempotency and ownership

### 15.1 Stable new idempotency key

Replace mutable name-based check identity:

```text
check-run:<owner/repo>/<pr>/<head>/<check>/<attempt>
```

with:

```text
check-run:<repositoryId>/<pr>/<head>/<check>/<attempt>
```

The derived `external_id` therefore remains stable across future repository-name changes.

### 15.2 Migration of existing relevant check ownership

A pre-#34 check may have an old name-derived side-effect key/external ID. Creating a new stable key without reconciliation could duplicate the GitHub check.

During migration, for every affected association, process the exact set of heads that can still be operationally relevant:

```text
{ association.headSha } U association.pendingCancellationHeadShas
```

For each MASWE check name and supported attempt identity:

1. calculate the legacy name-derived key from `--from`;
2. calculate the new stable-ID-derived key;
3. inspect any existing legacy side-effect record;
4. authenticate under the stable repository ID/current canonical name;
5. verify the referenced GitHub check resource belongs to the expected repository/head/check identity before aliasing the same resource ID to the new stable key;
6. if the local legacy record is absent, reconcile GitHub checks using the known legacy external ID and require an unambiguous ownership match before publishing the new stable mapping;
7. never claim a check by name/head alone when external ownership is ambiguous.

Old side-effect records remain historical recovery evidence; migration does not delete or rewrite them.

### 15.3 Current and future publication

After migration, publication uses only the stable key and repository-ID-scoped credential. Another rename changes only the REST routing name, not the check ownership key.

## 16. Permanent versus retryable failures

The current webhook worker retries all thrown dispatch failures. #34 must distinguish identity/policy rejection from transient infrastructure/API failure so a forged or permanently conflicting delivery cannot become an endless poison message.

### 16.1 Permanent failures

Examples:

- repository-scoped event lacks stable repository ID;
- repository ID is malformed;
- repository ID is not in live `allowedRepositoryIds`;
- event name matches but numeric ID conflicts;
- legacy normalized event lacks recoverable stable identity;
- run/index stable identities conflict;
- authenticated live result proves a different repository identity.

Permanent failures:

- mutate no run/index/check/workflow state;
- are recorded through bounded safe diagnostics;
- complete/consume the durable delivery rather than scheduling infinite retry;
- never downgrade into name-based lookup.

Introduce an explicit typed permanent-dispatch error/result rather than parsing diagnostic text.

### 16.2 Retryable failures

Examples:

- rate limit;
- transient GitHub 5xx/network failure;
- temporary token creation/API failure that does not prove authorization loss;
- local journal/lock contention;
- recoverable durable I/O failure.

Retryable failures retain the current bounded durable inbox retry/backoff behavior.

### 16.3 Authorization revocation

When authenticated GitHub state positively proves the installation no longer has repository access, use the existing authorization-revoked suspension semantics under stable repository identity.

An ambiguous API failure is not positive proof of revocation and remains retryable/fail-closed.

## 17. Manual publication safety after rename

`github-publish-checks` must no longer trust the stored repository name enough to mint credentials or enter the publication fence.

Required sequence:

1. load run and require stable GitHub association;
2. require `repositoryId` allowlisted in live config;
3. acquire repository/PR stable identity fences;
4. reconcile canonical name by repository ID and installation ID;
5. reload/re-prove run/index identity;
6. mint checks token scoped by `repositoryId`;
7. load live PR through the reconciled canonical name;
8. preserve existing stale-head invalidation/revalidation behavior;
9. publish/reconcile checks through stable idempotency keys.

No redirect following is accepted as repository identity proof even if the HTTP client follows redirects for unrelated endpoints.

## 18. Security properties

#34 adds or strengthens these security boundaries:

- an attacker cannot reuse a previously authorized repository name with a different repository ID to inherit authorization;
- an old webhook replay cannot roll routing metadata backward;
- a repository rename cannot create a second local check identity for the same check resource;
- token repository scoping moves from mutable name to numeric ID;
- future GitHub writes gain a stable repository authorization anchor;
- stale SHA evidence remains separate from repository identity migration;
- installation removal remains fail-closed;
- immutable journals/history cannot be edited to manufacture continuity.

A signed webhook is authenticated transport evidence. It does not override explicit `allowedRepositoryIds`, stored stable association identity, installation identity, PR number, or SHA evidence requirements.

## 19. Required regression matrix

Implementation must extend existing GitHub normalization, association, suspension, authoritative-state, concurrency, adapter-integration, and #28 reconciliation tests rather than establish a parallel test framework.

### 19.1 Normalization and durable inbox

- every supported repository-scoped new event persists positive `repositoryId` plus canonical name;
- `installation_repositories` preserves ID/name pairs;
- missing/zero/negative/fractional/unsafe repository IDs fail normalization;
- duplicate repository ID/name pairs deduplicate deterministically;
- duplicate ID with conflicting names is malformed;
- historical durable events missing ID remain readable but permanently reject at dispatch with zero mutation;
- replay/delivery-ID deduplication remains unchanged.

### 19.2 Configuration and authorization

- stable ID allowlist accepts unique positive safe integers;
- duplicate/malformed IDs fail config validation;
- legacy name-only config remains loadable;
- name-only config cannot authorize webhook mutation or check publication;
- allowed old name + unauthorized ID fails;
- authorized ID + changed/unlisted canonical name succeeds after live reconciliation;
- Phase A `readOnlyChecks` behavior remains intact.

### 19.3 Token scope

- checks token body uses `repository_ids`, never `repositories` name scope;
- metadata token is ID-scoped and least-privilege;
- unauthorized repository ID cannot yield a usable scoped token;
- no name fallback occurs when token creation fails.

### 19.4 Association/index

- new association key is `<repositoryId>#<pr>`;
- same ID/new name resolves the existing run;
- old-name replay with same ID resolves the same run but cannot restore old name;
- same name/different ID conflicts;
- stable and legacy parser forms are individually exact;
- malformed mixed keys fail closed;
- duplicate active run/stable PR identity remains rejected;
- branch lookup and repository suspension select by stable ID.

### 19.5 Migration and crash recovery

Inject interruption/failure at least:

- before checkpoint creation;
- after checkpoint creation before first run mutation;
- after run migration before index publication;
- after index publication before checkpoint refresh;
- during relevant check-key alias publication;
- after all associations are stable before checkpoint completion;
- run atomic-write outcome unknown;
- association-index atomic-write outcome unknown;
- checkpoint atomic-write outcome unknown;
- stable side-effect alias atomic-write outcome unknown.

For each case, restart/re-run must either finish idempotently or fail closed on a concrete conflict.

Also prove:

- rerun after complete migration is a no-op;
- same legacy selector + different repository ID conflicts;
- stale/missing run for an index record fails;
- stale/missing index for a run association fails rather than being guessed;
- authorization loss during migration does not publish partial success;
- canonical name changing again during restart is reconciled by the same stable ID.

### 19.6 SHA and PR behavior

- unchanged head preserves SHA-bound evidence;
- changed head invalidates stale evidence and enters #28 revalidation;
- closed PR gets existing closure suspension semantics;
- PR repository identity mismatch fails migration;
- base/head/branch mismatches are handled according to existing live PR reconciliation rules, never hidden by rename migration.

### 19.7 Check ownership

- pre-rename check maps to the same resource under stable key after migration;
- no duplicate check is created on first post-rename publication;
- check resource with wrong repository/head/name/external ownership is rejected;
- current head and every pending cancellation head migrate relevant ownership;
- future second rename requires no side-effect-key migration.

### 19.8 Concurrency

- webhook canonical-name reconciliation races migration;
- manual check publication races migration;
- installation deletion races migration;
- installation repository removal races migration;
- canonical-name reconciliation races check publication;
- two migrations for same stable ID serialize;
- migrations for conflicting IDs/legacy selector fail deterministically;
- lock ordering has no recursive same-key acquisition/deadlock.

### 19.9 Permanent/retryable worker disposition

- permanent identity error completes delivery with zero mutation and no retry loop;
- transient GitHub error retries;
- diagnostic callbacks cannot alter durable disposition;
- completion failure after permanent reject still follows existing completion-recovery semantics;
- legacy poison delivery cannot starve unrelated queue entries.

## 20. Documentation and contract synchronization

The implementation tranche must synchronize all affected active surfaces, including at minimum:

- `src/domain.ts`;
- `src/config.ts`;
- `src/cli-args.ts` and CLI dispatch/help;
- `schemas/config.schema.json`;
- `schemas/run-record.schema.json`;
- `src/github/types.ts`;
- `src/github/normalize.ts`;
- `src/github/delivery-inbox-record.ts` as required for compatibility;
- `src/github/token.ts`;
- `src/github/adapter-identities.ts`;
- `src/github/association.ts`;
- `src/github/adapter.ts`;
- `src/github/checks.ts`;
- `src/github/side-effect-store.ts` or a narrowly scoped alias/list API if required;
- `src/github/journal.ts`;
- `src/github/webhook-worker.ts` and diagnostics for permanent dispatch rejection;
- migration service/checkpoint module(s);
- focused and integration/regression tests;
- `docs/GITHUB_APP.md`;
- `docs/OPERATIONS.md`;
- `docs/SECURITY.md`;
- `docs/ARCHITECTURE.md`;
- `CHANGELOG.md`.

Historical Superpowers specs/plans remain historical evidence and are not retroactively rewritten.

Issue #3 must be updated so #34 completion is an explicit Phase B entry gate before GitHub write authority is enabled.

## 21. Non-goals

Issue #34 does not:

- implement #3 Phase B approvals, pushes, PR writes, review replies, or Actions artifact ingestion;
- grant automatic merge authority;
- redesign the MASWE workflow state machine;
- implement MH-01/MH-02 harness-neutral execution contracts;
- move the file store to PostgreSQL;
- create general owner/account identity migration;
- treat repository URLs, redirects, remotes, branch names, PR SHAs, or check resources as substitutes for GitHub repository ID;
- rewrite immutable workflow events or immutable GitHub journals;
- rewrite historical run configuration snapshots to manufacture stable authorization history;
- combine #33 product/repository naming cleanup into this implementation.

## 22. Implementation sequencing constraints

A future implementation plan should preserve this order:

1. add failing tests for stable identity normalization/config/token scope;
2. add stable domain/config/schema primitives while preserving legacy reads;
3. move token scoping to repository IDs;
4. add stable association/index APIs and transitional parser;
5. add stable fences and permanent/retryable dispatch classification;
6. add authenticated live canonical-name reconciliation;
7. move check idempotency to stable ID and add legacy ownership aliasing;
8. implement the explicit restartable migration command/checkpoint;
9. integrate migration with #28 stale-head handling and installation suspension;
10. synchronize docs and #3 Phase B gate;
11. run exact supported-baseline validation and independent review.

Implementation should be test-first and keep each intermediate failing state explicit. Do not temporarily authorize by name merely to make migration tests pass.

## 23. Completion gate

Issue #34 is complete only when all of the following are true:

- [ ] Stable numeric repository ID is authoritative in normalized events, run associations, association indexes, authorization, token scoping, locks, and GitHub side-effect ownership.
- [ ] Current canonical `owner/repo` can change without breaking the run/PR association.
- [ ] `allowedRepositoryIds` is the operational repository authorization source.
- [ ] Name-only legacy config cannot authorize repository-scoped operations or Phase B writes.
- [ ] Existing legacy associations can be explicitly reconciled to the same stable ID/current canonical name without manual state editing.
- [ ] Migration is idempotent and crash-recoverable under injected durable-write uncertainty.
- [ ] Old-name replay, new-name delivery, same-name/different-ID conflict, missing-ID legacy delivery, stale association, installation removal, and check ownership are covered.
- [ ] Unknown or conflicting repository identity fails closed with zero workflow/GitHub mutation.
- [ ] Permanent identity failures do not poison the durable retry queue.
- [ ] Rename plus unchanged head preserves valid SHA evidence; rename plus changed head enters #28 revalidation.
- [ ] Existing checks are reconciled without duplicate post-rename creation.
- [ ] Run, config/schema, GitHub adapter, association/index, token, operations, architecture, security, migration, and changelog documentation are synchronized.
- [ ] #3 lists #34 completion as an explicit Phase B entry gate.
- [ ] `npm run check` passes on exact Node `24.18.0`.
- [ ] `npm run check` passes on exact Node `22.22.2`.
- [ ] `npm run pack:dry` passes on both supported Node baselines as required by repository policy.
- [ ] `git diff --check` passes.
- [ ] Exact-head GitHub Actions CI passes, including the unsupported-Node negative gate.
- [ ] Independent exact-head validation passes.
- [ ] All substantive review threads are resolved or explicitly owner-dispositioned.
- [ ] Post-merge `main` CI is revalidated before #3 Phase B implementation begins.

## 24. External references

Official GitHub documentation used to validate the external API assumptions in this design:

- GitHub Docs — **Generating an installation access token for a GitHub App**: installation access tokens may be restricted with `repository_ids`; when no repository restriction is supplied they cover all repositories granted to the installation; permissions may be reduced.
- GitHub REST API — **Create an installation access token for an app**: documents `repository_ids` and `permissions`, including repository metadata permission.
- GitHub REST API — **List repositories accessible to the app installation**: `GET /installation/repositories` works with GitHub App installation access tokens.
- GitHub Docs — **Webhook events and payloads**: repository-scoped webhook payloads contain a `repository` object; #34 requires its stable numeric ID in normalized events.

These references describe GitHub's external behavior. MASWE's authorization and migration rules above are stricter by design and remain fail-closed if GitHub behavior is ambiguous or changes.