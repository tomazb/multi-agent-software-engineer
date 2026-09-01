import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunRecord } from "../src/domain.ts";
import {
  buildCommentClassifierPrompt,
  buildRolePrompt,
} from "../src/prompt-builder.ts";
import type { RunStore } from "../src/store.ts";

function makeRun(): RunRecord {
  return {
    schemaVersion: 1,
    version: 1,
    id: "issue-43-review-governance",
    title: "Evidence-backed review governance",
    request: "Implement the approved Issue #43 policy tranche.",
    repositoryPath: "/repository",
    state: "PR_REVIEW",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    approvals: { brainstorm: true, design: true },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: structuredClone(DEFAULT_CONFIG),
    artifacts: [],
    events: [],
  };
}

function artifactStore(values: Record<string, string> = {}): RunStore {
  return {
    readArtifact: async (_run, name) => values[name],
  } as RunStore;
}

function assertInOrder(text: string, fragments: RegExp[]): void {
  let offset = 0;
  for (const fragment of fragments) {
    const match = fragment.exec(text.slice(offset));
    assert.ok(match, `Expected ${fragment} after offset ${offset}`);
    offset += match.index + match[0].length;
  }
}

test("verifier blockers are evidence-backed and remediation is a separate architecture decision", async () => {
  const prompt = await buildRolePrompt("verifier", makeRun(), artifactStore());

  assertInOrder(prompt, [
    /every blocking finding/i,
    /governing requirement|acceptance criterion|invariant|approved behavior/i,
    /concrete reachable (failure|impact)/i,
    /supporting (code|test|diff|execution) evidence/i,
    /smallest safe remediation/i,
  ]);
  assert.match(
    prompt,
    /defect.*(separate|independent).*remediation|remediation.*(separate|independent).*defect/is,
  );
  assert.match(
    prompt,
    /architectural.*persisted state.*workflow state.*configuration.*compatibility.*retry.*abstraction.*backend.*dependency.*security/is,
  );
  assert.match(
    prompt,
    /unnecessary[- ]complexity.*states.*branches.*retries.*compatibility.*abstractions.*configuration.*defensive/is,
  );
  assert.match(
    prompt,
    /uncertainty|missing evidence/i,
  );
});

test("classifier can validate a defect while routing architectural remediation to human specification disposition", async () => {
  const prompt = await buildCommentClassifierPrompt(
    makeRun(),
    artifactStore({
      "03-specification-and-design.md": "The approved design changes prompts and documentation only.",
    }),
    "Reviewer reports a concrete defect and proposes adding a persisted retry controller.",
  );

  assertInOrder(prompt, [
    /defect validity|valid.*defect/i,
    /proposed remediation|remediation disposition/i,
    /architectural/i,
    /human|specification/i,
  ]);
  assert.match(
    prompt,
    /valid defect.*(out[- ]of[- ]scope|outside).*remediation|remediation.*(out[- ]of[- ]scope|outside).*valid defect/is,
  );
  assert.match(prompt, /minimal permitted change/i);
  assert.match(prompt, /design decision.*outside.*correction loop/is);
  assert.match(prompt, /SCOPE: IN_SCOPE[\s\S]*SCOPE: OUT_OF_SCOPE/);
});

test("resolver implements only authorized minimal corrections and reports design insufficiency", async () => {
  const prompt = await buildRolePrompt(
    "prResolver",
    makeRun(),
    artifactStore({
      "03-specification-and-design.md": "The approved design changes prompts and documentation only.",
      "07-review-comment.md": "The reviewer proposes a new persistence-backed retry subsystem.",
      "08-comment-classification.md": "The defect is valid; the proposed architecture is not approved.",
    }),
  );

  assertInOrder(prompt, [
    /verify the reviewer concern/i,
    /governing requirement|approved requirement/i,
    /smallest.*correction/i,
    /authorized|approved design/i,
  ]);
  assert.match(prompt, /do not.*adopt.*reviewer.*architecture|avoid.*reviewer.*architecture/is);
  assert.match(
    prompt,
    /valid defect.*design decision|approved architecture.*insufficient.*design decision/is,
  );
  assert.match(
    prompt,
    /do not resolve the GitHub thread.*fresh verifier.*CI/is,
  );
});

test("AGENTS policy preserves requirements before simplification and establishes single-writer authority", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");

  assertInOrder(agents, [
    /correctness.*safety.*security.*concurrency.*recovery.*idempotency.*audit.*evidence.*compatibility/is,
    /precedence|take precedence/i,
    /YAGNI.*KISS.*DRY/is,
  ]);
  assertInOrder(agents, [
    /preserve governing requirements|preserve.*approved behavior/i,
    /do not add requirements/i,
    /smallest clear and explicit model/i,
    /share authoritative knowledge/i,
  ]);
  assert.match(agents, /MASWE.*durable orchestration authority/is);
  assert.match(agents, /Superpowers.*engineering methodology/is);
  assert.match(agents, /one designated writer.*mutable branch.*worktree/is);
  assert.match(agents, /writer handoff.*stop.*refresh.*exact.*HEAD/is);
});

test("artifact contracts describe review report semantics without changing terminal markers", async () => {
  const contracts = await readFile(
    new URL("../docs/ARTIFACT_CONTRACTS.md", import.meta.url),
    "utf8",
  );

  assert.match(
    contracts,
    /verification report.*governing requirement.*reachable.*evidence.*smallest safe remediation/is,
  );
  assert.match(
    contracts,
    /comment classification.*defect validity.*remediation.*design decision/is,
  );
  assert.match(
    contracts,
    /resolution report.*authorized.*minimal correction.*design decision/is,
  );
  assert.match(
    contracts,
    /report semantics.*do not.*change.*terminal marker|terminal markers.*remain unchanged/is,
  );
});

test("role permissions and terminal-marker constraints remain unchanged", async () => {
  const run = makeRun();
  const [verifier, classifier, resolver] = await Promise.all([
    buildRolePrompt("verifier", run, artifactStore()),
    buildCommentClassifierPrompt(run, artifactStore(), "Review comment."),
    buildRolePrompt("prResolver", run, artifactStore()),
  ]);

  assert.match(verifier, /read-only and must not change the workspace/i);
  assert.match(classifier, /read-only task\. Do not modify the workspace/i);
  assert.match(verifier, /VERDICT: PASS[\s\S]*VERDICT: FAIL/);
  assert.match(classifier, /SCOPE: IN_SCOPE[\s\S]*SCOPE: OUT_OF_SCOPE/);
  assert.match(resolver, /RESOLUTION_COMPLETE/);
  for (const prompt of [verifier, classifier, resolver]) {
    assert.match(prompt, /very last line|final line/i);
    assert.match(prompt, /only on that final line|may appear only on that final line|token may appear only on that final line/i);
  }
});
