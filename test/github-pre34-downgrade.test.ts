import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import {
  pre34AcceptsAssociationIndex,
  pre34AcceptsGitHubConfig,
} from "./fixtures/github-pre34-validators.ts";

const REPOSITORY_ID = 1308655205;

function migratedGitHubConfig(): Record<string, unknown> {
  const config = mergeConfigForTest({
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositoryIds: [REPOSITORY_ID],
    },
  });
  assert.ok(config.githubApp, "migrated golden config must carry githubApp");
  return config.githubApp as unknown as Record<string, unknown>;
}

test("frozen pre-#34 validators still accept pre-#34 golden state", () => {
  assert.equal(
    pre34AcceptsGitHubConfig({
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
    }),
    true,
  );
  assert.equal(
    pre34AcceptsAssociationIndex({
      "owner/repo#7": {
        runId: "run-1",
        installationId: 42,
        repository: "owner/repo",
        pullRequestNumber: 7,
        baseSha: "base",
        headSha: "head",
        branch: "feature",
        suspended: false,
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    }),
    true,
  );
});

test("pre-#34 binary rejects migrated config carrying allowedRepositoryIds", () => {
  const githubApp = migratedGitHubConfig();

  assert.deepEqual(githubApp.allowedRepositoryIds, [REPOSITORY_ID]);
  assert.equal(pre34AcceptsGitHubConfig(githubApp), false);
});

test("pre-#34 binary rejects a name-keyed association record carrying repositoryId", () => {
  assert.equal(
    pre34AcceptsAssociationIndex({
      "owner/repo#7": {
        runId: "run-1",
        installationId: 42,
        repositoryId: REPOSITORY_ID,
        repository: "owner/repo",
        pullRequestNumber: 7,
        baseSha: "base",
        headSha: "head",
        branch: "feature",
        suspended: false,
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    }),
    false,
  );
});

test("pre-#34 binary rejects a stable repository-id keyed association record", () => {
  assert.equal(
    pre34AcceptsAssociationIndex({
      [`${REPOSITORY_ID}#7`]: {
        runId: "run-1",
        installationId: 42,
        repositoryId: REPOSITORY_ID,
        repository: "owner/repo",
        pullRequestNumber: 7,
        baseSha: "base",
        headSha: "head",
        branch: "feature",
        suspended: false,
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    }),
    false,
  );
});
