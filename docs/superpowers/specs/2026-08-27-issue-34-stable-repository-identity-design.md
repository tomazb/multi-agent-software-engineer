# Issue #34 Stable GitHub Repository Identity and Rename Reconciliation Design

## Status

- **Issue:** #34 — Handle GitHub repository renames with stable repository identity
- **Related:** #3 — v0.3 GitHub App pilot, Phase B
- **Ordering predecessor:** #27 — correctness hardening, completed
- **Date:** 2026-08-27
- **Exact baseline:** `main@4565d1c0661ff6cf20185f718b59c40d9c837c77`
- **Branch:** `issue-34-stable-repository-identity-design`
- **Design status:** owner-approved architecture; committed specification awaiting owner review
- **Implementation authority:** none yet. This branch authorizes only this design specification. Runtime, schema, CLI, migration, test, documentation, and GitHub issue implementation changes require a separately approved implementation plan.

This document is a design specification. Its implementation behavior is not yet verified. GitHub API facts cited here were checked against current official GitHub documentation on 2026-08-27.

## 1. Baseline review

Issue #34 remains applicable on the exact post-#27, post-MH-00 baseline.

The Phase A GitHub integration currently treats mutable `owner/repository` text as primary repository identity in several authoritative places:

1. `GitHubAppConfig.allowedRepositories` authorizes repositories by `owner/repo` string.
2. `RunGitHubAssociation` persists `repository` but no stable numeric GitHub repository ID.
3. `GitHubInternalEvent` persists repository names while `normalizeGitHubWebhook()` discards `repository.id`.
4. `GitHubAssociationIndex` keys records as `<owner/repo>#<pull-request-number>`.
5. Repository suspension, branch lookup, publication fences, and association fences select by repository name.
6. Check-run idempotency keys contain `owner/repo`, so a rename creates a second local idempotency identity for the same GitHub repository/check resource.
7. `createInstallationAccessToken()` scopes credentials through GitHub's mutable `repositories: [name]` parameter.
8. Initial unassociated run discovery uses exact Git remote name plus branch as a candidate match.

A GitHub repository rename therefore creates an identity discontinuity even though GitHub retains the same repository object. Redirect behavior cannot safely repair that discontinuity because routing behavior is not MASWE authorization proof.

The repository already provides primitives that should be composed rather than replaced:

- authenticated webhook signature verification before normalization;
- durable delivery inbox and replay protection;
- installation-scoped GitHub credentials;
- append-only GitHub ownership journals and file locks;
- optimistic run persistence with exact validation;
- association transactions with rollback handling for known failures;
- explicit durable atomic-write outcome-unknown recovery;
- exact SHA-bound evidence and stale-head revalidation from #28;
- publication and target mutation fences;
- bounded GitHub side-effect records;
- centralized CLI grammar.

## 2. Objective and invariants

Make GitHub's stable numeric repository ID the authoritative identity for repository authorization, association, locking, reconciliation, token scoping, and GitHub side-effect ownership while retaining current canonical `owner/repo` as mutable API-routing/display metadata.

The design must preserve these invariants:

1. **Stable numeric ID is authoritative.** Mutable names never establish repository equivalence or authorization.
2. **Canonical name is mutable metadata.** A repository or owner rename does not break an already stable run/PR association.
3. **Authorization is ID-based.** Future Phase B writes may target only explicitly allowlisted repository IDs.
4. **Redirects are never identity evidence.** MASWE never derives old/new-name equivalence from HTTP redirect behavior.
5. **Exact PR/head/check ownership remains intact.** Rename handling does not weaken installation, PR number, target repository, head SHA, or check-resource proof.
6. **Legacy state remains readable but not authoritative.** Historical schema-v1 records may omit IDs; repository-scoped GitHub operations reject unresolved legacy identity.
7. **Migration is explicit, authenticated, idempotent, and restartable.** No hand editing of run records, association state, side-effect state, or immutable journals.
8. **Unknown/conflicting identity fails closed.** Matching text cannot repair a numeric identity conflict.
9. **Rename correctness does not depend on one webhook.** Repository-bearing events and manual publication trigger authenticated reconciliation when canonical metadata may be stale.
10. **#34 introduces no Phase B write authority.** Current Phase A `readOnlyChecks` restrictions remain in force.

## 3. Approaches considered

### 3.1 Dual identity with in-place restartable migration — selected

Add stable `repositoryId` to normalized events, run associations, association records, authorization, token scoping, locks, and side-effect ownership while keeping `repository` as current canonical name. Transitional readers accept both legacy name-keyed state and stable-ID-keyed state only at persistence boundaries.

This directly closes the correctness/security gap without starting a repository-wide schema-v2 programme immediately before later MH-01/MH-02 evolution.

### 3.2 Parallel GitHub state v2 — rejected

A new v2 store would provide a clean cutover but causes disproportionate schema/persistence churn for a focused identity repair.

### 3.3 Name-primary index plus secondary ID lookup — rejected

This leaves two competing authoritative identities and complicates crash recovery, locking, and authorization. Stable ID must be primary rather than advisory.

## 4. Canonical identity contract

Every repository-scoped GitHub operation uses this identity tuple:

```text
repositoryId      = immutable GitHub repository identity and authorization key
repository        = current canonical owner/name for API routing and display
installationId    = GitHub App installation authority boundary
pullRequestNumber = PR identity within repositoryId
headSha           = exact evidence/publication revision
```

### 4.1 `repositoryId`

`repositoryId` is a positive JavaScript safe integer. It is authoritative for:

- allowlist decisions;
- association primary keys;
- repository/PR fence keys;
- repository suspension selection;
- installation-token repository restriction;
- check-run idempotency ownership;
- rename reconciliation;
- Phase B repository authority after #34 closes.

### 4.2 `repository`

`repository` remains a normalized lowercase `owner/repo` string for REST routing and operator-facing output. A name change is not a new association when `repositoryId` remains equal.

Stored canonical name may change only after authenticated live reconciliation for the already-authorized ID. A signed webhook name mismatch is a reconciliation signal, not permission by itself to mutate routing metadata.

### 4.3 `installationId`

The association retains its installation identity. Incoming repository-scoped events must satisfy the expected installation boundary as well as stable repository identity. A different installation is never silently substituted.

## 5. Configuration and authorization

### 5.1 Normalized configuration shape

The in-memory normalized GitHub App configuration becomes conceptually:

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

Raw historical/project config may omit either allowlist. Config migration normalizes missing arrays to `[]` in memory without rewriting historical persisted snapshots.

`allowedRepositoryIds` validation:

- every entry is a positive safe integer;
- entries are unique;
- ordering has no semantic meaning.

### 5.2 Operational authorization rule

Any repository-scoped GitHub operation requires a non-empty `allowedRepositoryIds` and the target stable ID must be present.

`allowedRepositories` remains accepted only for:

- loading historical schema-v1 configuration snapshots;
- selecting/diagnosing legacy local state during explicit migration;
- operator display.

It cannot authorize:

- webhook-driven run changes;
- check publication;
- rename reconciliation;
- installation credential scope;
- future Phase B push/PR/comment/review writes;
- old-name/new-name equivalence.

A GitHub-enabled name-only project config remains parseable so an operator can inspect state, update configuration with approved IDs, and run migration. Repository-scoped adapter startup/publication fails with an explicit stable-authorization-required error until the live config contains IDs.

### 5.3 Persisted run config snapshots

Do not rewrite historical `run.config.githubApp` snapshots merely to add stable authorization. Those snapshots remain evidence of configuration at run creation. Live GitHub authorization uses the current project configuration.

### 5.4 Schema version

Keep `config.version: 1` and `RunRecord.schemaVersion: 1`. `allowedRepositoryIds` and run-association `repositoryId` are additive schema-v1 fields. Historical persisted records may omit them; operational GitHub accessors reject unresolved legacy state.

## 6. Installation-token identity

The current token helper scopes by mutable repository name. #34 replaces that with GitHub's documented numeric `repository_ids` restriction.

### 6.1 Token purposes

Refactor token minting around explicit purpose:

```ts
type GitHubInstallationTokenPurpose =
  | "metadata-reconcile"
  | "checks";
```

Both receive `installationId` and `repositoryId`; repository name is never credential scope.

`metadata-reconcile`:

- `repository_ids: [repositoryId]`;
- only `metadata: read`;
- used to prove installation access and discover current canonical name.

`checks`:

- `repository_ids: [repositoryId]`;
- current Phase A permissions: `checks: write`, `pull_requests: read`, `metadata: read`;
- all non-check write behavior remains blocked by `readOnlyChecks`.

No fallback to `repositories: [name]` is permitted.

### 6.2 Authenticated repository lookup

Using a metadata token restricted to the candidate ID, MASWE calls GitHub's `GET /installation/repositories` and requires a repository object with exactly the requested numeric ID and valid current `full_name`.

The endpoint is documented for GitHub App installation access tokens. The result is live identity proof for migration/reconciliation. MASWE never calls the old repository URL to discover a redirect.

## 7. Normalized webhook identity

### 7.1 Single-repository events

Every supported repository-scoped event normalized by the new binary requires and persists:

```ts
repositoryId: number;
repository: string;
```

This applies to current supported repository-scoped families:

- pull request;
- push;
- workflow run completed;
- check run completed;
- check suite completed.

`repository.id` must be a positive safe integer. Missing, zero, negative, fractional, unsafe, or malformed IDs fail normalization.

### 7.2 Installation repository changes

Do not keep independent parallel arrays of names and IDs. Normalize each `installation_repositories` item as:

```ts
interface GitHubRepositoryIdentity {
  repositoryId: number;
  repository: string;
}
```

Duplicate identical pairs collapse deterministically. Duplicate numeric ID with conflicting names is malformed.

`installation.created` and `installation.deleted` remain installation-scoped and need no invented repository ID.

### 7.3 Durable inbox compatibility

New normalized inbox records include stable IDs. Transitional deserialization may read historical normalized repository events that lack ID because old binaries discarded it before enqueue.

A legacy event missing stable identity is never upgraded from its name. Dispatch classifies it as permanent `legacy-repository-identity-missing`, performs zero run/index/GitHub mutation, and consumes the delivery instead of poisoning the retry queue.

Migration separately performs live reconciliation of affected associations. A new GitHub delivery normalized by the new binary includes the ID.

## 8. Local Git remote semantics

The local Git remote is workspace provenance/candidate-selection metadata, not repository authorization.

### 8.1 Already associated runs

Once a run has stable `repositoryId`, future webhook matching/reconciliation uses that ID. A stale pre-rename `workspace.remote` may remain historical/current local Git configuration and does not invalidate the stable GitHub association. #34 does not rewrite the operator's Git remote.

### 8.2 First association of an unassociated run

For a run with no GitHub association, existing exact remote-name + branch matching may remain only as a **candidate selector**. Before binding:

1. incoming webhook stable ID must be live-allowlisted;
2. live PR lookup must prove the target/base repository ID equals that stable ID;
3. installation identity and branch/head conditions must pass;
4. only then may MASWE persist the stable association.

A stale old remote slug is not followed or reconciled through redirects. If the repository was renamed before first association and the operator's remote still contains the old slug, MASWE does not infer equivalence; the operator must update the remote to the current canonical name before candidate matching.

This preserves the no-redirect rule without weakening the current exact remote+branch anti-stealing behavior.

## 9. Association/index model

### 9.1 Stable association shape

Add `repositoryId` to `RunGitHubAssociation` and `AssociationRecord`.

Persisted schema-v1 records may temporarily omit it, but every newly bound association requires it. GitHub operational code calls a type guard/accessor equivalent to `requireStableGitHubAssociation()` and rejects unresolved legacy association state.

### 9.2 Stable index key

New key:

```text
<repositoryId>#<pullRequestNumber>
```

`repository` remains inside the record only as mutable canonical routing/display metadata.

### 9.3 Transitional parser

During migration `associations.json` may contain:

- legacy `<owner/repo>#<pr>` records without `repositoryId`;
- stable `<repositoryId>#<pr>` records with `repositoryId`.

The parser rejects malformed keys, key/record mismatch, duplicate active run IDs, duplicate stable PR identity, inconsistent stable/legacy claims for the same run, unsupported fields, and malformed timestamps.

Normal lookup, branch lookup, and repository suspension APIs become stable-ID based. Migration gets a dedicated exact-name legacy enumeration path.

## 10. Stable fences and lock ordering

Add a repository-identity journal/fence keyed by `repositoryId`. It serializes:

- legacy migration;
- canonical-name reconciliation;
- repository-level authorization suspension/recovery;
- repository-scoped publication entry.

PR publication/association fences use `<repositoryId>#<pr>`, so a rename cannot change the lock identity.

Required acquisition order:

```text
repository-identity(repositoryId)
  -> PR/publication identity(repositoryId, pr)
    -> run target mutation fence(runId), when required
      -> association transaction / check-create lock
```

Helpers operating under an already-held identity context must not reacquire the same journal. Concurrency regressions must prove no same-key recursion/deadlock.

## 11. Live canonical-name reconciliation

Correctness does not depend on receiving a dedicated rename webhook.

### 11.1 Triggers

Reconciliation runs when:

- a repository-bearing event has the correct stable ID but a name different from stored canonical metadata;
- manual check publication begins;
- migration verifies legacy state;
- another repository-scoped operation needs a REST route and canonical metadata may be stale.

A later dedicated repository/account rename event may be an eager trigger, but is not required for correctness.

### 11.2 Algorithm

Under the repository identity fence:

1. require `repositoryId` in live `allowedRepositoryIds`;
2. require expected `installationId`;
3. mint ID-scoped metadata token;
4. query installation-accessible repositories;
5. require exactly the requested numeric ID and valid current `full_name`;
6. compare live name with stored metadata;
7. synchronize run association/index canonical name recoverably if changed;
8. reload and re-prove stable identity before using the route.

An old-name replay with the same ID can find the same association but cannot roll canonical name backward. Live ID lookup decides current routing name.

## 12. Pull request ownership proof

Any live PR read used for association, migration, or publication must return enough identity to prove the PR target.

The live PR helper must validate:

- response state (`open`/`closed` as expected);
- head SHA;
- target/base repository ID from `pull_request.base.repo.id`;
- target/base canonical repository name where available;
- base SHA/ref and head ref where the caller depends on them.

**The authoritative repository check is against `base.repo.id`, not `head.repo.id`.** Fork PRs legitimately have a different head repository ID. #34 must not reject valid fork PRs merely because the head repository differs from the target repository.

A PR loaded through a canonical name that reports a different base repository ID is a permanent identity conflict.

## 13. Explicit legacy migration command

MASWE's flat CLI grammar yields:

```text
maswe github-migrate-repository \
  --from <legacy-owner/repo> \
  --repository-id <positive-safe-integer>
```

`--json` may provide deterministic operator output; global `--cwd` and `--config` retain current semantics.

`--from` is only a local selector for unresolved persisted records. It is never identity proof.

### 13.1 Preconditions

Migration requires:

- GitHub App enabled;
- supplied ID present in live `allowedRepositoryIds`;
- valid exact legacy owner/repo selector;
- GitHub App credentials available;
- no Phase B writer authority enabled;
- repository identity fence held;
- affected installation IDs derived from persisted associations rather than guessed from name.

Operations should recommend stopping the webhook listener for operational quiescence, but correctness is enforced by the stable identity fence rather than by operator timing alone.

### 13.2 Installation proof

For every distinct installation ID referenced by selected legacy associations:

1. mint metadata token scoped to supplied repository ID;
2. query installation repositories;
3. require same numeric ID;
4. obtain current canonical name;
5. require consistent stable identity across proofs.

If an installation cannot prove access, migration does not infer continuity from the old name. The association remains unresolved and migration fails with a typed reason.

### 13.3 Per-association proof

For each selected legacy association:

- load run by `runId`;
- require run/index equality on installation ID, legacy repository name, PR number, base/head SHA, branch, and suspension state, except already-idempotent migration to the same ID;
- use stable-ID-scoped credential/current canonical name to load the live PR;
- require `base.repo.id === repositoryId`;
- compare live PR state/head/base/branch with stored state;
- route head drift through existing #28 revalidation semantics.

A stale/missing/conflicting run or index record stops migration. MASWE never chooses one copy as "probably correct."

## 14. Migration checkpoint and restart semantics

Persist a bounded migration intent/status record under the GitHub authoritative state root, protected by the repository identity journal:

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

No per-run completed list is required. Restart rescans authoritative run/index state and classifies each candidate as legacy, already migrated to the same ID, same-ID/name-refresh-needed, or conflict.

If canonical name changes again during migration, the same stable ID authorizes a new live canonical refresh; a conflicting ID does not.

### 14.1 Durable write uncertainty

On durable atomic-write outcome unknown:

- re-read run, association index, checkpoint, and any side-effect alias written in the step;
- compare against exact intended stable identity;
- continue only if the on-disk result is provably idempotent;
- otherwise stop with typed recovery error.

Migration succeeds only after a final full rescan finds no selected unresolved legacy association and stable run/index state agrees.

Re-running the same completed migration is a no-op after live authorization/reconciliation is re-proved. Same legacy selector with a different numeric ID conflicts and performs zero mutation.

## 15. Run/index synchronization

Migration and live rename reconciliation reuse the existing association transaction model.

For one run:

1. acquire stable repository/PR and run fences in documented order;
2. load and validate run/index snapshots;
3. prepare exact stable association candidate;
4. publish through existing optimistic/durable semantics;
5. use current rollback mechanism for known failures where rollback is safe;
6. for outcome-unknown errors, re-read rather than blindly roll back;
7. reload and require run/index equality on stable identity before release.

Immutable workflow event history and immutable GitHub journals are never rewritten.

## 16. SHA evidence and PR lifecycle during migration

### 16.1 Unchanged head

If live head equals associated head, migration may preserve existing SHA-bound quality/verification/merge-ready evidence. Only routing metadata changed.

### 16.2 Changed head

If live head differs, stable identity migration may complete but:

- old SHA success becomes unusable;
- pending cancellation state is updated through hardened logic;
- run enters existing GitHub-origin #28 revalidation before merge-ready/completion evidence can be reused.

Migration never silently overwrites head SHA without the revalidation/evidence-invalidating contract.

### 16.3 Closed PR

If live PR is closed, apply existing pull-request-closed suspension semantics under stable identity.

## 17. Check-run idempotency and ownership

### 17.1 Stable key

Replace:

```text
check-run:<owner/repo>/<pr>/<head>/<check>/<attempt>
```

with:

```text
check-run:<repositoryId>/<pr>/<head>/<check>/<attempt>
```

The derived external ID is then stable across future renames.

### 17.2 Existing relevant checks

Baseline production publication always uses check attempt `1`; `GitHubAppAdapter` does not override `CheckPublisher`'s default attempt. #34 therefore migrates production attempt `1` for each operationally relevant head:

```text
{ association.headSha } U association.pendingCancellationHeadShas
```

For each MASWE check name:

1. compute legacy name-derived key/external ID for attempt `1`;
2. compute new stable-ID key/external ID;
3. inspect exact legacy side-effect record if present;
4. authenticate under stable repository ID/current canonical route;
5. verify referenced GitHub check resource matches expected check name/head and legacy external ID before mapping the same resource ID to the stable local key;
6. if local legacy record is absent, list/reconcile checks for that exact head/name and legacy external ID;
7. require uniqueness; multiple matches are an ownership conflict;
8. if no existing legacy check can be proven, do not manufacture an alias.

Old side-effect records remain historical recovery evidence and are not deleted/re-written.

Future second/subsequent renames require no key migration because stable ID remains unchanged.

## 18. Permanent versus retryable failures

The current worker retries thrown dispatch failures. #34 introduces typed disposition so permanent identity/policy rejection cannot become an endless poison delivery.

### 18.1 Permanent

Examples:

- repository-scoped event missing/malformed ID;
- ID not live-allowlisted;
- matching name but conflicting ID;
- historical normalized event missing stable identity;
- run/index stable identity conflict;
- authenticated live result proves different repository identity.

Permanent failures:

- perform zero run/index/check/workflow mutation;
- emit bounded safe diagnostics;
- complete/consume durable delivery rather than retrying;
- never downgrade into name-based lookup.

Both background worker and synchronous deterministic dispatch seam must honor the same typed permanent disposition.

### 18.2 Retryable

Examples:

- rate limit;
- transient GitHub 5xx/network failure;
- temporary token/API failure that does not prove authorization loss;
- local journal/lock contention;
- recoverable durable I/O failure.

Retryable failures retain current durable inbox retry/backoff.

### 18.3 Positive authorization loss

When authenticated GitHub state positively proves installation no longer has repository access, apply existing authorization-revoked suspension semantics under stable ID. Ambiguous API failure is not proof of revocation.

## 19. Manual publication safety after rename

`github-publish-checks` sequence becomes:

1. load run and require stable association;
2. require stable ID live-allowlisted;
3. acquire stable repository/PR fences;
4. reconcile current canonical name by ID/installation;
5. reload/re-prove run/index identity;
6. mint checks token scoped by repository ID;
7. load live PR through reconciled canonical route and require `base.repo.id === repositoryId`;
8. preserve current stale-head invalidation/revalidation;
9. publish/reconcile through stable check keys.

Redirect behavior is never accepted as repository identity proof.

## 20. Security properties

#34 strengthens these boundaries:

- reuse of a previously authorized repository name by a different repository ID cannot inherit authorization;
- old webhook replay cannot roll canonical routing metadata backward;
- rename cannot create a second local check identity for the same check;
- token scoping moves from mutable name to numeric repository ID;
- future GitHub writes gain a stable repository authorization anchor;
- stale SHA evidence remains independent from identity migration;
- installation removal remains fail-closed;
- immutable journals/history cannot be edited to manufacture continuity;
- local Git remote text remains candidate/provenance metadata and cannot establish old/new-name equivalence.

A signed webhook is authenticated transport evidence. It does not override `allowedRepositoryIds`, stable association identity, installation identity, PR target repository ID, PR number, or SHA evidence.

## 21. Required regression matrix

Extend existing normalization, remote-match, association, suspension, authoritative-state, concurrency, adapter-integration, and #28 reconciliation suites.

### 21.1 Normalization/inbox

- every new supported repository event persists positive ID + name;
- installation repository changes preserve ID/name pairs;
- malformed IDs fail;
- duplicate identical pairs dedupe; duplicate ID/conflicting name fails;
- historical durable event missing ID remains readable but permanently rejects with zero mutation;
- delivery-ID replay semantics remain unchanged.

### 21.2 Config/authorization

- stable allowlist accepts only unique positive safe integers;
- malformed/duplicate IDs fail config validation;
- legacy name-only config remains loadable;
- name-only config cannot authorize webhook mutation/publication;
- allowed old name + unauthorized ID fails;
- authorized ID + changed/unlisted name succeeds after live reconciliation;
- Phase A `readOnlyChecks` behavior remains intact.

### 21.3 Token scope

- token requests use `repository_ids`, never repository names;
- metadata token is ID-scoped and least-privilege;
- unauthorized ID cannot yield usable scoped token;
- no name fallback occurs.

### 21.4 Remote/first association

- already stable associated run continues after rename even if `workspace.remote` retains old slug;
- unassociated run with exact current canonical remote + branch can become stable-associated only after allowlist/live PR base-ID proof;
- unassociated run with stale old remote does not auto-associate through redirect behavior;
- same textual remote cannot authorize a different repository ID.

### 21.5 Association/index

- new key is `<repositoryId>#<pr>`;
- same ID/new name resolves existing run;
- old-name replay same ID resolves same run but cannot restore old name;
- same name/different ID conflicts;
- transitional legacy/stable parser forms are exact;
- malformed mixed keys fail closed;
- duplicate stable PR/run identity remains rejected;
- branch lookup/repository suspension select by ID.

### 21.6 PR ownership

- target `base.repo.id` equal to stable ID succeeds;
- different base repo ID fails permanently;
- fork PR with different `head.repo.id` remains valid when base repo ID matches;
- malformed/missing base repo identity fails closed.

### 21.7 Migration/crash recovery

Inject interruption/failure:

- before checkpoint;
- after checkpoint before first run mutation;
- after run migration before index publication;
- after index publication before checkpoint refresh;
- during stable check-key alias publication;
- after all associations stable before completion;
- run atomic-write outcome unknown;
- index atomic-write outcome unknown;
- checkpoint atomic-write outcome unknown;
- side-effect alias atomic-write outcome unknown.

Restart/re-run must finish idempotently or fail closed on concrete conflict.

Also prove completed rerun no-op, same selector/different ID conflict, stale/missing run/index failure, authorization loss during migration, and canonical name changing again during restart.

### 21.8 SHA/PR lifecycle

- unchanged head preserves valid SHA evidence;
- changed head enters #28 revalidation;
- closed PR receives existing closure suspension;
- PR base repository identity mismatch fails migration.

### 21.9 Check ownership

- pre-rename check maps to same resource under stable key;
- no duplicate check on first post-rename publication;
- wrong repository/head/name/external ownership is rejected;
- multiple legacy external-ID matches fail as ambiguous;
- current head + pending cancellation heads are reconciled;
- second rename needs no side-effect migration.

### 21.10 Concurrency

- webhook reconciliation races migration;
- manual publication races migration;
- installation deletion/removal races migration;
- canonical-name reconciliation races publication;
- same-ID migrations serialize;
- conflicting migrations fail deterministically;
- lock ordering has no same-key recursion/deadlock.

### 21.11 Worker disposition

- permanent identity failure completes delivery with zero mutation/no retry loop;
- transient GitHub failure retries;
- synchronous dispatch uses same permanent/retryable classification;
- diagnostic callback cannot alter durable disposition;
- completion failure after permanent reject follows existing completion recovery;
- poison legacy delivery cannot starve unrelated queue entries.

## 22. Documentation and contract synchronization

Implementation must synchronize affected active surfaces, at minimum:

- `src/domain.ts`;
- `src/config.ts`;
- `src/cli-args.ts` and CLI dispatch/help;
- `schemas/config.schema.json`;
- `schemas/run-record.schema.json`;
- `src/github/types.ts`;
- `src/github/normalize.ts`;
- `src/github/delivery-inbox-record.ts`;
- `src/github/token.ts`;
- `src/github/adapter-identities.ts`;
- `src/github/association.ts`;
- `src/github/adapter.ts`;
- `src/github/checks.ts`;
- `src/github/side-effect-store.ts` as needed;
- `src/github/journal.ts`;
- `src/github/webhook-worker.ts` and diagnostics;
- migration/checkpoint modules;
- `test/github-remote-match.test.ts` plus affected GitHub suites;
- `docs/GITHUB_APP.md`;
- `docs/OPERATIONS.md`;
- `docs/SECURITY.md`;
- `docs/ARCHITECTURE.md`;
- `CHANGELOG.md`.

Historical Superpowers specs/plans remain historical evidence and are not retroactively rewritten.

Issue #3 must be updated so #34 completion is an explicit Phase B entry gate before GitHub write authority is enabled.

## 23. Non-goals

#34 does not:

- implement #3 Phase B approvals, pushes, PR writes, replies, or Actions artifact ingestion;
- grant automatic merge authority;
- redesign the workflow state machine;
- implement MH-01/MH-02 harness-neutral execution contracts;
- move storage to PostgreSQL;
- implement general owner/account identity migration;
- treat repository URLs, redirects, remotes, branch names, PR SHAs, or checks as substitutes for repository ID;
- rewrite immutable workflow events/GitHub journals;
- rewrite historical run config snapshots to manufacture stable authorization history;
- rewrite the operator's local Git remote;
- combine #33 product/repository naming cleanup.

## 24. Implementation sequencing constraints

A future implementation plan should preserve this order:

1. add failing stable-identity normalization/config/token/PR-ownership tests;
2. add stable domain/config/schema primitives preserving legacy reads;
3. move installation-token scoping to repository IDs;
4. add stable association/index APIs and transitional parser;
5. add stable fences and permanent/retryable dispatch classification;
6. add authenticated canonical-name reconciliation and PR base-ID proof;
7. move check idempotency to stable ID and add legacy attempt-1 ownership aliasing;
8. implement explicit restartable migration command/checkpoint;
9. integrate migration with #28 stale-head and installation suspension;
10. synchronize docs and #3 Phase B gate;
11. run exact supported-baseline validation and independent review.

Work test-first. Never temporarily authorize by name to make migration tests pass.

## 25. Completion gate

Issue #34 is complete only when:

- [ ] stable numeric repository ID is authoritative in normalized events, run associations, index, authorization, token scoping, locks, and side-effect ownership;
- [ ] canonical `owner/repo` can change without breaking an existing stable association;
- [ ] `allowedRepositoryIds` is the operational authorization source;
- [ ] legacy name-only config cannot authorize repository-scoped operations or Phase B writes;
- [ ] existing legacy associations can be explicitly reconciled to the same stable ID/current canonical name without manual state editing;
- [ ] unassociated stale remote names are never treated as redirect-based identity proof;
- [ ] live PR target ownership is proven by base repository ID and fork PRs remain valid;
- [ ] migration is idempotent/crash-recoverable under injected durable-write uncertainty;
- [ ] old-name replay, new-name delivery, same-name/different-ID conflict, missing-ID legacy delivery, stale association, installation removal, and check ownership are covered;
- [ ] unknown/conflicting identity fails closed with zero workflow/GitHub mutation;
- [ ] permanent identity failures do not poison the durable retry queue;
- [ ] unchanged head preserves valid SHA evidence and changed head enters #28 revalidation;
- [ ] existing checks reconcile without duplicate post-rename creation;
- [ ] run/config/schema/GitHub adapter/index/token/operations/architecture/security/migration/changelog surfaces are synchronized;
- [ ] #3 lists #34 completion as explicit Phase B entry gate;
- [ ] `npm run check` passes on exact Node `24.18.0`;
- [ ] `npm run check` passes on exact Node `22.22.2`;
- [ ] `npm run pack:dry` passes on both supported baselines as required by repository policy;
- [ ] `git diff --check` passes;
- [ ] exact-head GitHub Actions CI passes, including unsupported-Node negative gate;
- [ ] independent exact-head validation passes;
- [ ] all substantive review threads are resolved or explicitly owner-dispositioned;
- [ ] post-merge `main` CI is revalidated before #3 Phase B implementation begins.

## 26. External references

Official GitHub documentation used to validate external API assumptions:

- **Generating an installation access token for a GitHub App** — installation tokens may be restricted using `repository_ids`; permissions may be reduced.
- **Create an installation access token for an app** — documents `repository_ids` and repository `metadata` permissions.
- **List repositories accessible to the app installation** — `GET /installation/repositories` works with GitHub App installation access tokens.
- **Webhook events and payloads** — repository-scoped webhook payloads contain repository objects; #34 requires their stable numeric IDs during normalization.

GitHub's external behavior is input evidence only. MASWE's authorization/migration rules above are intentionally stricter and fail closed if external behavior becomes ambiguous.