import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  canonicalClaim,
  journalPaths,
  LockJournalError,
  parseClaimBytes,
  scanLockJournal,
} from "../src/lock-journal.ts";
import {
  runMutationJournalRoot,
  withRunMutationFence,
} from "../src/run-mutation.ts";
import { FileRunStore } from "../src/store.ts";

interface WorkerMessage {
  type: "EVENT" | "RESULT";
  event?: string;
  result?: string;
  requestId?: string;
}

test("invalid run mutation options fail before publishing ownership", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-options-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("mutation options", "reject before claim", DEFAULT_CONFIG);

  await assert.rejects(
    withRunMutationFence(cwd, run.id, "target", async () => undefined, {
      timeoutMs: 60_001,
    }),
    /Run mutation fence options are invalid/,
  );

  assert.deepEqual(await readdir(runMutationJournalRoot(cwd, run.id)), []);
});

test("a timed-out queued mutation claim is exactly released before rejection", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-timeout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("mutation timeout", "release queued claim", DEFAULT_CONFIG);
  const dataRoot = path.join(runMutationJournalRoot(cwd, run.id), ".lock-journal-v3", "data");

  await withRunMutationFence(cwd, run.id, "publication", async () => {
    await assert.rejects(
      withRunMutationFence(cwd, run.id, "target", async () => undefined, {
        timeoutMs: 0,
      }),
      /Timed out acquiring durable run mutation fence/,
    );
    assert.equal((await readdir(path.join(dataRoot, "releases"))).length, 1);
  });

  await withRunMutationFence(cwd, run.id, "target", async () => undefined, {
    timeoutMs: 1_000,
  });
  assert.equal((await readdir(path.join(dataRoot, "claims"))).length, 3);
  assert.equal((await readdir(path.join(dataRoot, "releases"))).length, 3);
});

test("a post-link claim failure releases its exact claim before same-process reacquisition", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-post-link-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("post-link failure", "release exact claim", DEFAULT_CONFIG);
  const injectedFailure = new Error("injected after claim hard link");
  let injected = false;
  let failedTicket: string | undefined;

  await assert.rejects(
    withRunMutationFence(cwd, run.id, "target", async () => {
      assert.fail("failed publication must not enter protected work");
    }, {
      transition: async (event, context) => {
        if (event !== "CLAIM_PUBLISHED" || injected) return;
        injected = true;
        failedTicket = context.ticket;
        throw injectedFailure;
      },
    }),
    (error: unknown) => error === injectedFailure,
  );

  let reacquired = false;
  await withRunMutationFence(cwd, run.id, "target", async () => {
    reacquired = true;
  }, { timeoutMs: 1_000 });
  assert.equal(reacquired, true);
  const scan = await scanLockJournal(runMutationJournalRoot(cwd, run.id), "data");
  assert.equal(failedTicket, "00000000000000000001");
  assert.equal(scan.releases.has(failedTicket!), true);
  assert.equal(scan.claims.length, 2);
  assert.equal(scan.releases.size, 2);
});

test("a post-link claim failure aggregates an exact-release failure", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-release-fail-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("release failure", "preserve both errors", DEFAULT_CONFIG);
  const claimFailure = new Error("injected claim publication failure");
  const releaseFailure = new Error("injected exact release failure");

  await assert.rejects(
    withRunMutationFence(cwd, run.id, "target", async () => undefined, {
      transition: async (event) => {
        if (event === "CLAIM_PUBLISHED") throw claimFailure;
        if (event === "RELEASE_PREPARED") throw releaseFailure;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [claimFailure, releaseFailure]);
      assert.equal(error.cause, claimFailure);
      return true;
    },
  );
});

test("a post-link claim failure fails closed for an unknown final record", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-nonmatch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("nonmatching claim", "fail closed", DEFAULT_CONFIG);
  const mutationRoot = runMutationJournalRoot(cwd, run.id);
  const injectedFailure = new Error("injected after corrupting final claim");

  await assert.rejects(
    withRunMutationFence(cwd, run.id, "target", async () => undefined, {
      transition: async (event, context) => {
        if (event !== "CLAIM_PUBLISHED") return;
        const claimPath = path.join(
          journalPaths(mutationRoot, "data").claims,
          `${context.ticket}.json`,
        );
        await chmod(claimPath, 0o600);
        await writeFile(claimPath, "{not-the-published-claim\n");
        throw injectedFailure;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], injectedFailure);
      assert.ok(
        error.errors.some(
          (nested) => nested instanceof LockJournalError && nested.code === "LOCK_CORRUPT",
        ),
      );
      return true;
    },
  );

  assert.deepEqual(await readdir(journalPaths(mutationRoot, "data").releases), []);
});

test("a post-link claim failure fails closed for a valid nonmatching final claim", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-nonmatch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("nonmatching claim", "fail closed", DEFAULT_CONFIG);
  const mutationRoot = runMutationJournalRoot(cwd, run.id);
  const injectedFailure = new Error("injected after replacing final claim");

  await assert.rejects(
    withRunMutationFence(cwd, run.id, "target", async () => undefined, {
      transition: async (event, context) => {
        if (event !== "CLAIM_PUBLISHED") return;
        const ticket = BigInt(context.ticket);
        const claimPath = path.join(
          journalPaths(mutationRoot, "data").claims,
          `${context.ticket}.json`,
        );
        const published = parseClaimBytes(await readFile(claimPath, "utf8"), "data", ticket);
        const replacement = canonicalClaim({
          kind: published.kind,
          ticket,
          owner: "11111111-1111-4111-8111-111111111111",
          pid: published.pid,
          process: published.process,
          at: published.at,
          operation: published.operation,
        });
        await chmod(claimPath, 0o600);
        await writeFile(claimPath, replacement.bytes);
        throw injectedFailure;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], injectedFailure);
      assert.ok(
        error.errors.some(
          (nested) =>
            nested instanceof LockJournalError && nested.code === "LOCK_OWNERSHIP_LOST",
        ),
      );
      return true;
    },
  );

  assert.deepEqual(await readdir(journalPaths(mutationRoot, "data").releases), []);
});

function waitForMessage(
  child: ReturnType<typeof fork>,
  predicate: (message: WorkerMessage) => boolean,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onMessage = (message: WorkerMessage): void => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("mutation worker watchdog expired"));
    }, 10_000);
    child.on("message", onMessage);
    child.on("error", onError);
  });
}

test("durable run mutation ownership crosses processes and ESRCH-recovers a crashed owner without deletion", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-process-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("mutation process", "recover immutable ownership", DEFAULT_CONFIG);
  await withRunMutationFence(cwd, run.id, "target", async () => undefined);
  const mutationRoot = runMutationJournalRoot(cwd, run.id);
  const child = fork(
    path.join(process.cwd(), "test/fixtures/lock-journal-worker.ts"),
    [],
    {
      execArgv: ["--experimental-strip-types"],
      env: {
        ...process.env,
        MASWE_LOCK_RUN_DIRECTORY: mutationRoot,
        MASWE_LOCK_ACTOR: "crash-owner",
        MASWE_LOCK_KIND: "data",
        MASWE_LOCK_OPERATION: "run-publication",
        MASWE_LOCK_MODE: "session",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await waitForMessage(child, (message) => message.event === "WORKER_READY");
  const validation = waitForMessage(
    child,
    (message) => message.type === "RESULT" && message.requestId === "validate",
  );
  child.send({ type: "COMMAND", command: "VALIDATE", requestId: "validate" });
  assert.equal((await validation).result, "OK");
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await exited;

  let entered = false;
  await withRunMutationFence(cwd, run.id, "target", async () => {
    entered = true;
  }, { timeoutMs: 5_000 });
  assert.equal(entered, true);

  const dataRoot = path.join(runMutationJournalRoot(cwd, run.id), ".lock-journal-v3", "data");
  assert.deepEqual((await readdir(path.join(dataRoot, "claims"))).sort(), [
    "00000000000000000001.json",
    "00000000000000000002.json",
    "00000000000000000003.json",
  ]);
  const releases = (await readdir(path.join(dataRoot, "releases"))).sort();
  assert.equal(releases.length, 3);
  assert.deepEqual(
    releases.map((name) => name.match(/^data\.([0-9]{20})\./)?.[1]),
    ["00000000000000000001", "00000000000000000002", "00000000000000000003"],
  );
});

test("terminal-cleanup and terminal-recovery roles publish distinct durable claim operations", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-mutation-roles-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("mutation roles", "distinct cleanup and recovery claims", DEFAULT_CONFIG);

  let cleanupClaimOperation: string | undefined;
  await withRunMutationFence(cwd, run.id, "terminal-cleanup", async () => {
    const scan = await scanLockJournal(runMutationJournalRoot(cwd, run.id), "data");
    const live = scan.claims.find((claim) => !scan.releases.has(claim.ticket));
    cleanupClaimOperation = live?.operation;
  });

  let recoveryClaimOperation: string | undefined;
  await withRunMutationFence(cwd, run.id, "terminal-recovery", async () => {
    const scan = await scanLockJournal(runMutationJournalRoot(cwd, run.id), "data");
    const live = scan.claims.find((claim) => !scan.releases.has(claim.ticket));
    recoveryClaimOperation = live?.operation;
  });

  assert.equal(cleanupClaimOperation, "run-terminal-cleanup");
  assert.equal(recoveryClaimOperation, "run-terminal-recovery");

  const finalScan = await scanLockJournal(runMutationJournalRoot(cwd, run.id), "data");
  assert.equal(
    finalScan.claims.some(
      (claim) =>
        claim.operation === "run-target-mutation" && !finalScan.releases.has(claim.ticket),
    ),
    false,
  );
});
