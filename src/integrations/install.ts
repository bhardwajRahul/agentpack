import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPackPath, readJson, writeJson } from "../core/store.js";

const INSTRUCTIONS = `# Agentpack

Use Agentpack to preserve task state for future AI coding agents.

When you make meaningful progress, call Agentpack tools or CLI commands to record:
- current status and next actions
- decisions and their evidence
- dead ends and failed approaches
- files inspected, with conclusions and hashes
- test outputs and relevant command results

Before re-reading a file, check Agentpack source cache. If a source is marked unchanged and has a clear conclusion, rely on the recorded conclusion unless the task requires fresh inspection.
`;

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function installIntegration(root: string, target: string): string {
  if (!["codex", "claude", "cursor"].includes(target)) {
    throw new Error(`Unknown install target: ${target}`);
  }

  mkdirSync(getPackPath(root, "instructions"), { recursive: true });

  if (target === "codex") {
    writeFileSync(getPackPath(root, "instructions", "codex.md"), INSTRUCTIONS, "utf8");
    appendBlock(path.join(root, "AGENTS.md"), INSTRUCTIONS);
    writeFileSync(
      getPackPath(root, "instructions", "codex-mcp.example.toml"),
      [
        "[mcp_servers.agentpack]",
        "command = \"agentpack\"",
        "args = [\"mcp\"]",
        ""
      ].join("\n"),
      "utf8"
    );
    return "Installed Agentpack project instructions for Codex. MCP config example written to .agentpack/instructions/codex-mcp.example.toml.";
  }

  if (target === "claude") {
    writeFileSync(getPackPath(root, "instructions", "claude.md"), INSTRUCTIONS, "utf8");
    appendBlock(path.join(root, "CLAUDE.md"), INSTRUCTIONS);
    mergeMcpJson(path.join(root, ".mcp.json"));
    return "Installed Agentpack project instructions for Claude and updated .mcp.json.";
  }

  mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
  mkdirSync(path.join(root, ".cursor"), { recursive: true });
  writeFileSync(path.join(root, ".cursor", "rules", "agentpack.mdc"), INSTRUCTIONS, "utf8");
  mergeMcpJson(path.join(root, ".cursor", "mcp.json"));
  return "Installed Agentpack Cursor rule and updated .cursor/mcp.json.";
}

function appendBlock(filePath: string, block: string): void {
  const marker = "<!-- agentpack:start -->";
  const endMarker = "<!-- agentpack:end -->";
  const wrapped = `${marker}\n${block.trim()}\n${endMarker}\n`;
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";

  if (existing.includes(marker)) {
    const next = existing.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`), wrapped);
    writeFileSync(filePath, next, "utf8");
    return;
  }

  writeFileSync(filePath, `${existing.trimEnd()}\n\n${wrapped}`.trimStart(), "utf8");
}

function mergeMcpJson(filePath: string): void {
  const existing = readJson<McpConfig>(filePath, {});
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      agentpack: {
        command: "agentpack",
        args: ["mcp"]
      }
    }
  };
  writeJson(filePath, next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
