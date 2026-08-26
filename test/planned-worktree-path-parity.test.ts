import assert, { AssertionError } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { isPortableDurableAbsolutePath, PORTABLE_DURABLE_ABSOLUTE_PATH_PATTERN } from "../src/run-record-validation.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";

type JsonSchema = {
  $ref?: string;
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  type?: string | string[];
  minLength?: number;
  pattern?: string;
  const?: unknown;
  additionalProperties?: boolean;
  not?: JsonSchema;
};

function resolveRef(root: JsonSchema, schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  throw new Error(`Unsupported $ref ${schema.$ref}`);
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
    } catch (error) {
      conditionMatches = false;
      if (!(error instanceof AssertionError)) throw error;
    }
    if (conditionMatches) {
      assertMatches(root, effective.then, value, `${label}.then`);
    }
  }
  if (effective.not) {
    let forbiddenMatches = true;
    try {
      assertMatches(root, effective.not, value, `${label}.not`);
    } catch (error) {
      forbiddenMatches = false;
      if (!(error instanceof AssertionError)) throw error;
    }
    assert.equal(forbiddenMatches, false, `${label} not`);
  }
  if (effective.required) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
    for (const key of effective.required) {
      assert.ok(Object.hasOwn(value as object, key), `${label}.${key}`);
    }
  }
  if (effective.type) {
    const types = Array.isArray(effective.type) ? effective.type : [effective.type];
    if (types.includes("object")) {
      assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
    }
    if (types.includes("string")) {
      assert.equal(typeof value, "string", label);
    }
  }
  if (typeof value === "string") {
    if (effective.minLength !== undefined) {
      assert.ok(value.length >= effective.minLength, `${label} minLength`);
    }
    if (effective.pattern) {
      assert.match(value, new RegExp(effective.pattern), `${label} pattern`);
    }
  }
  if (effective.const !== undefined) {
    assert.equal(value, effective.const, label);
  }
  if (effective.additionalProperties === false && value && typeof value === "object") {
    const allowed = new Set(Object.keys(effective.properties ?? {}));
    for (const key of Object.keys(value)) {
      assert.ok(allowed.has(key), `${label} additionalProperties:${key}`);
    }
  }
  if (effective.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(effective.properties)) {
      if (Object.hasOwn(value, key)) {
        assertMatches(root, child, (value as Record<string, unknown>)[key], `${label}.${key}`);
      }
    }
  }
}

const PARITY_CASES = [
  { path: "/tmp/maswe-worktrees/run", accepted: true, label: "posix absolute" },
  { path: "/", accepted: true, label: "posix root" },
  { path: "C:\\maswe-worktrees\\run", accepted: true, label: "windows drive absolute" },
  { path: "C:/maswe-worktrees/run", accepted: true, label: "windows drive absolute forward slash" },
  { path: "\\\\server\\share", accepted: true, label: "windows UNC share root" },
  {
    path: "\\\\server\\share\\maswe-worktrees\\run",
    accepted: true,
    label: "windows UNC",
  },
  { path: "/tmp/maswe worktrees/run", accepted: true, label: "posix with internal space" },
  { path: "C:\\maswe worktrees\\run", accepted: true, label: "windows drive with internal space" },
  { path: "\\\\server\\my share\\run", accepted: true, label: "windows UNC with internal space" },
  {
    path: "\\maswe-worktrees\\run",
    accepted: false,
    label: "windows drive-less rooted",
  },
  { path: "C:maswe-worktrees\\run", accepted: false, label: "windows drive-relative" },
  { path: "relative/path", accepted: false, label: "relative" },
  { path: "./relative", accepted: false, label: "dot relative" },
  { path: "../relative", accepted: false, label: "dotdot relative" },
  { path: "/tmp/maswe-worktrees/run ", accepted: false, label: "posix trailing space" },
  { path: "/tmp/maswe-worktrees/run\t", accepted: false, label: "posix trailing tab" },
  { path: "/tmp/maswe-worktrees/run\n", accepted: false, label: "posix trailing newline" },
  { path: "C:\\maswe-worktrees\\run ", accepted: false, label: "windows drive trailing space" },
  { path: "C:/maswe-worktrees/run\t", accepted: false, label: "windows drive trailing tab" },
  { path: "\\\\server\\share\\run ", accepted: false, label: "windows UNC trailing space" },
  { path: "\\\\server\\share\\run\t", accepted: false, label: "windows UNC trailing tab" },
  { path: "/ ", accepted: false, label: "posix root trailing space" },
  { path: "C:\\ ", accepted: false, label: "windows drive root trailing space" },
  { path: "\\\\server\\share ", accepted: false, label: "windows UNC share trailing space" },
] as const;

test("plannedWorktreePath schema and runtime share portable absolute-path parity", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as JsonSchema;
  const bootstrapSchema = schema.properties!.workspaceBootstrap!;

  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-planned-path-parity-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("feature", "planned path parity", DEFAULT_CONFIG);
  const runPath = path.join(store.root, run.id, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as Record<string, unknown>;

  const baseBootstrap = {
    mode: "isolated-worktree",
    sourceBaseSha: "a".repeat(40),
    sourceBranch: "main",
    sourceTreeFingerprint: "b".repeat(64),
    plannedAt: "2026-08-26T00:00:00.000Z",
  };

  // Document the Windows-specific host gap: win32 path.isAbsolute accepts drive-less
  // rooted paths that the published portable grammar rejects. Linux CI cannot reproduce
  // native Windows acceptance of that form via host path.isAbsolute(), so parity must be
  // enforced by a host-independent durable-path validator rather than path.isAbsolute alone.
  assert.equal(
    path.win32.isAbsolute("\\maswe-worktrees\\run"),
    true,
    "win32.isAbsolute accepts drive-less rooted paths (Windows bug surface)",
  );
  assert.throws(
    () =>
      assertMatches(
        schema,
        bootstrapSchema,
        { ...baseBootstrap, plannedWorktreePath: "\\maswe-worktrees\\run" },
        "schema drive-less",
      ),
    /pattern/,
    "published schema rejects drive-less rooted Windows paths",
  );

  for (const sample of PARITY_CASES) {
    const bootstrap = { ...baseBootstrap, plannedWorktreePath: sample.path };
    const schemaOk = (() => {
      try {
        assertMatches(schema, bootstrapSchema, bootstrap, sample.label);
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(schemaOk, sample.accepted, `schema:${sample.label}`);

    assert.equal(
      isPortableDurableAbsolutePath(sample.path),
      sample.accepted,
      `predicate:${sample.label}`,
    );

    const candidate = structuredClone(raw);
    candidate.workspaceBootstrap = bootstrap;
    if (sample.accepted) {
      assert.doesNotThrow(
        () => migrateRunRecord(candidate),
        `runtime must accept ${sample.label}: ${JSON.stringify(sample.path)}`,
      );
      const migrated = migrateRunRecord(candidate);
      assert.equal(
        migrated.workspaceBootstrap?.plannedWorktreePath,
        sample.path,
        `runtime preserves ${sample.label}`,
      );
    } else {
      assert.throws(
        () => migrateRunRecord(candidate),
        /absolute|plannedWorktreePath|canonical/i,
        `runtime must reject ${sample.label}: ${JSON.stringify(sample.path)}`,
      );
    }
  }

  // Schema pattern and runtime predicate must stay behaviorally locked.
  const publishedPattern = bootstrapSchema.properties!.plannedWorktreePath!.pattern!;
  assert.equal(typeof publishedPattern, "string");
  const publishedRe = new RegExp(publishedPattern);
  for (const sample of PARITY_CASES) {
    assert.equal(
      publishedRe.test(sample.path),
      PORTABLE_DURABLE_ABSOLUTE_PATH_PATTERN.test(sample.path),
      `schema/runtime drift:${sample.label}`,
    );
    assert.equal(
      isPortableDurableAbsolutePath(sample.path),
      PORTABLE_DURABLE_ABSOLUTE_PATH_PATTERN.test(sample.path),
      `predicate delegates to shared pattern:${sample.label}`,
    );
  }

  // Historical omission remains valid; operator-checkout forbids the field.
  assert.doesNotThrow(() =>
    assertMatches(schema, bootstrapSchema, baseBootstrap, "historical omit"),
  );
  const omitCandidate = structuredClone(raw);
  omitCandidate.workspaceBootstrap = baseBootstrap;
  assert.doesNotThrow(() => migrateRunRecord(omitCandidate));

  const operatorBootstrap = {
    mode: "operator-checkout",
    sourceBaseSha: "a".repeat(40),
    sourceBranch: "main",
    sourceTreeFingerprint: "b".repeat(64),
    plannedAt: "2026-08-26T00:00:00.000Z",
    plannedWorktreePath: "/tmp/should-not-exist-for-operator",
  };
  assert.throws(
    () => assertMatches(schema, bootstrapSchema, operatorBootstrap, "operator+planned"),
    /not|plannedWorktreePath|required/i,
  );
  const operatorCandidate = structuredClone(raw);
  operatorCandidate.workspaceBootstrap = operatorBootstrap;
  operatorCandidate.config = structuredClone(DEFAULT_CONFIG);
  (operatorCandidate.config as { policy: { useIsolatedWorktree: boolean } }).policy
    .useIsolatedWorktree = false;
  assert.throws(
    () => migrateRunRecord(operatorCandidate),
    /operator-checkout|plannedWorktreePath/i,
  );
});
