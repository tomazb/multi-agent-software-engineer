import { containsDurableAtomicWriteOutcomeUnknown } from "../durable-file.ts";
import { parseOwnerRepo } from "./adapter-identities.ts";
import {
  checkRunIdempotencyKey,
  externalIdFor,
  legacyCheckRunIdempotencyKey,
  type GitHubHttpClient,
} from "./checks.ts";
import { nextGitHubLink, requireSafeGitHubPageUrl } from "./pagination.ts";
import type { GitHubSideEffectStore } from "./side-effect-store.ts";
import { MASWE_CHECK_NAMES, type MasweCheckName } from "./types.ts";

/**
 * Migration authority is production attempt 1 only (design doc §15.1). This
 * module never takes or derives an attempt parameter -- widening beyond
 * attempt 1 requires an explicit, re-reviewed spec change, not a silent code
 * change here.
 */
const LEGACY_MIGRATION_ATTEMPT = 1;

const CHECK_LIST_PAGE_LIMIT = 10;

function requestHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "maswe-github-app",
  };
}

/**
 * Authenticated proof that the GitHub check run at `resourceId` is exactly
 * the referenced legacy check (design doc §15.2 step 4): its name, head SHA,
 * and external id must all match before the same resource id is ever mapped
 * onto the stable local key. A 404 is positive absence (not proven, no
 * alias); any other non-2xx or malformed body is an ambiguous failure and
 * must never be treated as absence (design doc §16 -- ambiguous API failure
 * is not proof), so it throws and is retryable.
 */
async function verifyLegacyCheckRun(options: {
  http: GitHubHttpClient;
  token: string;
  owner: string;
  repo: string;
  resourceId: number;
  checkName: string;
  headSha: string;
  legacyExternalId: string;
}): Promise<boolean> {
  const response = await options.http.request(
    "GET",
    `https://api.github.com/repos/${options.owner}/${options.repo}/check-runs/${options.resourceId}`,
    { headers: requestHeaders(options.token) },
  );
  if (response.status === 404) return false;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `GitHub check-run alias verification failed: HTTP ${response.status}`,
    );
  }
  const body = response.body as {
    name?: unknown;
    head_sha?: unknown;
    external_id?: unknown;
  };
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.name !== "string" ||
    typeof body.head_sha !== "string" ||
    typeof body.external_id !== "string"
  ) {
    throw new Error(
      "GitHub check-run alias verification response body is malformed",
    );
  }
  return (
    body.name === options.checkName &&
    body.head_sha === options.headSha &&
    body.external_id === options.legacyExternalId
  );
}

/**
 * Lists check runs for the exact head/name and returns the distinct resource
 * ids whose `external_id` proves the legacy check (design doc §15.2 step 5).
 * Bounded/URL-safe pagination mirrors `checks.ts`'s reconciliation loop.
 * Duplicate rows for the same id (possible on pagination drift) collapse to
 * one match; genuinely distinct ids sharing the same external id are the
 * ambiguous-ownership conflict the caller must reject (step 6). A row whose
 * `external_id` matches but whose `id` is not a number is a malformed
 * response and throws rather than being silently dropped -- dropping it
 * could collapse a genuine multi-match conflict into a false single-match
 * alias, consistent with the `check_runs` container check above.
 */
async function listMatchingLegacyCheckRuns(options: {
  http: GitHubHttpClient;
  token: string;
  owner: string;
  repo: string;
  headSha: string;
  checkName: string;
  legacyExternalId: string;
}): Promise<number[]> {
  const endpointPath = `/repos/${options.owner}/${options.repo}/commits/${encodeURIComponent(options.headSha)}/check-runs`;
  const initialUrl = new URL(`https://api.github.com${endpointPath}`);
  initialUrl.searchParams.set("check_name", options.checkName);
  initialUrl.searchParams.set("filter", "all");
  initialUrl.searchParams.set("per_page", "100");

  const matches = new Set<number>();
  let pageUrl = initialUrl.toString();
  const visited = new Set<string>();
  for (let page = 0; page < CHECK_LIST_PAGE_LIMIT; page += 1) {
    if (visited.has(pageUrl)) {
      throw new Error("GitHub check-run alias pagination Link loop detected");
    }
    visited.add(pageUrl);
    const response = await options.http.request("GET", pageUrl, {
      headers: requestHeaders(options.token),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub check-run alias listing failed: HTTP ${response.status}`);
    }
    const checkRuns = (
      response.body as { check_runs?: Array<{ id?: unknown; external_id?: unknown }> }
    ).check_runs;
    if (!Array.isArray(checkRuns)) {
      throw new Error("GitHub check-run alias listing response check_runs is malformed");
    }
    for (const run of checkRuns) {
      if (run.external_id !== options.legacyExternalId) continue;
      if (typeof run.id !== "number") {
        // A matching row with a non-number id must never be silently
        // dropped: that would collapse what could be a genuine two-match
        // conflict into a false single-match alias.
        throw new Error(
          "GitHub check-run alias listing response check_runs entry is malformed",
        );
      }
      matches.add(run.id);
    }

    const nextLink = nextGitHubLink(response.headers);
    if (nextLink === undefined) break;
    const nextUrl = requireSafeGitHubPageUrl(nextLink, {
      origin: "https://api.github.com",
      pathname: endpointPath,
      requiredQuery: {
        check_name: options.checkName,
        filter: "all",
        per_page: "100",
      },
      optionalPositiveIntegerQuery: ["page"],
      allowedQueryKeys: ["check_name", "filter", "per_page", "page"],
    });
    if (visited.has(nextUrl)) {
      throw new Error("GitHub check-run alias pagination Link loop detected");
    }
    if (page + 1 >= CHECK_LIST_PAGE_LIMIT) {
      throw new Error("GitHub check-run alias pagination page limit exceeded");
    }
    pageUrl = nextUrl;
  }
  return [...matches];
}

/**
 * Writes the stable-key alias and re-reads on an outcome-unknown durable
 * write (design doc §15.2): the local write is only ever "published but the
 * directory sync failed", so a re-read that confirms the intended resource
 * id landed is safe to treat as success; anything else rethrows.
 */
async function putStableAliasWithOutcomeUnknownRetry(options: {
  sideEffects: GitHubSideEffectStore;
  stableKey: string;
  resourceId: number;
}): Promise<void> {
  try {
    await options.sideEffects.put(options.stableKey, {
      resourceId: options.resourceId,
      kind: "check-run",
    });
  } catch (error) {
    if (!containsDurableAtomicWriteOutcomeUnknown(error)) throw error;
    const reread = await options.sideEffects.get(options.stableKey);
    if (reread?.resourceId !== options.resourceId) throw error;
  }
}

async function aliasOneCheck(options: {
  repositoryId: number;
  legacyRepository: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  checkName: MasweCheckName;
  token: string;
  http: GitHubHttpClient;
  sideEffects: GitHubSideEffectStore;
}): Promise<void> {
  const stableKey = checkRunIdempotencyKey(
    options.repositoryId,
    options.pullRequestNumber,
    options.headSha,
    options.checkName,
    LEGACY_MIGRATION_ATTEMPT,
  );
  await options.sideEffects.withCreateLock(stableKey, async () => {
    // A second rename needs no further side-effect migration: once the
    // stable key is bound, this head/check pair is done -- zero further
    // GitHub calls are ever issued for it again.
    if (await options.sideEffects.get(stableKey)) return;

    const legacyKey = legacyCheckRunIdempotencyKey(
      options.legacyRepository,
      options.pullRequestNumber,
      options.headSha,
      options.checkName,
      LEGACY_MIGRATION_ATTEMPT,
    );
    const legacyExternalId = externalIdFor(legacyKey);

    let resourceId: number | undefined;
    const localLegacy = await options.sideEffects.get(legacyKey);
    if (localLegacy) {
      const verified = await verifyLegacyCheckRun({
        http: options.http,
        token: options.token,
        owner: options.owner,
        repo: options.repo,
        resourceId: localLegacy.resourceId,
        checkName: options.checkName,
        headSha: options.headSha,
        legacyExternalId,
      });
      if (verified) resourceId = localLegacy.resourceId;
      // Wrong head/name/external-id ownership: never manufacture an alias.
    } else {
      const matches = await listMatchingLegacyCheckRuns({
        http: options.http,
        token: options.token,
        owner: options.owner,
        repo: options.repo,
        headSha: options.headSha,
        checkName: options.checkName,
        legacyExternalId,
      });
      if (matches.length > 1) {
        throw new Error(
          `GitHub legacy check alias is ambiguous: multiple check runs match external id ${legacyExternalId} for ${options.owner}/${options.repo}#${options.pullRequestNumber} "${options.checkName}"@${options.headSha}`,
        );
      }
      if (matches.length === 1) resourceId = matches[0];
    }

    // If no legacy check is proven, do not manufacture an alias (§15.2 step 7).
    if (resourceId === undefined) return;

    await putStableAliasWithOutcomeUnknownRetry({
      sideEffects: options.sideEffects,
      stableKey,
      resourceId,
    });
  });
}

/**
 * One-time authenticated legacy production check aliasing (design doc §15.2).
 *
 * For every operationally relevant head SHA and MASWE check name, proves --
 * under authentication, conservatively -- that a pre-rename attempt-1 check
 * run exists before mapping its GitHub resource id onto the new stable
 * `repositoryId`-keyed idempotency key. Never manufactures an alias: a head/
 * check pair with no provable legacy check is left unmigrated, and the first
 * post-rename publication creates it fresh under the stable key.
 *
 * Migration authority is production attempt 1 only (design doc §15.1); this
 * function hardcodes attempt 1 internally and takes no attempt parameter.
 * Old legacy side-effect records are historical recovery evidence and are
 * never deleted or rewritten here.
 *
 * `repository` is the current, reconciled canonical name and is used only to
 * route the authenticated GitHub REST calls; `legacyRepository` is used only
 * to derive the pre-rename key/external id. Neither ever authorizes anything
 * -- `repositoryId` is the sole identity anchor.
 */
export async function aliasLegacyAttemptOneChecks(options: {
  repositoryId: number;
  legacyRepository: string;
  repository: string;
  pullRequestNumber: number;
  headShas: readonly string[];
  token: string;
  http: GitHubHttpClient;
  sideEffects: GitHubSideEffectStore;
}): Promise<void> {
  const { owner, repo } = parseOwnerRepo(options.repository);
  const headShas = [...new Set(options.headShas)];
  for (const headSha of headShas) {
    for (const checkName of MASWE_CHECK_NAMES) {
      await aliasOneCheck({
        repositoryId: options.repositoryId,
        legacyRepository: options.legacyRepository,
        owner,
        repo,
        pullRequestNumber: options.pullRequestNumber,
        headSha,
        checkName,
        token: options.token,
        http: options.http,
        sideEffects: options.sideEffects,
      });
    }
  }
}
