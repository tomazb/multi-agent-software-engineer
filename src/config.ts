import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MasweConfig, RoleConfig, RoleId, RuntimeKind } from "./domain.ts";
import { assertConfiguredRolePermission } from "./policy.ts";

export const DEFAULT_CONFIG: MasweConfig = {
  version: 1,
  runtime: {
    kind: "cursor-cli",
    command: "agent",
    outputFormat: "json",
  },
  roles: {
    brainstormer: {
      model: "grok-4.5",
      reasoning: "high",
      permissions: "read-only",
    },
    designer: {
      model: "claude-fable-5",
      fallbackModels: ["claude-opus-4.8"],
      reasoning: "high",
      permissions: "read-only",
    },
    builder: {
      model: "grok-4.5",
      reasoning: "high",
      permissions: "workspace-write",
    },
    verifier: {
      model: "gpt-5.6-sol-high",
      reasoning: "high",
      permissions: "read-only",
    },
    prResolver: {
      model: "gpt-5.6-sol-high",
      reasoning: "high",
      permissions: "workspace-write",
    },
  },
  gates: {
    requireBrainstormApproval: true,
    requireDesignApproval: true,
    requireCiPass: true,
    requireVerifierPass: true,
  },
  quality: {
    commands: ["npm test", "npm run typecheck", "npm run build"],
  },
  policy: {
    rejectModelFallback: true,
    maxBuildVerifyCycles: 3,
    maxCommentResolutionCycles: 2,
    allowDirtyWorkspace: false,
    useIsolatedWorktree: true,
    trustManagedWorktrees: true,
    promptTransport: "stdin",
    commandTimeoutMs: 600_000,
    roleTimeoutMs: 1_800_000,
    doctorProbeTimeoutMs: 60_000,
    allowedPathGlobs: ["**"],
  },
};

const ROLE_ENV: Record<RoleId, string> = {
  brainstormer: "MASWE_MODEL_BRAINSTORMER",
  designer: "MASWE_MODEL_DESIGNER",
  builder: "MASWE_MODEL_BUILDER",
  verifier: "MASWE_MODEL_VERIFIER",
  prResolver: "MASWE_MODEL_PR_RESOLVER",
};

function cloneDefaults(): MasweConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function exactObject(
  raw: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unsupported) {
    throw new Error(`Unsupported config field: ${label}.${unsupported}`);
  }
  return value;
}

function optionalExactObject(
  raw: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  return raw === undefined ? {} : exactObject(raw, label, allowed);
}

function mergeRole(base: RoleConfig, incoming: unknown, label: string): RoleConfig {
  if (incoming === undefined) return base;
  const value = exactObject(incoming, label, [
    "model",
    "fallbackModels",
    "reasoning",
    "permissions",
  ]) as Partial<RoleConfig>;
  const fallbackModels = value.fallbackModels ?? base.fallbackModels;
  const permissions = Object.hasOwn(value, "permissions")
    ? value.permissions
    : base.permissions;
  return {
    model: value.model ?? base.model,
    reasoning: value.reasoning ?? base.reasoning,
    permissions: permissions as RoleConfig["permissions"],
    ...(fallbackModels ? { fallbackModels } : {}),
  };
}

function normalizeGitHubAppConfig(raw: unknown): NonNullable<MasweConfig["githubApp"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("githubApp must be an object when set");
  }
  const value = exactObject(raw, "githubApp", [
    "enabled",
    "readOnlyChecks",
    "webhookSecretEnv",
    "appIdEnv",
    "privateKeyEnv",
    "allowedRepositoryIds",
    "allowedRepositories",
    "webhookHost",
    "webhookPort",
  ]);
  const repositories = value.allowedRepositories;
  const repositoryIds = value.allowedRepositoryIds;
  return {
    enabled: value.enabled as boolean,
    readOnlyChecks: value.readOnlyChecks as boolean,
    webhookSecretEnv: value.webhookSecretEnv as string,
    appIdEnv: value.appIdEnv as string,
    privateKeyEnv: value.privateKeyEnv as string,
    // The two allowlists normalize independently: names never populate ids and ids never
    // populate names. Only an omitted array becomes []; malformed values reach validation.
    allowedRepositoryIds: (repositoryIds === undefined ? [] : repositoryIds) as number[],
    allowedRepositories: repositories === undefined
      ? []
      : Array.isArray(repositories)
        ? repositories.map((repository) =>
            typeof repository === "string" ? repository.toLowerCase() : repository,
          ) as string[]
        : repositories as string[],
    ...(value.webhookHost !== undefined ? { webhookHost: value.webhookHost as string } : {}),
    ...(value.webhookPort !== undefined ? { webhookPort: value.webhookPort as number } : {}),
  };
}

/** Pure default migration without applying process environment overrides. */
export function migrateConfig(raw: unknown): MasweConfig {
  const base = cloneDefaults();
  if (raw === undefined) return base;
  const value = exactObject(raw, "config", [
    "version",
    "runtime",
    "roles",
    "gates",
    "quality",
    "policy",
    "githubApp",
  ]);
  const runtime = optionalExactObject(value.runtime, "runtime", [
    "kind",
    "command",
    "outputFormat",
  ]);
  const roles = optionalExactObject(value.roles, "roles", [
    "brainstormer",
    "designer",
    "builder",
    "verifier",
    "prResolver",
  ]);
  const gates = optionalExactObject(value.gates, "gates", [
    "requireBrainstormApproval",
    "requireDesignApproval",
    "requireCiPass",
    "requireVerifierPass",
  ]);
  const quality = optionalExactObject(value.quality, "quality", ["commands"]);
  const policy = optionalExactObject(value.policy, "policy", [
    "rejectModelFallback",
    "maxBuildVerifyCycles",
    "maxCommentResolutionCycles",
    "allowDirtyWorkspace",
    "useIsolatedWorktree",
    "trustManagedWorktrees",
    "promptTransport",
    "commandTimeoutMs",
    "roleTimeoutMs",
    "doctorProbeTimeoutMs",
    "maxRunDurationMs",
    "allowedPathGlobs",
  ]);

  const migrated: MasweConfig = {
    version: 1,
    runtime: { ...base.runtime, ...runtime } as MasweConfig["runtime"],
    roles: {
      brainstormer: mergeRole(base.roles.brainstormer, roles.brainstormer, "roles.brainstormer"),
      designer: mergeRole(base.roles.designer, roles.designer, "roles.designer"),
      builder: mergeRole(base.roles.builder, roles.builder, "roles.builder"),
      verifier: mergeRole(base.roles.verifier, roles.verifier, "roles.verifier"),
      prResolver: mergeRole(base.roles.prResolver, roles.prResolver, "roles.prResolver"),
    },
    gates: { ...base.gates, ...gates } as MasweConfig["gates"],
    quality: { ...base.quality, ...quality } as MasweConfig["quality"],
    policy: { ...base.policy, ...policy } as MasweConfig["policy"],
  };
  if (value.githubApp !== undefined) {
    migrated.githubApp = normalizeGitHubAppConfig(value.githubApp);
  } else {
    delete migrated.githubApp;
  }
  return migrated;
}

/** Project config load path: migrate defaults then apply environment overrides. */
export function mergeConfig(raw: unknown): MasweConfig {
  return applyEnvironment(migrateConfig(raw));
}

/** Test/helper alias: deep-migrate partial or v0.1 config snapshots onto current defaults. */
export function mergeConfigForTest(raw: unknown): MasweConfig {
  const config = migrateConfig(raw);
  assertConfig(config);
  return config;
}

function applyEnvironment(config: MasweConfig): MasweConfig {
  const result = structuredClone(config);
  const runtime = process.env.MASWE_RUNTIME;
  if (runtime) result.runtime.kind = runtime as RuntimeKind;

  for (const [role, variable] of Object.entries(ROLE_ENV) as Array<[RoleId, string]>) {
    const model = process.env[variable];
    if (model) result.roles[role].model = model;
  }
  return result;
}

/** Fail-closed validation shared by project config load and persisted run migration. */
export function assertConfig(config: MasweConfig): void {
  exactObject(config, "config", [
    "version",
    "runtime",
    "roles",
    "gates",
    "quality",
    "policy",
    "githubApp",
  ]);
  exactObject(config.runtime, "runtime", ["kind", "command", "outputFormat"]);
  const roles = exactObject(config.roles, "roles", [
    "brainstormer",
    "designer",
    "builder",
    "verifier",
    "prResolver",
  ]);
  for (const role of Object.keys(roles)) {
    exactObject(roles[role], `roles.${role}`, [
      "model",
      "fallbackModels",
      "reasoning",
      "permissions",
    ]);
  }
  exactObject(config.gates, "gates", [
    "requireBrainstormApproval",
    "requireDesignApproval",
    "requireCiPass",
    "requireVerifierPass",
  ]);
  exactObject(config.quality, "quality", ["commands"]);
  exactObject(config.policy, "policy", [
    "rejectModelFallback",
    "maxBuildVerifyCycles",
    "maxCommentResolutionCycles",
    "allowDirtyWorkspace",
    "useIsolatedWorktree",
    "trustManagedWorktrees",
    "promptTransport",
    "commandTimeoutMs",
    "roleTimeoutMs",
    "doctorProbeTimeoutMs",
    "maxRunDurationMs",
    "allowedPathGlobs",
  ]);
  const runtimes: RuntimeKind[] = ["mock", "cursor-cli", "cursor-sdk"];
  if (!runtimes.includes(config.runtime.kind)) {
    throw new Error(`Unsupported runtime.kind: ${config.runtime.kind}`);
  }
  if (typeof config.runtime.command !== "string" || !config.runtime.command.trim()) {
    throw new Error("runtime.command must not be empty");
  }
  if (!["text", "json", "stream-json"].includes(config.runtime.outputFormat)) {
    throw new Error("runtime.outputFormat must be text, json, or stream-json");
  }
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    if (typeof roleConfig.model !== "string" || !roleConfig.model.trim()) {
      throw new Error(`roles.${role}.model must not be empty`);
    }
    if (!["read-only", "workspace-write"].includes(roleConfig.permissions)) {
      throw new Error(`roles.${role}.permissions must be read-only or workspace-write`);
    }
    assertConfiguredRolePermission(role as RoleId, roleConfig.permissions);
    if (!["low", "medium", "high"].includes(roleConfig.reasoning)) {
      throw new Error(`roles.${role}.reasoning must be low, medium, or high`);
    }
    if (
      roleConfig.fallbackModels !== undefined &&
      (!Array.isArray(roleConfig.fallbackModels) ||
        !roleConfig.fallbackModels.every((model) => typeof model === "string" && model.trim().length > 0))
    ) {
      throw new Error(`roles.${role}.fallbackModels must be an array of non-empty strings when set`);
    }
  }
  for (const [gate, value] of Object.entries(config.gates)) {
    if (typeof value !== "boolean") {
      throw new Error(`gates.${gate} must be a boolean`);
    }
  }
  if (!Array.isArray(config.quality.commands)) {
    throw new Error("quality.commands must be an array");
  }
  if (
    !config.quality.commands.every(
      (command) => typeof command === "string" && command.trim().length > 0,
    )
  ) {
    throw new Error("quality.commands must contain only non-blank strings");
  }
  if (
    typeof config.policy.maxBuildVerifyCycles !== "number" ||
    !Number.isFinite(config.policy.maxBuildVerifyCycles) ||
    config.policy.maxBuildVerifyCycles < 1
  ) {
    throw new Error("policy.maxBuildVerifyCycles must be at least 1");
  }
  if (
    typeof config.policy.maxCommentResolutionCycles !== "number" ||
    !Number.isFinite(config.policy.maxCommentResolutionCycles) ||
    config.policy.maxCommentResolutionCycles < 1
  ) {
    throw new Error("policy.maxCommentResolutionCycles must be at least 1");
  }
  if (!["stdin", "argv"].includes(config.policy.promptTransport)) {
    throw new Error("policy.promptTransport must be stdin or argv");
  }
  if (typeof config.policy.trustManagedWorktrees !== "boolean") {
    throw new Error("policy.trustManagedWorktrees must be a boolean");
  }
  if (typeof config.policy.useIsolatedWorktree !== "boolean") {
    throw new Error("policy.useIsolatedWorktree must be a boolean");
  }
  if (typeof config.policy.allowDirtyWorkspace !== "boolean") {
    throw new Error("policy.allowDirtyWorkspace must be a boolean");
  }
  if (typeof config.policy.rejectModelFallback !== "boolean") {
    throw new Error("policy.rejectModelFallback must be a boolean");
  }
  if (!Number.isFinite(config.policy.commandTimeoutMs) || config.policy.commandTimeoutMs < 1) {
    throw new Error("policy.commandTimeoutMs must be at least 1");
  }
  if (!Number.isFinite(config.policy.roleTimeoutMs) || config.policy.roleTimeoutMs < 1) {
    throw new Error("policy.roleTimeoutMs must be at least 1");
  }
  if (
    !Number.isInteger(config.policy.doctorProbeTimeoutMs) ||
    config.policy.doctorProbeTimeoutMs < 1_000 ||
    config.policy.doctorProbeTimeoutMs > 300_000
  ) {
    throw new Error("policy.doctorProbeTimeoutMs must be an integer between 1000 and 300000");
  }
  if (
    config.policy.maxRunDurationMs !== undefined &&
    (!Number.isFinite(config.policy.maxRunDurationMs) || config.policy.maxRunDurationMs < 1)
  ) {
    throw new Error("policy.maxRunDurationMs must be at least 1 when set");
  }
  if (
    !Array.isArray(config.policy.allowedPathGlobs) ||
    config.policy.allowedPathGlobs.length < 1 ||
    !config.policy.allowedPathGlobs.every((glob) => typeof glob === "string" && glob.trim().length > 0)
  ) {
    throw new Error("policy.allowedPathGlobs must contain at least one glob");
  }
  if (config.githubApp !== undefined) {
    assertGitHubAppConfig(config.githubApp);
  }
}

function assertGitHubAppConfig(githubApp: MasweConfig["githubApp"]): void {
  if (!githubApp || typeof githubApp !== "object") {
    throw new Error("githubApp must be an object when set");
  }
  if (typeof githubApp.enabled !== "boolean") {
    throw new Error("githubApp.enabled must be a boolean");
  }
  if (typeof githubApp.readOnlyChecks !== "boolean") {
    throw new Error("githubApp.readOnlyChecks must be a boolean");
  }
  if (githubApp.enabled && githubApp.readOnlyChecks !== true) {
    throw new Error(
      "githubApp.readOnlyChecks must be true when githubApp.enabled is true (Phase A pilot)",
    );
  }
  exactObject(githubApp, "githubApp", [
    "enabled",
    "readOnlyChecks",
    "webhookSecretEnv",
    "appIdEnv",
    "privateKeyEnv",
    "allowedRepositoryIds",
    "allowedRepositories",
    "webhookHost",
    "webhookPort",
  ]);
  for (const key of ["webhookSecretEnv", "appIdEnv", "privateKeyEnv"] as const) {
    if (typeof githubApp[key] !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(githubApp[key])) {
      throw new Error(`githubApp.${key} must be a canonical environment variable name`);
    }
  }
  if (
    !Array.isArray(githubApp.allowedRepositories) ||
    !githubApp.allowedRepositories.every(
      (repo) => typeof repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(repo),
    )
  ) {
    throw new Error(
      "githubApp.allowedRepositories must be an array of owner/repo strings",
    );
  }
  if (
    !Array.isArray(githubApp.allowedRepositoryIds) ||
    !githubApp.allowedRepositoryIds.every(
      (repositoryId) => Number.isSafeInteger(repositoryId) && (repositoryId as number) > 0,
    ) ||
    new Set(githubApp.allowedRepositoryIds).size !== githubApp.allowedRepositoryIds.length
  ) {
    throw new Error(
      "githubApp.allowedRepositoryIds must be an array of unique positive safe integers",
    );
  }
  if (
    githubApp.enabled &&
    githubApp.allowedRepositoryIds.length < 1 &&
    githubApp.allowedRepositories.length < 1
  ) {
    throw new Error(
      "githubApp.allowedRepositoryIds or githubApp.allowedRepositories must contain at least one entry when enabled",
    );
  }
  if (
    githubApp.webhookHost !== undefined &&
    (typeof githubApp.webhookHost !== "string" || !githubApp.webhookHost.trim())
  ) {
    throw new Error("githubApp.webhookHost must be a non-empty string when set");
  }
  if (
    githubApp.webhookPort !== undefined &&
    (!Number.isInteger(githubApp.webhookPort) ||
      githubApp.webhookPort < 1 ||
      githubApp.webhookPort > 65535)
  ) {
    throw new Error("githubApp.webhookPort must be an integer between 1 and 65535 when set");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findConfigPath(cwd: string, explicitPath?: string): Promise<string | undefined> {
  if (explicitPath) return path.resolve(cwd, explicitPath);
  const candidates = [
    path.join(cwd, ".maswe", "config.json"),
    path.join(cwd, "devflow.config.json"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export async function loadConfig(cwd: string, explicitPath?: string): Promise<MasweConfig> {
  const configPath = await findConfigPath(cwd, explicitPath);
  const raw = configPath ? JSON.parse(await readFile(configPath, "utf8")) : undefined;
  const config = mergeConfig(raw);
  assertConfig(config);
  return config;
}

export async function writeStarterConfig(cwd: string, force = false): Promise<string> {
  const directory = path.join(cwd, ".maswe");
  const target = path.join(directory, "config.json");
  await mkdir(directory, { recursive: true });
  if (!force && (await exists(target))) {
    throw new Error(`${target} already exists. Pass --force to replace it.`);
  }
  await writeFile(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return target;
}
