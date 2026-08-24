import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import {
  buildCommentClassifierPrompt,
  buildRolePrompt,
  renderPromptTemplate,
} from "../src/prompt-builder.ts";
import type { RunStore } from "../src/store.ts";

function makeRun(request: string): RunRecord {
  return {
    schemaVersion: 1,
    version: 1,
    id: "issue-29-prompt-rendering",
    title: "Literal prompt values",
    request,
    repositoryPath: "/repository",
    state: "BUILDING",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: structuredClone(DEFAULT_CONFIG),
    artifacts: [],
    events: [],
  };
}

function artifactStore(values: Record<string, string>): RunStore {
  return {
    readArtifact: async (_run, name) => values[name],
  } as RunStore;
}

test("replacement values are literal and never rescanned", () => {
  assert.equal(
    renderPromptTemplate("A={{A}} B={{B}}", { A: "{{B}}", B: "expanded" }),
    "A={{B}} B=expanded",
  );
});

test("unknown prompt placeholders fail deterministically", () => {
  assert.throws(
    () => renderPromptTemplate("{{KNOWN}} {{UNKNOWN}}", { KNOWN: "{{UNTRUSTED}}" }),
    (error: Error) =>
      error.message === "Unknown prompt placeholder {{UNKNOWN}}" &&
      !error.message.includes("{{UNTRUSTED}}"),
  );
});

test("brainstorm prompts preserve placeholder-shaped requests literally", async () => {
  const prompt = await buildRolePrompt(
    "brainstormer",
    makeRun("request {{DESIGN}}"),
    artifactStore({}),
  );

  assert.match(prompt, /request \{\{DESIGN\}\}/);
});

test("role prompts preserve placeholder-shaped requests and artifact handoffs literally", async () => {
  const run = makeRun("request {{DESIGN}}");
  const store = artifactStore({
    "02-brainstorm.md": "brainstorm {{DESIGN}}",
    "03-specification-and-design.md": "design {{BUILDER_REPORT}}",
    "04-builder-report.md": "builder report {{QUALITY_REPORT}}",
    "05-quality-report.md": "quality {{VERIFICATION_REPORT}}",
    "06-verification-report.md": "verification {{VERIFIER_DEFECTS}}",
    "10-verifier-defects.md": "defects {{COMMENT}}",
    "07-review-comment.md": "comment {{CLASSIFICATION}}",
    "08-comment-classification.md": "classification {{REQUEST}}",
  });

  const [designer, builder, verifier, resolver] = await Promise.all([
    buildRolePrompt("designer", run, store),
    buildRolePrompt("builder", run, store),
    buildRolePrompt("verifier", run, store),
    buildRolePrompt("prResolver", run, store),
  ]);

  for (const prompt of [designer, builder, verifier, resolver]) {
    assert.match(prompt, /request \{\{DESIGN\}\}/);
  }
  assert.match(designer, /brainstorm \{\{DESIGN\}\}/);
  assert.match(builder, /brainstorm \{\{DESIGN\}\}/);
  assert.match(builder, /design \{\{BUILDER_REPORT\}\}/);
  assert.match(verifier, /design \{\{BUILDER_REPORT\}\}/);
  assert.match(resolver, /design \{\{BUILDER_REPORT\}\}/);
  assert.match(verifier, /builder report \{\{QUALITY_REPORT\}\}/);
  assert.match(builder, /quality \{\{VERIFICATION_REPORT\}\}/);
  assert.match(verifier, /quality \{\{VERIFICATION_REPORT\}\}/);
  assert.match(builder, /verification \{\{VERIFIER_DEFECTS\}\}/);
  assert.match(builder, /defects \{\{COMMENT\}\}/);
  assert.match(resolver, /comment \{\{CLASSIFICATION\}\}/);
  assert.match(resolver, /classification \{\{REQUEST\}\}/);
});

test("rendered builder prompts preserve the simplification contract", async () => {
  const prompt = await buildRolePrompt(
    "builder",
    makeRun("implement the approved change"),
    artifactStore({}),
  );

  assert.match(
    prompt,
    /before declaring the implementation ready for deterministic CI and subsequent independent verification/i,
  );
  assert.match(
    prompt,
    /Simplification review outcome: summarize safe in-scope simplifications applied, or state that none were identified\./,
  );
  assert.match(
    prompt,
    /Do not weaken safety, security, concurrency, recovery, idempotency, audit, evidence, parity, compatibility, or operator-facing guarantees through simplification\./,
  );
  assert.match(
    prompt,
    /Preserve public and operator-facing interfaces, persisted state, checkpoint contracts, errors, and observable outcomes unless the approved change explicitly revises them\./,
  );
});

test("comment classifier prompts preserve placeholder-shaped review comments literally", async () => {
  const prompt = await buildCommentClassifierPrompt(
    makeRun("request {{DESIGN}}"),
    artifactStore({ "03-specification-and-design.md": "design {{COMMENT}}" }),
    "review comment {{DESIGN}}",
  );

  assert.match(prompt, /request \{\{DESIGN\}\}/);
  assert.match(prompt, /design \{\{COMMENT\}\}/);
  assert.match(prompt, /review comment \{\{DESIGN\}\}/);
});
