import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPackPath, readJson } from "../core/store.js";

const INSTALL_TARGETS = ["codex", "claude", "claude-desktop", "cursor"] as const;

const INSTRUCTIONS = `# Agentpack

Use Agentpack as the task-state ledger for this repo.
Agentpack is not an activity logger; do not record every thought, file read, or edit.

At the start of a task:
- call \`load_context\` with a small preset first
- call \`source_status\` before re-reading previously inspected files

During work:
- call \`record_source\` after inspecting an important file, with a concise conclusion
- call \`record_decision\` for durable technical/product decisions
- call \`record_dead_end\` when an approach failed and should not be repeated
- call \`attach_evidence\` for useful test output, command output, or verification notes

Default cadence:
- start with Agentpack context
- work locally without recording every micro-step
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

  if (target === "codex") {
    const codexSnippetPath = getPackPath(root, "instructions", "codex-mcp.example.toml");
    return {
      target,
      files: [
        writeFilePlan(root, ".agentpack/instructions/codex.md", "Write Codex-specific Agentpack workflow instructions.", INSTRUCTIONS),
        managedBlockPlan(root, "AGENTS.md", "Add or update the Agentpack block in AGENTS.md.", INSTRUCTIONS),
        tomlTablePlan(root, ".codex/config.toml", "Add the Agentpack MCP server to project-local Codex config.", "mcp_servers.agentpack", codexMcpTomlTable()),
        writeFilePlan(root, ".agentpack/instructions/codex-mcp.example.toml", "Write a Codex MCP config snippet for manual review.", codexTomlSnippet())
      ],
      notes: [
        "No global Codex config is modified.",
        "Codex should use the project-local .codex/config.toml entry for this repo.",
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
        jsonMergePlan(root, ".mcp.json", "Add the Agentpack MCP server to project .mcp.json.", claudeMcpServer())
      ],
      notes: [
        "Only project-local files are modified.",
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
          claudeDesktopInstructions(root, desktopSnippetPath)
        ),
        writeFilePlan(
          root,
          ".agentpack/instructions/claude-desktop-mcp.example.json",
          "Write a Claude Desktop MCP config snippet for manual review.",
          claudeDesktopJsonSnippet(root)
        )
      ],
      notes: [
        "No Claude Desktop global config is modified.",
        "Claude Desktop does not read project .mcp.json or CLAUDE.md.",
        `To enable local MCP in Claude Desktop manually, review ${relativePath(root, desktopSnippetPath)} and merge it into ~/Library/Application Support/Claude/claude_desktop_config.json on macOS.`
      ]
    };
  }

  return {
    target,
    files: [
      writeFilePlan(root, ".agentpack/instructions/cursor.md", "Write Cursor-specific Agentpack workflow instructions.", INSTRUCTIONS),
      writeFilePlan(root, ".cursor/rules/agentpack.mdc", "Write a Cursor project rule for Agentpack.", INSTRUCTIONS),
      jsonMergePlan(root, ".cursor/mcp.json", "Add the Agentpack MCP server to Cursor project MCP config.", cursorMcpServer())
    ],
    notes: [
      "Only project-local files are modified.",
      "Cursor reads project-specific MCP servers from .cursor/mcp.json."
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

function jsonMergePlan(root: string, relativeFilePath: string, description: string, server: Record<string, unknown>): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = readJson<McpConfig>(filePath, {});
  const mcpServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  const next = {
    ...existing,
    mcpServers: {
      ...mcpServers,
      agentpack: server
    }
  };

  return {
    filePath,
    description,
    content: `${JSON.stringify(next, null, 2)}\n`
  };
}

function tomlTablePlan(root: string, relativeFilePath: string, description: string, tableName: string, tableBody: string): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  return {
    filePath,
    description,
    content: upsertTomlTable(existing, tableName, tableBody)
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

function codexTomlSnippet(): string {
  return [
    "# Add this to the repo's .codex/config.toml after reviewing it.",
    "# Do not put a project-specific --root or cwd in ~/.codex/config.toml.",
    "# A hard-coded global root makes Agentpack read the wrong repo.",
    codexMcpTomlTable(),
    ""
  ].join("\n");
}

function codexMcpTomlTable(): string {
  return [
    "[mcp_servers.agentpack]",
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
    command: "agentpack",
    args: ["mcp"],
    env: {
      AGENTPACK_ROOT: root
    }
  };
}

function claudeDesktopJsonSnippet(root: string): string {
  return JSON.stringify({
    mcpServers: {
      agentpack: claudeDesktopMcpServer(root)
    }
  }, null, 2);
}

function claudeDesktopInstructions(root: string, snippetPath: string): string {
  return [
    "# Agentpack for Claude Desktop",
    "",
    "Claude Desktop does not read project-local `.mcp.json` or `CLAUDE.md`.",
    "Use Claude Code's `.mcp.json` for Claude Code only.",
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
    "If it already exists, merge only the `mcpServers.agentpack` entry into the existing JSON.",
    "",
    "After editing the Claude Desktop config, restart Claude Desktop.",
    "",
    "If Claude Desktop cannot find `agentpack`, replace the `command` value with an absolute executable path.",
    "Keep the `AGENTPACK_ROOT` env value pointed at the project whose `.agentpack/` state you want Claude Desktop to use.",
    "When switching Claude Desktop to another repo, update the global `mcpServers.agentpack.env.AGENTPACK_ROOT` value and restart Claude Desktop."
  ].join("\n");
}

function cursorMcpServer(): Record<string, unknown> {
  return {
    type: "stdio",
    command: "agentpack",
    args: ["mcp", "--root", "${workspaceFolder}"]
  };
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
