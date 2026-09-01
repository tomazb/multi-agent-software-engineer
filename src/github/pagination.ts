/**
 * Shared hardened GitHub Link-header pagination primitives.
 *
 * Extracted from `checks.ts`'s check-run reconciliation pagination so the
 * same hardened URL/loop policy can be reused by the canonical repository
 * lookup in `repository-identity.ts` without duplicating the parsing rules.
 *
 * `nextGitHubLink` and `requireSafeGitHubPageUrl` intentionally take no
 * caller-specific message/context parameter: their signatures are frozen by
 * the Issue #34 Task 3 brief. Callers that must preserve a specific historical
 * error message (e.g. `checks.ts`'s check-run pagination errors) catch
 * `GitHubPaginationError` and remap by `.code` to their own exact strings
 * rather than parameterizing this module's generic messages.
 */

export type GitHubPaginationErrorCode =
  | "link-header-malformed"
  | "link-multiple-next"
  | "link-url-malformed"
  | "link-url-unsafe";

export class GitHubPaginationError extends Error {
  readonly code: GitHubPaginationErrorCode;

  constructor(code: GitHubPaginationErrorCode, message: string) {
    super(message);
    this.name = "GitHubPaginationError";
    this.code = code;
  }
}

/** Case-insensitive single HTTP header lookup. */
export function headerValue(
  headers: Record<string, string>,
  expectedName: string,
): string | undefined {
  const normalizedExpectedName = expectedName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedExpectedName) return value;
  }
  return undefined;
}

/** Extracts the `rel="next"` URL from a GitHub `Link` response header, if any. */
export function nextGitHubLink(headers: Record<string, string>): string | undefined {
  const value = headerValue(headers, "link");
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new GitHubPaginationError("link-header-malformed", "GitHub pagination Link header is malformed");
  }

  let nextUrl: string | undefined;
  for (const segment of value.split(",")) {
    const link = /^\s*<([^<>]+)>(.*)$/.exec(segment);
    if (!link) {
      throw new GitHubPaginationError("link-header-malformed", "GitHub pagination Link header is malformed");
    }
    const parameterText = link[2]!;
    const parameters = parameterText.split(";");
    if (parameters.shift()!.trim() !== "") {
      throw new GitHubPaginationError("link-header-malformed", "GitHub pagination Link header is malformed");
    }

    let relations: string[] = [];
    let hasRelationParameter = false;
    for (const parameter of parameters) {
      const parsed = /^\s*([^=\s]+)\s*=\s*(?:"([^"]*)"|([^"\s;]+))\s*$/.exec(parameter);
      if (!parsed) {
        throw new GitHubPaginationError("link-header-malformed", "GitHub pagination Link header is malformed");
      }
      if (parsed[1]!.toLowerCase() === "rel") {
        if (hasRelationParameter) {
          throw new GitHubPaginationError("link-header-malformed", "GitHub pagination Link header is malformed");
        }
        hasRelationParameter = true;
        relations = (parsed[2] ?? parsed[3] ?? "").split(/\s+/).filter(Boolean);
        const normalizedRelations = relations.map((relation) => relation.toLowerCase());
        if (new Set(normalizedRelations).size !== normalizedRelations.length) {
          throw new GitHubPaginationError("link-header-malformed", "GitHub pagination Link header is malformed");
        }
      }
    }
    if (!relations.some((relation) => relation.toLowerCase() === "next")) continue;
    if (nextUrl !== undefined) {
      throw new GitHubPaginationError(
        "link-multiple-next",
        "GitHub pagination Link header has multiple next links",
      );
    }
    nextUrl = link[1]!;
  }
  return nextUrl;
}

/**
 * Validates a candidate next-page URL against a strict allow-list policy and
 * returns its normalized string form. Throws `GitHubPaginationError` on any
 * violation.
 */
export function requireSafeGitHubPageUrl(
  rawUrl: string,
  policy: {
    origin: string;
    pathname: string;
    requiredQuery: Record<string, string>;
    optionalPositiveIntegerQuery: readonly string[];
    allowedQueryKeys: readonly string[];
  },
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GitHubPaginationError("link-url-malformed", "GitHub pagination Link URL is malformed");
  }

  const allowedQueryKeys = new Set(policy.allowedQueryKeys);
  const hasOnlyAllowedQueryKeys = Array.from(parsed.searchParams.keys()).every((key) =>
    allowedQueryKeys.has(key),
  );
  const hasExactSingleValue = (key: string, expected: string): boolean => {
    const values = parsed.searchParams.getAll(key);
    return values.length === 1 && values[0] === expected;
  };
  const hasValidOptionalPositiveInteger = (key: string): boolean => {
    const values = parsed.searchParams.getAll(key);
    return values.length === 0 || (values.length === 1 && /^[1-9]\d*$/.test(values[0]!));
  };

  const requiredOk = Object.entries(policy.requiredQuery).every(([key, expected]) =>
    hasExactSingleValue(key, expected),
  );
  const optionalOk = policy.optionalPositiveIntegerQuery.every((key) =>
    hasValidOptionalPositiveInteger(key),
  );

  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== policy.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== policy.pathname ||
    parsed.hash !== "" ||
    !hasOnlyAllowedQueryKeys ||
    !requiredOk ||
    !optionalOk
  ) {
    throw new GitHubPaginationError("link-url-unsafe", "GitHub pagination Link URL is unsafe");
  }
  return parsed.toString();
}

/** True when a GitHub API response indicates primary or secondary rate limiting. */
export function isRateLimited(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const remaining = headerValue(headers, "x-ratelimit-remaining");
  if (remaining === "0") return true;
  const message =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : "";
  return /rate limit/i.test(message);
}
