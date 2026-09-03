import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGitHubWebhook } from "../src/github/normalize.ts";
import {
  MalformedGitHubWebhookError,
  UnsupportedGitHubWebhookError,
} from "../src/github/types.ts";

const REPO_ID = 1308655205;

test("normalize pull_request.synchronize into an internal event", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-1",
    eventName: "pull_request",
    payload: {
      action: "synchronize",
      installation: { id: 99 },
      repository: { id: REPO_ID, full_name: "owner/repo" },
      pull_request: {
        number: 7,
        head: { sha: "abc123", ref: "feature" },
        base: { sha: "def456" },
      },
    },
  });
  assert.equal(event.type, "pull_request.synchronize");
  assert.equal(event.eventId, "del-1");
  assert.equal(event.repository, "owner/repo");
  assert.equal(event.repositoryId, REPO_ID);
  assert.equal(event.installationId, 99);
  assert.equal(event.pullRequestNumber, 7);
  assert.equal(event.headSha, "abc123");
  assert.equal(event.baseSha, "def456");
  assert.equal(event.branch, "feature");
});

test("normalize validates repository shape before canonical case folding", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "case-fold",
    eventName: "pull_request",
    payload: {
      action: "opened",
      installation: { id: 99 },
      repository: { id: REPO_ID, full_name: "Owner/Repo" },
      pull_request: {
        number: 12,
        head: { sha: "head", ref: "feature" },
        base: { sha: "base" },
      },
    },
  });

  assert.equal(event.repository, "owner/repo");
  assert.equal(event.repositoryId, REPO_ID);
});

function repoScopedPayload(eventName: string, repository: unknown): {
  eventName: string;
  payload: Record<string, unknown>;
} {
  const base = { installation: { id: 99 }, repository };
  switch (eventName) {
    case "pull_request":
      return {
        eventName,
        payload: {
          ...base,
          action: "opened",
          pull_request: {
            number: 1,
            head: { sha: "head-sha", ref: "feature" },
            base: { sha: "base-sha" },
          },
        },
      };
    case "push":
      return {
        eventName,
        payload: { ...base, ref: "refs/heads/main", after: "after-sha" },
      };
    case "workflow_run":
      return {
        eventName,
        payload: {
          ...base,
          action: "completed",
          workflow_run: { head_sha: "run-sha" },
        },
      };
    case "check_run":
      return {
        eventName,
        payload: {
          ...base,
          action: "completed",
          check_run: { check_suite: { head_sha: "suite-sha" } },
        },
      };
    case "check_suite":
      return {
        eventName,
        payload: {
          ...base,
          action: "completed",
          check_suite: { head_sha: "suite-sha" },
        },
      };
    default:
      throw new Error(`unhandled eventName ${eventName}`);
  }
}

const REPO_SCOPED_EVENT_NAMES = [
  "pull_request",
  "push",
  "workflow_run",
  "check_run",
  "check_suite",
] as const;

test("every supported repo-scoped event requires and persists a positive safe repository id", () => {
  for (const eventName of REPO_SCOPED_EVENT_NAMES) {
    const { payload } = repoScopedPayload(eventName, { id: REPO_ID, full_name: "owner/repo" });
    const event = normalizeGitHubWebhook({
      deliveryId: `del-repoid-${eventName}`,
      eventName,
      payload,
    });
    assert.equal(event.repositoryId, REPO_ID, eventName);
    assert.equal(event.repository, "owner/repo", eventName);
  }
});

test("every supported repo-scoped event rejects missing/zero/negative/fractional/unsafe repository ids", () => {
  const malformedIds: Array<{ label: string; repository: unknown }> = [
    { label: "missing", repository: { full_name: "owner/repo" } },
    { label: "zero", repository: { id: 0, full_name: "owner/repo" } },
    { label: "negative", repository: { id: -1, full_name: "owner/repo" } },
    { label: "fractional", repository: { id: 1.5, full_name: "owner/repo" } },
    { label: "non-number", repository: { id: "1308655205", full_name: "owner/repo" } },
    {
      label: "beyond-safe-integer",
      repository: { id: Number.MAX_SAFE_INTEGER + 2, full_name: "owner/repo" },
    },
    { label: "NaN", repository: { id: Number.NaN, full_name: "owner/repo" } },
  ];

  for (const eventName of REPO_SCOPED_EVENT_NAMES) {
    for (const { label, repository } of malformedIds) {
      const { payload } = repoScopedPayload(eventName, repository);
      assert.throws(
        () =>
          normalizeGitHubWebhook({
            deliveryId: `del-bad-repoid-${eventName}-${label}`,
            eventName,
            payload,
          }),
        MalformedGitHubWebhookError,
        `${eventName}:${label}`,
      );
    }
  }
});

test("normalize never derives a repository id from a name or a name from an id", () => {
  // No repository.id at all: normalization must fail, never synthesize one from the name.
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-no-synthesis",
        eventName: "push",
        payload: {
          installation: { id: 1 },
          repository: { full_name: "owner/repo" },
          ref: "refs/heads/main",
          after: "sha",
        },
      }),
    MalformedGitHubWebhookError,
  );
  // No repository.full_name at all: normalization must fail, never synthesize one from the id.
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-no-reverse-synthesis",
        eventName: "push",
        payload: {
          installation: { id: 1 },
          repository: { id: 1308655205 },
          ref: "refs/heads/main",
          after: "sha",
        },
      }),
    MalformedGitHubWebhookError,
  );
});

test("normalize installation.deleted", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-2",
    eventName: "installation",
    payload: {
      action: "deleted",
      installation: { id: 55 },
    },
  });
  assert.equal(event.type, "installation.deleted");
  assert.equal(event.installationId, 55);
});

test("normalize workflow_run as observe-only", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-3",
    eventName: "workflow_run",
    payload: {
      action: "completed",
      installation: { id: 1 },
      repository: { id: REPO_ID, full_name: "owner/repo" },
      workflow_run: {
        head_sha: "deadbeef",
        conclusion: "success",
        status: "completed",
      },
    },
  });
  assert.equal(event.type, "workflow_run.completed");
  assert.equal(event.headSha, "deadbeef");
  assert.equal(event.observeOnly, true);
  assert.equal(event.repositoryId, REPO_ID);
  assert.equal(event.repository, "owner/repo");
});

test("observe-only event families reject every non-completed action as unsupported", () => {
  const cases = [
    { eventName: "workflow_run", action: "requested" },
    { eventName: "workflow_run", action: "in_progress" },
    { eventName: "workflow_run", action: undefined },
    { eventName: "workflow_run", action: "other" },
    { eventName: "check_run", action: "created" },
    { eventName: "check_run", action: "rerequested" },
    { eventName: "check_run", action: "requested_action" },
    { eventName: "check_run", action: undefined },
    { eventName: "check_run", action: "other" },
    { eventName: "check_suite", action: "requested" },
    { eventName: "check_suite", action: "in_progress" },
    { eventName: "check_suite", action: "rerequested" },
    { eventName: "check_suite", action: undefined },
    { eventName: "check_suite", action: "other" },
  ] as const;

  for (const [index, candidate] of cases.entries()) {
    assert.throws(
      () =>
        normalizeGitHubWebhook({
          deliveryId: `del-observe-unsupported-${index}`,
          eventName: candidate.eventName,
          payload:
            candidate.action === undefined ? {} : { action: candidate.action },
        }),
      UnsupportedGitHubWebhookError,
      `${candidate.eventName}:${String(candidate.action)}`,
    );
  }
});

test("normalize rejects unsupported event names", () => {
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-4",
        eventName: "gollum",
        payload: {},
      }),
    UnsupportedGitHubWebhookError,
  );
});

test("normalize distinguishes an unsupported action from a malformed supported payload", () => {
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-unsupported-action",
        eventName: "pull_request",
        payload: {
          action: "labeled",
          installation: { id: 99 },
          repository: { id: REPO_ID, full_name: "owner/repo" },
          pull_request: {
            number: 7,
            head: { sha: "abc123", ref: "feature" },
            base: { sha: "def456" },
          },
        },
      }),
    UnsupportedGitHubWebhookError,
  );

  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-malformed",
        eventName: "pull_request",
        payload: { action: "synchronize" },
      }),
    MalformedGitHubWebhookError,
  );
});

test("normalize installation_repositories.removed keeps id/name pairs and dedupes identical pairs", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-5",
    eventName: "installation_repositories",
    payload: {
      action: "removed",
      installation: { id: 7 },
      repositories_removed: [
        { id: 1, full_name: "Owner/One" },
        { id: 2, full_name: "OWNER/Two" },
        { id: 1, full_name: "owner/one" },
      ],
    },
  });
  assert.equal(event.type, "installation_repositories.removed");
  assert.deepEqual(event.repositories, [
    { repositoryId: 1, repository: "owner/one" },
    { repositoryId: 2, repository: "owner/two" },
  ]);
  assert.equal(event.repository, "owner/one");
});

test("normalize installation_repositories rejects the same id with a conflicting name", () => {
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-conflict",
        eventName: "installation_repositories",
        payload: {
          action: "added",
          installation: { id: 7 },
          repositories_added: [
            { id: 1, full_name: "owner/one" },
            { id: 1, full_name: "owner/renamed" },
          ],
        },
      }),
    MalformedGitHubWebhookError,
  );
});

test("normalize installation_repositories rejects missing/malformed item repository ids", () => {
  const malformedIds = [undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 2];
  for (const id of malformedIds) {
    assert.throws(
      () =>
        normalizeGitHubWebhook({
          deliveryId: `del-item-repoid-${String(id)}`,
          eventName: "installation_repositories",
          payload: {
            action: "added",
            installation: { id: 7 },
            repositories_added:
              id === undefined ? [{ full_name: "owner/one" }] : [{ id, full_name: "owner/one" }],
          },
        }),
      MalformedGitHubWebhookError,
      String(id),
    );
  }
});
