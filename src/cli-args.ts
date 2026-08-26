import { parseArgs } from "node:util";

const ARG_OPTIONS = {
  config: { type: "string" },
  cwd: { type: "string" },
  json: { type: "boolean" },
  force: { type: "boolean" },
  title: { type: "string" },
  request: { type: "string" },
  "request-file": { type: "string" },
  text: { type: "string" },
  file: { type: "string" },
} as const;

const GLOBAL_OPTIONS = new Set<MasweOptionName>(["config", "cwd"]);

interface CommandSpec {
  minPositionals: number;
  maxPositionals: number;
  options: readonly MasweOptionName[];
}

const COMMAND_SPECS = {
  help: { minPositionals: 0, maxPositionals: 0, options: [] },
  init: { minPositionals: 0, maxPositionals: 0, options: ["force"] },
  doctor: { minPositionals: 0, maxPositionals: 0, options: ["json"] },
  start: {
    minPositionals: 0,
    maxPositionals: 0,
    options: ["title", "request", "request-file", "json"],
  },
  status: { minPositionals: 0, maxPositionals: 1, options: ["json"] },
  approve: { minPositionals: 2, maxPositionals: 2, options: [] },
  run: { minPositionals: 1, maxPositionals: 1, options: [] },
  "pr-opened": { minPositionals: 1, maxPositionals: 1, options: [] },
  "review-comment": {
    minPositionals: 1,
    maxPositionals: 1,
    options: ["text", "file"],
  },
  "resume-review": { minPositionals: 1, maxPositionals: 1, options: [] },
  "merge-ready": { minPositionals: 1, maxPositionals: 1, options: [] },
  complete: { minPositionals: 1, maxPositionals: 1, options: [] },
  cancel: { minPositionals: 1, maxPositionals: 1, options: [] },
  retry: { minPositionals: 1, maxPositionals: 1, options: [] },
  supersede: { minPositionals: 1, maxPositionals: 1, options: [] },
  cleanup: { minPositionals: 1, maxPositionals: 1, options: [] },
  unlock: { minPositionals: 1, maxPositionals: 1, options: ["force"] },
  "unlock-admin": { minPositionals: 1, maxPositionals: 1, options: ["force"] },
  "github-webhook": { minPositionals: 0, maxPositionals: 0, options: [] },
  "github-publish-checks": {
    minPositionals: 1,
    maxPositionals: 1,
    options: ["json"],
  },
} as const satisfies Record<string, CommandSpec>;

export type MasweCommand = keyof typeof COMMAND_SPECS;
export type MasweOptionName = keyof typeof ARG_OPTIONS;

export interface MasweOptions {
  config?: string;
  cwd?: string;
  json?: boolean;
  force?: boolean;
  title?: string;
  request?: string;
  "request-file"?: string;
  text?: string;
  file?: string;
}

export interface ParsedMasweArgs {
  options: MasweOptions;
  positionals: [MasweCommand, ...string[]];
}

function isMasweCommand(value: string): value is MasweCommand {
  return Object.hasOwn(COMMAND_SPECS, value);
}

function optionCount(options: MasweOptions, names: readonly MasweOptionName[]): number {
  return names.filter((name) => options[name] !== undefined).length;
}

export function parseMasweArgs(argv: string[]): ParsedMasweArgs {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: ARG_OPTIONS,
  });

  const seenOptions = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === "option-terminator") {
      throw new Error("The CLI option terminator is not supported");
    }
    if (token.kind !== "option") continue;
    if (seenOptions.has(token.name)) {
      throw new Error(`Option --${token.name} may not appear more than once`);
    }
    seenOptions.add(token.name);
  }

  const [commandValue, ...operands] = parsed.positionals;
  if (!commandValue) throw new Error("A command is required");
  if (!isMasweCommand(commandValue)) throw new Error(`Unknown command: ${commandValue}`);

  const options: MasweOptions = { ...parsed.values };
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === "string" && value.length === 0) {
      throw new Error(`Option --${name} requires a non-empty value`);
    }
  }

  const spec = COMMAND_SPECS[commandValue];
  const allowedOptions = new Set<MasweOptionName>([...GLOBAL_OPTIONS, ...spec.options]);
  for (const name of Object.keys(options) as MasweOptionName[]) {
    if (!allowedOptions.has(name)) {
      throw new Error(`Option --${name} is not valid for ${commandValue}`);
    }
  }

  if (operands.length < spec.minPositionals || operands.length > spec.maxPositionals) {
    throw new Error(
      `${commandValue} accepts ${spec.minPositionals === spec.maxPositionals
        ? `exactly ${spec.minPositionals}`
        : `${spec.minPositionals}-${spec.maxPositionals}`} operand(s)`,
    );
  }

  if (commandValue === "approve" && operands[1] !== "brainstorm" && operands[1] !== "design") {
    throw new Error("approve requires <run-id> <brainstorm|design>");
  }
  if (
    commandValue === "start" &&
    (options.title === undefined || optionCount(options, ["request", "request-file"]) !== 1)
  ) {
    throw new Error("start requires --title and exactly one request source");
  }
  if (
    commandValue === "review-comment" &&
    optionCount(options, ["text", "file"]) !== 1
  ) {
    throw new Error("review-comment requires exactly one comment source");
  }

  return {
    options,
    positionals: [commandValue, ...operands],
  };
}
