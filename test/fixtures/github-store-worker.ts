import { access, appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { GitHubAssociationIndex } from "../../src/github/association.ts";
import { GitHubSideEffectStore } from "../../src/github/side-effect-store.ts";

const githubRoot = process.env.MASWE_GITHUB_ROOT;
const barrierPath = process.env.MASWE_GITHUB_BARRIER_PATH;
const mode = process.env.MASWE_GITHUB_STORE_MODE;
const actor = process.env.MASWE_GITHUB_ACTOR;

if (!githubRoot || !barrierPath || !mode || !actor || typeof process.send !== "function") {
  throw new Error("GitHub store worker requires root, barrier, mode, actor, and IPC");
}

async function send(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForBarrier(filePath: string): Promise<void> {
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(5);
    }
  }
}

try {
  await send({ type: "READY", actor, pid: process.pid });
  await waitForBarrier(barrierPath);

  if (mode === "association") {
    // Explicit legacy fixture: baseline name-primary bind, unchanged since before #34.
    const pullRequestNumber = Number(process.env.MASWE_GITHUB_PULL_REQUEST_NUMBER);
    if (!Number.isSafeInteger(pullRequestNumber)) {
      throw new Error("association worker requires a pull request number");
    }
    const index = new GitHubAssociationIndex(githubRoot);
    await index.bind({
      runId: `run-${actor}`,
      installationId: 41,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: `head-${actor}`,
      branch: `branch-${actor}`,
    });
  } else if (mode === "association-stable") {
    const pullRequestNumber = Number(process.env.MASWE_GITHUB_PULL_REQUEST_NUMBER);
    if (!Number.isSafeInteger(pullRequestNumber)) {
      throw new Error("association-stable worker requires a pull request number");
    }
    const index = new GitHubAssociationIndex(githubRoot);
    await index.withTransaction(async (transaction) =>
      transaction.bindStable({
        runId: `run-${actor}`,
        installationId: 41,
        repositoryId: 9090,
        repository: "owner/repo",
        pullRequestNumber,
        baseSha: "base",
        headSha: `head-${actor}`,
        branch: `branch-${actor}`,
      }),
    );
  } else if (mode === "check-create") {
    const idempotencyKey = process.env.MASWE_GITHUB_IDEMPOTENCY_KEY;
    const createsPath = process.env.MASWE_GITHUB_CREATES_PATH;
    if (!idempotencyKey || !createsPath) {
      throw new Error("check-create worker requires a key and create log");
    }
    const sideEffects = new GitHubSideEffectStore(githubRoot);
    await sideEffects.withCreateLock(idempotencyKey, async () => {
      const existing = await sideEffects.get(idempotencyKey);
      if (existing) return;
      await appendFile(createsPath, `${actor}:create\n`, "utf8");
      await delay(30);
      await sideEffects.put(idempotencyKey, { resourceId: 971, kind: "check-run" });
    });
  } else {
    throw new Error(`unsupported GitHub store worker mode: ${mode}`);
  }

  await send({ type: "COMPLETE", actor, pid: process.pid });
  process.disconnect?.();
} catch (error) {
  await send({
    type: "ERROR",
    actor,
    pid: process.pid,
    message: error instanceof Error ? error.message : String(error),
  });
  process.disconnect?.();
  process.exitCode = 1;
}
