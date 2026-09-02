import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET = "delivery-semantics-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_DELIVERY_SECRET";
const REPO_ID = 1308655205;

/** Live installation-repository listing proving the allowlisted stable id is present. */
function canonicalListing() {
  return {
    status: 200,
    headers: {},
    body: { repositories: [{ id: REPO_ID, full_name: "owner/repo" }] },
  };
}

/** Full live pull request snapshot proving `base.repo.id`. */
function livePullRequest(headSha = "sha-new") {
  return {
    status: 200,
    headers: {},
    body: {
      state: "open",
      head: { sha: headSha, ref: "feature" },
      base: {
        sha: "sha-base",
        ref: "main",
        repo: { id: REPO_ID, full_name: "owner/repo" },
      },
    },
  };
}

function config() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [REPO_ID],
      allowedRepositories: ["owner/repo"],
    },
  });
}

function signed(deliveryId: string, eventName: string, value: unknown) {
  const rawBody = JSON.stringify(value);
  return {
    deliveryId,
    eventName,
    signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    rawBody,
  };
}

function pullRequest(headSha = "sha-new") {
  return {
    action: "synchronize",
    installation: { id: 44 },
    repository: { id: REPO_ID, full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: headSha, ref: "feature" },
      base: { sha: "sha-base" },
    },
  };
}

async function setup(t: test.TestContext, http?: GitHubHttpClient) {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-delivery-semantics-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: new FileRunStore(cwd),
    http: http ?? {
      async request(method, url) {
        if (method === "GET" && url.includes("/installation/repositories")) {
          return canonicalListing();
        }
        if (method === "GET" && url.includes("/pulls/")) {
          return livePullRequest();
        }
        if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    },
    repositoryTokenProvider: async () => "token",
  });
  return { adapter, cwd };
}

test("supported delivery is acknowledged only after durable enqueue", async (t) => {
  let requests = 0;
  const { adapter } = await setup(t, {
    async request(method, url) {
      requests += 1;
      if (method === "GET" && url.includes("/installation/repositories")) {
        return canonicalListing();
      }
      if (method === "GET" && url.includes("/pulls/")) {
        return livePullRequest();
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      return { status: 201, headers: {}, body: { id: requests } };
    },
  });

  const result = await adapter.handleWebhook(
    signed("supported-enqueue", "pull_request", pullRequest()),
  );
  assert.equal(result.status, 202);
  assert.equal(requests, 0);

  await adapter.startWebhookWorker();
  await adapter.waitForWebhookIdle();
  await adapter.stopWebhookWorker();
  assert.ok(requests > 0);
});

test("queued and completed duplicates use 202 then 200 without redispatch", async (t) => {
  let posts = 0;
  const { adapter } = await setup(t, {
    async request(method, url) {
      if (method === "GET" && url.includes("/installation/repositories")) {
        return canonicalListing();
      }
      if (method === "GET" && url.includes("/pulls/")) {
        return livePullRequest();
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      posts += 1;
      return { status: 201, headers: {}, body: { id: posts } };
    },
  });
  const request = signed("duplicate-contract", "pull_request", pullRequest());

  assert.equal((await adapter.handleWebhook(request)).status, 202);
  const queued = await adapter.handleWebhook(request);
  assert.equal(queued.status, 202);
  assert.equal(queued.body.duplicate, true);
  await adapter.startWebhookWorker();
  await adapter.waitForWebhookIdle();
  await adapter.stopWebhookWorker();
  assert.equal(posts, 4);

  const completed = await adapter.handleWebhook(request);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.duplicate, true);
  assert.equal(posts, 4);
});

test("same delivery id with a different event or digest returns 409", async (t) => {
  const { adapter } = await setup(t);
  assert.equal(
    (await adapter.handleWebhook(signed("conflict", "pull_request", pullRequest()))).status,
    202,
  );
  assert.equal(
    (await adapter.handleWebhook(signed("conflict", "pull_request", pullRequest("other"))))
      .status,
    409,
  );
  assert.equal(
    (await adapter.handleWebhook(signed("conflict", "push", {
      ref: "refs/heads/feature",
      after: "sha-new",
      installation: { id: 44 },
      repository: { id: 1308655205, full_name: "owner/repo" },
    }))).status,
    409,
  );
});

test("unsupported delivery writes a durable terminal tombstone", async (t) => {
  const { adapter } = await setup(t);
  const request = signed("ignored-terminal", "gollum", {});
  const first = await adapter.handleWebhook(request);
  assert.equal(first.status, 200);
  assert.equal(first.body.message, "unsupported webhook ignored");
  const duplicate = await adapter.handleWebhook(request);
  assert.equal(duplicate.status, 200);
  assert.equal(
    (await adapter.handleWebhook(signed("ignored-terminal", "gollum", { changed: true })))
      .status,
    409,
  );
});

test("malformed authenticated input returns 400 without inbox state", async (t) => {
  const { adapter, cwd } = await setup(t);
  const result = await adapter.handleWebhook(
    signed("malformed-no-enqueue", "pull_request", { action: "synchronize" }),
  );
  assert.equal(result.status, 400);
  await assert.rejects(
    access(path.join(cwd, ".maswe", "github", "inbox", "state")),
    { code: "ENOENT" },
  );
});
