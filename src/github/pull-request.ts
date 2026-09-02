import { parseOwnerRepo } from "./adapter-identities.ts";
import type { GitHubHttpClient } from "./http.ts";

/**
 * Exact live pull request target proof (design doc §11, §14).
 *
 * Repository ownership is proven with `base.repo.id` and never `head.repo.id`:
 * a fork pull request legitimately has a different -- or entirely absent --
 * head repository, and must remain valid whenever its base repository is the
 * target. This module therefore never reads `head.repo` at all; callers
 * compare only `baseRepositoryId` against the stable target ID. A different or
 * missing base repository ID is a permanent identity conflict.
 */
export interface GitHubPullRequestSnapshot {
  state: "open" | "closed";
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  baseRepositoryId: number;
  baseRepository: string;
}

const API_ORIGIN = "https://api.github.com";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub pull request ${label} has a malformed ${field}`);
  }
  return value;
}

/**
 * Accepts every canonical `owner/repo` GitHub can issue while rejecting the
 * shapes a downstream consumer could misread (empty segments, extra
 * separators, whitespace). Kept deliberately permissive for the same reason as
 * the canonical repository lookup: over-tightening risks rejecting a real
 * repository and blocking a legitimate ownership proof.
 */
function isCanonicalRepositoryName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

/**
 * Reads the live pull request and parses an exact snapshot of its target.
 *
 * `token` must already be scoped to the target repository ID (purpose
 * `pull-request-read` for association/migration proof, or the already-required
 * `checks` token for publication). Any malformed, missing, or non-canonical
 * field -- including a missing or non-safe-integer `base.repo.id` -- is
 * rejected rather than defaulted.
 */
export async function readGitHubPullRequestSnapshot(options: {
  http: GitHubHttpClient;
  token: string;
  repository: string;
  pullRequestNumber: number;
}): Promise<GitHubPullRequestSnapshot> {
  const { http, token, repository, pullRequestNumber } = options;
  const { owner, repo } = parseOwnerRepo(repository);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error("GitHub pull request number must be a positive safe integer");
  }
  const label = `${repository}#${pullRequestNumber}`;

  const response = await http.request(
    "GET",
    `${API_ORIGIN}/repos/${owner}/${repo}/pulls/${pullRequestNumber}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "maswe-github-app",
      },
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to read GitHub pull request ${label}: HTTP ${response.status}`);
  }

  const body = response.body;
  if (!isPlainObject(body)) {
    throw new Error(`GitHub pull request ${label} response body is malformed`);
  }

  const state = body.state;
  if (state !== "open" && state !== "closed") {
    throw new Error(`GitHub pull request ${label} has a malformed state`);
  }

  const head = body.head;
  if (!isPlainObject(head)) {
    throw new Error(`GitHub pull request ${label} has a malformed head.sha`);
  }
  // `head.repo` is deliberately never read: a fork PR -- including one whose
  // fork was deleted, where GitHub sends `head.repo: null` -- must stay valid
  // as long as its base repository is the target.
  const headSha = requireNonEmptyString(head.sha, "head.sha", label);
  const headRef = requireNonEmptyString(head.ref, "head.ref", label);

  const base = body.base;
  if (!isPlainObject(base)) {
    throw new Error(`GitHub pull request ${label} has a malformed base.sha`);
  }
  const baseSha = requireNonEmptyString(base.sha, "base.sha", label);
  const baseRef = requireNonEmptyString(base.ref, "base.ref", label);

  const baseRepo = base.repo;
  const baseRepositoryId = isPlainObject(baseRepo) ? baseRepo.id : undefined;
  if (
    typeof baseRepositoryId !== "number" ||
    !Number.isSafeInteger(baseRepositoryId) ||
    baseRepositoryId <= 0
  ) {
    throw new Error(
      `GitHub pull request ${label} has a missing or malformed base repository id`,
    );
  }
  const baseRepository = (baseRepo as Record<string, unknown>).full_name;
  if (!isCanonicalRepositoryName(baseRepository)) {
    throw new Error(
      `GitHub pull request ${label} has a missing or malformed base repository name`,
    );
  }

  return {
    state,
    headSha,
    headRef,
    baseSha,
    baseRef,
    baseRepositoryId,
    baseRepository,
  };
}
