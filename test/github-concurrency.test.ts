import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CheckPublisher, type GitHubHttpClient } from "../src/github/checks.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { inspectLegacyGitHubJournalOwnership } from "../src/github/journal.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { scanLockJournal } from "../src/lock-journal.ts";
import type { RunRecord } from "../src/domain.ts";

const workerPath = fileURLToPath(
  new URL("./fixtures/github-store-worker.ts", import.meta.url),
);
const journalWorkerPath = fileURLToPath(
  new URL("./fixtures/github-journal-worker.ts", import.meta.url),
);
const WATCHDOG_MS = 10_000;

interface WorkerMessage {
  type: "READY" | "COMPLETE" | "ERROR";
  actor: string;
  message?: string;
}

function spawnStoreWorker(
  githubRoot: string,
  barrierPath: string,
  actor: string,
  mode: "association" | "association-stable" | "check-create",
  extraEnv: Record<string, string>,
): { child: ChildProcess; next(type: WorkerMessage["type"]): Promise<WorkerMessage> } {
  const child = fork(workerPath, [], {
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      MASWE_GITHUB_ROOT: githubRoot,
      MASWE_GITHUB_BARRIER_PATH: barrierPath,
      MASWE_GITHUB_ACTOR: actor,
      MASWE_GITHUB_STORE_MODE: mode,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    type: WorkerMessage["type"];
    resolve: (message: WorkerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  child.on("message", (message: WorkerMessage) => {
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index < 0) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter!.timer);
    waiter!.resolve(message);
  });
  child.on("exit", (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`GitHub store worker ${actor} exited ${code ?? signal} before ${waiter.type}`),
      );
    }
  });
  return {
    child,
    next(type) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
      return new Promise<WorkerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`GitHub store worker ${actor} watchdog expired`));
        }, WATCHDOG_MS);
        waiters.push({ type, resolve, reject, timer });
      });
    },
  };
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = WATCHDOG_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`GitHub store worker ${child.pid ?? "unknown"} exit watchdog expired`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function waitForWorkers(workers: ChildProcess[]): Promise<void> {
  for (const child of workers) {
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null });
  }
}

async function terminateWorkers(workers: ChildProcess[]): Promise<void> {
  await Promise.all(
    workers.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child);
    }),
  );
}

async function expectCompleted(
  worker: ReturnType<typeof spawnStoreWorker>,
): Promise<void> {
  const message = await worker.next("COMPLETE");
  assert.equal(message.type, "COMPLETE");
}

function emptyRun(): RunRecord {
  return {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  };
}

test("concurrent check publishers serialize creates for the same key", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-conc-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sideEffects = new GitHubSideEffectStore(root);
  let posts = 0;
  let nextId = 1;
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      if (method === "POST" && url.includes("/check-runs")) {
        posts += 1;
        // Yield so the other publisher can race without the lock.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 201, headers: {}, body: { id: nextId++ } };
      }
      if (method === "PATCH") return { status: 200, headers: {}, body: { id: 1 } };
      return { status: 200, headers: {}, body: {} };
    },
  };

  const makePublisher = () =>
    new CheckPublisher({
      http,
      sideEffects,
      readOnlyChecks: true,
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 1,
      token: "token",
      sleepFn: async () => {},
    });

  const run = emptyRun();
  await Promise.all([
    makePublisher().publishForHeadSha(run, "sha"),
    makePublisher().publishForHeadSha(run, "sha"),
  ]);
  // Four checks, each created once despite two concurrent publishers.
  assert.equal(posts, 4);
});

test("separate processes concurrently binding two PRs preserve both association records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-lock-"));
  const barrierPath = path.join(root, "association.start");
  const first = spawnStoreWorker(root, barrierPath, "one", "association", {
    MASWE_GITHUB_PULL_REQUEST_NUMBER: "1",
  });
  const second = spawnStoreWorker(root, barrierPath, "two", "association", {
    MASWE_GITHUB_PULL_REQUEST_NUMBER: "2",
  });
  t.after(async () => {
    await terminateWorkers([first.child, second.child]);
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([first.next("READY"), second.next("READY")]);
  await writeFile(barrierPath, "start\n", "utf8");
  await Promise.all([expectCompleted(first), expectCompleted(second)]);
  await waitForWorkers([first.child, second.child]);

  const index = new GitHubAssociationIndex(root);
  assert.equal((await index.find("owner/repo", 1))?.runId, "run-one");
  assert.equal((await index.find("owner/repo", 2))?.runId, "run-two");
});

test("separate processes concurrently binding two stable PRs preserve both stable association records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-stable-lock-"));
  const barrierPath = path.join(root, "association-stable.start");
  const first = spawnStoreWorker(root, barrierPath, "one", "association-stable", {
    MASWE_GITHUB_PULL_REQUEST_NUMBER: "1",
  });
  const second = spawnStoreWorker(root, barrierPath, "two", "association-stable", {
    MASWE_GITHUB_PULL_REQUEST_NUMBER: "2",
  });
  t.after(async () => {
    await terminateWorkers([first.child, second.child]);
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([first.next("READY"), second.next("READY")]);
  await writeFile(barrierPath, "start\n", "utf8");
  await Promise.all([expectCompleted(first), expectCompleted(second)]);
  await waitForWorkers([first.child, second.child]);

  const index = new GitHubAssociationIndex(root);
  assert.equal((await index.findStable(9090, 1))?.runId, "run-one");
  assert.equal((await index.findStable(9090, 2))?.runId, "run-two");
});

test("two processes sharing a full check key execute exactly one create section", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-check-lock-"));
  const barrierPath = path.join(root, "check-create.start");
  const createsPath = path.join(root, "creates.log");
  const idempotencyKey =
    "check-run:owner/repo/42/0123456789abcdef0123456789abcdef01234567/MASWE / deterministic quality/7";
  await writeFile(createsPath, "", "utf8");
  const extraEnv = {
    MASWE_GITHUB_IDEMPOTENCY_KEY: idempotencyKey,
    MASWE_GITHUB_CREATES_PATH: createsPath,
  };
  const first = spawnStoreWorker(root, barrierPath, "one", "check-create", extraEnv);
  const second = spawnStoreWorker(root, barrierPath, "two", "check-create", extraEnv);
  t.after(async () => {
    await terminateWorkers([first.child, second.child]);
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([first.next("READY"), second.next("READY")]);
  await writeFile(barrierPath, "start\n", "utf8");
  await Promise.all([expectCompleted(first), expectCompleted(second)]);
  await waitForWorkers([first.child, second.child]);

  assert.match(await readFile(createsPath, "utf8"), /^(?:one|two):create\n$/);
  assert.deepEqual(await new GitHubSideEffectStore(root).get(idempotencyKey), {
    resourceId: 971,
    kind: "check-run",
  });
});

test("association binding migrates the exact legacy associations.lock path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-migration-"));
  const legacyPath = path.join(root, "associations.lock");
  await mkdir(legacyPath);
  await writeFile(
    path.join(legacyPath, "owner.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "dead", at: "2026-08-09T10:00:00.000Z" })}\n`,
  );

  await new GitHubAssociationIndex(root).bind({
    runId: "run-migrated",
    installationId: 41,
    repository: "owner/repo",
    pullRequestNumber: 3,
    baseSha: "base",
    headSha: "head",
    branch: "migration",
  });

  assert.equal((await lstat(legacyPath)).isDirectory(), true);
  assert.equal(
    (await lstat(
      path.join(
        root,
        "journals",
        "association",
        "0d0eff7483f9df60bddf94736a2ce4e3e77fe46d895ebd415d72351adb890e30",
        "legacy-migration.json",
      ),
    )).isFile(),
    true,
  );
});

test("check creation migrates the exact legacy per-key lock path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-check-migration-"));
  const idempotencyKey =
    "check-run:owner/repo/42/0123456789abcdef0123456789abcdef01234567/MASWE / deterministic quality/7";
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  const legacyPath = path.join(
    root,
    "side-effect-create-locks",
    `${digest}.json.lock`,
  );
  await mkdir(legacyPath, { recursive: true });
  await writeFile(
    path.join(legacyPath, "owner.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "dead", at: "2026-08-09T10:00:00.000Z" })}\n`,
  );

  await new GitHubSideEffectStore(root).withCreateLock(
    idempotencyKey,
    async () => undefined,
  );

  assert.equal((await lstat(legacyPath)).isDirectory(), true);
  assert.equal(
    (await lstat(
      path.join(
        root,
        "journals",
        "check-create",
        digest,
        "legacy-migration.json",
      ),
    )).isFile(),
    true,
  );
});

test(
  "read-only legacy-journal preflight reports live and never acquires or disturbs a genuinely live pre-#34 publication owner",
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-legacy-preflight-live-"));
    const eventsPath = path.join(root, "events.log");
    await writeFile(eventsPath, "", "utf8");
    const logicalKey = "owner/repo#42";
    const digest = createHash("sha256").update(logicalKey).digest("hex");
    const journalDirectory = path.join(root, "journals", "publication", digest);

    const child = fork(journalWorkerPath, [], {
      execArgv: ["--experimental-strip-types"],
      env: {
        ...process.env,
        MASWE_GITHUB_ROOT: root,
        MASWE_GITHUB_EVENTS_PATH: eventsPath,
        MASWE_GITHUB_ACTOR: "legacy-owner",
        MASWE_GITHUB_JOURNAL_KIND: "publication",
        MASWE_GITHUB_LOGICAL_KEY: logicalKey,
        MASWE_GITHUB_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    });

    interface WorkerMessage {
      type: "ENTER" | "TRANSITION" | "COMPLETE" | "ERROR";
      actor: string;
      pid: number;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("legacy owner ENTER watchdog expired")),
        WATCHDOG_MS,
      );
      child.on("message", (message: WorkerMessage) => {
        if (message.type !== "ENTER") return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`legacy owner exited ${code ?? signal} before ENTER`));
      });
    });

    // The live legacy owner is now holding the exact name-keyed publication claim that a
    // pre-#34 binary would hold. Capture its on-disk state before running the read-only
    // preflight so the "undisturbed" assertion below compares real journal contents.
    const before = await scanLockJournal(journalDirectory, "data");
    assert.equal(before.claims.length, 1);
    assert.equal(before.releases.size, 0);

    const result = await inspectLegacyGitHubJournalOwnership({
      githubRoot: root,
      kind: "publication",
      logicalKey,
    });
    assert.deepEqual(result, { state: "live" });

    // No competing claim was appended and the live owner's claim is exactly intact: same
    // ticket count, same claim digest, still unreleased.
    const after = await scanLockJournal(journalDirectory, "data");
    assert.deepEqual(after.claims, before.claims);
    assert.equal(after.releases.size, 0);

    child.send({ type: "RELEASE" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("legacy owner COMPLETE watchdog expired")),
        WATCHDOG_MS,
      );
      child.on("message", (message: WorkerMessage) => {
        if (message.type !== "COMPLETE") return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`legacy owner exited ${code ?? signal} before COMPLETE`));
      });
    });

    assert.equal(await readFile(eventsPath, "utf8"), "legacy-owner:enter\nlegacy-owner:exit\n");
    const final = await scanLockJournal(journalDirectory, "data");
    assert.equal(final.claims.length, 1);
    assert.equal(final.releases.size, 1);
  },
);
