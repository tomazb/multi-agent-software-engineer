import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { FileRunStore } from "../src/store.ts";

test("association index binds and finds a run by repository and PR", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("assoc", "request", DEFAULT_CONFIG);
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));

  await index.bind({
    runId: run.id,
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 3,
    baseSha: "base",
    headSha: "head",
    branch: "maswe/x",
  });

  const found = await index.find("owner/repo", 3);
  assert.equal(found?.runId, run.id);
  assert.equal(found?.suspended, false);
});

test("association index suspends all entries for an installation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-suspend-"));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-a",
    installationId: 77,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
  });
  await index.bind({
    runId: "run-b",
    installationId: 88,
    repository: "owner/other",
    pullRequestNumber: 2,
    baseSha: "b",
    headSha: "h",
    branch: "feature",
  });

  await index.suspendInstallation(77);
  assert.equal((await index.find("owner/repo", 1))?.suspended, true);
  assert.equal((await index.find("owner/other", 2))?.suspended, false);
});

test("association index finds all non-suspended branch associations in PR order", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-branch-assoc-"));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-five",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 5,
    baseSha: "base",
    headSha: "head-five",
    branch: "maswe/shared",
  });
  await index.bind({
    runId: "run-two",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 2,
    baseSha: "base",
    headSha: "head-two",
    branch: "maswe/shared",
  });
  await index.bind({
    runId: "run-suspended",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 7,
    baseSha: "base",
    headSha: "head-suspended",
    branch: "maswe/shared",
    suspended: true,
  });

  const matches = await index.findAllByRepositoryBranch("owner/repo", "maswe/shared");

  assert.deepEqual(
    matches.map((record) => [record.pullRequestNumber, record.runId]),
    [
      [2, "run-two"],
      [5, "run-five"],
    ],
  );
  const firstMatch = matches[0];
  assert.ok(firstMatch);
  firstMatch.headSha = "mutated-snapshot";
  assert.equal((await index.find("owner/repo", 2))?.headSha, "head-two");
});

test("association index rejects two active PRs owning the same run id", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-unique-run-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  const base = {
    runId: "run-unique",
    installationId: 10,
    repository: "owner/repo",
    baseSha: "base",
    headSha: "head",
    branch: "maswe/shared",
  };
  await index.bind({ ...base, pullRequestNumber: 1 });

  await assert.rejects(
    index.bind({ ...base, pullRequestNumber: 2 }),
    /already associated|duplicate active run/i,
  );
});

test("association index fails closed on malformed or duplicate persisted records", async (t) => {
  for (const corruption of ["extra-field", "duplicate-run"] as const) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), `maswe-gh-assoc-corrupt-${corruption}-`));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const githubRoot = path.join(cwd, ".maswe", "github");
    await mkdir(githubRoot, { recursive: true });
    const record = (pullRequestNumber: number) => ({
      runId: "run-duplicate",
      installationId: 10,
      repository: "owner/repo",
      pullRequestNumber,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/shared",
      suspended: false,
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    const records: Record<string, unknown> = {
      "owner/repo#1": {
        ...record(1),
        ...(corruption === "extra-field" ? { token: "must-not-be-accepted" } : {}),
      },
      ...(corruption === "duplicate-run" ? { "owner/repo#2": record(2) } : {}),
    };
    await writeFile(
      path.join(githubRoot, "associations.json"),
      `${JSON.stringify(records)}\n`,
      "utf8",
    );

    await assert.rejects(
      new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
      /Invalid GitHub association index|duplicate active run/i,
    );
  }
});

function stableRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: "run-stable",
    installationId: 10,
    repositoryId: 555,
    repository: "owner/repo",
    pullRequestNumber: 9,
    baseSha: "base",
    headSha: "head",
    branch: "maswe/stable",
    suspended: false,
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

// --- Step 1: stable-key tests ---

test("bindStable persists a record under the exact <repositoryId>#<pr> key with both stable id and mutable name", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-stable-bind-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const index = new GitHubAssociationIndex(githubRoot);

  const bound = await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-a",
      installationId: 10,
      repositoryId: 4242,
      repository: "owner/repo",
      pullRequestNumber: 3,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/stable",
    }),
  );

  assert.equal(bound.repositoryId, 4242);
  assert.equal(bound.repository, "owner/repo");

  const raw = JSON.parse(
    await readFile(path.join(githubRoot, "associations.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(Object.hasOwn(raw, "4242#3"));
  assert.equal((raw["4242#3"] as { repositoryId: number }).repositoryId, 4242);
  assert.equal((raw["4242#3"] as { repository: string }).repository, "owner/repo");

  const found = await index.findStable(4242, 3);
  assert.equal(found?.runId, "run-a");
  assert.equal(found?.repository, "owner/repo");
});

test("findAllStableByRepositoryId returns records addressed by stable id regardless of current name", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-stable-by-id-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.withTransaction(async (transaction) => {
    transaction.bindStable({
      runId: "run-id-1",
      installationId: 1,
      repositoryId: 900,
      repository: "owner/repo",
      pullRequestNumber: 1,
      baseSha: "b",
      headSha: "h",
      branch: "one",
    });
    transaction.bindStable({
      runId: "run-id-2",
      installationId: 1,
      repositoryId: 900,
      repository: "owner/repo",
      pullRequestNumber: 2,
      baseSha: "b",
      headSha: "h",
      branch: "two",
    });
    transaction.bindStable({
      runId: "run-id-other",
      installationId: 1,
      repositoryId: 901,
      repository: "owner/other",
      pullRequestNumber: 1,
      baseSha: "b",
      headSha: "h",
      branch: "three",
    });
  });

  const matches = await index.findAllStableByRepositoryId(900);
  assert.deepEqual(
    matches.map((record) => record.runId).sort(),
    ["run-id-1", "run-id-2"],
  );
});

test("findAllStableByRepositoryBranch mirrors the name-primary branch lookup but is id-keyed", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-stable-branch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.withTransaction(async (transaction) => {
    transaction.bindStable({
      runId: "run-branch-five",
      installationId: 10,
      repositoryId: 700,
      repository: "owner/repo",
      pullRequestNumber: 5,
      baseSha: "base",
      headSha: "head-five",
      branch: "maswe/shared",
    });
    transaction.bindStable({
      runId: "run-branch-two",
      installationId: 10,
      repositoryId: 700,
      repository: "owner/repo",
      pullRequestNumber: 2,
      baseSha: "base",
      headSha: "head-two",
      branch: "maswe/shared",
    });
    transaction.bindStable({
      runId: "run-branch-suspended",
      installationId: 10,
      repositoryId: 700,
      repository: "owner/repo",
      pullRequestNumber: 7,
      baseSha: "base",
      headSha: "head-suspended",
      branch: "maswe/shared",
      suspended: true,
    });
  });

  const matches = await index.findAllStableByRepositoryBranch(700, "maswe/shared");

  assert.deepEqual(
    matches.map((record) => [record.pullRequestNumber, record.runId]),
    [
      [2, "run-branch-two"],
      [5, "run-branch-five"],
    ],
  );
});

test("refreshCanonicalRepository updates the mutable name in place without changing the stable key or id", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-refresh-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const index = new GitHubAssociationIndex(githubRoot);
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-rename",
      installationId: 10,
      repositoryId: 321,
      repository: "old-owner/old-name",
      pullRequestNumber: 6,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/rename",
    }),
  );

  const refreshed = await index.withTransaction(async (transaction) =>
    transaction.refreshCanonicalRepository(321, 6, "new-owner/new-name"),
  );

  assert.equal(refreshed?.repository, "new-owner/new-name");
  assert.equal(refreshed?.repositoryId, 321);
  const stillFound = await index.findStable(321, 6);
  assert.equal(stillFound?.repository, "new-owner/new-name");
  const raw = JSON.parse(
    await readFile(path.join(githubRoot, "associations.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(Object.hasOwn(raw, "321#6"));
  assert.equal(Object.keys(raw).length, 1);
});

test("old-name replay after a rename cannot restore the old name (id never derives a name)", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-no-name-derive-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-old-name",
      installationId: 10,
      repositoryId: 654,
      repository: "owner/old",
      pullRequestNumber: 4,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/x",
    }),
  );
  await index.withTransaction(async (transaction) =>
    transaction.refreshCanonicalRepository(654, 4, "owner/new"),
  );

  const record = await index.findStable(654, 4);
  assert.equal(record?.repository, "owner/new");
  assert.notEqual(record?.repository, "owner/old");
});

test("same id with a different name resolves the same run; same name with a different id conflicts", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-same-id-diff-name-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-same-id",
      installationId: 10,
      repositoryId: 111,
      repository: "owner/repo",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/x",
    }),
  );
  await index.withTransaction(async (transaction) =>
    transaction.refreshCanonicalRepository(111, 1, "owner/renamed"),
  );
  // Same ID, new name still resolves the same run.
  assert.equal((await index.findStable(111, 1))?.runId, "run-same-id");

  // A different repository claiming the SAME name at a different ID must be an
  // independent record, not the same identity: it binds cleanly under its own id.
  const other = await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-different-id",
      installationId: 10,
      repositoryId: 222,
      repository: "owner/renamed",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/y",
    }),
  );
  assert.equal(other.repositoryId, 222);
  assert.equal((await index.findStable(222, 1))?.runId, "run-different-id");
  assert.equal((await index.findStable(111, 1))?.runId, "run-same-id");
});

test("bindStable rejects a second active run claiming the same stable pull request identity", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-stable-dup-pr-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-first",
      installationId: 10,
      repositoryId: 8080,
      repository: "owner/repo",
      pullRequestNumber: 12,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/x",
    }),
  );

  await assert.rejects(
    index.withTransaction(async (transaction) =>
      transaction.bindStable({
        runId: "run-second",
        installationId: 10,
        repositoryId: 8080,
        repository: "owner/repo",
        pullRequestNumber: 12,
        baseSha: "base",
        headSha: "head2",
        branch: "maswe/y",
      }),
    ),
    /already associated|duplicate/i,
  );
});

test("migrateLegacy removes the exact legacy key and inserts the exact stable key in one transaction", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-migrate-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  const index = new GitHubAssociationIndex(githubRoot);
  await index.bind({
    runId: "run-migrate",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 8,
    baseSha: "base",
    headSha: "head",
    branch: "maswe/migrate",
  });

  const migrated = await index.withTransaction(async (transaction) =>
    transaction.migrateLegacy({
      legacyRepository: "owner/repo",
      stable: {
        runId: "run-migrate",
        installationId: 10,
        repositoryId: 2468,
        repository: "owner/repo",
        pullRequestNumber: 8,
        baseSha: "base",
        headSha: "head",
        branch: "maswe/migrate",
      },
    }),
  );

  assert.equal(migrated.repositoryId, 2468);
  assert.equal(await index.find("owner/repo", 8), undefined);
  assert.equal((await index.findStable(2468, 8))?.runId, "run-migrate");

  const raw = JSON.parse(
    await readFile(path.join(githubRoot, "associations.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw), ["2468#8"]);
});

// --- Step 2: failing mixed-parser tests ---

test("mixed association index accepts exact legacy and exact stable records in one file", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-mixed-ok-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  await mkdir(githubRoot, { recursive: true });
  const records = {
    "owner/legacy#1": {
      runId: "run-legacy",
      installationId: 10,
      repository: "owner/legacy",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/legacy",
      suspended: false,
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
    "999#2": stableRecord({ runId: "run-mixed-stable", repositoryId: 999, pullRequestNumber: 2 }),
  };
  await writeFile(
    path.join(githubRoot, "associations.json"),
    `${JSON.stringify(records)}\n`,
    "utf8",
  );

  const index = new GitHubAssociationIndex(githubRoot);
  assert.equal((await index.find("owner/legacy", 1))?.runId, "run-legacy");
  assert.equal((await index.findStable(999, 2))?.runId, "run-mixed-stable");
});

test("mixed association index rejects malformed keys, mismatches, and unknown fields", async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    // malformed key: does not match either the legacy or the stable key shape
    ["not-a-valid-key-1", { "not-a-valid-key": stableRecord() }],
    // key/record mismatch: stable record stored under the wrong pull request number
    ["555#1", { "555#1": stableRecord({ pullRequestNumber: 2 }) }],
    // key/record mismatch: legacy record stored under a numeric-looking key
    [
      "12345#1",
      {
        "12345#1": {
          runId: "run-x",
          installationId: 10,
          repository: "owner/repo",
          pullRequestNumber: 1,
          baseSha: "base",
          headSha: "head",
          branch: "b",
          suspended: false,
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
      },
    ],
    // malformed id: zero
    ["555#9-zero-id", { "555#9": stableRecord({ repositoryId: 0 }) }],
    // malformed id: negative
    ["555#9-negative-id", { "555#9": stableRecord({ repositoryId: -1 }) }],
    // malformed id: non-integer
    ["555#9-float-id", { "555.5#9": stableRecord({ repositoryId: 555.5 }) }],
    // unknown field alongside a valid stable record
    [
      "555#9-extra-field",
      { "555#9": { ...stableRecord(), token: "must-not-be-accepted" } },
    ],
    // malformed timestamp on a stable record
    ["555#9-bad-timestamp", { "555#9": stableRecord({ updatedAt: "not-a-timestamp" }) }],
  ];

  for (const [label, records] of cases) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-mixed-bad-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const githubRoot = path.join(cwd, ".maswe", "github");
    await mkdir(githubRoot, { recursive: true });
    await writeFile(
      path.join(githubRoot, "associations.json"),
      `${JSON.stringify(records)}\n`,
      "utf8",
    );

    await assert.rejects(
      new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
      /Invalid GitHub association index/i,
      label,
    );
  }
});

test("mixed association index rejects a duplicate active run id across legacy and stable shapes", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-mixed-dup-run-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  await mkdir(githubRoot, { recursive: true });
  const records = {
    "owner/repo#1": {
      runId: "run-shared",
      installationId: 10,
      repository: "owner/repo",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      branch: "b",
      suspended: false,
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
    "999#2": stableRecord({ runId: "run-shared", repositoryId: 999, pullRequestNumber: 2 }),
  };
  await writeFile(
    path.join(githubRoot, "associations.json"),
    `${JSON.stringify(records)}\n`,
    "utf8",
  );

  await assert.rejects(
    new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
    /duplicate active run/i,
  );
});

test("mixed association index rejects inconsistent stable/legacy claims for the same run", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-mixed-inconsistent-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const githubRoot = path.join(cwd, ".maswe", "github");
  await mkdir(githubRoot, { recursive: true });
  // The same run appears once under its old legacy name-keyed record (suspended, as
  // migrateLegacy would never leave it) and once under a stable record that claims the
  // exact same (repository, pullRequestNumber) tuple: an incomplete/duplicated migration.
  const records = {
    "owner/repo#5": {
      runId: "run-inconsistent",
      installationId: 10,
      repository: "owner/repo",
      pullRequestNumber: 5,
      baseSha: "base",
      headSha: "head",
      branch: "b",
      suspended: true,
      suspensionReason: "pull-request-closed",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
    "999#5": stableRecord({
      runId: "run-inconsistent",
      repositoryId: 999,
      repository: "owner/repo",
      pullRequestNumber: 5,
    }),
  };
  await writeFile(
    path.join(githubRoot, "associations.json"),
    `${JSON.stringify(records)}\n`,
    "utf8",
  );

  await assert.rejects(
    new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
    /inconsistent/i,
  );
});

test("findAllLegacyByRepository enumerates only active, id-less records for exact-name migration candidates", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-legacy-enum-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-legacy-active",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "b",
  });
  await index.bind({
    runId: "run-legacy-suspended",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 2,
    baseSha: "base",
    headSha: "head",
    branch: "b",
    suspended: true,
  });
  await index.bind({
    runId: "run-legacy-other-repo",
    installationId: 10,
    repository: "owner/other",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "b",
  });
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-already-stable",
      installationId: 10,
      repositoryId: 1234,
      repository: "owner/repo",
      pullRequestNumber: 3,
      baseSha: "base",
      headSha: "head",
      branch: "b",
    }),
  );

  const candidates = await index.findAllLegacyByRepository("owner/repo");
  assert.deepEqual(
    candidates.map((record) => record.runId),
    ["run-legacy-active"],
  );
});

test("suspendStable and suspendLegacy operate only on their own key namespace", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-suspend-split-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-legacy-suspend",
    installationId: 10,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "b",
  });
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-stable-suspend",
      installationId: 10,
      repositoryId: 4321,
      repository: "owner/repo",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      branch: "b",
    }),
  );

  const suspendedStable = await index.withTransaction(async (transaction) =>
    transaction.suspendStable(4321, 1, "authorization-revoked"),
  );
  assert.equal(suspendedStable?.suspended, true);
  assert.equal((await index.find("owner/repo", 1))?.suspended, false);

  const suspendedLegacy = await index.withTransaction(async (transaction) =>
    transaction.suspendLegacy("owner/repo", 1, "pull-request-closed"),
  );
  assert.equal(suspendedLegacy?.suspended, true);
  assert.equal((await index.findStable(4321, 1))?.suspended, true);
});

test("findAllByInstallation returns both legacy and stable records for the same installation, sorted by name/pr/run", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-installation-mixed-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));
  await index.bind({
    runId: "run-legacy-mixed",
    installationId: 55,
    repository: "owner/legacy",
    pullRequestNumber: 3,
    baseSha: "base",
    headSha: "head",
    branch: "b",
  });
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-stable-mixed",
      installationId: 55,
      repositoryId: 6060,
      repository: "owner/stable",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      branch: "b",
    }),
  );
  // Different installation: must not appear in results.
  await index.bind({
    runId: "run-other-installation",
    installationId: 56,
    repository: "owner/other",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "b",
  });

  const all = await index.findAllByInstallation(55);
  assert.deepEqual(
    all.map((record) => [record.repository, record.runId]),
    [
      ["owner/legacy", "run-legacy-mixed"],
      ["owner/stable", "run-stable-mixed"],
    ],
  );
  const stableEntry = all.find((record) => record.runId === "run-stable-mixed");
  assert.equal(stableEntry?.repositoryId, 6060);

  // The optional repository filter matches the stable record by its mutable name.
  const filtered = await index.findAllByInstallation(55, "owner/stable");
  assert.deepEqual(
    filtered.map((record) => record.runId),
    ["run-stable-mixed"],
  );
});

// --- Step 4: explicit compatibility test ---

test("a baseline name-keyed record stays reachable only through generic methods and a stable record only through explicit stable methods", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-assoc-compat-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const index = new GitHubAssociationIndex(path.join(cwd, ".maswe", "github"));

  await index.bind({
    runId: "run-baseline",
    installationId: 10,
    repository: "owner/legacy-repo",
    pullRequestNumber: 4,
    baseSha: "base",
    headSha: "head",
    branch: "maswe/baseline",
  });
  await index.withTransaction(async (transaction) =>
    transaction.bindStable({
      runId: "run-stable-only",
      installationId: 10,
      repositoryId: 77_001,
      repository: "owner/stable-repo",
      pullRequestNumber: 4,
      baseSha: "base",
      headSha: "head",
      branch: "maswe/stable-only",
    }),
  );

  // Baseline generic surface still sees the legacy record exactly as before #34.
  assert.equal((await index.find("owner/legacy-repo", 4))?.runId, "run-baseline");
  const legacyBranchMatches = await index.findAllByRepositoryBranch(
    "owner/legacy-repo",
    "maswe/baseline",
  );
  assert.deepEqual(
    legacyBranchMatches.map((record) => record.runId),
    ["run-baseline"],
  );

  // The stable record is invisible to the generic name-primary surface under its real name...
  assert.equal(await index.find("owner/stable-repo", 4), undefined);
  // ...and reachable only through the explicit stable methods.
  assert.equal((await index.findStable(77_001, 4))?.runId, "run-stable-only");
  const stableBranchMatches = await index.findAllStableByRepositoryBranch(
    77_001,
    "maswe/stable-only",
  );
  assert.deepEqual(
    stableBranchMatches.map((record) => record.runId),
    ["run-stable-only"],
  );
});
