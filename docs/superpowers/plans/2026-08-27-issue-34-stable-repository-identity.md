# Issue #34 Stable GitHub Repository Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub numeric repository IDs authoritative for authorization, association, locking, canonical-name reconciliation, installation-token scope, and check ownership; migrate existing name-only state safely; preserve exact PR/head/evidence semantics; and leave Phase B write authority disabled.

**Architecture:** Keep config/run schema version 1 with additive stable-ID fields and explicit legacy-read boundaries. Stable repository operations use ID-scoped credentials and ID-keyed fences. Pure GitHub API parsing lives in focused modules. Run/index mutation logic is extracted from the adapter into one shared transaction helper used by both live routing and migration. Legacy ID-less authority reduction uses only `run target fence -> global association transaction`. Migration is explicit, quiescent, checkpointed, restartable, and aliases existing production check ownership without rewriting immutable history.

**Tech Stack:** TypeScript, Node.js built-in test runner, JSON Schema 2020-12, GitHub REST API, current immutable ticket journals, durable atomic file store, `FileRunStore`, `GitHubAssociationIndex`, and `GitHubDeliveryInbox`.

**Spec:** `docs/superpowers/specs/2026-08-27-issue-34-stable-repository-identity-design.md` at approved design head `06fc6be310332a997a6eff41c33cf7b5d8d09d9c`.

## Global Constraints

- Exact runtime baseline is `main@4565d1c0661ff6cf20185f718b59c40d9c837c77`; the approved design/plan commits are documentation ancestry.
- Before implementation, invoke `superpowers:using-git-worktrees` and create an isolated implementation worktree/branch from the approved plan head. Do not implement on `main`.
- Use test-driven development: write a focused regression, run it and observe the expected failure, implement the smallest production change, rerun focused tests, then commit.
- Do not grant Phase B write authority. `githubApp.enabled === true` continues to require `readOnlyChecks === true` throughout #34.
- `repositoryId` is the only repository authorization identity. `repository`/`owner/repo` is routing/display/candidate metadata only.
- Never use redirect behavior as identity evidence.
- Validate PR target ownership with `base.repo.id`; fork PRs with a different `head.repo.id` remain valid.
- Preserve Issue #28 exact-head revalidation. Repository identity migration cannot make stale evidence current.
- Cutover is quiescent: stop all pre-#34 GitHub writers, configure stable IDs, inspect old name-keyed journals, finish migrations, then start the #34 listener/manual publisher.
- Do not rewrite immutable workflow events, GitHub journals, old side-effect records, or historical run config snapshots.
- Keep the hardcoded GitHub API origin `https://api.github.com`; API-origin configurability is outside #34.
- Permanent webhook identity/policy rejection is durably consumed with zero authority increase. Transient API/I/O/lock failures remain retryable.
- Every durable outcome-unknown path re-reads authoritative state and compares the exact intended post-state before continuing.
- Final validation runs on exact Node `24.18.0` and `22.22.2`; the existing Node 25 negative CI gate remains required.

## File Structure / Responsibility Map

New modules:

- `src/github/pagination.ts` — shared strict GitHub `Link` parsing and safe page-URL validation.
- `src/github/repository-identity.ts` — authenticated `repositoryId -> current canonical owner/repo` lookup with bounded pagination.
- `src/github/pull-request.ts` — exact live PR snapshot parsing, including `base.repo.id`.
- `src/github/association-mutation.ts` — shared run/index mutation, rollback, and outcome-unknown reconciliation primitives extracted from `adapter.ts`.
- `src/github/dispatch-disposition.ts` — permanent-vs-applied webhook dispatch result vocabulary.
- `src/github/check-identity-migration.ts` — legacy production attempt-1 check ownership proof and stable alias publication.
- `src/github/repository-identity-migration-store.ts` — bounded exact migration checkpoint persistence.
- `src/github/repository-identity-migration.ts` — quiescent restartable migration orchestration.
- `test/fixtures/github-pre34-validators.ts` — frozen test-only pre-#34 validators for downgrade evidence.

Existing responsibility changes:

- `src/domain.ts`, `src/config.ts`, schemas, `src/store.ts` — additive schema-v1 stable-ID representation and legacy reads.
- `src/github/types.ts`, `normalize.ts`, `delivery-inbox-record.ts` — stable event identity plus exact legacy durable-event compatibility.
- `src/github/token.ts` — ID-scoped least-privilege installation tokens and the shared token-provider type.
- `src/github/adapter-identities.ts` — stable allowlist guard, stable-association guard, owner/repo parsing, remote candidate matching.
- `src/github/association.ts` — stable primary index, transitional legacy parser, global association transaction.
- `src/github/journal.ts` — `repository-identity` journal kind and read-only pre-#34 ownership inspection.
- `src/github/adapter.ts` — composition only: stable routing/reconciliation, lock order, mixed stable/legacy revocation fan-out.
- `src/github/checks.ts` — stable check key and live publication.
- `src/github/webhook-worker.ts`, `webhook-diagnostic.ts` — consume permanent dispositions, retry transient failures, emit listener-process observability.
- `src/cli-args.ts`, `src/cli-runner.ts` — migration command and quiescent cutover guard.

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

**Consumes:** Current schema-v1 config/run records and exact-object validation.

**Produces:** Normalized ID allowlist, optional persisted run `repositoryId`, exact enabled-time rule, and frozen downgrade evidence.

- [ ] **Step 1: Write failing config tests.** Prove name-only enabled config remains loadable and normalizes `allowedRepositoryIds: []`; ID-only enabled config is valid and normalizes `allowedRepositories: []`; both-empty enabled config fails; duplicate/zero/negative/fractional/unsafe/non-number IDs fail; names normalize to lowercase but never populate IDs.

Expected normalized ID-only shape:

```ts
{
  enabled: true,
  readOnlyChecks: true,
  webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
  appIdEnv: "MASWE_GITHUB_APP_ID",
  privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
  allowedRepositoryIds: [1308655205],
  allowedRepositories: [],
}
```

- [ ] **Step 2: Write failing run/schema tests.** A legacy `github` association without ID must load. A positive-safe-integer ID must round-trip. Malformed IDs must fail both run migration and schema validation.

- [ ] **Step 3: Create frozen downgrade evidence before changing production validators.** `test/fixtures/github-pre34-validators.ts` contains only test copies of the exact baseline GitHub config key/rule and association allowed-field/name-key parser:

```ts
export function pre34AcceptsGitHubConfig(raw: Record<string, unknown>): boolean;
export function pre34AcceptsAssociationIndex(raw: unknown): boolean;
```

`test/github-pre34-downgrade.test.ts` feeds migrated golden fixtures containing `allowedRepositoryIds` / `repositoryId` and requires both old validators to reject them. Production code never imports the fixture.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/config.test.ts test/schema.test.ts test/github-pre34-downgrade.test.ts
```

Expected: unknown stable fields/current name-only enabled rule cause failures.

- [ ] **Step 5: Implement domain types.**

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
  repositoryId?: number; // legacy-read boundary only
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

- [ ] **Step 6: Implement config migration/validation.** Raw missing arrays normalize independently to `[]`. Enabled config requires `allowedRepositoryIds.length > 0 || allowedRepositories.length > 0`. IDs are unique positive safe integers. Preserve the Phase A `readOnlyChecks` guard.

- [ ] **Step 7: Synchronize schemas and `migrateRunRecord()`.** Keep version constants at 1. Normalized config schema contains both arrays and rejects enabled both-empty. Run schema accepts optional positive integer `repositoryId`; exact run migration allows and validates it.

- [ ] **Step 8: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/config.test.ts test/schema.test.ts test/github-pre34-downgrade.test.ts
npm run _typecheck
```

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

**Consumes:** Authenticated parsed GitHub payloads and persisted format-2 inbox records.

**Produces:** New ID-bearing repo events, ID/name repository-change pairs, and explicit `legacyRepositories` for old persisted name arrays.

- [ ] **Step 1: Write failing normalization tests.** Every supported repo-scoped new payload requires a positive safe `repository.id` and normalized `repository.full_name`. Add missing/zero/fractional/unsafe cases.

- [ ] **Step 2: Write failing installation-repository pairing tests.**

```ts
export interface GitHubRepositoryIdentity {
  repositoryId: number;
  repository: string;
}
```

New `installation_repositories` events use `repositories?: GitHubRepositoryIdentity[]`. Identical pairs dedupe; same ID/conflicting names is malformed.

- [ ] **Step 3: Write failing historical durable-record tests.** Pre-#34 repo events with name/no ID remain readable. Old `installation_repositories` `repositories: string[]` is migrated at the durable-record boundary to exact internal `legacyRepositories?: string[]`. No parser synthesizes IDs.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-normalize.test.ts test/github-delivery-inbox.test.ts test/github-durable-ingress.test.ts
```

- [ ] **Step 5: Implement one exact repository-identity extractor** and use it for all supported repo-scoped new events.

- [ ] **Step 6: Implement durable compatibility migration.** New exact forms and recognized pre-#34 exact forms are distinct. Legacy ordinary events remain ID-less; old name arrays become `legacyRepositories`.

- [ ] **Step 7: Update newly generated test payloads** to include `repository: { id: 1308655205, full_name: "owner/repo" }`; only historical fixtures omit the ID.

- [ ] **Step 8: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-normalize.test.ts test/github-delivery-inbox.test.ts test/github-durable-ingress.test.ts
npm run _typecheck
```

- [ ] **Step 9: Commit.**

```bash
git add src/github/types.ts src/github/normalize.ts src/github/delivery-inbox-record.ts \
  test/github-normalize.test.ts test/github-delivery-inbox.test.ts test/github-durable-ingress.test.ts
git commit -m "feat: persist stable repository ids in GitHub events"
```

---

## Task 3: Move installation credentials to repository IDs and add authenticated canonical lookup

**Files:**
- Modify: `src/github/token.ts`
- Create: `src/github/pagination.ts`
- Create: `src/github/repository-identity.ts`
- Modify: `src/github/checks.ts`
- Modify: `test/github-token.test.ts`
- Create: `test/github-repository-identity.test.ts`
- Modify: `test/github-checks.test.ts`

**Consumes:** Installation ID, stable repository ID, token purpose, injected `GitHubHttpClient`.

**Produces:** ID-restricted least-privilege tokens, named token-provider type, and bounded authenticated canonical lookup.

- [ ] **Step 1: Write failing token-purpose tests.** Define exactly:

```ts
export type GitHubInstallationTokenPurpose =
  | "metadata-reconcile"
  | "pull-request-read"
  | "checks";

export type GitHubRepositoryTokenProvider = (
  installationId: number,
  repositoryId: number,
  purpose: GitHubInstallationTokenPurpose,
) => Promise<string>;
```

All token requests use `repository_ids: [repositoryId]` and never `repositories`. Exact permissions:

```ts
metadata-reconcile -> { metadata: "read" }
pull-request-read  -> { metadata: "read", pull_requests: "read" }
checks             -> { checks: "write", metadata: "read", pull_requests: "read" }
```

- [ ] **Step 2: Write failing canonical-lookup tests.** Cover target page 1/page 2+, clean terminal absence, duplicate ID/conflicting name, unsafe origin/path/query, duplicate/multiple next rels, loop, rate-limit/5xx, and 100-page exhaustion.

- [ ] **Step 3: Extract current hardened Link logic into `pagination.ts`.** Use exact API:

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

Update existing check pagination to consume it with no behavior change.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-token.test.ts test/github-repository-identity.test.ts test/github-checks.test.ts
```

- [ ] **Step 5: Implement ID-scoped token creation.** Reject invalid IDs/unknown purposes. Repository name never participates in credential scope.

- [ ] **Step 6: Implement canonical lookup.**

```ts
export type InstallationRepositoryLookupResult =
  | { kind: "found"; repositoryId: number; repository: string }
  | { kind: "not-found" };
```

Use hardcoded `https://api.github.com`, `/installation/repositories?per_page=100`, max 100 pages, visited-URL loop detection, strict URL policy, cross-page ID/name consistency, and canonical name validation. Clean terminal absence returns `not-found`. Page-limit/malformed/unsafe/rate-limit/5xx throws a typed retryable/blocked lookup error; traversal limit has a distinct operator-facing code and never means revocation.

- [ ] **Step 7: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-token.test.ts test/github-repository-identity.test.ts test/github-checks.test.ts
npm run _typecheck
```

- [ ] **Step 8: Commit.**

```bash
git add src/github/token.ts src/github/pagination.ts src/github/repository-identity.ts src/github/checks.ts \
  test/github-token.test.ts test/github-repository-identity.test.ts test/github-checks.test.ts
git commit -m "feat: scope GitHub identity reads by repository id"
```

---

## Task 4: Re-key associations by repository ID with an exact transitional parser

**Files:**
- Modify: `src/github/types.ts`
- Modify: `src/github/association.ts`
- Modify: `test/github-association.test.ts`
- Modify: `test/github-authoritative-state.test.ts`
- Modify: `test/github-concurrency.test.ts`
- Modify: `test/fixtures/github-store-worker.ts`

**Consumes:** Mixed historical name-keyed and new ID-keyed association records.

**Produces:** Stable operational transaction/query APIs and migration-only legacy APIs under the existing global association journal.

- [ ] **Step 1: Write failing stable-key tests.** New stable record key is `${repositoryId}#${pullRequestNumber}` and the record contains both stable ID and mutable canonical name.

- [ ] **Step 2: Write failing mixed-parser tests.** Accept exact legacy `<owner/repo>#<pr>` without ID and exact stable `<id>#<pr>` with ID in one file. Reject malformed key/record pairs, duplicate stable PR identity, duplicate active run ID, inconsistent stable/legacy claims, unknown fields, malformed IDs/timestamps.

- [ ] **Step 3: Define concrete transaction types in production.**

```ts
export type SuspensionReason = "pull-request-closed" | "authorization-revoked";

export type StableAssociationBindInput = Omit<
  AssociationRecord,
  "repositoryId" | "suspended" | "updatedAt"
> & {
  repositoryId: number;
  suspended?: boolean;
};

export interface GitHubAssociationTransaction {
  findStable(repositoryId: number, pullRequestNumber: number): AssociationRecord | undefined;
  findLegacy(repository: string, pullRequestNumber: number): AssociationRecord | undefined;
  bindStable(input: StableAssociationBindInput): AssociationRecord;
  migrateLegacy(input: { legacyRepository: string; stable: StableAssociationBindInput }): AssociationRecord;
  refreshCanonicalRepository(repositoryId: number, pullRequestNumber: number, repository: string): AssociationRecord | undefined;
  suspendStable(repositoryId: number, pullRequestNumber: number, reason: SuspensionReason): AssociationRecord | undefined;
  suspendLegacy(repository: string, pullRequestNumber: number, reason: SuspensionReason): AssociationRecord | undefined;
  onRollback(callback: () => Promise<void>): void;
}
```

Public queries: `findStable`, `findAllStableByRepositoryId`, `findAllLegacyByRepository`, `findAllByInstallation` (mixed), and stable `findAllByRepositoryBranch(repositoryId, branch)`.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-association.test.ts test/github-authoritative-state.test.ts test/github-concurrency.test.ts
```

- [ ] **Step 5: Implement parser/APIs.** `migrateLegacy()` removes the exact legacy key and inserts the exact stable key in one in-memory transaction followed by one durable index write. Keep the existing global `association/associations` journal.

- [ ] **Step 6: Preserve durable uncertainty and filesystem hardening.** Outcome unknown remains re-read/reconcile; do not weaken bounded no-follow reads, capacity checks, or symlink rejection.

- [ ] **Step 7: Update multi-process fixture/tests** for stable new operations plus explicit legacy fixtures.

- [ ] **Step 8: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-association.test.ts test/github-authoritative-state.test.ts test/github-concurrency.test.ts
npm run _typecheck
```

- [ ] **Step 9: Commit.**

```bash
git add src/github/types.ts src/github/association.ts \
  test/github-association.test.ts test/github-authoritative-state.test.ts test/github-concurrency.test.ts \
  test/fixtures/github-store-worker.ts
git commit -m "feat: key GitHub associations by repository id"
```

---

## Task 5: Add stable repository journals and read-only pre-#34 lock inspection

**Files:**
- Modify: `src/lock-journal.ts`
- Modify: `src/github/journal.ts`
- Modify: `test/github-journal.test.ts`
- Modify: `test/fixtures/github-journal-worker.ts`
- Modify: `test/github-concurrency.test.ts`

**Consumes:** Immutable ticket journals and current pre-#34 name-keyed publication/association-identity journal directories.

**Produces:** `repository-identity` journal kind and a conservative read-only old-lock preflight.

- [ ] **Step 1: Write failing repository-journal tests.** Add exact `ClaimOperation` value `github-repository-identity`; add `repository-identity` to `GitHubJournalKind`, `JOURNAL_KINDS`, operation map, initialization/recovery.

- [ ] **Step 2: Write failing read-only inspection tests** for:

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
  logicalKey: string; // exact old owner/repo#pr
  isProcessDefinitelyDead?: (pid: number) => boolean;
}): Promise<{ state: LegacyGitHubJournalOwnershipState }>;
```

Classification: no unresolved owner -> `absent`; exactly proven dead current owner -> `dead`; exactly proven live owner -> `live`; corrupt/unsafe records -> `malformed`; queued/incomplete/ownership state that cannot be classified exactly -> `ambiguous`.

- [ ] **Step 3: Prove inspection acquires no old operational lock.** Hold a live old name-keyed journal claim in a fixture process; inspection reports `live`, does not append a competing claim, and does not disturb the owner.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test test/github-journal.test.ts test/github-concurrency.test.ts
```

- [ ] **Step 5: Implement registration/inspection.** Reuse `scanLockJournal()` and stable journal reads. Do not recover/acquire the old logical lock inside inspection.

- [ ] **Step 6: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test test/github-journal.test.ts test/github-concurrency.test.ts
npm run _typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add src/lock-journal.ts src/github/journal.ts test/github-journal.test.ts \
  test/fixtures/github-journal-worker.ts test/github-concurrency.test.ts
git commit -m "feat: add stable GitHub repository identity fences"
```

---

## Task 6: Centralize exact PR target proof, stable authorization guards, and shared run/index mutation

**Files:**
- Create: `src/github/pull-request.ts`
- Create: `src/github/association-mutation.ts`
- Modify: `src/github/adapter-identities.ts`
- Modify: `src/github/adapter.ts` (extract mutation helpers only)
- Create: `test/github-pull-request.test.ts`
- Create: `test/github-association-mutation.test.ts`
- Modify: `test/github-remote-match.test.ts`
- Modify: `test/github-adapter.integration.test.ts`

**Consumes:** Canonical route, stable ID, PR-read/check token, run store, association transaction.

**Produces:** Exact PR snapshot, stable guards, and one shared mutation primitive usable by adapter and migration.

- [ ] **Step 1: Write failing PR snapshot tests.**

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
```

`readGitHubPullRequestSnapshot({http, token, repository, pullRequestNumber})` rejects malformed/missing base repo identity. Fork PR with different `head.repo.id` remains parseable; caller compares only `baseRepositoryId` to target ID.

- [ ] **Step 2: Write failing guard tests.**

```ts
export function isRepositoryIdAllowed(config: GitHubAppConfig, repositoryId: number | undefined): boolean;
export function requireStableGitHubAssociation(association: RunGitHubAssociation | undefined): StableRunGitHubAssociation;
```

ID-less association throws an explicit migration-required error. `remoteMatchesRepository()` remains exact candidate metadata and never authorizes.

- [ ] **Step 3: Write failing shared mutation tests.** Extract current `eventHistoryIdentity`, `associationRollbackInvariant`, run rollback, and association-coupled save into `association-mutation.ts` with concrete API:

```ts
export async function saveGitHubAssociationMutation(options: {
  store: RunStore;
  transaction: GitHubAssociationTransaction;
  before: RunRecord;
  candidate: RunRecord;
}): Promise<void>;
```

It may change only `github` and `evidence`; known transaction failure can compensate the run; durable outcome unknown is re-read/reconciled, never blind rollback.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-pull-request.test.ts test/github-association-mutation.test.ts \
  test/github-remote-match.test.ts test/github-adapter.integration.test.ts
```

- [ ] **Step 5: Implement PR helper/guards/shared mutation module.** Make `adapter.ts` consume the shared mutation module so migration will not reach into private adapter methods.

- [ ] **Step 6: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-pull-request.test.ts test/github-association-mutation.test.ts \
  test/github-remote-match.test.ts test/github-adapter.integration.test.ts
npm run _typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add src/github/pull-request.ts src/github/association-mutation.ts src/github/adapter-identities.ts \
  src/github/adapter.ts test/github-pull-request.test.ts test/github-association-mutation.test.ts \
  test/github-remote-match.test.ts test/github-adapter.integration.test.ts
git commit -m "refactor: share GitHub association mutation safety"
```

---

## Task 7: Give webhook dispatch a permanent disposition and listener-process drop observability

**Files:**
- Create: `src/github/dispatch-disposition.ts`
- Modify: `src/github/webhook-worker.ts`
- Modify: `src/github/webhook-diagnostic.ts`
- Modify: `src/github/adapter.ts`
- Modify: `src/cli-runner.ts` (diagnostic rendering only)
- Modify: `test/github-webhook-worker.test.ts`
- Modify: `test/github-durable-ingress.test.ts`
- Modify: `test/github-cli-http.test.ts`

**Consumes:** Dispatch result and durable inbox completion/retry.

**Produces:** Permanent reject -> complete; transient throw -> retry; process-local reason/count emitted only after durable completion.

- [ ] **Step 1: Write failing worker tests** for exact result vocabulary:

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

Permanent result calls `complete`, not `retry`. Thrown transient failure still calls `retry`.

- [ ] **Step 2: Test completion/counter ordering.** Permanent dispatch + failed `complete()` must not increment the counter. A later successful completion increments exactly once.

- [ ] **Step 3: Define the counter reader.** Adapter owns `permanentRepositoryDropsSinceStart`, saturating at `Number.MAX_SAFE_INTEGER`. After successful durable completion of a permanently rejected repo delivery, increment and emit a bounded reason-coded diagnostic through the existing listener-process `onWebhookDiagnostic` callback. This callback is the reader. Do not persist the counter or expose it via `doctor`.

- [ ] **Step 4: Write safe CLI diagnostic rendering tests.** Output contains only sanitized code/reason/delivery/event/attempt/count, not arbitrary cause/secret text.

- [ ] **Step 5: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-webhook-worker.test.ts test/github-durable-ingress.test.ts test/github-cli-http.test.ts
```

- [ ] **Step 6: Implement background and synchronous completion plumbing** with the same result type. Emit permanent-drop diagnostics only after `complete()` succeeds. Completion failure follows current recovery/retry semantics.

- [ ] **Step 7: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-webhook-worker.test.ts test/github-durable-ingress.test.ts test/github-cli-http.test.ts
npm run _typecheck
```

- [ ] **Step 8: Commit.**

```bash
git add src/github/dispatch-disposition.ts src/github/webhook-worker.ts src/github/webhook-diagnostic.ts \
  src/github/adapter.ts src/cli-runner.ts test/github-webhook-worker.test.ts \
  test/github-durable-ingress.test.ts test/github-cli-http.test.ts
git commit -m "feat: consume permanent GitHub identity rejections"
```

---

## Task 8: Move the adapter to stable routing/reconciliation and split mixed revocation fan-out

**Files:**
- Modify: `src/github/adapter.ts`
- Modify: `test/github-adapter.integration.test.ts`
- Modify: `test/github-suspend-reconcile.test.ts`
- Modify: `test/issue28-github-reconciliation.test.ts`
- Modify: `test/github-concurrency.test.ts`

**Consumes:** Stable events/index/guards, token provider, canonical lookup, PR snapshot, shared mutation helper, stable journal kind, dispatch disposition.

**Produces:** Stable ID routing/locking, live rename reconciliation, and explicit stable-vs-legacy `installation.deleted`/removal fan-out.

- [ ] **Step 1: Update ordinary fixtures first** with stable repo ID and complete live PR base/head objects; retain ID-less fixtures only where historical behavior is under test.

- [ ] **Step 2: Write failing rename tests.** Same ID/new name resolves existing run; old-name replay same ID cannot roll name back; same text/different ID permanently rejects with zero authority increase; manual publication reconciles canonical name first; stale old `workspace.remote` does not invalidate an already stable association; stale old remote cannot first-associate automatically.

- [ ] **Step 3: Write failing stable fence tests.** Exact stable sequence:

```text
repository-identity(repositoryId)
  -> publication/association-identity(repositoryId#pr)
    -> run target mutation fence(runId)
      -> global association transaction / check-create
```

No global association transaction may acquire a run target fence from inside the transaction.

- [ ] **Step 4: Write mixed `installation.deleted` tests (round-3 clarification).** Seed stable and legacy ID-less records under one installation. Shared fan-out classifies first:
  - stable -> repository-ID fence -> PR fence -> run fence -> global association transaction;
  - legacy -> run fence -> global association transaction, re-proving ID absent + same installation/name; no name-keyed or ID-keyed repository fence.

A failure on one record does not skip later records; aggregate after all attempts. Non-ENOENT run-load errors propagate. If an index record points to a truly missing run, only authority-reducing index suspension may be reconciled under the global association transaction; never invent a run or ID.

- [ ] **Step 5: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-adapter.integration.test.ts test/github-suspend-reconcile.test.ts \
  test/issue28-github-reconciliation.test.ts test/github-concurrency.test.ts
```

- [ ] **Step 6: Change adapter token provider** to `GitHubRepositoryTokenProvider`; all repository authorization uses stable ID.

- [ ] **Step 7: Implement canonical reconciliation.** Under stable repository fence: allowlist ID -> metadata token -> canonical lookup -> shared run/index name refresh -> reload/re-prove -> route API by reconciled name.

- [ ] **Step 8: Replace current PR read** with `readGitHubPullRequestSnapshot()` and require `snapshot.baseRepositoryId === repositoryId`. Preserve stale/out-of-order lifecycle logic and #28 behavior.

- [ ] **Step 9: Refactor suspension fan-out** into `suspendStableAssociation()` and `suspendLegacyAssociation()` with the exact lock orders above and shared mutation helper. New ID-bearing repository removal selects stable records by ID; historical ID-less removal selects only unresolved legacy records by exact installation/name.

- [ ] **Step 10: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-adapter.integration.test.ts test/github-suspend-reconcile.test.ts \
  test/issue28-github-reconciliation.test.ts test/github-concurrency.test.ts
npm run _typecheck
```

- [ ] **Step 11: Commit.**

```bash
git add src/github/adapter.ts test/github-adapter.integration.test.ts test/github-suspend-reconcile.test.ts \
  test/issue28-github-reconciliation.test.ts test/github-concurrency.test.ts
git commit -m "feat: route GitHub operations by stable repository id"
```

---

## Task 9: Make check ownership stable across rename and verify legacy production aliases

**Files:**
- Modify: `src/github/checks.ts`
- Create: `src/github/check-identity-migration.ts`
- Modify: `test/github-checks.test.ts`
- Create: `test/github-check-identity-migration.test.ts`
- Modify: `test/github-concurrency.test.ts`

**Consumes:** Stable ID, canonical route name, PR/head/check identity, existing side-effect store.

**Produces:** Stable check key and one-time authenticated legacy production attempt-1 aliasing. `GitHubSideEffectStore` persisted shape remains unchanged.

- [ ] **Step 1: Write failing stable-key tests.**

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

`CheckPublisher` receives `repositoryId`; owner/repo is REST routing only.

- [ ] **Step 2: Write failing alias tests** for:

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

If old local record exists, authenticated GET verifies exact check name/head/legacy external ID before stable key -> same resource ID is written. If local record is absent, list exact head/name and require a unique legacy external-ID match. Multiple matches conflict; no match produces no alias; old record stays untouched.

- [ ] **Step 3: Prove production attempt scope.** Source/constructor regression verifies the sole production adapter construction does not pass an `attempt`, so production remains default 1. Explicit non-1 test seams remain non-migration authority.

- [ ] **Step 4: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-checks.test.ts test/github-check-identity-migration.test.ts test/github-concurrency.test.ts
```

- [ ] **Step 5: Implement stable keying and alias helper** using existing side-effect `get`/`put` and stable check-create lock. Outcome-unknown alias write is re-read; continue only when the stable key maps to the intended resource ID.

- [ ] **Step 6: Run GREEN/typecheck.**

```bash
node --experimental-strip-types --test \
  test/github-checks.test.ts test/github-check-identity-migration.test.ts test/github-concurrency.test.ts
npm run _typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add src/github/checks.ts src/github/check-identity-migration.ts \
  test/github-checks.test.ts test/github-check-identity-migration.test.ts test/github-concurrency.test.ts
git commit -m "feat: stabilize GitHub check ownership across renames"
```

---

## Task 10: Implement the restartable repository-identity migration store/service

**Files:**
- Create: `src/github/repository-identity-migration-store.ts`
- Create: `src/github/repository-identity-migration.ts`
- Create: `test/github-repository-identity-migration.test.ts`
- Create: `test/github-repository-identity-migration-crash.test.ts`

**Consumes:** Quiescent legacy state, stable config, old-lock inspection, canonical lookup, PR proof, association APIs, shared mutation helper, #28 revalidation, check alias helper.

**Produces:** Exact checkpoint, union candidate universe, stable run/index state, current canonical metadata, correct stale-head revalidation and check aliases.

- [ ] **Step 1: Write checkpoint-store tests.** Exact record:

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

Path: `.maswe/github/repository-identity-migrations/<sha256(repositoryId + "\0" + legacyRepository)>.json`. Use bounded no-follow reads/durable atomic writes/exact fields. Symlink/oversize/malformed state fails.

- [ ] **Step 2: Write happy-path service tests** for concrete constructor:

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

  migrate(input: { legacyRepository: string; repositoryId: number }): Promise<RepositoryIdentityMigrationResult>;
}
```

Prove legacy run/index -> same stable ID/current canonical name; rerun no-op; same normalized selector/different ID conflict with zero mutation.

- [ ] **Step 3: Write union restart tests.** Candidate universe each pass is unresolved legacy-by-normalized-name **union** stable-by-target-ID. Re-derive distinct installation IDs from that union. A partially migrated run remains visible after restart.

- [ ] **Step 4: Write proof/lifecycle tests.** Every installation must prove the ID via canonical lookup; every PR must report `base.repo.id === repositoryId`. Closed PR applies closure suspension. Same ID can reconcile to another newer canonical name during restart.

- [ ] **Step 5: Write stale-head tests with exact lock sequence.** Under outer repository-ID + PR fence:
  1. acquire run target fence + global association transaction;
  2. migrate stable identity/update `run.github.headSha` and pending cancellation intent through `saveGitHubAssociationMutation()`;
  3. release global association transaction/run fence;
  4. if live head differs from workflow target, call existing `RevalidationService.route()` while still under repository/PR fences so it may acquire the run target fence in the correct order;
  5. only after revalidation state is durable, alias/check ownership work may continue.

Unchanged head preserves valid evidence. Changed head cannot silently reuse old evidence.

- [ ] **Step 6: Write crash/outcome-unknown tests** using exact `afterStep` names:

```ts
type RepositoryIdentityMigrationStep =
  | "checkpoint-started"
  | "association-published"
  | "revalidation-routed"
  | "check-aliases-published"
  | "before-complete"
  | "complete";
```

Inject failure before checkpoint, after checkpoint, after run publication before index commit via store/index seams, after index before checkpoint refresh, during check alias, before complete; separately inject run/index/checkpoint/side-effect outcome unknown. Restart either proves exact intended state and continues or fails on a concrete conflict.

- [ ] **Step 7: Write old-lock preflight tests.** For every affected legacy PR inspect old `publication` and `association-identity` logical keys. `live`, `malformed`, or `ambiguous` blocks migration before run/index mutation. `dead`/`absent` follows documented recovery policy. Inspection never claims operator quiescence; quiescence remains a CLI/operator precondition.

- [ ] **Step 8: Run RED.**

```bash
node --experimental-strip-types --test \
  test/github-repository-identity-migration.test.ts test/github-repository-identity-migration-crash.test.ts
```

- [ ] **Step 9: Implement store/service.** Acquire `repository-identity(repositoryId)` once for the migration pass. Per PR acquire stable PR fence, then run/global association as required. Use shared mutation module, canonical/PR proof, `RevalidationService.route()` only after releasing the previous run/global transaction, check alias helper, outcome-unknown re-reads, and final full union rescan before checkpoint `complete`.

- [ ] **Step 10: Run GREEN plus adjacent recovery suites.**

```bash
node --experimental-strip-types --test \
  test/github-repository-identity-migration.test.ts test/github-repository-identity-migration-crash.test.ts \
  test/issue28-github-reconciliation.test.ts test/github-suspend-reconcile.test.ts \
  test/github-authoritative-state.test.ts
npm run _typecheck
```

- [ ] **Step 11: Commit.**

```bash
git add src/github/repository-identity-migration-store.ts src/github/repository-identity-migration.ts \
  test/github-repository-identity-migration.test.ts test/github-repository-identity-migration-crash.test.ts \
  test/issue28-github-reconciliation.test.ts test/github-suspend-reconcile.test.ts \
  test/github-authoritative-state.test.ts
git commit -m "feat: migrate legacy GitHub repository identity safely"
```

---

## Task 11: Add migration CLI, enforce cutover, synchronize docs, and gate Issue #3

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
- GitHub metadata: update Issue #3 after local code/docs are green.

**Consumes:** Migration service and listener/manual publisher entrypoints.

**Produces:** Operator migration command, enforceable stable-ID listener gate, documented cutover/redelivery procedure, explicit #3 entry gate.

- [ ] **Step 1: Write failing parser tests** for:

```text
maswe github-migrate-repository --from <legacy-owner/repo> --repository-id <positive-safe-integer> [--json]
```

Add exact single-value options `from`, `repository-id`; reject missing/duplicate/invalid names/IDs/extra positionals. Normalize `Owner/Repo` to lowercase before service call.

- [ ] **Step 2: Write failing command tests.** Migration requires GitHub credentials + live stable allowlist, invokes migration service, never starts listener, emits deterministic JSON/text result.

- [ ] **Step 3: Write failing listener cutover tests.** `github-webhook` rejects before listener readiness if `allowedRepositoryIds` is empty. Supported cutover configures IDs and completes migration before listener start. Process-local permanent-drop defense remains for embedded/direct misuse only.

- [ ] **Step 4: Update CLI token factory** to `GitHubRepositoryTokenProvider`; token, repository lookup, PR read, and checks all share current bounded `GitHubHttpClient`.

- [ ] **Step 5: Run RED.**

```bash
node --experimental-strip-types --test test/github-identity-cli.test.ts test/github-cli-http.test.ts
```

- [ ] **Step 6: Implement command/cutover guard and run GREEN/typecheck.**

```bash
node --experimental-strip-types --test test/github-identity-cli.test.ts test/github-cli-http.test.ts
npm run _typecheck
```

- [ ] **Step 7: Synchronize active docs.** Exact cutover:
  1. stop all pre-#34 webhook/manual publishers;
  2. configure approved `allowedRepositoryIds`;
  3. run old-journal preflight through migration;
  4. finish required migrations;
  5. start #34 listener/manual publisher;
  6. inspect GitHub App delivery history for transport failures during outage and explicitly redeliver them.

Also document 10,000-row traversal-limit response (narrow installation scope), unsupported downgrade, stable/legacy lock orders, token purposes, permanent-drop diagnostic semantics, check-key aliasing, and no redirect-based identity.

- [ ] **Step 8: Run drift searches and inspect every hit.**

```bash
git grep -n "allowedRepositories" -- src schemas docs test
git grep -n "repositoryId" -- src/github src/domain.ts src/store.ts schemas test
git grep -n "new CheckPublisher" -- src
git grep -n "withGitHubJournal.*publication\|withGitHubJournal.*association-identity" -- src/github
```

Expected: no operational authorization/stable lock is name-keyed; sole production `CheckPublisher` construction has no non-1 attempt override.

- [ ] **Step 9: Update Issue #3 through GitHub.** Add entry gate:

```markdown
- [ ] #34 stable repository identity is completed, independently validated, merged, and post-merge `main` is revalidated before Phase B obtains GitHub write authority.
```

Update status prose so #27 is not the only blocker; do not alter B1-B4 scope.

- [ ] **Step 10: Run focused docs/CLI/typecheck/diff validation.**

```bash
node --experimental-strip-types --test test/github-identity-cli.test.ts test/github-cli-http.test.ts
npm run _typecheck
git diff --check
```

- [ ] **Step 11: Commit code/docs.**

```bash
git add src/cli-args.ts src/cli-runner.ts test/github-identity-cli.test.ts test/github-cli-http.test.ts \
  docs/GITHUB_APP.md docs/OPERATIONS.md docs/SECURITY.md docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: operationalize stable GitHub repository identity"
```

Record Issue #3 mutation URL/ID in the implementation report; it is external metadata, not Git history.

---

## Task 12: Full regression, exact supported-baseline validation, independent review, and governed merge

**Files:**
- Modify only for a concrete #34 defect exposed by validation/review; no new feature scope.
- GitHub: implementation PR, #34 completion evidence, #3 gate already updated.

**Consumes:** Complete implementation branch.

**Produces:** Fresh exact-head evidence suitable for owner merge decision.

- [ ] **Step 1: Exact Node 24.18.0 validation from clean dependencies.**

```bash
nvm use 24.18.0
node --version
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:dry
git diff --check
```

Expected: `v24.18.0`; all commands exit 0.

- [ ] **Step 2: Exact Node 22.22.2 compatibility validation.**

```bash
nvm use 22.22.2
node --version
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:dry
git diff --check
```

Expected: `v22.22.2`; all commands exit 0.

- [ ] **Step 3: Re-run the focused final-head #34 matrix.**

```bash
node --experimental-strip-types --test \
  test/config.test.ts test/schema.test.ts test/github-pre34-downgrade.test.ts \
  test/github-normalize.test.ts test/github-delivery-inbox.test.ts test/github-token.test.ts \
  test/github-repository-identity.test.ts test/github-pull-request.test.ts \
  test/github-association.test.ts test/github-association-mutation.test.ts test/github-journal.test.ts \
  test/github-webhook-worker.test.ts test/github-adapter.integration.test.ts test/github-suspend-reconcile.test.ts \
  test/github-checks.test.ts test/github-check-identity-migration.test.ts \
  test/github-repository-identity-migration.test.ts test/github-repository-identity-migration-crash.test.ts \
  test/github-identity-cli.test.ts test/issue28-github-reconciliation.test.ts \
  test/github-concurrency.test.ts test/github-authoritative-state.test.ts
```

Expected: all pass.

- [ ] **Step 4: Final invariant audit.** Produce concrete evidence that:
  - every new repo-bearing event contains stable ID;
  - no operational repository authorization uses `allowedRepositories`;
  - token restriction uses `repository_ids` only;
  - live PR ownership uses `base.repo.id`;
  - stable publication/association locks are ID-keyed;
  - legacy ID-less authority reduction uses run fence -> global association transaction only;
  - `installation.deleted` mixed fan-out classifies record type before lock path;
  - no global association transaction acquires a run fence from inside the transaction;
  - permanent worker outcomes complete rather than retry;
  - permanent-drop diagnostic increments only after durable completion;
  - stable check keys use ID and production attempt remains 1;
  - migration restart universe is legacy-by-name union stable-by-ID;
  - no immutable journal/event/history rewrite exists.

- [ ] **Step 5: Open a draft PR against `main`** with exact base/head disclosure, #34 spec/plan links, migration/cutover warning, supported-node evidence, and explicit statement that Phase B write authority remains disabled.

- [ ] **Step 6: Verify exact-head CI.** Require canonical Node 24.18.0, Node 22.22.2 compatibility, and Node 25.9.0 negative jobs to reach their expected terminal-success semantics on the same PR head. Stale CI does not count.

- [ ] **Step 7: Request independent exact-head review/verification** using `superpowers:requesting-code-review`. Every correction creates a new head and requires fresh focused validation and exact-head CI.

- [ ] **Step 8: Resolve or explicitly owner-disposition every substantive review thread.** Reviewer silence is not approval.

- [ ] **Step 9: Invoke `superpowers:verification-before-completion` before every completion/pass claim** and rerun the command that proves the claim.

- [ ] **Step 10: Governed merge/post-merge validation.** Merge only after exact-head CI, independent verification, scope review, and thread resolution. Revalidate `main` CI on the merge commit. Only then close #34 and consider the #3 Phase B stable-identity entry gate satisfied.

---

## Plan Self-Review Checklist

- [ ] Every design section with implementation consequences maps to a task above.
- [ ] Round-3 clarification is explicit: `installation.deleted` classifies mixed stable/legacy associations and routes each to the correct lock branch.
- [ ] Round-3 observability clarification is explicit: the process-local permanent-drop count is read through listener diagnostics after durable completion, never through `doctor`.
- [ ] Shared run/index mutation is a dedicated module; migration does not call private adapter helpers or duplicate rollback rules.
- [ ] Token provider is explicitly `(installationId, repositoryId, purpose)` everywhere.
- [ ] Stable association input/reason types are named and reused.
- [ ] Migration head-drift sequence releases the previous run/global association lock before `RevalidationService.route()` reacquires the run target fence under repository/PR fences.
- [ ] No task introduces Phase B side effects or name/redirect-based authorization.
- [ ] No unresolved implementation markers or unspecified test steps remain.
- [ ] Every implementation task has a RED command, GREEN command, and reviewable commit boundary.
- [ ] Final validation is fresh on exact supported Node baselines and exact GitHub head.
