import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { aliasLegacyAttemptOneChecks } from "../src/github/check-identity-migration.ts";
import {
  checkRunIdempotencyKey,
  CheckPublisher,
  externalIdFor,
  legacyCheckRunIdempotencyKey,
  type GitHubHttpClient,
} from "../src/github/checks.ts";
import { GitHubSideEffectStore } from "../src/github/side-effect-store.ts";
import { MASWE_CHECK_NAMES } from "../src/github/types.ts";
import type { RunRecord } from "../src/domain.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const REPOSITORY_ID = 909090;
const LEGACY_REPOSITORY = "owner/repo";
const REPOSITORY = "owner/renamed";
const PULL_REQUEST_NUMBER = 9;
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function legacyExternalIdFor(checkName: string, headSha = HEAD_SHA): string {
  return externalIdFor(
    legacyCheckRunIdempotencyKey(LEGACY_REPOSITORY, PULL_REQUEST_NUMBER, headSha, checkName, 1),
  );
}

function stableKeyFor(checkName: string, headSha = HEAD_SHA): string {
  return checkRunIdempotencyKey(REPOSITORY_ID, PULL_REQUEST_NUMBER, headSha, checkName, 1);
}

function legacyKeyFor(checkName: string, headSha = HEAD_SHA): string {
  return legacyCheckRunIdempotencyKey(
    LEGACY_REPOSITORY,
    PULL_REQUEST_NUMBER,
    headSha,
    checkName,
    1,
  );
}

async function freshSideEffects(): Promise<GitHubSideEffectStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-check-alias-"));
  return new GitHubSideEffectStore(root);
}

function minimalRun(): RunRecord {
  return {
    schemaVersion: 1,
    version: 1,
    id: "run-1",
    title: "t",
    request: "r",
    repositoryPath: "/tmp",
    state: "PR_REVIEW",
    createdAt: "",
    updatedAt: "",
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config: DEFAULT_CONFIG,
    artifacts: [],
    events: [],
  } as RunRecord;
}

test("aliasLegacyAttemptOneChecks maps every proven pre-rename check onto its stable key", async () => {
  const sideEffects = await freshSideEffects();
  const legacyResourceIds = new Map(MASWE_CHECK_NAMES.map((name, index) => [name, 500 + index]));
  for (const name of MASWE_CHECK_NAMES) {
    await sideEffects.put(legacyKeyFor(name), {
      resourceId: legacyResourceIds.get(name)!,
      kind: "check-run",
    });
  }
  const gets: string[] = [];
  const http: GitHubHttpClient = {
    async request(method, url) {
      gets.push(`${method} ${url}`);
      if (method === "GET" && url.includes("/check-runs/")) {
        const id = Number(url.split("/").pop());
        const name = [...legacyResourceIds.entries()].find(([, value]) => value === id)?.[0];
        if (name === undefined) return { status: 404, headers: {}, body: { message: "Not Found" } };
        return {
          status: 200,
          headers: {},
          body: { name, head_sha: HEAD_SHA, external_id: legacyExternalIdFor(name) },
        };
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };

  await aliasLegacyAttemptOneChecks({
    repositoryId: REPOSITORY_ID,
    legacyRepository: LEGACY_REPOSITORY,
    repository: REPOSITORY,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headShas: [HEAD_SHA],
    token: "token",
    http,
    sideEffects,
  });

  for (const name of MASWE_CHECK_NAMES) {
    assert.deepEqual(
      await sideEffects.get(stableKeyFor(name)),
      { resourceId: legacyResourceIds.get(name)!, kind: "check-run" },
      `${name} must alias onto the same resource id under the stable key`,
    );
    // Old side-effect records remain historical recovery evidence.
    assert.deepEqual(await sideEffects.get(legacyKeyFor(name)), {
      resourceId: legacyResourceIds.get(name)!,
      kind: "check-run",
    });
  }
  assert.ok(gets.every((call) => call.startsWith("GET ")), "aliasing only reads, never writes GitHub state");
});

test("a first post-rename publication patches the aliased check instead of duplicating it", async () => {
  const sideEffects = await freshSideEffects();
  const aliasedName = "MASWE / deterministic quality";
  const aliasedId = 777;
  await sideEffects.put(legacyKeyFor(aliasedName), { resourceId: aliasedId, kind: "check-run" });
  const aliasHttp: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes(`/check-runs/${aliasedId}`)) {
        return {
          status: 200,
          headers: {},
          body: {
            name: aliasedName,
            head_sha: HEAD_SHA,
            external_id: legacyExternalIdFor(aliasedName),
          },
        };
      }
      // The other three checks have no local legacy record, so aliasing falls
      // back to a list-and-verify lookup; none has a provable legacy check.
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };
  await aliasLegacyAttemptOneChecks({
    repositoryId: REPOSITORY_ID,
    legacyRepository: LEGACY_REPOSITORY,
    repository: REPOSITORY,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headShas: [HEAD_SHA],
    token: "token",
    http: aliasHttp,
    sideEffects,
  });

  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let nextId = 1000;
  const publishHttp: GitHubHttpClient = {
    async request(method, url, options) {
      calls.push({ method, url, body: options?.body });
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      if (method === "POST") return { status: 201, headers: {}, body: { id: nextId++ } };
      if (method === "PATCH") return { status: 200, headers: {}, body: { id: Number(url.split("/").pop()) } };
      return { status: 200, headers: {}, body: {} };
    },
  };
  const publisher = new CheckPublisher({
    http: publishHttp,
    sideEffects,
    readOnlyChecks: true,
    repositoryId: REPOSITORY_ID,
    owner: "owner",
    repo: "renamed",
    pullRequestNumber: PULL_REQUEST_NUMBER,
    token: "token",
  });

  await publisher.publishForHeadSha(minimalRun(), HEAD_SHA);

  const postedNames = calls
    .filter((call) => call.method === "POST")
    .map((call) => (call.body as { name?: string }).name);
  assert.equal(postedNames.includes(aliasedName), false, "the aliased check must never be re-created");
  assert.equal(postedNames.length, MASWE_CHECK_NAMES.length - 1);
  const patch = calls.find(
    (call) => call.method === "PATCH" && call.url.endsWith(`/check-runs/${aliasedId}`),
  );
  assert.ok(patch, "the aliased check must be patched by its stable-key resource id");
});

test("a wrong head/name/external-id owner is rejected and no alias is manufactured", async (t) => {
  const cases: Array<{
    name: string;
    responseBody: { name: string; head_sha: string; external_id: string };
  }> = [
    {
      name: "wrong check name",
      responseBody: {
        name: "some other check",
        head_sha: HEAD_SHA,
        external_id: legacyExternalIdFor("MASWE / specification compliance"),
      },
    },
    {
      name: "wrong head sha",
      responseBody: {
        name: "MASWE / specification compliance",
        head_sha: "different-sha",
        external_id: legacyExternalIdFor("MASWE / specification compliance"),
      },
    },
    {
      name: "wrong external id",
      responseBody: {
        name: "MASWE / specification compliance",
        head_sha: HEAD_SHA,
        external_id: "maswe:check-run:sha256:" + "0".repeat(64),
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const sideEffects = await freshSideEffects();
      const checkName = "MASWE / specification compliance";
      await sideEffects.put(legacyKeyFor(checkName), { resourceId: 42, kind: "check-run" });
      const http: GitHubHttpClient = {
        async request(method, url) {
          if (method === "GET" && url.includes("/check-runs/42")) {
            return { status: 200, headers: {}, body: fixture.responseBody };
          }
          if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
          throw new Error(`Unexpected ${method} ${url}`);
        },
      };

      await aliasLegacyAttemptOneChecks({
        repositoryId: REPOSITORY_ID,
        legacyRepository: LEGACY_REPOSITORY,
        repository: REPOSITORY,
        pullRequestNumber: PULL_REQUEST_NUMBER,
        headShas: [HEAD_SHA],
        token: "token",
        http,
        sideEffects,
      });

      assert.equal(
        await sideEffects.get(stableKeyFor(checkName)),
        undefined,
        "an unproven legacy check must never be aliased",
      );
      assert.deepEqual(await sideEffects.get(legacyKeyFor(checkName)), {
        resourceId: 42,
        kind: "check-run",
      });
    });
  }
});

test("a unique legacy external-id match is aliased when no local record exists", async () => {
  const sideEffects = await freshSideEffects();
  const checkName = "MASWE / specification compliance";
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/check-runs") && url.includes("check_name=")) {
        return {
          status: 200,
          headers: {},
          body: {
            check_runs: [
              { id: 11, external_id: "maswe:check-run:sha256:" + "1".repeat(64) },
              { id: 12, external_id: legacyExternalIdFor(checkName) },
            ],
          },
        };
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };

  await aliasLegacyAttemptOneChecks({
    repositoryId: REPOSITORY_ID,
    legacyRepository: LEGACY_REPOSITORY,
    repository: REPOSITORY,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headShas: [HEAD_SHA],
    token: "token",
    http,
    sideEffects,
  });

  assert.deepEqual(await sideEffects.get(stableKeyFor(checkName)), {
    resourceId: 12,
    kind: "check-run",
  });
});

test("multiple legacy external-id matches conflict and no alias is written", async () => {
  const sideEffects = await freshSideEffects();
  const conflictingExternalId = externalIdFor(
    legacyCheckRunIdempotencyKey(
      LEGACY_REPOSITORY,
      PULL_REQUEST_NUMBER,
      HEAD_SHA,
      "MASWE / specification compliance",
      1,
    ),
  );
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("check_name=MASWE")) {
        const name = new URL(url).searchParams.get("check_name")!;
        if (name === "MASWE / specification compliance") {
          return {
            status: 200,
            headers: {},
            body: {
              check_runs: [
                { id: 21, external_id: conflictingExternalId },
                { id: 22, external_id: conflictingExternalId },
              ],
            },
          };
        }
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };

  await assert.rejects(
    () =>
      aliasLegacyAttemptOneChecks({
        repositoryId: REPOSITORY_ID,
        legacyRepository: LEGACY_REPOSITORY,
        repository: REPOSITORY,
        pullRequestNumber: PULL_REQUEST_NUMBER,
        headShas: [HEAD_SHA],
        token: "token",
        http,
        sideEffects,
      }),
    /conflict|ambiguous|multiple/i,
  );

  for (const name of MASWE_CHECK_NAMES) {
    assert.equal(
      await sideEffects.get(stableKeyFor(name)),
      undefined,
      "an ambiguous match must never be aliased",
    );
  }
});

test("current head and pending-cancellation heads are both reconciled", async () => {
  const sideEffects = await freshSideEffects();
  const currentHead = HEAD_SHA;
  const pendingHead = "fedcba9876543210fedcba9876543210fedcba98";
  const checkName = "MASWE / independent verification";
  await sideEffects.put(legacyKeyFor(checkName, currentHead), { resourceId: 61, kind: "check-run" });
  await sideEffects.put(legacyKeyFor(checkName, pendingHead), { resourceId: 62, kind: "check-run" });
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/check-runs/61")) {
        return {
          status: 200,
          headers: {},
          body: { name: checkName, head_sha: currentHead, external_id: legacyExternalIdFor(checkName, currentHead) },
        };
      }
      if (method === "GET" && url.includes("/check-runs/62")) {
        return {
          status: 200,
          headers: {},
          body: { name: checkName, head_sha: pendingHead, external_id: legacyExternalIdFor(checkName, pendingHead) },
        };
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };

  await aliasLegacyAttemptOneChecks({
    repositoryId: REPOSITORY_ID,
    legacyRepository: LEGACY_REPOSITORY,
    repository: REPOSITORY,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headShas: [currentHead, pendingHead],
    token: "token",
    http,
    sideEffects,
  });

  assert.deepEqual(await sideEffects.get(stableKeyFor(checkName, currentHead)), {
    resourceId: 61,
    kind: "check-run",
  });
  assert.deepEqual(await sideEffects.get(stableKeyFor(checkName, pendingHead)), {
    resourceId: 62,
    kind: "check-run",
  });
});

test("a second rename needs no further side-effect migration and makes no further GitHub calls", async () => {
  const sideEffects = await freshSideEffects();
  const checkName = "MASWE / review comments resolved";
  await sideEffects.put(legacyKeyFor(checkName), { resourceId: 81, kind: "check-run" });
  // The other three MASWE checks have no local or live legacy proof, so they
  // legitimately re-attempt a (cheap, read-only) lookup on every call -- only
  // the one check that was actually aliased must never be looked up again.
  let verifyCallsForAliasedCheck = 0;
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/check-runs/81")) {
        verifyCallsForAliasedCheck += 1;
        return {
          status: 200,
          headers: {},
          body: { name: checkName, head_sha: HEAD_SHA, external_id: legacyExternalIdFor(checkName) },
        };
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };

  const call = () =>
    aliasLegacyAttemptOneChecks({
      repositoryId: REPOSITORY_ID,
      legacyRepository: LEGACY_REPOSITORY,
      repository: REPOSITORY,
      pullRequestNumber: PULL_REQUEST_NUMBER,
      headShas: [HEAD_SHA],
      token: "token",
      http,
      sideEffects,
    });

  await call();
  assert.equal(verifyCallsForAliasedCheck, 1);

  await call();
  assert.equal(
    verifyCallsForAliasedCheck,
    1,
    "an already-aliased head/check must trigger zero further GitHub calls",
  );
  assert.deepEqual(await sideEffects.get(stableKeyFor(checkName)), { resourceId: 81, kind: "check-run" });
});

test("explicit non-1 attempt test/internal side-effect keys are not treated as production migration authority", async () => {
  const sideEffects = await freshSideEffects();
  const checkName = "MASWE / deterministic quality";
  const nonOneKey = `check-run:${LEGACY_REPOSITORY}/${PULL_REQUEST_NUMBER}/${HEAD_SHA}/${checkName}/7`;
  await sideEffects.put(nonOneKey, { resourceId: 999, kind: "check-run" });
  const http: GitHubHttpClient = {
    async request(method) {
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      throw new Error(`Unexpected ${method}`);
    },
  };

  await aliasLegacyAttemptOneChecks({
    repositoryId: REPOSITORY_ID,
    legacyRepository: LEGACY_REPOSITORY,
    repository: REPOSITORY,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headShas: [HEAD_SHA],
    token: "token",
    http,
    sideEffects,
  });

  assert.deepEqual(
    await sideEffects.get(nonOneKey),
    { resourceId: 999, kind: "check-run" },
    "the non-1 test/internal record must remain untouched",
  );
  assert.equal(
    await sideEffects.get(`check-run:${REPOSITORY_ID}/${PULL_REQUEST_NUMBER}/${HEAD_SHA}/${checkName}/7`),
    undefined,
    "no stable non-1 key may ever be fabricated by production aliasing",
  );
  assert.equal(
    await sideEffects.get(stableKeyFor(checkName)),
    undefined,
    "attempt 1 has no proven legacy check either, so no alias is manufactured from thin air",
  );
});

test("an outcome-unknown alias write is re-read and the alias continues once the stable key is confirmed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-gh-check-alias-outcome-unknown-"));
  const checkName = "MASWE / specification compliance";
  // Seed the legacy record through a plain store first, so the side-effects
  // namespace directory already exists before fault injection is armed --
  // otherwise the injected failure would fire on namespace creation instead
  // of on the alias write's own final durable-directory sync.
  await new GitHubSideEffectStore(root).put(legacyKeyFor(checkName), {
    resourceId: 71,
    kind: "check-run",
  });
  let failSyncOnce = true;
  const sideEffects = new GitHubSideEffectStore(root, {
    syncDirectory: async () => {
      if (failSyncOnce) {
        failSyncOnce = false;
        throw new Error("simulated directory sync failure");
      }
    },
  });
  const http: GitHubHttpClient = {
    async request(method, url) {
      if (method === "GET" && url.includes("/check-runs/71")) {
        return {
          status: 200,
          headers: {},
          body: { name: checkName, head_sha: HEAD_SHA, external_id: legacyExternalIdFor(checkName) },
        };
      }
      if (method === "GET") return { status: 200, headers: {}, body: { check_runs: [] } };
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };

  await aliasLegacyAttemptOneChecks({
    repositoryId: REPOSITORY_ID,
    legacyRepository: LEGACY_REPOSITORY,
    repository: REPOSITORY,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headShas: [HEAD_SHA],
    token: "token",
    http,
    sideEffects,
  });

  assert.equal(failSyncOnce, false, "the injected directory-sync failure must have fired exactly once");
  assert.deepEqual(await sideEffects.get(stableKeyFor(checkName)), {
    resourceId: 71,
    kind: "check-run",
  });
});
