# Operations guide

## 1. Installation

The active Node runtime must satisfy `>=22.22.2 <23 || >=24.18.0 <25` before normal npm or MASWE execution. Exact Node `24.18.0` from `.nvmrc` is the canonical local/primary-CI baseline; exact Node `22.22.2` is the blocking compatibility floor. NVM is optional and is not a MASWE runtime dependency.

With NVM:

```bash
git clone https://github.com/tomazb/multi-agent-software-engineer.git
cd multi-agent-software-engineer
nvm install
nvm use
npm install
npm run check
npm run build
npm link
```

For an existing checkout created before the repository rename:

```bash
git remote set-url origin git@github.com:tomazb/multi-agent-software-engineer.git
git remote -v
git fetch origin --prune
```

The SSH command assumes GitHub SSH authentication is already configured. To retain HTTPS
transport instead, use:

```bash
git remote set-url origin https://github.com/tomazb/multi-agent-software-engineer.git
git remote -v
git fetch origin --prune
```

Review external CI, Cursor Cloud projects, GitHub App allowlists, webhook deployments, bookmarks,
and scripts that may store the former full repository name. MASWE itself keys GitHub authorization,
association, locking, credential scope, and check ownership on the immutable numeric repository ID;
see "GitHub stable repository identity cutover" below for the required migration. Do not hand-edit
`.maswe` run records, association indexes, or immutable journals.

With another environment manager, select a supported Node binary and run the same npm commands. Normal installation and repository scripts reject unsupported versions through package engines, `engine-strict`, and the dependency-free guard. Direct CLI execution applies the same policy before repository or durable-state actions.

An unsupported runtime fails with `MASWE_UNSUPPORTED_NODE_VERSION` and reports:

- the selected Node version;
- the supported range;
- canonical version `24.18.0`;
- an optional `nvm install 24.18.0 && nvm use 24.18.0` recovery example.

The guard does not install or switch Node. Node 23, Node 25, Node 26+, Node 22 below `22.22.2`, and Node 24 below `24.18.0` are unsupported. A passing exploratory command outside the range is not support evidence.

For each exact-head validation target, capture separately:

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
```

When NVM is used, also capture `nvm current` and `nvm which current`. Do not combine Node 24 canonical and Node 22 compatibility commands into one unlabeled validation record.

Install Cursor CLI according to Cursor's current documentation and authenticate it. Install Superpowers in Cursor:

```text
/add-plugin superpowers
```

The optional SDK runtime additionally requires:

```bash
npm install @cursor/sdk
export CURSOR_API_KEY="cursor_..."
```

The currently implemented runtime kinds are `mock`, `cursor-cli`, and `cursor-sdk`. Claude Code,
Codex CLI, GitHub Copilot CLI, and OpenCode are planned targets under Issues #31 and #32; do not
configure them as runtime kinds before their governed adapters are implemented.

## 2. Initialize a project

From the target repository:

```bash
maswe init
```

This creates `.maswe/config.json`. The directory `.maswe/runs/` is ignored by the starter `.gitignore` in this project, but target repositories should make the same choice explicitly. Some teams may want to commit approved design artifacts while keeping raw model logs private.

The Node guard runs before `init` writes starter configuration. Under an unsupported runtime, no `.maswe` state is created.

## 3. Configure models

List models available to the current Cursor account:

```bash
agent models
```

Update each exact model slug in `.maswe/config.json`. Model names and access can vary by Cursor version, plan, team policy, and provider availability.

Run diagnostics:

```bash
maswe doctor
maswe doctor --cwd /path/to/repo
maswe doctor --json
```

`doctor` probes the Cursor CLI from a MASWE-managed worktree when `trustManagedWorktrees` is enabled (passing `--trust`), then removes that ephemeral worktree **and** its `maswe/doctor-*` branch. Cleanup outcome is reported as a doctor check.

Doctor timeout policy is explicit and fail-closed:

- `policy.doctorProbeTimeoutMs` controls only the stdin prompt-transport invocation deadline.
- Default: `60_000`; hard bounds: integer `1_000..300_000`.
- Invalid explicit values fail at config validation (no clamping).
- The probe timeout is independent of `commandTimeoutMs` and `roleTimeoutMs`.
- Only the probe invocation deadline and promise settlement are bounded. Process-tree termination is best-effort and unobservable, so descendant lifetimes are not strictly bounded. Full `maswe doctor` duration is also unbounded because probe worktree create/cleanup git operations have no timeout.

MASWE stores local lock history under
`.maswe/runs/<run-id>/.lock-journal-v3/`. The `data`, `admin`, and
`admin-recovery` streams contain immutable ticket claims and exact release markers. A queued claim
is not an owner; only the smallest valid unreleased ticket may enter. The journal infrastructure,
published claims, and published releases are permanent and must not be manually pruned.

If the smallest data claim belongs to a dead process, use explicit recovery. MASWE never
auto-reclaims by age:

```bash
maswe unlock <run-id>
maswe unlock <run-id> --force   # explicit assertion that every affected writer is quiescent
```

Without force, a live owner and corrupt/incomplete state are rejected; a valid dead owner is
recoverable. Force can publish an exact release for a live data/admin claim or one stable eligible
corrupt claim only after the operator confirms quiescence. Force is not fencing: it cannot stop a
live process after operator error. Every release targets one exact ticket/digest and leaves later
claims untouched.

If the admin stream is blocked, use:

```bash
maswe unlock-admin <run-id>
maswe unlock-admin <run-id> --force   # only after confirming data/admin actors are quiescent
```

Administrative recovery first publishes a ticket in the separate `admin-recovery` stream. During
forced bootstrap, a contender may exactly release one eligible dead predecessor, but that
publication does not grant recovery ownership. Every contender rescans; only the smallest
unreleased recovery ticket may enter the recovery critical section. A live recovery owner is never
force-released. Corrupt/ambiguous recovery claims remain fail-closed.

Useful semantic failures include `LOCK_LIVE_OWNER`, `LOCK_DEAD_OWNER`, `LOCK_QUEUED`,
`LOCK_CORRUPT`, `LOCK_UNSAFE_PATH_TYPE`, `LOCK_OWNERSHIP_LOST`,
`ADMIN_RECOVERY_CONCURRENT`, `LOCK_CLEANUP_FAILED`, `LOCK_UNSUPPORTED_FILESYSTEM`, and
`LOCK_TICKET_OVERFLOW`. Do not work around them by deleting journal files. Preserve the run
directory and investigate the reported exact path/state.

The journal requires coherent same-host local filesystem semantics, exclusive temporary creation,
and atomic no-clobber hard links. NFS, SMB, distributed FUSE, object-store mounts, cross-host use,
and filesystems without hard links are unsupported. Windows support requires exact-head native
testing on local NTFS; Linux-injected Windows/error cases are not Windows-native coverage. ReFS,
FAT, unsupported reparse layouts, and network shares fail closed.

Each successful lock cycle appends a claim and usually a release. Records are roughly 0.5–1 KiB
but commonly consume a filesystem block each. Ten thousand mutations can consume tens to a few
hundred MiB because data operations also use admin serialization. Issue #11 provides no
compaction. Monitor `.lock-journal-v3` size, but do not archive, compact, or delete it while using
this version.

### Model resolution invariants

Configured role models may use logical names (for example `grok-4.5`).

Fail-closed catalogue discovery and logical→exact resolution apply to runtimes that implement catalogue discovery — currently **`CursorCliRuntime`** (`agent models`).

- **Catalogue trust boundary:** only recognized stdout rows contribute IDs. Supported decorations include `(default)` and `[default]`, spaced dash descriptions, tab columns, and columns aligned with at least two spaces. Headings, aliases, metadata, and ordinary prose are ignored. Any ID-shaped row with an unsupported trailing structure makes the entire discovered catalogue unusable, even when other valid IDs survive. MASWE never resolves from a silently incomplete catalogue.
- **New runs (`start`, Cursor CLI):** logical names are resolved against the complete local catalogue to exact executable IDs. When a configured logical model explicitly includes an effort suffix (`-high` / `-medium` / `-low`), only same-core catalogue IDs with that same effort are eligible; missing effort fails closed. When no effort is specified, preference selects non-fast, then high>medium>low, then `cursor-` prefixed IDs within the same logical family.
- **Weak matches:** one substring-only candidate is an inexact match, not an ambiguity; multiple substring-only candidates are an ambiguity. Both fail closed and carry typed resolution classifications. Control flow does not inspect error-message prose.
- **Authenticated smoke selection:** automatic selection tries the approved families in order and records a family-specific failure before continuing to the next family. A preferred value must be either an exact discovered ID that satisfies the family/effort policy or one literal allowlist family hint. An unresolved literal hint preserves the actionable resolver cause; unrelated logical aliases are rejected.
- **Run snapshot:** `start` stores exact IDs in `run.config`. Environment and project-config mutations after start do not rewrite them.
- **Existing-run stages (`run`, `approve`, `retry`, …):** validate the persisted exact ID against the live complete catalogue and use it as-is. Same-core / same-family / provider / effort-level substitution is forbidden. If the persisted exact ID disappears, execution fails closed naming that ID.
- **Doctor (Cursor CLI):** discovers and validates the complete catalogue first, resolves the brainstormer model with the same project-resolution logic as `start`, then probes with that exact ID. Doctor does **not** create a run and does **not** persist a `run.config` snapshot.
- **`CursorSdkRuntime`:** has no catalogue capability. Doctor/start do not call `agent models`; empty-catalogue pass-through keeps configured IDs as-is. SDK doctor must not be described as resolving through the CLI catalogue.

Treat a Cursor CLI doctor catalogue failure as a reason to inspect `agent models` output format and authentication, not as proof the provider is unavailable and not as permission to select from surviving rows.

Doctor probe cleanup is based on recorded probe identity: once a `doctor-*` probe ID is assigned, final cleanup removes the probe worktree (if present) and `maswe/doctor-*` branch even when worktree creation failed after the branch was created. Cleanup is idempotent; cleanup failures surface as a `doctor-probe-cleanup` check without erasing the original doctor failure.

Doctor checks include typed `code` values in JSON output (`maswe doctor --json`) and keep human output unchanged:

- Human mode: `PASS|FAIL <name>: <message>`
- JSON mode: full `RuntimeDoctorResult` object (`ok`, `checks[]` with `name`, `ok`, `message`, `code`, and optional `prerequisite`)
- Both modes set exit code from `report.ok`.

Emitted doctor codes:

- `ok`
- `cursor-executable-unavailable`
- `cursor-version-check-failure`
- `catalogue-discovery-failure`
- `model-resolution-failure`
- `skipped-prerequisite-failure` (`prerequisite` is one of `cursor-cli`, `model-catalogue`, `model-brainstormer`)
- `probe-invocation-failure`
- `probe-transport-timeout`
- `cleanup-failure`
- `doctor-unexpected-error`
- `cursor-sdk-credential-missing`
- `cursor-sdk-unavailable`

Reserved but non-emitted in this release: `auth-failure`, `process-termination-failure`, `probe-malformed-output`, `probe-invalid-terminal-marker`.

Probe success semantics are intentionally narrow: a passing stdin probe means the command started with the configured stdin payload wired to it and exited zero inside `doctorProbeTimeoutMs`. It does not independently prove that the child read or semantically accepted the payload, auth classification, output-shape validity, terminal-marker validity, or descendant termination. Process-tree termination remains best-effort and not observable.

Cursor CLI assistant extraction and terminal markers:

- Pipeline: raw Cursor CLI stdout → try one whole JSON envelope → when the buffer is not one JSON value, scan individual JSON/NDJSON records → select the authoritative string `result` field → validate exactly one bare terminal marker on the final logical line.
- `stream-json`: only terminal records with `type: "result"` contribute assistant output; the last valid terminal result wins.
- `json`: result-bearing objects use `type: "result"` with string `result`, or a typeless object with string `result`. Line-by-line recovery is permitted only for the same authoritative result shapes.
- Text mode: raw stdout (Markdown may contain JSON snippets without triggering structured decoding).
- Structured modes never fall back to validating the raw JSON envelope as logical text. A malformed JSON-looking record fails with `invalid-transport-json`; plain non-JSON output fails with `unsupported-response-shape`; valid JSON events without an authoritative result fail with `missing-logical-output`.
- Exit 0 with no valid assistant result fails closed and returns a `status: "error"` result carrying
  a `RuntimeFailureDiagnostic`; the diagnostic is never treated as successful assistant content.
  The operator-visible codes remain `invalid-transport-json`, `unsupported-response-shape`, and
  `missing-logical-output`. Stderr content is discarded at the runtime boundary; only
  `stderrPresent` is retained.
- A non-zero exit never promotes structured or text stdout to assistant output. It returns a typed
  `cursor-cli-non-zero` or `cursor-cli-timeout` diagnostic with exit code, timeout state, duration,
  requested/configured model, prompt transport, stderr presence, and truncation state where
  applicable. Process-spawn rejection uses `cursor-cli-spawn`.
- Diagnostics normalize unsafe controls, redact, then truncate by Unicode code points. Per-model
  diagnostics are capped at 2,048 code points and the all-model fallback message at 8,192; both
  bounds include `… [truncated]`. If later fallback diagnostics cannot fit, the message reports
  their omitted-attempt count while the configured attempts still execute.
- Before redaction, diagnostic inspection is capped at the output budget plus 4,096 Unicode code points
  and never exceeds 12,288. The lookahead closes recognized assignments/private-key blocks that
  cross the retained output boundary, and an incomplete supported URI authority that reaches the
  inspection boundary is redacted fail-closed. URI userinfo is recognized for `http`, `https`, `ssh`,
  `git`, `git+https`, `git+ssh`, `sftp`, and `ftp` `scheme://` forms; ordinary email and SCP-like
  `user@host:path` text are not treated as URI credentials. URI authorities are scanned once
  forwards, including on larger successful-artifact content; operators should treat benchmark
  evidence as a regression guard rather than a formal proof.
- Authentication-like text can remain useful in the redacted excerpt, but it does not select a
  control-flow classification. Catalogue and doctor errors use the same bounded sanitizer.
- Marker validation rejects quoted examples, embedded tokens, duplicates, conflicts, non-final markers, and content after a marker. Operator-visible messages name the violated contract and logical line number without dumping full model output.
- Authenticated validation for the earlier JSON-marker repair used Cursor CLI `2026.07.23-e383d2b` on Linux. A new exact-head external validation is required after the Thermos blocker repairs; do not infer broader provider or platform coverage.

### GitHub App Phase A operations

When `githubApp.enabled` is true, `readOnlyChecks` must be true and at least one of
`allowedRepositoryIds` or `allowedRepositories` must be non-empty, so a historical name-only
project configuration still loads for offline inspection and migration preparation. A disabled
configuration may retain empty lists.

Only `allowedRepositoryIds` authorizes anything. Every repository-scoped association,
reconciliation, credential mint, workflow mutation, and check publication requires a non-empty live
`allowedRepositoryIds` containing the exact target ID. `allowedRepositories` survives solely to
load historical configuration during migration, to select and diagnose unresolved legacy records,
and to display operator context; a name in that list grants nothing. Obtain each ID once with an
authenticated request such as `gh api repos/<owner>/<repo> --jq .id`.

`maswe github-webhook` refuses to reach listener readiness while `allowedRepositoryIds` is empty.
It then probes all required journals, enumerates every exact retained legacy
per-check lock, migrates the legacy flat delivery directory,
recovers interrupted queue leases, and starts one worker before the listener becomes ready.
`maswe github-publish-checks <run-id>` probes association, check-create, and per-PR publication
journals before token or API work, but it does not scan or reclaim the listener's inbox. Each
journal contains `format.json` plus `data`, `admin`, and `admin-recovery` streams with immutable
`claims`, `releases`, and `tmp` records. Do not prune them.

Listener readiness also requires the configured webhook secret, App ID, and private-key
environment variables to be present. Only presence is checked; credential values and configured
environment-variable names are not persisted or written to diagnostics.

The listener defaults to loopback. An explicit `0.0.0.0` or `::` binding is an operator opt-in and
must sit behind a TLS-terminating reverse proxy plus network admission controls. Keep signature
verification mandatory even if the proxy restricts GitHub source ranges. Configure the proxy and
firewall with a one MiB body ceiling, bounded connection/rate concurrency, header and body-idle
timeouts, and an end-to-end request timeout that allows the app's eight-second ingress deadline to
return before GitHub's ten-second cutoff. Do not trust forwarded identity or authorization headers.

Run exactly one webhook listener/worker plus simultaneous manual publishers on one host and one
coherent local filesystem with atomic no-clobber hard links. This is not a distributed queue. NFS,
SMB, distributed FUSE, object-store mounts, cross-host use, a second listener, and filesystems
without hard-link support are unsupported. Before upgrading legacy locks or flat delivery state,
stop every old webhook server and manual publisher and back up the complete `.maswe/github/` tree.
Start one new listener; it retains digest-bound legacy evidence. Mixed old/new execution is
unsupported.

Webhook response semantics are operationally significant:

- completed duplicates and intentionally unsupported events/actions return 200;
- a same-ID/body queued or processing duplicate returns 202; a different body/event for the same
  ID returns 409;
- malformed headers/body return 400, forged signatures return 401, and oversized bodies return
  413;
- durable handoff/storage failure returns 503. GitHub does not guarantee automatic redelivery, so
  alert on this response and use operator-initiated webhook redelivery if necessary;
- other handler failures return a generic 500 body while details are emitted only to local
  diagnostics.

The 202 response is sent only after exact-byte HMAC verification, strict UTF-8/JSON normalization,
and file-plus-directory sync of the normalized envelope and queue marker. It does not wait for
live-head or Checks API calls. The persisted envelope contains the normalized event, event name,
delivery ID, receive time, raw-body SHA-256, and queue lease fields only—never raw request bytes,
signatures, headers, tokens, secrets, keys, or arbitrary error text.

One sub-ten-second deadline covers body receipt through durable handoff. A body timeout destroys
the incomplete request and reports that handoff never started. Once handoff starts, a deadline
returns 503 with an outcome-unknown diagnostic while the local filesystem operation finishes;
same-delivery replay reconciles either result without duplicate dispatch.

Every production GitHub HTTP request has a 30-second default deadline, including installation
token, live-head, Checks API, webhook-triggered, and manual-publication calls. Rate-limit retries
remain bounded and do not create an indefinite request. Check reconciliation uses the full digest
of repository/PR/head/name/attempt and visits bounded `filter=all`, 100-item pages before creating
a replacement.

Normal delivery lookup is hash-addressed beneath `inbox/state/<prefix>/<digest>/`; pending markers
are under `inbox/queue/<prefix>/`. Startup alone scans/migrates legacy `deliveries/` files into
`inbox/legacy/<prefix>/<digest>/`. A version-1 completed delivery becomes a terminal legacy
tombstone. A version-1 processing record has no persisted normalized event and therefore becomes
`awaiting-redelivery`; request redelivery rather than fabricating a payload.

The single worker holds one exact 30-second lease, heartbeats every five seconds, and retries with
exponential backoff from 250 ms capped at 30 seconds. An embedding stop waits up to five seconds by
default; interruption leaves the lease durable for pre-listener startup recovery. Manual
`github-publish-checks` republishes one run's checks and is not a queue repair command.

Retain completed tombstones, side-effect records, migrated legacy evidence, and immutable journals
for the lifetime of the active integration. No active-state pruning is supported because signed
webhooks have no replay-expiry field. Monitor filesystem bytes/inodes, queue depth, oldest queued
receive time, retry diagnostics, and journal growth; stop ingress before capacity exhaustion.
After the new listener acknowledges traffic, rollback to an old binary or restoration of the
pre-upgrade backup can strand accepted work. Stop traffic and roll forward with the complete state
tree. Archive the whole tree only after permanent endpoint disablement and webhook-secret
rotation/revocation.

### GitHub journals and lock order

`.maswe/github/journals/` holds one immutable journal per kind. Beyond `association`,
`check-create`, and `delivery`, three kinds are keyed by stable repository identity:

| Kind | Key | Serializes |
|---|---|---|
| `repository-identity` | `<repositoryId>` | Legacy identity migration, canonical-name reconciliation, repository authorization suspension/recovery, repository-scoped publication entry |
| `publication` | `<repositoryId>#<pullRequestNumber>` | Per-PR check publication |
| `association-identity` | `<repositoryId>#<pullRequestNumber>` | Per-PR association identity |

Every stable operational path takes locks in exactly this order:

```text
repository-identity(repositoryId)
  -> publication / association-identity(repositoryId#pullRequestNumber)
    -> run target mutation fence(runId)
      -> global association transaction
```

Authority-reducing removal of an unresolved pre-#34 legacy association (an association with no
`repositoryId`, for example under `installation.deleted`) is the one legacy-only path. It uses the
common suffix only:

```text
run target mutation fence(runId)
  -> global association transaction
```

That branch never acquires a name-keyed publication or association-identity fence and never
invents a repository-ID fence for a record that has no ID. No code path may invert
`association transaction -> run target fence`. Do not prune any journal directory.

### GitHub stable repository identity cutover

Repository authorization, association keys, publication and association-identity fences,
installation-token scope, and check idempotency keys are all derived from the immutable numeric
repository ID. Pre-#34 state is keyed by the mutable `owner/repo` name and must be migrated.

**Migration is required for every repository that holds pre-#34 MASWE GitHub state, not only
repositories that were renamed.** Check ownership is keyed by repository ID, so after the cutover
every pre-#34 check carries a legacy, name-derived external ID that the stable key cannot find. An
operator who migrates only renamed repositories silently duplicates every check run on the first
post-cutover publication of every unmigrated repository.

Run the cutover in exactly this order:

1. Stop every pre-#34 `maswe github-webhook` listener and every manual GitHub publisher. Process
   quiescence of all old binaries is a hard precondition, not merely a lock observation: a pre-#34
   name-keyed lock and a #34 ID-keyed lock are different lock identities and do not exclude each
   other.
2. Install the new binary and put the approved `allowedRepositoryIds` into the live configuration
   **before starting any new listener**.
3. With listeners and manual publishers still stopped, run the migration. It performs a read-only
   legacy-journal ownership preflight and refuses to proceed while a live legacy name-keyed
   publication or association-identity owner is observed.
4. Finish the required migrations for every repository holding pre-#34 state:

   ```bash
   maswe github-migrate-repository --from <legacy-owner/repo> --repository-id <id> [--json]
   ```

   `--from` is a local selector only and never identity proof: it selects unresolved legacy records
   and derives pre-#34 lock and check keys, and it is normalized to lowercase before use. The
   supplied `--repository-id` is the sole identity anchor and is proved live on every invocation.
   The command requires GitHub App credentials and a live allowlist containing the ID, holds the
   `repository-identity` fence, and never starts a listener or worker. It is restartable: rerunning
   it after an interruption resumes from its durable checkpoint.
5. Only after migration completes, start the new `maswe github-webhook` listener and resume manual
   publication.
6. Inspect the GitHub App delivery history for the deliberate listener outage and explicitly
   redeliver every delivery GitHub reports as failed during the maintenance window. MASWE does not
   claim such transport-failed deliveries were durably received.

Suspended pre-#34 legacy associations are deliberately **not** migrated and stay name-keyed
permanently. They are inert: nothing un-suspends them, they never publish, and they carry no
authority. Do not expect them in migration output.

Once migrated state and the new fields are written, downgrade to a pre-#34 binary is unsupported.
Old binaries are expected to fail closed on exact validation rather than silently ignoring stable
identity and resuming name-authoritative behavior. Roll forward with the complete state tree
instead of restoring an older binary.

Migration checkpoints live under `.maswe/github/`. A stray durable `.tmp` residue file left by an
interrupted checkpoint write is skipped rather than treated as fatal. Any *other* unrecognized file
in the checkpoint directory still fails closed, and the error names the exact file: remove exactly
the named file and rerun, and do not clear the directory wholesale.

If a listener was started against name-only configuration in violation of this order, signed
ingress may still be durably accepted, but repository-scoped dispatch receives a permanent
`stable-repository-authorization-required` disposition, cannot mutate authority, and is counted in
the process-local `permanentRepositoryDropsSinceStart` diagnostic counter. That counter saturates
at `Number.MAX_SAFE_INTEGER`, resets on process restart, is never persisted, and is emitted only
through the listener diagnostic callback. A non-zero count means deliveries were permanently
consumed for identity or policy reasons; fix configuration and migration state rather than
redelivering blindly. Correctness never depends on replaying such deliveries: migration and later
manual publication re-read authoritative live repository and PR state.

Canonical-name lookup traverses at most 100 bounded `per_page=100` pages, so an installation with
more than 10,000 repositories reports `traversal-limit-exceeded`. That is an ambiguous failure, not
proof that the repository is absent or that access was revoked. Narrow the installation's
repository scope and retry.

GitHub association publication is event-free and rollback-capable; workflow request and retarget
events publish only after association commit and are never rolled back. If association processing
fails, inspect the authoritative run and association index before redelivery: no request/retarget
event means the association transaction did not durably reach workflow publication. Redeliver the
authenticated webhook or retry normal publication; do not hand-edit the association, evidence, or
event history. If the workflow event is present, treat it as immutable and recover forward from
the recorded generation.

## 4. Configure quality commands

Replace starter commands with commands that are authoritative for the target repository, for example:

```json
{
  "quality": {
    "commands": [
      "pnpm test",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build"
    ]
  }
}
```

Commands execute with the system shell and are trusted code. Only repository administrators should change them. Never derive them from issues, model output, or PR comments.

## 5. Prefer isolated worktrees

By default `policy.useIsolatedWorktree` is `true`. On `start`, MASWE creates branch `maswe/<run-id>` and a linked worktree under an **external** directory (`$TMPDIR/maswe-worktrees/...`), not inside the operator checkout. `.maswe/` is appended via `git rev-parse --git-path info/exclude` so local run storage does not dirty `git status` even when the operator is already inside a linked worktree. Builder and resolver roles execute in that worktree. With `policy.trustManagedWorktrees` (default `true`), Cursor CLI invocations pass `--trust` for every role in MASWE-created worktrees. After a run is durably `COMPLETED`, `CANCELLED`, or ordinary `FAILED`, MASWE removes that run's managed worktree but **preserves** the `maswe/<run-id>` branch ref so failed-run provenance (builder `outputHeadSha`) can be restored on `retry`. Workflow failure and cleanup failure are independent: a terminal workflow state is already durable before deletion begins, and a later cleanup retry cannot change it. `pending` and `failed` cleanup are retryable through `maswe cleanup`. `preserved` cleanup retains governed Issue #28 recovery worktrees and rejects cleanup. There is no `--force` cleanup bypass. Manual `rm -rf`, branch deletion, and global `git worktree prune` are not supported recovery procedures because they skip ownership re-proof and can destroy recovery or provenance state. Cleanup failures are surfaced independently of `run.failure`.

Every production-created run, including a superseding replacement, persists workspace bootstrap
intent before branch or worktree side effects and durably checkpoints the established workspace
before `START`. Bootstrap source-drift checks exclude the orchestrator-owned `.maswe` namespace;
read-only role fingerprints continue to include authoritative `.maswe` state.

To opt out for a trusted checkout:

```json
{
  "policy": {
    "useIsolatedWorktree": false
  }
}
```

Keep the primary workspace clean. Dirty checkouts are rejected unless
`policy.allowDirtyWorkspace` is true. The shared production run-creation boundary applies this
check to both `start` and `supersede` before bootstrap intent, replacement creation, Git metadata
changes, or mutation of the original run.

## 6. Run lifecycle

### Start

```bash
maswe start \
  --title "Add organization audit trail" \
  --request-file docs/requests/organization-audit-trail.md
```

The command returns a run ID and stops at `WAITING_FOR_BRAINSTORM_APPROVAL`.

### Inspect

```bash
maswe status <run-id>
cat .maswe/runs/<run-id>/artifacts/02-brainstorm.md
```

Human and JSON status expose `terminalCleanup` independently from workflow state and
`run.failure`. A legacy terminal record that omits `terminalCleanup` renders as unknown until
reconciled.

### Retry terminal worktree cleanup

```bash
maswe cleanup <run-id>
```

Use this when workflow state is already `COMPLETED`, `CANCELLED`, or ordinary `FAILED` and cleanup
is `pending` or `failed`. The command re-proves exact repository, path, Git registration, branch,
HEAD, and type ownership, then removes only that owned worktree. It appends no workflow events,
changes no workflow evidence, and retains the `maswe/<run-id>` branch. It refuses `preserved`
Issue #28 recovery worktrees. It has no `--force` flag. Do not recover a stuck worktree with
`rm -rf`, branch deletion, or `git worktree prune`.

### Approve discovery

```bash
maswe approve <run-id> brainstorm
```

Inspect the design artifact before the next approval.

### Approve design and execute

```bash
maswe approve <run-id> design
```

The orchestrator automatically advances through build, CI, and verification until it reaches a gate, terminal state, or retry ceiling.

### Signal PR creation

```bash
maswe pr-opened <run-id>
```

### Process a review comment

```bash
maswe review-comment <run-id> --text "Please cover the expired token case."
```

Or preserve the exact comment in a file:

```bash
maswe review-comment <run-id> --file /tmp/review-comment.md
```

In-scope comments pass through resolver, quality, and a fresh verifier, then return to the existing `PR_REVIEW` state. Out-of-scope comments stop at `WAITING_FOR_HUMAN`.

### Resume after human decision

When a human has handled or clarified an out-of-scope comment:

```bash
maswe resume-review <run-id>
```

A future version will allow updating the approved specification through a new approval cycle rather than merely returning to review.

### Complete

```bash
maswe merge-ready <run-id>
maswe complete <run-id>
```

These commands record workflow status only; they do not merge a PR.

Both commands re-read authoritative run state and apply the same exact current-head gate. The run
must have no active revalidation, a known recorded head, the exact recorded branch in a clean
MASWE-managed isolated worktree, matching workspace/GitHub heads when associated, and current
passing quality and verification evidence. These final requirements are unconditional even when
`gates.requireCiPass` or `gates.requireVerifierPass` allowed a failed result to remain nonblocking
before `PR_READY`. `complete` additionally requires current passing merge-ready evidence.
Rejection does not alter state, events, or evidence, and historical passing events do not
substitute for current evidence.

Immediately before each builder, resolver, quality, verifier, merge-ready, or completion result is
published, MASWE rechecks the branch, clean-worktree status, and exact expected head inside the
durable per-run publication fence. A deterministic commit advances its branch only when the ref
still has the exact expected parent. If an operator or another process moved the ref, MASWE does
not reset, clean, force-update, rebase, or discard that work.

## 7. Recovery

### Unsupported Node runtime

Select a runtime inside the supported range and retry the same command. No run migration is required solely because of the runtime policy. A persisted run created earlier cannot resume under an unsupported runtime because the CLI guard executes before loading the run or constructing its runtime.

Do not use `--force` to turn an unsupported runtime into validation evidence. npm's strict-engine behavior is an early convenience layer; the standalone and CLI guards remain authoritative for normal execution.

### Process interrupted

All completed transitions and artifacts are on disk. Re-run:

```bash
maswe status <run-id>
maswe run <run-id>
```

`maswe run` works only for actionable automatic states. Approval and review states require their specific commands.

### Terminal cleanup failure

A workflow failure (`FAILED`, engineering `run.failure`) is not a cleanup failure. Cleanup
lifecycle lives in `terminalCleanup` and is inspected with `maswe status <run-id>`.

- `pending` or `failed`: retry with `maswe cleanup <run-id>`. The retry is idempotent. Success
  publishes `complete` without rewriting workflow state, evidence, artifacts, approvals, counters,
  GitHub association, or engineering failure classification.
- `complete`: already cleaned; a further `maswe cleanup` is an idempotent no-op when the
  registration and path are already absent.
- `preserved`: governed Issue #28 recovery (`bootstrap-recovery`, `revalidation-recovery`, or
  `publication-outcome-unknown`). Cleanup is rejected until that recovery is consumed or the run
  is superseded. Do not delete the worktree by hand.
- omitted on a legacy terminal record: unknown until `maswe cleanup` reconciles it. Ambiguous
  legacy `FAILED` preservation fails closed.

`maswe cleanup` has no `--force`. Production cleanup retains the branch. Manual `rm -rf` of a
managed worktree, deletion of `maswe/<run-id>`, and global `git worktree prune` are not supported
recovery procedures: they skip exact ownership re-proof, can remove another run's or the operator
checkout's tree, and can destroy Issue #28 recovery or failed-run provenance.

For a bootstrap failure whose `failure.resumeState` is `CREATED`, inspect `workspaceBootstrap` and
`workspace` in `run.json` before running `maswe retry <run-id>`. Intent without a workspace means
reconciliation had not checkpointed the side effect; intent plus a workspace means the
branch/worktree checkpoint was durable but `START` was not. Retry reconciles the exact
planned/current facts and publishes the single `START`. An embedding integration recovering a raw
`CREATED` record after abrupt process termination must invoke the public
`Orchestrator.bootstrapCreatedRun(runId)` operation before `runUntilBlocked`; the CLI has no
separate raw-bootstrap recovery command. Do not delete or recreate the recorded branch/worktree to
make recovery pass. A source branch/tree change outside `.maswe` is real drift and must be resolved
explicitly; `.maswe` orchestration state is excluded only from this bootstrap drift comparison.

### Runtime failure

Inspect:

- `run.failure` in `run.json` (includes `resumeState` when recoverable).
- Last transition details.
- The stable aggregate failure code and bounded message.
- Optional `run.failure.runtime`: `attempts` (at most eight), `totalAttempts`,
  `omittedAttempts`, and `aggregateTruncated`. Each stored attempt has a safe model display, stable
  code, a message capped at 512 code points, requested/configured model displays where supplied,
  exit/timeout/duration/transport fields where supplied, `stderrPresent`, and `truncated`.
- Loading or migrating runtime metadata inspects only the first eight raw attempt slots. Invalid
  entries are dropped; the sanitizer does not scan an attacker-sized malformed array looking for
  later valid entries.
- Historical schema-version-1 `failure.message` values may exceed the current 8,192-code-point
  persistence policy. Loading migrates them through the sanitizer; the v1 JSON Schema deliberately
  does not retroactively reject that formerly valid field.
- Human `maswe status` prints the attempt count and structured operational fields. `--json` emits
  the same durable object. Model display values are single-line and delimiter-neutral; they do not
  change the exact model value used for execution.
- Successful runtime-backed events apply the same bounded model-display policy to
  `requestedModel` and `actualModel`; optional agent/run identifiers use their own bounded display
  policy. The runtime still receives and validates the original identifiers.
- The nested runtime attempt and summary objects are schema-closed. Unknown adapter metadata,
  nested raw stderr, and arbitrary summary properties are rejected rather than becoming durable
  contract fields.
- Cursor authentication and model availability.

Raw provider stderr is not available in `run.json`, events, artifacts, retry history, status output,
or a debug file. MASWE intentionally has no persistent raw-stderr channel. Reproduce a failure
directly with the provider CLI only under your organization’s secure debugging procedures; never
paste credential-bearing stderr into run artifacts, logs, issues, or PR comments.

Retry the same run after fixing the cause:

```bash
maswe retry <run-id>
```

Or start a linked replacement that cancels the original when it is still active:

```bash
maswe supersede <run-id>
```

### Quality failure loop

CI failure returns to `BUILDING`. The builder sees the latest quality artifact on the next pass. After `maxBuildVerifyCycles`, the run fails.

### Verifier failure loop

A failed verifier returns to `BUILDING`. The next builder prompt includes the latest deterministic quality and independent verification reports so defects can be addressed directly.

### Current-head revalidation

A newer authenticated or local head retargets an active or recoverable failed revalidation
generation. Evidence from a superseded generation is unusable. Inspect `revalidation.source`,
`requestedHeadSha`, `generation`, and `returnState` in `run.json`; human status shows the same target
as a shortened SHA. Align the recorded managed branch/worktree to the requested head, keep it
clean, then run `maswe run <run-id>` for an active generation or `maswe retry <run-id>` for a
recoverable failed generation. MASWE restarts at deterministic quality and fresh verification and
returns only to the recorded gate. Never copy earlier quality, verification, or merge-ready
evidence into the new generation, and never delete historical request/retarget/failure events.
If an associated head moves after review while the run is in `BUILDING`, `CI_RUNNING`,
`VERIFYING`, or `MERGE_READY` with no active generation, a delivery retry or manual check rerun
creates the missing generation. Durable event history selects `PR_REVIEW` after review entry and
`PR_READY` otherwise. The recovery pass never restores `MERGE_READY`; mark it again only after
current-head quality and verification succeed.

Retarget and final stage publication ownership is retained in
`.maswe/runs/<run-id>/.mutation-journal-v1/.lock-journal-v3/`. Its acquisition order is GitHub
per-PR publication, per-PR association identity, per-run mutation, global association, then run
store. A crashed owner is recovered automatically only when same-host PID probing proves `ESRCH`;
a live owner remains blocking until the bounded acquisition timeout. Claims and releases are
immutable and retained. Do not delete, compact, rename, or hand-repair this journal; corrupt or
uncertain ownership fails closed.

### Read-only violation

The run fails if a read-only role changes fingerprinted workspace state. In Git checkouts that includes git status/diffs/untracked content. In both Git and non-Git working directories it also includes authoritative `.maswe` run records, durable artifacts, and project config under the fingerprinted working directory (Git excludes do not hide that state from the fingerprint). Inspect `git status` (when applicable) and `.maswe/runs/<id>/`, and revert only changes attributable to that role. Preserve unrelated user work. Ephemeral `.lock` / `.admin.lock` / `.admin.lock.recovering` / `*.tmp` churn and validated immutable run/mutation journal records under their exact paths are excluded from the fingerprint by design. The fingerprint is a before/after mutation detector, not an OS sandbox.

## 8. File-store backup and privacy

A complete local backup consists of `.maswe/runs/`. Artifacts can contain proprietary source descriptions, security findings, reviewer comments, and model output. Apply the repository's data classification and retention policy.

Do not commit `.maswe/runs/` by default. If approved designs should be versioned, export selected artifacts into a reviewed documentation directory rather than committing the whole run store.

## 9. CI use

A basic CI job can build and test MASWE itself. Using MASWE to alter a target repository in CI requires:

- Cursor CLI or SDK authentication in the runner.
- A checked-out feature branch.
- Protected secrets.
- Explicit write permissions.
- Deterministic publish steps outside the model.

Do not let a model push or merge directly in production CI. Let it edit the checkout, then use scripted git and GitHub steps after policy gates pass.

MASWE's own blocking CI uses:

1. exact Node `24.18.0` from `.nvmrc` as the canonical baseline, with exact-head verification, binary/version evidence, install, guard, typecheck, focused regressions, contention gates, full tests, build, built-CLI guard seam, and package dry run;
2. exact Node `22.22.2` as the compatibility floor, with exact-head verification, install, guard, full check, focused Node-policy/child-runtime regressions, and package dry run;
3. exact unsupported Node `25.9.0` as a short negative job that succeeds only when normal `npm ci` and the standalone guard reject before dependency installation or substantive validation.

No blocking job uses a floating major or LTS alias. The Node 25 job is rejection evidence, not product-validation evidence. Test-only child-process result capture uses explicit synchronous or unique file-backed channels, and same-runtime Node children use `process.execPath`, avoiding PATH drift without changing production CLI rendering.

The normal constrained-heap sanitizer regression runs an 8,000,000-character one-byte input with a
48 MiB V8 old-space limit, an exact 128-code-point output assertion, and a hard timeout. This
detects the historical full-code-point-array overhead while keeping the initial input feasible on
supported Node 22 releases; it does not establish an absolute process-memory bound.

## 10. Upgrades

Before pulling a new version:

1. Back up `.maswe/runs/` for active projects.
2. Read `CHANGELOG.md` for state, artifact, or runtime-support contract changes.
3. Select a Node runtime inside `>=22.22.2 <23 || >=24.18.0 <25`; for the canonical NVM flow run `nvm install 24.18.0 && nvm use 24.18.0`.
4. Run `npm install` and `npm run check`.
5. Rebuild and re-link the CLI.
6. Run `maswe doctor` in target repositories.

For the v3 lock-journal upgrade:

1. Stop every MASWE process using the target `.maswe/runs/` tree.
2. Back up the tree and inspect legacy `.lock`, `.admin.lock`, and
   `.admin.lock.recovering` objects.
3. Start only the new binary. It represents an existing PR #10 lock as virtual ticket zero and
   publishes a digest-bound compatibility release only through `maswe unlock <run-id> --force`
   or `maswe unlock-admin <run-id> --force`; it never deletes the legacy path. An empty legacy
   `.admin.lock.recovering` directory is bound to stable filesystem identity and fails closed if
   replaced or if that identity is unavailable.
4. Do not run old and new binaries concurrently. Old binaries cannot see v3 claims.

After the first v3 claim, rollback to an old binary is unsupported without a separately designed
quiescent migration/archival operation. Stop and restore the backup rather than deleting claims or
journal directories. There is no general run-schema migration tool in v0.1.
