import assert from "node:assert/strict";
import test from "node:test";
import { parseMasweArgs } from "../src/cli-args.ts";

const validGrammarCases: Array<{
  name: string;
  argv: string[];
  positionals?: string[];
}> = [
  { name: "start split", argv: ["start", "--title", "T", "--request", "R"] },
  { name: "start equals", argv: ["start", "--title=T", "--request=R"] },
  {
    name: "equals-form dash-prefixed string value",
    argv: ["start", "--title=T", "--request=--literal"],
  },
  {
    name: "global before",
    argv: ["--cwd", "/tmp/x", "status", "run-1"],
    positionals: ["status", "run-1"],
  },
  {
    name: "global after",
    argv: ["status", "run-1", "--cwd=/tmp/x"],
    positionals: ["status", "run-1"],
  },
  {
    name: "run ID after equals option",
    argv: ["status", "--cwd=/tmp/x", "run-1"],
    positionals: ["status", "run-1"],
  },
  {
    name: "boolean leaves positional",
    argv: ["status", "--json", "run-1"],
    positionals: ["status", "run-1"],
  },
];

for (const grammarCase of validGrammarCases) {
  test(`CLI grammar accepts ${grammarCase.name}`, () => {
    const parsed = parseMasweArgs(grammarCase.argv);
    assert.deepEqual(parsed.positionals, grammarCase.positionals ?? [grammarCase.argv[0]!]);
  });
}

test("CLI grammar preserves an equals-form dash-prefixed string value", () => {
  const parsed = parseMasweArgs(["start", "--title=T", "--request=--literal"]);
  assert.equal(parsed.options.request, "--literal");
  assert.deepEqual(parsed.positionals, ["start"]);
});

const documentedCommands: Array<[name: string, argv: string[]]> = [
  ["help", ["help"]],
  ["init", ["init", "--force"]],
  ["doctor", ["doctor", "--json"]],
  ["start", ["start", "--title", "T", "--request", "R", "--json"]],
  ["status", ["status"]],
  ["approve", ["approve", "run-1", "brainstorm"]],
  ["run", ["run", "run-1"]],
  ["pr-opened", ["pr-opened", "run-1"]],
  ["review-comment", ["review-comment", "run-1", "--text", "comment"]],
  ["resume-review", ["resume-review", "run-1"]],
  ["merge-ready", ["merge-ready", "run-1"]],
  ["complete", ["complete", "run-1"]],
  ["cancel", ["cancel", "run-1"]],
  ["retry", ["retry", "run-1"]],
  ["supersede", ["supersede", "run-1"]],
  ["unlock", ["unlock", "run-1", "--force"]],
  ["unlock-admin", ["unlock-admin", "run-1", "--force"]],
  ["github-webhook", ["github-webhook"]],
  ["github-publish-checks", ["github-publish-checks", "run-1", "--json"]],
  ["cleanup", ["cleanup", "run-1"]],
];

for (const [name, argv] of documentedCommands) {
  test(`CLI grammar preserves documented ${name} syntax`, () => {
    const parsed = parseMasweArgs(["--config=config.json", ...argv, "--cwd", "/tmp/x"]);
    assert.equal(parsed.positionals[0], name);
    assert.equal(parsed.options.config, "config.json");
    assert.equal(parsed.options.cwd, "/tmp/x");
  });
}

const invalidGrammarCases: Array<[name: string, argv: string[]]> = [
  ["unknown", ["status", "--wat"]],
  ["unknown before a positional", ["status", "--wat", "run-1"]],
  [
    "split dash-prefixed string value without consuming the option-like token",
    ["start", "--title=T", "--request", "--literal"],
  ],
  ["duplicate split/equals", ["status", "--cwd", "a", "--cwd=b"]],
  ["missing string", ["start", "--title"]],
  ["wrong option for command", ["run", "r1", "--force"]],
  [
    "start both request forms",
    ["start", "--title", "T", "--request", "R", "--request-file", "r.md"],
  ],
  ["review both forms", ["review-comment", "r1", "--text", "x", "--file", "x.md"]],
  ["extra positional", ["run", "r1", "r2"]],
  ["missing command", []],
  ["unknown command", ["stat"]],
  ["option terminator", ["status", "--", "--wat"]],
  ["abbreviated option", ["status", "--con=config.json"]],
  ["short option", ["status", "-j"]],
  ["boolean implicit value", ["status", "--json=true"]],
  ["start missing title", ["start", "--request=R"]],
  ["start missing request source", ["start", "--title=T"]],
  ["review missing comment source", ["review-comment", "r1"]],
  ["empty title", ["start", "--title=", "--request=R"]],
  ["empty request", ["start", "--title=T", "--request="]],
  ["empty comment", ["review-comment", "r1", "--text="]],
];

for (const [name, argv] of invalidGrammarCases) {
  test(`CLI grammar rejects ${name}`, () => {
    assert.throws(() => parseMasweArgs(argv), Error);
  });
}

const duplicateOptionCases: Array<[name: string, argv: string[]]> = [
  ["config", ["status", "--config", "a", "--config=b"]],
  ["cwd", ["status", "--cwd", "a", "--cwd=b"]],
  ["title", ["start", "--title", "T", "--title=U", "--request=R"]],
  ["request", ["start", "--title=T", "--request", "R", "--request=S"]],
  [
    "request-file",
    ["start", "--title=T", "--request-file", "r.md", "--request-file=s.md"],
  ],
  ["text", ["review-comment", "r1", "--text", "x", "--text=y"]],
  ["file", ["review-comment", "r1", "--file", "x.md", "--file=y.md"]],
  ["json", ["status", "--json", "--json"]],
  ["force", ["init", "--force", "--force"]],
];

for (const [name, argv] of duplicateOptionCases) {
  test(`CLI grammar rejects mixed or repeated ${name} options`, () => {
    assert.throws(
      () => parseMasweArgs(argv),
      new RegExp(`Option --${name} may not appear more than once`),
    );
  });
}

const missingStringCases: Array<[name: string, argv: string[]]> = [
  ["config", ["status", "--config"]],
  ["cwd", ["status", "--cwd"]],
  ["title", ["start", "--request=R", "--title"]],
  ["request", ["start", "--title=T", "--request"]],
  ["request-file", ["start", "--title=T", "--request-file"]],
  ["text", ["review-comment", "r1", "--text"]],
  ["file", ["review-comment", "r1", "--file"]],
];

for (const [name, argv] of missingStringCases) {
  test(`CLI grammar rejects a missing ${name} value`, () => {
    assert.throws(() => parseMasweArgs(argv), Error);
  });
}

const wrongCommandOptionCases: Array<[name: string, argv: string[]]> = [
  ["force", ["run", "r1", "--force"]],
  ["json", ["run", "r1", "--json"]],
  ["title", ["status", "--title=T"]],
  ["request", ["status", "--request=R"]],
  ["request-file", ["status", "--request-file=r.md"]],
  ["text", ["status", "--text=x"]],
  ["file", ["status", "--file=x.md"]],
];

for (const [name, argv] of wrongCommandOptionCases) {
  test(`CLI grammar enforces the command allowlist for --${name}`, () => {
    assert.throws(() => parseMasweArgs(argv), new RegExp(`Option --${name} is not valid for`));
  });
}

const invalidPositionalCases: Array<[name: string, argv: string[]]> = [
  ["init operand", ["init", "extra"]],
  ["doctor operand", ["doctor", "extra"]],
  ["start operand", ["start", "extra", "--title=T", "--request=R"]],
  ["status second run ID", ["status", "r1", "r2"]],
  ["approve missing gate", ["approve", "r1"]],
  ["approve extra operand", ["approve", "r1", "design", "extra"]],
  ["approve unknown gate", ["approve", "r1", "ship"]],
  ["run missing run ID", ["run"]],
  ["review missing run ID", ["review-comment", "--text=x"]],
  ["review extra operand", ["review-comment", "r1", "r2", "--text=x"]],
  ["github-webhook operand", ["github-webhook", "extra"]],
  ["github-publish-checks missing run ID", ["github-publish-checks"]],
  ["cleanup missing run ID", ["cleanup"]],
  ["cleanup extra operand", ["cleanup", "r1", "r2"]],
  ["cleanup force forbidden", ["cleanup", "r1", "--force"]],
  ["cleanup json forbidden", ["cleanup", "r1", "--json"]],
];

for (const [name, argv] of invalidPositionalCases) {
  test(`CLI grammar rejects ${name}`, () => {
    assert.throws(() => parseMasweArgs(argv), Error);
  });
}

test("CLI grammar reports split dash-prefixed request text as a native ambiguous value", () => {
  assert.throws(
    () => parseMasweArgs(["start", "--title=T", "--request", "--literal"]),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(
        (error as TypeError & { code?: string }).code,
        "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
      );
      assert.match(error.message, /--request.*ambiguous|ambiguous.*--request/i);
      return true;
    },
  );
});

test("CLI grammar reports the intended mutual-exclusion and cardinality failures", () => {
  assert.throws(
    () =>
      parseMasweArgs([
        "start",
        "--title=T",
        "--request=R",
        "--request-file=r.md",
      ]),
    /start requires --title and exactly one request source/,
  );
  assert.throws(
    () => parseMasweArgs(["review-comment", "r1", "--text=x", "--file=x.md"]),
    /review-comment requires exactly one comment source/,
  );
  assert.throws(() => parseMasweArgs(["run", "r1", "r2"]), /run accepts exactly 1 operand/);
  assert.throws(() => parseMasweArgs(["status", "--wat"]), /Unknown option '--wat'/);
});
