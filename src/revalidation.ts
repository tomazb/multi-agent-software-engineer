import { isDeepStrictEqual } from "node:util";
import type {
  RevalidationSource,
  RunRecord,
  RunRevalidation,
  RunWorkspace,
  WorkflowState,
} from "./domain.ts";
import { invalidateStaleEvidence } from "./git-workspace.ts";
import type { RunStore } from "./store.ts";
import {
  assertRunMutationLease,
  withRunMutationFence,
  type RunMutationFenceOptions,
  type RunMutationLease,
} from "./run-mutation.ts";

export interface RevalidationTargetInput {
  source: RevalidationSource;
  previousHeadSha: string;
  requestedHeadSha: string;
  expectedRunVersion: number;
  actor: string;
  observedWorkspace?: RunWorkspace;
  at?: string;
}

export interface RevalidationFence {
  runVersion: number;
  generation: number;
  requestedHeadSha: string;
}

const ACTIVE_REVALIDATION_STATES: WorkflowState[] = [
  "BUILDING",
  "CI_RUNNING",
  "VERIFYING",
];

const ASSOCIATED_HEAD_RECOVERY_STATES: WorkflowState[] = [
  ...ACTIVE_REVALIDATION_STATES,
  "RESOLVING",
  "MERGE_READY",
];

const SAME_TARGET_EVIDENCE_RECOVERY_STATES: WorkflowState[] = [
  "PR_READY",
  "PR_REVIEW",
  "MERGE_READY",
];

export function requiresSameTargetEvidenceRecovery(
  run: RunRecord,
  headSha: string,
): boolean {
  return (
    run.revalidation === undefined &&
    SAME_TARGET_EVIDENCE_RECOVERY_STATES.includes(run.state) &&
    run.github?.suspended !== true &&
    run.github?.headSha === headSha &&
    run.workspace?.headSha === headSha &&
    (run.evidence?.quality?.headSha !== headSha ||
      run.evidence?.verification?.headSha !== headSha)
  );
}

export function hasEnteredPullRequestReview(run: RunRecord): boolean {
  return (
    run.state === "PR_REVIEW" ||
    run.events.some((event) => event.to === "PR_REVIEW")
  );
}

function initialReturnState(
  run: RunRecord,
  input: RevalidationTargetInput,
): "PR_READY" | "PR_REVIEW" {
  if (run.state === "PR_READY" || run.state === "PR_REVIEW") return run.state;
  if (
    input.source !== "github" ||
    run.github === undefined ||
    run.github.headSha !== input.requestedHeadSha ||
    !ASSOCIATED_HEAD_RECOVERY_STATES.includes(run.state)
  ) {
    throw new Error(
      `Illegal revalidation request without active revalidation from state ${run.state}`,
    );
  }
  return hasEnteredPullRequestReview(run) ? "PR_REVIEW" : "PR_READY";
}

export class RevalidationOptimisticConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevalidationOptimisticConflictError";
  }
}

function requireTargetInput(input: RevalidationTargetInput): void {
  if (!input.previousHeadSha.trim()) {
    throw new Error("Revalidation previous head SHA is required");
  }
  if (!input.requestedHeadSha.trim()) {
    throw new Error("Revalidation requested head SHA is required");
  }
  if (!Number.isSafeInteger(input.expectedRunVersion) || input.expectedRunVersion <= 0) {
    throw new Error("Revalidation expected run version must be a positive safe integer");
  }
  if (!input.actor.trim()) {
    throw new Error("Revalidation actor is required");
  }
}

function candidateWithObservedWorkspace(
  run: RunRecord,
  observedWorkspace: RunWorkspace | undefined,
): RunRecord {
  const candidate = structuredClone(run);
  if (observedWorkspace !== undefined) {
    candidate.workspace = structuredClone(observedWorkspace);
  }
  return candidate;
}

export class RevalidationService {
  private readonly store: RunStore;
  private readonly now: () => string;
  private readonly mutationFenceOptions: RunMutationFenceOptions;

  constructor(
    store: RunStore,
    now: (() => string) | undefined = () => new Date().toISOString(),
    options: { mutationFenceOptions?: RunMutationFenceOptions } = {},
  ) {
    this.store = store;
    this.now = now;
    this.mutationFenceOptions = options.mutationFenceOptions ?? {};
  }

  async route(runId: string, input: RevalidationTargetInput): Promise<RunRecord> {
    requireTargetInput(input);
    const location = await this.store.load(runId);
    return withRunMutationFence(
      location.repositoryPath,
      runId,
      "target",
      async () => this.routeAuthoritative(runId, input, location.repositoryPath),
      this.mutationFenceOptions,
    );
  }

  async routeWithHeldTerminalRecoveryLease(
    runId: string,
    input: RevalidationTargetInput,
    lease: RunMutationLease,
  ): Promise<RunRecord> {
    requireTargetInput(input);
    await assertRunMutationLease(
      lease,
      lease.repositoryPath,
      runId,
      "terminal-recovery",
    );
    return this.routeAuthoritative(runId, input, lease.repositoryPath);
  }

  private async routeAuthoritative(
    runId: string,
    input: RevalidationTargetInput,
    repositoryPath: string,
  ): Promise<RunRecord> {
    const run = await this.store.load(runId);
    if (run.repositoryPath !== repositoryPath) {
      throw new RevalidationOptimisticConflictError(
        `Revalidation repository path changed for run ${runId}`,
      );
    }
    if (run.version !== input.expectedRunVersion) {
      throw new RevalidationOptimisticConflictError(
        `Revalidation optimistic version conflict for run ${runId}: expected ${input.expectedRunVersion}, authoritative ${run.version}`,
      );
    }

    const revalidation = run.revalidation;
    if (revalidation === undefined) {
      const authoritativeTarget = run.workspace?.headSha;
      if (authoritativeTarget !== input.previousHeadSha) {
        throw new RevalidationOptimisticConflictError(
          `Revalidation optimistic predecessor conflict for run ${runId}: expected ${input.previousHeadSha}, authoritative target ${authoritativeTarget ?? "missing"}`,
        );
      }
      if (
        input.observedWorkspace !== undefined &&
        input.observedWorkspace.headSha !== input.requestedHeadSha
      ) {
        throw new Error(
          `Revalidation target ${input.requestedHeadSha} does not match observed workspace HEAD ${input.observedWorkspace.headSha}`,
        );
      }
      return this.requestInitial(run, input);
    }
    if (revalidation.requestedHeadSha !== input.previousHeadSha) {
      throw new RevalidationOptimisticConflictError(
        `Revalidation optimistic predecessor conflict for run ${runId}: expected ${input.previousHeadSha}, authoritative target ${revalidation.requestedHeadSha}`,
      );
    }
    return this.routeActive(run, revalidation, input);
  }

  private async requestInitial(
    run: RunRecord,
    input: RevalidationTargetInput,
  ): Promise<RunRecord> {
    if (
      input.previousHeadSha === input.requestedHeadSha &&
      (input.source !== "github" ||
        !requiresSameTargetEvidenceRecovery(run, input.requestedHeadSha))
    ) {
      throw new Error("Initial revalidation target is unchanged");
    }
    const returnState = initialReturnState(run, input);

    const at = input.at ?? this.now();
    const candidate = candidateWithObservedWorkspace(run, input.observedWorkspace);
    candidate.revalidation = {
      returnState,
      source: input.source,
      originHeadSha: input.previousHeadSha,
      requestedHeadSha: input.requestedHeadSha,
      generation: 1,
      requestedAt: at,
      updatedAt: at,
    };
    invalidateStaleEvidence(candidate, input.requestedHeadSha);

    return this.store.applyEvent(candidate, "REVALIDATE_REQUESTED", input.actor, {
      previousHeadSha: input.previousHeadSha,
      requestedHeadSha: input.requestedHeadSha,
      generation: 1,
      returnState,
      source: input.source,
    });
  }

  private async routeActive(
    run: RunRecord,
    revalidation: RunRevalidation,
    input: RevalidationTargetInput,
  ): Promise<RunRecord> {
    const failureResumeState = run.failure?.resumeState;
    const activeState = ACTIVE_REVALIDATION_STATES.includes(run.state);
    const failedState =
      run.state === "FAILED" &&
      failureResumeState !== undefined &&
      ACTIVE_REVALIDATION_STATES.includes(failureResumeState);

    if (!activeState && !failedState) {
      throw new Error(
        `Illegal active revalidation context from state ${run.state}; a legal revalidation resume state is required`,
      );
    }

    if (revalidation.requestedHeadSha === input.requestedHeadSha) {
      if (
        input.observedWorkspace !== undefined &&
        input.observedWorkspace.headSha !== input.requestedHeadSha
      ) {
        throw new Error(
          `Revalidation target ${input.requestedHeadSha} does not match observed workspace HEAD ${input.observedWorkspace.headSha}`,
        );
      }
      if (
        input.observedWorkspace === undefined ||
        isDeepStrictEqual(run.workspace, input.observedWorkspace)
      ) {
        return run;
      }
      const aligned = candidateWithObservedWorkspace(run, input.observedWorkspace);
      await this.store.save(aligned);
      return aligned;
    }

    const previousRequestedHeadSha = revalidation.requestedHeadSha;
    const generation = revalidation.generation + 1;
    const at = input.at ?? this.now();
    const candidate = candidateWithObservedWorkspace(run, input.observedWorkspace);
    candidate.revalidation = {
      ...revalidation,
      source: input.source,
      requestedHeadSha: input.requestedHeadSha,
      generation,
      updatedAt: at,
    };
    invalidateStaleEvidence(candidate, input.requestedHeadSha);

    const details: Record<string, unknown> = {
      previousRequestedHeadSha,
      requestedHeadSha: input.requestedHeadSha,
      generation,
      returnState: revalidation.returnState,
      source: input.source,
    };
    if (failedState) {
      details.previousResumeState = failureResumeState;
      candidate.failure = {
        ...candidate.failure!,
        resumeState: "CI_RUNNING",
      };
    }

    return this.store.applyEvent(
      candidate,
      "REVALIDATION_RETARGETED",
      input.actor,
      details,
    );
  }
}

export function captureRevalidationFence(run: RunRecord): RevalidationFence {
  if (run.revalidation === undefined) {
    throw new Error(`Run ${run.id} has no active revalidation to fence`);
  }
  return {
    runVersion: run.version,
    generation: run.revalidation.generation,
    requestedHeadSha: run.revalidation.requestedHeadSha,
  };
}

export async function assertRevalidationFence(
  store: RunStore,
  runId: string,
  fence: RevalidationFence,
): Promise<RunRecord> {
  const authoritative = await store.load(runId);
  if (
    authoritative.revalidation === undefined ||
    authoritative.version !== fence.runVersion ||
    authoritative.revalidation.generation !== fence.generation ||
    authoritative.revalidation.requestedHeadSha !== fence.requestedHeadSha
  ) {
    throw new Error(`Run ${runId} has a stale revalidation fence`);
  }
  return authoritative;
}
