import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCheckpoint, diffCheckpoints } from "../core/checkpoints.js";
import { buildResume } from "../core/resume.js";
import { formatBudgetPresets, resolveBudget } from "../core/presets.js";
import { buildDoctorReport } from "../core/doctor.js";
import { redactForRoot } from "../core/redaction.js";
import {
  appendEvent,
  getPackPath,
  initPack,
  readState,
  requirePackRoot,
  withPackWriteLock,
  writeState
} from "../core/store.js";
import { addEvidence, addSourceRecord, formatSourceStatuses, getSourceStatuses, replayEvents } from "../operations.js";
import { installIntegration } from "../integrations/install.js";
import { startMcpServer } from "../mcp/server.js";

type ArgValue = string | boolean | string[];

interface ParsedArgs {
  options: Record<string, ArgValue>;
  positionals: string[];
}

export async function runCli(argv: string[], cwd: string): Promise<void> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    const packPath = initPack(cwd);
    process.stdout.write(`Initialized Agentpack at ${packPath}\n`);
    return;
  }

  if (command === "mcp") {
    const parsed = parseArgs(rest);
    startMcpServer(stringOption(parsed.options.root) || cwd);
    return;
  }

  if (command === "doctor") {
    const report = buildDoctorReport(cwd);
    process.stdout.write(`${report.text}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const root = requirePackRoot(cwd);

  if (command === "status") {
    const state = readState(root);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  if (command === "record") {
    recordCommand(root, rest);
    return;
  }

  if (command === "note") {
    noteCommand(root, rest);
    return;
  }

  if (command === "source") {
    sourceCommand(root, rest);
    return;
  }

  if (command === "evidence") {
    evidenceCommand(root, rest);
    return;
  }

  if (command === "run") {
    runCommand(root, rest);
    return;
  }

  if (command === "checkpoint") {
    const parsed = parseArgs(rest);
    const checkpoint = createCheckpoint(root, {
      summary: stringOption(parsed.options.message) || stringOption(parsed.options.m) || stringOption(parsed.options.summary),
      status: stringOption(parsed.options.status),
      nextActions: toArray(parsed.options.next)
    });
    process.stdout.write(`Created checkpoint ${checkpoint.id}\n`);
    return;
  }

  if (command === "resume") {
    const parsed = parseArgs(rest);
    const resume = buildResume(root, {
      budget: budgetOption(parsed.options),
      query: stringOption(parsed.options.query)
    });
    process.stdout.write(`${resume.markdown}\n`);
    return;
  }

  if (command === "export") {
    const parsed = parseArgs(rest);
    const target = stringOption(parsed.options.to) || parsed.positionals[0] || "chatgpt";
    const resume = buildResume(root, {
      budget: budgetOption(parsed.options, 4000),
      query: stringOption(parsed.options.query)
    });
    const filePath = exportPath(root, target);
    writeFileSync(filePath, resume.markdown, "utf8");
    process.stdout.write(`Exported ${target} handoff to ${filePath}\n`);
    return;
  }

  if (command === "diff") {
    const parsed = parseArgs(rest);
    const diff = diffCheckpoints(root, parsed.positionals[0], parsed.positionals[1]);
    process.stdout.write(`${redactForRoot(root, diff)}\n`);
    return;
  }

  if (command === "replay") {
    const parsed = parseArgs(rest);
    const replay = replayEvents(root, numberOption(parsed.options.limit) || 50);
    process.stdout.write(`${redactForRoot(root, replay)}\n`);
    return;
  }

  if (command === "install") {
    const target = rest[0];
    if (!target) {
      throw new Error("install requires target: codex, claude, or cursor");
    }
    const parsed = parseArgs(rest.slice(1));
    const dryRun = installDryRun(parsed.options);
    const message = installIntegration(root, target, { dryRun });
    process.stdout.write(`${message}\n`);
    return;
  }

  if (command === "set") {
    setCommand(root, rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp(): void {
  process.stdout.write(`Agentpack

Portable savegames and context budgets for AI coding agents.

Usage:
  agentpack init
  agentpack set goal <text>
  agentpack set status <text>
  agentpack set next <item> [--next <item>]
  agentpack source add <file> --summary <text>
  agentpack source status [--json]
  agentpack record decision <text>
  agentpack record dead-end <text> --reason <text>
  agentpack note <text>
  agentpack evidence add --kind test-output --file test.log
  agentpack run "npm test"
  agentpack checkpoint -m <summary> --status <text> --next <item>
  agentpack resume --preset chat [--query <text>]
  agentpack export --to chatgpt --preset chat [--query <text>]
  agentpack diff [from] [to]
  agentpack replay
  agentpack doctor
  agentpack mcp [--root <path>]
  agentpack install codex|claude|cursor [--dry-run|--write]

Budget presets: ${formatBudgetPresets()}
`);
}

function recordCommand(root: string, rest: string[]): void {
  const type = rest[0];
  const args = rest.slice(1);
  const parsed = parseArgs(args);
  const text = stringOption(parsed.options.text) || parsed.positionals.join(" ");

  if (!isRecordType(type)) {
    throw new Error("record type must be decision, dead-end, or note");
  }

  if (!text) {
    throw new Error("record requires text");
  }

  const event = appendEvent(root, type, {
    text: redactForRoot(root, text),
    reason: redactForRoot(root, stringOption(parsed.options.reason) || ""),
    files: toArray(parsed.options.file),
    evidence: toArray(parsed.options.evidence)
  });

  process.stdout.write(`Recorded ${type} ${event.id}\n`);
}

function noteCommand(root: string, rest: string[]): void {
  const parsed = parseArgs(rest);
  const text = stringOption(parsed.options.text) || parsed.positionals.join(" ");

  if (!text) {
    throw new Error("note requires text");
  }

  const event = appendEvent(root, "note", { text: redactForRoot(root, text) });
  process.stdout.write(`Recorded note ${event.id}\n`);
}

function sourceCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];
  const args = rest.slice(1);

  if (subcommand === "status") {
    const parsed = parseArgs(args);
    if (parsed.options.json) {
      const statuses = JSON.stringify(getSourceStatuses(root), null, 2);
      process.stdout.write(`${redactForRoot(root, statuses)}\n`);
    } else {
      process.stdout.write(`${formatSourceStatuses(root)}\n`);
    }
    return;
  }

  if (subcommand !== "add") {
    throw new Error("source command supports `add` and `status`");
  }

  const parsed = parseArgs(args);
  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error("source add requires a file path");
  }

  const source = addSourceRecord(root, filePath, {
    summary: stringOption(parsed.options.summary) || stringOption(parsed.options.s) || parsed.positionals.slice(1).join(" "),
    snippet: stringOption(parsed.options.snippet) || ""
  });

  process.stdout.write(`Recorded source ${source.path} (${source.hash.slice(0, 12)})\n`);
}

function evidenceCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];
  const args = rest.slice(1);
  if (subcommand !== "add") {
    throw new Error("evidence command supports only `add` in v0");
  }

  const parsed = parseArgs(args);
  const event = addEvidence(root, {
    kind: stringOption(parsed.options.kind) || "note",
    file: stringOption(parsed.options.file),
    content: stringOption(parsed.options.content) || parsed.positionals.join(" "),
    command: stringOption(parsed.options.command),
    exitCode: stringOption(parsed.options.exitCode)
  });

  process.stdout.write(`Attached evidence ${event.id}\n`);
}

function runCommand(root: string, rest: string[]): void {
  const command = rest.join(" ").trim();
  if (!command) {
    throw new Error("run requires a command");
  }

  const startedAt = new Date().toISOString();
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  const exitCode = typeof result.status === "number" ? result.status : 1;
  const content = [
    `Command: ${command}`,
    `Started: ${startedAt}`,
    `Exit code: ${exitCode}`,
    "",
    "## stdout",
    stdout || "(empty)",
    "",
    "## stderr",
    stderr || "(empty)"
  ].join("\n");

  const event = addEvidence(root, {
    kind: "command-output",
    content,
    command,
    exitCode
  });

  process.stdout.write(`\nAttached command evidence ${event.id}\n`);
  process.exitCode = exitCode;
}

function setCommand(root: string, rest: string[]): void {
  const field = rest[0];
  const args = rest.slice(1);
  const parsed = parseArgs(args);
  const text = parsed.positionals.join(" ");

  withPackWriteLock(root, () => {
    const state = readState(root);

    if (field === "goal") {
      state.goal = redactForRoot(root, text);
    } else if (field === "status") {
      state.currentStatus = redactForRoot(root, text);
    } else if (field === "next") {
      state.nextActions = [text, ...toArray(parsed.options.next)]
        .filter(Boolean)
        .map((item) => redactForRoot(root, item));
    } else {
      throw new Error("set supports goal, status, or next");
    }

    writeState(root, state);
  });
  process.stdout.write(`Updated ${field}\n`);
}

function exportPath(root: string, target: string): string {
  const normalized = String(target).toLowerCase();
  const fileName = normalized === "chatgpt" ? "chatgpt-handoff.md" : `${normalized}-handoff.md`;
  const filePath = getPackPath(root, "exports", fileName);
  if (!existsSync(path.dirname(filePath))) {
    throw new Error("Agentpack exports directory is missing. Run `agentpack init` again.");
  }
  return filePath;
}

function parseArgs(args: string[]): ParsedArgs {
  const options: Record<string, ArgValue> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item) {
      continue;
    }

    if (item.startsWith("--")) {
      const [rawKey, inlineValue] = item.slice(2).split("=", 2);
      if (!rawKey) {
        continue;
      }
      const value = inlineValue !== undefined ? inlineValue : args[index + 1];
      if (inlineValue === undefined && value && !value.startsWith("-")) {
        index += 1;
        addOption(options, rawKey, value);
      } else {
        addOption(options, rawKey, true);
      }
      continue;
    }

    if (item.startsWith("-") && item.length > 1) {
      const key = item.slice(1);
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        index += 1;
        addOption(options, key, value);
      } else {
        addOption(options, key, true);
      }
      continue;
    }

    positionals.push(item);
  }

  return { options, positionals };
}

function addOption(options: Record<string, ArgValue>, key: string, value: ArgValue): void {
  if (options[key] === undefined) {
    options[key] = value;
    return;
  }

  if (Array.isArray(options[key])) {
    const textValue = stringOption(value);
    if (textValue) {
      options[key].push(textValue);
    }
    return;
  }

  options[key] = [...toArray(options[key]), ...toArray(value)];
}

function toArray(value: ArgValue | undefined): string[] {
  if (value === undefined || value === true || value === false) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function stringOption(value: ArgValue | undefined): string {
  if (value === undefined || value === true || value === false) {
    return "";
  }
  return Array.isArray(value) ? value[0] || "" : value;
}

function numberOption(value: ArgValue | undefined): number {
  if (value === undefined || value === true || value === false) {
    return 0;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function installDryRun(options: Record<string, ArgValue>): boolean {
  const dryRun = options["dry-run"] === true;
  const write = options.write === true;

  if (dryRun && write) {
    throw new Error("install accepts either --dry-run or --write, not both");
  }

  return !write;
}

function budgetOption(options: Record<string, ArgValue>, fallback = 0): number {
  return resolveBudget({
    budget: numberOption(options.budget),
    preset: stringOption(options.preset)
  }, fallback);
}

function isRecordType(value: string | undefined): value is "decision" | "dead-end" | "note" {
  return value === "decision" || value === "dead-end" || value === "note";
}
