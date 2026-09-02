import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli-runner.ts";
import { mergeConfigForTest } from "../src/config.ts";
import type { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubPermanentRepositoryDropDiagnostic } from "../src/github/dispatch-disposition.ts";
import { WebhookIngressDeadlineError } from "../src/github/webhook-server.ts";
import { CANONICAL_NODE_VERSION } from "../src/node-version.ts";
import { FileRunStore } from "../src/store.ts";

const WEBHOOK_SECRET_ENV = "MASWE_TEST_CLI_HTTP_WEBHOOK_SECRET";
const APP_ID_ENV = "MASWE_TEST_CLI_HTTP_APP_ID";
const PRIVATE_KEY_ENV = "MASWE_TEST_CLI_HTTP_PRIVATE_KEY";
const WEBHOOK_SECRET = "cli-http-secret";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function testConfig() {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: WEBHOOK_SECRET_ENV,
      appIdEnv: APP_ID_ENV,
      privateKeyEnv: PRIVATE_KEY_ENV,
      allowedRepositories: ["owner/repo"],
    },
  });
}

async function setupProject() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-cli-http-"));
  const config = testConfig();
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return { cwd, config, store: new FileRunStore(cwd) };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex")}`;
}

function pullRequestBody(headSha: string): string {
  return JSON.stringify({
    action: "synchronize",
    installation: { id: 44 },
    repository: { id: 1308655205, full_name: "owner/repo" },
    pull_request: {
      number: 9,
      head: { sha: headSha, ref: "feature" },
      base: { sha: "base-sha" },
    },
  });
}

function recordingFetch(liveHead = "sha-new") {
  const calls: Array<{ method: string; url: string; signal: AbortSignal }> = [];
  let nextCheckId = 100;
  let currentLiveHead = liveHead;
  const fetchFn: typeof fetch = async (input, init) => {
    if (!(init?.signal instanceof AbortSignal)) {
      throw new Error("GitHub CLI fetch was called without an AbortSignal");
    }
    const method = init.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, signal: init.signal });
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_cli_test" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url.includes("/pulls/9")) {
      return new Response(JSON.stringify({ head: { sha: currentLiveHead }, state: "open" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url.includes("/check-runs")) {
      return new Response(JSON.stringify({ check_runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && url.includes("/check-runs")) {
      return new Response(JSON.stringify({ id: nextCheckId++ }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "PATCH" && url.includes("/check-runs/")) {
      return new Response(JSON.stringify({ id: nextCheckId++ }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${url}`);
  };
  return {
    calls,
    fetchFn,
    setLiveHead(headSha: string) {
      currentLiveHead = headSha;
    },
  };
}

function installGitHubEnvironment(): () => void {
  const previous = {
    webhookSecret: process.env[WEBHOOK_SECRET_ENV],
    appId: process.env[APP_ID_ENV],
    privateKey: process.env[PRIVATE_KEY_ENV],
  };
  process.env[WEBHOOK_SECRET_ENV] = WEBHOOK_SECRET;
  process.env[APP_ID_ENV] = "123";
  process.env[PRIVATE_KEY_ENV] = PRIVATE_KEY;
  return () => {
    if (previous.webhookSecret === undefined) delete process.env[WEBHOOK_SECRET_ENV];
    else process.env[WEBHOOK_SECRET_ENV] = previous.webhookSecret;
    if (previous.appId === undefined) delete process.env[APP_ID_ENV];
    else process.env[APP_ID_ENV] = previous.appId;
    if (previous.privateKey === undefined) delete process.env[PRIVATE_KEY_ENV];
    else process.env[PRIVATE_KEY_ENV] = previous.privateKey;
  };
}

test("github-webhook shares one bounded client across token, live-head, and check requests", async () => {
  const { cwd, config, store } = await setupProject();
  const restoreEnvironment = installGitHubEnvironment();
  const { calls, fetchFn, setLiveHead } = recordingFetch("sha-old");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = fetchFn;
  console.log = () => undefined;
  try {
    const run = await store.create("associated", "request", config);
    run.workspace = {
      baseSha: "base-sha",
      headSha: "sha-old",
      branch: "feature",
      fingerprint: "fingerprint",
      remote: "https://github.com/owner/repo.git",
    };
    await store.save(run);

    const webhookListener = async (options: { adapter: GitHubAppAdapter }) => {
      for (const [deliveryId, headSha] of [
        ["cli-http-old", "sha-old"],
        ["cli-http-new", "sha-new"],
      ] as const) {
        setLiveHead(headSha);
        const rawBody = pullRequestBody(headSha);
        const result = await options.adapter.handleWebhook({
          deliveryId,
          eventName: "pull_request",
          signatureHeader: sign(rawBody),
          rawBody,
        });
        assert.equal(result.status, 202);
        await options.adapter.waitForWebhookIdle();
      }
      await options.adapter.stopWebhookWorker();
      return { url: "http://127.0.0.1:0/github/webhook" };
    };

    await runCli({
      argv: ["github-webhook", "--cwd", cwd],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: { timeoutMs: 25, fetchFn },
      webhookListener,
    });

    assert.ok(calls.some((call) => call.url.includes("/access_tokens")));
    assert.ok(calls.some((call) => call.method === "GET" && call.url.includes("/pulls/9")));
    assert.ok(calls.some((call) => call.method === "GET" && call.url.includes("/check-runs")));
    assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/check-runs")));
    assert.ok(calls.some((call) => call.method === "PATCH" && call.url.includes("/check-runs/")));
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    restoreEnvironment();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("github-publish-checks uses the command's shared bounded client", async () => {
  const { cwd, config, store } = await setupProject();
  const restoreEnvironment = installGitHubEnvironment();
  const { calls, fetchFn } = recordingFetch();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = fetchFn;
  console.log = () => undefined;
  try {
    const run = await store.create("manual", "request", config);
    run.github = {
      installationId: 44,
      repository: "owner/repo",
      pullRequestNumber: 9,
      baseSha: "base-sha",
      headSha: "manual-sha",
      branch: "feature",
      suspended: false,
    };
    await store.save(run);

    await runCli({
      argv: ["github-publish-checks", run.id, "--cwd", cwd],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: { timeoutMs: 25, fetchFn },
    });

    assert.ok(calls.some((call) => call.url.includes("/access_tokens")));
    assert.ok(calls.some((call) => call.method === "GET" && call.url.includes("/check-runs")));
    assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/check-runs")));
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    restoreEnvironment();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("github-webhook preflight failure prevents the listener and GitHub API work", async (t) => {
  const { cwd } = await setupProject();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const restoreEnvironment = installGitHubEnvironment();
  t.after(restoreEnvironment);
  const githubRoot = path.join(cwd, ".maswe", "github");
  await mkdir(githubRoot, { recursive: true });
  await writeFile(
    path.join(githubRoot, "associations.lock"),
    `${JSON.stringify({
      pid: process.pid,
      token: "live-preflight-owner",
      at: "2026-08-10T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  let listenerCalled = false;
  let apiCalls = 0;

  await assert.rejects(
    runCli({
      argv: ["github-webhook", "--cwd", cwd],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: {
        fetchFn: async () => {
          apiCalls += 1;
          return new Response(null, { status: 500 });
        },
      },
      webhookListener: async () => {
        listenerCalled = true;
        return { url: "http://127.0.0.1:0/github/webhook" };
      },
    }),
    /journal migration is blocked/i,
  );

  assert.equal(listenerCalled, false);
  assert.equal(apiCalls, 0);
});

test("github-webhook preflights every retained per-check legacy journal before readiness", async (t) => {
  const { cwd } = await setupProject();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const restoreEnvironment = installGitHubEnvironment();
  t.after(restoreEnvironment);
  const githubRoot = path.join(cwd, ".maswe", "github");
  const digest = createHash("sha256").update("retained-check-key").digest("hex");
  const legacyLock = path.join(
    githubRoot,
    "side-effect-create-locks",
    `${digest}.json.lock`,
  );
  await mkdir(legacyLock, { recursive: true });
  await writeFile(
    path.join(legacyLock, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      token: "live-check-preflight-owner",
      at: "2026-08-10T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  let listenerCalled = false;
  let apiCalls = 0;

  await assert.rejects(
    runCli({
      argv: ["github-webhook", "--cwd", cwd],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: {
        fetchFn: async () => {
          apiCalls += 1;
          return new Response(null, { status: 500 });
        },
      },
      webhookListener: async () => {
        listenerCalled = true;
        return { url: "http://127.0.0.1:0/github/webhook" };
      },
    }),
    /check-create journal migration is blocked/i,
  );

  assert.equal(listenerCalled, false);
  assert.equal(apiCalls, 0);
});

test("github-webhook requires every listener credential before readiness", async (t) => {
  for (const [name, environmentName] of [
    ["webhook secret", WEBHOOK_SECRET_ENV],
    ["app id", APP_ID_ENV],
    ["private key", PRIVATE_KEY_ENV],
  ] as const) {
    await t.test(name, async (t) => {
      const { cwd } = await setupProject();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const restoreEnvironment = installGitHubEnvironment();
      t.after(restoreEnvironment);
      delete process.env[environmentName];
      let listenerCalled = false;

      await assert.rejects(
        runCli({
          argv: ["github-webhook", "--cwd", cwd],
          observedNodeVersion: CANONICAL_NODE_VERSION,
          webhookListener: async ({ adapter }) => {
            listenerCalled = true;
            await adapter.stopWebhookWorker();
            return { url: "http://127.0.0.1:0/github/webhook" };
          },
        }),
        /GitHub App listener credentials are missing/,
      );
      assert.equal(listenerCalled, false);
    });
  }
});

test("github-webhook wires a sanitized production diagnostic before listener readiness", async (t) => {
  const { cwd } = await setupProject();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const restoreEnvironment = installGitHubEnvironment();
  t.after(restoreEnvironment);
  const originalError = console.error;
  const originalLog = console.log;
  const diagnostics: string[] = [];
  console.error = (...values: unknown[]) => diagnostics.push(values.map(String).join(" "));
  console.log = () => undefined;
  t.after(() => {
    console.error = originalError;
    console.log = originalLog;
  });
  const credential = `ghp_${"a".repeat(24)}`;

  await runCli({
    argv: ["github-webhook", "--cwd", cwd],
    observedNodeVersion: CANONICAL_NODE_VERSION,
    webhookListener: async (options) => {
      assert.ok(options.onDiagnostic);
      options.onDiagnostic(Object.assign(
        new WebhookIngressDeadlineError(true),
        {
          deliveryId: "safe-delivery-1",
          eventName: "push",
          attempt: 3,
          detail: `Authorization: Bearer ${credential}`,
        },
      ));
      await options.adapter.stopWebhookWorker();
      return { url: "http://127.0.0.1:0/github/webhook" };
    },
  });

  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /GITHUB_WEBHOOK_INGRESS_OUTCOME_UNKNOWN/);
  assert.match(diagnostics[0]!, /safe-delivery-1/);
  assert.match(diagnostics[0]!, /event=push/);
  assert.match(diagnostics[0]!, /attempt=3/);
  assert.match(diagnostics[0]!, /handoffStarted=true/);
  assert.match(diagnostics[0]!, /Authorization: Bearer \[REDACTED\]/);
  assert.doesNotMatch(diagnostics[0]!, new RegExp(credential));
});

test("github-webhook renders only sanitized permanent repository drop fields", async (t) => {
  const { cwd } = await setupProject();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const restoreEnvironment = installGitHubEnvironment();
  t.after(restoreEnvironment);
  const originalError = console.error;
  const originalLog = console.log;
  const diagnostics: string[] = [];
  console.error = (...values: unknown[]) => diagnostics.push(values.map(String).join(" "));
  console.log = () => undefined;
  t.after(() => {
    console.error = originalError;
    console.log = originalLog;
  });
  const operatorSecret = "operator-private-note-42";

  await runCli({
    argv: ["github-webhook", "--cwd", cwd],
    observedNodeVersion: CANONICAL_NODE_VERSION,
    webhookListener: async (options) => {
      assert.ok(options.onDiagnostic);
      options.onDiagnostic(Object.assign(
        new GitHubPermanentRepositoryDropDiagnostic({
          deliveryId: "drop-delivery-1",
          eventName: "pull_request",
          attempt: 2,
          reason: "repository-access-revoked",
          count: 7,
        }),
        {
          // Hostile extras: a renderer that fell through to generic rendering
          // would leak these; the permanent-drop shape must print six fields only.
          detail: operatorSecret,
          cause: new Error(operatorSecret),
        },
      ));
      await options.adapter.stopWebhookWorker();
      return { url: "http://127.0.0.1:0/github/webhook" };
    },
  });

  assert.equal(diagnostics.length, 1);
  assert.equal(
    diagnostics[0],
    "code=GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP reason=repository-access-revoked"
      + " delivery=drop-delivery-1 event=pull_request attempt=2 count=7",
  );
  assert.doesNotMatch(diagnostics[0]!, new RegExp(operatorSecret));
});

test("github-webhook handles SIGTERM and SIGINT with ordered bounded shutdown", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    await t.test(signal, async (t) => {
      const { cwd } = await setupProject();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const restoreEnvironment = installGitHubEnvironment();
      t.after(restoreEnvironment);
      const signals = new EventEmitter();
      const events: string[] = [];
      let capturedAdapter: GitHubAppAdapter | undefined;
      let listenerReady!: () => void;
      const ready = new Promise<void>((resolve) => { listenerReady = resolve; });
      const server = {
        close(callback?: (error?: Error) => void) {
          events.push("close-start");
          setImmediate(() => {
            events.push("close-done");
            callback?.();
          });
          return this;
        },
        closeAllConnections() {
          events.push("close-all");
        },
      } as unknown as Server;

      const cli = runCli({
        argv: ["github-webhook", "--cwd", cwd],
        observedNodeVersion: CANONICAL_NODE_VERSION,
        webhookListener: async ({ adapter }) => {
          capturedAdapter = adapter;
          const stop = adapter.stopWebhookWorker.bind(adapter);
          adapter.stopWebhookWorker = async (options) => {
            events.push(`worker-stop:${options?.drainMs ?? "default"}`);
            await stop(options);
          };
          listenerReady();
          return { url: "http://127.0.0.1:0/github/webhook", server };
        },
        signalSource: signals,
        shutdownIngressMs: 50,
        shutdownDrainMs: 50,
      } as Parameters<typeof runCli>[0] & {
        signalSource: EventEmitter;
        shutdownIngressMs: number;
        shutdownDrainMs: number;
      });
      t.after(async () => capturedAdapter?.stopWebhookWorker({ drainMs: 10 }));
      await ready;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(signals.listenerCount(signal), 1);
      signals.emit(signal);
      await cli;

      assert.deepEqual(events, ["close-start", "close-done", "worker-stop:50"]);
      assert.equal(signals.listenerCount("SIGTERM"), 0);
      assert.equal(signals.listenerCount("SIGINT"), 0);
    });
  }
});

test("github-webhook stops its worker when listener startup fails", async (t) => {
  const { cwd } = await setupProject();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const restoreEnvironment = installGitHubEnvironment();
  t.after(restoreEnvironment);
  let stopCalls = 0;
  let capturedAdapter: GitHubAppAdapter | undefined;

  await assert.rejects(
    runCli({
      argv: ["github-webhook", "--cwd", cwd],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      webhookListener: async ({ adapter }) => {
        capturedAdapter = adapter;
        const stop = adapter.stopWebhookWorker.bind(adapter);
        adapter.stopWebhookWorker = async (...args) => {
          stopCalls += 1;
          await stop(...args);
        };
        throw new Error("synthetic listener startup failure");
      },
    }),
    /synthetic listener startup failure/,
  );

  t.after(async () => capturedAdapter?.stopWebhookWorker());
  assert.equal(stopCalls, 1);
});
