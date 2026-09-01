import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { readBoundedOrdinaryFile } from "../src/durable-file.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { FileRunStore } from "../src/store.ts";

function sideEffectPath(root: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(root, "side-effects", `${digest}.json`);
}

function associationRecord() {
  return {
    runId: "run-hostile",
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "feature",
    suspended: false,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function stableAssociationBindInput() {
  return {
    runId: "run-stable-hostile",
    installationId: 1,
    repositoryId: 909,
    repository: "owner/repo",
    pullRequestNumber: 1,
    baseSha: "base",
    headSha: "head",
    branch: "feature",
  };
}

test("association reads reject a symlinked authoritative index", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-association-symlink-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.json");
  await writeFile(
    outside,
    `${JSON.stringify({ "owner/repo#1": associationRecord() })}\n`,
    "utf8",
  );
  const githubRoot = path.join(root, "github");
  await mkdir(githubRoot);
  await symlink(outside, path.join(githubRoot, "associations.json"));

  await assert.rejects(
    new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
    /ordinary|symbolic|unsafe/i,
  );
});

test("stable association reads reject a symlinked authoritative index the same way legacy reads do", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-association-stable-symlink-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.json");
  await writeFile(
    outside,
    `${JSON.stringify({ "909#1": { ...associationRecord(), repositoryId: 909 } })}\n`,
    "utf8",
  );
  const githubRoot = path.join(root, "github");
  await mkdir(githubRoot);
  await symlink(outside, path.join(githubRoot, "associations.json"));

  await assert.rejects(
    new GitHubAssociationIndex(githubRoot).findStable(909, 1),
    /ordinary|symbolic|unsafe/i,
  );
});

test("stable association capacity fails before publishing unreadable state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-association-stable-capacity-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const githubRoot = path.join(root, "github");
  await mkdir(githubRoot);
  const index = new GitHubAssociationIndex(githubRoot, { maxFileBytes: 512 });
  const first = stableAssociationBindInput();
  await index.withTransaction(async (transaction) => transaction.bindStable(first));
  const indexPath = path.join(githubRoot, "associations.json");
  const retained = await readFile(indexPath, "utf8");

  await assert.rejects(
    index.withTransaction(async (transaction) =>
      transaction.bindStable({
        ...first,
        runId: "run-stable-overflow",
        repositoryId: 910,
        pullRequestNumber: 2,
      }),
    ),
    /capacity|bounded|exceed/i,
  );

  assert.equal(await readFile(indexPath, "utf8"), retained);
  assert.equal((await index.findStable(909, 1))?.runId, "run-stable-hostile");
  assert.equal(await index.findStable(910, 2), undefined);
});

test("association reads reject an oversized authoritative index", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-association-oversized-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const githubRoot = path.join(root, "github");
  await mkdir(githubRoot);
  await writeFile(path.join(githubRoot, "associations.json"), Buffer.alloc(1_048_577, 0x20));

  await assert.rejects(
    new GitHubAssociationIndex(githubRoot).find("owner/repo", 1),
    /bounded|too large|ordinary/i,
  );
});

test("association capacity fails before publishing unreadable state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-association-capacity-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const githubRoot = path.join(root, "github");
  await mkdir(githubRoot);
  const index = new GitHubAssociationIndex(githubRoot, { maxFileBytes: 512 });
  const first = associationRecord();
  await index.bind(first);
  const indexPath = path.join(githubRoot, "associations.json");
  const retained = await readFile(indexPath, "utf8");

  await assert.rejects(
    index.bind({
      ...first,
      runId: "run-overflow",
      repository: "owner/second",
      pullRequestNumber: 2,
    }),
    /capacity|bounded|exceed/i,
  );

  assert.equal(await readFile(indexPath, "utf8"), retained);
  assert.equal((await index.find("owner/repo", 1))?.runId, "run-hostile");
  assert.equal(await index.find("owner/second", 2), undefined);
});

test("bounded ordinary reads fail closed without no-follow support and detect post-stat growth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-authoritative-read-bound-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "state.json");
  await writeFile(filePath, "abc", "utf8");

  await assert.rejects(
    readBoundedOrdinaryFile(filePath, "test state", 3, { noFollowFlag: null }),
    /no-follow|unsupported/i,
  );
  await assert.rejects(
    readBoundedOrdinaryFile(filePath, "test state", 3, {
      afterStat: async () => appendFile(filePath, "overflow", "utf8"),
    }),
    /bounded|exceed/i,
  );
});

test("side-effect reads reject symlinks and non-exact persisted identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-side-effect-hostile-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const key = "check-run:owner/repo/1/head/check/1";
  const directory = path.join(root, "side-effects");
  await mkdir(directory);
  const outside = path.join(root, "outside.json");
  await writeFile(
    outside,
    `${JSON.stringify({ idempotencyKey: key, resourceId: 999, kind: "check-run" })}\n`,
    "utf8",
  );
  await symlink(outside, sideEffectPath(root, key));
  await assert.rejects(new GitHubSideEffectStore(root).get(key), /ordinary|symbolic|unsafe/i);
  await rm(sideEffectPath(root, key));

  for (const record of [
    { idempotencyKey: "different-key", resourceId: 1, kind: "check-run" },
    { idempotencyKey: key, resourceId: 0, kind: "check-run" },
    { idempotencyKey: key, resourceId: 1.5, kind: "check-run" },
    { idempotencyKey: key, resourceId: 1, kind: "issue" },
    { idempotencyKey: key, resourceId: 1, kind: "check-run", token: "secret" },
  ]) {
    await writeFile(sideEffectPath(root, key), `${JSON.stringify(record)}\n`, "utf8");
    await assert.rejects(
      new GitHubSideEffectStore(root).get(key),
      /invalid GitHub side-effect record/i,
      JSON.stringify(record),
    );
  }

  await writeFile(sideEffectPath(root, key), Buffer.alloc(1_048_577, 0x20));
  await assert.rejects(
    new GitHubSideEffectStore(root).get(key),
    /bounded|too large|ordinary/i,
  );
});

test("side-effect writes reject a symlinked namespace without mutating its target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-side-effect-namespace-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(root, "side-effects"));

  await assert.rejects(
    new GitHubSideEffectStore(root).put("hostile-key", { resourceId: 1, kind: "check-run" }),
    /ordinary|symbolic|unsafe/i,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("side-effect writes reject extra fields without publishing them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-side-effect-exact-write-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const key = "check-run:owner/repo/1/head/check/1";
  const store = new GitHubSideEffectStore(root);

  await assert.rejects(
    store.put(key, {
      resourceId: 1,
      kind: "check-run",
      token: "must-not-persist",
    } as never),
    /invalid GitHub side-effect record/i,
  );
  await assert.rejects(readFile(sideEffectPath(root, key), "utf8"), { code: "ENOENT" });
});

test("run loading rejects symlinked, oversized, and non-exact top-level records", async (t) => {
  await t.test("symlink", async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-symlink-load-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const run = await store.create("run", "symlink", DEFAULT_CONFIG);
    const runPath = path.join(store.root, run.id, "run.json");
    const outside = path.join(cwd, "outside-run.json");
    await writeFile(outside, `${JSON.stringify(run)}\n`, "utf8");
    await rm(runPath);
    await symlink(outside, runPath);

    await assert.rejects(store.load(run.id), /ordinary|symlink|no-follow/i);
  });

  await t.test("oversized", async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-oversized-load-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const run = await store.create("run", "oversized", DEFAULT_CONFIG);
    await writeFile(path.join(store.root, run.id, "run.json"), Buffer.alloc(1_048_577, 0x20));

    await assert.rejects(store.load(run.id), /bounded|exceed/i);
  });

  await t.test("unknown top-level field", async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-exact-load-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const run = await store.create("run", "exact", DEFAULT_CONFIG);
    (run as unknown as Record<string, unknown>).token = "must-not-survive";
    await writeFile(
      path.join(store.root, run.id, "run.json"),
      `${JSON.stringify(run)}\n`,
      "utf8",
    );

    await assert.rejects(store.load(run.id), /unsupported run record field.*token/i);
  });

  await t.test("missing, mistyped, and directory-mismatched required fields", async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-required-load-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const store = new FileRunStore(cwd);
    const run = await store.create("run", "required", DEFAULT_CONFIG);
    const runPath = path.join(store.root, run.id, "run.json");
    const valid = JSON.parse(await readFile(runPath, "utf8")) as Record<string, unknown>;

    const corruptions: Array<[string, (record: Record<string, unknown>) => void]> = [
      ["missing title", (record) => { delete record.title; }],
      ["invalid state", (record) => { record.state = "NOT_A_STATE"; }],
      ["invalid approvals", (record) => {
        record.approvals = { brainstorm: "yes", design: false };
      }],
      ["invalid counters", (record) => {
        record.counters = { buildVerifyCycles: 0.5, commentResolutionCycles: 0 };
      }],
      ["invalid events", (record) => { record.events = {}; }],
      ["directory id mismatch", (record) => { record.id = "different-run"; }],
      ["missing config", (record) => { delete record.config; }],
    ];
    for (const [label, corrupt] of corruptions) {
      const record = structuredClone(valid);
      corrupt(record);
      await writeFile(runPath, `${JSON.stringify(record)}\n`, "utf8");
      await assert.rejects(store.load(run.id), /run record|run id|requested/i, label);
    }
  });
});

test("run capacity rejects before publication and preserves readable prior bytes", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-capacity-write-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const initialStore = new FileRunStore(cwd);
  const run = await initialStore.create("run", "retained", DEFAULT_CONFIG);
  const runPath = path.join(initialStore.root, run.id, "run.json");
  const retained = await readFile(runPath, "utf8");
  const boundedStore = new FileRunStore(cwd, {
    maxRunFileBytes: Buffer.byteLength(retained, "utf8") + 64,
  });
  const retainedVersion = run.version;
  const retainedUpdatedAt = run.updatedAt;
  run.request = "x".repeat(10_000);

  await assert.rejects(boundedStore.save(run), /bounded|capacity|exceed/i);

  assert.equal(await readFile(runPath, "utf8"), retained);
  assert.equal((await boundedStore.load(run.id)).request, "retained");
  assert.equal(run.version, retainedVersion);
  assert.equal(run.updatedAt, retainedUpdatedAt);
});

test("artifact capacity is checked before publishing artifact bytes", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-artifact-capacity-write-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const initialStore = new FileRunStore(cwd);
  const run = await initialStore.create("run", "retained", DEFAULT_CONFIG);
  const retained = await readFile(path.join(initialStore.root, run.id, "run.json"), "utf8");
  const boundedStore = new FileRunStore(cwd, {
    maxRunFileBytes: Buffer.byteLength(retained, "utf8") + 32,
  });

  await assert.rejects(
    boundedStore.writeArtifact(run, "capacity.md", "must not become an orphan"),
    /bounded|capacity|exceed/i,
  );
  await assert.rejects(
    readFile(
      path.join(initialStore.root, run.id, "artifacts", "capacity.attempt-1.md"),
      "utf8",
    ),
    { code: "ENOENT" },
  );
});

test("save reconciles the caller when directory sync fails after canonical publication", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-save-outcome-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const initialStore = new FileRunStore(cwd);
  const run = await initialStore.create("run", "before", DEFAULT_CONFIG);
  let failSync = true;
  const store = new FileRunStore(cwd, {
    syncDirectory: async () => {
      if (failSync) {
        failSync = false;
        throw new Error("simulated post-rename run directory sync failure");
      }
    },
  });
  run.request = "published despite unknown durability";

  await assert.rejects(store.save(run), /published.*directory sync failed/i);
  const canonical = await initialStore.load(run.id);
  assert.equal(canonical.request, "published despite unknown durability");
  assert.equal(run.version, canonical.version);
  assert.equal(run.updatedAt, canonical.updatedAt);
});

test("artifact outcome reconciliation preserves pending caller mutations", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-artifact-save-outcome-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const initialStore = new FileRunStore(cwd);
  const run = await initialStore.create("run", "before", DEFAULT_CONFIG);
  await initialStore.writeArtifact(run, "04-builder-report.md", "first");
  run.counters.buildVerifyCycles = 1;
  let failRunSync = true;
  const store = new FileRunStore(cwd, {
    syncDirectory: async (directoryPath) => {
      if (path.basename(directoryPath) === run.id && failRunSync) {
        failRunSync = false;
        throw new Error("simulated post-rename run directory sync failure");
      }
    },
  });

  await assert.rejects(
    store.writeArtifact(run, "04-builder-report.md", "second"),
    /published.*directory sync failed/i,
  );
  const canonical = await initialStore.load(run.id);
  assert.equal(canonical.artifacts.at(-1)?.attempt, 2);
  assert.equal(canonical.counters.buildVerifyCycles, 0);
  assert.equal(run.version, canonical.version);
  assert.equal(run.counters.buildVerifyCycles, 1);
  await initialStore.save(run);
  assert.equal((await initialStore.load(run.id)).counters.buildVerifyCycles, 1);
});

test("authoritative atomic writes surface file and parent-directory sync failures", async (t) => {
  for (const failure of ["file", "directory"] as const) {
    await t.test(`side-effect ${failure} sync`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `maswe-gh-side-sync-${failure}-`));
      t.after(async () => rm(root, { recursive: true, force: true }));
      const fail = async () => { throw new Error(`simulated ${failure} sync failure`); };
      const store = new GitHubSideEffectStore(root, {
        ...(failure === "file" ? { syncFile: fail } : { syncDirectory: fail }),
      } as never);
      await assert.rejects(
        store.put("sync-key", { resourceId: 1, kind: "check-run" }),
        new RegExp(`${failure} sync failure`),
      );
    });

    await t.test(`association ${failure} sync`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `maswe-gh-association-sync-${failure}-`));
      t.after(async () => rm(root, { recursive: true, force: true }));
      const fail = async () => { throw new Error(`simulated ${failure} sync failure`); };
      const index = new GitHubAssociationIndex(root, {
        ...(failure === "file" ? { syncFile: fail } : { syncDirectory: fail }),
      } as never);
      await assert.rejects(
        index.bind(associationRecord()),
        failure === "file"
          ? /file sync failure/
          : /published.*directory sync failed/,
      );
    });

    await t.test(`run ${failure} sync`, async (t) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `maswe-run-sync-${failure}-`));
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const fail = async () => { throw new Error(`simulated ${failure} sync failure`); };
      const store = new FileRunStore(cwd, {
        ...(failure === "file" ? { syncFile: fail } : { syncDirectory: fail }),
      } as never);
      await assert.rejects(
        store.create("sync", "failure", DEFAULT_CONFIG),
        failure === "file"
          ? /file sync failure/
          : /published.*directory sync failed/,
      );
    });
  }
});
