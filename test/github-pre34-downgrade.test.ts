import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import {
  pre34AcceptsAssociationIndex,
  pre34AcceptsGitHubConfig,
  pre34GitHubConfigRejection,
} from "./fixtures/github-pre34-validators.ts";

const REPOSITORY_ID = 1308655205;

/** The only pre-#34 rule that can reject stable identity itself, rather than an empty name list. */
const UNKNOWN_STABLE_FIELD = "Unsupported config field: githubApp.allowedRepositoryIds";

function migratedGitHubConfig(allowlists: Record<string, unknown>): Record<string, unknown> {
  const config = mergeConfigForTest({
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      ...allowlists,
    },
  });
  assert.ok(config.githubApp, "migrated golden config must carry githubApp");
  return config.githubApp as unknown as Record<string, unknown>;
}

test("frozen pre-#34 validators still accept pre-#34 golden state", () => {
  assert.equal(
    pre34GitHubConfigRejection({
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: "MASWE_GITHUB_WEBHOOK_SECRET",
      appIdEnv: "MASWE_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
    }),
    undefined,
  );
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

test("pre-#34 binary rejects migrated stable-id-only config", () => {
  const githubApp = migratedGitHubConfig({ allowedRepositoryIds: [REPOSITORY_ID] });

  assert.deepEqual(githubApp.allowedRepositoryIds, [REPOSITORY_ID]);
  assert.deepEqual(githubApp.allowedRepositories, []);
  assert.equal(pre34AcceptsGitHubConfig(githubApp), false);
  // Pin the mechanism: the stable field itself, not the incidentally empty name allowlist.
  assert.equal(pre34GitHubConfigRejection(githubApp), UNKNOWN_STABLE_FIELD);
});

test("pre-#34 binary rejects migrated config that still retains display names", () => {
  // Tasks 10/11 keep owner/repo for routing/display, so the realistic post-migration shape carries
  // BOTH allowlists non-empty. The pre-#34 `enabled && allowedRepositories.length < 1` rule cannot
  // reject this shape, so only the unknown-field path can. This is the case that stays honest if
  // someone ever "syncs" PRE34_GITHUB_APP_FIELDS with the #34 field list.
  const githubApp = migratedGitHubConfig({
    allowedRepositoryIds: [REPOSITORY_ID],
    allowedRepositories: ["owner/repo"],
  });

  assert.deepEqual(githubApp.allowedRepositoryIds, [REPOSITORY_ID]);
  assert.deepEqual(githubApp.allowedRepositories, ["owner/repo"]);
  assert.equal(pre34AcceptsGitHubConfig(githubApp), false);
  assert.equal(pre34GitHubConfigRejection(githubApp), UNKNOWN_STABLE_FIELD);
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
