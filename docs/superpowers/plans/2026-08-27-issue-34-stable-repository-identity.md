# Issue #34 Stable GitHub Repository Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub numeric repository IDs authoritative for authorization, association, locking, canonical-name reconciliation, installation-token scope, and check ownership; provide a restartable authenticated migration for legacy name-only state; preserve exact PR/head/evidence semantics; and leave Phase B write authority disabled.

**Architecture:** Keep schema/config version 1 with additive stable-ID fields and explicit legacy-read boundaries. New repository-scoped execution uses stable ID fences and ID-scoped credentials. Pure GitHub identity/API parsing lives in focused modules instead of further expanding `adapter.ts`; the adapter composes those modules with the existing run mutation and association transaction primitives. Legacy ID-less authority reduction has its own `run target fence -> global association transaction` branch. Migration is explicit, quiescent, checkpointed, restartable, and reconciles existing production check ownership without rewriting immutable history.

**Tech Stack:** TypeScript, Node.js built-in test runner, JSON Schema 2020-12, GitHub REST API, current immutable ticket journals, durable atomic file store, existing `FileRunStore` / `GitHubAssociationIndex` / `GitHubDeliveryInbox` primitives.

**Spec:** `docs/superpowers/specs/2026-08-27-issue-34-stable-repository-identity-design.md` at approved design head `06fc6be310332a997a6eff41c33cf7b5d8d09d9c`.

## Global Constraints

- Exact implementation baseline is `main@4565d1c0661ff6cf20185f718b59c40d9c837c77`; the approved spec commits are documentation ancestry only.
- Before implementation, use `superpowers:using-git-worktrees` and create an isolated worktree/implementation branch from the approved plan head. Do not implement directly on `main`.
- Use test-driven development. Every task below begins with a failing focused regression, observes the expected failure, implements the smallest production change, and reruns the focused tests before committing.
- Do not grant Phase B write authority. `githubApp.enabled === true` still requires `readOnlyChecks === true` throughout Issue #34.
- `repositoryId` is the only repository authorization identity. `repository`/`owner/repo` remains routing/display/candidate metadata only.
- Never use redirect behavior as repository identity proof.
- Preserve exact PR target ownership via `base.repo.id`; fork PRs with a different `head.repo.id` remain valid.
- Preserve exact SHA-bound evidence and the Issue #28 revalidation contract. Identity migration alone cannot make stale evidence current.
- Pre-#34 and #34 GitHub writers must never run concurrently during migration. Cutover is quiescent: stop old writers, configure stable IDs, preflight old journals, migrate, then start the #34 listener.
- Do not rewrite immutable workflow events, GitHub journals, old side-effect records, or historical run config snapshots to manufacture continuity.
- Keep the hardcoded GitHub API origin `https://api.github.com`; API-origin configurability is not part of #34.
- Permanent webhook identity/policy rejection is consumed with zero authority increase; transient API/I/O/lock failures remain retryable.
- Every durable outcome-unknown path must re-read authoritative state and compare exact intended post-state before continuing.
- Final validation must run on exact Node `24.18.0` and `22.22.2`; the existing Node 25 negative CI gate remains required.

## File Structure / Responsibility Map

New focused modules:

- `src/github/repository-identity.ts` — stable-ID authorization helpers plus authenticated canonical repository lookup with safe bounded pagination.
- `src/github/pull-request.ts` — exact live PR snapshot parsing and target/base repository-ID proof.
- `src/github/dispatch-disposition.ts` — permanent-vs-applied webhook dispatch result vocabulary; no persistence.
- `src/github/check-identity-migration.ts` — legacy attempt-1 check ownership proof and stable local alias publication.
- `src/github/repository-identity-migration-store.ts` — bounded exact migration checkpoint persistence.
- `src/github/repository-identity-migration.ts` — quiescent restartable migration orchestration.
- `test/fixtures/github-pre34-validators.ts` — frozen **test-only** pre-#34 config/association validators for downgrade evidence.

Existing modules keep these responsibilities:

- `src/domain.ts`, `src/config.ts`, schemas, `src/store.ts` — additive schema-v1 stable-ID representation and legacy read compatibility.
- `src/github/types.ts`, `normalize.ts`, `delivery-inbox-record.ts` — new event identity plus exact legacy durable-event migration boundary.
- `src/github/token.ts` — ID-scoped least-privilege installation tokens.
- `src/github/association.ts` — stable primary index, transitional legacy parser, global association transaction.
- `src/github/journal.ts` — stable repository journal kind and read-only old-lock inspection.
- `src/github/adapter.ts` — orchestration/composition only: stable routing, canonical-name sync, lock order, mixed stable/legacy revocation fan-out.
- `src/github/checks.ts`, `side-effect-store.ts` — stable check idempotency and existing resource reconciliation.
- `src/github/webhook-worker.ts`, `webhook-diagnostic.ts` — consume permanent dispositions, retry transient failures, emit bounded listener-process observability.
- `src/cli-args.ts`, `src/cli-runner.ts` — migration command and quiescent listener cutover contract.

---

## Task 1: Add stable repository identity to config/run contracts without breaking legacy reads

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/config.ts`
- Modify: `src/store.ts`
- Modify: `schemas/config.schema.json`
- Modify: `schemas/run-record.schema.json`
- Modify: `test/config.test.ts`
- Modify: `test/schema.test.ts`
- Create: `test/fixtures/github-pre34-validators.ts`
- Create: `test/github-pre34-downgrade.test.ts`

**Consumes:** Existing schema-v1 config/run records and exact-object validation.

**Produces:** Normalized `allowedRepositoryIds: number[]`, optional persisted `RunGitHubAssociation.repositoryId`, exact enabled-time migration rule, and frozen downgrade evidence.

- [ ] **Step 1: Write failing config tests.** Add cases proving:
  - current name-only enabled config migrates to `allowedRepositoryIds: []` and remains loadable;
  - ID-only enabled config migrates to `allowedRepositories: []` and is valid;
  - enabled config with both arrays empty is invalid;
  - duplicate, zero, negative, fractional, unsafe, or non-number repository IDs fail;
  - repository names still normalize to lowercase but never populate IDs.

Use normalized expectations like:

```ts
assert.deepEqual(config.githubApp, {
  enabled: true,
  readOnlyChecks: true,
  webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
  appIdEnv: "MASWE_GITHUB_APP_ID",
  privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
  allowedRepositoryIds: [1308655205],
  allowedRepositories: [],
});
```

- [ ] **Step 2: Write failing run/schema tests.** Prove a legacy `github` association without `repositoryId` loads, a valid positive-safe-integer `repositoryId` round-trips, and malformed IDs fail in both `migrateRunRecord()` and JSON-schema checks.

- [ ] **Step 3: Write the frozen downgrade regression before production changes.** In `test/fixtures/github-pre34-validators.ts`, copy only the exact baseline `4565d1c` GitHub config allowed-key rule and association allowed-field/name-key rule into clearly named test-only functions, for example:

```ts
export function pre34AcceptsGitHubConfig(raw: Record<string, unknown>): boolean;
export function pre34AcceptsAssociationIndex(raw: unknown): boolean;
```

In `test/github-pre34-downgrade.test.ts`, create migrated golden fixtures containing `allowedRepositoryIds` / `repositoryId` and require both frozen validators to reject them. Never import these helpers from `src/`.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/config.test.ts \
  test/schema.test.ts \
  test/github-pre34-downgrade.test.ts
```

Expected: failures for unknown `allowedRepositoryIds`, missing normalized arrays, unsupported run `repositoryId`, and the not-yet-existing downgrade fixture behavior.

- [ ] **Step 5: Implement the normalized domain shape.** Use:

```ts
export interface GitHubAppConfig {
  enabled: boolean;
  readOnlyChecks: boolean;
  webhookSecretEnv: string;
  appIdEnv: string;
  privateKeyEnv: string;
  allowedRepositoryIds: number[];
  allowedRepositories: string[];
  webhookHost?: string;
  webhookPort?: number;
}

export interface RunGitHubAssociation {
  installationId: number;
  repositoryId?: number; // optional only because historical schema-v1 records exist
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  branch: string;
  suspended?: boolean;
  suspensionReason?: "pull-request-closed" | "authorization-revoked";
  pendingCancellationHeadShas?: string[];
}

export type StableRunGitHubAssociation = RunGitHubAssociation & { repositoryId: number };
```

- [ ] **Step 6: Implement config migration/validation.** Raw missing arrays normalize independently to `[]`. Enabled config requires `allowedRepositoryIds.length > 0 || allowedRepositories.length > 0`. `allowedRepositoryIds` must be unique positive safe integers. Preserve `readOnlyChecks === true` when enabled.

- [ ] **Step 7: Synchronize JSON schemas and `migrateRunRecord()`.** Keep version constants at 1. Require both normalized allowlist arrays in the normalized config schema; encode enabled-time rejection of both-empty arrays. Add optional positive integer `repositoryId` to run schema and exact run migration allowed fields.

- [ ] **Step 8: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/config.test.ts \
  test/schema.test.ts \
  test/github-pre34-downgrade.test.ts
npm run _typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit.**

```bash
git add src/domain.ts src/config.ts src/store.ts schemas/config.schema.json schemas/run-record.schema.json \
  test/config.test.ts test/schema.test.ts test/fixtures/github-pre34-validators.ts test/github-pre34-downgrade.test.ts
git commit -m "feat: add stable GitHub repository identity contracts"
```

---

## Task 2: Normalize repository IDs into new webhook events while preserving exact legacy durable-event reads

**Files:**
- Modify: `src/github/types.ts`
- Modify: `src/github/normalize.ts`
- Modify: `src/github/delivery-inbox-record.ts`
- Modify: `test/github-normalize.test.ts`
- Modify: `test/github-delivery-inbox.test.ts`
- Modify: `test/github-durable-ingress.test.ts`

**Consumes:** Signed parsed GitHub payloads and persisted format-2 inbox records.

**Produces:** New repo-scoped events with `repositoryId + repository`, ID/name pairs for installation repository changes, and explicit migrated representation for old name-only inbox events.

- [ ] **Step 1: Add failing normalization cases.** Every supported repository-scoped event must include a positive safe integer `repository.id`. Add malformed cases for missing/zero/fractional/unsafe IDs. Update normal event expectations to include `repositoryId`.

- [ ] **Step 2: Add failing `installation_repositories` pairing cases.** Define:

```ts
export interface GitHubRepositoryIdentity {
  repositoryId: number;
  repository: string;
}
```

New normalized events use `repositories?: GitHubRepositoryIdentity[]`. Prove identical duplicate pairs dedupe deterministically and same ID with conflicting names is malformed.

- [ ] **Step 3: Add failing historical durable-record cases.** Persist exact pre-#34 format-2 event JSON and prove `parseRecord()` can still read:
  - ordinary PR/push events with name but no ID;
  - old `installation_repositories` events with `repositories: string[]`.

Do **not** infer IDs. Migrate old repository-array records into an internal legacy-only field such as:

```ts
legacyRepositories?: string[];
```

so the operational type does not expose a union of names and stable identity objects.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-normalize.test.ts \
  test/github-delivery-inbox.test.ts \
  test/github-durable-ingress.test.ts
```

Expected: new ID assertions fail against name-only normalization/current exact durable-event parser.

- [ ] **Step 5: Implement exact repository identity extraction.** Add one helper that validates `repository.id` and `repository.full_name`; reuse it across event families. New repository-scoped events always carry both values.

- [ ] **Step 6: Implement durable-event compatibility migration.** `validEvent`/record parsing must distinguish new exact forms from recognized pre-#34 exact forms. Legacy forms remain marked by absence of `repositoryId` or `legacyRepositories`; no parser path may synthesize a repository ID.

- [ ] **Step 7: Update ingress fixtures.** All newly generated signed payloads in the touched tests must include `repository: { id: 1308655205, full_name: "owner/repo" }`; only explicit historical fixtures omit it.

- [ ] **Step 8: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-normalize.test.ts \
  test/github-delivery-inbox.test.ts \
  test/github-durable-ingress.test.ts
npm run _typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit.**

```bash
git add src/github/types.ts src/github/normalize.ts src/github/delivery-inbox-record.ts \
  test/github-normalize.test.ts test/github-delivery-inbox.test.ts test/github-durable-ingress.test.ts
git commit -m "feat: persist stable repository ids in GitHub events"
```

---

## Task 3: Replace name-scoped installation credentials with ID-scoped least-privilege purposes and add canonical-ID lookup

**Files:**
- Modify: `src/github/token.ts`
- Create: `src/github/pagination.ts`
- Create: `src/github/repository-identity.ts`
- Modify: `src/github/checks.ts` (consume shared pagination parser without changing check semantics)
- Modify: `test/github-token.test.ts`
- Create: `test/github-repository-identity.test.ts`
- Modify: `test/github-checks.test.ts`

**Consumes:** Installation ID + stable repository ID + purpose; injected `GitHubHttpClient`.

**Produces:** ID-restricted tokens and an authenticated `repositoryId -> current full_name` lookup with safe bounded pagination.

- [ ] **Step 1: Write failing token tests** for the three exact purposes:

```ts
type GitHubInstallationTokenPurpose =
  | "metadata-reconcile"
  | "pull-request-read"
  | "checks";
```

Require request body `repository_ids: [repositoryId]` and forbid `repositories`. Assert exact permissions:
  - metadata-reconcile: `{ metadata: "read" }`;
  - pull-request-read: `{ metadata: "read", pull_requests: "read" }`;
  - checks: `{ checks: "write", metadata: "read", pull_requests: "read" }`.

- [ ] **Step 2: Write failing canonical lookup pagination tests.** Cover page 1, page 2+, terminal absent target, duplicate ID/conflicting name, unsafe cross-origin/path/query, duplicate/multiple next rels, loop, page-limit exhaustion, rate limit/5xx. The first URL must be exactly based on:

```ts
const GITHUB_API_ORIGIN = "https://api.github.com";
const url = new URL("/installation/repositories", GITHUB_API_ORIGIN);
url.searchParams.set("per_page", "100");
```

- [ ] **Step 3: Extract shared strict Link parsing.** Move the already-hardened generic mechanics from `checks.ts` into `src/github/pagination.ts` with an interface such as:

```ts
export function nextGitHubLink(headers: Record<string, string>): string | undefined;
export function requireSafeGitHubPageUrl(rawUrl: string, policy: {
  origin: string;
  pathname: string;
  requiredQuery: Record<string, string>;
  optionalPositiveIntegerQuery: readonly string[];
  allowedQueryKeys: readonly string[];
}): string;
```

Existing check pagination must remain behaviorally identical under its current tests.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-token.test.ts \
  test/github-repository-identity.test.ts \
  test/github-checks.test.ts
```

Expected: token-body/purpose tests and new repository lookup tests fail; pre-existing check tests still show the baseline behavior to preserve.

- [ ] **Step 5: Implement ID-scoped token creation.** Change the input to `repositoryId` + `purpose`; reject non-positive-safe IDs and unknown purposes. No repository name may participate in credential scope.

- [ ] **Step 6: Implement canonical lookup.** Use a result union:

```ts
export type InstallationRepositoryLookupResult =
  | { kind: "found"; repositoryId: number; repository: string }
  | { kind: "not-found" };
```

Use `per_page=100`, max 100 pages, a visited-URL set, cross-page ID/name consistency checks, and exact canonical owner/name validation. A safely exhausted list returns `not-found`. Ambiguous/incomplete traversal throws a typed retryable/blocked error. A 100-page exhaustion gets a distinct operator-facing traversal-limit code and never becomes revocation evidence.

- [ ] **Step 7: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-token.test.ts \
  test/github-repository-identity.test.ts \
  test/github-checks.test.ts
npm run _typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git add src/github/token.ts src/github/pagination.ts src/github/repository-identity.ts \
  src/github/checks.ts test/github-token.test.ts test/github-repository-identity.test.ts test/github-checks.test.ts
git commit -m "feat: scope GitHub identity reads by repository id"
```

---

## Task 4: Re-key the association index by stable repository ID with an exact transitional legacy parser

**Files:**
- Modify: `src/github/types.ts`
- Modify: `src/github/association.ts`
- Modify: `test/github-association.test.ts`
- Modify: `test/github-authoritative-state.test.ts`
- Modify: `test/github-concurrency.test.ts`
- Modify: `test/fixtures/github-store-worker.ts`

**Consumes:** Mixed historical name-keyed and new ID-keyed association index records.

**Produces:** Stable operational APIs, migration-only legacy APIs, exact mixed-state parser, and stable repository/PR keying.

- [ ] **Step 1: Write failing stable-key tests.** New records must serialize under `${repositoryId}#${pullRequestNumber}` and contain `repositoryId` plus mutable `repository`.

- [ ] **Step 2: Write failing transitional parser tests.** Accept exact legacy `<owner/repo>#<pr>` records without ID and exact stable `<id>#<pr>` records with ID in the same index. Reject malformed mixed keys, stable key/record mismatch, duplicate stable PR identity, conflicting stable/legacy claims for one run, duplicate active run IDs, unknown fields, and malformed IDs/timestamps.

- [ ] **Step 3: Write failing API tests for explicit separation.** Implement/target these interfaces consistently:

```ts
export interface GitHubAssociationTransaction {
  findStable(repositoryId: number, pullRequestNumber: number): AssociationRecord | undefined;
  findLegacy(repository: string, pullRequestNumber: number): AssociationRecord | undefined;
  bindStable(input: StableAssociationBindInput): AssociationRecord;
  migrateLegacy(input: {
    legacyRepository: string;
    stable: StableAssociationBindInput;
  }): AssociationRecord;
  refreshCanonicalRepository(
    repositoryId: number,
    pullRequestNumber: number,
    repository: string,
  ): AssociationRecord | undefined;
  suspendStable(repositoryId: number, pullRequestNumber: number, reason: SuspensionReason): AssociationRecord | undefined;
  suspendLegacy(repository: string, pullRequestNumber: number, reason: SuspensionReason): AssociationRecord | undefined;
  onRollback(callback: () => Promise<void>): void;
}
```

Public index queries must include `findStable`, `findAllStableByRepositoryId`, `findAllLegacyByRepository`, `findAllByInstallation` (mixed), and stable `findAllByRepositoryBranch(repositoryId, branch)`.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-association.test.ts \
  test/github-authoritative-state.test.ts \
  test/github-concurrency.test.ts
```

Expected: new API/key assertions fail against the current name-primary index.

- [ ] **Step 5: Implement stable/mixed parser and transaction APIs.** Keep one authoritative `associations.json` and the existing single global association journal. `migrateLegacy()` must atomically remove the exact legacy key and publish the exact stable record in the same in-memory transaction before one durable index write.

- [ ] **Step 6: Preserve outcome-unknown semantics.** Existing durable index outcome-unknown behavior remains “re-read/reconcile, do not blind rollback.” Do not weaken bounded ordinary file reads or symlink/size protections.

- [ ] **Step 7: Update multi-process fixture and tests** to use stable keys for new operations while retaining explicit legacy fixtures for migration tests.

- [ ] **Step 8: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-association.test.ts \
  test/github-authoritative-state.test.ts \
  test/github-concurrency.test.ts
npm run _typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit.**

```bash
git add src/github/types.ts src/github/association.ts \
  test/github-association.test.ts test/github-authoritative-state.test.ts \
  test/github-concurrency.test.ts test/fixtures/github-store-worker.ts
git commit -m "feat: key GitHub associations by repository id"
```

---

## Task 5: Add stable repository journals and read-only pre-#34 ownership inspection

**Files:**
- Modify: `src/lock-journal.ts`
- Modify: `src/github/journal.ts`
- Modify: `test/github-journal.test.ts`
- Modify: `test/fixtures/github-journal-worker.ts`
- Modify: `test/github-concurrency.test.ts`

**Consumes:** Existing immutable GitHub journal protocol and old name-keyed publication/association-identity journal directories.

**Produces:** `repository-identity` journal kind plus conservative read-only cutover preflight that acquires no old operational lock.

- [ ] **Step 1: Write failing repository-journal tests.** `withGitHubJournal(root, "repository-identity", String(repositoryId), ...)` must initialize/acquire/release under the same immutable ticket protocol. Add the necessary `ClaimOperation` value (for example `github-repository-identity`) and exact mapping.

- [ ] **Step 2: Write failing read-only inspection tests.** Export a focused API:

```ts
export type LegacyGitHubJournalOwnershipState =
  | "absent"
  | "dead"
  | "live"
  | "malformed"
  | "ambiguous";

export async function inspectLegacyGitHubJournalOwnership(options: {
  githubRoot: string;
  kind: "publication" | "association-identity";
  logicalKey: string; // exact old owner/repo#pr key
  isProcessDefinitelyDead?: (pid: number) => boolean;
}): Promise<{ state: LegacyGitHubJournalOwnershipState }>;
```

It must scan/validate the old name-keyed journal state without publishing a claim to that logical key. Live owner => `live`; dead owner => `dead`; corrupt/incomplete/unsafe => `malformed` or `ambiguous`; absent path => `absent`.

- [ ] **Step 3: Add a concurrency fixture proving inspection does not acquire/block the old lock.** A live old writer remains the owner while inspection reports `live`; no new name-keyed claim is written by the #34 inspector.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-journal.test.ts \
  test/github-concurrency.test.ts
```

Expected: unknown journal kind/API and missing inspection semantics fail.

- [ ] **Step 5: Implement journal registration and inspection.** Reuse `scanLockJournal()`/stable journal reads and the existing conservative PID identity rules. Do not recover or acquire the old logical lock inside inspection; recovery/remediation remains a separate explicit operator path.

- [ ] **Step 6: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-journal.test.ts \
  test/github-concurrency.test.ts
npm run _typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add src/lock-journal.ts src/github/journal.ts \
  test/github-journal.test.ts test/fixtures/github-journal-worker.ts test/github-concurrency.test.ts
git commit -m "feat: add stable GitHub repository identity fences"
```

---

## Task 6: Centralize exact PR target ownership and stable authorization helpers

**Files:**
- Create: `src/github/pull-request.ts`
- Modify: `src/github/adapter-identities.ts`
- Create: `test/github-pull-request.test.ts`
- Modify: `test/github-remote-match.test.ts`

**Consumes:** Canonical current repository name, stable repository ID, ID-scoped PR-read/check token.

**Produces:** Exact PR snapshot and one stable authorization helper; local remote remains candidate metadata only.

- [ ] **Step 1: Write failing PR snapshot tests.** Target interface:

```ts
export interface GitHubPullRequestSnapshot {
  state: "open" | "closed";
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  baseRepositoryId: number;
  baseRepository: string;
}

export async function readGitHubPullRequestSnapshot(options: {
  http: GitHubHttpClient;
  token: string;
  repository: string;
  pullRequestNumber: number;
}): Promise<GitHubPullRequestSnapshot>;
```

Prove malformed/missing `base.repo.id` fails, mismatched target ID can be detected by callers, and a fork PR with different `head.repo.id` is accepted when `base.repo.id` matches.

- [ ] **Step 2: Write failing stable allowlist helper tests.** Replace name authorization with:

```ts
export function isRepositoryIdAllowed(
  config: GitHubAppConfig,
  repositoryId: number | undefined,
): boolean;

export function requireStableGitHubAssociation(
  association: RunGitHubAssociation | undefined,
): StableRunGitHubAssociation;
```

Name-only associations must throw an explicit migration-required error in operational paths.

- [ ] **Step 3: Preserve remote semantics.** Keep `remoteMatchesRepository()` unchanged as exact GitHub-host candidate matching; add tests/comments making clear it is not authorization and no redirect resolution is attempted.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-pull-request.test.ts \
  test/github-remote-match.test.ts
```

- [ ] **Step 5: Implement the modules** with exact shape validation and current hardcoded GitHub API origin. The PR helper parses data only; repository-ID comparison is explicit at each caller so tests can prove fork behavior.

- [ ] **Step 6: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-pull-request.test.ts \
  test/github-remote-match.test.ts
npm run _typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add src/github/pull-request.ts src/github/adapter-identities.ts \
  test/github-pull-request.test.ts test/github-remote-match.test.ts
git commit -m "feat: prove GitHub pull request target identity"
```

---

## Task 7: Give webhook processing a typed permanent disposition and listener-process drop observability

**Files:**
- Create: `src/github/dispatch-disposition.ts`
- Modify: `src/github/webhook-worker.ts`
- Modify: `src/github/webhook-diagnostic.ts`
- Modify: `src/github/adapter.ts` (dispatch return type/callback plumbing only; stable routing comes next task)
- Modify: `src/cli-runner.ts` (safe diagnostic rendering only)
- Modify: `test/github-webhook-worker.test.ts`
- Modify: `test/github-durable-ingress.test.ts`
- Modify: `test/github-cli-http.test.ts`

**Consumes:** Normalized events and dispatch result; durable inbox complete/retry primitives.

**Produces:** Permanent reject => complete, transient throw => retry; process-local reason-coded counter emitted through the existing listener diagnostic callback.

- [ ] **Step 1: Write failing worker tests** for a result vocabulary:

```ts
export type GitHubPermanentRepositoryRejectReason =
  | "stable-repository-authorization-required"
  | "repository-not-allowlisted"
  | "legacy-repository-identity-missing"
  | "repository-identity-conflict";

export type GitHubDispatchResult =
  | { kind: "applied" }
  | { kind: "permanent-reject"; reason: GitHubPermanentRepositoryRejectReason };
```

A permanent result must call `inbox.complete`, not `retry`. A thrown transient error still calls `retry`.

- [ ] **Step 2: Protect exactly-once counter semantics around completion.** Add a test where permanent dispatch succeeds but `inbox.complete` fails: the counter callback must **not** increment yet, because the delivery was not durably consumed. On a later successful completion it increments once.

- [ ] **Step 3: Define the counter reader.** `GitHubAppAdapter` owns:

```ts
private permanentRepositoryDropsSinceStart = 0;
```

After successful durable completion of a permanent repository reject, saturating-increment it to `Number.MAX_SAFE_INTEGER` and emit a diagnostic through the existing `onWebhookDiagnostic` listener-process callback containing `reason` and current count. This callback emission is the defined reader; do not persist the counter and do not expose it through `doctor`.

- [ ] **Step 4: Add safe production rendering test.** `src/cli-runner.ts` must print only bounded/sanitized code, reason, delivery/event identity, attempt, and count; arbitrary causes/secrets remain redacted.

- [ ] **Step 5: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-webhook-worker.test.ts \
  test/github-durable-ingress.test.ts \
  test/github-cli-http.test.ts
```

- [ ] **Step 6: Implement worker/adapter completion plumbing.** Both background worker and synchronous deterministic dispatch use the same result type. Emit the permanent diagnostic only after `complete()` succeeds. Completion failure follows existing completion-recovery semantics.

- [ ] **Step 7: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-webhook-worker.test.ts \
  test/github-durable-ingress.test.ts \
  test/github-cli-http.test.ts
npm run _typecheck
```

- [ ] **Step 8: Commit.**

```bash
git add src/github/dispatch-disposition.ts src/github/webhook-worker.ts src/github/webhook-diagnostic.ts \
  src/github/adapter.ts src/cli-runner.ts \
  test/github-webhook-worker.test.ts test/github-durable-ingress.test.ts test/github-cli-http.test.ts
git commit -m "feat: consume permanent GitHub identity rejections"
```

---

## Task 8: Move the adapter to stable routing/reconciliation and split mixed revocation fan-out by record class

**Files:**
- Modify: `src/github/adapter.ts`
- Modify: `src/github/adapter-identities.ts`
- Modify: `test/github-adapter.integration.test.ts`
- Modify: `test/github-suspend-reconcile.test.ts`
- Modify: `test/issue28-github-reconciliation.test.ts`
- Modify: `test/github-concurrency.test.ts`

**Consumes:** Stable events, stable/mixed association APIs, canonical lookup, exact PR snapshot, stable journal kinds, typed dispatch disposition.

**Produces:** Stable-ID publication/association locking, live rename reconciliation, stable first association, and explicit mixed `installation.deleted` fan-out.

- [ ] **Step 1: Update test fixtures first** to include stable repository ID and complete live PR objects (`base.repo.id/full_name`, base/head refs/SHA). Keep explicit historical legacy fixtures where the test is about migration/removal.

- [ ] **Step 2: Write failing rename tests.** Prove:
  - same ID/new name locates the existing association;
  - old-name replay with same ID cannot overwrite current canonical name;
  - same name/different ID permanently rejects with zero run/index/check mutation;
  - manual publication reconciles canonical name by ID before building REST paths;
  - an already associated run survives rename even if `workspace.remote` remains the old slug;
  - an unassociated stale old remote does not auto-associate.

- [ ] **Step 3: Write failing stable fence tests.** Replace name keys with:

```ts
withGitHubJournal(root, "repository-identity", String(repositoryId), ...)
withGitHubJournal(root, "publication", `${repositoryId}#${pr}`, ...)
withGitHubJournal(root, "association-identity", `${repositoryId}#${pr}`, ...)
```

Require lock order: repository -> PR -> run target -> association transaction/check-create.

- [ ] **Step 4: Write failing mixed `installation.deleted` tests (round-3 clarification).** Seed one stable association and one legacy ID-less association for the same installation. The shared suspension fan-out must classify each record:
  - stable record: `repository-identity(id) -> PR association fence -> run target fence -> global association transaction`;
  - legacy record: `run target fence -> global association transaction`, re-proving `repositoryId === undefined`, same installation, same legacy name; no name-keyed or ID-keyed repository fence.

Keep aggregation semantics: a failure on one record does not skip later records; aggregate after attempting all. Preserve non-ENOENT load errors. For a genuinely missing run record, only authority-reducing index state may be reconciled; never invent a run or stable identity.

- [ ] **Step 5: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-adapter.integration.test.ts \
  test/github-suspend-reconcile.test.ts \
  test/issue28-github-reconciliation.test.ts \
  test/github-concurrency.test.ts
```

Expected: current name fences/name allowlist/current PR parser and shared name-fenced suspension path fail the new assertions.

- [ ] **Step 6: Change the adapter token-provider contract** to:

```ts
(installationId: number, repositoryId: number, purpose: GitHubInstallationTokenPurpose) => Promise<string>
```

and route all repository authorization through `isRepositoryIdAllowed()`.

- [ ] **Step 7: Implement stable canonical reconciliation.** Under repository-ID fence, ID-scope metadata token -> canonical lookup -> recoverable run/index name refresh -> reload/re-prove. Name mismatch alone never authorizes mutation.

- [ ] **Step 8: Replace `currentPullRequest()` with `readGitHubPullRequestSnapshot()`.** For every association/publication read require `snapshot.baseRepositoryId === repositoryId`. Preserve live-state/head ordering and #28 stale-head behavior.

- [ ] **Step 9: Refactor suspension fan-out.** Replace one name-fenced `suspendAssociations()` path with explicit `suspendStableAssociation()` and `suspendLegacyAssociation()` helpers and one classifier. Stable and legacy branches must use the exact lock orders above; no transaction may acquire a run fence after it is already held.

- [ ] **Step 10: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-adapter.integration.test.ts \
  test/github-suspend-reconcile.test.ts \
  test/issue28-github-reconciliation.test.ts \
  test/github-concurrency.test.ts
npm run _typecheck
```

- [ ] **Step 11: Commit.**

```bash
git add src/github/adapter.ts src/github/adapter-identities.ts \
  test/github-adapter.integration.test.ts test/github-suspend-reconcile.test.ts \
  test/issue28-github-reconciliation.test.ts test/github-concurrency.test.ts
git commit -m "feat: route GitHub operations by stable repository id"
```

---

## Task 9: Make check ownership stable across rename and build a verified legacy alias primitive

**Files:**
- Modify: `src/github/checks.ts`
- Create: `src/github/check-identity-migration.ts`
- Modify: `src/github/side-effect-store.ts` only if a small read/put reconciliation helper is needed; do not change persisted record shape.
- Modify: `test/github-checks.test.ts`
- Create: `test/github-check-identity-migration.test.ts`
- Modify: `test/github-concurrency.test.ts`

**Consumes:** Stable repository ID, canonical route name, PR/head/check identity, old name-derived side-effect records/check resources.

**Produces:** Stable check key and one-time authenticated attempt-1 legacy ownership aliasing.

- [ ] **Step 1: Write failing stable-key tests.** Export deterministic key builders:

```ts
export function checkRunIdempotencyKey(
  repositoryId: number,
  pullRequestNumber: number,
  headSha: string,
  checkName: string,
  attempt: number,
): string {
  return `check-run:${repositoryId}/${pullRequestNumber}/${headSha}/${checkName}/${attempt}`;
}

export function legacyCheckRunIdempotencyKey(
  repository: string,
  pullRequestNumber: number,
  headSha: string,
  checkName: string,
  attempt: number,
): string;
```

`CheckPublisher` receives `repositoryId`; owner/repo remains only REST routing.

- [ ] **Step 2: Write failing alias tests.** Target helper:

```ts
export async function aliasLegacyAttemptOneChecks(options: {
  repositoryId: number;
  legacyRepository: string;
  repository: string;
  pullRequestNumber: number;
  headShas: readonly string[];
  token: string;
  http: GitHubHttpClient;
  sideEffects: GitHubSideEffectStore;
}): Promise<void>;
```

For each MASWE check/head:
  - if old local record exists, GET/verify the exact GitHub check resource has expected check name, head SHA, and legacy external ID before writing the new stable key -> same resource ID;
  - if old local record is absent, list exact head/name and find a unique legacy external-ID match;
  - multiple matches conflict;
  - no match means no alias;
  - old local record remains untouched.

- [ ] **Step 3: Prove production attempt scope.** Add a source-level/constructor test that production `GitHubAppAdapter` does not pass `attempt`, so production remains attempt 1. Explicit non-1 tests continue to work but are not migration authority.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-checks.test.ts \
  test/github-check-identity-migration.test.ts \
  test/github-concurrency.test.ts
```

- [ ] **Step 5: Implement stable keying and alias helper.** Side-effect alias writes remain ordinary `GitHubSideEffectStore.put()` under the stable create lock. If an alias write reports outcome unknown, re-read the stable key and continue only if it equals the intended resource ID.

- [ ] **Step 6: Run GREEN and typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-checks.test.ts \
  test/github-check-identity-migration.test.ts \
  test/github-concurrency.test.ts
npm run _typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add src/github/checks.ts src/github/check-identity-migration.ts src/github/side-effect-store.ts \
  test/github-checks.test.ts test/github-check-identity-migration.test.ts test/github-concurrency.test.ts
git commit -m "feat: stabilize GitHub check ownership across renames"
```

---

## Task 10: Implement the restartable repository-identity migration checkpoint and service

**Files:**
- Create: `src/github/repository-identity-migration-store.ts`
- Create: `src/github/repository-identity-migration.ts`
- Create: `test/github-repository-identity-migration.test.ts`
- Create: `test/github-repository-identity-migration-crash.test.ts`
- Modify: `src/github/association.ts` only for migration query/reconciliation gaps discovered by these tests.
- Modify: `src/github/adapter.ts` only to expose/reuse already-hardened association mutation primitives if needed; do not duplicate them.

**Consumes:** Quiescent legacy state, stable live config, read-only legacy journal inspection, canonical lookup, PR target proof, association transaction, run store, #28 revalidation, check alias helper.

**Produces:** Exact migration checkpoint, union candidate-universe restart logic, stable run/index associations, current canonical metadata, preserved/invalidated SHA evidence as appropriate.

- [ ] **Step 1: Write the checkpoint store tests first.** Persist exact record:

```ts
export interface RepositoryIdentityMigrationRecord {
  version: 1;
  repositoryId: number;
  legacyRepository: string;
  canonicalRepository: string;
  status: "in-progress" | "complete";
  startedAt: string;
  updatedAt: string;
}
```

Store under `.maswe/github/repository-identity-migrations/<sha256(repositoryId + "\0" + legacyRepository)>.json`. Use bounded ordinary reads and durable atomic writes; exact fields only; symlink/oversize/malformed state fails closed.

- [ ] **Step 2: Write migration happy-path tests.** Target service:

```ts
export class RepositoryIdentityMigrationService {
  constructor(options: {
    cwd: string;
    config: MasweConfig;
    store: RunStore;
    associations: GitHubAssociationIndex;
    sideEffects: GitHubSideEffectStore;
    http: GitHubHttpClient;
    tokenProvider: GitHubRepositoryTokenProvider;
    afterStep?: (step: RepositoryIdentityMigrationStep) => Promise<void>;
  });

  migrate(input: {
    legacyRepository: string;
    repositoryId: number;
  }): Promise<RepositoryIdentityMigrationResult>;
}
```

Prove old-name run/index becomes same stable ID/current canonical name; rerun is no-op; same normalized selector/different ID conflicts with zero mutation.

- [ ] **Step 3: Write union candidate-universe restart tests.** After one run is already migrated and another remains legacy, restart must inspect both:
  1. legacy records matching normalized old name;
  2. stable records matching target repository ID.

Re-derive distinct installation IDs from that union every pass.

- [ ] **Step 4: Write migration proof tests.** For every candidate require installation access by ID and live PR `base.repo.id === repositoryId`. Missing/ambiguous API data is not identity proof. Closed PR uses existing closure suspension. Same ID/current new name can refresh again during restart.

- [ ] **Step 5: Write stale-head tests.** Unchanged head preserves valid evidence. Changed head must create/update the same #28 GitHub-origin revalidation semantics and pending cancellation intent; migration cannot silently make old evidence current.

- [ ] **Step 6: Write crash/outcome-unknown tests with an explicit step seam.** Cover at least:
  - before checkpoint;
  - checkpoint published before first mutation;
  - run save before index publication;
  - index publication before checkpoint refresh;
  - stable check alias publication;
  - all associations stable before final complete marker;
  - run/index/checkpoint/side-effect alias atomic outcome unknown.

On restart, exact intended post-state must be re-read and either resumed idempotently or rejected on concrete conflict.

- [ ] **Step 7: Write old-lock preflight tests.** For every affected legacy PR, inspect old name-keyed publication and association-identity keys. `live`, `malformed`, or `ambiguous` blocks migration before run/index mutation. `dead`/`absent` can proceed according to documented journal recovery policy. The service never proves process quiescence from lock inspection alone; CLI/operator precondition remains mandatory.

- [ ] **Step 8: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-repository-identity-migration.test.ts \
  test/github-repository-identity-migration-crash.test.ts
```

- [ ] **Step 9: Implement checkpoint store and migration service.** Acquire `repository-identity(repositoryId)` once for a migration pass; do not recursively reacquire it. For each run use PR/run/global-association order. Use `migrateLegacy()` for index key conversion, `saveAssociationMutation`-equivalent rollback discipline for run/index synchronization, canonical lookup/PR proof, check aliasing, and final full rescan before `status: "complete"`.

- [ ] **Step 10: Run GREEN plus adjacent recovery suites.**

```bash
node --experimental-strip-types --test \
  test/github-repository-identity-migration.test.ts \
  test/github-repository-identity-migration-crash.test.ts \
  test/issue28-github-reconciliation.test.ts \
  test/github-suspend-reconcile.test.ts \
  test/github-authoritative-state.test.ts
npm run _typecheck
```

- [ ] **Step 11: Commit.**

```bash
git add src/github/repository-identity-migration-store.ts src/github/repository-identity-migration.ts \
  src/github/association.ts src/github/adapter.ts \
  test/github-repository-identity-migration.test.ts test/github-repository-identity-migration-crash.test.ts \
  test/issue28-github-reconciliation.test.ts test/github-suspend-reconcile.test.ts test/github-authoritative-state.test.ts
git commit -m "feat: migrate legacy GitHub repository identity safely"
```

---

## Task 11: Add the migration CLI, enforce quiescent cutover, synchronize active docs/contracts, and gate Issue #3

**Files:**
- Modify: `src/cli-args.ts`
- Modify: `src/cli-runner.ts`
- Create: `test/github-identity-cli.test.ts`
- Modify: `test/github-cli-http.test.ts`
- Modify: `docs/GITHUB_APP.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- GitHub metadata: update Issue #3 Phase B entry gate after code/docs are locally green.

**Consumes:** Migration service, approved stable config, listener/manual publisher entrypoints.

**Produces:** Operator command, enforceable cutover ordering, documented redelivery procedure, synchronized Phase B gate.

- [ ] **Step 1: Write failing CLI parser tests** for:

```text
maswe github-migrate-repository \
  --from <legacy-owner/repo> \
  --repository-id <positive-safe-integer> \
  [--json]
```

Add `from` and `repository-id` as exact single-value options. Reject missing option, duplicate option, invalid owner/repo, zero/fractional/unsafe ID, positional extras. Normalize `--from Owner/Repo` to lowercase before service invocation.

- [ ] **Step 2: Write failing command tests.** Migration requires GitHub App credentials + live stable allowlist. It prints deterministic JSON when requested and a concise text summary otherwise. It must never start a listener.

- [ ] **Step 3: Write failing listener cutover tests.** `github-webhook` must reject before listener readiness when `allowedRepositoryIds` is empty. Tests must configure IDs before listener start. Maintain the permanent-reject counter only as a defense for embedded/direct adapter misuse; the supported CLI ordering makes that window zero.

- [ ] **Step 4: Update the CLI token factory.** `githubAdapterForCommand` provides `(installationId, repositoryId, purpose)` to `createInstallationAccessToken`. Ensure token, PR, repository-list, and check calls share the current bounded `GitHubHttpClient`.

- [ ] **Step 5: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-identity-cli.test.ts \
  test/github-cli-http.test.ts
```

- [ ] **Step 6: Implement CLI command/cutover guard and run GREEN.**

```bash
node --experimental-strip-types --test \
  test/github-identity-cli.test.ts \
  test/github-cli-http.test.ts
npm run _typecheck
```

- [ ] **Step 7: Synchronize active documentation.** Document exact cutover order:
  1. stop all pre-#34 webhook/manual publishers;
  2. configure approved `allowedRepositoryIds`;
  3. run read-only old-journal preflight through migration command;
  4. run all required migrations to completion;
  5. start #34 listener/manual publisher;
  6. inspect GitHub App delivery history for transport failures during the deliberate outage and explicitly redeliver them.

Also document 10,000-row traversal-limit action (narrow installation repository scope; do not raise bound ad hoc), unsupported downgrade, stable/legacy lock orders, stable token purposes, permanent-drop diagnostic counter semantics, check-key migration, and no redirect-based equivalence.

- [ ] **Step 8: Run doc/code drift searches.** Inspect every result; names may remain only as routing/display/migration selector.

```bash
git grep -n "allowedRepositories" -- src schemas docs test
git grep -n "repositoryId" -- src/github src/domain.ts src/store.ts schemas test
git grep -n "new CheckPublisher" -- src
git grep -n "withGitHubJournal.*publication\|withGitHubJournal.*association-identity" -- src/github
```

Expected: no repository-scoped authorization or stable lock is still keyed by mutable owner/repo; the sole production `CheckPublisher` construction has no non-1 attempt override.

- [ ] **Step 9: Update Issue #3 Phase B entry gate through GitHub.** Add an explicit unchecked gate item equivalent to:

```markdown
- [ ] #34 stable repository identity is completed, independently validated, merged, and post-merge `main` is revalidated before Phase B obtains GitHub write authority.
```

Also update the status prose so it no longer says Phase B is blocked only by #27. Do not alter B1-B4 scope.

- [ ] **Step 10: Run focused docs/CLI plus full typecheck.**

```bash
node --experimental-strip-types --test test/github-identity-cli.test.ts test/github-cli-http.test.ts
npm run _typecheck
git diff --check
```

- [ ] **Step 11: Commit.**

```bash
git add src/cli-args.ts src/cli-runner.ts test/github-identity-cli.test.ts test/github-cli-http.test.ts \
  docs/GITHUB_APP.md docs/OPERATIONS.md docs/SECURITY.md docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: operationalize stable GitHub repository identity"
```

Record the Issue #3 mutation URL/ID in the implementation report; the GitHub issue edit is external metadata and is not part of the Git commit.

---

## Task 12: Full regression, exact supported-baseline validation, independent review, and governed merge

**Files:**
- Modify only if validation exposes a concrete Issue #34 defect; otherwise no new product scope.
- GitHub: PR for the implementation branch; Issue #34 completion evidence; Issue #3 gate already updated in Task 11.

**Consumes:** Complete implementation branch.

**Produces:** Fresh exact-head evidence suitable for owner merge decision.

- [ ] **Step 1: Run canonical Node 24.18.0 validation from a clean dependency install.**

```bash
nvm use 24.18.0
node --version
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:dry
git diff --check
```

Expected: Node prints `v24.18.0`; all commands exit 0.

- [ ] **Step 2: Run exact Node 22.22.2 compatibility validation.**

```bash
nvm use 22.22.2
node --version
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:dry
git diff --check
```

Expected: Node prints `v22.22.2`; all commands exit 0.

- [ ] **Step 3: Re-run the focused #34 matrix on the final head.**

```bash
node --experimental-strip-types --test \
  test/config.test.ts \
  test/schema.test.ts \
  test/github-pre34-downgrade.test.ts \
  test/github-normalize.test.ts \
  test/github-delivery-inbox.test.ts \
  test/github-token.test.ts \
  test/github-repository-identity.test.ts \
  test/github-pull-request.test.ts \
  test/github-association.test.ts \
  test/github-journal.test.ts \
  test/github-webhook-worker.test.ts \
  test/github-adapter.integration.test.ts \
  test/github-suspend-reconcile.test.ts \
  test/github-checks.test.ts \
  test/github-check-identity-migration.test.ts \
  test/github-repository-identity-migration.test.ts \
  test/github-repository-identity-migration-crash.test.ts \
  test/github-identity-cli.test.ts \
  test/issue28-github-reconciliation.test.ts \
  test/github-concurrency.test.ts \
  test/github-authoritative-state.test.ts
```

Expected: all pass.

- [ ] **Step 4: Perform final static invariants review.** Require evidence for each:
  - every new repo-bearing normalized event has stable ID;
  - no operational repository authorization uses `allowedRepositories`;
  - token restriction uses `repository_ids` only;
  - every live PR target check uses `base.repo.id`;
  - stable publication/association locks are ID-keyed;
  - §6.2 legacy authority reduction uses run fence -> global association transaction only;
  - `installation.deleted` mixed fan-out classifies records before choosing lock path;
  - permanent worker outcomes complete rather than retry;
  - permanent-drop count is emitted only after durable completion;
  - stable check keys use repository ID and production attempt remains 1;
  - migration restart universe is legacy-by-name union stable-by-ID;
  - no immutable journal/event/history rewrite exists.

- [ ] **Step 5: Open a draft PR against `main` with exact base/head disclosure.** Include Issue #34 design/plan links, migration/cutover warning, supported-node evidence, and explicit statement that Phase B write authority remains disabled.

- [ ] **Step 6: Wait for exact-head CI and verify the checked SHA.** Require canonical Node 24.18.0, Node 22.22.2 compatibility, and Node 25.9.0 negative jobs all terminal-success as applicable to their expected semantics. Do not use stale CI from an earlier head.

- [ ] **Step 7: Request independent exact-head verification and review.** Use `superpowers:requesting-code-review`. Any correction creates a new head, so rerun focused validation and exact-head CI before merge readiness.

- [ ] **Step 8: Resolve or explicitly owner-disposition every substantive review thread.** Do not infer reviewer silence as approval.

- [ ] **Step 9: Before claiming completion, use `superpowers:verification-before-completion` and re-run the proof commands required for every success claim.**

- [ ] **Step 10: Governed merge and post-merge main revalidation.** Merge only after exact-head CI, independent verification, scope review, and thread resolution pass. Then run/observe `main` CI on the merge commit. Only after post-merge `main` revalidation may Issue #34 be closed and Issue #3 Phase B entry gate be considered satisfied.

---

## Plan Self-Review Checklist

Before implementation starts, the executing agent must verify this plan still matches the approved spec and current branch state:

- [ ] Every spec section 3-23 maps to at least one implementation task above.
- [ ] Round-3 non-blocking clarification is explicit: `installation.deleted` classifies mixed stable/legacy records and routes each to its own lock discipline.
- [ ] Round-3 observability clarification is explicit: `permanentRepositoryDropsSinceStart` is read through the existing listener-process diagnostic callback after durable completion; it is not persisted and not exposed through `doctor`.
- [ ] No task introduces Phase B side effects.
- [ ] No task uses repository name/redirect as authorization proof.
- [ ] No placeholder terms such as `TODO`, `TBD`, “appropriate error handling”, or unspecified tests remain in the plan.
- [ ] New module interfaces are type-consistent across tasks: token provider takes `(installationId, repositoryId, purpose)`; stable association APIs take `repositoryId`; PR snapshot returns base repository ID; migration consumes all three.
- [ ] Each task has a RED command, GREEN command, and reviewable commit boundary.
- [ ] Final validation is fresh on exact supported Node baselines and exact GitHub head.
