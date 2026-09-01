import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GitHubJournalError,
  initializeGitHubJournals,
  inspectLegacyGitHubJournalOwnership,
  withGitHubJournal,
} from "../src/github/journal.ts";
import {
  canonicalClaim,
  initializeLockJournal,
  journalPaths,
  scanLockJournal,
} from "../src/lock-journal.ts";

const ASSOCIATION_DIGEST =
  "0d0eff7483f9df60bddf94736a2ce4e3e77fe46d895ebd415d72351adb890e30";

function associationJournal(githubRoot: string): string {
  return path.join(
    githubRoot,
    "journals",
    "association",
    ASSOCIATION_DIGEST,
  );
}

function migrationMarker(githubRoot: string): string {
  return path.join(associationJournal(githubRoot), "legacy-migration.json");
}

function deadOwner(token = "dead-owner"): string {
  return `${JSON.stringify({
    pid: 999_999_999,
    token,
    at: "2026-08-09T10:00:00.000Z",
  })}\n`;
}

test("initialization probes the hash-addressed association journal filesystem", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-init-"));
  await initializeGitHubJournals(githubRoot);
  assert.equal(
    await readFile(
      path.join(associationJournal(githubRoot), ".lock-journal-v3", "format.json"),
      "utf8",
    ),
    '{"format":3,"protocol":"immutable-ticket-journal","ticketWidth":20}\n',
  );
});

test("initialization fails closed when hard-link publication is unavailable", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-no-link-"));
  await assert.rejects(
    initializeGitHubJournals(githubRoot, {
      linkFile: async () => {
        const error = new Error("hard links unavailable") as NodeJS.ErrnoException;
        error.code = "ENOTSUP";
        throw error;
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "GitHub association journal initialization failed",
  );
});

test("dead legacy regular-file ownership publishes digest-bound immutable evidence and retains the path", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-file-"));
  const legacyPath = path.join(githubRoot, "associations.lock");
  const raw = deadOwner();
  await writeFile(legacyPath, raw, "utf8");

  await initializeGitHubJournals(githubRoot);

  assert.equal(await readFile(legacyPath, "utf8"), raw);
  const markerPath = migrationMarker(githubRoot);
  assert.equal((await lstat(markerPath)).isFile(), true);
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  assert.equal(marker.kind, "association");
  assert.equal(marker.logicalKeyDigest, `sha256:${ASSOCIATION_DIGEST}`);
  assert.equal(
    marker.evidenceDigest,
    `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  );
  assert.equal(typeof marker.migrationDigest, "string");
  assert.equal(JSON.stringify(marker).includes("dead-owner"), false);
});

test("a published exact legacy marker wins over later unrelated PID reuse", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-pid-reuse-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const legacyPath = path.join(githubRoot, "associations.lock");
  const raw = `${JSON.stringify({
    pid: process.pid,
    token: "historical-owner",
    at: "2026-08-09T10:00:00.000Z",
  })}\n`;
  await writeFile(legacyPath, raw, "utf8");

  await initializeGitHubJournals(githubRoot, {
    isProcessDefinitelyDead: (pid) => pid === process.pid,
  });

  let postMarkerLivenessChecks = 0;
  await assert.doesNotReject(
    initializeGitHubJournals(githubRoot, {
      isProcessDefinitelyDead: () => {
        postMarkerLivenessChecks += 1;
        throw new Error("published marker must precede PID classification");
      },
    }),
  );
  assert.equal(postMarkerLivenessChecks, 0);
  assert.equal(await readFile(legacyPath, "utf8"), raw);
  await access(migrationMarker(githubRoot));
});

test("association journals reject every noncanonical logical key", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-association-key-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));

  await assert.rejects(
    withGitHubJournal(
      githubRoot,
      "association",
      "association",
      async () => undefined,
    ),
    /association journal options are invalid/i,
  );
  await assert.doesNotReject(
    withGitHubJournal(
      githubRoot,
      "association",
      "associations",
      async () => undefined,
    ),
  );
});

test("dead legacy directory ownership migrates without deleting the directory", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-dir-"));
  const logicalKey = "legacy-check";
  const digest = "0b0921d94d255f1b2eae802f8cdb610bd03a77a2af3bb439493e9abd786261e2";
  const legacyPath = path.join(
    githubRoot,
    "side-effect-create-locks",
    `${digest}.json.lock`,
  );
  await mkdir(legacyPath, { recursive: true });
  await writeFile(path.join(legacyPath, "owner.json"), deadOwner(), "utf8");

  await withGitHubJournal(githubRoot, "check-create", logicalKey, async () => undefined);

  assert.equal((await lstat(legacyPath)).isDirectory(), true);
  assert.equal(await readFile(path.join(legacyPath, "owner.json"), "utf8"), deadOwner());
  const marker = path.join(
    githubRoot,
    "journals",
    "check-create",
    digest,
    "legacy-migration.json",
  );
  assert.equal((await lstat(marker)).isFile(), true);
});

test("an empty legacy crash directory publishes identity evidence and remains present", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-empty-"));
  const legacyPath = path.join(githubRoot, "associations.lock");
  await mkdir(legacyPath);

  await initializeGitHubJournals(githubRoot);

  assert.deepEqual(await readdir(legacyPath), []);
  const marker = JSON.parse(
    await readFile(migrationMarker(githubRoot), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(marker.legacyType, "directory");
  assert.match(String(marker.evidenceDigest), /^sha256:[0-9a-f]{64}$/);
});

test("live, malformed, and changing legacy owners fail closed without migration", async (t) => {
  await t.test("live owner", async () => {
    const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-live-old-"));
    await writeFile(
      path.join(githubRoot, "associations.lock"),
      `${JSON.stringify({
        pid: process.pid,
        token: "live",
        at: "2026-08-09T10:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      initializeGitHubJournals(githubRoot),
      /GitHub association journal migration is blocked by legacy ownership/,
    );
    await assert.rejects(access(migrationMarker(githubRoot)), /ENOENT/);
  });

  await t.test("malformed owner", async () => {
    const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-bad-old-"));
    await writeFile(path.join(githubRoot, "associations.lock"), "not-json\n", "utf8");
    await assert.rejects(
      initializeGitHubJournals(githubRoot),
      /GitHub association journal migration is blocked by malformed legacy ownership/,
    );
    await assert.rejects(access(migrationMarker(githubRoot)), /ENOENT/);
  });

  await t.test("changing owner", async () => {
    const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-changing-"));
    const legacyPath = path.join(githubRoot, "associations.lock");
    await writeFile(legacyPath, deadOwner("first"), "utf8");
    await assert.rejects(
      initializeGitHubJournals(githubRoot, {
        afterLegacyObserved: async () => {
          await writeFile(legacyPath, deadOwner("replacement"), "utf8");
        },
      }),
      /GitHub association journal migration evidence changed/,
    );
    assert.equal(await readFile(legacyPath, "utf8"), deadOwner("replacement"));
    await assert.rejects(access(migrationMarker(githubRoot)), /ENOENT/);
  });
});

test("concurrent migration attempts reconcile one canonical marker without overwriting it", async () => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-migrate-race-"));
  await writeFile(path.join(githubRoot, "associations.lock"), deadOwner(), "utf8");
  let publicationAttempts = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      initializeGitHubJournals(githubRoot, {
        linkFile: async (existingPath, newPath) => {
          if (path.basename(newPath.toString()) === "legacy-migration.json") {
            publicationAttempts += 1;
          }
          await link(existingPath, newPath);
        },
      }),
    ),
  );

  assert.ok(publicationAttempts >= 1);
  const markerPath = migrationMarker(githubRoot);
  const before = await readFile(markerPath, "utf8");
  await initializeGitHubJournals(githubRoot);
  assert.equal(await readFile(markerPath, "utf8"), before);
  assert.deepEqual(
    (await readdir(associationJournal(githubRoot))).filter(
      (name) => name === "legacy-migration.json",
    ),
    ["legacy-migration.json"],
  );
});

test("legacy migration preserves both publication and temporary cleanup failures", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-migrate-errors-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  await writeFile(path.join(githubRoot, "associations.lock"), deadOwner(), "utf8");

  await assert.rejects(
    initializeGitHubJournals(githubRoot, {
      linkFile: async (existingPath, newPath) => {
        await link(existingPath, newPath);
        if (path.basename(newPath.toString()) !== "legacy-migration.json") return;
        await chmod(newPath, 0o600);
        await writeFile(newPath, "corrupted-after-publication\n", "utf8");
        await unlink(existingPath);
        await mkdir(existingPath);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubJournalError);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 2);
      return true;
    },
  );
});

test("journal transactions preserve both operation and release failures", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-release-errors-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const operationError = new Error("synthetic operation failure");

  await assert.rejects(
    withGitHubJournal(
      githubRoot,
      "delivery",
      "delivery-with-release-error",
      async () => {
        throw operationError;
      },
      {
        transition: async (event) => {
          if (event === "RELEASE_PREPARED") throw new Error("synthetic release failure");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], operationError);
      assert.ok(error.errors[1] instanceof GitHubJournalError);
      assert.equal(error.errors[1].code, "GITHUB_JOURNAL_RELEASE_FAILED");
      return true;
    },
  );
});

function ownershipJournalDirectory(
  githubRoot: string,
  kind: "publication" | "association-identity",
  logicalKey: string,
): string {
  const digest = createHash("sha256").update(logicalKey).digest("hex");
  return path.join(githubRoot, "journals", kind, digest);
}

test("the repository-identity fence is registered and serializes on repositoryId", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-repo-identity-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));

  let entered = false;
  await withGitHubJournal(githubRoot, "repository-identity", "9090", async () => {
    entered = true;
  });
  assert.equal(entered, true);

  const digest = createHash("sha256").update("9090").digest("hex");
  const claimPath = path.join(
    githubRoot,
    "journals",
    "repository-identity",
    digest,
    ".lock-journal-v3",
    "data",
    "claims",
    "00000000000000000001.json",
  );
  const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
  assert.equal(claim.operation, "github-repository-identity");
});

test("inspectLegacyGitHubJournalOwnership reports absent for a never-used logical key", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-inspect-absent-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));

  const result = await inspectLegacyGitHubJournalOwnership({
    githubRoot,
    kind: "publication",
    logicalKey: "owner/repo#1",
  });
  assert.deepEqual(result, { state: "absent" });
  await assert.rejects(access(path.join(githubRoot, "journals")), /ENOENT/);
});

test("inspectLegacyGitHubJournalOwnership reports absent once the only claim is fully released", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-inspect-resolved-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "owner/repo#2";

  await withGitHubJournal(githubRoot, "publication", logicalKey, async () => undefined);
  const journalDirectory = ownershipJournalDirectory(githubRoot, "publication", logicalKey);
  const before = await scanLockJournal(journalDirectory, "data");

  const result = await inspectLegacyGitHubJournalOwnership({
    githubRoot,
    kind: "publication",
    logicalKey,
  });
  assert.deepEqual(result, { state: "absent" });

  const after = await scanLockJournal(journalDirectory, "data");
  assert.deepEqual(after.claims, before.claims);
  assert.deepEqual(after.releases, before.releases);
});

test("inspectLegacyGitHubJournalOwnership reports live for an exactly-proven live owner and does not disturb it", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-inspect-live-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "owner/repo#3";
  const journalDirectory = ownershipJournalDirectory(
    githubRoot,
    "association-identity",
    logicalKey,
  );
  await mkdir(journalDirectory, { recursive: true });
  await initializeLockJournal(journalDirectory);
  const claim = canonicalClaim({
    kind: "data",
    ticket: 1n,
    owner: "550e8400-e29b-41d4-a716-446655440000",
    pid: process.pid,
    process: { startedAt: "2026-08-09T10:00:00.000Z", platformIdentity: null },
    at: "2026-08-09T10:00:00.000Z",
    operation: "github-association",
  });
  await writeFile(
    path.join(journalPaths(journalDirectory, "data").claims, "00000000000000000001.json"),
    claim.bytes,
    "utf8",
  );

  const result = await inspectLegacyGitHubJournalOwnership({
    githubRoot,
    kind: "association-identity",
    logicalKey,
  });
  assert.deepEqual(result, { state: "live" });

  const scan = await scanLockJournal(journalDirectory, "data");
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.claims[0]!.claimDigest, claim.record.claimDigest);
  assert.equal(scan.releases.size, 0);
});

test("inspectLegacyGitHubJournalOwnership reports dead for an exactly-proven dead owner without recovering it", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-inspect-dead-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "owner/repo#4";
  const journalDirectory = ownershipJournalDirectory(githubRoot, "publication", logicalKey);
  await mkdir(journalDirectory, { recursive: true });
  await initializeLockJournal(journalDirectory);
  const claim = canonicalClaim({
    kind: "data",
    ticket: 1n,
    owner: "550e8400-e29b-41d4-a716-446655440000",
    pid: 999_999_999,
    process: { startedAt: "2026-08-09T10:00:00.000Z", platformIdentity: null },
    at: "2026-08-09T10:00:00.000Z",
    operation: "github-publication",
  });
  await writeFile(
    path.join(journalPaths(journalDirectory, "data").claims, "00000000000000000001.json"),
    claim.bytes,
    "utf8",
  );

  const result = await inspectLegacyGitHubJournalOwnership({
    githubRoot,
    kind: "publication",
    logicalKey,
  });
  assert.deepEqual(result, { state: "dead" });

  const scan = await scanLockJournal(journalDirectory, "data");
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.claims[0]!.claimDigest, claim.record.claimDigest);
  assert.equal(scan.releases.size, 0);
});

test("inspectLegacyGitHubJournalOwnership reports malformed for a corrupt unresolved claim record", async (t) => {
  const githubRoot = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-journal-inspect-malformed-"));
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "owner/repo#5";
  const journalDirectory = ownershipJournalDirectory(githubRoot, "publication", logicalKey);
  await mkdir(journalDirectory, { recursive: true });
  await initializeLockJournal(journalDirectory);
  await writeFile(
    path.join(journalPaths(journalDirectory, "data").claims, "00000000000000000001.json"),
    "not-a-claim\n",
    "utf8",
  );

  const result = await inspectLegacyGitHubJournalOwnership({
    githubRoot,
    kind: "publication",
    logicalKey,
  });
  assert.deepEqual(result, { state: "malformed" });
});

test("inspectLegacyGitHubJournalOwnership reports malformed when the journal path is not an ordinary directory", async (t) => {
  const githubRoot = await mkdtemp(
    path.join(os.tmpdir(), "maswe-gh-journal-inspect-not-a-dir-"),
  );
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "owner/repo#6";
  const journalDirectory = ownershipJournalDirectory(githubRoot, "publication", logicalKey);
  await mkdir(path.dirname(journalDirectory), { recursive: true });
  await writeFile(journalDirectory, "not-a-directory\n", "utf8");

  const result = await inspectLegacyGitHubJournalOwnership({
    githubRoot,
    kind: "publication",
    logicalKey,
  });
  assert.deepEqual(result, { state: "malformed" });
});

test("inspectLegacyGitHubJournalOwnership reports ambiguous when death cannot be exactly proven", async (t) => {
  const githubRoot = await mkdtemp(
    path.join(os.tmpdir(), "maswe-gh-journal-inspect-ambiguous-"),
  );
  t.after(async () => rm(githubRoot, { recursive: true, force: true }));
  const logicalKey = "owner/repo#7";
  const journalDirectory = ownershipJournalDirectory(githubRoot, "publication", logicalKey);
  await mkdir(journalDirectory, { recursive: true });
  await initializeLockJournal(journalDirectory);
  const claim = canonicalClaim({
    kind: "data",
    ticket: 1n,
    owner: "550e8400-e29b-41d4-a716-446655440000",
    pid: process.pid,
    process: { startedAt: "2026-08-09T10:00:00.000Z", platformIdentity: null },
    at: "2026-08-09T10:00:00.000Z",
    operation: "github-publication",
  });
  await writeFile(
    path.join(journalPaths(journalDirectory, "data").claims, "00000000000000000001.json"),
    claim.bytes,
    "utf8",
  );

  const result = await inspectLegacyGitHubJournalOwnership({
    githubRoot,
    kind: "publication",
    logicalKey,
    isProcessDefinitelyDead: () => {
      throw new Error("liveness proof unavailable");
    },
  });
  assert.deepEqual(result, { state: "ambiguous" });

  const scan = await scanLockJournal(journalDirectory, "data");
  assert.equal(scan.claims.length, 1);
  assert.equal(scan.releases.size, 0);
});
