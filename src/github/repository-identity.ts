import type { GitHubHttpClient } from "./http.ts";
import {
  GitHubPaginationError,
  isRateLimited,
  nextGitHubLink,
  requireSafeGitHubPageUrl,
} from "./pagination.ts";

/**
 * Authenticated canonical repository lookup (design doc §5, §5.1, §5.2).
 *
 * Uses the documented `GET /installation/repositories` listing endpoint with
 * an ID-scoped installation token, bounded pagination, strict Link-header
 * URL policy, cross-page ID/name consistency, and canonical-name validation.
 * A fully successful traversal reaching the terminal page without the
 * requested ID is positive evidence of absence (`{ kind: "not-found" }`).
 * Every other failure mode -- traversal-limit exhaustion, malformed/unsafe
 * pagination, loops, rate limiting, transport failure, upstream 5xx, or a
 * duplicate ID with a conflicting name -- is ambiguous and throws a typed
 * `GitHubRepositoryLookupError` instead, so an ambiguous failure can never be
 * mistaken for clean absence.
 */

export type InstallationRepositoryLookupResult =
  | { kind: "found"; repositoryId: number; repository: string }
  | { kind: "not-found" };

/**
 * `traversal-limit-exceeded` is a distinct, operator-facing code: it means
 * the 100-page bound was hit, not that the repository is absent or that
 * authorization was revoked. Every other code here is likewise never proof
 * of revocation -- callers must not synthesize `not-found` from any of them.
 */
export type GitHubRepositoryLookupErrorCode =
  | "traversal-limit-exceeded"
  | "pagination-link-malformed"
  | "pagination-link-unsafe"
  | "pagination-loop-detected"
  | "malformed-response"
  | "canonical-name-invalid"
  | "duplicate-id-conflicting-name"
  | "rate-limited"
  | "transport-failure"
  | "upstream-error";

export class GitHubRepositoryLookupError extends Error {
  readonly code: GitHubRepositoryLookupErrorCode;
  /** True when a caller may retry the same lookup later without operator intervention. */
  readonly retryable: boolean;

  constructor(code: GitHubRepositoryLookupErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "GitHubRepositoryLookupError";
    this.code = code;
    this.retryable = retryable;
  }
}

const API_ORIGIN = "https://api.github.com";
const LISTING_PATHNAME = "/installation/repositories";
const MAX_LOOKUP_PAGES = 100;

const NEXT_LINK_POLICY = {
  origin: API_ORIGIN,
  pathname: LISTING_PATHNAME,
  requiredQuery: { per_page: "100" },
  optionalPositiveIntegerQuery: ["page"] as readonly string[],
  allowedQueryKeys: ["per_page", "page"] as readonly string[],
};

function malformed(message: string): never {
  throw new GitHubRepositoryLookupError("malformed-response", message, false);
}

function validateRow(row: unknown): { id: number; name: string } {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    malformed("GitHub installation repository lookup response row is malformed");
  }
  const id = (row as { id?: unknown }).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    malformed("GitHub installation repository lookup response row id is malformed");
  }
  const fullName = (row as { full_name?: unknown }).full_name;
  if (typeof fullName !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    throw new GitHubRepositoryLookupError(
      "canonical-name-invalid",
      "GitHub installation repository lookup response row full_name is not a valid owner/repo canonical name",
      false,
    );
  }
  return { id: id as number, name: fullName.toLowerCase() };
}

/** Maps the shared pagination parser's generic error onto this module's error taxonomy. */
function remapPaginationError(error: unknown): never {
  if (error instanceof GitHubPaginationError) {
    switch (error.code) {
      case "link-header-malformed":
      case "link-multiple-next":
        throw new GitHubRepositoryLookupError("pagination-link-malformed", error.message, false);
      case "link-url-malformed":
        throw new GitHubRepositoryLookupError("pagination-link-malformed", error.message, false);
      case "link-url-unsafe":
        throw new GitHubRepositoryLookupError("pagination-link-unsafe", error.message, false);
    }
  }
  throw error;
}

/**
 * Looks up the canonical `{ repositoryId, repository }` identity for
 * `repositoryId` using an already-scoped installation access token (see
 * `createRepositoryInstallationAccessToken` with purpose `metadata-reconcile`).
 */
export async function lookupCanonicalGitHubRepository(options: {
  http: GitHubHttpClient;
  token: string;
  repositoryId: number;
}): Promise<InstallationRepositoryLookupResult> {
  const { http, token, repositoryId } = options;
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("GitHub repository id must be a positive safe integer");
  }

  const initialUrl = new URL(`${API_ORIGIN}${LISTING_PATHNAME}`);
  initialUrl.searchParams.set("per_page", "100");

  const visited = new Set<string>();
  const seen = new Map<number, string>();
  let pageUrl = initialUrl.toString();

  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    if (visited.has(pageUrl)) {
      throw new GitHubRepositoryLookupError(
        "pagination-loop-detected",
        "GitHub installation repository lookup pagination loop detected",
        false,
      );
    }
    visited.add(pageUrl);

    let response: { status: number; headers: Record<string, string>; body: unknown };
    try {
      response = await http.request("GET", pageUrl, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "maswe-github-app",
        },
      });
    } catch (error) {
      throw new GitHubRepositoryLookupError(
        "transport-failure",
        `GitHub installation repository lookup transport failure: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      if (isRateLimited(response.status, response.headers, response.body)) {
        throw new GitHubRepositoryLookupError(
          "rate-limited",
          "GitHub installation repository lookup was rate limited",
          true,
        );
      }
      throw new GitHubRepositoryLookupError(
        "upstream-error",
        `GitHub installation repository lookup failed: HTTP ${response.status}`,
        response.status >= 500,
      );
    }

    const body = response.body;
    const rows =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { repositories?: unknown }).repositories
        : undefined;
    if (!Array.isArray(rows)) {
      malformed("GitHub installation repository lookup response repositories is malformed");
    }

    for (const row of rows) {
      const { id, name } = validateRow(row);
      const priorName = seen.get(id);
      if (priorName !== undefined && priorName !== name) {
        throw new GitHubRepositoryLookupError(
          "duplicate-id-conflicting-name",
          `GitHub installation repository lookup saw repository id ${id} with conflicting names '${priorName}' and '${name}'`,
          false,
        );
      }
      seen.set(id, name);
      if (id === repositoryId) {
        return { kind: "found", repositoryId: id, repository: name };
      }
    }

    let nextLink: string | undefined;
    try {
      nextLink = nextGitHubLink(response.headers);
    } catch (error) {
      remapPaginationError(error);
    }
    if (nextLink === undefined) {
      return { kind: "not-found" };
    }

    let nextUrl: string;
    try {
      nextUrl = requireSafeGitHubPageUrl(nextLink, NEXT_LINK_POLICY);
    } catch (error) {
      remapPaginationError(error);
    }

    if (visited.has(nextUrl)) {
      throw new GitHubRepositoryLookupError(
        "pagination-loop-detected",
        "GitHub installation repository lookup pagination loop detected",
        false,
      );
    }
    if (page + 1 >= MAX_LOOKUP_PAGES) {
      throw new GitHubRepositoryLookupError(
        "traversal-limit-exceeded",
        `GitHub installation repository lookup exceeded the ${MAX_LOOKUP_PAGES}-page traversal limit`,
        false,
      );
    }
    pageUrl = nextUrl;
  }

  throw new GitHubRepositoryLookupError(
    "traversal-limit-exceeded",
    `GitHub installation repository lookup exceeded the ${MAX_LOOKUP_PAGES}-page traversal limit`,
    false,
  );
}
