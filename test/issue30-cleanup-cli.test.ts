import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MasweConfig } from "../src/domain.ts";
import { FileRunStore } from "../src/store.ts";
import { spawnFileCaptured } from "./helpers/child-process.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function initRepo(prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# cleanup cli\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return spawnFileCaptured(
    process.execPath,
    ["--experimental-strip-types", cliPath, ...args],
    {
      cwd,
      env: { ...process.env, ...env },
    },
  );
}

function snapshottedConfig(): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.runtime.command = "snapshotted-agent";
  config.roles.brainstormer.model = "snapshotted-model";
  config.policy.useIsolatedWorktree = false;
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];
  return config;
}

async function writeProjectConfig(cwd: string, config: MasweConfig): Promise<void> {
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "config.json"),
    JSON.stringify({
      runtime: config.runtime,
      roles: config.roles,
      gates: config.gates,
      quality: config.quality,
      policy: config.policy,
      version: 1,
    }),
    "utf8",
  );
}

test("maswe cleanup dispatches through persisted run snapshot after config corruption", async () => {
  const cwd = await initRepo("maswe-cleanup-cli-");
  const config = snapshottedConfig();
  await writeProjectConfig(cwd, config);

  const store = new FileRunStore(cwd);
  const run = await store.create("cleanup-cli", "request", config);
  run.state = "COMPLETED";
  run.terminalCleanup = { status: "complete", updatedAt: new Date().toISOString() };
  await store.save(run);

  await writeFile(path.join(cwd, ".maswe", "config.json"), "{ not-json", "utf8");

  const result = await runCli(
    cwd,
    ["cleanup", run.id],
    {
      MASWE_RUNTIME: "cursor-cli",
      MASWE_MODEL_BRAINSTORMER: "env-mutated-model",
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Terminal cleanup: complete/);
  assert.match(result.stdout, /State: COMPLETED/);

  const reloaded = await store.load(run.id);
  assert.equal(reloaded.config.runtime.kind, "mock");
  assert.equal(reloaded.config.runtime.command, "snapshotted-agent");
  assert.equal(reloaded.config.roles.brainstormer.model, "snapshotted-model");
});
