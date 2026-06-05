import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackPath, readJson } from "../core/store.js";

const INSTALL_TARGETS = ["codex", "claude", "claude-desktop", "cursor"] as const;

function collaborationModesSection(): string {
  return `Collaboration modes:
- treat named modes as explicit collaboration preferences; follow the active mode until the user switches mode, asks for work that clearly implies another mode, the task ends, or safety requires a pause
- design mode: do not write code; analyze the task, architecture, options, risks, and verification plan
- implementation mode: implement the agreed direction in small, reviewable steps
- review mode: review the current diff or proposal for bugs, regressions, missing tests, and design risks
- teach mode: explain TypeScript, architecture, or code through the concrete files and changes at hand
- checkpoint mode: summarize what was decided, what changed, why, verification status, and next actions`;
}

const INSTRUCTIONS = `# Agentpack

Use Agentpack as the task-state ledger for this repo.
Agentpack is not an activity logger; do not record every thought, file read, or edit.

Safety invariant:
- preserve existing functionality; do not make changes that knowingly break current behavior
- make changes carefully, with compatibility and rollback impact in mind
- verify meaningful changes with focused tests, smoke checks, or documented reasoning before handing off
- if a requested change risks a regression, call out the risk and choose the safer path unless explicitly directed otherwise

Coding defaults:
- read the relevant code before changing it, then follow existing project patterns and helper APIs
- keep changes small, focused, and reviewable; avoid unrelated refactors, formatting churn, dependency changes, or generated-file noise
- prefer clear, boring code over clever abstractions; add abstractions only when they remove real complexity or match an established local pattern
- treat security as a default: do not log secrets, weaken auth or validation, add unsafe shell execution, or broaden permissions without a clear reason
- run the narrowest meaningful verification first, then broader checks when the risk or blast radius warrants it

Git and PR hygiene:
- use concise imperative commit messages, for example \`Add release preflight check\`
- do not add AI or agent prefixes, model names, \`Co-authored-by\`, or AI attribution to commits, PR titles, PR bodies, release notes, or branch names
- avoid branch names with AI or agent-style prefixes such as \`claude/\`, \`codex/\`, \`ai/\`, or \`agent/\`
- keep commits logically small; separate docs, tests, feature changes, and release prep when practical
- before staging or committing, inspect the diff and avoid including unrelated user changes

Focused skills/rules:
- when the client supports skills, rules, or sub-instructions, keep coding workflow, git hygiene, secure coding review, and frontend QA as focused opt-in guidance rather than expanding the always-on project instructions

${collaborationModesSection()}

At the start of a task:
- call \`load_context\` with a small preset first
- call \`source_status\` only when you need a full stale-source check beyond the context you just loaded

Task lifecycle gate:
- before implementation, confirm the current Task Passport is the right active task for this phase and branch
- if the current task is verifying, blocked, closed, or has unexplained branch/head drift, stop and resolve it before editing code
- park deferred work with \`task_park\`/\`task park\`, or switch/close only when appropriate, before starting unrelated work
- do not finalize a task just to free the current slot; finalization means verification is passed, failed, or explicitly accepted as complete
- if a task still has next actions and must pause for unrelated work, park it instead of using \`task_finalize\`/\`task finalize --status accepted\`; force accepted finalization only when the remaining next actions are intentionally historical
- do not mutate a review task into implementation work
- keep one active task per coherent phase: review, stabilization, rewrite, deployment

During work:
- call \`record_source\` only when you have a durable conclusion about an important file; avoid repeated records for the same file unless the conclusion changed
- call \`record_decision\` for durable technical/product decisions, not every preference
- call \`record_dead_end\` when an approach failed and should not be repeated
- call \`attach_evidence\` for meaningful verification, review findings, or command output worth preserving

Avoid turning Agentpack into an activity log:
- do not record every file read, mode switch, minor diff check, or routine command
- do not call \`source_status\` repeatedly when \`load_context\`, \`task_audit\`, or a recent status check already answered the question
- do not call \`record_source\` for every changed file just to make an audit warning disappear; prefer a checkpoint summary for batch changes and refresh source records only when the durable conclusion changed
- for small tasks, prefer one aggregated verification evidence and one checkpoint; add source records only for important implementation files with reusable conclusions
- for small verified slices, attach one evidence item for the meaningful verification result
- link that evidence from \`task_update_verification\`, or from \`task_finalize\` when finalize performs the verification update
- mention commit hashes in checkpoint/finalize summaries instead of attaching separate commit evidence
- attach separate commit, tag, workflow, or publish evidence only when that output is itself part of the verification contract

Default cadence:
- start with Agentpack context
- work locally without recording every micro-step
- sequence state-changing Agentpack calls; do not run them in parallel with audit/status/checkpoint calls
- record durable findings and evidence before a checkpoint
- use full safe mode for risky or release-like changes

Before re-reading an unchanged source file, prefer the recorded source conclusion unless the task requires fresh inspection.

After meaningful progress, call \`checkpoint\` with:
- summary
- current status
- next actions
`;

type InstallTarget = typeof INSTALL_TARGETS[number];

interface InstallOptions {
  dryRun?: boolean;
}

interface InstallFile {
  filePath: string;
  description: string;
  content: string;
}

interface InstallPlan {
  target: InstallTarget;
  files: InstallFile[];
  notes: string[];
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function installIntegration(root: string, targetValue: string, options: InstallOptions = {}): string {
  const target = parseTarget(targetValue);
  const dryRun = options.dryRun !== false;
  const plan = buildInstallPlan(root, target);
  const statuses = plan.files.map((file) => ({
    file,
    status: fileStatus(file.filePath, file.content)
  }));

  if (!dryRun) {
    applyPlan(plan);
  }

  return formatInstallResult(root, plan, statuses, dryRun);
}

function buildInstallPlan(root: string, target: InstallTarget): InstallPlan {
  mkdirSync(getPackPath(root, "instructions"), { recursive: true });
  const serverName = mcpServerName(root);

  if (target === "codex") {
    const codexSnippetPath = getPackPath(root, "instructions", "codex-mcp.example.toml");
    return {
      target,
      files: [
        writeFilePlan(root, ".agentpack/instructions/codex.md", "Write Codex-specific Agentpack workflow instructions.", INSTRUCTIONS),
        managedBlockPlan(root, "AGENTS.md", "Add or update the Agentpack block in AGENTS.md.", INSTRUCTIONS),
        tomlTablePlan(root, ".codex/config.toml", "Add the Agentpack MCP server to project-local Codex config.", `mcp_servers.${serverName}`, codexMcpTomlTable(serverName), "mcp_servers.agentpack"),
        writeFilePlan(root, ".agentpack/instructions/codex-mcp.example.toml", "Write a Codex MCP config snippet for manual review.", codexTomlSnippet(serverName))
      ],
      notes: [
        "No global Codex config is modified.",
        `Codex should use the project-local .codex/config.toml entry named ${serverName} for this repo.`,
        "Remove any old ~/.codex/config.toml agentpack server that hard-codes --root or cwd to another project.",
        `For manual review, see ${relativePath(root, codexSnippetPath)}.`
      ]
    };
  }

  if (target === "claude") {
    return {
      target,
      files: [
        writeFilePlan(root, ".agentpack/instructions/claude.md", "Write Claude-specific Agentpack workflow instructions.", INSTRUCTIONS),
        managedBlockPlan(root, "CLAUDE.md", "Add or update the Agentpack block in CLAUDE.md.", INSTRUCTIONS),
        jsonMergePlan(root, ".mcp.json", "Add the Agentpack MCP server to project .mcp.json.", serverName, claudeMcpServer())
      ],
      notes: [
        "Only project-local files are modified.",
        `The Claude Code MCP server key is ${serverName} to avoid cross-repo name collisions.`,
        "Claude Code prompts before using project-scoped MCP servers from .mcp.json."
      ]
    };
  }

  if (target === "claude-desktop") {
    const desktopSnippetPath = getPackPath(root, "instructions", "claude-desktop-mcp.example.json");
    return {
      target,
      files: [
        writeFilePlan(
          root,
          ".agentpack/instructions/claude-desktop.md",
          "Write Claude Desktop-specific Agentpack setup notes.",
          claudeDesktopInstructions(root, desktopSnippetPath, serverName)
        ),
        writeFilePlan(
          root,
          ".agentpack/instructions/claude-desktop-mcp.example.json",
          "Write a Claude Desktop MCP config snippet for manual review.",
          claudeDesktopJsonSnippet(root, serverName)
        )
      ],
      notes: [
        "No Claude Desktop global config is modified.",
        "Claude Desktop does not read project .mcp.json or CLAUDE.md.",
        `The generated Claude Desktop server key for this repo is ${serverName}.`,
        `To enable local MCP in Claude Desktop manually, review ${relativePath(root, desktopSnippetPath)} and merge it into ~/Library/Application Support/Claude/claude_desktop_config.json on macOS.`
      ]
    };
  }

  return {
    target,
    files: [
      writeFilePlan(root, ".agentpack/instructions/cursor.md", "Write Cursor-specific Agentpack workflow instructions.", cursorInstructions()),
      writeFilePlan(root, ".cursor/rules/agentpack.mdc", "Write a Cursor project rule for Agentpack.", cursorInstructions()),
      jsonMergePlan(root, ".cursor/mcp.json", "Add the Agentpack MCP server to Cursor project MCP config.", serverName, cursorMcpServer())
    ],
    notes: [
      "Only project-local files are modified.",
      "Cursor reads project-specific MCP servers from .cursor/mcp.json when this folder is opened as the workspace.",
      "After writing the config, reload the Cursor window, open MCP Servers, and enable the Agentpack server if it is toggled off.",
      "The Cursor MCP entry uses an absolute Node launcher so Cursor does not depend on your shell/fnm/nvm PATH."
    ]
  };
}

function applyPlan(plan: InstallPlan): void {
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.filePath), { recursive: true });
    if (existsSync(file.filePath) && readFileSync(file.filePath, "utf8") === file.content) {
      continue;
    }
    writeFileSync(file.filePath, file.content, "utf8");
  }
}

function formatInstallResult(root: string, plan: InstallPlan, statuses: Array<{ file: InstallFile; status: string }>, dryRun: boolean): string {
  const lines = [
    dryRun
      ? `Agentpack ${plan.target} install plan (dry run)`
      : `Installed Agentpack ${plan.target} integration`,
    dryRun ? "No files were changed." : "Files written:",
    "",
    ...statuses.map(({ file, status }) => `- ${status.toUpperCase()} ${relativePath(root, file.filePath)}: ${file.description}`),
    "",
    "Notes:",
    ...plan.notes.map((note) => `- ${note}`)
  ];

  if (dryRun) {
    lines.push("", "To apply:", `  agentpack install ${plan.target} --write`);
  }

  return lines.join("\n");
}

function writeFilePlan(root: string, relativeFilePath: string, description: string, content: string): InstallFile {
  return {
    filePath: path.join(root, relativeFilePath),
    description,
    content: ensureTrailingNewline(content)
  };
}

function managedBlockPlan(root: string, relativeFilePath: string, description: string, block: string): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  return {
    filePath,
    description,
    content: upsertManagedBlock(existing, block)
  };
}

function jsonMergePlan(root: string, relativeFilePath: string, description: string, serverName: string, server: Record<string, unknown>): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = readJson<McpConfig>(filePath, {});
  const mcpServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  const nextMcpServers = {
    ...mcpServers,
    [serverName]: server
  };

  if (serverName !== "agentpack" && JSON.stringify(mcpServers.agentpack) === JSON.stringify(server)) {
    delete nextMcpServers.agentpack;
  }

  const next = {
    ...existing,
    mcpServers: nextMcpServers
  };

  return {
    filePath,
    description,
    content: `${JSON.stringify(next, null, 2)}\n`
  };
}

function tomlTablePlan(root: string, relativeFilePath: string, description: string, tableName: string, tableBody: string, legacyTableName?: string): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const withoutLegacy = legacyTableName && legacyTableName !== tableName
    ? removeTomlTable(existing, legacyTableName)
    : existing;
  return {
    filePath,
    description,
    content: upsertTomlTable(withoutLegacy, tableName, tableBody)
  };
}

function upsertManagedBlock(existing: string, block: string): string {
  const marker = "<!-- agentpack:start -->";
  const endMarker = "<!-- agentpack:end -->";
  const wrapped = `${marker}\n${block.trim()}\n${endMarker}\n`;

  if (existing.includes(marker)) {
    return existing.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`), wrapped);
  }

  return `${existing.trimEnd()}\n\n${wrapped}`.trimStart();
}

function upsertTomlTable(existing: string, tableName: string, tableBody: string): string {
  const tableHeader = `[${tableName}]`;
  const lines = existing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === tableHeader);
  const bodyLines = tableBody.trimEnd().split("\n");

  if (start === -1) {
    const prefix = existing.trimEnd();
    return ensureTrailingNewline(prefix ? `${prefix}\n\n${tableBody}` : tableBody);
  }

  let end = start + 1;
  const nestedPrefix = `[${tableName}.`;
  while (end < lines.length) {
    const trimmed = (lines[end] || "").trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]") && !trimmed.startsWith(nestedPrefix)) {
      break;
    }
    end += 1;
  }

  lines.splice(start, end - start, ...bodyLines);
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

function removeTomlTable(existing: string, tableName: string): string {
  const tableHeader = `[${tableName}]`;
  const lines = existing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === tableHeader);

  if (start === -1) {
    return existing;
  }

  let end = start + 1;
  const nestedPrefix = `[${tableName}.`;
  while (end < lines.length) {
    const trimmed = (lines[end] || "").trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]") && !trimmed.startsWith(nestedPrefix)) {
      break;
    }
    end += 1;
  }

  lines.splice(start, end - start);
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

function codexTomlSnippet(serverName: string): string {
  return [
    "# Add this to the repo's .codex/config.toml after reviewing it.",
    "# Do not put a project-specific --root or cwd in ~/.codex/config.toml.",
    "# A hard-coded global root makes Agentpack read the wrong repo.",
    codexMcpTomlTable(serverName),
    ""
  ].join("\n");
}

function codexMcpTomlTable(serverName: string): string {
  return [
    `[mcp_servers.${serverName}]`,
    "command = \"agentpack\"",
    "args = [\"mcp\"]",
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 60",
    ""
  ].join("\n");
}

function claudeMcpServer(): Record<string, unknown> {
  return {
    type: "stdio",
    command: "agentpack",
    args: ["mcp"]
  };
}

function claudeDesktopMcpServer(root: string): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [agentpackEntrypoint(), "mcp", "--root", root],
    env: {
      AGENTPACK_ROOT: root
    }
  };
}

function claudeDesktopJsonSnippet(root: string, serverName: string): string {
  return JSON.stringify({
    mcpServers: {
      [serverName]: claudeDesktopMcpServer(root)
    }
  }, null, 2);
}

function claudeDesktopInstructions(root: string, snippetPath: string, serverName: string): string {
  return [
    "# Agentpack for Claude Desktop",
    "",
    "Claude Desktop does not read project-local `.mcp.json` or `CLAUDE.md`.",
    "Use Claude Code's `.mcp.json` for Claude Code only.",
    "",
    `Generated server key for this repo: \`${serverName}\`.`,
    "If Claude Desktop has several Agentpack servers, use the server/tool group with this repo-specific key for this repo.",
    "",
    "For Claude Desktop local MCP, prefer Desktop Extensions/MCP bundles when Agentpack ships one.",
    "Until then, review the generated JSON snippet and merge it into your Claude Desktop config manually.",
    "Do not copy the generated snippet over the Desktop config file; that can delete existing MCP servers.",
    "",
    "macOS config path:",
    "",
    "```text",
    "~/Library/Application Support/Claude/claude_desktop_config.json",
    "```",
    "",
    "Generated snippet:",
    "",
    "```text",
    relativePath(root, snippetPath),
    "```",
    "",
    "Safe manual flow:",
    "",
    "```bash",
    "agentpack install claude-desktop --write",
    "cat .agentpack/instructions/claude-desktop-mcp.example.json",
    "mkdir -p \"$HOME/Library/Application Support/Claude\"",
    "open -e \"$HOME/Library/Application Support/Claude/claude_desktop_config.json\"",
    "```",
    "",
    "If the config file does not exist yet, create it with the generated snippet content.",
    `If it already exists, merge only the generated \`mcpServers.${serverName}\` entry into the existing JSON.`,
    "",
    "After editing the Claude Desktop config, restart Claude Desktop.",
    "",
    "The generated snippet launches Agentpack through the current Node executable and Agentpack entrypoint, rather than relying on `agentpack` being available in Claude Desktop's GUI `PATH`.",
    "If Claude Desktop reports that the MCP server disconnected or cannot start, rerun `agentpack install claude-desktop --write`, merge the refreshed snippet, then restart Claude Desktop.",
    "Keep both the `--root` argument and `AGENTPACK_ROOT` env value pointed at the project whose `.agentpack/` state you want Claude Desktop to use.",
    `When switching this Claude Desktop server to another repo, update both \`mcpServers.${serverName}.args\` \`--root\` and \`mcpServers.${serverName}.env.AGENTPACK_ROOT\`, then restart Claude Desktop.`
  ].join("\n");
}

function cursorInstructions(): string {
  return [
    INSTRUCTIONS.trimEnd(),
    "",
    "Cursor-specific notes:",
    "- Project MCP only applies when Cursor opens this folder as the workspace root.",
    "- After `agentpack install cursor --write`, reload the Cursor window so `.cursor/mcp.json` is re-read.",
    "- In Cursor, open MCP Servers and enable the `agentpack` server if it appears toggled off.",
    "- If Agentpack MCP tools are not visible in Cursor, run `agentpack doctor` and check Cursor's MCP/server logs.",
    "- If MCP is unavailable, use the CLI equivalents: `agentpack resume --preset agent`, `agentpack source status`, and `agentpack checkpoint ...`."
  ].join("\n");
}

function cursorMcpServer(): Record<string, unknown> {
  return {
    type: "stdio",
    command: process.execPath,
    args: [agentpackEntrypoint(), "mcp", "--root", "${workspaceFolder}"]
  };
}

function agentpackEntrypoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agentpack.js");
}

function mcpServerName(root: string): string {
  const projectName = path.basename(root);
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!slug || slug === "agentpack") {
    return "agentpack";
  }

  return `agentpack-${slug}`;
}

function parseTarget(target: string): InstallTarget {
  if (INSTALL_TARGETS.includes(target as InstallTarget)) {
    return target as InstallTarget;
  }
  throw new Error(`Unknown install target: ${target}`);
}

function fileStatus(filePath: string, content: string): string {
  if (!existsSync(filePath)) {
    return "create";
  }
  return readFileSync(filePath, "utf8") === content ? "unchanged" : "update";
}

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath) || ".";
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
