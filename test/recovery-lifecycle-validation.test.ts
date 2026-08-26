import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { WORKFLOW_STATES, type RunRecord, type WorkflowState } from "../src/domain.ts";
import { FileRunStore } from "../src/store.ts";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const AT = "2026-08-19T00:00:00.000Z";

function bootstrap(mode: "operator-checkout" | "isolated-worktree" = "isolated-worktree") {
  return {
    mode,
    sourceBaseSha: HEAD_A,
    sourceBranch: "main",
    sourceTreeFingerprint: "c".repeat(64),
    plannedAt: AT,
  } as const;
}

function revalidation() {
  return {
    returnState: "PR_REVIEW",
    source: "github",
    originHeadSha: HEAD_A,
    requestedHeadSha: HEAD_B,
    generation: 1,
    requestedAt: AT,
    updatedAt: AT,
  } as const;
}

async function fixture(t: test.TestContext): Promise<{
  store: FileRunStore;
  raw: RunRecord;
  publish: (candidate: RunRecord) => Promise<void>;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-recovery-lifecycle-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("recovery lifecycle", "validate at load", DEFAULT_CONFIG);
  const runPath = path.join(store.root, run.id, "run.json");
  const raw = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
  return {
    store,
    raw,
    publish: (candidate) => writeFile(runPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8"),
  };
}

function setFailure(run: RunRecord, resumeState: WorkflowState | undefined): void {
  if (resumeState === undefined) {
    delete run.failure;
    return;
  }
  run.failure = { message: "recover", at: AT, resumeState };
}

test("historical schema-v1 records may omit both optional recovery metadata fields in every state", async (t) => {
  const { store, raw, publish } = await fixture(t);
  for (const state of WORKFLOW_STATES) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    delete candidate.workspaceBootstrap;
    delete candidate.revalidation;
    delete candidate.failure;
    await publish(candidate);
    assert.equal((await store.load(candidate.id)).state, state);
  }
});

test("workspace bootstrap metadata accepts only the exact legal state and resume matrix", async (t) => {
  const { store, raw, publish } = await fixture(t);
  const legal: Array<[WorkflowState, WorkflowState | undefined]> = [
    ["CREATED", undefined],
    ["FAILED", "CREATED"],
    ["CANCELLED", undefined],
    ["CANCELLED", "CREATED"],
  ];
  for (const [state, resumeState] of legal) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    candidate.workspaceBootstrap = bootstrap();
    setFailure(candidate, resumeState);
    await publish(candidate);
    assert.equal((await store.load(candidate.id)).state, state);
  }

  const invalid: Array<[WorkflowState, WorkflowState | undefined]> = [
    ["BRAINSTORMING", undefined],
    ["CREATED", "CREATED"],
    ["FAILED", undefined],
    ["FAILED", "BUILDING"],
    ["CANCELLED", "BUILDING"],
  ];
  for (const [state, resumeState] of invalid) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    candidate.workspaceBootstrap = bootstrap();
    setFailure(candidate, resumeState);
    await publish(candidate);
    await assert.rejects(store.load(candidate.id), /workspaceBootstrap.*state|bootstrap.*resume/i);
  }
  for (const state of ["FAILED", "CANCELLED"] as const) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    candidate.workspaceBootstrap = bootstrap();
    candidate.failure = { message: "recover", at: AT };
    await publish(candidate);
    await assert.rejects(store.load(candidate.id), /workspaceBootstrap.*state|bootstrap.*resume/i);
  }
});

test("active revalidation metadata accepts only active states or their exact failed/cancelled resumes", async (t) => {
  const { store, raw, publish } = await fixture(t);
  const active = ["BUILDING", "CI_RUNNING", "VERIFYING"] as const;
  const legal: Array<[WorkflowState, WorkflowState | undefined]> = [
    ...active.map((state) => [state, undefined] as [WorkflowState, undefined]),
    ...active.map((resume) => ["FAILED", resume] as [WorkflowState, WorkflowState]),
    ["CANCELLED", undefined],
    ...active.map((resume) => ["CANCELLED", resume] as [WorkflowState, WorkflowState]),
  ];
  for (const [state, resumeState] of legal) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    candidate.revalidation = revalidation();
    setFailure(candidate, resumeState);
    await publish(candidate);
    assert.equal((await store.load(candidate.id)).state, state);
  }

  const invalid: Array<[WorkflowState, WorkflowState | undefined]> = [
    ["PR_REVIEW", undefined],
    ["BUILDING", "BUILDING"],
    ["FAILED", undefined],
    ["FAILED", "PR_REVIEW"],
    ["CANCELLED", "PR_REVIEW"],
  ];
  for (const [state, resumeState] of invalid) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    candidate.revalidation = revalidation();
    setFailure(candidate, resumeState);
    await publish(candidate);
    await assert.rejects(store.load(candidate.id), /revalidation.*state|revalidation.*resume/i);
  }
  for (const state of ["FAILED", "CANCELLED"] as const) {
    const candidate = structuredClone(raw);
    candidate.state = state;
    candidate.revalidation = revalidation();
    candidate.failure = { message: "recover", at: AT };
    await publish(candidate);
    await assert.rejects(store.load(candidate.id), /revalidation.*state|revalidation.*resume/i);
  }
});

test("recovery metadata rejects policy-mode contradictions, simultaneous lifecycles, and noncanonical values", async (t) => {
  const { store, raw, publish } = await fixture(t);
  const cases: Array<[string, (run: RunRecord) => void]> = [
    ["policy mode", (run) => {
      run.workspaceBootstrap = bootstrap("operator-checkout");
    }],
    ["both lifecycles", (run) => {
      run.state = "CANCELLED";
      run.workspaceBootstrap = bootstrap();
      run.revalidation = revalidation();
    }],
    ["empty branch", (run) => {
      run.workspaceBootstrap = { ...bootstrap(), sourceBranch: " " };
    }],
    ["noncanonical base", (run) => {
      run.workspaceBootstrap = {
        ...bootstrap(),
        sourceBaseSha: HEAD_A.toUpperCase(),
      };
    }],
    ["noncanonical fingerprint", (run) => {
      run.workspaceBootstrap = { ...bootstrap(), sourceTreeFingerprint: "ABC" };
    }],
    ["noncanonical bootstrap timestamp", (run) => {
      run.workspaceBootstrap = { ...bootstrap(), plannedAt: "2026-08-19" };
    }],
    ["operator planned path", (run) => {
      run.workspaceBootstrap = {
        ...bootstrap("operator-checkout"),
        plannedWorktreePath: "/tmp/maswe-operator-forbidden",
      };
      run.config = structuredClone(DEFAULT_CONFIG);
      run.config.policy.useIsolatedWorktree = false;
    }],
    ["relative planned path", (run) => {
      run.workspaceBootstrap = {
        ...bootstrap(),
        plannedWorktreePath: "relative/not/absolute",
      };
    }],
    ["workspace planned path disagreement", (run) => {
      run.workspaceBootstrap = {
        ...bootstrap(),
        plannedWorktreePath: "/tmp/maswe-planned-a",
      };
      run.workspace = {
        baseSha: HEAD_A,
        headSha: HEAD_A,
        branch: `maswe/${run.id}`,
        fingerprint: "d".repeat(64),
        worktreePath: "/tmp/maswe-planned-b",
      };
    }],
    ["noncanonical origin head", (run) => {
      run.state = "CI_RUNNING";
      run.revalidation = { ...revalidation(), originHeadSha: " HEAD " };
    }],
    ["noncanonical requested head", (run) => {
      run.state = "CI_RUNNING";
      run.revalidation = {
        ...revalidation(),
        requestedHeadSha: HEAD_B.toUpperCase(),
      };
    }],
    ["noncanonical revalidation timestamp", (run) => {
      run.state = "CI_RUNNING";
      run.revalidation = { ...revalidation(), updatedAt: "yesterday" };
    }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(raw);
    mutate(candidate);
    await publish(candidate);
    await assert.rejects(
      store.load(candidate.id),
      /bootstrap|revalidation|fingerprint|timestamp|mode|plannedWorktreePath|absolute|disagrees|operator-checkout/i,
      label,
    );
  }
});
