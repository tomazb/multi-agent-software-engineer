import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubDeliveryInbox } from "../src/github/delivery-inbox.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET_ENV = "MASWE_TEST_COMPLETE_REJECT_SECRET";
const SECRET = "complete-reject-secret";

test("file and directory sync failures prevent durable acknowledgement", async (t) => {
  process.env[SECRET_ENV] = SECRET;
  const config = mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_APP_ID",
      privateKeyEnv: "MASWE_TEST_PRIVATE_KEY",
      allowedRepositoryIds: [1308655205],
      allowedRepositories: ["owner/repo"],
    },
  });
  const rawBody = JSON.stringify({
    ref: "refs/heads/feature",
    after: "sha",
    installation: { id: 44 },
    repository: { id: 1308655205, full_name: "owner/repo" },
  });

  for (const failure of ["state-file", "state-directory", "queue-file", "queue-directory"] as const) {
    await t.test(failure, async (t) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-enqueue-reject-"));
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const adapter = new GitHubAppAdapter({
        cwd,
        config,
        store: new FileRunStore(cwd),
        http: { async request() { throw new Error("must not dispatch"); } },
        repositoryTokenProvider: async () => "token",
        inboxOptions: {
          syncFile: async (handle, filePath) => {
            const parts = filePath.split(path.sep);
            if (
              (failure === "state-file" && parts.some((part) => part.startsWith(".state."))) ||
              (failure === "queue-file" && filePath.endsWith(".queued"))
            ) {
              throw new Error(`simulated ${failure} sync failure`);
            }
            await handle.sync();
          },
          syncDirectory: async (directoryPath) => {
            const parts = directoryPath.split(path.sep);
            const inboxIndex = parts.lastIndexOf("inbox");
            const inboxChild = inboxIndex >= 0 ? parts[inboxIndex + 1] : undefined;
            if (
              (failure === "state-directory" && inboxChild === "state") ||
              (failure === "queue-directory" && inboxChild === "queue")
            ) {
              throw new Error(`simulated ${failure} sync failure`);
            }
            const handle = await open(directoryPath, "r");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          },
        },
      });

      const result = await adapter.handleWebhook({
        deliveryId: `enqueue-${failure}`,
        eventName: "push",
        signatureHeader: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
        rawBody,
      });
      assert.equal(result.status, 503);
      assert.equal(result.body.message, "durable webhook handoff unavailable");
    });
  }
});

test("durable inbox initialization syncs every layout parent before readiness", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-inbox-layout-sync-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const synced: string[] = [];
  await new GitHubDeliveryInbox(githubRoot, {
    syncDirectory: async (directoryPath) => {
      synced.push(directoryPath);
    },
  }).initialize();

  assert.ok(synced.includes(cwd));
  assert.ok(synced.includes(path.join(cwd, ".maswe")));
  assert.ok(synced.includes(githubRoot));
  assert.ok(synced.includes(path.join(githubRoot, "inbox")));
});
