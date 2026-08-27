# Issue #34 Stable GitHub Repository Identity and Rename Reconciliation Design

## Status

- **Issue:** #34 — Handle GitHub repository renames with stable repository identity
- **Related:** #3 — v0.3 GitHub App Phase B
- **Predecessor:** #27 — correctness hardening, completed
- **Date:** 2026-08-27
- **Exact baseline:** `main@4565d1c0661ff6cf20185f718b59c40d9c837c77`
- **Branch:** `issue-34-stable-repository-identity-design`
- **Design status:** owner-approved architecture; committed specification awaiting owner review
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
6. Legacy schema-v1 state remains readable but cannot authorize repository-scoped operations until reconciled.
7. Migration is explicit, authenticated, idempotent, restartable, and never hand-edits authoritative state or immutable journals.
8. Unknown/conflicting identity fails closed.
9. Correctness does not depend on receiving a dedicated rename webhook.
10. #34 adds no Phase B write authority; current `readOnlyChecks` restrictions remain.

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

## 3. Configuration and authorization

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

`allowedRepositoryIds` entries must be unique positive safe integers. Any repository-scoped association, reconciliation, credential mint, mutation, or publication requires a non-empty stable-ID allowlist and the target ID must be present.

`allowedRepositories` remains accepted only to load historical config, select/diagnose legacy local records during explicit migration, and display operator context. It cannot authorize webhook-driven run mutation, check publication, rename reconciliation, credential scope, future Phase B writes, or old/new-name equivalence.

A GitHub-enabled name-only project config remains parseable. Signed webhook ingress may still be durably accepted so deliveries are not lost, while repository-scoped dispatch/publication fails closed until IDs are configured. `installation.deleted` may still reduce authority by persisted `installationId`, including for unresolved legacy associations; it never establishes repository identity.

Keep `config.version: 1` and `RunRecord.schemaVersion: 1`. `allowedRepositoryIds` and run-association `repositoryId` are additive schema-v1 fields. Historical records may omit them; operational accessors reject unresolved legacy associations.

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

Authenticated canonical lookup uses `GET /installation/repositories` with the ID-scoped metadata token and requires exactly the requested numeric ID plus a valid current `full_name`. The old repository URL is never queried to infer redirect equivalence.

## 5. Webhook normalization and durable inbox compatibility

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

Historical durable normalized repository events may lack `repositoryId` because old binaries discarded it before enqueue. Transitional readers may load those records, but dispatch must never upgrade them from name. They receive a typed permanent `legacy-repository-identity-missing` disposition, mutate nothing, and are consumed rather than retried forever.

## 6. Local Git remote semantics

The local remote remains workspace provenance/candidate metadata, never repository authorization.

For an already stable-associated run, a stale pre-rename `workspace.remote` does not invalidate the GitHub association and #34 does not rewrite the operator's remote.

For a run with no GitHub association, existing exact current-remote + branch matching may remain only as a candidate selector. Before binding, MASWE must prove:

1. incoming stable ID is live-allowlisted;
2. live PR target/base repository ID equals that stable ID;
3. installation, branch, and head conditions pass.

If rename happened before first association and the local remote still contains the old slug, MASWE does not infer equivalence from redirect behavior. The operator must update the remote before candidate matching.

## 7. Association/index model

Add `repositoryId` to `RunGitHubAssociation` and `AssociationRecord`. Every newly bound association requires it. Historical persisted associations may omit it only at deserialization/migration boundaries.

Operational code uses a helper equivalent to `requireStableGitHubAssociation()` and rejects unresolved legacy state.

New association key:

```text
<repositoryId>#<pullRequestNumber>
```

During migration, `associations.json` may contain:

- legacy `<owner/repo>#<pr>` entries without `repositoryId`;
- stable `<repositoryId>#<pr>` entries with `repositoryId`.

The transitional parser must reject malformed keys, key/record mismatch, duplicate active run IDs, duplicate stable PR identity, inconsistent stable/legacy claims for the same run, unsupported fields, and malformed timestamps.

Normal lookup, branch lookup, and repository suspension become stable-ID based. Migration gets an explicit exact-name legacy enumeration path.

## 8. Stable fences and lock order

Add a repository-identity journal/fence keyed by `repositoryId`. It serializes legacy migration, canonical-name reconciliation, repository authorization suspension/recovery, and repository-scoped publication entry.

PR publication/association fences use `<repositoryId>#<pr>`.

Required order:

```text
repository-identity(repositoryId)
  -> PR/publication identity(repositoryId, pr)
    -> run target mutation fence(runId), when required
      -> association transaction / check-create lock
```

Helpers operating under an already-held identity context must not reacquire the same journal. Concurrency tests must prove no recursive same-key acquisition/deadlock.

## 9. Live canonical-name reconciliation

Correctness does not depend on a dedicated rename webhook. Reconciliation runs when a repository-bearing event has the correct ID but a different name, manual publication begins, migration verifies legacy state, or another repository-scoped operation requires a possibly stale route.

Under repository identity fence:

1. require stable ID live-allowlisted;
2. require expected installation;
3. mint ID-scoped metadata token;
4. query installation repositories;
5. require the exact requested ID and current valid `full_name`;
6. synchronize run/index canonical name recoverably if changed;
7. reload and re-prove stable identity before using the route.

An old-name replay with the same ID can locate the same association but cannot roll the canonical name backward; live ID reconciliation decides the current name. Same text with a different ID is a permanent conflict.

## 10. Pull request ownership proof

Any live PR read used for association, migration, or publication must prove the PR target. The helper validates state, head SHA, target/base repository ID (`base.repo.id`), base canonical name where available, and base/head refs/SHAs where callers depend on them.

**Repository ownership is checked against `base.repo.id`, not `head.repo.id`.** Fork PRs legitimately have a different head repository. A different/missing base repository ID is a permanent identity conflict.

Migration/association proof uses the ID-scoped `pull-request-read` token. Check publication may use its already-required ID-scoped `checks` token for the same live PR read.

## 11. Explicit legacy migration

Concrete flat CLI command:

```text
maswe github-migrate-repository \
  --from <legacy-owner/repo> \
  --repository-id <positive-safe-integer>
```

Optional `--json` may provide deterministic operator output; global `--cwd` and `--config` keep current semantics. `--from` is only a local selector for unresolved persisted records and never identity proof.

Migration requires GitHub App enabled, supplied ID live-allowlisted, valid legacy selector, credentials available, no Phase B writer authority, repository identity fence held, and affected installation IDs derived from persisted associations.

For each affected installation:

1. mint metadata token scoped to supplied ID;
2. query installation repositories;
3. require the same ID;
4. obtain current canonical name;
5. require consistent stable identity across successful proofs.

For each selected legacy association:

- require run/index equality on installation, legacy name, PR number, base/head SHA, branch, and suspension state, except already-idempotent same-ID migration;
- use ID-scoped `pull-request-read` credential/current canonical route;
- require live `base.repo.id === repositoryId`;
- compare live PR state/head/base/branch with stored state;
- route head drift through existing #28 revalidation semantics.

Stale/missing/conflicting run/index state stops migration. MASWE never chooses one persisted copy as probably correct.

Operations should recommend stopping the listener for operational quiescence, but correctness is enforced by stable fences rather than operator timing alone.

## 12. Migration checkpoint and crash recovery

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

No per-run completed list is required. Restart rescans authoritative run/index state and classifies each candidate as legacy, already migrated to same ID, same-ID name-refresh-needed, or conflict.

Migration/live rename synchronization reuses current association transactions and optimistic run persistence. Known failures may use existing rollback where safe; outcome-unknown writes require re-read/reconciliation rather than blind rollback.

On any atomic-write outcome unknown, re-read the run, index, checkpoint, and affected side-effect alias; continue only when the exact intended stable identity is provably on disk. Final success requires a full rescan showing no selected unresolved legacy association and run/index agreement.

Re-running the same completed migration is a no-op after live proof. Same selector with a different ID conflicts and mutates nothing.

Immutable workflow events and immutable GitHub journals are never rewritten.

## 13. SHA evidence and PR lifecycle

If live head is unchanged, migration may preserve existing SHA-bound evidence because only routing metadata changed.

If live head differs, stable identity migration may complete but old success becomes unusable, pending check cancellation state is updated, and the run enters existing GitHub-origin #28 revalidation before merge-ready/completion evidence can be reused.

If the live PR is closed, apply existing pull-request-closed suspension under stable identity.

## 14. Check idempotency and existing check ownership

Replace mutable key:

```text
check-run:<owner/repo>/<pr>/<head>/<check>/<attempt>
```

with stable key:

```text
check-run:<repositoryId>/<pr>/<head>/<check>/<attempt>
```

The derived external ID then remains stable across future renames.

Baseline production publication uses attempt `1`, so #34 migrates attempt `1` for the operationally relevant heads:

```text
{ association.headSha } U association.pendingCancellationHeadShas
```

For each MASWE check name:

1. compute legacy name-derived key/external ID and stable-ID key;
2. inspect exact legacy side-effect record if present;
3. authenticate under stable ID/current canonical route;
4. verify referenced GitHub check matches expected name/head/legacy external ID before mapping the same resource ID to stable local key;
5. if local legacy record is absent, reconcile exact head/name/legacy external ID through GitHub;
6. require uniqueness; multiple matches conflict;
7. if no legacy check is proven, do not manufacture an alias.

Old side-effect records remain historical recovery evidence. A second rename needs no side-effect-key migration.

## 15. Permanent versus retryable dispatch failures

The current worker retries thrown dispatch failures. #34 introduces typed disposition so permanent identity/policy rejection cannot become a poison delivery.

Permanent examples: missing/malformed ID, ID not live-allowlisted, same name/conflicting ID, historical event missing stable ID, run/index identity conflict, authenticated live result proving different identity.

Permanent disposition:

- zero run/index/check/workflow mutation;
- bounded safe diagnostic;
- durable delivery consumed rather than retried;
- no fallback to name lookup.

Background worker and synchronous deterministic dispatch seam use the same classification.

Retryable examples remain rate limit, transient GitHub/network errors, temporary token/API failure without proven authorization loss, lock contention, and recoverable durable I/O.

When authenticated GitHub state positively proves repository access was revoked, apply existing authorization-revoked suspension under stable ID. Ambiguous API failure is not proof of revocation.

## 16. Manual publication after rename

`github-publish-checks` becomes:

1. load run and require stable association;
2. require stable ID live-allowlisted;
3. acquire stable repository/PR fences;
4. reconcile canonical name with metadata token;
5. reload/re-prove run/index identity;
6. mint checks token scoped by repository ID;
7. read live PR and require `base.repo.id === repositoryId`;
8. preserve current stale-head invalidation/revalidation;
9. publish/reconcile using stable check keys.

Redirect behavior is never accepted as identity proof.

## 17. Security properties

#34 must prove that:

- reuse of an authorized old name by a different repository ID cannot inherit authority;
- old webhook replay cannot roll canonical metadata backward;
- rename cannot create a second local check identity;
- credential scope is numeric-ID based;
- future GitHub writes have a stable repository authority anchor;
- stale SHA evidence remains independent from repository identity migration;
- installation removal remains fail-closed;
- local Git remote remains candidate/provenance metadata only;
- immutable history cannot be edited to manufacture continuity.

A signed webhook authenticates transport. It never overrides stable allowlist, association, installation, PR target repository ID, PR number, or SHA evidence.

## 18. Required regression matrix

Extend existing normalization, remote-match, association, suspension, authoritative-state, concurrency, adapter-integration, check, and #28 reconciliation suites.

### Normalization/inbox

- every new repository event persists positive ID + name;
- installation repository changes preserve ID/name pairs;
- malformed IDs fail;
- identical pairs dedupe; same ID/conflicting name fails;
- historical event missing ID permanently rejects with zero mutation;
- delivery replay semantics remain unchanged.

### Config/authorization

- stable allowlist accepts only unique positive safe integers;
- malformed/duplicate IDs fail;
- legacy name-only config remains loadable;
- signed ingress can remain durable while repository-scoped dispatch is blocked;
- name-only config cannot authorize mutation/publication;
- allowed old name + unauthorized ID fails;
- authorized ID + changed name succeeds after live reconciliation;
- Phase A `readOnlyChecks` stays intact.

### Token scope

- all restricted token requests use `repository_ids`, never repository names;
- metadata token has only metadata read;
- PR-read token has pull-request + metadata read and no check write;
- checks token retains only current Phase A permissions;
- no name fallback occurs.

### Remote/first association

- stable-associated run survives rename with stale `workspace.remote`;
- unassociated current-remote + branch binds only after allowlist/live PR base-ID proof;
- stale old remote does not auto-associate through redirect;
- same text remote cannot authorize another repository ID.

### Association/index

- key is `<repositoryId>#<pr>`;
- same ID/new name resolves same run;
- old-name replay same ID cannot restore old name;
- same name/different ID conflicts;
- transitional parser exactness/mixed-key failures;
- duplicate stable PR/run identity rejected;
- branch lookup/repository suspension by ID.

### PR ownership

- matching `base.repo.id` succeeds;
- different/missing base repo ID fails;
- fork PR with different `head.repo.id` remains valid when base matches.

### Migration/crash recovery

Inject failure before checkpoint; after checkpoint; after run mutation before index; after index before checkpoint refresh; during stable check alias; after all associations stable before completion; and outcome-unknown for run/index/checkpoint/side-effect alias. Restart must finish idempotently or fail closed on a concrete conflict.

Also prove completed rerun no-op, selector/different-ID conflict, stale/missing run/index failure, authorization loss, and another same-ID rename during restart.

### SHA/PR lifecycle

- unchanged head preserves valid evidence;
- changed head enters #28 revalidation;
- closed PR receives closure suspension;
- PR base repository mismatch fails migration.

### Check ownership

- pre-rename check maps to same resource under stable key;
- no duplicate on first post-rename publication;
- wrong head/name/external ownership rejected;
- multiple legacy external-ID matches conflict;
- current + pending-cancellation heads reconciled;
- second rename needs no side-effect migration.

### Concurrency

- webhook reconciliation vs migration;
- manual publication vs migration;
- installation deletion/removal vs migration;
- canonical reconciliation vs publication;
- same-ID migrations serialize;
- conflicting migrations fail deterministically;
- no recursive same-key lock/deadlock.

### Worker disposition

- permanent identity error consumes delivery with zero mutation/no retry loop;
- transient GitHub failure retries;
- synchronous path uses same classification;
- diagnostic callback cannot alter durable disposition;
- completion failure after permanent reject follows existing completion recovery;
- poison legacy event cannot starve unrelated queue items.

## 19. Contract/document synchronization

Implementation must synchronize at minimum:

- domain/config and config validation;
- CLI grammar/dispatch/help;
- config and run-record schemas;
- GitHub types/normalization/durable inbox compatibility;
- token creation;
- adapter identity helpers;
- association/index;
- adapter routing/publication;
- checks/side-effect ownership;
- GitHub journals/worker diagnostics;
- migration/checkpoint modules;
- affected focused/integration tests including remote-match;
- `docs/GITHUB_APP.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, and `CHANGELOG.md`.

Historical Superpowers specs/plans remain historical evidence. Issue #3 must be updated so #34 completion is an explicit Phase B entry gate before write authority is enabled.

## 20. Non-goals

#34 does not implement Phase B approvals/pushes/PR writes/replies/Actions artifacts, automatic merge, workflow redesign, MH-01/MH-02, PostgreSQL, general owner/account migration, local Git remote rewriting, or #33 identity wording cleanup.

Repository URLs, redirects, remotes, branch names, PR SHAs, and check resources are never substitutes for repository ID. Immutable workflow events/GitHub journals and historical run config snapshots are not rewritten to manufacture identity history.

## 21. Implementation sequencing constraints

A future plan should preserve this order:

1. failing normalization/config/token/PR-ownership tests;
2. stable domain/config/schema primitives preserving legacy reads;
3. ID-scoped least-privilege token purposes;
4. stable association/index APIs and transitional parser;
5. stable fences plus permanent/retryable dispatch classification;
6. canonical reconciliation plus PR base-ID proof;
7. stable check idempotency plus legacy attempt-1 ownership aliasing;
8. explicit restartable migration command/checkpoint;
9. #28 stale-head plus installation-suspension integration;
10. documentation plus #3 Phase B gate synchronization;
11. exact supported-baseline validation and independent review.

Work test-first. Never temporarily authorize by name to make migration tests pass.

## 22. Completion gate

Issue #34 is complete only when:

- [ ] stable numeric repository ID is authoritative in normalized events, associations, index, authorization, token scope, locks, and side-effect ownership;
- [ ] canonical name can change without breaking an existing stable association;
- [ ] `allowedRepositoryIds` is the operational authorization source;
- [ ] name-only config cannot authorize repository-scoped operations or Phase B writes;
- [ ] legacy associations migrate explicitly without manual state editing;
- [ ] stale unassociated remotes never become redirect-based identity proof;
- [ ] live PR target ownership is base-repository-ID bound and fork PRs remain valid;
- [ ] migration is idempotent/crash-recoverable under injected durable uncertainty;
- [ ] old-name replay, new-name delivery, conflicting ID, missing-ID legacy delivery, stale association, installation removal, and check ownership are covered;
- [ ] unknown/conflicting identity causes zero workflow/GitHub mutation;
- [ ] permanent identity failures do not poison the durable retry queue;
- [ ] unchanged head preserves valid SHA evidence and changed head enters #28 revalidation;
- [ ] existing checks reconcile without duplicate post-rename creation;
- [ ] active contracts/docs/changelog are synchronized;
- [ ] #3 lists #34 as explicit Phase B entry gate;
- [ ] `npm run check` passes on exact Node `24.18.0` and `22.22.2`;
- [ ] `npm run pack:dry` passes on both supported baselines as required by repository policy;
- [ ] `git diff --check` passes;
- [ ] exact-head CI passes including unsupported-Node negative gate;
- [ ] independent exact-head validation passes;
- [ ] substantive review threads are resolved or owner-dispositioned;
- [ ] post-merge `main` CI is revalidated before #3 Phase B begins.

## 23. External GitHub references

Official GitHub documentation used to validate external assumptions:

- **Generating an installation access token for a GitHub App** — tokens may be restricted by `repository_ids` and permissions may be reduced.
- **Create an installation access token for an app** — documents `repository_ids`, metadata, and pull-request permissions.
- **List repositories accessible to the app installation** — `GET /installation/repositories` supports GitHub App installation tokens.
- **Get a pull request** — installation tokens can read PRs with suitable read permission and PR objects expose base/head repository information.
- **Webhook events and payloads** — repository-scoped payloads contain repository objects; #34 requires their stable numeric IDs during normalization.

GitHub behavior is external input evidence only. MASWE's authorization and migration rules above are intentionally stricter and fail closed if external behavior is ambiguous.