import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createCheckpoint, diffCheckpoints } from "../core/checkpoints.js";
import { buildResume } from "../core/resume.js";
import { formatBudgetPresets, resolveBudget } from "../core/presets.js";
import { buildDoctorReport } from "../core/doctor.js";
import { redactForRoot } from "../core/redaction.js";
import {
  auditCurrentTask,
  blockCurrentTask,
  closeCurrentTask,
  formatCurrentTaskStatus,
  formatTaskAuditReport,
  getCurrentPassport,
  listTasks,
  parkCurrentTask,
  readPassport,
  startTask,
  switchTask,
  type TaskUpdateOptions,
  updateCurrentTaskPassport,
  updateCurrentTaskVerification
} from "../core/tasks.js";
import {
  appendEvent,
  getPackPath,
  initPack,
  readState,
  requirePackRoot,
  withPackWriteLock,
  writeState
} from "../core/store.js";
import {
  addEvidence,
  addSourceRecord,
  formatSourceStatuses,
  getSourceStatuses,
  pruneMissingSourceRecords,
  removeSourceRecord,
  replayEvents
} from "../operations.js";
import { installIntegration } from "../integrations/install.js";
import { startMcpServer } from "../mcp/server.js";

export type ArgValue = string | boolean | string[];

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

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  if (command === "init") {
    const packPath = initPack(cwd);
    process.stdout.write(`Initialized Agentpack at ${packPath}\n`);
    return;
  }

  if (command === "mcp") {
    const parsed = parseArgs(rest);
    startMcpServer(resolveMcpStartDir(parsed.options, cwd));
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

  if (command === "task") {
    taskCommand(root, rest);
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
    const target = stringOption(parsed.options.to) || parsed.positionals[0] || "markdown";
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
      throw new Error("install requires target: codex, claude, claude-desktop, or cursor");
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

export function resolveMcpStartDir(options: Record<string, ArgValue>, cwd: string): string {
  return stringOption(options.root) || process.env.AGENTPACK_ROOT || cwd;
}

function printHelp(): void {
  process.stdout.write(`Agentpack

Portable task continuity for AI coding agents.

Default workflow:
  agentpack init, install a client, then let MCP-connected agents use the
  generated project instructions. CLI commands are for setup, inspection,
  debugging, demos, and fallback.

Usage:
  agentpack init
  agentpack install codex|claude|claude-desktop|cursor [--dry-run|--write]
  agentpack doctor
  agentpack mcp [--root <path>]
  agentpack set goal <text>
  agentpack set status <text>
  agentpack set next <item> [--next <item>]
  agentpack task start <title> [--objective <text>] [--constraint <text>] [--write-scope <path>] [--next <item>] [--tag <tag>] [--risk low|medium|high]
  agentpack task update [--objective <text>] [--constraint <text>] [--write-scope <path>] [--next <item>] [--tag <tag>] [--risk low|medium|high]
  agentpack task list
  agentpack task status
  agentpack task passport
  agentpack task switch <id>
  agentpack task audit
  agentpack task park|block|close
  agentpack task update-verification [--status pending|passed|failed|accepted] [--evidence <id>] [--summary <text>]
  agentpack source add <file> --summary <text>
  agentpack source remove <file>
  agentpack source prune --missing
  agentpack source status [--json]
  agentpack record decision <text>
  agentpack record dead-end <text> --reason <text>
  agentpack note <text>
  agentpack evidence add --kind test-output --file test.log
  agentpack run "npm test"
  agentpack checkpoint -m <summary> --status <text> --next <item>
  agentpack resume --preset agent [--query <text>]
  agentpack export --to markdown --preset chat [--query <text>]
  agentpack diff [from] [to]
  agentpack replay
  agentpack --version
  agentpack --help

MCP root resolution: --root, then AGENTPACK_ROOT, then current working directory.
Install defaults to dry-run; pass --write to apply generated client config.
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

function taskCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];
  const args = rest.slice(1);

  if (subcommand === "start") {
    const parsed = parseArgs(args);
    const title = parsed.positionals.join(" ").trim();
    const startOptions = {
      title: redactForRoot(root, title),
      objective: redactForRoot(root, stringOption(parsed.options.objective)),
      constraints: toArray(parsed.options.constraint).map((item) => redactForRoot(root, item)),
      writeScope: toArray(parsed.options["write-scope"]),
      nextActions: toArray(parsed.options.next).map((item) => redactForRoot(root, item)),
      tags: toArray(parsed.options.tag)
    };
    const passport = startTask(root, optionValue(parsed.options, "risk")
      ? { ...startOptions, risk: taskRiskOption(parsed.options.risk) }
      : startOptions);
    process.stdout.write(`Started task ${passport.id}\n`);
    return;
  }

  if (subcommand === "list") {
    const tasks = listTasks(root);
    if (tasks.length === 0) {
      process.stdout.write("No task passports yet. Run `agentpack task start <title>`.\n");
      return;
    }

    process.stdout.write(`${tasks.map((task) => [
      task.current ? "*" : "-",
      task.id,
      `[${task.status}]`,
      task.title,
      task.branch ? `(branch: ${task.branch})` : ""
    ].filter(Boolean).join(" ")).join("\n")}\n`);
    return;
  }

  if (subcommand === "status") {
    process.stdout.write(`${redactForRoot(root, formatCurrentTaskStatus(root))}\n`);
    return;
  }

  if (subcommand === "update") {
    const parsed = parseArgs(args);
    const updateOptions: TaskUpdateOptions = {
      constraints: toArray(parsed.options.constraint).map((item) => redactForRoot(root, item)),
      writeScope: toArray(parsed.options["write-scope"]),
      nextActions: toArray(parsed.options.next).map((item) => redactForRoot(root, item)),
      tags: toArray(parsed.options.tag)
    };
    if (optionValue(parsed.options, "objective")) {
      updateOptions.objective = redactForRoot(root, stringOption(parsed.options.objective));
    }
    if (optionValue(parsed.options, "risk")) {
      updateOptions.risk = taskRiskOption(parsed.options.risk);
    }
    const passport = updateCurrentTaskPassport(root, updateOptions);
    process.stdout.write(`Updated task ${passport.id}\n`);
    return;
  }

  if (subcommand === "passport") {
    const parsed = parseArgs(args);
    const passport = parsed.positionals[0]
      ? readPassport(root, parsed.positionals[0])
      : getCurrentPassport(root);
    if (!passport) {
      throw new Error("No current task. Run `agentpack task start <title>` first.");
    }
    process.stdout.write(`${redactForRoot(root, JSON.stringify(passport, null, 2))}\n`);
    return;
  }

  if (subcommand === "switch") {
    const parsed = parseArgs(args);
    const taskId = parsed.positionals[0];
    if (!taskId) {
      throw new Error("task switch requires a task id");
    }
    const passport = switchTask(root, taskId);
    process.stdout.write(`Switched to task ${passport.id}\n`);
    return;
  }

  if (subcommand === "audit") {
    const report = auditCurrentTask(root, getSourceStatuses(root));
    process.stdout.write(`${formatTaskAuditReport(report)}\n`);
    return;
  }

  if (subcommand === "park") {
    const passport = parkCurrentTask(root);
    process.stdout.write(`Parked task ${passport.id}\n`);
    return;
  }

  if (subcommand === "block") {
    const parsed = parseArgs(args);
    const reason = redactForRoot(root, stringOption(parsed.options.reason) || parsed.positionals.join(" "));
    const passport = blockCurrentTask(root, reason);
    process.stdout.write(`Blocked task ${passport.id}\n`);
    return;
  }

  if (subcommand === "update-verification") {
    const parsed = parseArgs(args);
    const passport = updateCurrentTaskVerification(root, {
      status: stringOption(parsed.options.status),
      evidence: toArray(parsed.options.evidence),
      summary: redactForRoot(root, stringOption(parsed.options.summary))
    });
    process.stdout.write(`Updated verification for task ${passport.id} (${passport.verification.status})\n`);
    return;
  }

  if (subcommand === "close") {
    const passport = closeCurrentTask(root);
    process.stdout.write(`Closed task ${passport.id}\n`);
    return;
  }

  throw new Error("task command supports start, update, list, status, passport, switch, audit, park, block, update-verification, and close");
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

  if (subcommand === "remove") {
    const parsed = parseArgs(args);
    const filePath = parsed.positionals[0];
    if (!filePath) {
      throw new Error("source remove requires a file path");
    }

    const source = removeSourceRecord(root, filePath);
    process.stdout.write(`Removed source ${source.path}\n`);
    return;
  }

  if (subcommand === "prune") {
    const parsed = parseArgs(args);
    if (!parsed.options.missing) {
      throw new Error("source prune requires --missing");
    }

    const removed = pruneMissingSourceRecords(root);
    const label = removed.length === 1 ? "record" : "records";
    process.stdout.write(`Pruned ${removed.length} missing source ${label}\n`);
    if (removed.length > 0) {
      process.stdout.write(`${removed.map((source) => `- ${source.path}`).join("\n")}\n`);
    }
    return;
  }

  if (subcommand !== "add") {
    throw new Error("source command supports `add`, `remove`, `prune`, and `status`");
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

function optionValue(options: Record<string, ArgValue>, key: string): boolean {
  return options[key] !== undefined;
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

function taskRiskOption(value: ArgValue | undefined): "low" | "medium" | "high" | "unknown" {
  const risk = stringOption(value);
  if (risk === "unknown" || risk === "low" || risk === "medium" || risk === "high") {
    return risk;
  }
  throw new Error(`Unknown task risk: ${risk || "(empty)"}`);
}

function isRecordType(value: string | undefined): value is "decision" | "dead-end" | "note" {
  return value === "decision" || value === "dead-end" || value === "note";
}

function readPackageVersion(): string {
  // Resolve package.json relative to the compiled CLI file (dist/src/cli/index.js).
  // Works both in the source tree and after `npm install -g`, because the package
  // root is always three levels above this file.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
