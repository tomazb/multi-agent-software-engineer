import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunRecord, RunWorkspace, TerminalCleanupFailureCode } from "./domain.ts";
import {
  gitChangedFiles,
  gitCurrentBranch,
  gitRemoteUrl,
  gitRevParse,
  gitRun,
  gitWorkspaceFingerprint,
  isGitRepository,
  isGitWorkspaceClean,
} from "./git-snapshot.ts";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function gitExec(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  if (command !== "git") {
    throw new Error(`Unsupported command for gitExec: ${command}`);
  }
  return gitRun(args, cwd);
}

/** Reject path-like or otherwise unsafe run IDs before filesystem joins. */
export function assertSafeRunId(runId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(
      `Invalid run id '${runId}': must be 1-128 chars of [A-Za-z0-9._-] starting with alphanumeric`,
    );
  }
}

function matchGlob(filePath: string, glob: string): boolean {
  const normalizedGlob = glob.replace(/\\/g, "/");
  if (normalizedGlob === "**" || normalizedGlob === "**/*") return true;

  let source = "";
  for (let index = 0; index < normalizedGlob.length; index += 1) {
    const token = normalizedGlob.charAt(index);
    if (token === "*") {
      if (normalizedGlob[index + 1] === "*") {
        if (normalizedGlob[index + 2] === "/") {
          source += "(?:[\\s\\S]*/)?";
          index += 2;
        } else {
          source += "[\\s\\S]*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (token === "?") {
      source += "[^/]";
    } else if (".+^${}()|[]\\".includes(token)) {
      source += `\\${token}`;
    } else {
      source += token;
    }
  }
  return new RegExp(`^${source}$`).test(filePath);
}

export function pathAllowed(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchGlob(filePath, glob));
}

export function externalWorktreePath(repositoryPath: string, runId: string): string {
  assertSafeRunId(runId);
  const repoKey = createHash("sha256").update(path.resolve(repositoryPath)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "maswe-worktrees", repoKey, runId);
}

/**
 * Exact managed cleanup target derived only from durable run authority.
 * Checkpointed workspace wins; otherwise an isolated bootstrap intent may
 * derive the deterministic path/branch/source HEAD without fabricating
 * durable `run.workspace`.
 */
export type ManagedTerminalCleanupTarget = {
  worktreePath: string;
  branch: string;
  headSha: string;
  source: "checkpointed-workspace" | "bootstrap-uncheckpointed";
};

export function deriveManagedTerminalCleanupTarget(
  run: RunRecord,
): ManagedTerminalCleanupTarget | undefined {
  if (!run.config.policy.useIsolatedWorktree) return undefined;

  if (run.workspace?.worktreePath) {
    return {
      worktreePath: path.resolve(run.workspace.worktreePath),
      branch: run.workspace.branch,
      headSha: run.workspace.headSha,
      source: "checkpointed-workspace",
    };
  }

  const bootstrap = run.workspaceBootstrap;
  if (!bootstrap || bootstrap.mode !== "isolated-worktree") return undefined;

  return {
    worktreePath: path.resolve(externalWorktreePath(run.repositoryPath, run.id)),
    branch: `maswe/${run.id}`,
    headSha: bootstrap.sourceBaseSha,
    source: "bootstrap-uncheckpointed",
  };
}

export interface GitWorktreeRegistration {
  worktreePath: string;
  headSha: string;
  branch?: string;
  prunable: boolean;
}

/** Parse Git's NUL-delimited porcelain format without consulting diagnostic prose. */
export function parseGitWorktreeRegistrationsPorcelain(
  output: string,
): GitWorktreeRegistration[] {
  if (!output.endsWith("\0\0")) {
    throw new Error("Malformed Git worktree registration output: missing record terminator");
  }

  const registrations: GitWorktreeRegistration[] = [];
  const paths = new Set<string>();
  const branches = new Set<string>();
  let bareSeen = false;
  for (const rawRecord of output.slice(0, -2).split("\0\0")) {
    const fields = rawRecord.split("\0");
    const worktreeField = fields.shift();
    const headField = fields.shift();
    if (!worktreeField?.startsWith("worktree ")) {
      throw new Error("Malformed Git worktree registration: worktree must come first");
    }
    const rawPath = worktreeField.slice("worktree ".length);
    if (!path.isAbsolute(rawPath)) {
      throw new Error("Malformed Git worktree registration path");
    }
    const worktreePath = path.resolve(rawPath);
    if (paths.has(worktreePath)) {
      throw new Error(`Conflicting Git worktree registrations for path ${worktreePath}`);
    }
    paths.add(worktreePath);
    if (headField === "bare") {
      if (bareSeen || fields.length !== 0) {
        throw new Error("Malformed bare Git worktree registration");
      }
      bareSeen = true;
      continue;
    }
    if (!headField?.startsWith("HEAD ")) {
      throw new Error("Malformed Git worktree registration: HEAD must follow worktree");
    }
    const headSha = headField.slice("HEAD ".length).toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) {
      throw new Error("Malformed Git worktree registration HEAD");
    }

    let branch: string | undefined;
    let detached = false;
    let locked = false;
    let prunable = false;
    for (const field of fields) {
      if (field === "detached") {
        if (detached) {
          throw new Error("Malformed Git worktree registration: duplicate detached field");
        }
        detached = true;
        continue;
      }
      if (field === "locked" || field.startsWith("locked ")) {
        if (locked) {
          throw new Error("Malformed Git worktree registration: duplicate locked field");
        }
        locked = true;
        continue;
      }
      if (field === "prunable" || field.startsWith("prunable ")) {
        if (prunable) throw new Error("Malformed Git worktree registration: duplicate prunable field");
        prunable = true;
        continue;
      }
      if (field.startsWith("branch ")) {
        if (branch !== undefined) {
          throw new Error("Malformed Git worktree registration: duplicate branch field");
        }
        const fullRef = field.slice("branch ".length);
        if (!fullRef.startsWith("refs/heads/") || fullRef.length === "refs/heads/".length) {
          throw new Error("Malformed Git worktree registration branch ref");
        }
        branch = fullRef.slice("refs/heads/".length);
        continue;
      }
      throw new Error(`Malformed Git worktree registration field: ${field}`);
    }

    if ((branch !== undefined) === detached) {
      throw new Error(
        "Malformed Git worktree registration: exactly one branch or detached marker is required",
      );
    }

    if (branch && branches.has(branch)) {
      throw new Error(`Conflicting Git worktree registrations for branch ${branch}`);
    }
    if (branch) branches.add(branch);
    registrations.push({ worktreePath, headSha, ...(branch ? { branch } : {}), prunable });
  }
  return registrations;
}

export class TerminalCleanupError extends Error {
  readonly code: TerminalCleanupFailureCode;

  constructor(code: TerminalCleanupFailureCode, message: string) {
    super(message);
    this.name = "TerminalCleanupError";
    this.code = code;
  }
}

export type TerminalCleanupPathState = "absent" | "directory" | "unsafe";

export interface TerminalCleanupDependencies {
  listRegistrations(repositoryPath: string): Promise<GitWorktreeRegistration[]>;
  inspectPath(candidatePath: string): Promise<TerminalCleanupPathState>;
  removeWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function inspectTerminalCleanupPath(
  candidatePath: string,
): Promise<TerminalCleanupPathState> {
  try {
    const stat = await lstat(candidatePath);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

async function defaultRemoveWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return gitExec("git", ["worktree", "remove", "--force", worktreePath], repositoryPath);
}

function throwTerminalCleanup(code: TerminalCleanupFailureCode, message: string): never {
  throw new TerminalCleanupError(code, message);
}

function resolveRegistrationPath(registration: GitWorktreeRegistration): string {
  return path.resolve(registration.worktreePath);
}

function findRegistrationForPath(
  registrations: GitWorktreeRegistration[],
  worktreePath: string,
): GitWorktreeRegistration | undefined {
  const resolved = path.resolve(worktreePath);
  return registrations.find((registration) => resolveRegistrationPath(registration) === resolved);
}

function findRegistrationForBranch(
  registrations: GitWorktreeRegistration[],
  branch: string,
): GitWorktreeRegistration | undefined {
  return registrations.find((registration) => registration.branch === branch);
}

type RemoveWorktreeAttempt = {
  exitCode: number;
  stdout: string;
  stderr: string;
  invocationError?: Error;
};

function assertExpectedBranchNotRegisteredElsewhere(
  registrations: GitWorktreeRegistration[],
  expectedBranch: string,
  worktreePath: string,
): void {
  const branchRegistration = findRegistrationForBranch(registrations, expectedBranch);
  if (
    branchRegistration &&
    resolveRegistrationPath(branchRegistration) !== path.resolve(worktreePath)
  ) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      `Expected branch ${expectedBranch} is registered at a different worktree path`,
    );
  }
}

function assertTargetRegistrationOwnership(
  targetRegistration: GitWorktreeRegistration | undefined,
  expectedBranch: string,
  workspaceHeadSha: string,
): void {
  if (!targetRegistration) return;
  if (targetRegistration.branch !== expectedBranch) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Target worktree registration branch does not match the run workspace branch",
    );
  }
  if (targetRegistration.headSha !== workspaceHeadSha.toLowerCase()) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Target worktree registration HEAD does not match the run workspace headSha",
    );
  }
}

function classifyPostRemovalState(
  postRegistrations: GitWorktreeRegistration[],
  postPathState: TerminalCleanupPathState,
  worktreePath: string,
  expectedBranch: string,
  workspaceHeadSha: string,
  removeAttempt: RemoveWorktreeAttempt,
): void {
  if (postPathState === "unsafe") {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Target worktree path is not an ordinary directory after cleanup attempt",
    );
  }

  assertExpectedBranchNotRegisteredElsewhere(
    postRegistrations,
    expectedBranch,
    worktreePath,
  );

  const postTargetRegistration = findRegistrationForPath(postRegistrations, worktreePath);
  assertTargetRegistrationOwnership(
    postTargetRegistration,
    expectedBranch,
    workspaceHeadSha,
  );

  if (!postTargetRegistration && postPathState === "absent") {
    return;
  }

  if (postTargetRegistration && postPathState === "directory") {
    const removeFailed =
      removeAttempt.exitCode !== 0 || removeAttempt.invocationError !== undefined;
    if (removeFailed) {
      const diagnostic =
        removeAttempt.invocationError?.message ??
        (removeAttempt.stderr ||
          removeAttempt.stdout ||
          "git worktree remove failed");
      throwTerminalCleanup("cleanup-remove-failed", diagnostic);
    }
    throwTerminalCleanup(
      "cleanup-postcondition-failed",
      "Worktree registration and directory remained after git worktree remove",
    );
  }

  if (postTargetRegistration && postPathState === "absent") {
    throwTerminalCleanup(
      "cleanup-postcondition-failed",
      "Worktree registration remained after the target path disappeared",
    );
  }

  if (!postTargetRegistration && postPathState === "directory") {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Refusing to delete an unregistered worktree directory after cleanup attempt",
    );
  }

  throwTerminalCleanup(
    "cleanup-postcondition-failed",
    "Worktree cleanup postconditions were not satisfied",
  );
}

async function attemptRemoveWorktree(
  deps: TerminalCleanupDependencies,
  repositoryPath: string,
  worktreePath: string,
): Promise<RemoveWorktreeAttempt> {
  try {
    const result = await deps.removeWorktree(repositoryPath, worktreePath);
    return { ...result };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "",
      invocationError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export async function reconcileTerminalWorktreeCleanup(
  run: RunRecord,
  invocationRepositoryPath: string,
  dependencies?: Partial<TerminalCleanupDependencies>,
): Promise<void> {
  const deps: TerminalCleanupDependencies = {
    listRegistrations: dependencies?.listRegistrations ?? listGitWorktreeRegistrations,
    inspectPath: dependencies?.inspectPath ?? inspectTerminalCleanupPath,
    removeWorktree: dependencies?.removeWorktree ?? defaultRemoveWorktree,
  };

  const repositoryPath = run.repositoryPath;
  const target = deriveManagedTerminalCleanupTarget(run);
  const expectedBranch = `maswe/${run.id}`;

  if (!["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Terminal worktree cleanup requires a terminal workflow state",
    );
  }
  if (!run.config.policy.useIsolatedWorktree) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Terminal worktree cleanup requires an isolated managed worktree policy",
    );
  }

  if (path.resolve(invocationRepositoryPath) !== path.resolve(repositoryPath)) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Cleanup invocation repository root must match the run repositoryPath exactly",
    );
  }
  if (!target) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Terminal worktree cleanup requires a recorded managed worktree path or durable isolated bootstrap target",
    );
  }
  const worktreePath = target.worktreePath;
  if (path.resolve(worktreePath) === path.resolve(repositoryPath)) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Refusing to delete the operator checkout worktree path",
    );
  }
  if (path.resolve(worktreePath) !== path.resolve(externalWorktreePath(repositoryPath, run.id))) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Recorded worktree path does not match the deterministic external worktree path",
    );
  }
  if (target.branch !== expectedBranch) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      `Recorded branch ${target.branch} does not match expected ${expectedBranch}`,
    );
  }

  let registrations: GitWorktreeRegistration[];
  try {
    registrations = await deps.listRegistrations(repositoryPath);
  } catch (error) {
    throwTerminalCleanup(
      "cleanup-inspection-failed",
      error instanceof Error ? error.message : "Failed to inspect Git worktree registrations",
    );
  }

  let pathState: TerminalCleanupPathState;
  try {
    pathState = await deps.inspectPath(worktreePath);
  } catch (error) {
    throwTerminalCleanup(
      "cleanup-inspection-failed",
      error instanceof Error ? error.message : "Failed to inspect worktree path",
    );
  }

  if (pathState === "unsafe") {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Target worktree path is not an ordinary directory",
    );
  }

  const branchRegistration = findRegistrationForBranch(registrations, expectedBranch);
  if (
    branchRegistration &&
    resolveRegistrationPath(branchRegistration) !== path.resolve(worktreePath)
  ) {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      `Expected branch ${expectedBranch} is registered at a different worktree path`,
    );
  }

  const targetRegistration = findRegistrationForPath(registrations, worktreePath);
  assertTargetRegistrationOwnership(targetRegistration, expectedBranch, target.headSha);

  if (!targetRegistration && pathState === "directory") {
    throwTerminalCleanup(
      "cleanup-ownership-mismatch",
      "Refusing to delete an unregistered worktree directory",
    );
  }

  if (!targetRegistration && pathState === "absent") {
    assertExpectedBranchNotRegisteredElsewhere(registrations, expectedBranch, worktreePath);
    return;
  }

  const removeAttempt = await attemptRemoveWorktree(deps, repositoryPath, worktreePath);

  let postRegistrations: GitWorktreeRegistration[];
  try {
    postRegistrations = await deps.listRegistrations(repositoryPath);
  } catch (error) {
    throwTerminalCleanup(
      "cleanup-inspection-failed",
      error instanceof Error ? error.message : "Failed to re-inspect Git worktree registrations",
    );
  }

  let postPathState: TerminalCleanupPathState;
  try {
    postPathState = await deps.inspectPath(worktreePath);
  } catch (error) {
    throwTerminalCleanup(
      "cleanup-inspection-failed",
      error instanceof Error ? error.message : "Failed to re-inspect worktree path",
    );
  }

  classifyPostRemovalState(
    postRegistrations,
    postPathState,
    worktreePath,
    expectedBranch,
    target.headSha,
    removeAttempt,
  );
}

export async function listGitWorktreeRegistrations(
  repositoryPath: string,
): Promise<GitWorktreeRegistration[]> {
  const result = await gitExec(
    "git",
    ["worktree", "list", "--porcelain", "-z"],
    repositoryPath,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to inspect Git worktree registrations: ${result.stderr || result.stdout}`);
  }
  return parseGitWorktreeRegistrationsPorcelain(result.stdout);
}

export async function gitLocalBranchHead(
  repositoryPath: string,
  branch: string,
): Promise<string | undefined> {
  const result = await gitExec(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    repositoryPath,
  );
  if (result.exitCode !== 0) return undefined;
  const headSha = result.stdout.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) {
    throw new Error(`Git returned a malformed HEAD for branch ${branch}`);
  }
  return headSha;
}

export async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await lstat(candidatePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureMasweGitExclude(repositoryPath: string): Promise<void> {
  if (!(await isGitRepository(repositoryPath))) return;
  const resolved = await gitExec("git", ["rev-parse", "--git-path", "info/exclude"], repositoryPath);
  if (resolved.exitCode !== 0) {
    throw new Error(`Failed to resolve info/exclude: ${resolved.stderr}`);
  }
  const excludePath = path.isAbsolute(resolved.stdout.trim())
    ? resolved.stdout.trim()
    : path.resolve(repositoryPath, resolved.stdout.trim());
  await mkdir(path.dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  if (!existing.split(/\r?\n/).includes(".maswe/")) {
    await appendFile(
      excludePath,
      `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.maswe/\n`,
      "utf8",
    );
  }
}

export async function captureWorkspace(cwd: string): Promise<RunWorkspace> {
  if (!(await isGitRepository(cwd))) {
    return {
      baseSha: "not-a-git-repository",
      headSha: "not-a-git-repository",
      branch: "not-a-git-repository",
      fingerprint: await gitWorkspaceFingerprint(cwd),
    };
  }
  const headSha = await gitRevParse(cwd, "HEAD");
  const remote = await gitRemoteUrl(cwd);
  return {
    ...(remote ? { remote } : {}),
    baseSha: headSha,
    headSha,
    branch: await gitCurrentBranch(cwd),
    fingerprint: await gitWorkspaceFingerprint(cwd),
  };
}

export async function assertExpectedBranch(cwd: string, expectedBranch: string): Promise<void> {
  if (!(await isGitRepository(cwd))) return;
  if (expectedBranch === "not-a-git-repository") return;
  const actual = await gitCurrentBranch(cwd);
  if (actual !== expectedBranch) {
    throw new Error(
      `Unexpected branch movement: expected ${expectedBranch}, currently on ${actual}`,
    );
  }
}

export async function refreshWorkspaceHead(run: RunRecord): Promise<string | undefined> {
  if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return undefined;
  const cwd = workingDirectoryFor(run);
  await assertExpectedBranch(cwd, run.workspace.branch);
  const headSha = await gitRevParse(cwd, "HEAD");
  run.workspace.headSha = headSha;
  run.workspace.fingerprint = await gitWorkspaceFingerprint(cwd);
  return headSha;
}

export function invalidateStaleEvidence(run: RunRecord, headSha: string): boolean {
  if (!run.evidence) return false;
  let invalidated = false;
  if (run.evidence.quality && run.evidence.quality.headSha !== headSha) {
    delete run.evidence.quality;
    invalidated = true;
  }
  if (run.evidence.verification && run.evidence.verification.headSha !== headSha) {
    delete run.evidence.verification;
    invalidated = true;
  }
  if (run.evidence.mergeReady && run.evidence.mergeReady.headSha !== headSha) {
    delete run.evidence.mergeReady;
    invalidated = true;
  }
  if (
    run.evidence &&
    !run.evidence.quality &&
    !run.evidence.verification &&
    !run.evidence.mergeReady
  ) {
    delete run.evidence;
  }
  return invalidated;
}

export async function listWorkingTreePaths(cwd: string): Promise<string[]> {
  const status = await gitExec(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
  );
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr}`);
  const files: string[] = [];
  const parts = status.stdout.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    // Porcelain -z entries start with two status letters and a space.
    if (entry.length < 3 || entry[2] !== " ") continue;
    const code = entry.slice(0, 2);
    const pathPart = entry.slice(3);
    if (/[RC]/.test(code)) {
      // Porcelain -z rename/copy: "XY dest\0origin\0" — keep destination, skip origin.
      files.push(pathPart);
      index += 1;
    } else {
      files.push(pathPart);
    }
  }
  return files;
}

export async function assertWorkingTreeScope(
  cwd: string,
  allowedPathGlobs: string[],
): Promise<string[]> {
  const files = await listWorkingTreePaths(cwd);
  const disallowed = files.filter((file) => !pathAllowed(file, allowedPathGlobs));
  if (disallowed.length > 0) {
    throw new Error(`Change-scope violation: ${disallowed.join(", ")}`);
  }
  return files;
}

export async function ensureRunWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace> {
  await ensureMasweGitExclude(repositoryPath);
  const base = await captureWorkspace(repositoryPath);
  if (!run.config.policy.useIsolatedWorktree) {
    return base;
  }
  if (!(await isGitRepository(repositoryPath))) {
    throw new Error("Isolated worktrees require a git repository.");
  }

  const branch = `maswe/${run.id}`;
  const worktreePath = externalWorktreePath(repositoryPath, run.id);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const createBranch = await gitExec("git", ["branch", branch, "HEAD"], repositoryPath);
  if (createBranch.exitCode !== 0 && !/already exists/i.test(createBranch.stderr)) {
    throw new Error(`Failed to create branch ${branch}: ${createBranch.stderr}`);
  }

  const addWorktree = await gitExec(
    "git",
    ["worktree", "add", worktreePath, branch],
    repositoryPath,
  );
  if (addWorktree.exitCode !== 0 && !/already exists|already checked out/i.test(addWorktree.stderr)) {
    const existing = await gitExec("git", ["rev-parse", "--is-inside-work-tree"], worktreePath);
    if (existing.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${addWorktree.stderr}`);
    }
  }

  return {
    ...base,
    branch,
    worktreePath,
    fingerprint: await gitWorkspaceFingerprint(worktreePath),
    headSha: await gitRevParse(worktreePath, "HEAD"),
  };
}

export async function createDeterministicCommit(
  cwd: string,
  message: string,
  options: { allowedPathGlobs: string[]; expectedParentSha: string },
): Promise<{ headSha: string; files: string[] }> {
  const branch = await gitCurrentBranch(cwd);
  if (branch === "HEAD") {
    throw new Error("Deterministic commit requires an attached branch; workspace HEAD is detached");
  }
  const initialHeadSha = await gitRevParse(cwd, "HEAD");
  if (initialHeadSha !== options.expectedParentSha) {
    throw new Error(
      `Deterministic commit expected parent ${options.expectedParentSha}, but HEAD moved to ${initialHeadSha}`,
    );
  }
  await assertWorkingTreeScope(cwd, options.allowedPathGlobs);

  const status = await gitExec("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr}`);
  if (!status.stdout.trim()) {
    const currentBranch = await gitCurrentBranch(cwd);
    const currentHeadSha = await gitRevParse(cwd, "HEAD");
    if (currentBranch !== branch || currentHeadSha !== options.expectedParentSha) {
      throw new Error(
        `Deterministic commit input moved: expected ${branch}@${options.expectedParentSha}, found ${currentBranch}@${currentHeadSha}`,
      );
    }
    return { headSha: options.expectedParentSha, files: [] };
  }

  const add = await gitExec("git", ["add", "-A"], cwd);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const staged = await gitExec("git", ["diff", "--cached", "--name-only", "-z"], cwd);
  const files = staged.stdout
    .split("\0")
    .map((line) => line.trim())
    .filter(Boolean);
  const disallowed = files.filter((file) => !pathAllowed(file, options.allowedPathGlobs));
  if (disallowed.length > 0) {
    throw new Error(`Change-scope violation: ${disallowed.join(", ")}`);
  }

  const tree = await gitExec("git", ["write-tree"], cwd);
  if (tree.exitCode !== 0) {
    throw new Error(`git write-tree failed: ${tree.stderr || tree.stdout}`);
  }
  const currentBranch = await gitCurrentBranch(cwd);
  const currentHeadSha = await gitRevParse(cwd, "HEAD");
  if (currentBranch !== branch || currentHeadSha !== options.expectedParentSha) {
    throw new Error(
      `Deterministic commit input moved: expected ${branch}@${options.expectedParentSha}, found ${currentBranch}@${currentHeadSha}`,
    );
  }

  const commit = await gitExec(
    "git",
    ["commit-tree", tree.stdout.trim(), "-p", options.expectedParentSha, "-m", message],
    cwd,
  );
  if (commit.exitCode !== 0) {
    throw new Error(`git commit-tree failed: ${commit.stderr || commit.stdout}`);
  }
  const commitSha = commit.stdout.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)) {
    throw new Error("git commit-tree returned a malformed commit object name");
  }
  const publishedParentSha = await gitRevParse(cwd, `${commitSha}^`);
  if (publishedParentSha !== options.expectedParentSha) {
    throw new Error(
      `Deterministic commit parent ${publishedParentSha} does not match expected input ${options.expectedParentSha}`,
    );
  }

  const update = await gitExec(
    "git",
    ["update-ref", `refs/heads/${branch}`, commitSha, options.expectedParentSha],
    cwd,
  );
  if (update.exitCode !== 0) {
    throw new Error(
      `Deterministic commit publication lost its expected-old-SHA fence: ${update.stderr || update.stdout}`,
    );
  }
  if ((await gitCurrentBranch(cwd)) !== branch || (await gitRevParse(cwd, "HEAD")) !== commitSha) {
    throw new Error("Deterministic commit publication did not retain the expected branch and HEAD");
  }

  if (!(await isGitWorkspaceClean(cwd))) {
    throw new Error("worktree remained dirty after deterministic commit");
  }

  return { headSha: commitSha, files };
}

export async function assertChangeScope(
  cwd: string,
  baseSha: string,
  allowedPathGlobs: string[],
): Promise<string[]> {
  const files = await gitChangedFiles(cwd, baseSha, "HEAD");
  const disallowed = files.filter((file) => !pathAllowed(file, allowedPathGlobs));
  if (disallowed.length > 0) {
    throw new Error(`Change-scope violation versus base: ${disallowed.join(", ")}`);
  }
  return files;
}

export async function cleanupRunWorkspace(run: RunRecord): Promise<void> {
  if (!run.workspace?.worktreePath) return;
  const repositoryPath = run.repositoryPath;
  const worktreePath = run.workspace.worktreePath;
  // Preserve the failed/completed run branch ref for provenance; only remove the worktree directory.
  const removed = await gitExec("git", ["worktree", "remove", "--force", worktreePath], repositoryPath);
  if (removed.exitCode !== 0) {
    const stillThere = await gitExec("git", ["rev-parse", "--is-inside-work-tree"], worktreePath).catch(
      () => ({ exitCode: 1, stdout: "", stderr: "" }),
    );
    if (stillThere.exitCode === 0) {
      throw new Error(
        `Failed to remove managed worktree ${worktreePath}: ${removed.stderr || removed.stdout}`,
      );
    }
  }
}

export async function cleanupDoctorProbeResources(
  repositoryPath: string,
  probeId: string,
  worktreePath: string,
): Promise<void> {
  const branch = `maswe/${probeId}`;
  // Missing worktree is not itself a cleanup failure.
  const removed = await gitExec("git", ["worktree", "remove", "--force", worktreePath], repositoryPath).catch(
    () => ({ exitCode: 1, stdout: "", stderr: "worktree remove unavailable" }),
  );
  if (removed.exitCode !== 0) {
    const stillThere = await gitExec("git", ["rev-parse", "--is-inside-work-tree"], worktreePath).catch(
      () => ({ exitCode: 1, stdout: "", stderr: "" }),
    );
    if (stillThere.exitCode === 0) {
      throw new Error(
        `Failed to remove doctor probe worktree ${worktreePath}: ${removed.stderr || removed.stdout}`,
      );
    }
    // Directory may exist without git registration — best-effort rimraf via worktree remove already failed.
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  }
  const deleted = await gitExec("git", ["branch", "-D", branch], repositoryPath);
  if (deleted.exitCode !== 0 && !/not found|doesn't exist/i.test(deleted.stderr)) {
    // Branch may already be gone if worktree remove pruned it; confirm.
    const still = await gitExec("git", ["rev-parse", "--verify", branch], repositoryPath);
    if (still.exitCode === 0) {
      throw new Error(`Failed to delete doctor probe branch ${branch}: ${deleted.stderr}`);
    }
  }
}

export async function restoreRunWorkspace(
  repositoryPath: string,
  run: RunRecord,
): Promise<RunWorkspace> {
  await ensureMasweGitExclude(repositoryPath);
  if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") {
    return captureWorkspace(repositoryPath);
  }
  if (!run.config.policy.useIsolatedWorktree) {
    return {
      ...run.workspace,
      headSha: await gitRevParse(repositoryPath, "HEAD"),
      fingerprint: await gitWorkspaceFingerprint(repositoryPath),
    };
  }

  const branch = run.workspace.branch;
  const headSha = run.workspace.headSha;
  const worktreePath = externalWorktreePath(repositoryPath, run.id);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const existing = await gitExec("git", ["rev-parse", "--verify", branch], repositoryPath);
  if (existing.exitCode !== 0) {
    const create = await gitExec("git", ["branch", branch, headSha], repositoryPath);
    if (create.exitCode !== 0) {
      throw new Error(`Failed to recreate branch ${branch} at ${headSha}: ${create.stderr}`);
    }
  } else if (existing.stdout.trim() !== headSha) {
    throw new Error(
      `Run branch ${branch} moved to ${existing.stdout.trim()} but run.workspace.headSha is ${headSha}. Refusing to discard branch commits; supersede the run or recover manually.`,
    );
  }

  const probe = await gitExec("git", ["rev-parse", "--is-inside-work-tree"], worktreePath).catch(
    () => ({ exitCode: 1, stdout: "", stderr: "missing worktree" }),
  );
  if (probe.exitCode !== 0) {
    const add = await gitExec("git", ["worktree", "add", worktreePath, branch], repositoryPath);
    if (add.exitCode !== 0) {
      throw new Error(`Failed to restore worktree at ${headSha}: ${add.stderr}`);
    }
  }

  const restoredHead = await gitRevParse(worktreePath, "HEAD");
  if (restoredHead !== headSha) {
    throw new Error(
      `Restored worktree HEAD ${restoredHead} does not match preserved headSha ${headSha}`,
    );
  }

  return {
    ...run.workspace,
    branch,
    worktreePath,
    headSha: restoredHead,
    fingerprint: await gitWorkspaceFingerprint(worktreePath),
  };
}

export function workingDirectoryFor(run: RunRecord): string {
  if (run.config.policy.useIsolatedWorktree) {
    if (!run.workspace?.worktreePath) {
      throw new Error(`Run ${run.id} requires an established MASWE-managed worktree`);
    }
    return run.workspace.worktreePath;
  }
  return run.repositoryPath;
}
