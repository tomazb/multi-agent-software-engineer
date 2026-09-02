import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubAppConfig, RunGitHubAssociation } from "../src/domain.ts";
import { remoteMatchesRepository } from "../src/github/adapter.ts";
import {
  isRepoAllowed,
  isRepositoryIdAllowed,
  parseOwnerRepo,
  requireStableGitHubAssociation,
} from "../src/github/adapter-identities.ts";

function githubConfig(
  overrides: Pick<GitHubAppConfig, "allowedRepositories" | "allowedRepositoryIds">,
): GitHubAppConfig {
  return {
    enabled: true,
    readOnlyChecks: true,
    webhookSecretEnv: "MASWE_TEST_GITHUB_WEBHOOK_SECRET",
    appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
    privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
    ...overrides,
  };
}

const LEGACY_ASSOCIATION: RunGitHubAssociation = {
  installationId: 44,
  repository: "owner/repo",
  pullRequestNumber: 9,
  baseSha: "base",
  headSha: "head",
  branch: "maswe/run-1",
};

test("parseOwnerRepo requires exactly one canonical owner/name separator", () => {
  assert.deepEqual(parseOwnerRepo("owner/repo"), { owner: "owner", repo: "repo" });
  const invalidRepositories = [
    "owner/repo/extra",
    "owner /repo",
    "owner/repo ",
    "/repo",
    "owner/",
  ];
  for (const repository of invalidRepositories) {
    assert.throws(() => parseOwnerRepo(repository), /Invalid repository/);
  }
});

test("remoteMatchesRepository accepts only GitHub hosts", () => {
  assert.equal(
    remoteMatchesRepository("https://github.com/owner/repo.git", "owner/repo"),
    true,
  );
  assert.equal(
    remoteMatchesRepository("git@github.com:owner/repo.git", "owner/repo"),
    true,
  );
  assert.equal(
    remoteMatchesRepository("ssh://git@github.com/owner/repo.git", "owner/repo"),
    true,
  );
  assert.equal(
    remoteMatchesRepository("http://github.com/owner/repo.git", "owner/repo"),
    false,
  );
  assert.equal(
    remoteMatchesRepository("https://gitlab.com/owner/repo.git", "owner/repo"),
    false,
  );
  assert.equal(
    remoteMatchesRepository("https://github.example.com/owner/repo.git", "owner/repo"),
    false,
  );
});

test("remoteMatchesRepository is exact candidate metadata and never infers a rename", () => {
  // A stale pre-rename remote must not resolve to the new canonical name:
  // MASWE never infers equivalence from GitHub's redirect behavior (design doc §7).
  assert.equal(
    remoteMatchesRepository("https://github.com/owner/old-name.git", "owner/new-name"),
    false,
  );
  assert.equal(
    remoteMatchesRepository("https://github.com/old-owner/repo.git", "new-owner/repo"),
    false,
  );
  // The same remote text only ever matches its own exact name, so it can never
  // stand in for a second repository.
  assert.equal(remoteMatchesRepository("https://github.com/owner/repo", "owner/repo"), true);
  assert.equal(remoteMatchesRepository("https://github.com/owner/repo", "owner/other"), false);
  assert.equal(remoteMatchesRepository(undefined, "owner/repo"), false);
});

test("a matching remote never authorizes a repository id", () => {
  const config = githubConfig({ allowedRepositories: ["owner/repo"], allowedRepositoryIds: [] });
  assert.equal(remoteMatchesRepository("https://github.com/owner/repo.git", "owner/repo"), true);
  assert.equal(isRepoAllowed(config, "owner/repo"), true);
  assert.equal(
    isRepositoryIdAllowed(config, 4242),
    false,
    "an allowlisted name plus a matching remote must not authorize any repository id",
  );
});

test("isRepositoryIdAllowed consults allowedRepositoryIds only", () => {
  const config = githubConfig({
    allowedRepositories: ["owner/repo"],
    allowedRepositoryIds: [4242, 77],
  });
  assert.equal(isRepositoryIdAllowed(config, 4242), true);
  assert.equal(isRepositoryIdAllowed(config, 77), true);
  assert.equal(isRepositoryIdAllowed(config, 4243), false);
  assert.equal(isRepositoryIdAllowed(config, undefined), false);

  const renamed = githubConfig({
    allowedRepositories: ["owner/old-name"],
    allowedRepositoryIds: [4242],
  });
  assert.equal(
    isRepositoryIdAllowed(renamed, 4242),
    true,
    "a renamed repository stays authorized through its stable id",
  );
  assert.equal(
    isRepoAllowed(renamed, "owner/new-name"),
    false,
    "the name allowlist is stale after a rename and authorizes nothing",
  );
});

test("requireStableGitHubAssociation returns an already-stable association unchanged", () => {
  const stable = { ...LEGACY_ASSOCIATION, repositoryId: 4242 };
  const resolved = requireStableGitHubAssociation(stable);
  assert.equal(resolved, stable);
  assert.equal(resolved.repositoryId, 4242);
});

test("requireStableGitHubAssociation rejects unresolved legacy state", () => {
  assert.throws(() => requireStableGitHubAssociation(LEGACY_ASSOCIATION), /migration/i);
  assert.throws(() => requireStableGitHubAssociation(LEGACY_ASSOCIATION), /owner\/repo#9/);
  assert.throws(() => requireStableGitHubAssociation(undefined), /migration/i);
  for (const repositoryId of [0, -1, 1.5]) {
    assert.throws(
      () => requireStableGitHubAssociation({ ...LEGACY_ASSOCIATION, repositoryId }),
      /migration/i,
      `repositoryId ${repositoryId} must not be accepted as stable`,
    );
  }
});
