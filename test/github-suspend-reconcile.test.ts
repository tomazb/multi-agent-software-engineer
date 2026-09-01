import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { FileRunStore } from "../src/store.ts";
import type { RunStore } from "../src/store.ts";
import type { RunRecord } from "../src/domain.ts";

const SECRET = "suspend-reconcile-secret";
const SECRET_ENV = "MASWE_TEST_GITHUB_WEBHOOK_SECRET_SUSPEND";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

test("redelivery after run-save failure still suspends the authoritative run", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-rec-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/one"],
    },
  });
  const run = await store.create("s1", "req", config);
  run.github = {
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(run);

  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });

  // Simulate crash after index suspend but before run save: index already suspended, run still active.
  await index.suspendRepository(44, "owner/one");
  assert.equal((await index.find("owner/one", 1))?.suspended, true);
  assert.equal((await store.load(run.id)).github?.suspended, false);

  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store,
    http: {
      async request() {
        return { status: 200, headers: {}, body: {} };
      },
    },
    tokenProvider: async () => "token",
    synchronousWebhookDispatch: true,
  });

  const body = JSON.stringify({
    action: "removed",
    installation: { id: 44 },
    repositories_removed: [{ id: 1, full_name: "owner/one" }],
  });
  const result = await adapter.handleWebhook({
    deliveryId: "del-suspend-retry",
    eventName: "installation_repositories",
    signatureHeader: sign(body),
    rawBody: body,
  });
  assert.equal(result.status, 200);
  assert.equal((await store.load(run.id)).github?.suspended, true);
});

for (const eventKind of ["installation", "repository-removal"] as const) {
  test(`${eventKind} suspension processes later associations before aggregating a persistent first save failure`, async (t) => {
    process.env[SECRET_ENV] = SECRET;
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-all-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const config = mergeConfigForTest({
      runtime: { kind: "mock" },
      quality: { commands: [] },
      githubApp: {
        enabled: true,
        readOnlyChecks: true,
        webhookSecretEnv: SECRET_ENV,
        appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
        privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
        allowedRepositories: ["owner/one", "owner/two"],
      },
    });
    const runs: RunRecord[] = [];
    const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
    for (const [offset, repository] of ["owner/one", "owner/two"].entries()) {
      const run = await store.create(`s${offset + 1}`, "req", config);
      run.github = {
        installationId: 44,
        repository,
        pullRequestNumber: offset + 1,
        baseSha: "b",
        headSha: "h",
        branch: "a",
        suspended: false,
      };
      await store.save(run);
      await index.bind({
        runId: run.id,
        installationId: 44,
        repository,
        pullRequestNumber: offset + 1,
        baseSha: "b",
        headSha: "h",
        branch: "a",
      });
      runs.push(run);
    }

    const failingStore: RunStore = {
      create: store.create.bind(store),
      load: store.load.bind(store),
      list: store.list.bind(store),
      applyEvent: store.applyEvent.bind(store),
      writeArtifact: store.writeArtifact.bind(store),
      readArtifact: store.readArtifact.bind(store),
      save: async (run) => {
        if (run.id === runs[0]!.id && run.github?.suspended) {
          throw new Error("persistent first run-save failure");
        }
        await store.save(run);
      },
    };
    const adapter = new GitHubAppAdapter({
      cwd,
      config,
      store: failingStore,
      http: { async request() { return { status: 200, headers: {}, body: {} }; } },
      tokenProvider: async () => "token",
      synchronousWebhookDispatch: true,
    });
    const body = eventKind === "installation"
      ? JSON.stringify({ action: "deleted", installation: { id: 44 } })
      : JSON.stringify({
          action: "removed",
          installation: { id: 44 },
          repositories_removed: [
            { id: 1, full_name: "owner/one" },
            { id: 2, full_name: "owner/two" },
          ],
        });

    await assert.rejects(
      adapter.handleWebhook({
        deliveryId: `del-suspend-all-${eventKind}`,
        eventName: eventKind === "installation" ? "installation" : "installation_repositories",
        signatureHeader: sign(body),
        rawBody: body,
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some((nested) => /persistent first run-save failure/.test(String(nested))),
    );

    const firstIndex = await index.find("owner/one", 1);
    const secondIndex = await index.find("owner/two", 2);
    assert.equal(firstIndex?.suspensionReason, "authorization-revoked");
    assert.equal(secondIndex?.suspensionReason, "authorization-revoked");
    assert.equal((await store.load(runs[0]!.id)).github?.suspended, false);
    assert.equal((await store.load(runs[1]!.id)).github?.suspensionReason, "authorization-revoked");
  });
}

test("authorization suspension only treats ENOENT as a missing run", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-load-error-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/one"],
    },
  });
  const run = await store.create("load failure", "do not swallow corruption", config);
  run.github = {
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
    suspended: false,
  };
  await store.save(run);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: run.id,
    installationId: 44,
    repository: "owner/one",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "a",
  });
  const corruptingStore: RunStore = {
    create: store.create.bind(store),
    save: store.save.bind(store),
    load: async () => {
      throw new Error("run record required field is missing");
    },
    list: store.list.bind(store),
    applyEvent: store.applyEvent.bind(store),
    writeArtifact: store.writeArtifact.bind(store),
    readArtifact: store.readArtifact.bind(store),
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config,
    store: corruptingStore,
    http: { async request() { return { status: 200, headers: {}, body: {} }; } },
    tokenProvider: async () => "token",
    synchronousWebhookDispatch: true,
  });
  const body = JSON.stringify({ action: "deleted", installation: { id: 44 } });

  await assert.rejects(
    adapter.handleWebhook({
      deliveryId: "del-suspend-load-error",
      eventName: "installation",
      signatureHeader: sign(body),
      rawBody: body,
    }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((nested) => /required field is missing/.test(String(nested))),
  );
});
