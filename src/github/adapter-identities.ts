import type {
  GitHubAppConfig,
  RunGitHubAssociation,
  StableRunGitHubAssociation,
} from "../domain.ts";
import path from "node:path";

const MAX_PENDING_CANCELLATION_HEADS = 64;

export function githubStateRoot(cwd: string): string {
  return path.join(cwd, ".maswe", "github");
}

export function parseOwnerRepo(repository: string): { owner: string; repo: string } {
  const match = repository.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`Invalid repository: ${repository}`);
  return { owner: match[1]!, repo: match[2]! };
}

export function isRepoAllowed(
  config: GitHubAppConfig,
  repository: string | undefined,
): boolean {
  if (!repository) return false;
  return config.allowedRepositories.includes(repository);
}

/**
 * Operational repository authorization (design doc §3.2).
 *
 * Consults `allowedRepositoryIds` only. A mutable `owner/repo` name is
 * routing/display/candidate metadata and must never authorize anything, so a
 * name present in `allowedRepositories` grants nothing here.
 */
export function isRepositoryIdAllowed(
  config: GitHubAppConfig,
  repositoryId: number | undefined,
): boolean {
  if (repositoryId === undefined) return false;
  return config.allowedRepositoryIds.includes(repositoryId);
}

/**
 * The single validity predicate for a stable repository id: a positive safe
 * integer. Every guard that decides whether a record/association is stable
 * must delegate here so their strictness cannot drift apart.
 */
export function isStableRepositoryId(repositoryId: number | undefined): repositoryId is number {
  return (
    typeof repositoryId === "number" && Number.isSafeInteger(repositoryId) && repositoryId > 0
  );
}

/**
 * Rejects unresolved legacy state before any stable repository/PR publication
 * fence is acquired (design doc §8).
 *
 * An ID-less (or malformed-ID) association is a historical record that has not
 * been migrated yet. It is never silently upgraded here -- resolving it needs
 * live installation proof -- so this fails closed with an explicit
 * migration-required error that names the legacy selector.
 */
export function requireStableGitHubAssociation(
  association: RunGitHubAssociation | undefined,
): StableRunGitHubAssociation {
  if (association === undefined) {
    throw new Error(
      "GitHub association is missing its stable repository id; explicit migration is required",
    );
  }
  if (!isStableRepositoryId(association.repositoryId)) {
    throw new Error(
      `GitHub association ${association.repository}#${association.pullRequestNumber} is missing its stable repository id; explicit migration is required`,
    );
  }
  return association as StableRunGitHubAssociation;
}

export function pendingCancellationHeads(
  existing: readonly string[] | undefined,
  previousHeadSha: string | undefined,
  currentHeadSha: string,
): string[] {
  const pending = new Set(existing ?? []);
  if (previousHeadSha && previousHeadSha !== currentHeadSha) pending.add(previousHeadSha);
  pending.delete(currentHeadSha);
  const result = [...pending].sort();
  if (result.length > MAX_PENDING_CANCELLATION_HEADS) {
    throw new Error("GitHub pending check cancellation limit exceeded");
  }
  return result;
}

/** Match only github.com remotes (HTTPS or SSH) to owner/repo. Plain HTTP is rejected. */
export function remoteMatchesRepository(
  remote: string | undefined,
  repository: string,
): boolean {
  if (!remote) return false;
  const trimmed = remote.trim().replace(/\.git$/i, "");
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) {
    return `${https[1]}/${https[2]}`.toLowerCase() === repository.toLowerCase();
  }
  const sshScp = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshScp) {
    return `${sshScp[1]}/${sshScp[2]}`.toLowerCase() === repository.toLowerCase();
  }
  const sshUrl = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (sshUrl) {
    return `${sshUrl[1]}/${sshUrl[2]}`.toLowerCase() === repository.toLowerCase();
  }
  return false;
}
