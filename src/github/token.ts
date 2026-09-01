import { createSign, createPrivateKey } from "node:crypto";
import type { GitHubHttpClient } from "./http.ts";

export type GitHubTokenHttp = GitHubHttpClient;

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/** Create a short-lived GitHub App JWT (RS256) from a PEM private key. */
export function createGitHubAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 10 * 60;
  const payload = base64Url(JSON.stringify({ iat, exp, iss: appId }));
  const data = `${header}.${payload}`;
  const key = createPrivateKey(privateKeyPem);
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(key).toString("base64url");
  return `${data}.${signature}`;
}

/**
 * Repository-name-scoped installation token purposes are being replaced by
 * ID-scoped credentials (see `createRepositoryInstallationAccessToken`
 * below). No new code may call `createInstallationAccessToken`; it remains
 * only so existing adapter/CLI consumers keep compiling. Issue #34 Task 11
 * removes it once every call site has migrated to the ID-scoped provider.
 *
 * @deprecated Use `createRepositoryInstallationAccessToken` instead. This
 * function is transitional and will be removed in Task 11.
 */
export async function createInstallationAccessToken(options: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  http: GitHubTokenHttp;
  /** Canonical owner/name repository identity; the API body receives the name component. */
  repository: string;
  /** Phase A least-privilege scope; only an explicit false opts out. */
  readOnlyChecks?: boolean;
  nowMs?: number;
}): Promise<string> {
  if (options.readOnlyChecks === false) {
    throw new Error("GitHub installation tokens require the read-only checks policy");
  }
  const repositoryMatch = options.repository.match(/^[^/\s]+\/([^/\s]+)$/);
  if (!repositoryMatch) {
    throw new Error("GitHub repository must use the owner/name form");
  }
  const jwt = createGitHubAppJwt(options.appId, options.privateKeyPem, options.nowMs);
  const body: Record<string, unknown> = { repositories: [repositoryMatch[1]!] };
  body.permissions = {
    checks: "write",
    pull_requests: "read",
    metadata: "read",
  };
  const response = await options.http.request(
    "POST",
    `https://api.github.com/app/installations/${options.installationId}/access_tokens`,
    {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "maswe-github-app",
        "content-type": "application/json",
      },
      body,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to create installation token: HTTP ${response.status}`);
  }
  const tokenBody = response.body;
  if (tokenBody === null || typeof tokenBody !== "object" || Array.isArray(tokenBody)) {
    throw new Error("Installation token response missing token");
  }
  const token = (tokenBody as { token?: unknown }).token;
  if (typeof token !== "string" || !token) {
    throw new Error("Installation token response missing token");
  }
  return token;
}

/** Explicit least-privilege installation-token purposes; #34 must not broaden or add to this set implicitly. */
export type GitHubInstallationTokenPurpose =
  | "metadata-reconcile"
  | "pull-request-read"
  | "checks";

export type GitHubRepositoryTokenProvider = (
  installationId: number,
  repositoryId: number,
  purpose: GitHubInstallationTokenPurpose,
) => Promise<string>;

/**
 * Exact least-privilege permission set per token purpose (design doc §4).
 * Phase B write authority stays disabled; #34 must not broaden these
 * implicitly and must not add new purposes here.
 */
const REPOSITORY_TOKEN_PERMISSIONS: Record<GitHubInstallationTokenPurpose, Record<string, string>> = {
  "metadata-reconcile": { metadata: "read" },
  "pull-request-read": { metadata: "read", pull_requests: "read" },
  checks: { checks: "write", metadata: "read", pull_requests: "read" },
};

/**
 * Requests a repository-ID-scoped installation access token. All requests
 * use `repository_ids: [repositoryId]`; there is no name fallback anywhere
 * in this credential path.
 */
export async function createRepositoryInstallationAccessToken(options: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  repositoryId: number;
  purpose: GitHubInstallationTokenPurpose;
  http: GitHubHttpClient;
  readOnlyChecks?: boolean;
}): Promise<string> {
  if (options.readOnlyChecks === false) {
    throw new Error("GitHub installation tokens require the read-only checks policy");
  }
  if (!Number.isSafeInteger(options.installationId) || options.installationId <= 0) {
    throw new Error("GitHub installation id must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.repositoryId) || options.repositoryId <= 0) {
    throw new Error("GitHub repository id must be a positive safe integer");
  }
  const permissions = REPOSITORY_TOKEN_PERMISSIONS[options.purpose];
  if (!permissions) {
    throw new Error(`Unknown GitHub installation token purpose: ${String(options.purpose)}`);
  }
  const jwt = createGitHubAppJwt(options.appId, options.privateKeyPem);
  const body: Record<string, unknown> = {
    repository_ids: [options.repositoryId],
    permissions,
  };
  const response = await options.http.request(
    "POST",
    `https://api.github.com/app/installations/${options.installationId}/access_tokens`,
    {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "maswe-github-app",
        "content-type": "application/json",
      },
      body,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to create installation token: HTTP ${response.status}`);
  }
  const tokenBody = response.body;
  if (tokenBody === null || typeof tokenBody !== "object" || Array.isArray(tokenBody)) {
    throw new Error("Installation token response missing token");
  }
  const token = (tokenBody as { token?: unknown }).token;
  if (typeof token !== "string" || !token) {
    throw new Error("Installation token response missing token");
  }
  return token;
}
