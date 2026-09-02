import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { parseMasweArgs } from "./cli-args.ts";
import { loadConfig, writeStarterConfig } from "./config.ts";
import type { AgentRuntime, MasweConfig, RunRecord } from "./domain.ts";
import { GitHubAppAdapter } from "./github/adapter.ts";
import { isGitHubPermanentRepositoryRejectReason } from "./github/dispatch-disposition.ts";
import {
  createFetchGitHubHttpClient,
  type FetchGitHubHttpClientOptions,
  type GitHubHttpClient,
} from "./github/http.ts";
import { createInstallationAccessToken } from "./github/token.ts";
import {
  listenWebhookServer,
  type WebhookServerOptions,
} from "./github/webhook-server.ts";
import { assertSupportedNodeVersion } from "./node-version.ts";
import { Orchestrator } from "./orchestrator.ts";
import { createRuntime } from "./runtime.ts";
import { renderRun } from "./run-rendering.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";
import { FileRunStore } from "./store.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDiagnosticField(value: unknown, pattern: RegExp, maxLength = 128): string | undefined {
  return typeof value === "string" && value.length <= maxLength && pattern.test(value)
    ? value
    : undefined;
}

/**
 * Bounded renderer for a permanently consumed repository delivery (design
 * doc §16). Recognized by its own safe fields and rendered from those fields
 * alone -- it deliberately never falls through to generic message/cause/detail
 * rendering, so no arbitrary text can travel out through this shape. The
 * diagnostic callback is the defined reader of the process-local
 * `permanentRepositoryDropsSinceStart` counter; it is never persisted.
 */
function permanentRepositoryDropDiagnostic(
  source: Record<string, unknown>,
): string | undefined {
  if (source.code !== "GITHUB_WEBHOOK_PERMANENT_REPOSITORY_DROP") return undefined;
  if (!isGitHubPermanentRepositoryRejectReason(source.reason)) return undefined;
  return [
    `code=${source.code}`,
    `reason=${source.reason}`,
    safeDiagnosticField(source.deliveryId, /^[A-Za-z0-9._-]+$/)
      ? `delivery=${String(source.deliveryId)}`
      : undefined,
    safeDiagnosticField(source.eventName, /^[A-Za-z0-9._-]+$/)
      ? `event=${String(source.eventName)}`
      : undefined,
    Number.isSafeInteger(source.attempt) && Number(source.attempt) >= 0
      ? `attempt=${String(source.attempt)}`
      : undefined,
    Number.isSafeInteger(source.count) && Number(source.count) > 0
      ? `count=${String(source.count)}`
      : undefined,
  ].filter((value): value is string => value !== undefined).join(" ");
}

function emitGitHubDiagnostic(error: unknown): void {
  const source = isRecord(error) ? error : {};
  const permanentDrop = permanentRepositoryDropDiagnostic(source);
  if (permanentDrop !== undefined) {
    console.error(
      sanitizeDiagnostic(permanentDrop, FAILURE_AGGREGATE_MAX_CODE_POINTS).text,
    );
    return;
  }
  const context = [
    safeDiagnosticField(source.code, /^[A-Z0-9_]+$/)
      ? `code=${String(source.code)}`
      : undefined,
    safeDiagnosticField(source.deliveryId, /^[A-Za-z0-9._-]+$/)
      ? `delivery=${String(source.deliveryId)}`
      : undefined,
    safeDiagnosticField(source.eventName, /^[A-Za-z0-9._-]+$/)
      ? `event=${String(source.eventName)}`
      : undefined,
    Number.isSafeInteger(source.attempt) && Number(source.attempt) >= 0
      ? `attempt=${String(source.attempt)}`
      : undefined,
    typeof source.handoffStarted === "boolean"
      ? `handoffStarted=${String(source.handoffStarted)}`
      : undefined,
  ].filter((value): value is string => value !== undefined);
  const cause = source.cause instanceof Error ? source.cause.message : undefined;
  const detail = typeof source.detail === "string" ? source.detail : undefined;
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    sanitizeDiagnostic(
      [...context, message, cause, detail].filter(Boolean).join(" "),
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
    ).text,
  );
}

function usage(): string {
  return `Multi-Agent Software Engineer (maswe)

Usage:
  maswe help
  maswe init [--force]
  maswe doctor [--json]
  maswe start --title <title> (--request <text> | --request-file <path>) [--json]
  maswe status [run-id] [--json]
  maswe approve <run-id> <brainstorm|design>
  maswe run <run-id>
  maswe pr-opened <run-id>
  maswe review-comment <run-id> (--text <text> | --file <path>)
  maswe resume-review <run-id>
  maswe merge-ready <run-id>
  maswe complete <run-id>
  maswe cancel <run-id>
  maswe retry <run-id>
  maswe supersede <run-id>
  maswe cleanup <run-id>
  maswe unlock <run-id> [--force]
  maswe unlock-admin <run-id> [--force]
  maswe github-webhook
  maswe github-publish-checks <run-id> [--json]

Options:
  --config <path>  Use a specific config file.
  --cwd <path>     Run against a different repository directory.
  --json           Print machine-readable output.
  --force          init: replace config; unlock*: assert quiescence and release exactly.

String option values beginning with "-" require --name=value.
`;
}

function orchestratorForProject(cwd: string, config: MasweConfig, store: FileRunStore): Orchestrator {
  const runtime = createRuntime(config, cwd);
  return new Orchestrator(cwd, config, runtime, store);
}

async function orchestratorForRun(
  cwd: string,
  store: FileRunStore,
  runId: string,
): Promise<{ orchestrator: Orchestrator; runtime: AgentRuntime; run: RunRecord }> {
  const run = await store.load(runId);
  const runtime = createRuntime(run.config, cwd);
  const orchestrator = new Orchestrator(cwd, run.config, runtime, store);
  return { orchestrator, runtime, run };
}

const PROJECT_CONFIG_COMMANDS = new Set(["doctor", "start", "github-webhook", "github-publish-checks"]);

export interface RunCliOptions {
  argv?: string[];
  observedNodeVersion?: string;
  githubHttpOptions?: FetchGitHubHttpClientOptions;
  webhookListener?: (options: WebhookServerOptions) => Promise<{ url: string; server?: Server }>;
  /** Injectable signal boundary for deterministic listener shutdown tests. */
  signalSource?: {
    once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
    off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  };
  shutdownIngressMs?: number;
  shutdownDrainMs?: number;
}

async function waitForShutdownSignal(source: NonNullable<RunCliOptions["signalSource"]>): Promise<void> {
  let settle!: () => void;
  const signal = new Promise<void>((resolve) => { settle = resolve; });
  const onSigterm = () => settle();
  const onSigint = () => settle();
  source.once("SIGTERM", onSigterm);
  source.once("SIGINT", onSigint);
  try {
    await signal;
  } finally {
    source.off("SIGTERM", onSigterm);
    source.off("SIGINT", onSigint);
  }
}

async function closeServerWithin(server: Server, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<"closed">((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve("closed"));
  });
  const outcome = await Promise.race([
    closed,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (outcome === "timeout") server.closeAllConnections?.();
}

function githubAdapterForCommand(
  cwd: string,
  config: MasweConfig,
  store: FileRunStore,
  http: GitHubHttpClient,
): GitHubAppAdapter {
  return new GitHubAppAdapter({
    cwd,
    config,
    store,
    http,
    tokenProvider: async (installationId, repository) => {
      const githubApp = config.githubApp!;
      const appId = process.env[githubApp.appIdEnv];
      const privateKey = process.env[githubApp.privateKeyEnv];
      if (!appId || !privateKey) {
        throw new Error("GitHub App id or private key environment variables are missing");
      }
      return createInstallationAccessToken({
        appId,
        privateKeyPem: privateKey,
        installationId,
        http,
        repository,
        readOnlyChecks: githubApp.readOnlyChecks,
      });
    },
    onWebhookDiagnostic: emitGitHubDiagnostic,
  });
}

export async function runCli(options: RunCliOptions = {}): Promise<void> {
  assertSupportedNodeVersion(options.observedNodeVersion ?? process.versions.node);

  const parsed = parseMasweArgs(options.argv ?? process.argv.slice(2));
  const [command, ...values] = parsed.positionals;
  const cwd = path.resolve(parsed.options.cwd ?? process.cwd());
  const configPath = parsed.options.config;

  if (command === "help") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const target = await writeStarterConfig(cwd, parsed.options.force ?? false);
    console.log(`Created ${target}`);
    console.log("Install Superpowers in Cursor with: /add-plugin superpowers");
    return;
  }

  const store = new FileRunStore(cwd);

  // Existing-run commands must not depend on current project config / env.
  let projectConfig: MasweConfig | undefined;
  if (PROJECT_CONFIG_COMMANDS.has(command)) {
    projectConfig = await loadConfig(cwd, configPath);
  }

  switch (command) {
    case "doctor": {
      const runtime = createRuntime(projectConfig!, cwd);
      const report = await runtime.doctor();
      if (parsed.options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const check of report.checks) {
          console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`);
        }
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case "start": {
      const title = parsed.options.title!;
      const requestText = parsed.options.request;
      const requestFile = parsed.options["request-file"];
      const request = requestFile ? await readFile(path.resolve(cwd, requestFile), "utf8") : requestText!;
      const orchestrator = orchestratorForProject(cwd, projectConfig!, store);
      const run = await orchestrator.start(title, request);
      console.log(parsed.options.json ? JSON.stringify(run, null, 2) : renderRun(run));
      return;
    }
    case "status": {
      const runId = values[0];
      if (runId) {
        const run = await store.load(runId);
        console.log(parsed.options.json ? JSON.stringify(run, null, 2) : renderRun(run));
      } else {
        const runs = await store.list();
        if (parsed.options.json) console.log(JSON.stringify(runs, null, 2));
        else console.log(runs.length ? runs.map(renderRun).join("\n\n") : "No runs found.");
      }
      return;
    }
    case "approve": {
      const runId = values[0]!;
      const gate = values[1] as "brainstorm" | "design";
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.approve(runId, gate)));
      return;
    }
    case "run": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.runUntilBlocked(runId)));
      return;
    }
    case "pr-opened": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.markPrOpened(runId)));
      return;
    }
    case "review-comment": {
      const runId = values[0]!;
      const text = parsed.options.text;
      const file = parsed.options.file;
      const comment = file ? await readFile(path.resolve(cwd, file), "utf8") : text!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.receiveReviewComment(runId, comment)));
      return;
    }
    case "resume-review": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.resumeHumanReview(runId)));
      return;
    }
    case "merge-ready": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.markMergeReady(runId)));
      return;
    }
    case "complete": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.complete(runId)));
      return;
    }
    case "cancel": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.cancel(runId)));
      return;
    }
    case "retry": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.retryFromFailed(runId)));
      return;
    }
    case "supersede": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.supersede(runId)));
      return;
    }
    case "cleanup": {
      const runId = values[0]!;
      const { orchestrator } = await orchestratorForRun(cwd, store, runId);
      console.log(renderRun(await orchestrator.cleanupTerminal(runId)));
      return;
    }
    case "unlock": {
      const runId = values[0]!;
      await store.unlock(runId, { force: parsed.options.force ?? false });
      console.log(`Published an exact data-lock release for run ${runId}`);
      return;
    }
    case "unlock-admin": {
      const runId = values[0]!;
      await store.unlockAdmin(runId, { force: parsed.options.force ?? false });
      console.log(`Published an exact admin-lock release for run ${runId}`);
      return;
    }
    case "github-webhook": {
      const config = projectConfig!;
      if (!config.githubApp?.enabled) {
        throw new Error("githubApp.enabled must be true to start the webhook server");
      }
      if (
        !process.env[config.githubApp.webhookSecretEnv] ||
        !process.env[config.githubApp.appIdEnv] ||
        !process.env[config.githubApp.privateKeyEnv]
      ) {
        throw new Error("GitHub App listener credentials are missing");
      }
      const http = createFetchGitHubHttpClient(options.githubHttpOptions);
      const adapter = githubAdapterForCommand(cwd, config, store, http);
      await adapter.initialize();
      await adapter.startWebhookWorker();
      let listener: { url: string; server?: Server };
      try {
        listener = await (options.webhookListener ?? listenWebhookServer)({
          adapter,
          host: config.githubApp.webhookHost ?? "127.0.0.1",
          port: config.githubApp.webhookPort ?? 8787,
          onDiagnostic: emitGitHubDiagnostic,
        });
      } catch (listenerError) {
        try {
          await adapter.stopWebhookWorker();
        } catch (stopError) {
          throw new AggregateError(
            [listenerError, stopError],
            "GitHub listener startup and worker shutdown both failed",
          );
        }
        throw listenerError;
      }
      console.log(`Listening for GitHub webhooks at ${listener.url}`);
      if (listener.server) {
        await waitForShutdownSignal(options.signalSource ?? process);
        let closeError: unknown;
        try {
          await closeServerWithin(listener.server, options.shutdownIngressMs ?? 8_000);
        } catch (error) {
          closeError = error;
        }
        let workerError: unknown;
        try {
          await adapter.stopWebhookWorker({ drainMs: options.shutdownDrainMs ?? 5_000 });
        } catch (error) {
          workerError = error;
        }
        if (closeError !== undefined && workerError !== undefined) {
          throw new AggregateError(
            [closeError, workerError],
            "GitHub listener and worker shutdown both failed",
          );
        }
        if (closeError !== undefined) throw closeError;
        if (workerError !== undefined) throw workerError;
      }
      return;
    }
    case "github-publish-checks": {
      const runId = values[0]!;
      const config = projectConfig!;
      if (!config.githubApp?.enabled) {
        throw new Error("githubApp.enabled must be true to publish checks");
      }
      const http = createFetchGitHubHttpClient(options.githubHttpOptions);
      const adapter = githubAdapterForCommand(cwd, config, store, http);
      await adapter.initializeManualPublisher();
      const run = await adapter.publishChecksForRun(runId);
      console.log(parsed.options.json ? JSON.stringify(run, null, 2) : renderRun(run));
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}
