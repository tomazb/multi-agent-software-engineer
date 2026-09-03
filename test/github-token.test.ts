import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createRepositoryInstallationAccessToken,
  type GitHubInstallationTokenPurpose,
} from "../src/github/token.ts";

function testPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const PURPOSE_PERMISSIONS: Record<GitHubInstallationTokenPurpose, Record<string, string>> = {
  "metadata-reconcile": { metadata: "read" },
  "pull-request-read": { metadata: "read", pull_requests: "read" },
  checks: { checks: "write", metadata: "read", pull_requests: "read" },
};

for (const purpose of Object.keys(PURPOSE_PERMISSIONS) as GitHubInstallationTokenPurpose[]) {
  test(`createRepositoryInstallationAccessToken scopes '${purpose}' to repository_ids with exact permissions`, async () => {
    let seenBody: unknown;
    let seenMethod: string | undefined;
    let seenUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;
    const token = await createRepositoryInstallationAccessToken({
      appId: "123",
      privateKeyPem: testPrivateKeyPem(),
      installationId: 9,
      repositoryId: 4242,
      purpose,
      http: {
        async request(method, url, options) {
          seenMethod = method;
          seenUrl = url;
          seenHeaders = options?.headers;
          seenBody = options?.body;
          return { status: 201, headers: {}, body: { token: "ghs_scoped" } };
        },
      },
    });
    assert.equal(token, "ghs_scoped");
    assert.equal(seenMethod, "POST");
    assert.equal(seenUrl, "https://api.github.com/app/installations/9/access_tokens");
    assert.equal(seenHeaders?.["content-type"], "application/json");
    assert.deepEqual(seenBody, {
      repository_ids: [4242],
      permissions: PURPOSE_PERMISSIONS[purpose],
    });
    assert.equal(Object.hasOwn(seenBody as object, "repositories"), false);
    assert.equal(Object.hasOwn(seenBody as object, "repository"), false);
  });
}

test("createRepositoryInstallationAccessToken rejects invalid repository ids before requesting a token", async () => {
  const invalidRepositoryIds = [0, -1, 1.5, Number.NaN, 2 ** 53, -(2 ** 53)];
  for (const repositoryId of invalidRepositoryIds) {
    let requests = 0;
    await assert.rejects(
      createRepositoryInstallationAccessToken({
        appId: "123",
        privateKeyPem: testPrivateKeyPem(),
        installationId: 9,
        repositoryId,
        purpose: "metadata-reconcile",
        http: {
          async request() {
            requests += 1;
            return { status: 201, headers: {}, body: { token: "too-broad" } };
          },
        },
      }),
      /repository id/i,
      `repositoryId ${repositoryId} should be rejected`,
    );
    assert.equal(requests, 0, `repositoryId ${repositoryId} must not issue a request`);
  }
});

test("createRepositoryInstallationAccessToken rejects invalid installation ids before requesting a token", async () => {
  let requests = 0;
  await assert.rejects(
    createRepositoryInstallationAccessToken({
      appId: "123",
      privateKeyPem: testPrivateKeyPem(),
      installationId: 0,
      repositoryId: 4242,
      purpose: "metadata-reconcile",
      http: {
        async request() {
          requests += 1;
          return { status: 201, headers: {}, body: { token: "too-broad" } };
        },
      },
    }),
    /installation id/i,
  );
  assert.equal(requests, 0);
});

test("createRepositoryInstallationAccessToken rejects an unknown purpose before requesting a token", async () => {
  // Includes Object.prototype keys ("constructor", "toString", "valueOf",
  // "hasOwnProperty") to pin the fix for the prototype-pollution fail-open
  // hole: a naive `REPOSITORY_TOKEN_PERMISSIONS[purpose]` lookup on a plain
  // object literal resolves these to inherited functions, which are truthy
  // and silently dropped by JSON.stringify, so the request would go out with
  // `permissions` omitted entirely -- GitHub then grants the installation's
  // FULL permission set. Each case must reject with zero HTTP requests
  // issued, not merely throw.
  //
  // "__proto__" is the case that pins the Object.hasOwn guard specifically.
  // The four keys above all resolve to functions, so the defence-in-depth
  // plain-object assertion would reject them even without Object.hasOwn.
  // "__proto__" instead resolves to Object.prototype itself -- typeof
  // "object", non-null, non-array -- so it slips past a type-only check and
  // is rejected solely because Object.hasOwn is evaluated first.
  const invalidPurposes = [
    "write-anything",
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ];
  for (const purpose of invalidPurposes) {
    let requests = 0;
    await assert.rejects(
      createRepositoryInstallationAccessToken({
        appId: "123",
        privateKeyPem: testPrivateKeyPem(),
        installationId: 9,
        repositoryId: 4242,
        purpose: purpose as GitHubInstallationTokenPurpose,
        http: {
          async request() {
            requests += 1;
            return { status: 201, headers: {}, body: { token: "too-broad" } };
          },
        },
      }),
      /purpose/i,
      `purpose '${purpose}' should be rejected`,
    );
    assert.equal(requests, 0, `purpose '${purpose}' must not issue a request`);
  }
});

test("createRepositoryInstallationAccessToken rejects an explicit read-only policy opt-out for every purpose", async () => {
  for (const purpose of Object.keys(PURPOSE_PERMISSIONS) as GitHubInstallationTokenPurpose[]) {
    let requests = 0;
    await assert.rejects(
      createRepositoryInstallationAccessToken({
        appId: "unused",
        privateKeyPem: "must-not-be-parsed",
        installationId: 9,
        repositoryId: 4242,
        purpose,
        readOnlyChecks: false,
        http: {
          async request() {
            requests += 1;
            return { status: 201, headers: {}, body: { token: "too-broad" } };
          },
        },
      }),
      /read-only checks policy/i,
    );
    assert.equal(requests, 0);
  }
});

test("createRepositoryInstallationAccessToken rejects malformed successful token responses", async () => {
  const malformedBodies: Array<[string, unknown]> = [
    ["null", null],
    ["a primitive", "not-an-object"],
    ["an array", []],
    ["a response without a token", {}],
    ["an empty token", { token: "" }],
  ];

  for (const [description, body] of malformedBodies) {
    await assert.rejects(
      createRepositoryInstallationAccessToken({
        appId: "123",
        privateKeyPem: testPrivateKeyPem(),
        installationId: 9,
        repositoryId: 4242,
        purpose: "metadata-reconcile",
        http: {
          async request() {
            return { status: 201, headers: {}, body };
          },
        },
      }),
      (error: unknown) => {
        assert.equal((error as Error).message, "Installation token response missing token", description);
        return true;
      },
    );
  }
});
