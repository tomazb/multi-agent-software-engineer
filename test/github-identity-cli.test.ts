import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMasweArgs } from "../src/cli-args.ts";
import { runCli } from "../src/cli-runner.ts";
import { mergeConfigForTest } from "../src/config.ts";
import type { MasweConfig, RunRecord, WorkflowEventType } from "../src/domain.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { CANONICAL_NODE_VERSION } from "../src/node-version.ts";
import { FileRunStore } from "../src/store.ts";

const REPO_ID = 4242;
const LEGACY = "owner/legacy";
const CANONICAL = "owner/renamed";
const INSTALLATION = 44;
const HEAD_SHA = "a".repeat(40);
const APP_ID_ENV = "MASWE_TEST_IDENTITY_CLI_APP_ID";
const PRIVATE_KEY_ENV = "MASWE_TEST_IDENTITY_CLI_PRIVATE_KEY";
const WEBHOOK_SECRET_ENV = "MASWE_TEST_IDENTITY_CLI_WEBHOOK_SECRET";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// --- Step 1: parser grammar ---

test("github-migrate-repository parses exactly one --from and one --repository-id", () => {
  const parsed = parseMasweArgs([
    "github-migrate-repository",
    "--from",
    "Owner/Legacy",
    "--repository-id",
    "4242",
    "--json",
  ]);
  assert.deepEqual(parsed.positionals, ["github-migrate-repository"]);
  assert.equal(parsed.options.from, "Owner/Legacy");
  assert.equal(parsed.options["repository-id"], "4242");
  assert.equal(parsed.options.json, true);
});

test("github-migrate-repository accepts the global --cwd and --config options", () => {
  const parsed = parseMasweArgs([
    "github-migrate-repository",
    "--from",
    "owner/legacy",
    "--repository-id",
    "4242",
    "--cwd",
    "/tmp/project",
    "--config",
    "custom.json",
  ]);
  assert.equal(parsed.options.cwd, "/tmp/project");
  assert.equal(parsed.options.config, "custom.json");
});

test("github-migrate-repository rejects malformed invocations", () => {
  const cases: Array<[string, string[], RegExp]> = [
    [
      "missing --from",
      ["github-migrate-repository", "--repository-id", "4242"],
      /requires --from <owner\/repo> and --repository-id <positive safe integer>/,
    ],
    [
      "missing --repository-id",
      ["github-migrate-repository", "--from", "owner/legacy"],
      /requires --from <owner\/repo> and --repository-id <positive safe integer>/,
    ],
    [
      "duplicate --from",
      [
        "github-migrate-repository",
        "--from",
        "owner/legacy",
        "--from",
        "owner/other",
        "--repository-id",
        "4242",
      ],
      /Option --from may not appear more than once/,
    ],
    [
      "duplicate --repository-id",
      [
        "github-migrate-repository",
        "--from",
        "owner/legacy",
        "--repository-id",
        "4242",
        "--repository-id",
        "9",
      ],
      /Option --repository-id may not appear more than once/,
    ],
    [
      "empty --from",
      ["github-migrate-repository", "--from=", "--repository-id", "4242"],
      /Option --from requires a non-empty value/,
    ],
    [
      "extra positional",
      ["github-migrate-repository", "run-1", "--from", "owner/legacy", "--repository-id", "4242"],
      /accepts exactly 0 operand/,
    ],
    [
      "--from on another command",
      ["github-webhook", "--from", "owner/legacy"],
      /Option --from is not valid for github-webhook/,
    ],
    [
      "--repository-id on another command",
      ["github-publish-checks", "run-1", "--repository-id", "4242"],
      /Option --repository-id is not valid for github-publish-checks/,
    ],
  ];
  for (const [label, argv, pattern] of cases) {
    assert.throws(() => parseMasweArgs(argv), pattern, label);
  }
});

test("github-migrate-repository rejects malformed legacy selectors and repository ids", async (t) => {
  const badSelectors = [
    "missing-slash",
    "owner/repo/extra",
    "owner /repo",
    "/repo",
    "owner/",
  ];
  for (const selector of badSelectors) {
    await assert.rejects(
      runCli({
        argv: [
          "github-migrate-repository",
          `--from=${selector}`,
          "--repository-id",
          "4242",
          "--cwd",
          os.tmpdir(),
        ],
        observedNodeVersion: CANONICAL_NODE_VERSION,
      }),
      /owner\/repo form/i,
      `selector ${selector} must be rejected`,
    );
  }

  const badIds = ["0", "-1", "1.5", "4242.0", "4e3", "0x10", " 42", "42 ", "", "9007199254740992"];
  for (const repositoryId of badIds) {
    await assert.rejects(
      runCli({
        argv: [
          "github-migrate-repository",
          "--from",
          LEGACY,
          `--repository-id=${repositoryId}`,
          "--cwd",
          os.tmpdir(),
        ],
        observedNodeVersion: CANONICAL_NODE_VERSION,
      }),
      /--repository-id (must be a positive safe integer|requires a non-empty value)/i,
      `repository id ${JSON.stringify(repositoryId)} must be rejected`,
    );
  }
  void t;
});

// --- Step 2/3: command and listener cutover behavior ---

function testConfig(options: { repositoryIds?: number[] } = {}): MasweConfig {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: WEBHOOK_SECRET_ENV,
      appIdEnv: APP_ID_ENV,
      privateKeyEnv: PRIVATE_KEY_ENV,
      allowedRepositoryIds: options.repositoryIds ?? [REPO_ID],
      allowedRepositories: [LEGACY, CANONICAL],
    },
  });
}

async function setupProject(
  t: { after(fn: () => Promise<void> | void): void },
  options: { repositoryIds?: number[] } = {},
): Promise<{ cwd: string; config: MasweConfig; store: FileRunStore; githubRoot: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-identity-cli-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const config = testConfig(options);
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return { cwd, config, store: new FileRunStore(cwd), githubRoot: path.join(cwd, ".maswe", "github") };
}

/** Seeds a PR_READY run plus its unresolved legacy `<repository>#<pr>` index record. */
async function seedLegacyRun(
  store: FileRunStore,
  githubRoot: string,
  config: MasweConfig,
  pullRequestNumber = 7,
): Promise<RunRecord> {
  let run = await store.create("identity cli", "request", config);
  const transitions: Array<[WorkflowEventType, string]> = [
    ["START", "user"],
    ["BRAINSTORM_COMPLETED", "brainstormer"],
    ["APPROVE_BRAINSTORM", "user"],
    ["DESIGN_COMPLETED", "designer"],
    ["APPROVE_DESIGN", "user"],
    ["BUILD_COMPLETED", "builder"],
    ["CI_PASSED", "quality"],
    ["VERIFY_PASSED", "verifier"],
    ["PR_OPENED", "github-app"],
  ];
  for (const [type, actor] of transitions) {
    run = await store.applyEvent(run, type, actor);
  }
  run.workspace = {
    remote: `https://github.com/${LEGACY}.git`,
    baseSha: "base-sha",
    headSha: HEAD_SHA,
    branch: "maswe/topic",
    fingerprint: "fingerprint",
  };
  run.github = {
    installationId: INSTALLATION,
    repository: LEGACY,
    pullRequestNumber,
    baseSha: "base-sha",
    headSha: HEAD_SHA,
    branch: "maswe/topic",
    suspended: false,
  };
  run.evidence = {
    quality: { headSha: HEAD_SHA, passed: true, at: "2026-08-18T10:00:00.000Z" },
    verification: { headSha: HEAD_SHA, passed: true, at: "2026-08-18T10:01:00.000Z" },
  };
  await store.save(run);
  await mkdir(githubRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(githubRoot, "associations.json"),
    `${JSON.stringify(
      {
        [`${LEGACY}#${pullRequestNumber}`]: {
          runId: run.id,
          installationId: INSTALLATION,
          repository: LEGACY,
          pullRequestNumber,
          baseSha: "base-sha",
          headSha: HEAD_SHA,
          branch: "maswe/topic",
          suspended: false,
          updatedAt: "2026-08-18T10:02:00.000Z",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return store.load(run.id);
}

interface FakeGitHub {
  fetchFn: typeof fetch;
  tokenBodies: unknown[];
  routes: string[];
}

function fakeGitHub(pullRequestNumber = 7): FakeGitHub {
  const tokenBodies: unknown[] = [];
  const routes: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    routes.push(`${method} ${url}`);
    const parsed = new URL(url);
    if (
      method === "POST" &&
      parsed.pathname === `/app/installations/${INSTALLATION}/access_tokens`
    ) {
      tokenBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ token: "ghs_migration" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (parsed.pathname === "/installation/repositories") {
      return new Response(
        JSON.stringify({ repositories: [{ id: REPO_ID, full_name: CANONICAL }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(parsed.pathname)) {
      return new Response(JSON.stringify({ check_runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (parsed.pathname === `/repos/${CANONICAL}/pulls/${pullRequestNumber}`) {
      return new Response(
        JSON.stringify({
          state: "open",
          head: { sha: HEAD_SHA, ref: "maswe/topic" },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: { id: REPO_ID, full_name: CANONICAL },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected GitHub request: ${method} ${url}`);
  };
  return { fetchFn, tokenBodies, routes };
}

function captureStdout(t: { after(fn: () => void): void }): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  t.after(() => { console.log = original; });
  return lines;
}

function withCredentials(t: { after(fn: () => void): void }): void {
  const previousAppId = process.env[APP_ID_ENV];
  const previousKey = process.env[PRIVATE_KEY_ENV];
  const previousSecret = process.env[WEBHOOK_SECRET_ENV];
  process.env[APP_ID_ENV] = "12345";
  process.env[PRIVATE_KEY_ENV] = PRIVATE_KEY_PEM;
  process.env[WEBHOOK_SECRET_ENV] = "identity-cli-secret";
  t.after(() => {
    if (previousAppId === undefined) delete process.env[APP_ID_ENV];
    else process.env[APP_ID_ENV] = previousAppId;
    if (previousKey === undefined) delete process.env[PRIVATE_KEY_ENV];
    else process.env[PRIVATE_KEY_ENV] = previousKey;
    if (previousSecret === undefined) delete process.env[WEBHOOK_SECRET_ENV];
    else process.env[WEBHOOK_SECRET_ENV] = previousSecret;
  });
}

test("github-migrate-repository migrates a legacy association and never starts a listener", async (t) => {
  withCredentials(t);
  const project = await setupProject(t);
  const run = await seedLegacyRun(project.store, project.githubRoot, project.config);
  const github = fakeGitHub();
  const lines = captureStdout(t);

  await runCli({
    argv: [
      "github-migrate-repository",
      "--from",
      "Owner/Legacy",
      "--repository-id",
      String(REPO_ID),
      "--json",
      "--cwd",
      project.cwd,
    ],
    observedNodeVersion: CANONICAL_NODE_VERSION,
    githubHttpOptions: { fetchFn: github.fetchFn },
    webhookListener: async () => {
      throw new Error("migration must never start a webhook listener");
    },
  });

  const result = JSON.parse(lines.join("\n")) as {
    repositoryId: number;
    legacyRepository: string;
    canonicalRepository: string;
    status: string;
    installationIds: number[];
    candidates: Array<{ runId: string; migratedFromLegacy: boolean }>;
  };
  assert.equal(result.repositoryId, REPO_ID);
  // `--from` is normalized to lowercase before it selects anything.
  assert.equal(result.legacyRepository, LEGACY);
  assert.equal(result.canonicalRepository, CANONICAL);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.installationIds, [INSTALLATION]);
  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.runId, candidate.migratedFromLegacy]),
    [[run.id, true]],
  );

  const index = new GitHubAssociationIndex(project.githubRoot);
  assert.equal((await index.findStable(REPO_ID, 7))?.runId, run.id);
  assert.equal(await index.findLegacy(LEGACY, 7), undefined);
  const raw = JSON.parse(
    await readFile(path.join(project.githubRoot, "associations.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw), [`${REPO_ID}#7`]);

  // Every credential minted for the migration is repository-ID-scoped.
  assert.ok(github.tokenBodies.length > 0);
  for (const body of github.tokenBodies) {
    assert.deepEqual((body as { repository_ids: number[] }).repository_ids, [REPO_ID]);
    assert.equal(Object.hasOwn(body as object, "repositories"), false);
  }
});

test("github-migrate-repository prints a deterministic text summary without --json", async (t) => {
  withCredentials(t);
  const project = await setupProject(t);
  const run = await seedLegacyRun(project.store, project.githubRoot, project.config);
  const github = fakeGitHub();
  const lines = captureStdout(t);

  await runCli({
    argv: [
      "github-migrate-repository",
      "--from",
      LEGACY,
      "--repository-id",
      String(REPO_ID),
      "--cwd",
      project.cwd,
    ],
    observedNodeVersion: CANONICAL_NODE_VERSION,
    githubHttpOptions: { fetchFn: github.fetchFn },
  });

  assert.deepEqual(lines, [
    `Migrated GitHub repository identity ${LEGACY} -> ${REPO_ID} (${CANONICAL})`,
    "status=complete passes=2 installations=44 candidates=1",
    `  pr=7 run=${run.id} migratedFromLegacy=true canonicalRefreshed=true headChanged=false `
      + "revalidationRouted=false suspended=false aliasedHeadShas=1",
  ]);
});

test("github-migrate-repository refuses a repository id that is not live-allowlisted", async (t) => {
  withCredentials(t);
  const project = await setupProject(t, { repositoryIds: [909] });
  await seedLegacyRun(project.store, project.githubRoot, project.config);
  const github = fakeGitHub();

  await assert.rejects(
    runCli({
      argv: [
        "github-migrate-repository",
        "--from",
        LEGACY,
        "--repository-id",
        String(REPO_ID),
        "--cwd",
        project.cwd,
      ],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: { fetchFn: github.fetchFn },
    }),
    /not allowlisted/i,
  );
  assert.deepEqual(github.routes, [], "an unauthorized id must never reach GitHub");
});

test("github-migrate-repository requires GitHub App credentials before any GitHub work", async (t) => {
  const project = await setupProject(t);
  await seedLegacyRun(project.store, project.githubRoot, project.config);
  const previousAppId = process.env[APP_ID_ENV];
  const previousKey = process.env[PRIVATE_KEY_ENV];
  delete process.env[APP_ID_ENV];
  delete process.env[PRIVATE_KEY_ENV];
  t.after(() => {
    if (previousAppId === undefined) delete process.env[APP_ID_ENV];
    else process.env[APP_ID_ENV] = previousAppId;
    if (previousKey === undefined) delete process.env[PRIVATE_KEY_ENV];
    else process.env[PRIVATE_KEY_ENV] = previousKey;
  });
  const github = fakeGitHub();

  await assert.rejects(
    runCli({
      argv: [
        "github-migrate-repository",
        "--from",
        LEGACY,
        "--repository-id",
        String(REPO_ID),
        "--cwd",
        project.cwd,
      ],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: { fetchFn: github.fetchFn },
    }),
    /GitHub App id or private key environment variables are missing/,
  );
  assert.deepEqual(github.routes, []);
});

test("github-migrate-repository refuses to run while githubApp is disabled", async (t) => {
  withCredentials(t);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-identity-cli-disabled-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: false,
      readOnlyChecks: true,
      webhookSecretEnv: WEBHOOK_SECRET_ENV,
      appIdEnv: APP_ID_ENV,
      privateKeyEnv: PRIVATE_KEY_ENV,
      allowedRepositoryIds: [REPO_ID],
      allowedRepositories: [LEGACY],
    },
  });
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(
    runCli({
      argv: [
        "github-migrate-repository",
        "--from",
        LEGACY,
        "--repository-id",
        String(REPO_ID),
        "--cwd",
        cwd,
      ],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: {
        fetchFn: async () => { throw new Error("disabled migration must not reach GitHub"); },
      },
    }),
    /githubApp\.enabled must be true to migrate repository identity/,
  );
});

test("github-webhook refuses to reach listener readiness with an empty stable allowlist", async (t) => {
  withCredentials(t);
  const project = await setupProject(t, { repositoryIds: [] });
  let listenerStarted = 0;

  await assert.rejects(
    runCli({
      argv: ["github-webhook", "--cwd", project.cwd],
      observedNodeVersion: CANONICAL_NODE_VERSION,
      githubHttpOptions: {
        fetchFn: async () => { throw new Error("gated listener must not reach GitHub"); },
      },
      webhookListener: async () => {
        listenerStarted += 1;
        return { url: "http://127.0.0.1:0" };
      },
    }),
    /githubApp\.allowedRepositoryIds must contain at least one repository id/,
  );
  assert.equal(listenerStarted, 0);
  // The gate runs before any durable GitHub listener state is created.
  await assert.rejects(stat(project.githubRoot), { code: "ENOENT" });
});

test("github-webhook reaches listener readiness once stable ids are configured", async (t) => {
  withCredentials(t);
  const project = await setupProject(t);
  let listenerStarted = 0;

  await runCli({
    argv: ["github-webhook", "--cwd", project.cwd],
    observedNodeVersion: CANONICAL_NODE_VERSION,
    githubHttpOptions: {
      fetchFn: async () => { throw new Error("listener startup must not call GitHub"); },
    },
    webhookListener: async ({ adapter }) => {
      listenerStarted += 1;
      await adapter.stopWebhookWorker();
      return { url: "http://127.0.0.1:0/github/webhook" };
    },
  });
  assert.equal(listenerStarted, 1);
});
