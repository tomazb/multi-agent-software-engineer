import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { WORKFLOW_EVENTS, WORKFLOW_STATES } from "../src/domain.ts";
import type { MasweConfig, RuntimeFailureCode } from "../src/domain.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";
import os from "node:os";

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  const?: unknown;
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  enum?: unknown[];
  additionalProperties?: boolean;
  dependentRequired?: Record<string, string[]>;
  not?: JsonSchema;
};

function resolveRef(root: JsonSchema, schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  if (
    schema.$ref ===
    "https://github.com/tomazb/cursor-multi-agent-software-engineer/schemas/config.schema.json"
  ) {
    // External config-schema semantics are exercised directly in this file and at runtime.
    return { type: "object" };
  }
  const match = schema.$ref.match(/^#\/\$defs\/(.+)$/);
  if (!match) throw new Error(`Unsupported $ref ${schema.$ref}`);
  const resolved = root.$defs?.[match[1]!];
  if (!resolved) throw new Error(`Missing $ref target ${schema.$ref}`);
  return resolved;
}

function assertMatches(root: JsonSchema, schema: JsonSchema, value: unknown, label: string): void {
  const effective = resolveRef(root, schema);
  for (const child of effective.allOf ?? []) {
    assertMatches(root, child, value, `${label}.allOf`);
  }
  if (effective.if && effective.then) {
    let conditionMatches = true;
    try {
      assertMatches(root, effective.if, value, `${label}.if`);
    } catch {
      conditionMatches = false;
    }
    if (conditionMatches) {
      assertMatches(root, effective.then, value, `${label}.then`);
    }
  }
  if (effective.not) {
    let forbiddenMatches = true;
    try {
      assertMatches(root, effective.not, value, `${label}.not`);
    } catch {
      forbiddenMatches = false;
    }
    assert.equal(forbiddenMatches, false, `${label} not`);
  }
  if (
    effective.required &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    for (const key of effective.required) {
      assert.ok(Object.hasOwn(obj, key), `${label}.${key} required`);
    }
  }
  if (
    effective.properties &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(effective.properties)) {
      if (Object.hasOwn(obj, key)) {
        assertMatches(root, child, obj[key], `${label}.${key}`);
      }
    }
  }
  if (effective.const !== undefined) {
    assert.equal(value, effective.const, `${label} const`);
  }
  if (effective.enum) {
    assert.ok(effective.enum.includes(value), `${label} enum`);
  }
  if (effective.type === "object") {
    assert.equal(typeof value, "object", label);
    assert.ok(value && !Array.isArray(value), label);
    const obj = value as Record<string, unknown>;
    for (const key of effective.required ?? []) {
      assert.ok(Object.hasOwn(obj, key), `${label}.${key} required`);
    }
    for (const [key, dependencies] of Object.entries(effective.dependentRequired ?? {})) {
      if (!Object.hasOwn(obj, key)) continue;
      for (const dependency of dependencies) {
        assert.ok(Object.hasOwn(obj, dependency), `${label}.${dependency} dependentRequired`);
      }
    }
    for (const [key, child] of Object.entries(effective.properties ?? {})) {
      if (Object.hasOwn(obj, key)) {
        assertMatches(root, child, obj[key], `${label}.${key}`);
      }
    }
    if (effective.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        assert.ok(
          Object.hasOwn(effective.properties ?? {}, key),
          `${label}.${key} additionalProperties`,
        );
      }
    }
  }
  if (effective.type === "array") {
    assert.ok(Array.isArray(value), label);
    if (effective.minItems !== undefined) {
      assert.ok(
        (value as unknown[]).length >= effective.minItems,
        `${label} minItems`,
      );
    }
    if (effective.maxItems !== undefined) {
      assert.ok(
        (value as unknown[]).length <= effective.maxItems,
        `${label} maxItems`,
      );
    }
    if (effective.items) {
      for (const [index, item] of (value as unknown[]).entries()) {
        assertMatches(root, effective.items, item, `${label}[${index}]`);
      }
    }
  }
  if (effective.type === "string") {
    assert.equal(typeof value, "string", label);
    if (effective.minLength) assert.ok(String(value).length >= effective.minLength, label);
    if (effective.maxLength) assert.ok(String(value).length <= effective.maxLength, label);
    if (effective.pattern) {
      assert.match(String(value), new RegExp(effective.pattern), `${label} pattern`);
    }
  }
  if (effective.type === "integer") {
    assert.equal(typeof value, "number", label);
    assert.ok(Number.isInteger(value), `${label} integer`);
    if (effective.minimum !== undefined) assert.ok(Number(value) >= effective.minimum, label);
    if (effective.maximum !== undefined) assert.ok(Number(value) <= effective.maximum, label);
  }
  if (effective.type === "number") {
    assert.equal(typeof value, "number", label);
    if (effective.minimum !== undefined) assert.ok(Number(value) >= effective.minimum, label);
    if (effective.maximum !== undefined) assert.ok(Number(value) <= effective.maximum, label);
  }
  if (effective.type === "boolean") {
    assert.equal(typeof value, "boolean", label);
  }
}

async function loadConfigSchema(): Promise<JsonSchema> {
  return JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
}

function configWithGitHubApp(
  overrides: Partial<NonNullable<MasweConfig["githubApp"]>> = {},
): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.githubApp = {
    enabled: true,
    readOnlyChecks: true,
    webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
    appIdEnv: "MASWE_GITHUB_APP_ID",
    privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
    allowedRepositories: ["owner/repo"],
    ...overrides,
  };
  return config;
}

test("schema assertion rejects fractional values for integer fields", () => {
  const integerSchema = { type: "integer" };

  assert.throws(
    () => assertMatches(integerSchema, integerSchema, 1.5, "integer"),
    /integer integer/,
  );
});

test("schema assertion enforces dependent required object properties", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      suspensionReason: { type: "string" },
      suspended: { type: "boolean" },
    },
    dependentRequired: {
      suspensionReason: ["suspended"],
    },
  };

  assert.throws(
    () => assertMatches(schema, schema, { suspensionReason: "closed" }, "github"),
    /github\.suspended dependentRequired/,
  );
});

test("DEFAULT_CONFIG satisfies config JSON schema required shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
  assertMatches(schema, schema, DEFAULT_CONFIG, "config");
});

test("config schema encodes exact role permissions and nonblank quality commands", async () => {
  const schema = await loadConfigSchema();
  const roles = schema.properties?.roles?.properties;
  const expected = {
    brainstormer: "read-only",
    designer: "read-only",
    builder: "workspace-write",
    verifier: "read-only",
    prResolver: "workspace-write",
  } as const;
  for (const [role, permission] of Object.entries(expected)) {
    const roleSchema = resolveRef(schema, roles?.[role] ?? {});
    assert.ok(roleSchema, `${role} schema`);
    const permissionSchema = roleSchema.allOf?.[1]?.properties?.permissions;
    assert.equal(permissionSchema?.const, permission, `${role} permissions.const`);
    const invalidConfig = structuredClone(DEFAULT_CONFIG) as unknown as {
      roles: Record<string, { permissions: unknown }>;
    };
    invalidConfig.roles[role]!.permissions = null;
    assert.throws(
      () => assertMatches(schema, schema, invalidConfig, `config.roles.${role}.permissions.null`),
      /enum|const/,
    );
  }

  const commands = schema.properties?.quality?.properties?.commands;
  assert.doesNotThrow(() => assertMatches(schema, commands!, [], "quality.commands.empty"));
  for (const command of ["", " \t\n "]) {
    assert.throws(
      () => assertMatches(schema, commands!, [command], "quality.commands.blank"),
      /pattern/,
    );
  }
});

test("config schema rejects enabled GitHub App write mode", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp({ readOnlyChecks: false });

  assert.throws(
    () => assertMatches(schema, schema, config, "config.githubApp.write-mode"),
    /const/,
  );
});

test("config schema rejects an enabled GitHub App with an empty allowlist", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp({ allowedRepositories: [] });

  assert.throws(
    () => assertMatches(schema, schema, config, "config.githubApp.empty-allowlist"),
    /minItems/,
  );
});

test("config schema accepts an enabled read-only GitHub App with an allowed repository", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp();

  assert.doesNotThrow(() =>
    assertMatches(schema, schema, config, "config.githubApp.enabled"),
  );
});

test("config schema accepts a disabled GitHub App with an empty allowlist", async () => {
  const schema = await loadConfigSchema();
  const config = configWithGitHubApp({ enabled: false, allowedRepositories: [] });

  assert.doesNotThrow(() =>
    assertMatches(schema, schema, config, "config.githubApp.disabled"),
  );
});

test("config schema requires the normalized doctor probe timeout", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;

  assert.ok(
    schema.properties?.policy?.required?.includes("doctorProbeTimeoutMs"),
    "policy.doctorProbeTimeoutMs must be required by the normalized config schema",
  );
});

test("persisted run records satisfy run-record schema required shape", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "check", DEFAULT_CONFIG);
  assertMatches(schema, schema, run, "run");
});

test("run-record schema and runtime migration enforce the same run id grammar", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-run-id-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const run = await new FileRunStore(cwd).create("schema", "run id grammar", DEFAULT_CONFIG);
  const validIds = [
    "a",
    "run-123",
    "A_b.c-9",
    `a${"b".repeat(127)}`,
  ];
  const invalidIds = [
    "../foreign",
    "/absolute",
    ".leading-dot",
    "-leading-dash",
    "contains/slash",
    "contains\\backslash",
    "white space",
    "",
    `a${"b".repeat(128)}`,
  ];

  for (const id of validIds) {
    const candidate = structuredClone(run);
    candidate.id = id;
    assert.doesNotThrow(
      () => assertMatches(schema, schema, candidate, `valid run id ${id.length}`),
      id,
    );
    assert.doesNotThrow(() => migrateRunRecord(candidate), id);
  }

  for (const id of invalidIds) {
    const candidate = structuredClone(run);
    candidate.id = id;
    assert.throws(
      () => assertMatches(schema, schema, candidate, `invalid run id ${JSON.stringify(id)}`),
      /run id|\.id|pattern|maxLength|minLength/i,
      id,
    );
    assert.throws(
      () => migrateRunRecord(candidate),
      /invalid run id|Run record id must be a non-empty string/i,
      id,
    );
  }
});

test("run-record schema and migration accept exact legal recovery metadata", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-recovery-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "bootstrap recovery contract", DEFAULT_CONFIG);
  const sourceSha = randomBytes(20).toString("hex");
  const originSha = randomBytes(20).toString("hex");
  const requestedSha = randomBytes(20).toString("hex");
  run.workspaceBootstrap = {
    mode: "isolated-worktree",
    sourceBaseSha: sourceSha,
    sourceBranch: "main",
    sourceTreeFingerprint: randomBytes(32).toString("hex"),
    remote: "https://github.com/owner/repo.git",
    plannedAt: "2026-08-18T12:00:00.000Z",
  };
  await store.save(run);
  const persistedBootstrap = await store.load(run.id);
  assert.doesNotThrow(() => assertMatches(schema, schema, persistedBootstrap, "bootstrap run"));
  assert.doesNotThrow(() => migrateRunRecord(persistedBootstrap));
  assert.equal(persistedBootstrap.workspaceBootstrap?.sourceBaseSha, sourceSha);

  const revalidationRun = await store.create(
    "schema",
    "revalidation recovery contract",
    DEFAULT_CONFIG,
  );
  revalidationRun.state = "CI_RUNNING";
  revalidationRun.revalidation = {
    returnState: "PR_REVIEW",
    source: "github",
    originHeadSha: originSha,
    requestedHeadSha: requestedSha,
    generation: 2,
    requestedAt: "2026-08-18T12:01:00.000Z",
    updatedAt: "2026-08-18T12:02:00.000Z",
  };
  await store.save(revalidationRun);
  const persisted = await store.load(revalidationRun.id);

  assert.doesNotThrow(() => assertMatches(schema, schema, persisted, "run"));
  assert.doesNotThrow(() => migrateRunRecord(persisted));
  assert.equal(persisted.revalidation?.originHeadSha, originSha);
  assert.equal(persisted.revalidation?.requestedHeadSha, requestedSha);

  const recovery = persisted as unknown as Record<string, unknown>;
  const revalidation = recovery.revalidation as Record<string, unknown>;
  revalidation.generation = 0;
  assert.throws(() => assertMatches(schema, schema, persisted, "run"), /generation/);
  assert.throws(() => migrateRunRecord(persisted), /generation/);
  revalidation.generation = 2;
  revalidation.generation = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => assertMatches(schema, schema, persisted, "run"), /generation/);
  assert.throws(() => migrateRunRecord(persisted), /generation/);
  revalidation.generation = 2;
  delete revalidation.requestedAt;
  assert.throws(() => assertMatches(schema, schema, persisted, "run"), /requestedAt.*required/);
  assert.throws(() => migrateRunRecord(persisted), /requestedAt.*required/);
  revalidation.requestedAt = "2026-08-18T12:01:00.000Z";
  revalidation.unknown = true;
  assert.throws(() => assertMatches(schema, schema, persisted, "run"), /additionalProperties/);
  assert.throws(() => migrateRunRecord(persisted), /unsupported.*revalidation.*unknown/i);
});

test("run-record schema and migration accept exact legal terminal cleanup metadata", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-terminal-cleanup-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "terminal cleanup contract", DEFAULT_CONFIG);
  const at = "2026-08-24T12:00:00.000Z";
  const legalForms = [
    { status: "pending", updatedAt: at },
    { status: "complete", updatedAt: at },
    {
      status: "preserved",
      updatedAt: at,
      preservationReason: "bootstrap-recovery",
    },
    {
      status: "failed",
      updatedAt: at,
      lastError: {
        code: "cleanup-remove-failed",
        message: "exact worktree remained registered",
      },
    },
  ] as const;

  for (const terminalCleanup of legalForms) {
    const candidate = structuredClone(await store.load(run.id));
    candidate.state = "COMPLETED";
    candidate.terminalCleanup = structuredClone(terminalCleanup);
    await store.save(candidate);
    const persisted = await store.load(candidate.id);
    assert.doesNotThrow(() => assertMatches(schema, schema, persisted, "terminal cleanup run"));
    assert.doesNotThrow(() => migrateRunRecord(persisted));
    assert.deepEqual(persisted.terminalCleanup, terminalCleanup);
  }

  const illegalForms = [
    { status: "pending", updatedAt: at, preservationReason: "bootstrap-recovery" },
    {
      status: "complete",
      updatedAt: at,
      lastError: { code: "cleanup-remove-failed", message: "x" },
    },
    { status: "preserved", updatedAt: at },
    {
      status: "preserved",
      updatedAt: at,
      preservationReason: "bootstrap-recovery",
      lastError: { code: "cleanup-remove-failed", message: "x" },
    },
    { status: "failed", updatedAt: at },
    {
      status: "failed",
      updatedAt: at,
      preservationReason: "revalidation-recovery",
      lastError: { code: "cleanup-remove-failed", message: "x" },
    },
  ] as const;

  for (const terminalCleanup of illegalForms) {
    const candidate = structuredClone(run);
    candidate.state = "COMPLETED";
    candidate.terminalCleanup = structuredClone(terminalCleanup) as NonNullable<
      typeof run.terminalCleanup
    >;
    assert.throws(
      () => assertMatches(schema, schema, candidate, "illegal terminal cleanup"),
      /required|not|preservationReason|lastError/i,
    );
    assert.throws(
      () => migrateRunRecord(candidate),
      /terminalCleanup|preservationReason|lastError/i,
    );
  }

  const nonterminal = structuredClone(run);
  nonterminal.state = "PR_READY";
  nonterminal.terminalCleanup = { status: "pending", updatedAt: at };
  assert.throws(
    () => assertMatches(schema, schema, nonterminal, "nonterminal terminal cleanup"),
    /terminalCleanup|COMPLETED|FAILED|CANCELLED|state/i,
  );
  assert.throws(
    () => migrateRunRecord(nonterminal),
    /terminalCleanup requires a terminal workflow state/i,
  );

  const nonterminalBuilding = structuredClone(run);
  nonterminalBuilding.state = "BUILDING";
  nonterminalBuilding.terminalCleanup = { status: "pending", updatedAt: at };
  assert.throws(
    () => assertMatches(schema, schema, nonterminalBuilding, "building terminal cleanup"),
    /terminalCleanup|COMPLETED|FAILED|CANCELLED|state/i,
  );
  assert.throws(
    () => migrateRunRecord(nonterminalBuilding),
    /terminalCleanup requires a terminal workflow state/i,
  );
});

test("run-record schema workflow enums and exact event records stay synchronized with runtime validation", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  assert.deepEqual(
    [...(schema.$defs?.workflowState?.enum ?? [])].sort(),
    [...WORKFLOW_STATES].sort(),
  );
  assert.deepEqual(
    [...(schema.$defs?.workflowEvent?.enum ?? [])].sort(),
    [...WORKFLOW_EVENTS].sort(),
  );
  assert.equal(schema.properties?.state?.$ref, "#/$defs/workflowState");
  assert.equal(
    schema.properties?.failure?.properties?.resumeState?.$ref,
    "#/$defs/workflowState",
  );
  const eventSchema = resolveRef(schema, schema.properties?.events?.items ?? {});
  assert.equal(eventSchema.additionalProperties, false);
  assert.deepEqual(eventSchema.required, ["id", "at", "type", "actor", "from", "to"]);
  assert.equal(eventSchema.properties?.type?.$ref, "#/$defs/workflowEvent");
  assert.equal(eventSchema.properties?.from?.$ref, "#/$defs/workflowState");
  assert.equal(eventSchema.properties?.to?.$ref, "#/$defs/workflowState");

  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-workflow-enums-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const run = await new FileRunStore(cwd).create(
    "exact workflow schema",
    "reject public/runtime drift",
    DEFAULT_CONFIG,
  );
  run.events = [
    {
      id: "event-1",
      at: "2026-08-19T12:00:00.000Z",
      type: "START",
      actor: "user",
      from: "CREATED",
      to: "BRAINSTORMING",
      details: { source: "test" },
    },
  ];
  assert.doesNotThrow(() => assertMatches(schema, schema, run, "valid run"));
  assert.doesNotThrow(() => migrateRunRecord(run));

  for (const invalid of [
    {
      label: "unknown state",
      mutate: (candidate: Record<string, unknown>) => {
        candidate.state = "UNKNOWN_STATE";
      },
    },
    {
      label: "unknown event type",
      mutate: (candidate: Record<string, unknown>) => {
        ((candidate.events as Array<Record<string, unknown>>)[0]!).type = "UNKNOWN_EVENT";
      },
    },
    {
      label: "missing required event field",
      mutate: (candidate: Record<string, unknown>) => {
        delete ((candidate.events as Array<Record<string, unknown>>)[0]!).actor;
      },
    },
    {
      label: "extra event field",
      mutate: (candidate: Record<string, unknown>) => {
        ((candidate.events as Array<Record<string, unknown>>)[0]!).secret = "not public";
      },
    },
  ]) {
    const candidate = structuredClone(run) as unknown as Record<string, unknown>;
    invalid.mutate(candidate);
    assert.throws(
      () => assertMatches(schema, schema, candidate, invalid.label),
      /enum|required|additionalProperties|state|event/i,
      invalid.label,
    );
    assert.throws(
      () => migrateRunRecord(candidate),
      /invalid|required|unsupported/i,
      invalid.label,
    );
  }
});

test("run-record schema contains every stable policy failure code", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const failureCodes = schema.properties?.failure?.properties?.code?.enum;
  assert.deepEqual(
    failureCodes?.filter((code) => typeof code === "string" && code.startsWith("policy-")),
    [
      "policy-read-only-workspace-mutation",
      "policy-runtime-identity-mismatch",
      "policy-role-permission-mismatch",
      "policy-read-only-head-moved",
    ],
  );
});

test("persisted run config uses the exact config schema and rejects nested secrets", async (t) => {
  const configSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema & { $id?: string };
  const runSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  assert.equal(runSchema.properties?.config?.$ref, configSchema.$id);
  assert.equal(runSchema.additionalProperties, false);

  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-config-exact-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "config exactness", DEFAULT_CONFIG);
  (run.config as unknown as Record<string, unknown>).inlineToken = "must-not-survive";
  assert.throws(() => migrateRunRecord(run), /unsupported config field/i);
  delete (run.config as unknown as Record<string, unknown>).inlineToken;
  (run.config.policy as unknown as Record<string, unknown>).privateKey = "must-not-survive";
  assert.throws(() => migrateRunRecord(run), /unsupported config field/i);
  delete (run.config.policy as unknown as Record<string, unknown>).privateKey;
  (run as unknown as Record<string, unknown>).token = "must-not-survive";
  assert.throws(() => migrateRunRecord(run), /unsupported run record field/i);
  assert.throws(() => assertMatches(runSchema, runSchema, run, "run"), /additionalProperties/);
});

test("run-record schema and runtime migration reject non-positive GitHub installation ids", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-github-installation-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "check", DEFAULT_CONFIG);
  run.github = {
    installationId: 0,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "feature",
  };

  assert.equal(
    schema.properties?.github?.properties?.installationId?.minimum,
    1,
  );
  assert.throws(
    () => assertMatches(schema, schema, run, "run"),
    /github\.installationId/,
  );
  assert.throws(() => migrateRunRecord(run), /installationId/i);
});

test("run records durably validate bounded pending GitHub head cancellations", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-github-cancellation-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "check", DEFAULT_CONFIG);
  run.github = {
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "feature",
  };
  (run.github as unknown as Record<string, unknown>).pendingCancellationHeadShas = ["old-head"];

  assert.doesNotThrow(() => assertMatches(schema, schema, run, "run"));
  assert.doesNotThrow(() => migrateRunRecord(run));
  (run.github as unknown as Record<string, unknown>).pendingCancellationHeadShas = [
    "old-head",
    "old-head",
  ];
  assert.throws(() => migrateRunRecord(run), /pendingCancellationHeadShas/);
});

test("run migration rejects unsupported and malformed GitHub association fields", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  assert.deepEqual(schema.properties?.github?.dependentRequired, {
    suspensionReason: ["suspended"],
  });
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-github-exact-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema", "check", DEFAULT_CONFIG);
  run.github = {
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "feature",
  };
  (run.github as unknown as Record<string, unknown>).token = "must-not-be-retained";
  assert.throws(() => migrateRunRecord(run), /unsupported.*github.*token/i);
  delete (run.github as unknown as Record<string, unknown>).token;
  (run.github as unknown as Record<string, unknown>).repository = "not-a-repository";
  assert.throws(() => migrateRunRecord(run), /github\.repository/i);
});

test("run migration and schema reject whitespace-only GitHub identity fields", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  for (const field of ["baseSha", "headSha", "branch"] as const) {
    await t.test(field, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `maswe-schema-github-${field}-`));
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const run = await new FileRunStore(cwd).create("schema", "check", DEFAULT_CONFIG);
      run.github = {
        installationId: 1,
        repository: "owner/repo",
        pullRequestNumber: 1,
        baseSha: "base",
        headSha: "head",
        branch: "feature",
        [field]: "   ",
      };
      assert.throws(() => assertMatches(schema, schema, run, "run"), new RegExp(field));
      assert.throws(() => migrateRunRecord(run), new RegExp(field));
    });
  }
});

test("run-record schema validates optional bounded durable runtime failure metadata", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const failureSchema = schema.properties?.failure;
  const runtimeSchemaReference = failureSchema?.properties?.runtime;
  assert.ok(runtimeSchemaReference, "failure.runtime schema");
  const runtimeSchema = resolveRef(schema, runtimeSchemaReference);
  assert.deepEqual(runtimeSchema.required, [
    "attempts",
    "totalAttempts",
    "omittedAttempts",
    "aggregateTruncated",
  ]);

  const sample = {
    attempts: [
      {
        model: "cursor-grok-4.5-high",
        code: "cursor-cli-non-zero",
        message: "Cursor CLI exited non-zero.",
        requestedModel: "cursor-grok-4.5-high",
        configuredModel: "cursor-grok-4.5-high",
        exitCode: 7,
        timedOut: false,
        durationMs: 42,
        promptTransport: "stdin",
        stderrPresent: true,
        truncated: false,
      },
    ],
    totalAttempts: 1,
    omittedAttempts: 0,
    aggregateTruncated: false,
  };
  assertMatches(schema, runtimeSchema, sample, "failure.runtime");

  const attemptsSchema = runtimeSchema.properties?.attempts;
  assert.equal(attemptsSchema?.maxItems, 8);
  assert.ok(attemptsSchema?.items);
  const attemptSchema = resolveRef(schema, attemptsSchema.items);
  assert.equal(
    attemptSchema.properties?.message?.maxLength,
    512,
  );
  assert.equal(
    attemptSchema.properties?.model?.maxLength,
    256,
  );
});

test("durable runtime schema accepts only its documented nested allowlist", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas/run-record.schema.json"),
      "utf8",
    ),
  ) as JsonSchema;
  const runtimeReference = schema.properties?.failure?.properties?.runtime;
  assert.ok(runtimeReference);
  const runtimeSchema = resolveRef(schema, runtimeReference);
  const attemptsSchema = runtimeSchema.properties?.attempts;
  assert.ok(attemptsSchema?.items);
  const attemptSchema = resolveRef(schema, attemptsSchema.items);
  const validAttempt = {
    model: "cursor-grok-4.5-high",
    code: "cursor-cli-non-zero",
    message: "Cursor CLI exited non-zero.",
    requestedModel: "cursor-grok-4.5-high",
    configuredModel: "cursor-grok-4.5-high",
    exitCode: 7,
    timedOut: false,
    durationMs: 42,
    promptTransport: "stdin",
    stderrPresent: true,
    truncated: false,
  };
  const validSummary = {
    attempts: [validAttempt],
    totalAttempts: 1,
    omittedAttempts: 0,
    aggregateTruncated: false,
  };

  assert.doesNotThrow(() =>
    assertMatches(schema, attemptSchema, validAttempt, "validAttempt"),
  );
  assert.doesNotThrow(() =>
    assertMatches(schema, runtimeSchema, validSummary, "validSummary"),
  );

  const invalidCases: Array<{
    label: string;
    target: JsonSchema;
    value: unknown;
  }> = [
    {
      label: "attempt.adapterMetadata",
      target: attemptSchema,
      value: {
        ...validAttempt,
        adapterMetadata: { provider: "unsafe" },
      },
    },
    {
      label: "attempt.stderr",
      target: attemptSchema,
      value: {
        ...validAttempt,
        stderr: "raw runtime stderr",
      },
    },
    {
      label: "attempt.unknownObject",
      target: attemptSchema,
      value: {
        ...validAttempt,
        futureAdapterObject: { nested: true },
      },
    },
    {
      label: "attempt.prototypeNamedProperty",
      target: attemptSchema,
      value: {
        ...validAttempt,
        toString: "must not inherit schema properties",
      },
    },
    {
      label: "summary.arbitrary",
      target: runtimeSchema,
      value: {
        ...validSummary,
        arbitrarySummaryProperty: "unsafe",
      },
    },
  ];
  for (const invalid of invalidCases) {
    assert.throws(
      () =>
        assertMatches(
          schema,
          invalid.target,
          invalid.value,
          invalid.label,
        ),
      /additionalProperties/,
      invalid.label,
    );
  }
});

test("runtime failure code schema enum stays synchronized with the TypeScript union", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas/run-record.schema.json"),
      "utf8",
    ),
  ) as JsonSchema;
  const runtimeCodes = {
    "cursor-cli-non-zero": true,
    "cursor-cli-timeout": true,
    "cursor-cli-spawn": true,
    "cursor-sdk-error": true,
    "runtime-error": true,
    "invalid-transport-json": true,
    "unsupported-response-shape": true,
    "missing-logical-output": true,
  } satisfies Record<RuntimeFailureCode, true>;
  const attemptSchema = resolveRef(
    schema,
    schema.$defs?.durableRuntimeFailureAttempt ?? {},
  );

  assert.deepEqual(
    [...(attemptSchema.properties?.code?.enum ?? [])].sort(),
    Object.keys(runtimeCodes).sort(),
  );
});

test("schema accepts retry and supersede records with allowlisted runtime metadata", async (t) => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas/run-record.schema.json"),
      "utf8",
    ),
  ) as JsonSchema;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-schema-history-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("schema history", "check", DEFAULT_CONFIG);
  const failure = {
    code: "runtime-models-exhausted" as const,
    message: "runtime exhausted",
    at: "2026-07-27T00:00:00.000Z",
    resumeState: "BRAINSTORMING" as const,
    runtime: {
      attempts: [
        {
          model: "cursor-grok-4.5-high",
          code: "cursor-cli-non-zero" as const,
          message: "Cursor CLI exited non-zero.",
          stderrPresent: true,
          truncated: false,
        },
      ],
      totalAttempts: 1,
      omittedAttempts: 0,
      aggregateTruncated: false,
    },
  };
  run.failure = failure;
  await store.save(run);
  const failed = await store.applyEvent(run, "FAIL", "test", {
    reason: failure.message,
    runtime: failure.runtime,
    resumeState: failure.resumeState,
  });
  const previousFailure = failed.failure;
  delete failed.failure;
  const retried = await store.applyEvent(
    failed,
    "RETRY_FROM_FAILED",
    "test",
    {
      resumeState: "BRAINSTORMING",
      previousFailure,
    },
  );
  assert.doesNotThrow(() => assertMatches(schema, schema, retried, "retry"));

  const replacement = await store.create(
    retried.title,
    retried.request,
    retried.config,
  );
  retried.supersededBy = replacement.id;
  replacement.supersedes = retried.id;
  await store.save(retried);
  await store.save(replacement);

  for (const [label, record] of [
    ["superseded", await store.load(retried.id)],
    ["replacement", await store.load(replacement.id)],
  ] as const) {
    assert.doesNotThrow(() => assertMatches(schema, schema, record, label));
  }
});

test("schema version 1 still accepts historical unbounded failure messages", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const failureSchema = schema.properties?.failure;
  assert.ok(failureSchema);

  assert.doesNotThrow(() =>
    assertMatches(
      schema,
      failureSchema,
      {
        message: "historical stderr ".repeat(1_000),
        at: "2026-07-01T00:00:00.000Z",
      },
      "failure",
    )
  );
});

test("schema-version-1 migration loads an old failure record without runtime metadata", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-old-failure-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("old failure", "check", DEFAULT_CONFIG);
  const oldRecord = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  oldRecord.failure = {
    code: "workflow-failure",
    message: "historical failure",
    at: "2026-07-01T00:00:00.000Z",
    resumeState: "BRAINSTORMING",
  };

  const migrated = migrateRunRecord(oldRecord);

  assert.deepEqual(migrated.failure, oldRecord.failure);
  assert.equal(
    "runtime" in (migrated.failure as unknown as Record<string, unknown>),
    false,
  );
});

test("schema-version-1 migration bounds and sanitizes optional runtime metadata", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-runtime-migration-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("runtime migration", "check", DEFAULT_CONFIG);
  const canary = "MIGRATION_RUNTIME_CANARY";
  const raw = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  raw.failure = {
    code: "runtime-models-exhausted",
    message: `token=${canary}`,
    at: "2026-07-01T00:00:00.000Z",
    runtime: {
      attempts: Array.from({ length: 12 }, (_, index) => ({
        model: `model-${index}\n | forged [runtime-error]: entry`,
        code: index === 0 ? "not-a-runtime-code" : "runtime-error",
        message: `token=${canary}-${index}${"x".repeat(1_000)}`,
        requestedModel: `requested-${index}\u0000`,
        stderrPresent: true,
        truncated: false,
        adapterMetadata: { raw: canary },
      })),
      totalAttempts: 12,
      omittedAttempts: 0,
      aggregateTruncated: true,
      adapterMetadata: { raw: canary },
    },
  };

  const migrated = migrateRunRecord(raw);
  const serialized = JSON.stringify(migrated.failure);
  const runtime = migrated.failure?.runtime;

  assert.equal(serialized.includes(canary), false);
  assert.ok(runtime);
  assert.equal(runtime.attempts.length, 8);
  assert.equal(runtime.totalAttempts, 12);
  assert.equal(runtime.omittedAttempts, 4);
  assert.equal(runtime.attempts[0]?.code, "runtime-error");
  assert.ok(
    runtime.attempts.every(
      (attempt) =>
        [...attempt.message].length <= 512 &&
        !/[\r\n\u0000-\u001f\u007f-\u009f]/.test(attempt.model) &&
        !/[\r\n\u0000-\u001f\u007f-\u009f]/.test(
          attempt.requestedModel ?? "",
        ) &&
        !("adapterMetadata" in attempt),
    ),
  );
  assert.equal("adapterMetadata" in runtime, false);
});

test("run-record schema rejects non-hex sha256 digests", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const artifactSchema = schema.properties?.artifacts?.items;
  assert.ok(artifactSchema);
  assert.throws(
    () =>
      assertMatches(
        schema,
        artifactSchema!,
        {
          name: "x",
          logicalName: "x",
          attempt: 1,
          path: "x",
          sha256: "z".repeat(64),
          createdAt: new Date().toISOString(),
        },
        "artifact",
      ),
    /pattern/,
  );
});

test("config schema accepts stream-json outputFormat and rejects unknown values", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;
  const outputFormat = schema.properties?.runtime?.properties?.outputFormat;
  assert.ok(outputFormat?.enum);
  assert.deepEqual(outputFormat.enum, ["json", "text", "stream-json"]);

  const withStream = structuredClone(DEFAULT_CONFIG);
  withStream.runtime.outputFormat = "stream-json";
  assertMatches(schema, schema, withStream, "config.stream-json");

  const bad = structuredClone(DEFAULT_CONFIG) as { runtime: { outputFormat: string } };
  bad.runtime.outputFormat = "yaml";
  assert.throws(() => assertMatches(schema, schema, bad, "config.bad-format"), /enum/);
});

test("config schema validates doctorProbeTimeoutMs bounds and integer type", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as JsonSchema;

  const min = structuredClone(DEFAULT_CONFIG);
  (min.policy as Record<string, unknown>).doctorProbeTimeoutMs = 1_000;
  assert.doesNotThrow(() => assertMatches(schema, schema, min, "config.doctorProbeTimeoutMs.min"));

  const max = structuredClone(DEFAULT_CONFIG);
  (max.policy as Record<string, unknown>).doctorProbeTimeoutMs = 300_000;
  assert.doesNotThrow(() => assertMatches(schema, schema, max, "config.doctorProbeTimeoutMs.max"));

  const tooLow = structuredClone(DEFAULT_CONFIG);
  (tooLow.policy as Record<string, unknown>).doctorProbeTimeoutMs = 999;
  assert.throws(
    () => assertMatches(schema, schema, tooLow, "config.doctorProbeTimeoutMs.low"),
    /config\.doctorProbeTimeoutMs\.low/,
  );

  const tooHigh = structuredClone(DEFAULT_CONFIG);
  (tooHigh.policy as Record<string, unknown>).doctorProbeTimeoutMs = 300_001;
  assert.throws(
    () => assertMatches(schema, schema, tooHigh, "config.doctorProbeTimeoutMs.high"),
    /config\.doctorProbeTimeoutMs\.high/,
  );

  const fractional = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  (fractional.policy as Record<string, unknown>).doctorProbeTimeoutMs = 1.5;
  assert.throws(
    () => assertMatches(schema, schema, fractional, "config.doctorProbeTimeoutMs.fractional"),
    /integer/,
  );
});
