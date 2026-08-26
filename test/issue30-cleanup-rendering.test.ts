import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import { renderRun, renderTerminalCleanup } from "../src/run-rendering.ts";

function terminalRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    version: 1,
    id: `render-${randomUUID()}`,
    title: "Terminal cleanup rendering",
    request: "Render cleanup disposition.",
    repositoryPath: "/tmp/generated-rendering",
    state: "COMPLETED",
    createdAt: now,
    updatedAt: now,
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: structuredClone(DEFAULT_CONFIG),
    artifacts: [],
    events: [],
    ...overrides,
  };
}

test("renderTerminalCleanup returns no line for nonterminal runs", () => {
  const run = terminalRun({ state: "CI_RUNNING" });
  assert.equal(renderTerminalCleanup(run), undefined);
});

test("renderTerminalCleanup renders complete disposition", () => {
  const run = terminalRun({
    terminalCleanup: { status: "complete", updatedAt: new Date().toISOString() },
  });
  assert.equal(renderTerminalCleanup(run), "Terminal cleanup: complete");
});

test("renderTerminalCleanup renders pending disposition", () => {
  const run = terminalRun({
    state: "FAILED",
    terminalCleanup: { status: "pending", updatedAt: new Date().toISOString() },
  });
  assert.equal(renderTerminalCleanup(run), "Terminal cleanup: pending");
});

test("renderRun includes pending terminal cleanup line", () => {
  const output = renderRun(
    terminalRun({
      state: "CANCELLED",
      terminalCleanup: { status: "pending", updatedAt: new Date().toISOString() },
    }),
  );
  assert.match(output, /Terminal cleanup: pending/);
});

test("renderTerminalCleanup renders failed cleanup with sanitized diagnostic", () => {
  const run = terminalRun({
    state: "FAILED",
    failure: {
      code: "workflow-failure",
      message: "engineering failure diagnostic",
      at: new Date().toISOString(),
      resumeState: "BUILDING",
    },
    terminalCleanup: {
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: {
        code: "cleanup-remove-failed",
        message: "exact worktree remained registered",
      },
    },
  });
  assert.equal(
    renderTerminalCleanup(run),
    "Terminal cleanup: failed (cleanup-remove-failed): exact worktree remained registered",
  );
});

test("renderTerminalCleanup renders preserved recovery disposition", () => {
  const run = terminalRun({
    state: "FAILED",
    terminalCleanup: {
      status: "preserved",
      updatedAt: new Date().toISOString(),
      preservationReason: "publication-outcome-unknown",
    },
  });
  assert.equal(
    renderTerminalCleanup(run),
    "Terminal cleanup: preserved (publication-outcome-unknown)",
  );
});

test("renderTerminalCleanup renders legacy omission as unknown", () => {
  const run = terminalRun({ state: "COMPLETED" });
  assert.equal(renderTerminalCleanup(run), "Terminal cleanup: unknown (legacy record)");
});

test("renderRun includes terminal cleanup independently from engineering failure", () => {
  const run = terminalRun({
    state: "FAILED",
    failure: {
      code: "workflow-failure",
      message: "engineering failure diagnostic",
      at: new Date().toISOString(),
      resumeState: "BUILDING",
    },
    terminalCleanup: {
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: {
        code: "cleanup-remove-failed",
        message: "exact worktree remained registered",
      },
    },
  });
  const output = renderRun(run);
  assert.match(output, /Failure: engineering failure diagnostic/);
  assert.match(output, /Failure code: workflow-failure/);
  assert.match(
    output,
    /Terminal cleanup: failed \(cleanup-remove-failed\): exact worktree remained registered/,
  );
});

test("renderRun includes preserved cleanup without engineering failure lines", () => {
  const run = terminalRun({
    state: "FAILED",
    terminalCleanup: {
      status: "preserved",
      updatedAt: new Date().toISOString(),
      preservationReason: "publication-outcome-unknown",
    },
  });
  const output = renderRun(run);
  assert.match(output, /Terminal cleanup: preserved \(publication-outcome-unknown\)/);
  assert.equal(output.includes("Failure:"), false);
});

test("renderRun includes legacy cleanup unknown line for terminal records", () => {
  const output = renderRun(terminalRun({ state: "CANCELLED" }));
  assert.match(output, /Terminal cleanup: unknown \(legacy record\)/);
});
