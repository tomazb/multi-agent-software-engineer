import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createInstallationAccessToken,
  createRepositoryInstallationAccessToken,
  type GitHubInstallationTokenPurpose,
} from "../src/github/token.ts";

function testPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

test("createInstallationAccessToken scopes checks write to one repository", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let seenBody: unknown;
  let seenMethod: string | undefined;
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  const token = await createInstallationAccessToken({
    appId: "123",
    privateKeyPem: pem,
    installationId: 9,
    repository: "owner/repo",
    http: {
      async request(method, url, options) {
        seenMethod = method;
        seenUrl = url;
        seenHeaders = options?.headers;
        seenBody = options?.body;
        return { status: 201, headers: {}, body: { token: "ghs_test" } };
      },
    },
  });
  assert.equal(token, "ghs_test");
  assert.equal(seenMethod, "POST");
  assert.equal(seenUrl, "https://api.github.com/app/installations/9/access_tokens");
  assert.equal(seenHeaders?.["content-type"], "application/json");
  assert.deepEqual(seenBody, {
    repositories: ["repo"],
    permissions: {
      checks: "write",
      pull_requests: "read",
      metadata: "read",
    },
  });
});

test("createInstallationAccessToken rejects a malformed repository before requesting a token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let requests = 0;

  await assert.rejects(
    createInstallationAccessToken({
      appId: "123",
      privateKeyPem: pem,
      installationId: 9,
      repository: "missing-owner-name",
      http: {
        async request() {
          requests += 1;
          return { status: 201, headers: {}, body: { token: "too-broad" } };
        },
      },
    }),
    /owner\/name/,
  );
  assert.equal(requests, 0);
});

test("createInstallationAccessToken rejects an explicit read-only policy opt-out", async () => {
  let requests = 0;
  await assert.rejects(
    createInstallationAccessToken({
      appId: "unused",
      privateKeyPem: "must-not-be-parsed",
      installationId: 9,
      repository: "owner/repo",
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
});

test("createInstallationAccessToken rejects malformed successful token responses", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const malformedBodies: Array<[string, unknown]> = [
    ["null", null],
    ["a primitive", "not-an-object"],
    ["an array", []],
    ["a response without a token", {}],
    ["an empty token", { token: "" }],
  ];

  for (const [description, body] of malformedBodies) {
    await assert.rejects(
      createInstallationAccessToken({
        appId: "123",
        privateKeyPem: pem,
        installationId: 9,
        repository: "owner/repo",
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
  let requests = 0;
  await assert.rejects(
    createRepositoryInstallationAccessToken({
      appId: "123",
      privateKeyPem: testPrivateKeyPem(),
      installationId: 9,
      repositoryId: 4242,
      purpose: "write-anything" as GitHubInstallationTokenPurpose,
      http: {
        async request() {
          requests += 1;
          return { status: 201, headers: {}, body: { token: "too-broad" } };
        },
      },
    }),
    /purpose/i,
  );
  assert.equal(requests, 0);
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
