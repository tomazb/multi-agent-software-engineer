import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import type {
  MasweConfig,
  RunRecord,
  RuntimeRequest,
  RuntimeResult,
  WorkflowEventType,
} from "../src/domain.ts";
import {
  DurableAtomicWriteOutcomeUnknownError,
  writeDurableAtomic,
} from "../src/durable-file.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import {
  GitHubAssociationIndex,
  type StableAssociationBindInput,
} from "../src/github/association.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import { isGitWorkspaceClean } from "../src/git-snapshot.ts";
import { captureWorkspace } from "../src/git-workspace.ts";
import { scanLockJournal } from "../src/lock-journal.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { runMutationJournalRoot } from "../src/run-mutation.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import type { RunStore } from "../src/store.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET = "issue-28-github-reconciliation-secret";
const SECRET_ENV = "MASWE_TEST_ISSUE_28_GITHUB_RECONCILIATION_SECRET";
/** The stable repository id every fixture in this file is scoped to. */
const REPO_ID = 1308655205;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const execFileAsync = promisify(execFile);

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function config(): MasweConfig {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [REPO_ID],
      allowedRepositories: ["owner/repo"],
    },
  });
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

/** Seeds a stable `<repositoryId>#<pr>` association record. */
async function bindStableRecord(
  index: GitHubAssociationIndex,
  input: StableAssociationBindInput,
): Promise<void> {
  await index.withTransaction(async (transaction) => transaction.bindStable(input));
}

/** The live installation-repository listing every stable operation reconciles against. */
function canonicalListingResponse() {
  return {
    status: 200,
    headers: {},
    body: { repositories: [{ id: REPO_ID, full_name: "owner/repo" }] },
  };
}

function prPayload(headSha: string, baseSha = HEAD_A) {
  return {
    action: "synchronize",
    installation: { id: 44 },
    repository: { id: 1308655205, full_name: "owner/repo" },
    pull_request: {
      number: 28,
      head: { sha: headSha, ref: "maswe/issue-28" },
      base: { sha: baseSha },
    },
  };
}

function eventIdentity(run: RunRecord): unknown[] {
  return run.events.map((event) => ({
    id: event.id,
    at: event.at,
    type: event.type,
    actor: event.actor,
    from: event.from,
    to: event.to,
    details: event.details,
  }));
}

async function advanceToPrReview(store: FileRunStore): Promise<RunRecord> {
  const run = await store.create("github reconciliation", "route the latest head", config());
  const transitions: Array<[WorkflowEventType, string]> = [
    ["START", "user"],
    ["BRAINSTORM_COMPLETED", "brainstormer"],
    ["APPROVE_BRAINSTORM", "user"],
    ["DESIGN_COMPLETED", "designer"],
    ["APPROVE_DESIGN", "user"],
    ["BUILD_COMPLETED", "builder"],
    ["CI_PASSED", "quality"],
    ["VERIFY_PASSED", "verifier"],
    ["PR_OPENED", "github-app"],
  ];
  for (const [type, actor] of transitions) await store.applyEvent(run, type, actor);
  run.workspace = {
    remote: "https://github.com/owner/repo.git",
    baseSha: HEAD_A,
    headSha: HEAD_A,
    branch: "maswe/issue-28",
    fingerprint: "fingerprint-a",
  };
  run.github = {
    installationId: 44,
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: HEAD_A,
    headSha: HEAD_A,
    branch: "maswe/issue-28",
    suspended: false,
  };
  run.evidence = {
    quality: { headSha: HEAD_A, passed: true, at: "2026-08-18T10:00:00.000Z" },
    verification: { headSha: HEAD_A, passed: true, at: "2026-08-18T10:01:00.000Z" },
    mergeReady: { headSha: HEAD_A, passed: true, at: "2026-08-18T10:02:00.000Z" },
  };
  await store.save(run);
  return run;
}

function storeWrapper(
  store: FileRunStore,
  overrides: Partial<Pick<RunStore, "save" | "applyEvent">>,
): RunStore {
  return {
    create: store.create.bind(store),
    save: overrides.save ?? store.save.bind(store),
    load: store.load.bind(store),
    list: store.list.bind(store),
    applyEvent: overrides.applyEvent ?? store.applyEvent.bind(store),
    writeArtifact: store.writeArtifact.bind(store),
    readArtifact: store.readArtifact.bind(store),
  };
}

interface AdapterHarness {
  cwd: string;
  store: FileRunStore;
  runId: string;
  adapter: GitHubAppAdapter;
  index: GitHubAssociationIndex;
  posts: Array<Record<string, unknown>>;
  setLiveHead(headSha: string): void;
}

type AssociationRaceState =
  | "PR_READY"
  | "PR_REVIEW"
  | "BUILDING"
  | "CI_RUNNING"
  | "VERIFYING"
  | "RESOLVING"
  | "MERGE_READY";

interface AssociationRaceHarness {
  cwd: string;
  config: MasweConfig;
  store: FileRunStore;
  runId: string;
  headB: string;
  headC: string;
  adapter: GitHubAppAdapter;
}

class HeadRecordingRuntime extends MockRuntime {
  readonly executions: Array<{ role: RuntimeRequest["role"]; headSha: string }> = [];

  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: request.cwd,
    })).stdout.trim();
    this.executions.push({ role: request.role, headSha });
    return super.execute(request);
  }
}

class PausingEditingBuilder extends MockRuntime {
  readonly executions: Array<{ role: RuntimeRequest["role"]; headSha: string }> = [];
  private readonly signalStarted: () => void;
  private readonly resume: Promise<void>;
  private readonly failAfterEdit: boolean;

  constructor(
    signalStarted: () => void,
    resume: Promise<void>,
    options: { failAfterEdit?: boolean } = {},
  ) {
    super();
    this.signalStarted = signalStarted;
    this.resume = resume;
    this.failAfterEdit = options.failAfterEdit ?? false;
  }

  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: request.cwd,
    })).stdout.trim();
    this.executions.push({ role: request.role, headSha });
    if (request.role === "builder") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(
        path.join(request.cwd, "src", "queued-builder.ts"),
        "export const queuedBuilder = true;\n",
        "utf8",
      );
      this.signalStarted();
      await this.resume;
      if (this.failAfterEdit) {
        return {
          status: "error",
          output: "builder failed after editing the workspace",
          requestedModel: request.roleConfig.model,
          actualModel: request.roleConfig.model,
          failure: {
            code: "runtime-error",
            message: "builder failed after editing the workspace",
            requestedModel: request.roleConfig.model,
            stderrPresent: false,
            truncated: false,
          },
        };
      }
    }
    return super.execute(request);
  }
}

class PausingEditingResolver extends MockRuntime {
  readonly executions: Array<{ role: RuntimeRequest["role"]; headSha: string }> = [];
  private readonly signalStarted: () => void;
  private readonly resume: Promise<void>;

  constructor(signalStarted: () => void, resume: Promise<void>) {
    super();
    this.signalStarted = signalStarted;
    this.resume = resume;
  }

  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: request.cwd,
    })).stdout.trim();
    this.executions.push({ role: request.role, headSha });
    if (request.role === "prResolver") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(
        path.join(request.cwd, "src", "queued-resolver.ts"),
        "export const queuedResolver = true;\n",
        "utf8",
      );
      this.signalStarted();
      await this.resume;
    }
    return super.execute(request);
  }
}

async function waitForQueuedTargetClaim(repositoryPath: string, runId: string): Promise<void> {
  const root = runMutationJournalRoot(repositoryPath, runId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const scan = await scanLockJournal(root, "data");
    if (
      scan.claims.some(
        (claim) =>
          claim.operation === "run-target-mutation" &&
          !scan.releases.has(claim.ticket),
      )
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for queued association target claim");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function associationRaceHarness(
  t: test.TestContext,
  state: AssociationRaceState,
  afterAssociationCommitBeforeRouting: (runId: string) => Promise<void>,
): Promise<AssociationRaceHarness> {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-association-race-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "A\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "A"], { cwd });
  await execFileAsync("git", ["branch", "-M", "maswe/issue-28"], { cwd });
  const headA = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await writeFile(path.join(cwd, "tracked.txt"), "B\n", "utf8");
  await execFileAsync("git", ["commit", "-qam", "B"], { cwd });
  const headB = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await execFileAsync("git", ["switch", "-qc", "future-c"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "C\n", "utf8");
  await execFileAsync("git", ["commit", "-qam", "C"], { cwd });
  const headC = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await execFileAsync("git", ["switch", "maswe/issue-28"], { cwd });

  const value = config();
  value.policy.useIsolatedWorktree = false;
  value.quality.commands = [];
  const store = new FileRunStore(cwd);
  let run = await store.create("association race", "route C before local work", value);
  const history = [
    ["START", "user"],
    ["BRAINSTORM_COMPLETED", "brainstormer"],
    ["APPROVE_BRAINSTORM", "user"],
    ["DESIGN_COMPLETED", "designer"],
    ["APPROVE_DESIGN", "user"],
    ["BUILD_COMPLETED", "builder"],
    ["CI_PASSED", "quality"],
    ["VERIFY_PASSED", "verifier"],
  ] as Array<[WorkflowEventType, string]>;
  if (state !== "PR_READY") history.push(["PR_OPENED", "github-app"]);
  for (const [type, actor] of history) {
    run = await store.applyEvent(run, type, actor);
  }
  run.workspace = await captureWorkspace(cwd);
  run.github = {
    installationId: 44,
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: headA,
    headSha: headB,
    branch: "maswe/issue-28",
    suspended: false,
  };
  run.evidence = {
    quality: { headSha: headB, passed: true, at: "2026-08-19T09:00:00.000Z" },
    verification: { headSha: headB, passed: true, at: "2026-08-19T09:01:00.000Z" },
    mergeReady: { headSha: headB, passed: true, at: "2026-08-19T09:02:00.000Z" },
  };
  await store.save(run);

  if (state === "MERGE_READY") {
    run = await store.applyEvent(run, "MARK_MERGE_READY", "user", { headSha: headB });
  } else if (state !== "PR_READY" && state !== "PR_REVIEW") {
    run = await store.applyEvent(run, "REVIEW_COMMENT_RECEIVED", "github");
    run = await store.applyEvent(run, "COMMENT_IN_SCOPE", "pr-comment-classifier");
    if (state !== "RESOLVING") {
      run = await store.applyEvent(run, "RESOLUTION_COMPLETED", "prResolver");
      if (state === "VERIFYING" || state === "BUILDING") {
        run = await store.applyEvent(run, "CI_PASSED", "quality-runner");
      }
      if (state === "BUILDING") {
        run = await store.applyEvent(run, "VERIFY_FAILED", "verifier");
      }
    }
  }
  assert.equal(run.state, state);
  assert.equal(run.revalidation, undefined);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: headA,
    headSha: headB,
    branch: "maswe/issue-28",
  });
  let nextCheckId = 1;
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/installation/repositories")) {
        return canonicalListingResponse();
      }
      if (method === "GET" && url.includes("/pulls/")) {
        return {
          status: 200,
          headers: {},
          body: {
            state: "open",
            head: { sha: headC, ref: "maswe/issue-28" },
            base: {
              sha: HEAD_A,
              ref: "main",
              repo: { id: REPO_ID, full_name: "owner/repo" },
            },
          },
        };
      }
      if (method === "GET" && url.includes("/check-runs")) {
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      return { status: 201, headers: {}, body: { id: nextCheckId++ } };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config: value,
    store,
    http,
    repositoryTokenProvider: async () => "test-token",
    synchronousWebhookDispatch: true,
    afterAssociationCommitBeforeRouting,
  });
  return { cwd, config: value, store, runId: run.id, headB, headC, adapter };
}

async function deliverAssociationRace(
  harness: AssociationRaceHarness,
  deliveryId: string,
): Promise<void> {
  const current = await harness.store.load(harness.runId);
  assert.ok(current.github);
  const rawBody = JSON.stringify(prPayload(harness.headC, current.github.baseSha));
  await harness.adapter.handleWebhook({
    deliveryId,
    eventName: "pull_request",
    signatureHeader: sign(rawBody),
    rawBody,
  });
}

function initialRevalidationPublications(run: RunRecord): number {
  return run.events.filter((event) => event.type === "REVALIDATE_REQUESTED").length;
}

async function adapterHarness(
  t: test.TestContext,
  options: {
    wrapStore?: (store: FileRunStore) => RunStore;
    bindAssociation?: boolean;
    associationWriteRecords?: (filePath: string, content: string) => Promise<void>;
    afterAssociationCommitBeforeRouting?: (runId: string) => Promise<void>;
    afterAssociationValidatedBeforeRouting?: (runId: string) => Promise<void>;
    afterAssociationRoutedBeforeChecks?: (runId: string) => Promise<void>;
    beforeCheckPost?: () => Promise<void>;
  } = {},
): Promise<AdapterHarness> {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-github-reconcile-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await advanceToPrReview(store);
  const githubRoot = path.join(cwd, ".maswe", "github");
  const index = new GitHubAssociationIndex(githubRoot);
  if (options.bindAssociation !== false) {
    await bindStableRecord(index, {
      runId: run.id,
      installationId: 44,
      repositoryId: REPO_ID,
      repository: "owner/repo",
      pullRequestNumber: 28,
      baseSha: HEAD_A,
      headSha: HEAD_A,
      branch: "maswe/issue-28",
    });
  }

  let liveHead = HEAD_A;
  let nextCheckId = 1;
  const posts: Array<Record<string, unknown>> = [];
  const http: GitHubHttpClient = {
    async request(method, url, requestOptions) {
      if (method === "GET" && url.includes("/installation/repositories")) {
        return canonicalListingResponse();
      }
      if (method === "GET" && url.includes("/pulls/")) {
        return {
          status: 200,
          headers: {},
          body: {
            state: "open",
            head: { sha: liveHead, ref: "maswe/issue-28" },
            base: {
              sha: HEAD_A,
              ref: "main",
              repo: { id: REPO_ID, full_name: "owner/repo" },
            },
          },
        };
      }
      if (method === "GET" && url.includes("/check-runs")) {
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      if (method === "POST" && url.includes("/check-runs")) {
        await options.beforeCheckPost?.();
        posts.push(structuredClone(requestOptions?.body as Record<string, unknown>));
        return { status: 201, headers: {}, body: { id: nextCheckId++ } };
      }
      return { status: 200, headers: {}, body: { id: 1 } };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: options.wrapStore?.(store) ?? store,
    http,
    repositoryTokenProvider: async () => "test-token",
    synchronousWebhookDispatch: true,
    ...(options.associationWriteRecords
      ? { associationWriteRecords: options.associationWriteRecords }
      : {}),
    ...(options.afterAssociationCommitBeforeRouting
      ? { afterAssociationCommitBeforeRouting: options.afterAssociationCommitBeforeRouting }
      : {}),
    ...(options.afterAssociationValidatedBeforeRouting
      ? { afterAssociationValidatedBeforeRouting: options.afterAssociationValidatedBeforeRouting }
      : {}),
    ...(options.afterAssociationRoutedBeforeChecks
      ? { afterAssociationRoutedBeforeChecks: options.afterAssociationRoutedBeforeChecks }
      : {}),
  });
  return {
    cwd,
    store,
    runId: run.id,
    adapter,
    index,
    posts,
    setLiveHead(headSha) {
      liveHead = headSha;
    },
  };
}

test("a queued GitHub association supersedes speculative builder publication", async (t) => {
  const associationCommitted = deferred();
  const harness = await associationRaceHarness(t, "BUILDING", async () => {
    associationCommitted.resolve();
  });
  const builderStarted = deferred();
  const resumeBuilder = deferred();
  const runtime = new PausingEditingBuilder(
    () => builderStarted.resolve(),
    resumeBuilder.promise,
  );
  const before = await harness.store.load(harness.runId);
  const localAdvance = new Orchestrator(
    harness.cwd,
    harness.config,
    runtime,
    harness.store,
  ).advance(harness.runId).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  await within(builderStarted.promise, "builder edit before association claim");
  const webhook = deliverAssociationRace(harness, "association-queues-during-builder");
  await waitForQueuedTargetClaim(harness.cwd, harness.runId);
  const beforeRelease = await harness.store.load(harness.runId);
  assert.equal(beforeRelease.github?.headSha, harness.headB);

  resumeBuilder.resolve();
  const localResult = await within(localAdvance, "superseded builder publication");
  assert.ok("error" in localResult);
  assert.match(String(localResult.error), /superseded.*target|target.*superseded/i);
  await within(webhook, "post-builder association routing");
  await within(associationCommitted.promise, "post-builder association commit");

  const authoritative = await harness.store.load(harness.runId);
  const { stdout: actualHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: harness.cwd,
  });
  assert.equal(
    runtime.executions.some(
      (execution) => execution.role === "builder" && execution.headSha === harness.headB,
    ),
    true,
  );
  assert.equal(actualHead.trim(), harness.headB);
  assert.equal(await isGitWorkspaceClean(harness.cwd), true);
  assert.equal(
    authoritative.events.filter((event) => event.type === "BUILD_COMPLETED").length,
    before.events.filter((event) => event.type === "BUILD_COMPLETED").length,
  );
  assert.equal(authoritative.github?.headSha, harness.headC);
  assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
  assert.equal(authoritative.revalidation?.returnState, "PR_REVIEW");
  assert.equal(authoritative.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(authoritative), 1);
});

test("a queued GitHub association supersedes resolver publication and discards B edits", async (t) => {
  const associationCommitted = deferred();
  let associationWasCommitted = false;
  const harness = await associationRaceHarness(t, "RESOLVING", async () => {
    associationWasCommitted = true;
    associationCommitted.resolve();
  });
  const resolverStarted = deferred();
  const resumeResolver = deferred();
  const runtime = new PausingEditingResolver(
    () => resolverStarted.resolve(),
    resumeResolver.promise,
  );
  const before = await harness.store.load(harness.runId);
  const localAdvance = new Orchestrator(
    harness.cwd,
    harness.config,
    runtime,
    harness.store,
  ).advance(harness.runId).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  await within(resolverStarted.promise, "resolver edit before association claim");
  const webhook = deliverAssociationRace(
    harness,
    "association-queues-during-resolver",
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const mutationRoot = runMutationJournalRoot(harness.cwd, harness.runId);
  const claimDeadline = Date.now() + 15_000;
  for (;;) {
    let targetQueued = false;
    try {
      const scan = await scanLockJournal(mutationRoot, "data");
      targetQueued = scan.claims.some(
        (claim) =>
          claim.operation === "run-target-mutation" && !scan.releases.has(claim.ticket),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (associationWasCommitted || targetQueued) break;
    if (Date.now() >= claimDeadline) {
      throw new Error("Timed out waiting for the resolver/association race barrier");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  resumeResolver.resolve();
  const localResult = await within(localAdvance, "superseded resolver publication");
  const webhookResult = await within(webhook, "post-resolver association routing");
  assert.equal(
    webhookResult.ok,
    true,
    `queued association must route after resolver: ${"error" in webhookResult ? String(webhookResult.error) : ""}`,
  );
  await within(associationCommitted.promise, "post-resolver association commit");

  const authoritative = await harness.store.load(harness.runId);
  const { stdout: actualHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: harness.cwd,
  });
  assert.ok("error" in localResult);
  assert.match(String(localResult.error), /superseded.*target|target.*superseded/i);
  assert.equal(
    runtime.executions.some(
      (execution) => execution.role === "prResolver" && execution.headSha === harness.headB,
    ),
    true,
  );
  assert.equal(actualHead.trim(), harness.headB);
  assert.equal(
    await isGitWorkspaceClean(harness.cwd),
    true,
    "superseded resolver edits must not cross the target-ownership handoff",
  );
  assert.equal(
    authoritative.events.filter((event) => event.type === "RESOLUTION_COMPLETED").length,
    before.events.filter((event) => event.type === "RESOLUTION_COMPLETED").length,
  );
  assert.equal(authoritative.github?.headSha, harness.headC);
  assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
  assert.equal(authoritative.revalidation?.returnState, "PR_REVIEW");
  assert.equal(authoritative.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(authoritative), 1);
});

test("a failed builder yields a clean workspace to a queued GitHub association", async (t) => {
  const harness = await associationRaceHarness(t, "BUILDING", async () => undefined);
  const builderStarted = deferred();
  const resumeBuilder = deferred();
  const runtime = new PausingEditingBuilder(
    () => builderStarted.resolve(),
    resumeBuilder.promise,
    { failAfterEdit: true },
  );
  const before = await harness.store.load(harness.runId);
  const localAdvance = new Orchestrator(
    harness.cwd,
    harness.config,
    runtime,
    harness.store,
  ).advance(harness.runId).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  await within(builderStarted.promise, "failed builder edit before association claim");
  const webhook = deliverAssociationRace(
    harness,
    "association-queues-during-failed-builder",
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await waitForQueuedTargetClaim(harness.cwd, harness.runId);
  assert.equal((await harness.store.load(harness.runId)).github?.headSha, harness.headB);

  resumeBuilder.resolve();
  await within(localAdvance, "failed builder handoff");
  const webhookResult = await within(webhook, "post-failure association routing");

  const authoritative = await harness.store.load(harness.runId);
  const { stdout: actualHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: harness.cwd,
  });
  assert.equal(actualHead.trim(), harness.headB);
  assert.equal(
    await isGitWorkspaceClean(harness.cwd),
    true,
    "failed builder edits must not cross the target-ownership handoff",
  );
  assert.equal(webhookResult.ok, true, "queued association must route after builder failure");
  assert.equal(
    authoritative.events.filter((event) => event.type === "BUILD_COMPLETED").length,
    before.events.filter((event) => event.type === "BUILD_COMPLETED").length,
  );
  assert.equal(authoritative.github?.headSha, harness.headC);
  assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
  assert.equal(authoritative.revalidation?.returnState, "PR_REVIEW");
  assert.equal(authoritative.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(authoritative), 1);
});

for (const state of ["CI_RUNNING", "VERIFYING", "BUILDING", "RESOLVING"] as const) {
  test(`local ${state} entry reloads authority after an association commits beyond its initial snapshot`, async (t) => {
    const associationCommitted = deferred();
    const resumeWebhook = deferred();
    const harness = await associationRaceHarness(t, state, async () => {
      associationCommitted.resolve();
      await resumeWebhook.promise;
    });
    const before = await harness.store.load(harness.runId);
    const localSnapshotLoaded = deferred();
    const resumeLocal = deferred();
    let pauseNextLoad = true;
    const localStore: RunStore = {
      create: harness.store.create.bind(harness.store),
      save: harness.store.save.bind(harness.store),
      async load(runId) {
        const snapshot = await harness.store.load(runId);
        if (pauseNextLoad) {
          pauseNextLoad = false;
          localSnapshotLoaded.resolve();
          await resumeLocal.promise;
        }
        return snapshot;
      },
      list: harness.store.list.bind(harness.store),
      applyEvent: harness.store.applyEvent.bind(harness.store),
      writeArtifact: harness.store.writeArtifact.bind(harness.store),
      readArtifact: harness.store.readArtifact.bind(harness.store),
    };
    const runtime = new HeadRecordingRuntime();
    const localAdvance = new Orchestrator(
      harness.cwd,
      harness.config,
      runtime,
      localStore,
    ).advance(harness.runId).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    await within(localSnapshotLoaded.promise, "local B snapshot");
    const webhook = deliverAssociationRace(
      harness,
      `association-commits-after-local-${state.toLowerCase()}-load`,
    );
    await within(associationCommitted.promise, "association C commit");
    resumeLocal.resolve();
    let localOutcome: Awaited<typeof localAdvance>;
    try {
      localOutcome = await within(localAdvance, "local committed-association reconciliation");
    } finally {
      resumeWebhook.resolve();
      await within(webhook, "webhook completion after local reconciliation");
    }

    const authoritative = await harness.store.load(harness.runId);
    assert.equal(
      runtime.executions.some((execution) => execution.headSha === harness.headB),
      false,
      "local work must reload committed association authority before executing on B",
    );
    if ("error" in localOutcome) throw localOutcome.error;
    assert.equal(
      authoritative.artifacts.some((artifact) => artifact.logicalName === "05-quality-report.md"),
      false,
      `${state} must not publish a quality artifact against B`,
    );
    assert.equal(
      authoritative.events.filter((event) => event.type === "CI_PASSED").length,
      before.events.filter((event) => event.type === "CI_PASSED").length,
      `${state} must not publish a quality result against B`,
    );
    assert.equal(authoritative.github?.headSha, harness.headC);
    assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
    assert.equal(authoritative.revalidation?.returnState, "PR_REVIEW");
    assert.equal(authoritative.revalidation?.generation, 1);
    assert.equal(initialRevalidationPublications(authoritative), 1);
  });
}

for (const state of ["CI_RUNNING", "VERIFYING", "BUILDING", "RESOLVING"] as const) {
  test(`local ${state} entry routes a committed C association before stale B work`, async (t) => {
    const associationCommitted = deferred();
    const resumeWebhook = deferred();
    const harness = await associationRaceHarness(t, state, async () => {
      associationCommitted.resolve();
      await resumeWebhook.promise;
    });
    const before = await harness.store.load(harness.runId);
    const runtime = new HeadRecordingRuntime();
    const orchestrator = new Orchestrator(
      harness.cwd,
      harness.config,
      runtime,
      harness.store,
    );
    const webhook = deliverAssociationRace(
      harness,
      `local-${state.toLowerCase()}-association-race`,
    );

    await within(associationCommitted.promise, `${state} association commit`);
    let afterLocal: RunRecord;
    try {
      await within(orchestrator.advance(harness.runId), `${state} local advance`);
      afterLocal = await harness.store.load(harness.runId);
    } finally {
      resumeWebhook.resolve();
      await within(webhook, `${state} webhook completion`);
    }

    assert.equal(
      runtime.executions.some((execution) => execution.headSha === harness.headB),
      false,
      `${state} must not invoke a role against B`,
    );
    assert.equal(
      afterLocal.artifacts.some((artifact) => artifact.logicalName === "05-quality-report.md"),
      false,
      `${state} must not publish a quality artifact against B`,
    );
    assert.equal(
      afterLocal.events.filter((event) => event.type === "CI_PASSED").length,
      before.events.filter((event) => event.type === "CI_PASSED").length,
      `${state} must not publish a quality result against B`,
    );
    assert.equal(afterLocal.github?.headSha, harness.headC);
    assert.equal(afterLocal.revalidation?.requestedHeadSha, harness.headC);
    assert.equal(afterLocal.revalidation?.returnState, "PR_REVIEW");
    assert.equal(afterLocal.revalidation?.generation, 1);
    assert.equal(initialRevalidationPublications(afterLocal), 1);

    const authoritative = await harness.store.load(harness.runId);
    assert.equal(authoritative.github?.headSha, harness.headC);
    assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
    assert.equal(authoritative.revalidation?.generation, 1);
    assert.equal(initialRevalidationPublications(authoritative), 1);
  });
}

test("local advance repairs a committed C association after the webhook process crashes", async (t) => {
  const harness = await associationRaceHarness(t, "BUILDING", async () => {
    throw new Error("simulated webhook crash after association commit");
  });
  await assert.rejects(
    deliverAssociationRace(harness, "crash-before-association-routing"),
    /webhook crash after association commit/,
  );
  const committed = await harness.store.load(harness.runId);
  assert.equal(committed.github?.headSha, harness.headC);
  assert.equal(committed.workspace?.headSha, harness.headB);
  assert.equal(committed.revalidation, undefined);

  const runtime = new HeadRecordingRuntime();
  await new Orchestrator(
    harness.cwd,
    harness.config,
    runtime,
    harness.store,
  ).advance(harness.runId);

  const recovered = await harness.store.load(harness.runId);
  assert.equal(
    runtime.executions.some((execution) => execution.headSha === harness.headB),
    false,
  );
  assert.equal(recovered.github?.headSha, harness.headC);
  assert.equal(recovered.revalidation?.requestedHeadSha, harness.headC);
  assert.equal(recovered.revalidation?.returnState, "PR_REVIEW");
  assert.equal(recovered.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(recovered), 1);
});

for (const state of ["PR_READY", "PR_REVIEW"] as const) {
  test(`local ${state} gate routes a committed C association before local freshness checks`, async (t) => {
    const harness = await associationRaceHarness(t, state, async () => {
      throw new Error("simulated webhook crash before gate routing");
    });
    await assert.rejects(
      deliverAssociationRace(harness, `gate-${state.toLowerCase()}-crash-before-routing`),
      /webhook crash before gate routing/,
    );
    const committed = await harness.store.load(harness.runId);
    assert.equal(committed.state, state);
    assert.equal(committed.github?.headSha, harness.headC);
    assert.equal(committed.workspace?.headSha, harness.headB);
    assert.equal(committed.revalidation, undefined);

    const recovered = await new Orchestrator(
      harness.cwd,
      harness.config,
      new HeadRecordingRuntime(),
      harness.store,
    ).runUntilBlocked(harness.runId);

    assert.equal(recovered.state, "CI_RUNNING");
    assert.equal(recovered.github?.headSha, harness.headC);
    assert.equal(recovered.revalidation?.requestedHeadSha, harness.headC);
    assert.equal(recovered.revalidation?.returnState, state);
    assert.equal(recovered.revalidation?.generation, 1);
    assert.equal(initialRevalidationPublications(recovered), 1);
    assert.equal(recovered.events.some((event) => event.type === "FAIL"), false);
  });
}

for (const state of ["PR_READY", "PR_REVIEW"] as const) {
  test(`local ${state} gate rechecks association authority after an equality snapshot`, async (t) => {
    const harness = await associationRaceHarness(t, state, async () => {
      throw new Error("simulated webhook crash after stale gate load");
    });
    let injectAssociation = true;
    const localStore: RunStore = {
      create: harness.store.create.bind(harness.store),
      save: harness.store.save.bind(harness.store),
      async load(runId) {
        const snapshot = await harness.store.load(runId);
        if (injectAssociation) {
          injectAssociation = false;
          await assert.rejects(
            deliverAssociationRace(
              harness,
              `gate-${state.toLowerCase()}-association-after-equality-load`,
            ),
            /webhook crash after stale gate load/,
          );
        }
        return snapshot;
      },
      list: harness.store.list.bind(harness.store),
      applyEvent: harness.store.applyEvent.bind(harness.store),
      writeArtifact: harness.store.writeArtifact.bind(harness.store),
      readArtifact: harness.store.readArtifact.bind(harness.store),
    };

    const recovered = await new Orchestrator(
      harness.cwd,
      harness.config,
      new HeadRecordingRuntime(),
      localStore,
    ).runUntilBlocked(harness.runId);

    assert.equal(recovered.state, "CI_RUNNING");
    assert.equal(recovered.github?.headSha, harness.headC);
    assert.equal(recovered.revalidation?.requestedHeadSha, harness.headC);
    assert.equal(recovered.revalidation?.returnState, state);
    assert.equal(recovered.revalidation?.generation, 1);
    assert.equal(initialRevalidationPublications(recovered), 1);
    assert.equal(recovered.events.some((event) => event.type === "FAIL"), false);
  });
}

test("return-gate preflight accepts a webhook-won target conflict without duplication", async (t) => {
  const harness = await associationRaceHarness(t, "PR_REVIEW", async () => undefined);
  await execFileAsync("git", ["merge", "--ff-only", "future-c"], { cwd: harness.cwd });
  let loadCount = 0;
  const localStore: RunStore = {
    create: harness.store.create.bind(harness.store),
    save: harness.store.save.bind(harness.store),
    async load(runId) {
      const snapshot = await harness.store.load(runId);
      loadCount += 1;
      if (loadCount === 2) {
        await deliverAssociationRace(harness, "webhook-wins-return-gate-route");
      }
      return snapshot;
    },
    list: harness.store.list.bind(harness.store),
    applyEvent: harness.store.applyEvent.bind(harness.store),
    writeArtifact: harness.store.writeArtifact.bind(harness.store),
    readArtifact: harness.store.readArtifact.bind(harness.store),
  };

  const recovered = await new Orchestrator(
    harness.cwd,
    harness.config,
    new HeadRecordingRuntime(),
    localStore,
  ).runUntilBlocked(harness.runId);
  const authoritative = await harness.store.load(harness.runId);

  assert.equal(recovered.state, "CI_RUNNING");
  assert.equal(authoritative.github?.headSha, harness.headC);
  assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
  assert.equal(authoritative.revalidation?.returnState, "PR_REVIEW");
  assert.equal(authoritative.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(authoritative), 1);
  assert.equal(authoritative.events.some((event) => event.type === "FAIL"), false);
});

test("complete routes a committed C association before stale B merge-ready evidence", async (t) => {
  const harness = await associationRaceHarness(t, "MERGE_READY", async () => {
    throw new Error("simulated webhook crash before merge-ready routing");
  });
  await assert.rejects(
    deliverAssociationRace(harness, "merge-ready-crash-before-routing"),
    /webhook crash before merge-ready routing/,
  );

  await assert.rejects(new Orchestrator(
    harness.cwd,
    harness.config,
    new HeadRecordingRuntime(),
    harness.store,
  ).complete(harness.runId));

  const authoritative = await harness.store.load(harness.runId);
  assert.equal(authoritative.events.some((event) => event.type === "COMPLETE"), false);
  assert.equal(authoritative.evidence, undefined);
  assert.equal(authoritative.github?.headSha, harness.headC);
  assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
  assert.equal(authoritative.revalidation?.returnState, "PR_REVIEW");
  assert.equal(authoritative.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(authoritative), 1);
});

test("local preflight accepts a webhook-won C route without a duplicate generation", async (t) => {
  const associationCommitted = deferred();
  const resumeWebhook = deferred();
  const harness = await associationRaceHarness(t, "VERIFYING", async () => {
    associationCommitted.resolve();
    await resumeWebhook.promise;
  });
  const localSnapshotLoaded = deferred();
  const resumeLocal = deferred();
  let pauseNextLoad = true;
  const localStore: RunStore = {
    create: harness.store.create.bind(harness.store),
    save: harness.store.save.bind(harness.store),
    async load(runId) {
      const snapshot = await harness.store.load(runId);
      if (pauseNextLoad) {
        pauseNextLoad = false;
        localSnapshotLoaded.resolve();
        await resumeLocal.promise;
      }
      return snapshot;
    },
    list: harness.store.list.bind(harness.store),
    applyEvent: harness.store.applyEvent.bind(harness.store),
    writeArtifact: harness.store.writeArtifact.bind(harness.store),
    readArtifact: harness.store.readArtifact.bind(harness.store),
  };
  const runtime = new HeadRecordingRuntime();
  const webhook = deliverAssociationRace(harness, "webhook-wins-local-preflight-race");

  await within(associationCommitted.promise, "inversion association commit");
  const localAdvance = new Orchestrator(
    harness.cwd,
    harness.config,
    runtime,
    localStore,
  ).advance(harness.runId);
  await within(localSnapshotLoaded.promise, "stale local preflight snapshot");
  resumeWebhook.resolve();
  await within(webhook, "webhook-winning C route");
  resumeLocal.resolve();
  await within(localAdvance, "local optimistic-conflict reconciliation");

  const authoritative = await harness.store.load(harness.runId);
  assert.equal(
    runtime.executions.some((execution) => execution.headSha === harness.headB),
    false,
  );
  assert.equal(authoritative.github?.headSha, harness.headC);
  assert.equal(authoritative.revalidation?.requestedHeadSha, harness.headC);
  assert.equal(authoritative.revalidation?.returnState, "PR_REVIEW");
  assert.equal(authoritative.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(authoritative), 1);
});

for (const winnerState of ["FAILED", "PR_REVIEW"] as const) {
  test(`local preflight preserves a webhook-won C route that already reached ${winnerState}`, async (t) => {
    const associationCommitted = deferred();
    const resumeWebhook = deferred();
    const harness = await associationRaceHarness(t, "VERIFYING", async () => {
      associationCommitted.resolve();
      await resumeWebhook.promise;
    });
    const localSnapshotLoaded = deferred();
    const resumeLocal = deferred();
    let pauseNextLoad = true;
    const localStore: RunStore = {
      create: harness.store.create.bind(harness.store),
      save: harness.store.save.bind(harness.store),
      async load(runId) {
        const snapshot = await harness.store.load(runId);
        if (pauseNextLoad) {
          pauseNextLoad = false;
          localSnapshotLoaded.resolve();
          await resumeLocal.promise;
        }
        return snapshot;
      },
      list: harness.store.list.bind(harness.store),
      applyEvent: harness.store.applyEvent.bind(harness.store),
      writeArtifact: harness.store.writeArtifact.bind(harness.store),
      readArtifact: harness.store.readArtifact.bind(harness.store),
    };
    const webhook = deliverAssociationRace(
      harness,
      `webhook-wins-through-${winnerState.toLowerCase()}`,
    );
    await within(associationCommitted.promise, `${winnerState} association commit`);
    const localAdvance = new Orchestrator(
      harness.cwd,
      harness.config,
      new HeadRecordingRuntime(),
      localStore,
    ).advance(harness.runId);
    await within(localSnapshotLoaded.promise, `${winnerState} stale local snapshot`);
    resumeWebhook.resolve();
    await within(webhook, `${winnerState} webhook route`);

    let winner = await harness.store.load(harness.runId);
    if (winnerState === "FAILED") {
      winner.failure = {
        code: "workflow-failure",
        message: "preserve the winning failure",
        at: "2026-08-19T14:00:00.000Z",
        resumeState: "CI_RUNNING",
      };
      winner = await harness.store.applyEvent(winner, "FAIL", "winning-worker", {
        reason: "preserve the winning failure",
        resumeState: "CI_RUNNING",
      });
    } else {
      await execFileAsync("git", ["merge", "--ff-only", "future-c"], { cwd: harness.cwd });
      winner.workspace = await captureWorkspace(harness.cwd);
      winner.evidence = {
        quality: {
          headSha: harness.headC,
          passed: true,
          at: "2026-08-19T14:00:00.000Z",
        },
      };
      winner = await harness.store.applyEvent(winner, "CI_PASSED", "winning-quality", {
        headSha: harness.headC,
        passed: true,
        required: true,
      });
      winner.evidence = {
        ...winner.evidence,
        verification: {
          headSha: harness.headC,
          passed: true,
          at: "2026-08-19T14:01:00.000Z",
        },
      };
      delete winner.revalidation;
      winner = await harness.store.applyEvent(
        winner,
        "VERIFY_PASSED_AFTER_REVIEW",
        "winning-verifier",
        { headSha: harness.headC },
      );
    }
    const expectedWinner = structuredClone(winner);
    resumeLocal.resolve();
    await within(localAdvance, `${winnerState} local adoption`);

    assert.deepEqual(await harness.store.load(harness.runId), expectedWinner);
  });
}

async function deleteInstallation(adapter: GitHubAppAdapter, deliveryId: string): Promise<void> {
  const rawBody = JSON.stringify({ action: "deleted", installation: { id: 44 } });
  const result = await adapter.handleWebhook({
    deliveryId,
    eventName: "installation",
    signatureHeader: sign(rawBody),
    rawBody,
  });
  assert.equal(result.status, 200);
}

async function deliver(harness: AdapterHarness, headSha: string, deliveryId: string): Promise<void> {
  harness.setLiveHead(headSha);
  const rawBody = JSON.stringify(prPayload(headSha));
  await harness.adapter.handleWebhook({
    deliveryId,
    eventName: "pull_request",
    signatureHeader: sign(rawBody),
    rawBody,
  });
}

async function advancePostReviewWithoutRevalidation(
  harness: AdapterHarness,
  state: "CI_RUNNING" | "VERIFYING" | "RESOLVING" | "MERGE_READY",
): Promise<RunRecord> {
  let run = await harness.store.load(harness.runId);
  run.workspace = { ...run.workspace!, headSha: HEAD_B };
  run.github = { ...run.github!, headSha: HEAD_B };
  run.evidence = {
    quality: { headSha: HEAD_B, passed: true, at: "2026-08-19T09:00:00.000Z" },
    verification: { headSha: HEAD_B, passed: true, at: "2026-08-19T09:01:00.000Z" },
    mergeReady: { headSha: HEAD_B, passed: true, at: "2026-08-19T09:02:00.000Z" },
  };
  await harness.store.save(run);
  await bindStableRecord(harness.index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: HEAD_A,
    headSha: HEAD_B,
    branch: "maswe/issue-28",
  });
  run = await harness.store.load(run.id);
  if (state === "MERGE_READY") {
    return harness.store.applyEvent(run, "MARK_MERGE_READY", "user", { headSha: HEAD_B });
  }
  run = await harness.store.applyEvent(run, "REVIEW_COMMENT_RECEIVED", "github");
  run = await harness.store.applyEvent(run, "COMMENT_IN_SCOPE", "pr-comment-classifier");
  if (state === "RESOLVING") return run;
  run = await harness.store.applyEvent(run, "RESOLUTION_COMPLETED", "prResolver");
  if (state === "VERIFYING") {
    run = await harness.store.applyEvent(run, "CI_PASSED", "quality-runner");
  }
  return run;
}

test("manual Phase A preserves index-only authorization suspension before bind", async (t) => {
  const harness = await adapterHarness(t);
  const before = await harness.store.load(harness.runId);
  await harness.index.withTransaction(async (transaction) =>
    transaction.suspendStable(REPO_ID, 28, "authorization-revoked"));

  await assert.rejects(
    harness.adapter.publishChecksForRun(harness.runId),
    /authorization.*revoked|association.*suspended/i,
  );

  assert.deepEqual(await harness.store.load(harness.runId), before);
  const indexed = await harness.index.findStable(REPO_ID, 28);
  assert.equal(indexed?.suspended, true);
  assert.equal(indexed?.suspensionReason, "authorization-revoked");
  assert.equal(harness.posts.length, 0);
});

test("webhook does not mutate a run discovered only after its fenced identity snapshot", async (t) => {
  let listCalls = 0;
  const harness = await adapterHarness(t, {
    bindAssociation: false,
    wrapStore: (store) => ({
      create: store.create.bind(store),
      save: store.save.bind(store),
      load: store.load.bind(store),
      list: async () => {
        listCalls += 1;
        return listCalls === 1 ? [] : store.list();
      },
      applyEvent: store.applyEvent.bind(store),
      writeArtifact: store.writeArtifact.bind(store),
      readArtifact: store.readArtifact.bind(store),
    }),
  });
  const before = await harness.store.load(harness.runId);

  await deliver(harness, HEAD_B, "late-run-after-identity-snapshot");

  assert.deepEqual(await harness.store.load(harness.runId), before);
  assert.equal(await harness.index.findStable(REPO_ID, 28), undefined);
});

test("github association failure matrix never rewrites an already-published workflow event", async (t) => {
  await t.test("run-save failure leaves the authoritative association and events unchanged", async (t) => {
    let failSave = true;
    const harness = await adapterHarness(t, {
      wrapStore: (store) => storeWrapper(store, {
        async save(run) {
          if (failSave && run.github?.headSha === HEAD_B) {
            failSave = false;
            throw new Error("simulated run-save failure");
          }
          await store.save(run);
        },
      }),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(deliver(harness, HEAD_B, "run-save-failure"), /run-save failure/);

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.deepEqual(recovered.github, before.github);
    assert.deepEqual(recovered.evidence, before.evidence);
  });

  await t.test("aggregate run-save outcome unknown never invokes association compensation", async (t) => {
    let rejectAfterPublication = true;
    let compensationSaveAttempts = 0;
    const harness = await adapterHarness(t, {
      wrapStore: (store) => storeWrapper(store, {
        async save(run) {
          if (rejectAfterPublication && run.github?.headSha === HEAD_B) {
            rejectAfterPublication = false;
            await store.save(run);
            const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError(
              "run record",
              new Error("simulated run directory sync failure"),
            );
            const nested = new Error("nested publication failure", { cause: outcomeUnknown });
            const aggregate = new AggregateError(
              [new Error("simulated run lock release failure"), nested],
              "run publication and release failed",
            );
            Object.defineProperty(aggregate, "cause", { value: aggregate });
            throw aggregate;
          }
          compensationSaveAttempts += 1;
          await store.save(run);
        },
      }),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "aggregate-run-save-outcome-unknown"),
      /publication and release failed/,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.equal(compensationSaveAttempts, 0);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.evidence, undefined);
    assert.equal((await harness.index.findStable(REPO_ID, 28))?.headSha, HEAD_A);
  });

  await t.test("known index failure restores only prior association fields", async (t) => {
    const harness = await adapterHarness(t, {
      associationWriteRecords: async () => {
        throw new Error("simulated known index failure");
      },
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(deliver(harness, HEAD_B, "known-index-failure"), /known index failure/);

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.deepEqual(recovered.github, before.github);
    assert.deepEqual(recovered.evidence, before.evidence);
    assert.equal(recovered.state, before.state);
    assert.deepEqual(recovered.revalidation, before.revalidation);
  });

  await t.test("index outcome unknown never rolls back the published association snapshot", async (t) => {
    let failSync = true;
    const harness = await adapterHarness(t, {
      associationWriteRecords: (filePath, content) => writeDurableAtomic(
        filePath,
        content,
        "GitHub association index",
        {
          syncDirectory: async () => {
            if (!failSync) return;
            failSync = false;
            throw new Error("simulated index sync uncertainty");
          },
        },
      ),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "index-outcome-unknown"),
      DurableAtomicWriteOutcomeUnknownError,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.evidence, undefined);
    assert.equal((await harness.index.findStable(REPO_ID, 28))?.headSha, HEAD_B);
  });

  await t.test("stop after association commit preserves the snapshot without routing an event", async (t) => {
    let stop = true;
    const harness = await adapterHarness(t, {
      afterAssociationCommitBeforeRouting: async () => {
        if (!stop) return;
        stop = false;
        throw new Error("simulated stop after association commit");
      },
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "stop-after-association"),
      /stop after association commit/,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.evidence, undefined);
    assert.equal(recovered.revalidation, undefined);

    await harness.adapter.publishChecksForRun(harness.runId);
    const routedAfterRecovery = await harness.store.load(harness.runId);
    assert.deepEqual(
      eventIdentity(routedAfterRecovery).slice(0, before.events.length),
      eventIdentity(before),
    );
    assert.equal(routedAfterRecovery.state, "CI_RUNNING");
    assert.equal(routedAfterRecovery.revalidation?.requestedHeadSha, HEAD_B);
  });

  await t.test("routing-event failure cannot roll back the already-committed association", async (t) => {
    let failRouting = true;
    const harness = await adapterHarness(t, {
      wrapStore: (store) => storeWrapper(store, {
        async applyEvent(run, type, actor, details) {
          const published = await store.applyEvent(run, type, actor, details);
          if (failRouting && type === "REVALIDATE_REQUESTED") {
            failRouting = false;
            throw new Error("simulated routing-event failure after publication");
          }
          return published;
        },
      }),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(deliver(harness, HEAD_B, "routing-event-failure"), /routing-event failure/);

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered).slice(0, before.events.length), eventIdentity(before));
    assert.equal(recovered.events.at(-1)?.type, "REVALIDATE_REQUESTED");
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.revalidation?.requestedHeadSha, HEAD_B);
  });

  await t.test("concurrent event before known rollback is preserved and makes rollback refuse", async (t) => {
    let baseStore: FileRunStore;
    let runId = "";
    const harness = await adapterHarness(t, {
      associationWriteRecords: async () => {
        const concurrent = await baseStore.load(runId);
        await baseStore.applyEvent(concurrent, "MARK_MERGE_READY", "concurrent-user", {
          marker: "must-survive",
        });
        throw new Error("simulated index failure after concurrent event");
      },
    });
    baseStore = harness.store;
    runId = harness.runId;
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "concurrent-event-before-rollback"),
      /changed before association rollback|concurrent event/,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered).slice(0, before.events.length), eventIdentity(before));
    assert.equal(recovered.events.at(-1)?.type, "MARK_MERGE_READY");
    assert.deepEqual(recovered.events.at(-1)?.details, { marker: "must-survive" });
    assert.equal(recovered.github?.headSha, HEAD_B);
  });
});

test("github B then C at zero cycles retargets generation two without publishing B-bound success", async (t) => {
  const harness = await adapterHarness(t);

  await deliver(harness, HEAD_B, "head-b");
  const atB = await harness.store.load(harness.runId);
  assert.equal(atB.state, "CI_RUNNING");
  assert.equal(atB.revalidation?.generation, 1);
  assert.equal(atB.revalidation?.requestedHeadSha, HEAD_B);

  await deliver(harness, HEAD_C, "head-c");
  const atC = await harness.store.load(harness.runId);
  assert.equal(atC.state, "CI_RUNNING");
  assert.equal(atC.counters.buildVerifyCycles, 0);
  assert.equal(atC.revalidation?.returnState, "PR_REVIEW");
  assert.equal(atC.revalidation?.generation, 2);
  assert.equal(atC.revalidation?.requestedHeadSha, HEAD_C);
  assert.deepEqual(
    atC.events.filter((event) => event.type === "REVALIDATION_RETARGETED").map((event) => event.details),
    [{
      previousRequestedHeadSha: HEAD_B,
      requestedHeadSha: HEAD_C,
      generation: 2,
      returnState: "PR_REVIEW",
      source: "github",
    }],
  );
  const bBoundQualityOrVerification = harness.posts.filter((post) =>
    post.head_sha === HEAD_B &&
    (post.name === "MASWE / deterministic quality" ||
      post.name === "MASWE / independent verification"),
  );
  assert.ok(bBoundQualityOrVerification.length >= 2);
  assert.equal(
    bBoundQualityOrVerification.some((post) => post.conclusion === "success"),
    false,
  );
});

test("github A to B crash then B to A starts one same-target evidence recovery", async (t) => {
  let associationCommits = 0;
  const harness = await adapterHarness(t, {
    afterAssociationCommitBeforeRouting: async () => {
      associationCommits += 1;
      if (associationCommits === 1) {
        throw new Error("stop after A to B association commit");
      }
    },
  });

  await assert.rejects(
    deliver(harness, HEAD_B, "head-b-crash-before-routing"),
    /stop after A to B association commit/,
  );
  const atB = await harness.store.load(harness.runId);
  assert.equal(atB.github?.headSha, HEAD_B);
  assert.equal(atB.workspace?.headSha, HEAD_A);
  assert.equal(atB.evidence, undefined);
  assert.equal(atB.revalidation, undefined);
  assert.equal(initialRevalidationPublications(atB), 0);

  await deliver(harness, HEAD_A, "head-a-return-after-crash");

  const recovered = await harness.store.load(harness.runId);
  assert.equal(recovered.state, "CI_RUNNING");
  assert.equal(recovered.github?.headSha, HEAD_A);
  assert.equal(recovered.workspace?.headSha, HEAD_A);
  assert.equal(recovered.revalidation?.originHeadSha, HEAD_A);
  assert.equal(recovered.revalidation?.requestedHeadSha, HEAD_A);
  assert.equal(recovered.revalidation?.returnState, "PR_REVIEW");
  assert.equal(recovered.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(recovered), 1);

  await deliver(harness, HEAD_A, "head-a-same-target-redelivery");
  const redelivered = await harness.store.load(harness.runId);
  assert.equal(redelivered.revalidation?.generation, 1);
  assert.equal(initialRevalidationPublications(redelivered), 1);
  assert.deepEqual(eventIdentity(redelivered), eventIdentity(recovered));
});

test("github equal-target delivery with current gate evidence remains event-free", async (t) => {
  const harness = await adapterHarness(t);
  const before = await harness.store.load(harness.runId);

  await deliver(harness, HEAD_A, "head-a-current-evidence");

  const after = await harness.store.load(harness.runId);
  assert.equal(after.state, "PR_REVIEW");
  assert.equal(after.revalidation, undefined);
  assert.deepEqual(eventIdentity(after), eventIdentity(before));
});

test("github head movement starts post-review recovery without an active revalidation", async (t) => {
  for (const state of ["CI_RUNNING", "VERIFYING", "RESOLVING", "MERGE_READY"] as const) {
    await t.test(state, async (t) => {
      const harness = await adapterHarness(t);
      const before = await advancePostReviewWithoutRevalidation(harness, state);
      assert.equal(before.state, state);
      assert.equal(before.revalidation, undefined);
      assert.equal(before.counters.commentResolutionCycles, 0);

      await deliver(harness, HEAD_C, `head-c-from-${state.toLowerCase()}`);

      const recovered = await harness.store.load(harness.runId);
      assert.equal(recovered.state, "CI_RUNNING");
      assert.equal(recovered.workspace?.headSha, HEAD_B, "GitHub routing must not move local refs");
      assert.equal(recovered.github?.headSha, HEAD_C);
      assert.equal(recovered.revalidation?.returnState, "PR_REVIEW");
      assert.equal(recovered.revalidation?.originHeadSha, HEAD_B);
      assert.equal(recovered.revalidation?.requestedHeadSha, HEAD_C);
      assert.equal(recovered.revalidation?.generation, 1);
      assert.equal(recovered.evidence, undefined);
      assert.equal(
        recovered.events.filter((event) => event.type === "REVALIDATE_REQUESTED").length,
        1,
      );
    });
  }
});

test("association identity fencing has a journal namespace distinct from publication", async (t) => {
  const harness = await adapterHarness(t);
  await harness.adapter.publishChecksForRun(harness.runId);
  const kinds = await readdir(path.join(harness.cwd, ".maswe", "github", "journals"));
  assert.ok(kinds.includes("publication"));
  assert.ok(kinds.includes("association-identity"));
});

test("delivery reruns converge to current head C and revalidation returns to PR_REVIEW", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-github-current-head-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "A\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "A"], { cwd });
  await execFileAsync("git", ["branch", "-M", "maswe/issue-28"], { cwd });
  const headA = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await writeFile(path.join(cwd, "tracked.txt"), "B\n", "utf8");
  await execFileAsync("git", ["commit", "-qam", "B"], { cwd });
  const headB = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await execFileAsync("git", ["switch", "-qc", "future-c"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "C\n", "utf8");
  await execFileAsync("git", ["commit", "-qam", "C"], { cwd });
  const headC = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await execFileAsync("git", ["switch", "maswe/issue-28"], { cwd });

  const value = config();
  value.policy.useIsolatedWorktree = false;
  const store = new FileRunStore(cwd);
  let run = await store.create("current head recovery", "return to review", value);
  for (const [type, actor] of [
    ["START", "user"],
    ["BRAINSTORM_COMPLETED", "brainstormer"],
    ["APPROVE_BRAINSTORM", "user"],
    ["DESIGN_COMPLETED", "designer"],
    ["APPROVE_DESIGN", "user"],
    ["BUILD_COMPLETED", "builder"],
    ["CI_PASSED", "quality"],
    ["VERIFY_PASSED", "verifier"],
    ["PR_OPENED", "github-app"],
    ["REVIEW_COMMENT_RECEIVED", "github"],
    ["COMMENT_IN_SCOPE", "pr-comment-classifier"],
    ["RESOLUTION_COMPLETED", "prResolver"],
  ] as Array<[WorkflowEventType, string]>) {
    run = await store.applyEvent(run, type, actor);
  }
  run.workspace = await captureWorkspace(cwd);
  run.github = {
    installationId: 44,
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: headA,
    headSha: headB,
    branch: "maswe/issue-28",
    suspended: false,
  };
  run.evidence = {
    quality: { headSha: headB, passed: true, at: "2026-08-19T09:00:00.000Z" },
    verification: { headSha: headB, passed: true, at: "2026-08-19T09:01:00.000Z" },
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await bindStableRecord(index, {
    runId: run.id,
    installationId: 44,
    repositoryId: REPO_ID,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: headA,
    headSha: headB,
    branch: "maswe/issue-28",
  });
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/installation/repositories")) {
        return canonicalListingResponse();
      }
      if (method === "GET" && url.includes("/pulls/")) {
        return {
          status: 200,
          headers: {},
          body: {
            state: "open",
            head: { sha: headC, ref: "maswe/issue-28" },
            base: {
              sha: HEAD_A,
              ref: "main",
              repo: { id: REPO_ID, full_name: "owner/repo" },
            },
          },
        };
      }
      if (method === "GET" && url.includes("/check-runs")) {
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      return { status: 201, headers: {}, body: { id: 1 } };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config: value,
    store,
    http,
    repositoryTokenProvider: async () => "test-token",
    synchronousWebhookDispatch: true,
  });

  const body = JSON.stringify(prPayload(headC, headA));
  for (const deliveryId of ["current-head-c-first", "current-head-c-rerun"]) {
    await adapter.handleWebhook({
      deliveryId,
      eventName: "pull_request",
      signatureHeader: sign(body),
      rawBody: body,
    });
  }
  const routed = await store.load(run.id);
  assert.equal(routed.state, "CI_RUNNING");
  assert.equal(routed.revalidation?.requestedHeadSha, headC);
  assert.equal(routed.revalidation?.returnState, "PR_REVIEW");
  assert.equal(routed.revalidation?.generation, 1);
  assert.equal(
    routed.events.filter((event) => event.type === "REVALIDATE_REQUESTED").length,
    1,
  );

  await execFileAsync("git", ["merge", "--ff-only", "future-c"], { cwd });
  const completed = await new Orchestrator(
    cwd,
    value,
    new MockRuntime(),
    store,
  ).runUntilBlocked(run.id);
  assert.equal(completed.state, "PR_REVIEW");
  assert.equal(completed.revalidation, undefined);
  assert.equal(completed.workspace?.headSha, headC);
  assert.equal(completed.evidence?.quality?.headSha, headC);
  assert.equal(completed.evidence?.verification?.headSha, headC);
  assert.equal(completed.counters.commentResolutionCycles, 0);
});

test("post-commit association fence blocks routing when authoritative identity changes", async (t) => {
  for (const mutation of [
    "index suspended before run record",
    "run record suspended before index",
    "active index head diverged",
  ] as const) {
    await t.test(mutation, async (t) => {
      let authoritativeStore: FileRunStore;
      let authoritativeIndex: GitHubAssociationIndex;
      const harness = await adapterHarness(t, {
        afterAssociationCommitBeforeRouting: async (runId) => {
          if (mutation === "index suspended before run record") {
            await authoritativeIndex.withTransaction(async (transaction) =>
              transaction.suspendStable(REPO_ID, 28, "authorization-revoked"));
            return;
          }
          if (mutation === "run record suspended before index") {
            const concurrent = await authoritativeStore.load(runId);
            concurrent.github = {
              ...concurrent.github!,
              suspended: true,
              suspensionReason: "authorization-revoked",
            };
            await authoritativeStore.save(concurrent);
            return;
          }
          const committed = await authoritativeIndex.findStable(REPO_ID, 28);
          assert.ok(committed);
          await bindStableRecord(authoritativeIndex, {
            runId: committed.runId,
            installationId: committed.installationId,
            repositoryId: REPO_ID,
            repository: committed.repository,
            pullRequestNumber: committed.pullRequestNumber,
            baseSha: committed.baseSha,
            headSha: HEAD_C,
            branch: committed.branch,
          });
        },
      });
      authoritativeStore = harness.store;
      authoritativeIndex = harness.index;
      const before = await harness.store.load(harness.runId);

      await assert.rejects(
        deliver(harness, HEAD_B, `association-fence-${mutation.replaceAll(" ", "-")}`),
        /association.*changed|association.*active|routing/i,
      );

      const recovered = await harness.store.load(harness.runId);
      assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
      assert.equal(recovered.state, "PR_REVIEW");
      assert.equal(recovered.revalidation, undefined);
      assert.equal(harness.posts.length, 0);
    });
  }
});

test("installation suspension that wins after association validation publishes no routing event", async (t) => {
  let suspensionAdapter!: GitHubAppAdapter;
  const harness = await adapterHarness(t, {
    afterAssociationValidatedBeforeRouting: async () => {
      await deleteInstallation(
        suspensionAdapter,
        "installation-deleted-after-association-validation",
      );
    },
  });
  suspensionAdapter = new GitHubAppAdapter({
    cwd: harness.cwd,
    config: config(),
    store: harness.store,
    http: { async request() { throw new Error("installation suspension must not call GitHub"); } },
    repositoryTokenProvider: async () => {
      throw new Error("installation suspension must not create a token");
    },
    synchronousWebhookDispatch: true,
  });
  await suspensionAdapter.initialize();
  const before = await harness.store.load(harness.runId);

  await assert.rejects(
    deliver(harness, HEAD_B, "suspension-after-association-validation"),
    /association.*changed|association.*active|routing/i,
  );

  const recovered = await harness.store.load(harness.runId);
  assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
  assert.equal(recovered.github?.suspended, true);
  assert.equal((await harness.index.findStable(REPO_ID, 28))?.suspended, true);
  assert.equal(harness.posts.length, 0);
});

test("installation suspension started after routing cannot publish checks against suspended state", async (t) => {
  let harness!: AdapterHarness;
  let suspensionAdapter!: GitHubAppAdapter;
  let suspension: Promise<void> | undefined;
  let eventHistoryDuringCheckPublication: unknown[] | undefined;
  let staleCheckPosts = 0;
  harness = await adapterHarness(t, {
    afterAssociationRoutedBeforeChecks: async () => {
      suspension = deleteInstallation(
        suspensionAdapter,
        "installation-deleted-after-association-routing",
      );
    },
    beforeCheckPost: async () => {
      const authoritative = await harness.store.load(harness.runId);
      eventHistoryDuringCheckPublication = eventIdentity(authoritative);
      if (authoritative.github?.suspended) staleCheckPosts += 1;
    },
  });
  suspensionAdapter = new GitHubAppAdapter({
    cwd: harness.cwd,
    config: config(),
    store: harness.store,
    http: { async request() { throw new Error("installation suspension must not call GitHub"); } },
    repositoryTokenProvider: async () => {
      throw new Error("installation suspension must not create a token");
    },
    synchronousWebhookDispatch: true,
  });
  await suspensionAdapter.initialize();

  await deliver(harness, HEAD_B, "suspension-after-association-routing");
  assert.ok(suspension, "post-route suspension interleaving was not injected");
  await suspension;

  const recovered = await harness.store.load(harness.runId);
  assert.equal(staleCheckPosts, 0);
  assert.ok(eventHistoryDuringCheckPublication);
  assert.deepEqual(eventIdentity(recovered), eventHistoryDuringCheckPublication);
  assert.equal(recovered.events.at(-1)?.type, "REVALIDATE_REQUESTED");
  assert.equal(recovered.github?.suspended, true);
  assert.equal((await harness.index.findStable(REPO_ID, 28))?.suspended, true);
  assert.ok(harness.posts.length > 0);
});

test("association rollback callbacks run in reverse and aggregate every known-failure callback error", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-known-rollback-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const order: string[] = [];
  const index = new GitHubAssociationIndex(path.join(cwd, "github"));

  let caught: unknown;
  try {
    await index.withTransaction(async (transaction) => {
      transaction.onRollback(async () => {
        order.push("first");
        throw new Error("first rollback failed");
      });
      transaction.onRollback(async () => {
        order.push("second");
        throw new Error("second rollback failed");
      });
      throw new Error("known association failure");
    });
  } catch (error) {
    caught = error;
  }

  assert.deepEqual(order, ["second", "first"]);
  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(
    caught.errors.map((error) => (error as Error).message),
    ["known association failure", "second rollback failed", "first rollback failed"],
  );
});

test("association outcome unknown never invokes registered rollback callbacks", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-unknown-rollback-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError(
    "GitHub association index",
    new Error("simulated directory sync failure"),
  );
  const rollbacks: string[] = [];
  const index = new GitHubAssociationIndex(path.join(cwd, "github"), {
    writeRecords: async () => {
      throw outcomeUnknown;
    },
  });

  await assert.rejects(
    index.withTransaction(async (transaction) => {
      transaction.onRollback(async () => {
        rollbacks.push("must-not-run");
      });
      transaction.bindStable({
        runId: "run-outcome-unknown",
        installationId: 44,
        repositoryId: REPO_ID,
        repository: "owner/repo",
        pullRequestNumber: 28,
        baseSha: HEAD_A,
        headSha: HEAD_B,
        branch: "maswe/issue-28",
      });
    }),
    (error: unknown) => error === outcomeUnknown,
  );
  assert.deepEqual(rollbacks, []);
});

for (const nesting of ["AggregateError.errors", "Error.cause"] as const) {
  test(`association transaction treats nested outcome uncertainty in ${nesting} as non-compensable`, async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-nested-unknown-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError(
      "GitHub association index",
      new Error("simulated directory sync failure"),
    );
    let nested: Error;
    if (nesting === "AggregateError.errors") {
      const aggregate = new AggregateError(
        [new Error("release failed"), outcomeUnknown],
        "association publication and release failed",
      );
      Object.defineProperty(aggregate, "cause", { value: aggregate });
      nested = aggregate;
    } else {
      nested = new Error("association publication wrapper", { cause: outcomeUnknown });
      Object.defineProperty(outcomeUnknown, "cause", { value: nested });
    }
    let rollbackCalls = 0;
    const index = new GitHubAssociationIndex(path.join(cwd, "github"), {
      writeRecords: async () => {
        throw nested;
      },
    });

    await assert.rejects(
      index.withTransaction(async (transaction) => {
        transaction.onRollback(async () => {
          rollbackCalls += 1;
        });
        transaction.bindStable({
          runId: `run-nested-${nesting === "Error.cause" ? "cause" : "aggregate"}`,
          installationId: 44,
          repositoryId: REPO_ID,
          repository: "owner/repo",
          pullRequestNumber: 28,
          baseSha: HEAD_A,
          headSha: HEAD_B,
          branch: "maswe/issue-28",
        });
      }),
      (error: unknown) => error === nested,
    );
    assert.equal(rollbackCalls, 0);
  });
}
