import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPackPath, readJson } from "../core/store.js";

const INSTALL_TARGETS = ["codex", "claude", "cursor"] as const;

const INSTRUCTIONS = `# Agentpack

Use Agentpack as the task-state ledger for this repo.

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
        writeFilePlan(root, ".agentpack/instructions/codex-mcp.example.toml", "Write a Codex MCP config snippet for manual review.", codexTomlSnippet(root))
      ],
      notes: [
        "No global Codex config is modified.",
        `To enable MCP in Codex, review ${relativePath(root, codexSnippetPath)} and paste it into ~/.codex/config.toml.`
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

function upsertManagedBlock(existing: string, block: string): string {
  const marker = "<!-- agentpack:start -->";
  const endMarker = "<!-- agentpack:end -->";
  const wrapped = `${marker}\n${block.trim()}\n${endMarker}\n`;

  if (existing.includes(marker)) {
    return existing.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`), wrapped);
  }

  return `${existing.trimEnd()}\n\n${wrapped}`.trimStart();
}

function codexTomlSnippet(root: string): string {
  return [
    "# Add this to ~/.codex/config.toml after reviewing it.",
    "# Agentpack does not write global Codex configuration automatically.",
    "[mcp_servers.agentpack]",
    "command = \"agentpack\"",
    `args = ["mcp", "--root", ${tomlString(root)}]`,
    `cwd = ${tomlString(root)}`,
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
