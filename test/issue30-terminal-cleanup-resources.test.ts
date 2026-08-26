import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig } from "../src/domain.ts";
import type { GitWorktreeRegistration } from "../src/git-workspace.ts";
import {
  externalWorktreePath,
  listGitWorktreeRegistrations,
} from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);
const SEQUENTIAL_RUNS = 20;

function isolatedConfig(): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];
  return config;
}

async function initGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue30-cleanup-resources-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# cleanup resource bound\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function readManagedEntries(managedRoot: string): Promise<string[]> {
  try {
    return await readdir(managedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function canonicalizeRegistrations(
  registrations: GitWorktreeRegistration[],
): GitWorktreeRegistration[] {
  return [...registrations]
    .map((registration) => ({
      ...registration,
      worktreePath: path.resolve(registration.worktreePath),
    }))
    .sort((left, right) => left.worktreePath.localeCompare(right.worktreePath));
}

test(
  "AC-30.17: twenty sequential isolated-worktree cleanups return registrations and managed-root entries to baseline except the asserted preserved-recovery fixture",
  { timeout: 360_000 },
  async (t) => {
    const cwd = await initGitRepo();
    const managedRoot = path.dirname(externalWorktreePath(cwd, "probe-id"));
    t.after(async () => {
      await rm(managedRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    });

    const beforeRegistrations = await listGitWorktreeRegistrations(cwd);
    const beforeEntries = await readManagedEntries(managedRoot);

    const store = new FileRunStore(cwd);
    const config = isolatedConfig();
    const preserved = await new Orchestrator(cwd, config, new MockRuntime(), store, {
      afterWorkspaceCheckpoint: async () => {
        throw new Error("interrupt after workspace checkpoint");
      },
    }).start("preserved recovery fixture", "retain governed recovery worktree");

    assert.equal(preserved.state, "FAILED");
    assert.equal(preserved.terminalCleanup?.status, "preserved");
    assert.equal(preserved.terminalCleanup?.preservationReason, "bootstrap-recovery");
    const preservedPath = preserved.workspace?.worktreePath;
    assert.ok(preservedPath);
    await access(preservedPath);

    const allowedRegistrations = canonicalizeRegistrations(
      await listGitWorktreeRegistrations(cwd),
    );
    const allowedEntries = [...(await readManagedEntries(managedRoot))].sort();
    const residualRegistrations = allowedRegistrations.filter(
      (registration) =>
        !canonicalizeRegistrations(beforeRegistrations).some(
          (baseline) => baseline.worktreePath === registration.worktreePath,
        ),
    );
    const residualEntries = allowedEntries.filter((entry) => !beforeEntries.includes(entry));
    assert.deepEqual(
      residualRegistrations.map((registration) => registration.worktreePath),
      [path.resolve(preservedPath)],
    );
    assert.deepEqual(residualEntries, [preserved.id]);

    const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), store);
    for (let index = 0; index < SEQUENTIAL_RUNS; index += 1) {
      const started = await orchestrator.start(
        `resource-bound-${index}`,
        "sequential isolated-worktree cleanup",
      );
      const managedPath = started.workspace?.worktreePath;
      assert.ok(managedPath);
      assert.notEqual(path.resolve(managedPath), path.resolve(preservedPath));

      const cancelled = await orchestrator.cancel(started.id);
      assert.equal(cancelled.state, "CANCELLED");
      assert.equal(cancelled.terminalCleanup?.status, "complete");
      await assert.rejects(access(managedPath), /ENOENT/);
    }

    assert.deepEqual(
      canonicalizeRegistrations(await listGitWorktreeRegistrations(cwd)),
      allowedRegistrations,
    );
    assert.deepEqual([...(await readManagedEntries(managedRoot))].sort(), allowedEntries);
    await access(preservedPath);
  },
);
