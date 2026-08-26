import path from "node:path";
import type { MasweConfig, RunRecord, RunWorkspace, WorkspaceBootstrapIntent } from "./domain.ts";
import {
  captureWorkspaceSourceFingerprint,
  gitCurrentBranch,
  gitRemoteUrl,
  gitRevParse,
  isGitRepository,
  isGitWorkspaceClean,
} from "./git-snapshot.ts";
import {
  captureWorkspace,
  ensureMasweGitExclude,
  externalWorktreePath,
  gitLocalBranchHead,
  listGitWorktreeRegistrations,
  pathExists,
} from "./git-workspace.ts";
import { mkdir } from "node:fs/promises";
import { gitRun, gitWorkspaceFingerprint } from "./git-snapshot.ts";

const NON_GIT_WORKSPACE = "not-a-git-repository";

export interface WorkspaceBootstrapHooks {
  beforeBranchCreate?: (run: RunRecord) => Promise<void>;
  afterBranchCreate?: (run: RunRecord) => Promise<void>;
  afterWorktreeCreate?: (run: RunRecord) => Promise<void>;
}

/**
 * Capture the immutable source-plane inputs required to establish a workspace.
 *
 * This deliberately performs no workspace or Git metadata mutation. The intent
 * must be durably stored before reconciliation creates branches, worktrees, or
 * an `.git/info/exclude` entry.
 */
export async function captureWorkspaceBootstrapIntent(
  repositoryPath: string,
  config: MasweConfig,
  plannedAt = new Date().toISOString(),
): Promise<WorkspaceBootstrapIntent> {
  const sourceTreeFingerprint = await captureWorkspaceSourceFingerprint(repositoryPath);
  const mode = config.policy.useIsolatedWorktree
    ? "isolated-worktree"
    : "operator-checkout";

  if (!(await isGitRepository(repositoryPath))) {
    return {
      mode,
      sourceBaseSha: NON_GIT_WORKSPACE,
      sourceBranch: NON_GIT_WORKSPACE,
      sourceTreeFingerprint,
      plannedAt,
    };
  }

  const [sourceBaseSha, sourceBranch, remote] = await Promise.all([
    gitRevParse(repositoryPath, "HEAD"),
    gitCurrentBranch(repositoryPath),
    gitRemoteUrl(repositoryPath),
  ]);
  if (sourceBranch === "HEAD") {
    throw new Error("Workspace bootstrap requires an attached branch; repository HEAD is detached");
  }
  return {
    mode,
    sourceBaseSha,
    sourceBranch,
    sourceTreeFingerprint,
    ...(remote ? { remote } : {}),
    plannedAt,
  };
}

function requireBootstrapIntent(run: RunRecord): WorkspaceBootstrapIntent {
  const intent = run.workspaceBootstrap;
  if (!intent) {
    throw new Error(`CREATED run ${run.id} has no durable workspace bootstrap intent`);
  }
  const expectedMode = run.config.policy.useIsolatedWorktree
    ? "isolated-worktree"
    : "operator-checkout";
  if (intent.mode !== expectedMode) {
    throw new Error(
      `Run ${run.id} bootstrap mode ${intent.mode} conflicts with policy mode ${expectedMode}`,
    );
  }
  return intent;
}

/**
 * Resolve the absolute planned isolated worktree path for first-time binding.
 * This publishes a concrete path under the current process environment before
 * any side effect. Historical unique-registration recovery belongs to cleanup
 * derivation, not to first-time binding, so a pre-existing alternate registration
 * remains a fail-closed reconcile conflict.
 */
export function resolveIsolatedPlannedWorktreePathForBinding(run: RunRecord): string {
  const intent = requireBootstrapIntent(run);
  if (intent.mode !== "isolated-worktree") {
    throw new Error(`Run ${run.id} planned worktree path applies only to isolated-worktree mode`);
  }
  if (intent.plannedWorktreePath !== undefined) {
    if (!path.isAbsolute(intent.plannedWorktreePath)) {
      throw new Error(`Run ${run.id} plannedWorktreePath must be absolute`);
    }
    return path.resolve(intent.plannedWorktreePath);
  }

  return path.resolve(externalWorktreePath(run.repositoryPath, run.id));
}

export function requireIsolatedPlannedWorktreePath(run: RunRecord): string {
  const intent = requireBootstrapIntent(run);
  if (intent.mode !== "isolated-worktree") {
    throw new Error(`Run ${run.id} planned worktree path applies only to isolated-worktree mode`);
  }
  if (!intent.plannedWorktreePath) {
    throw new Error(
      `Run ${run.id} isolated bootstrap requires durable plannedWorktreePath before side effects`,
    );
  }
  if (!path.isAbsolute(intent.plannedWorktreePath)) {
    throw new Error(`Run ${run.id} plannedWorktreePath must be absolute`);
  }
  return path.resolve(intent.plannedWorktreePath);
}

async function assertBootstrapSourceExact(
  repositoryPath: string,
  run: RunRecord,
): Promise<WorkspaceBootstrapIntent> {
  const intent = requireBootstrapIntent(run);
  const git = await isGitRepository(repositoryPath);
  if (!git) {
    if (
      intent.sourceBaseSha !== NON_GIT_WORKSPACE ||
      intent.sourceBranch !== NON_GIT_WORKSPACE
    ) {
      throw new Error(`Run ${run.id} bootstrap source changed from Git to non-Git`);
    }
  } else {
    if (
      intent.sourceBaseSha === NON_GIT_WORKSPACE ||
      intent.sourceBranch === NON_GIT_WORKSPACE
    ) {
      throw new Error(`Run ${run.id} bootstrap source changed from non-Git to Git`);
    }
    const [headSha, branch] = await Promise.all([
      gitRevParse(repositoryPath, "HEAD"),
      gitCurrentBranch(repositoryPath),
    ]);
    if (branch === "HEAD" || intent.sourceBranch === "HEAD") {
      throw new Error(`Run ${run.id} bootstrap requires an attached source branch`);
    }
    if (headSha !== intent.sourceBaseSha) {
      throw new Error(
        `Run ${run.id} bootstrap source HEAD drifted from ${intent.sourceBaseSha} to ${headSha}`,
      );
    }
    if (branch !== intent.sourceBranch) {
      throw new Error(
        `Run ${run.id} bootstrap source branch drifted from ${intent.sourceBranch} to ${branch}`,
      );
    }
  }
  const fingerprint = await captureWorkspaceSourceFingerprint(repositoryPath);
  if (fingerprint !== intent.sourceTreeFingerprint) {
    throw new Error(`Run ${run.id} bootstrap source fingerprint drifted`);
  }
  return intent;
}

export async function assertBootstrapWorkspaceReady(
  repositoryPath: string,
  run: RunRecord,
): Promise<void> {
  const intent = await assertBootstrapSourceExact(repositoryPath, run);
  const workspace = run.workspace;
  if (!workspace) throw new Error(`Run ${run.id} has no checkpointed bootstrap workspace`);

  if (intent.mode === "operator-checkout") {
    if (workspace.worktreePath !== undefined) {
      throw new Error(`Run ${run.id} operator-checkout workspace cannot name a worktree`);
    }
    if (
      workspace.baseSha !== intent.sourceBaseSha ||
      workspace.headSha !== intent.sourceBaseSha ||
      workspace.branch !== intent.sourceBranch
    ) {
      throw new Error(`Run ${run.id} operator-checkout workspace identity is not exact`);
    }
    return;
  }

  if (!(await isGitRepository(repositoryPath))) {
    throw new Error("Isolated worktrees require a git repository.");
  }
  const expectedBranch = `maswe/${run.id}`;
  const expectedPath = requireIsolatedPlannedWorktreePath(run);
  if (
    workspace.baseSha !== intent.sourceBaseSha ||
    workspace.headSha !== intent.sourceBaseSha ||
    workspace.branch !== expectedBranch ||
    !workspace.worktreePath ||
    path.resolve(workspace.worktreePath) !== expectedPath
  ) {
    throw new Error(`Run ${run.id} isolated workspace checkpoint identity is not exact`);
  }

  const registrations = await listGitWorktreeRegistrations(repositoryPath);
  const byPath = registrations.find((registration) => registration.worktreePath === expectedPath);
  const byBranch = registrations.find((registration) => registration.branch === expectedBranch);
  if (!byPath || !byBranch || byPath !== byBranch) {
    throw new Error(`Run ${run.id} isolated worktree registration is missing or conflicting`);
  }
  if (byPath.prunable) {
    throw new Error(`Run ${run.id} isolated worktree registration is stale or prunable`);
  }
  if (byPath.headSha !== intent.sourceBaseSha || byPath.branch !== expectedBranch) {
    throw new Error(`Run ${run.id} isolated worktree registration has the wrong branch or HEAD`);
  }
  const branchHead = await gitLocalBranchHead(repositoryPath, expectedBranch);
  if (branchHead !== intent.sourceBaseSha) {
    throw new Error(`Run ${run.id} branch ${expectedBranch} has the wrong HEAD`);
  }
  if (!(await pathExists(expectedPath))) {
    throw new Error(`Run ${run.id} isolated worktree path is missing`);
  }
  const [actualBranch, actualHead] = await Promise.all([
    gitCurrentBranch(expectedPath),
    gitRevParse(expectedPath, "HEAD"),
  ]);
  if (actualBranch !== expectedBranch || actualHead !== intent.sourceBaseSha) {
    throw new Error(`Run ${run.id} isolated worktree has the wrong branch or HEAD`);
  }
  if (!(await isGitWorkspaceClean(expectedPath))) {
    throw new Error(`Run ${run.id} isolated worktree is dirty`);
  }
  const fingerprint = await gitWorkspaceFingerprint(expectedPath);
  if (fingerprint !== workspace.fingerprint) {
    throw new Error(`Run ${run.id} isolated worktree fingerprint changed`);
  }
}

export async function reconcileBootstrapWorkspace(
  repositoryPath: string,
  run: RunRecord,
  hooks: WorkspaceBootstrapHooks = {},
): Promise<RunWorkspace> {
  const intent = await assertBootstrapSourceExact(repositoryPath, run);
  await ensureMasweGitExclude(repositoryPath);
  if (intent.mode === "operator-checkout") {
    const workspace = await captureWorkspace(repositoryPath);
    const candidate = structuredClone(run);
    candidate.workspace = workspace;
    await assertBootstrapWorkspaceReady(repositoryPath, candidate);
    return workspace;
  }
  if (!(await isGitRepository(repositoryPath))) {
    throw new Error("Isolated worktrees require a git repository.");
  }

  const branch = `maswe/${run.id}`;
  const worktreePath = requireIsolatedPlannedWorktreePath(run);
  let registrations = await listGitWorktreeRegistrations(repositoryPath);
  let byPath = registrations.find((registration) => registration.worktreePath === worktreePath);
  let byBranch = registrations.find((registration) => registration.branch === branch);
  if (byPath?.prunable || byBranch?.prunable) {
    throw new Error(`Run ${run.id} has a stale or prunable worktree registration`);
  }
  if (byPath && byPath.branch !== branch) {
    throw new Error(`Run ${run.id} deterministic path is registered to the wrong branch`);
  }
  if (byBranch && byBranch.worktreePath !== worktreePath) {
    throw new Error(`Run ${run.id} deterministic branch is registered at an alternate path`);
  }

  let branchHead = await gitLocalBranchHead(repositoryPath, branch);
  if (branchHead !== undefined && branchHead !== intent.sourceBaseSha) {
    throw new Error(`Run ${run.id} deterministic branch has the wrong HEAD`);
  }
  if (!byPath) {
    if (await pathExists(worktreePath)) {
      throw new Error(`Run ${run.id} deterministic worktree path is occupied but unregistered`);
    }
    if (branchHead === undefined) {
      await hooks.beforeBranchCreate?.(run);
      const created = await gitRun(
        ["branch", branch, intent.sourceBaseSha],
        repositoryPath,
      );
      if (created.exitCode !== 0) {
        throw new Error(`Failed to create deterministic branch ${branch}: ${created.stderr || created.stdout}`);
      }
      branchHead = intent.sourceBaseSha;
      await hooks.afterBranchCreate?.(run);
    }
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const added = await gitRun(
      ["worktree", "add", "--", worktreePath, branch],
      repositoryPath,
    );
    if (added.exitCode !== 0) {
      throw new Error(`Failed to create deterministic worktree: ${added.stderr || added.stdout}`);
    }
    await hooks.afterWorktreeCreate?.(run);
    registrations = await listGitWorktreeRegistrations(repositoryPath);
    byPath = registrations.find((registration) => registration.worktreePath === worktreePath);
    byBranch = registrations.find((registration) => registration.branch === branch);
  }
  if (!byPath || !byBranch || byPath !== byBranch || branchHead !== intent.sourceBaseSha) {
    throw new Error(`Run ${run.id} deterministic workspace reconciliation is conflicting`);
  }

  const workspace: RunWorkspace = {
    ...(intent.remote ? { remote: intent.remote } : {}),
    baseSha: intent.sourceBaseSha,
    headSha: intent.sourceBaseSha,
    branch,
    worktreePath,
    fingerprint: await gitWorkspaceFingerprint(worktreePath),
  };
  const candidate = structuredClone(run);
  candidate.workspace = workspace;
  await assertBootstrapWorkspaceReady(repositoryPath, candidate);
  return workspace;
}

/**
 * Reconcile the exact durable workspace needed by a retry without discarding
 * operator or model changes. A retry may recreate only a completely absent,
 * deterministically named isolated worktree; every conflicting shape fails
 * closed for explicit operator recovery or supersession.
 */
export async function reconcileRetryWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace | undefined> {
  const resumeState = run.failure?.resumeState;
  if (!resumeState) {
    throw new Error(`Run ${run.id} has no retry workspace resume state`);
  }
  if (path.resolve(run.repositoryPath) !== path.resolve(repositoryPath)) {
    throw new Error(`Run ${run.id} repository path does not match the retry checkout`);
  }
  if (resumeState === "CREATED") {
    return reconcileBootstrapWorkspace(repositoryPath, run);
  }

  const workspace = run.workspace;
  if (!workspace) {
    throw new Error(`Run ${run.id} has no preserved workspace; supersede the run`);
  }

  if (!run.config.policy.useIsolatedWorktree) {
    if (!(await isGitRepository(repositoryPath))) {
      throw new Error(
        `Run ${run.id} uses a later non-Git operator checkout whose source identity cannot be proven; supersede the run`,
      );
    }
    if (
      workspace.worktreePath !== undefined ||
      workspace.baseSha === NON_GIT_WORKSPACE ||
      workspace.headSha === NON_GIT_WORKSPACE ||
      workspace.branch === NON_GIT_WORKSPACE
    ) {
      throw new Error(`Run ${run.id} operator-checkout workspace identity is not exact`);
    }
    const [branch, headSha, clean] = await Promise.all([
      gitCurrentBranch(repositoryPath),
      gitRevParse(repositoryPath, "HEAD"),
      isGitWorkspaceClean(repositoryPath),
    ]);
    if (branch !== workspace.branch || headSha !== workspace.headSha) {
      throw new Error(
        `Run ${run.id} operator checkout moved from ${workspace.branch}@${workspace.headSha}; supersede the run`,
      );
    }
    if (!clean) {
      throw new Error(`Run ${run.id} operator checkout is dirty; preserve the changes and supersede the run`);
    }
    return structuredClone(workspace);
  }

  if (!(await isGitRepository(repositoryPath))) {
    throw new Error(`Run ${run.id} isolated retry requires the preserved Git repository`);
  }
  const expectedBranch = `maswe/${run.id}`;
  if (
    workspace.baseSha === NON_GIT_WORKSPACE ||
    workspace.headSha === NON_GIT_WORKSPACE ||
    workspace.branch !== expectedBranch ||
    !workspace.worktreePath
  ) {
    throw new Error(`Run ${run.id} isolated retry workspace identity is not exact`);
  }
  const expectedPath = path.resolve(workspace.worktreePath);
  const plannedPath = run.workspaceBootstrap?.plannedWorktreePath;
  if (plannedPath !== undefined && path.resolve(plannedPath) !== expectedPath) {
    throw new Error(`Run ${run.id} isolated retry workspace disagrees with plannedWorktreePath`);
  }

  let registrations = await listGitWorktreeRegistrations(repositoryPath);
  let byPath = registrations.find(
    (registration) => registration.worktreePath === expectedPath,
  );
  let byBranch = registrations.find(
    (registration) => registration.branch === expectedBranch,
  );
  if (byPath?.prunable || byBranch?.prunable) {
    throw new Error(`Run ${run.id} isolated retry registration is stale or prunable`);
  }
  if (byPath && byPath.branch !== expectedBranch) {
    throw new Error(`Run ${run.id} retry path is registered to the wrong branch`);
  }
  if (byBranch && byBranch.worktreePath !== expectedPath) {
    throw new Error(`Run ${run.id} retry branch is registered at an alternate path`);
  }

  const branchHead = await gitLocalBranchHead(repositoryPath, expectedBranch);
  if (branchHead !== workspace.headSha) {
    throw new Error(
      `Run branch ${expectedBranch} moved to ${branchHead ?? "(missing)"} but preserved headSha is ${workspace.headSha}; refusing to modify it, so supersede or recover manually`,
    );
  }
  const worktreeExists = await pathExists(expectedPath);
  if (byPath || byBranch) {
    if (!byPath || !byBranch || byPath !== byBranch || !worktreeExists) {
      throw new Error(`Run ${run.id} isolated retry registration is incomplete or conflicting`);
    }
  } else {
    if (worktreeExists) {
      throw new Error(`Run ${run.id} retry path is occupied but unregistered`);
    }
    await mkdir(path.dirname(expectedPath), { recursive: true });
    const added = await gitRun(
      ["worktree", "add", "--", expectedPath, expectedBranch],
      repositoryPath,
    );
    if (added.exitCode !== 0) {
      throw new Error(
        `Failed to recreate exact retry worktree: ${added.stderr || added.stdout}`,
      );
    }
    registrations = await listGitWorktreeRegistrations(repositoryPath);
    byPath = registrations.find(
      (registration) => registration.worktreePath === expectedPath,
    );
    byBranch = registrations.find(
      (registration) => registration.branch === expectedBranch,
    );
  }

  if (
    !byPath ||
    !byBranch ||
    byPath !== byBranch ||
    byPath.prunable ||
    byPath.branch !== expectedBranch ||
    byPath.headSha !== workspace.headSha
  ) {
    throw new Error(`Run ${run.id} isolated retry registration is not exact`);
  }
  const [actualBranch, actualHead, clean, fingerprint] = await Promise.all([
    gitCurrentBranch(expectedPath),
    gitRevParse(expectedPath, "HEAD"),
    isGitWorkspaceClean(expectedPath),
    gitWorkspaceFingerprint(expectedPath),
  ]);
  if (actualBranch !== expectedBranch || actualHead !== workspace.headSha) {
    throw new Error(`Run ${run.id} isolated retry worktree has the wrong branch or HEAD`);
  }
  if (!clean) {
    throw new Error(`Run ${run.id} isolated retry worktree is dirty`);
  }
  if (fingerprint !== workspace.fingerprint) {
    throw new Error(`Run ${run.id} isolated retry workspace fingerprint changed`);
  }
  return structuredClone(workspace);
}
