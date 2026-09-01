import { createHash } from "node:crypto";
import type { RunRecord } from "../domain.ts";
import type { GitHubHttpClient } from "./http.ts";
import {
  GitHubPaginationError,
  headerValue,
  isRateLimited,
  nextGitHubLink,
  requireSafeGitHubPageUrl,
} from "./pagination.ts";
import type { GitHubSideEffectStore } from "./side-effect-store.ts";
import { MASWE_CHECK_NAMES, type MasweCheckName } from "./types.ts";

export { isRateLimited } from "./pagination.ts";

export type { GitHubHttpClient } from "./http.ts";

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required";

export interface CheckOutcome {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

export type WriteSideEffectKind = "checks" | "push" | "pull_request_write" | "comment_reply";

export function assertReadOnlyChecksMode(
  readOnlyChecks: boolean,
  kind: WriteSideEffectKind,
): void {
  if (!readOnlyChecks) return;
  if (kind === "checks") return;
  throw new Error(
    `GitHub App is in read-only check mode; refusing side effect kind '${kind}'`,
  );
}

function hasApprovedSpecArtifacts(run: RunRecord): boolean {
  if (!run.approvals.brainstorm || !run.approvals.design) return false;
  const logical = new Set(run.artifacts.map((a) => a.logicalName));
  return (
    logical.has("02-brainstorm.md") && logical.has("03-specification-and-design.md")
  );
}

export function buildCheckConclusions(
  run: RunRecord,
  headSha: string,
): Record<MasweCheckName, CheckOutcome> {
  const quality = run.evidence?.quality;
  const verification = run.evidence?.verification;

  return {
    "MASWE / specification compliance": hasApprovedSpecArtifacts(run)
      ? {
          conclusion: "success",
          title: "Specification approved",
          summary: `Brainstorm and design approvals present for run ${run.id}.`,
        }
      : {
          conclusion: "action_required",
          title: "Specification incomplete",
          summary: "Approved brainstorm/design artifacts are required before specification compliance succeeds.",
        },
    "MASWE / deterministic quality":
      quality?.passed && quality.headSha === headSha
        ? {
            conclusion: "success",
            title: "Quality passed",
            summary: `Deterministic quality passed for head SHA ${headSha}.`,
          }
        : {
            conclusion: "neutral",
            title: "Quality not bound to this SHA",
            summary:
              quality?.headSha && quality.headSha !== headSha
                ? `Quality evidence is for ${quality.headSha}, not ${headSha}.`
                : `No passing quality evidence for head SHA ${headSha}.`,
          },
    "MASWE / independent verification":
      verification?.passed && verification.headSha === headSha
        ? {
            conclusion: "success",
            title: "Verification passed",
            summary: `Independent verification passed for head SHA ${headSha}.`,
          }
        : {
            conclusion: "neutral",
            title: "Verification not bound to this SHA",
            summary:
              verification?.headSha && verification.headSha !== headSha
                ? `Verification evidence is for ${verification.headSha}, not ${headSha}.`
                : `No passing verification evidence for head SHA ${headSha}.`,
          },
    "MASWE / review comments resolved": {
      conclusion: "neutral",
      title: "Review resolution deferred",
      summary: "Phase A read-only pilot does not resolve review comments yet.",
    },
  };
}

function idempotencyKey(
  owner: string,
  repo: string,
  pullRequestNumber: number,
  headSha: string,
  checkName: string,
  attempt: number,
): string {
  return `check-run:${owner}/${repo}/${pullRequestNumber}/${headSha}/${checkName}/${attempt}`;
}

export function externalIdFor(key: string): string {
  return `maswe:check-run:sha256:${createHash("sha256").update(key).digest("hex")}`;
}

const CHECK_RECONCILIATION_PAGE_LIMIT = 10;

/**
 * Extracted `nextGitHubLink`/`requireSafeGitHubPageUrl` (pagination.ts) throw
 * a generic `GitHubPaginationError` since their signatures are frozen and
 * carry no caller-specific message context. This remaps the extracted error
 * codes back onto the exact historical check-run pagination strings that
 * existing tests assert on verbatim, so the extraction changes no observable
 * behavior.
 */
function remapCheckPaginationError(error: unknown): never {
  if (error instanceof GitHubPaginationError) {
    switch (error.code) {
      case "link-header-malformed":
        throw new Error("GitHub check-run pagination Link header is malformed");
      case "link-multiple-next":
        throw new Error("GitHub check-run pagination Link header has multiple next links");
      case "link-url-malformed":
        throw new Error("GitHub check-run pagination Link URL is malformed");
      case "link-url-unsafe":
        throw new Error("GitHub check-run pagination Link URL is unsafe");
    }
  }
  throw error;
}

function rateLimitDelayMs(headers: Record<string, string>, attempt: number): number {
  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, 30_000);
  }
  const reset = headerValue(headers, "x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const until = Number(reset) * 1000 - Date.now();
    if (until > 0) return Math.min(until, 30_000);
  }
  return Math.min(250 * 2 ** attempt, 5_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CheckPublisher {
  private readonly http: GitHubHttpClient;
  private readonly sideEffects: GitHubSideEffectStore;
  private readonly readOnlyChecks: boolean;
  private readonly owner: string;
  private readonly repo: string;
  private readonly pullRequestNumber: number;
  private readonly token: string;
  private readonly attempt: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: {
    http: GitHubHttpClient;
    sideEffects: GitHubSideEffectStore;
    readOnlyChecks: boolean;
    owner: string;
    repo: string;
    pullRequestNumber: number;
    token: string;
    attempt?: number;
    maxRateLimitRetries?: number;
    sleepFn?: (ms: number) => Promise<void>;
  }) {
    this.http = options.http;
    this.sideEffects = options.sideEffects;
    this.readOnlyChecks = options.readOnlyChecks;
    this.owner = options.owner;
    this.repo = options.repo;
    this.pullRequestNumber = options.pullRequestNumber;
    this.token = options.token;
    this.attempt = options.attempt ?? 1;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 4;
    this.sleepFn = options.sleepFn ?? sleep;
  }

  async publishForHeadSha(
    run: RunRecord,
    headSha: string,
    options: { previousHeadSha?: string; previousHeadShas?: readonly string[] } = {},
  ): Promise<{ createdOrUpdated: string[] }> {
    assertReadOnlyChecksMode(this.readOnlyChecks, "checks");
    const previousHeadShas = new Set([
      ...(options.previousHeadShas ?? []),
      ...(options.previousHeadSha ? [options.previousHeadSha] : []),
    ]);
    previousHeadShas.delete(headSha);
    for (const previousHeadSha of [...previousHeadShas].sort()) {
      await this.invalidatePreviousSha(previousHeadSha);
    }

    const conclusions = buildCheckConclusions(run, headSha);
    const createdOrUpdated: string[] = [];
    for (const name of MASWE_CHECK_NAMES) {
      await this.upsertCheck(name, headSha, conclusions[name]);
      createdOrUpdated.push(name);
    }
    return { createdOrUpdated };
  }

  private async invalidatePreviousSha(previousHeadSha: string): Promise<void> {
    for (const name of MASWE_CHECK_NAMES) {
      const key = idempotencyKey(
        this.owner,
        this.repo,
        this.pullRequestNumber,
        previousHeadSha,
        name,
        this.attempt,
      );
      const existing = await this.sideEffects.get(key);
      const resourceId = existing?.resourceId ?? await this.reconcileExistingCheck(
        name,
        previousHeadSha,
        externalIdFor(key),
      );
      if (resourceId === undefined) continue;
      if (!existing) {
        await this.sideEffects.put(key, { resourceId, kind: "check-run" });
      }
      await this.patchCheck(resourceId, {
        conclusion: "cancelled",
        title: "Superseded by newer head SHA",
        summary: `Invalidated because a newer head SHA was evaluated for PR #${this.pullRequestNumber}.`,
      });
    }
  }

  private async upsertCheck(
    name: MasweCheckName,
    headSha: string,
    outcome: CheckOutcome,
  ): Promise<void> {
    const key = idempotencyKey(
      this.owner,
      this.repo,
      this.pullRequestNumber,
      headSha,
      name,
      this.attempt,
    );
    await this.sideEffects.withCreateLock(key, async () => {
      const externalId = externalIdFor(key);
      const existing = await this.sideEffects.get(key);
      if (existing) {
        await this.patchCheck(existing.resourceId, outcome);
        return;
      }

      const reconciled = await this.reconcileExistingCheck(name, headSha, externalId);
      if (reconciled !== undefined) {
        await this.sideEffects.put(key, { resourceId: reconciled, kind: "check-run" });
        await this.patchCheck(reconciled, outcome);
        return;
      }

      const response = await this.requestWithRateLimitRetry(
        "POST",
        `https://api.github.com/repos/${this.owner}/${this.repo}/check-runs`,
        {
          name,
          head_sha: headSha,
          external_id: externalId,
          status: "completed",
          conclusion: outcome.conclusion,
          output: { title: outcome.title, summary: outcome.summary },
        },
      );
      const id = (response.body as { id?: number }).id;
      if (typeof id !== "number") {
        const recovered = await this.reconcileExistingCheck(name, headSha, externalId);
        if (recovered === undefined) {
          throw new Error("GitHub check-run response missing id");
        }
        await this.sideEffects.put(key, { resourceId: recovered, kind: "check-run" });
        await this.patchCheck(recovered, outcome);
        return;
      }
      await this.sideEffects.put(key, { resourceId: id, kind: "check-run" });
    });
  }

  private async reconcileExistingCheck(
    name: MasweCheckName,
    headSha: string,
    externalId: string,
  ): Promise<number | undefined> {
    const endpointPath = `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(headSha)}/check-runs`;
    const initialUrl = new URL(`https://api.github.com${endpointPath}`);
    initialUrl.searchParams.set("check_name", name);
    initialUrl.searchParams.set("filter", "all");
    initialUrl.searchParams.set("per_page", "100");

    let pageUrl = initialUrl.toString();
    const visited = new Set<string>();
    for (let page = 0; page < CHECK_RECONCILIATION_PAGE_LIMIT; page += 1) {
      if (visited.has(pageUrl)) {
        throw new Error("GitHub check-run pagination Link loop detected");
      }
      visited.add(pageUrl);
      const response = await this.requestWithRateLimitRetry("GET", pageUrl);
      const checkRuns = (
        response.body as { check_runs?: Array<{ id?: number; external_id?: string }> }
      ).check_runs;
      if (!Array.isArray(checkRuns)) {
        throw new Error("GitHub check-run list response check_runs is malformed");
      }
      const match = checkRuns.find(
        (run) => run.external_id === externalId && typeof run.id === "number",
      );
      if (match) return match.id;

      let nextLink: string | undefined;
      try {
        nextLink = nextGitHubLink(response.headers);
      } catch (error) {
        remapCheckPaginationError(error);
      }
      if (nextLink === undefined) return undefined;
      let nextUrl: string;
      try {
        nextUrl = requireSafeGitHubPageUrl(nextLink, {
          origin: "https://api.github.com",
          pathname: endpointPath,
          requiredQuery: {
            check_name: name,
            filter: "all",
            per_page: "100",
          },
          optionalPositiveIntegerQuery: ["page"],
          allowedQueryKeys: ["check_name", "filter", "per_page", "page"],
        });
      } catch (error) {
        remapCheckPaginationError(error);
      }
      if (visited.has(nextUrl)) {
        throw new Error("GitHub check-run pagination Link loop detected");
      }
      if (page + 1 >= CHECK_RECONCILIATION_PAGE_LIMIT) {
        throw new Error("GitHub check-run pagination page limit exceeded");
      }
      pageUrl = nextUrl;
    }
    throw new Error("GitHub check-run pagination page limit exceeded");
  }

  private async patchCheck(checkRunId: number, outcome: CheckOutcome): Promise<void> {
    await this.requestWithRateLimitRetry(
      "PATCH",
      `https://api.github.com/repos/${this.owner}/${this.repo}/check-runs/${checkRunId}`,
      {
        status: "completed",
        conclusion: outcome.conclusion,
        output: { title: outcome.title, summary: outcome.summary },
      },
    );
  }

  private async requestWithRateLimitRetry(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    let lastHeaders: Record<string, string> = {};
    let lastBody: unknown;
    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt += 1) {
      const response = await this.http.request(method, url, {
        headers: this.headers(),
        ...(body !== undefined ? { body } : {}),
      });
      if (!isRateLimited(response.status, response.headers, response.body)) {
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`GitHub Checks API request failed: HTTP ${response.status}`);
        }
        return response;
      }
      lastHeaders = response.headers;
      lastBody = response.body;
      if (attempt === this.maxRateLimitRetries) break;
      await this.sleepFn(rateLimitDelayMs(response.headers, attempt));
    }
    void lastBody;
    void lastHeaders;
    throw new Error("GitHub API rate limit exceeded");
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "maswe-github-app",
      "content-type": "application/json",
    };
  }
}
