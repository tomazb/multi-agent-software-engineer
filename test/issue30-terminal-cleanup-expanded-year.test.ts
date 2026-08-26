import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";

type RunRecordSchema = {
  properties?: {
    terminalCleanup?: {
      properties?: {
        updatedAt?: {
          pattern?: string;
        };
      };
    };
  };
};

test("terminal cleanup schema and runtime reject expanded-year timestamps", async (t) => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as RunRecordSchema;
  const pattern = schema.properties?.terminalCleanup?.properties?.updatedAt?.pattern;
  assert.ok(pattern, "terminalCleanup.updatedAt pattern");
  const timestampPattern = new RegExp(pattern);

  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-cleanup-expanded-year-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const run = await new FileRunStore(cwd).create(
    "cleanup timestamp parity",
    "reject expanded years",
    DEFAULT_CONFIG,
  );

  for (const updatedAt of [
    "+010000-01-01T00:00:00.000Z",
    "-000001-01-01T00:00:00.000Z",
  ]) {
    assert.equal(timestampPattern.test(updatedAt), false, updatedAt);
    const candidate = structuredClone(run);
    candidate.state = "COMPLETED";
    candidate.terminalCleanup = { status: "pending", updatedAt };
    assert.throws(
      () => migrateRunRecord(candidate),
      /terminalCleanup\.updatedAt|four-digit year/i,
      updatedAt,
    );
  }

  const canonical = structuredClone(run);
  canonical.state = "COMPLETED";
  canonical.terminalCleanup = {
    status: "pending",
    updatedAt: "2024-02-29T23:59:59.999Z",
  };
  assert.equal(timestampPattern.test(canonical.terminalCleanup.updatedAt), true);
  assert.doesNotThrow(() => migrateRunRecord(canonical));
});
