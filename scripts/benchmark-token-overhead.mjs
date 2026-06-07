#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(repoRoot, "dist", "src", "agentpack.js");
const args = new Set(process.argv.slice(2));
const keepFixtures = args.has("--keep-fixtures");
const jsonOutput = args.has("--json");

if (!existsSync(cliPath)) {
  console.error("Missing dist/src/agentpack.js. Run `npm run build` before this benchmark.");
  process.exit(1);
}

const fixturesRoot = mkdtempSync(path.join(os.tmpdir(), "agentpack-token-bench-"));

try {
  const scenarios = [
    tinyQuestionScenario(),
    latestDiffReviewScenario(),
    resumedImplementationScenario(),
    staleSourceCacheScenario(),
    releasePrepHandoffScenario()
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    estimate: "ceil(characters / 4)",
    mcpWrapper: "modeled JSON-RPC tools/call text response",
    scenarios: scenarios.map((scenario) => summarizeScenario(scenario))
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
} finally {
  if (keepFixtures) {
    console.error(`Kept benchmark fixtures at ${fixturesRoot}`);
  } else {
    rmSync(fixturesRoot, { recursive: true, force: true });
  }
}

function tinyQuestionScenario() {
  const dir = createFixture("tiny-question", {
    "src/index.ts": [
      "export function statusLabel(done) {",
      "  return done ? \"ready\" : \"pending\";",
      "}",
      ""
    ].join("\n")
  });
  runCli(dir, [
    "set",
    "goal",
    "Answer a tiny status question without reopening unrelated files."
  ]);
  runCli(dir, [
    "task",
    "start",
    "Answer tiny status question",
    "--objective",
    "Report whether the current task has a next action and clean git state.",
    "--write-scope",
    "src/index.ts",
    "--next",
    "Answer the status question",
    "--risk",
    "low"
  ]);

  return {
    id: "tiny_question",
    label: "Tiny question",
    question: "What is the active task status?",
    agentpackCommand: "agentpack task status",
    agentpackOutput: runCli(dir, ["task", "status"]),
    directCommand: "git status --short --branch",
    directOutput: runGit(dir, ["status", "--short", "--branch"])
  };
}

function latestDiffReviewScenario() {
  const dir = createFixture("latest-diff-review", {
    "src/search.ts": [
      "export function buildQuery(input) {",
      "  return input.trim().toLowerCase();",
      "}",
      ""
    ].join("\n"),
    "tests/search.test.ts": [
      "import assert from \"node:assert/strict\";",
      "import { buildQuery } from \"../src/search.js\";",
      "",
      "assert.equal(buildQuery(\"  HELLO  \"), \"hello\");",
      ""
    ].join("\n")
  });
  runCli(dir, [
    "task",
    "start",
    "Review latest diff",
    "--objective",
    "Review the pending search-query change for behavior risk and missing tests.",
    "--write-scope",
    "src/search.ts",
    "--write-scope",
    "tests/search.test.ts",
    "--next",
    "Inspect changed files and call out regressions first",
    "--risk",
    "medium"
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/search.ts",
    "--summary",
    "Search query normalization trims input and lowercases it before lookup."
  ]);
  runCli(dir, [
    "source",
    "add",
    "tests/search.test.ts",
    "--summary",
    "Search tests cover whitespace trimming and lowercase normalization."
  ]);
  writeFileSync(path.join(dir, "src", "search.ts"), [
    "export function buildQuery(input) {",
    "  return input.normalize(\"NFKC\").trim().toLowerCase();",
    "}",
    "",
    "export function shouldSearch(input) {",
    "  return buildQuery(input).length >= 2;",
    "}",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(dir, "tests", "search.test.ts"), [
    "import assert from \"node:assert/strict\";",
    "import { buildQuery, shouldSearch } from \"../src/search.js\";",
    "",
    "assert.equal(buildQuery(\"  HELLO  \"), \"hello\");",
    "assert.equal(shouldSearch(\" x \"), false);",
    ""
  ].join("\n"), "utf8");

  return {
    id: "latest_diff_review",
    label: "Latest-diff review",
    question: "Review only the current diff.",
    agentpackCommand: "agentpack resume --preset quick --query \"latest diff review\"",
    agentpackOutput: runCli(dir, ["resume", "--preset", "quick", "--query", "latest diff review"]),
    directCommand: "git status --short && git diff -- src/search.ts tests/search.test.ts",
    directOutput: [
      runGit(dir, ["status", "--short"]),
      runGit(dir, ["diff", "--", "src/search.ts", "tests/search.test.ts"])
    ].join("\n")
  };
}

function resumedImplementationScenario() {
  const dir = createFixture("resumed-implementation", {
    "src/cache.ts": [
      "export class CacheStore {",
      "  constructor() {",
      "    this.values = new Map();",
      "  }",
      "",
      "  get(key) {",
      "    return this.values.get(key);",
      "  }",
      "",
      "  set(key, value) {",
      "    this.values.set(key, value);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "src/pipeline.ts": [
      "import { CacheStore } from \"./cache.js\";",
      "",
      "export function createPipeline(cache = new CacheStore()) {",
      "  return {",
      "    cache,",
      "    run(input) {",
      "      return input.trim();",
      "    }",
      "  };",
      "}",
      ""
    ].join("\n"),
    "tests/pipeline.test.ts": [
      "import assert from \"node:assert/strict\";",
      "import { createPipeline } from \"../src/pipeline.js\";",
      "",
      "assert.equal(createPipeline().run(\" x \"), \"x\");",
      ""
    ].join("\n"),
    "docs/CACHE.md": [
      "# Cache",
      "",
      "Pipeline cache state is intentionally local to each pipeline instance.",
      ""
    ].join("\n")
  });
  runCli(dir, ["set", "goal", "Finish cache-aware pipeline resume flow."]);
  runCli(dir, ["set", "status", "Implementation paused after cache API review."]);
  runCli(dir, [
    "set",
    "next",
    "Wire cache invalidation tests",
    "--next",
    "Keep handoff under the chat budget"
  ]);
  runCli(dir, [
    "task",
    "start",
    "Resume cache pipeline implementation",
    "--objective",
    "Continue the cache-aware pipeline change from recorded source conclusions.",
    "--constraint",
    "Do not re-open files whose source conclusions are unchanged unless needed.",
    "--constraint",
    "Preserve existing pipeline API behavior.",
    "--write-scope",
    "src/cache.ts",
    "--write-scope",
    "src/pipeline.ts",
    "--write-scope",
    "tests/pipeline.test.ts",
    "--next",
    "Add cache invalidation regression coverage",
    "--next",
    "Update docs only if behavior changes",
    "--risk",
    "medium"
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/cache.ts",
    "--summary",
    "CacheStore wraps a Map and exposes get/set without persistence or eviction."
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/pipeline.ts",
    "--summary",
    "createPipeline accepts an optional CacheStore and returns a run method that trims input."
  ]);
  runCli(dir, [
    "source",
    "add",
    "tests/pipeline.test.ts",
    "--summary",
    "Pipeline test currently verifies whitespace trimming only; cache invalidation coverage is still missing."
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Keep cache state per pipeline instance so tests can avoid shared global state."
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Resume should prefer source conclusions over re-reading unchanged implementation files."
  ]);
  runCli(dir, [
    "evidence",
    "add",
    "--kind",
    "test-output",
    "--content",
    "Focused pipeline test passed before pausing."
  ]);
  runCli(dir, [
    "checkpoint",
    "-m",
    "Paused with cache API reviewed",
    "--status",
    "Ready to resume implementation",
    "--next",
    "Add invalidation tests"
  ]);

  return {
    id: "resumed_implementation",
    label: "Resumed implementation",
    question: "Recover enough context to continue a paused coding task.",
    agentpackCommand: "agentpack resume --preset chat --query \"cache pipeline implementation\"",
    agentpackOutput: runCli(dir, ["resume", "--preset", "chat", "--query", "cache pipeline implementation"]),
    directCommand: "git status --short --branch && cat src/cache.ts src/pipeline.ts tests/pipeline.test.ts docs/CACHE.md",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      readFiles(dir, ["src/cache.ts", "src/pipeline.ts", "tests/pipeline.test.ts", "docs/CACHE.md"])
    ].join("\n")
  };
}

function staleSourceCacheScenario() {
  const dir = createFixture("stale-source-cache", {
    "src/active.ts": "export const active = true;\n",
    "src/changed.ts": "export const changed = \"v1\";\n",
    "docs/removed.md": "This document will be removed.\n"
  });
  runCli(dir, [
    "task",
    "start",
    "Triage stale source cache",
    "--objective",
    "Find changed or missing source records without dumping unchanged records.",
    "--write-scope",
    "src/changed.ts",
    "--write-scope",
    "docs/removed.md",
    "--next",
    "Refresh only conclusions that changed",
    "--risk",
    "low"
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/active.ts",
    "--summary",
    "Active source remains current and should stay out of stale-only triage."
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/changed.ts",
    "--summary",
    "Changed source exported a v1 marker."
  ]);
  runCli(dir, [
    "source",
    "add",
    "docs/removed.md",
    "--summary",
    "Removed docs file described an obsolete setup note."
  ]);
  writeFileSync(path.join(dir, "src", "changed.ts"), "export const changed = \"v2\";\n", "utf8");
  unlinkSync(path.join(dir, "docs", "removed.md"));

  return {
    id: "stale_source_cache",
    label: "Stale source triage",
    question: "Find stale source-cache entries only.",
    agentpackCommand: "agentpack source status --changed --missing",
    agentpackOutput: runCli(dir, ["source", "status", "--changed", "--missing"]),
    directCommand: "git status --short && git diff -- src/changed.ts",
    directOutput: [
      runGit(dir, ["status", "--short"]),
      runGit(dir, ["diff", "--", "src/changed.ts"])
    ].join("\n")
  };
}

function releasePrepHandoffScenario() {
  const dir = createFixture("release-prep-handoff", {
    "package.json": JSON.stringify({
      name: "example-release-fixture",
      version: "1.2.3",
      scripts: {
        test: "node --test"
      }
    }, null, 2),
    "docs/RELEASING.md": [
      "# Releasing",
      "",
      "Run focused tests, inspect the staged diff, then publish from GitHub Actions.",
      ""
    ].join("\n"),
    ".github/workflows/publish.yml": [
      "name: Publish",
      "on:",
      "  release:",
      "    types: [published]",
      "permissions:",
      "  contents: read",
      "  id-token: write",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish --access public",
      ""
    ].join("\n")
  });
  runCli(dir, ["set", "goal", "Prepare a normal weekly release handoff."]);
  runCli(dir, [
    "task",
    "start",
    "Prepare release handoff",
    "--objective",
    "Summarize release readiness, remaining checks, and rollout constraints.",
    "--constraint",
    "Do not push, tag, publish, or create GitHub Releases from benchmark fixtures.",
    "--write-scope",
    "docs/RELEASING.md",
    "--write-scope",
    ".github/workflows/publish.yml",
    "--next",
    "Run release preflight in the real repo",
    "--next",
    "Inspect staged diff before commit",
    "--risk",
    "medium"
  ]);
  runCli(dir, [
    "source",
    "add",
    "docs/RELEASING.md",
    "--summary",
    "Release docs require focused tests, staged diff inspection, and workflow-based publishing."
  ]);
  runCli(dir, [
    "source",
    "add",
    ".github/workflows/publish.yml",
    "--summary",
    "Publish workflow uses a release event and id-token permission for provenance."
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Release actions remain manual; benchmark fixtures must not publish."
  ]);
  runCli(dir, [
    "checkpoint",
    "-m",
    "Release handoff scaffolded",
    "--status",
    "Ready for preflight",
    "--next",
    "Run preflight in the real repo"
  ]);

  return {
    id: "release_prep_handoff",
    label: "Release-prep handoff",
    question: "Hand off release readiness without running release actions.",
    agentpackCommand: "agentpack task handoff",
    agentpackOutput: runCli(dir, ["task", "handoff"]),
    directCommand: "git status --short --branch && git log --oneline -5 && cat docs/RELEASING.md .github/workflows/publish.yml",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "--oneline", "-5"]),
      readFiles(dir, ["docs/RELEASING.md", ".github/workflows/publish.yml"])
    ].join("\n")
  };
}

function createFixture(name, files) {
  const dir = path.join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    writeFixtureFile(dir, filePath, content);
  }
  runGit(dir, ["init"]);
  runGit(dir, ["branch", "-M", "main"]);
  runCli(dir, ["init"]);
  runGit(dir, ["add", "."]);
  runGit(dir, [
    "-c",
    "user.name=Agentpack Benchmark",
    "-c",
    "user.email=benchmark@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial"
  ]);
  return dir;
}

function writeFixtureFile(root, filePath, content) {
  const absolutePath = path.join(root, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function summarizeScenario(scenario) {
  const agentpack = measure(scenario.agentpackOutput);
  const mcp = measure(wrapMcpText(scenario.agentpackOutput));
  const direct = measure(scenario.directOutput);
  const sectionBreakdown = measureMarkdownSections(scenario.agentpackOutput);
  return {
    id: scenario.id,
    label: scenario.label,
    question: scenario.question,
    agentpackCommand: scenario.agentpackCommand,
    directCommand: scenario.directCommand,
    agentpack,
    mcp,
    mcpOverhead: {
      characters: mcp.characters - agentpack.characters,
      estimatedTokens: mcp.estimatedTokens - agentpack.estimatedTokens
    },
    direct,
    deltaVsDirect: {
      agentpackTokens: agentpack.estimatedTokens - direct.estimatedTokens,
      mcpTokens: mcp.estimatedTokens - direct.estimatedTokens
    },
    ...(sectionBreakdown.length > 0 ? { sectionBreakdown } : {})
  };
}

function measure(output) {
  return {
    characters: output.length,
    estimatedTokens: estimateTokens(output)
  };
}

function estimateTokens(output) {
  return Math.max(1, Math.ceil(String(output || "").length / 4));
}

function measureMarkdownSections(output) {
  const text = String(output || "");
  if (!/^## /mu.test(text)) {
    return [];
  }

  const sections = [];
  let title = "Header";
  let lines = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      pushMeasuredSection(sections, title, lines);
      title = line.replace(/^##\s+/u, "").trim() || "Untitled";
      lines = [line];
    } else {
      lines.push(line);
    }
  }

  pushMeasuredSection(sections, title, lines);
  return sections;
}

function pushMeasuredSection(sections, title, lines) {
  const text = lines.join("\n").trim();
  if (!text) {
    return;
  }

  sections.push({
    title,
    ...measure(text)
  });
}

function wrapMcpText(text) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text
        }
      ]
    }
  }, null, 2);
}

function runCli(cwd, cliArgs) {
  return execFileSync(process.execPath, [cliPath, ...cliArgs], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runGit(cwd, gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function readFiles(cwd, filePaths) {
  return filePaths.map((filePath) => [
    `$ cat ${filePath}`,
    readFileSync(path.join(cwd, filePath), "utf8")
  ].join("\n")).join("\n");
}

function printReport(report) {
  const sectionRows = report.scenarios.flatMap((scenario) => (
    scenario.sectionBreakdown || []
  ).map((section) => [
    scenario.id,
    section.title,
    formatTokenCount(section.estimatedTokens),
    String(section.characters)
  ]));
  const lines = [
    "Agentpack token overhead benchmark",
    `Generated: ${report.generatedAt}`,
    `Estimate: ${report.estimate}`,
    `MCP wrapper: ${report.mcpWrapper}`,
    "",
    table([
      [
        "Scenario",
        "Agentpack",
        "MCP total",
        "MCP overhead",
        "Direct",
        "AP-direct",
        "MCP-direct"
      ],
      ...report.scenarios.map((scenario) => [
        scenario.label,
        formatTokenCount(scenario.agentpack.estimatedTokens),
        formatTokenCount(scenario.mcp.estimatedTokens),
        formatSignedTokenCount(scenario.mcpOverhead.estimatedTokens),
        formatTokenCount(scenario.direct.estimatedTokens),
        formatSignedTokenCount(scenario.deltaVsDirect.agentpackTokens),
        formatSignedTokenCount(scenario.deltaVsDirect.mcpTokens)
      ])
    ]),
    ""
  ];

  if (sectionRows.length > 0) {
    lines.push(
      "Agentpack section breakdown:",
      table([
        ["Scenario", "Section", "Tokens", "Characters"],
        ...sectionRows
      ]),
      ""
    );
  }

  lines.push(
    "Commands:",
    ...report.scenarios.flatMap((scenario) => [
      `- ${scenario.id}: ${scenario.agentpackCommand}`,
      `  direct: ${scenario.directCommand}`
    ]),
    "",
    "Notes:",
    "- Token counts use Agentpack's rough local estimate, not a model tokenizer.",
    "- Direct baselines show the likely git/file reads an agent would do without Agentpack context.",
    "- Positive deltas are overhead; negative deltas mean Agentpack output was shorter than the direct baseline.",
    "- Section breakdown attributes Markdown resume growth to buckets such as Source Cache, Evidence, and Current Task Passport."
  );

  process.stdout.write(lines.join("\n"));
  process.stdout.write("\n");
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row, rowIndex) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    if (rowIndex === 0) {
      return `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`;
    }
    return line;
  }).join("\n");
}

function formatTokenCount(value) {
  return String(value);
}

function formatSignedTokenCount(value) {
  return value > 0 ? `+${value}` : String(value);
}
