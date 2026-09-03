import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, mergeConfigForTest, migrateConfig } from "../src/config.ts";

const MASWE_ENV_KEYS = [
  "MASWE_RUNTIME",
  "MASWE_MODEL_BRAINSTORMER",
  "MASWE_MODEL_DESIGNER",
  "MASWE_MODEL_BUILDER",
  "MASWE_MODEL_VERIFIER",
  "MASWE_MODEL_PR_RESOLVER",
] as const;

function snapshotMasweEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of MASWE_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreMasweEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of MASWE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearMasweEnv(): void {
  for (const key of MASWE_ENV_KEYS) delete process.env[key];
}

test("config merges user values with safe defaults", async () => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  try {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-config-"));
    await mkdir(path.join(cwd, ".maswe"));
    await writeFile(
      path.join(cwd, ".maswe", "config.json"),
      JSON.stringify({
        runtime: { kind: "mock" },
        roles: { builder: { model: "custom-builder" } },
        quality: { commands: [] },
      }),
    );
    const config = await loadConfig(cwd);
    assert.equal(config.runtime.kind, "mock");
    assert.equal(config.roles.builder.model, "custom-builder");
    assert.equal(config.roles.verifier.model, "gpt-5.6-sol-high");
    assert.deepEqual(config.quality.commands, []);
  } finally {
    restoreMasweEnv(env);
  }
});

test("project config rejects explicit top-level null", async (t) => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-config-null-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  try {
    await mkdir(path.join(cwd, ".maswe"));
    await writeFile(path.join(cwd, ".maswe", "config.json"), "null\n", "utf8");

    await assert.rejects(() => loadConfig(cwd), /config.*object/i);
  } finally {
    restoreMasweEnv(env);
  }
});

test("omitted project config still uses defaults", async (t) => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-config-omitted-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  try {
    const config = await loadConfig(cwd);

    assert.deepEqual(config, DEFAULT_CONFIG);
  } finally {
    restoreMasweEnv(env);
  }
});

test("environment variables override role models", async () => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  process.env.MASWE_MODEL_VERIFIER = "verified-model";
  try {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-env-"));
    const config = await loadConfig(cwd);
    assert.equal(config.roles.verifier.model, "verified-model");
  } finally {
    restoreMasweEnv(env);
  }
});

test("host MASWE_MODEL_* env does not leak into file-backed defaults merge", async () => {
  const env = snapshotMasweEnv();
  clearMasweEnv();
  process.env.MASWE_MODEL_BUILDER = "cursor-grok-4.5-high";
  try {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-config-env-leak-"));
    await mkdir(path.join(cwd, ".maswe"));
    await writeFile(
      path.join(cwd, ".maswe", "config.json"),
      JSON.stringify({
        runtime: { kind: "mock" },
        roles: { builder: { model: "custom-builder" } },
        quality: { commands: [] },
      }),
    );
    // Without isolation, loadConfig would prefer the host env model.
    const polluted = await loadConfig(cwd);
    assert.equal(polluted.roles.builder.model, "cursor-grok-4.5-high");

    clearMasweEnv();
    const isolated = await loadConfig(cwd);
    assert.equal(isolated.roles.builder.model, "custom-builder");
  } finally {
    restoreMasweEnv(env);
  }
});

test("doctorProbeTimeoutMs defaults to 60000 when omitted", () => {
  const migrated = migrateConfig({
    policy: { commandTimeoutMs: 2_000 },
  });
  assert.equal(migrated.policy.doctorProbeTimeoutMs, 60_000);
});

test("doctorProbeTimeoutMs accepts explicit bounds and rejects invalid values", () => {
  assert.equal(
    mergeConfigForTest({ policy: { doctorProbeTimeoutMs: 1_000 } }).policy.doctorProbeTimeoutMs,
    1_000,
  );
  assert.equal(
    mergeConfigForTest({ policy: { doctorProbeTimeoutMs: 300_000 } }).policy.doctorProbeTimeoutMs,
    300_000,
  );

  const invalid = [0, -1, 999, 300_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5];
  for (const value of invalid) {
    assert.throws(
      () => mergeConfigForTest({ policy: { doctorProbeTimeoutMs: value } }),
      /doctorProbeTimeoutMs/i,
      String(value),
    );
  }
});

test("quality commands accept an explicit empty list but reject blank entries", () => {
  assert.deepEqual(mergeConfigForTest({ quality: { commands: [] } }).quality.commands, []);
  for (const command of ["", " \t\n "]) {
    assert.throws(
      () => mergeConfigForTest({ quality: { commands: [command] } }),
      /quality\.commands must contain only non-blank strings/,
    );
  }
  const trustedText = "  npm test  ";
  assert.deepEqual(
    mergeConfigForTest({ quality: { commands: [trustedText] } }).quality.commands,
    [trustedText],
  );
});

test("githubApp is optional and omitted by default", () => {
  const config = mergeConfigForTest({});
  assert.equal(config.githubApp, undefined);
});

test("githubApp accepts enabled read-only pilot config", () => {
  const config = mergeConfigForTest({
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
      webhookHost: "127.0.0.1",
      webhookPort: 8787,
    },
  });
  assert.deepEqual(config.githubApp, {
    enabled: true,
    readOnlyChecks: true,
    webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
    appIdEnv: "MASWE_GITHUB_APP_ID",
    privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
    allowedRepositoryIds: [],
    allowedRepositories: ["owner/repo"],
    webhookHost: "127.0.0.1",
    webhookPort: 8787,
  });
});

test("githubApp accepts an enabled stable-id-only allowlist", () => {
  const config = mergeConfigForTest({
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [1308655205],
    },
  });

  assert.deepEqual(config.githubApp, {
    enabled: true,
    readOnlyChecks: true,
    webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
    appIdEnv: "MASWE_GITHUB_APP_ID",
    privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
    allowedRepositoryIds: [1308655205],
    allowedRepositories: [],
  });
});

test("githubApp rejects write mode when enabled in Phase A pilot", () => {
  assert.throws(
    () =>
      mergeConfigForTest({
        githubApp: {
          enabled: true,
          readOnlyChecks: false,
          webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
          appIdEnv: "MASWE_GITHUB_APP_ID",
          privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
          allowedRepositories: ["owner/repo"],
        },
      }),
    /readOnlyChecks/,
  );
});

test("githubApp rejects unsupported fields instead of retaining inline secrets", () => {
  assert.throws(
    () =>
      mergeConfigForTest({
        githubApp: {
          enabled: true,
          readOnlyChecks: true,
          webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
          appIdEnv: "MASWE_GITHUB_APP_ID",
          privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
          allowedRepositories: ["owner/repo"],
          inlineSecret: "must-not-survive-normalization",
        } as never,
      }),
    /unsupported config field.*githubApp.*inlineSecret/i,
  );
});

test("githubApp rejects both allowlists empty when enabled", () => {
  for (const allowlists of [
    {},
    { allowedRepositories: [] },
    { allowedRepositoryIds: [] },
    { allowedRepositoryIds: [], allowedRepositories: [] },
  ]) {
    assert.throws(
      () =>
        mergeConfigForTest({
          githubApp: {
            enabled: true,
            readOnlyChecks: true,
            webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
            appIdEnv: "MASWE_GITHUB_APP_ID",
            privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
            ...allowlists,
          },
        }),
      /allowedRepositoryIds.*allowedRepositories.*at least one/,
      JSON.stringify(allowlists),
    );
  }
});

test("githubApp rejects malformed stable repository ids", () => {
  for (const allowedRepositoryIds of [
    [1308655205, 1308655205],
    [0],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 2],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    ["1308655205"],
    [null],
    "1308655205",
  ]) {
    assert.throws(
      () =>
        mergeConfigForTest({
          githubApp: {
            enabled: true,
            readOnlyChecks: true,
            webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
            appIdEnv: "MASWE_GITHUB_APP_ID",
            privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
            allowedRepositoryIds,
            allowedRepositories: ["owner/repo"],
          },
        }),
      /allowedRepositoryIds must be an array of unique positive safe integers/,
      JSON.stringify(allowedRepositoryIds),
    );
  }
});

test("githubApp accepts an empty allowlist when disabled", () => {
  const config = mergeConfigForTest({
    githubApp: {
      enabled: false,
      readOnlyChecks: false,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: [],
    },
  });

  assert.deepEqual(config.githubApp?.allowedRepositories, []);
  assert.deepEqual(config.githubApp?.allowedRepositoryIds, []);
});

test("githubApp normalizes validated repository allowlist entries case-insensitively", () => {
  const config = mergeConfigForTest({
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["Owner/Repo"],
    },
  });

  assert.deepEqual(config.githubApp?.allowedRepositories, ["owner/repo"]);
  assert.deepEqual(config.githubApp?.allowedRepositoryIds, []);
});

test("githubApp keeps the stable id allowlist independent of repository names", () => {
  const config = mergeConfigForTest({
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [1308655205, 42],
      allowedRepositories: ["Owner/Repo"],
    },
  });

  assert.deepEqual(config.githubApp?.allowedRepositoryIds, [1308655205, 42]);
  assert.deepEqual(config.githubApp?.allowedRepositories, ["owner/repo"]);
});

test("githubApp keeps the Phase A read-only guard for stable-id allowlists", () => {
  assert.throws(
    () =>
      mergeConfigForTest({
        githubApp: {
          enabled: true,
          readOnlyChecks: false,
          webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
          appIdEnv: "MASWE_GITHUB_APP_ID",
          privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
          allowedRepositoryIds: [1308655205],
        },
      }),
    /readOnlyChecks/,
  );
});

test("project config rejects unknown fields throughout the runtime tree", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-config-exact-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, ".maswe"));
  const configPath = path.join(cwd, ".maswe", "config.json");

  for (const raw of [
    { inlineToken: "top-level-secret" },
    { runtime: { privateKey: "nested-secret" } },
    { roles: { builder: { token: "nested-secret" } } },
    { roles: { secretRole: { model: "nested-secret" } } },
    { gates: { token: "nested-secret" } },
    { quality: { privateKey: "nested-secret" } },
    { policy: { token: "nested-secret" } },
  ]) {
    await writeFile(configPath, JSON.stringify(raw), "utf8");
    await assert.rejects(loadConfig(cwd), /unsupported config field/i, JSON.stringify(raw));
  }
});

test("GitHub credential references must be canonical environment variable names", () => {
  for (const invalidName of ["1SECRET", "MASWE-SECRET", "MASWE SECRET", " SECRET", ""]) {
    assert.throws(
      () =>
        mergeConfigForTest({
          githubApp: {
            enabled: true,
            readOnlyChecks: true,
            webhookSecretEnv: invalidName,
            appIdEnv: "MASWE_GITHUB_APP_ID",
            privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
            allowedRepositories: ["owner/repo"],
          },
        }),
      /environment variable name/i,
      JSON.stringify(invalidName),
    );
  }
});
