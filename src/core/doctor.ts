import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getGitInfo } from "./git.js";
import { AGENTPACK_IGNORE_PATTERNS, findPackRoot, getPackPath, PACK_DIR } from "./store.js";
import { getSourceStatuses } from "../operations.js";

type CheckStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  status: CheckStatus;
  name: string;
  detail: string;
}

export function buildDoctorReport(startDir: string): { ok: boolean; text: string } {
  const checks: DoctorCheck[] = [];
  const root = findPackRoot(startDir);

  if (!root) {
    checks.push({
      status: "fail",
      name: "Pack",
      detail: "No .agentpack directory found. Run `agentpack init`."
    });
    return renderDoctor(checks);
  }

  checks.push({
    status: "ok",
    name: "Pack",
    detail: `.agentpack found at ${getPackPath(root)}`
  });

  for (const file of ["config.json", "state.json", "sources.json", "events.jsonl"]) {
    checks.push({
      status: existsSync(getPackPath(root, file)) ? "ok" : "fail",
      name: file,
      detail: existsSync(getPackPath(root, file)) ? "present" : "missing"
    });
  }

  checks.push(checkGitignore(root));
  checks.push(checkLocalIgnores(root));
  checks.push(checkProjectMcpConfig(root));
  checks.push(checkCodexConfig(root));
  checks.push(checkCursorConfig(root));
  checks.push(checkClaudeDesktopConfig(root));

  const git = getGitInfo(root);
  checks.push({
    status: git.available ? "ok" : "warn",
    name: "Git",
    detail: git.available ? `${git.branch || "unknown"} @ ${git.head || "unknown"}` : "not a git repository"
  });

  const sourceStatuses = getSourceStatuses(root);
  const changed = sourceStatuses.filter((source) => source.status === "changed").length;
  const missing = sourceStatuses.filter((source) => source.status === "missing").length;
  checks.push({
    status: changed || missing ? "warn" : "ok",
    name: "Sources",
    detail: formatSourceHealth(sourceStatuses.length, changed, missing)
  });

  checks.push({
    status: "ok",
    name: "Node",
    detail: process.version
  });

  return renderDoctor(checks);
}

function formatSourceHealth(recorded: number, changed: number, missing: number): string {
  const summary = `${recorded} recorded, ${changed} changed, ${missing} missing`;
  return changed || missing
    ? `${summary}; run \`agentpack source status --changed --missing\` for details`
    : summary;
}

function checkGitignore(root: string): DoctorCheck {
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return {
      status: "warn",
      name: ".gitignore",
      detail: "missing; .agentpack/ may be committed accidentally"
    };
  }

  const content = readFileSync(gitignorePath, "utf8");
  const ignored = content.split(/\r?\n/).map((line) => line.trim()).some((line) => {
    return line === `${PACK_DIR}/` || line === PACK_DIR;
  });

  return {
    status: ignored ? "ok" : "warn",
    name: ".gitignore",
    detail: ignored ? ".agentpack/ ignored" : ".agentpack/ is not ignored"
  };
}

function checkLocalIgnores(root: string): DoctorCheck {
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return {
      status: "warn",
      name: "Local ignores",
      detail: "missing .gitignore; local Agentpack integration files may be committed accidentally"
    };
  }

  const lines = readGitignoreLines(gitignorePath);
  const missing = AGENTPACK_IGNORE_PATTERNS.filter((pattern) => !hasIgnorePattern(lines, pattern));

  return {
    status: missing.length ? "warn" : "ok",
    name: "Local ignores",
    detail: missing.length
      ? `missing local-only ignore entries: ${missing.join(", ")}`
      : "Agentpack local files are ignored"
  };
}

function checkProjectMcpConfig(root: string): DoctorCheck {
  const mcpPath = path.join(root, ".mcp.json");
  if (!existsSync(mcpPath)) {
    return {
      status: "ok",
      name: "Project MCP",
      detail: "not installed"
    };
  }

  const parsed = readJson(mcpPath);
  if (!parsed.ok) {
    return {
      status: "fail",
      name: "Project MCP",
      detail: `.mcp.json is not valid JSON: ${parsed.error}`
    };
  }

  const mcpServers = getRecord(parsed.value, "mcpServers");
  if (!mcpServers) {
    return {
      status: "warn",
      name: "Project MCP",
      detail: ".mcp.json has no mcpServers object"
    };
  }

  const expectedName = getAgentpackServerName(root);
  const issues: string[] = [];

  if (expectedName !== "agentpack" && isRecord(mcpServers.agentpack)) {
    issues.push(`generic server key "agentpack" can collide across repos; use "${expectedName}"`);
  }

  if (!isRecord(mcpServers[expectedName])) {
    issues.push(`expected server key "${expectedName}" is missing`);
  }

  for (const [name, server] of Object.entries(mcpServers)) {
    if (!name.startsWith("agentpack") || !isRecord(server)) {
      continue;
    }

    const cwd = typeof server.cwd === "string" ? server.cwd : undefined;
    if (cwd && !samePath(cwd, root)) {
      issues.push(`${name} has stale cwd ${cwd}`);
    }

    const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
    const rootArg = readRootArg(args);
    if (rootArg && !samePath(rootArg, root)) {
      issues.push(`${name} has stale --root ${rootArg}`);
    }
  }

  return {
    status: issues.length ? "warn" : "ok",
    name: "Project MCP",
    detail: issues.length ? issues.join("; ") : `server key "${expectedName}" is scoped to this repo`
  };
}

function checkCodexConfig(root: string): DoctorCheck {
  const configPath = path.join(root, ".codex", "config.toml");
  if (!existsSync(configPath)) {
    return {
      status: "ok",
      name: "Codex MCP",
      detail: "not installed"
    };
  }

  const content = readFileSync(configPath, "utf8");
  const expectedName = getAgentpackServerName(root);
  const issues: string[] = [];

  if (expectedName !== "agentpack" && content.includes("[mcp_servers.agentpack]")) {
    issues.push(`generic server key "agentpack" can collide across repos; use "${expectedName}"`);
  }

  if (!content.includes(`[mcp_servers.${expectedName}]`)) {
    issues.push(`expected server key "${expectedName}" is missing`);
  }

  if (content.includes("--root")) {
    issues.push("project-local Codex config should not hard-code --root");
  }

  if (/^\s*cwd\s*=/m.test(content)) {
    issues.push("project-local Codex config should not hard-code cwd");
  }

  return {
    status: issues.length ? "warn" : "ok",
    name: "Codex MCP",
    detail: issues.length ? issues.join("; ") : `server key "${expectedName}" is scoped to this repo`
  };
}

function checkCursorConfig(root: string): DoctorCheck {
  const configPath = path.join(root, ".cursor", "mcp.json");
  if (!existsSync(configPath)) {
    return {
      status: "ok",
      name: "Cursor MCP",
      detail: "not installed"
    };
  }

  const parsed = readJson(configPath);
  if (!parsed.ok) {
    return {
      status: "fail",
      name: "Cursor MCP",
      detail: `.cursor/mcp.json is not valid JSON: ${parsed.error}`
    };
  }

  const mcpServers = getRecord(parsed.value, "mcpServers");
  if (!mcpServers) {
    return {
      status: "warn",
      name: "Cursor MCP",
      detail: ".cursor/mcp.json has no mcpServers object"
    };
  }

  const expectedName = getAgentpackServerName(root);
  const server = mcpServers[expectedName];
  const issues: string[] = [];

  if (expectedName !== "agentpack" && isRecord(mcpServers.agentpack)) {
    issues.push(`generic server key "agentpack" can collide across repos; use "${expectedName}"`);
  }

  if (!isRecord(server)) {
    issues.push(`expected server key "${expectedName}" is missing`);
  } else {
    const type = typeof server.type === "string" ? server.type : undefined;
    const command = typeof server.command === "string" ? server.command : undefined;
    const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];

    if (type && type !== "stdio") {
      issues.push(`${expectedName} should use type "stdio"`);
    }

    if (!command) {
      issues.push(`${expectedName} is missing command`);
    } else if (command === "agentpack") {
      issues.push(`${expectedName} uses command "agentpack"; Cursor GUI may not inherit your shell PATH, rerun \`agentpack install cursor --write\``);
    } else if (path.isAbsolute(command) && !existsSync(command)) {
      issues.push(`${expectedName} command does not exist: ${command}`);
    }

    if (!args.includes("mcp")) {
      issues.push(`${expectedName} args should include "mcp"`);
    }

    const entrypoint = args[0];
    if (entrypoint && path.isAbsolute(entrypoint) && !existsSync(entrypoint)) {
      issues.push(`${expectedName} Agentpack entrypoint does not exist: ${entrypoint}; rerun \`agentpack install cursor --write\``);
    }

    const rootArg = readRootArg(args);
    if (!rootArg) {
      issues.push(`${expectedName} should pass --root "\${workspaceFolder}"`);
    } else if (rootArg !== "${workspaceFolder}" && !samePath(rootArg, root)) {
      issues.push(`${expectedName} has stale --root ${rootArg}`);
    }
  }

  return {
    status: issues.length ? "warn" : "ok",
    name: "Cursor MCP",
    detail: issues.length
      ? issues.join("; ")
      : `server key "${expectedName}" configured; open this folder as the Cursor workspace and reload MCP tools`
  };
}

function checkClaudeDesktopConfig(root: string): DoctorCheck {
  const configPath = path.join(process.env.HOME || homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (!existsSync(configPath)) {
    return {
      status: "ok",
      name: "Claude Desktop",
      detail: "not configured"
    };
  }

  const parsed = readJson(configPath);
  if (!parsed.ok) {
    return {
      status: "warn",
      name: "Claude Desktop",
      detail: `config is not valid JSON: ${parsed.error}`
    };
  }

  const mcpServers = getRecord(parsed.value, "mcpServers");
  if (!mcpServers) {
    return {
      status: "warn",
      name: "Claude Desktop",
      detail: "config has no mcpServers; merge Agentpack snippets into the existing config instead of replacing it"
    };
  }

  const agentpackServers = Object.entries(mcpServers).filter(([name]) => name.startsWith("agentpack"));
  if (!agentpackServers.length) {
    return {
      status: "ok",
      name: "Claude Desktop",
      detail: "no Agentpack Desktop servers configured"
    };
  }

  const roots = agentpackServers
    .map(([name, server]) => [name, readConfiguredRoot(server)] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string");
  const currentRootServers = roots.filter(([, configuredRoot]) => samePath(configuredRoot, root));
  const hasCurrentRoot = currentRootServers.length > 0;
  const issues = agentpackServers.flatMap(([name, server]) => claudeDesktopServerIssues(name, server));

  if (!hasCurrentRoot) {
    issues.push(`no Claude Desktop Agentpack server points at this repo; only fix this if you expect Claude Desktop to use this repo. Existing Agentpack Desktop roots: ${roots.map(([name, configuredRoot]) => `${name}=${configuredRoot}`).join(", ") || "no root configured"}`);
  }

  return {
    status: issues.length ? "warn" : "ok",
    name: "Claude Desktop",
    detail: issues.length ? issues.join("; ") : claudeDesktopOkDetail(currentRootServers, agentpackServers.length)
  };
}

function claudeDesktopOkDetail(currentRootServers: readonly (readonly [string, string])[], serverCount: number): string {
  const serverNames = currentRootServers.map(([name]) => `"${name}"`).join(", ");
  const base = currentRootServers.length === 1
    ? `server key ${serverNames} points at this pack root`
    : `server keys ${serverNames} point at this pack root`;

  return serverCount > currentRootServers.length
    ? `${base}; Claude Desktop also has other Agentpack servers, so use the repo-specific server/tool group for this repo`
    : base;
}

function claudeDesktopServerIssues(name: string, server: unknown): string[] {
  if (!isRecord(server)) {
    return [`${name} server config is not an object`];
  }

  const issues: string[] = [];
  const command = typeof server.command === "string" ? server.command : undefined;
  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];

  if (!command) {
    issues.push(`${name} is missing command`);
  } else if (command === "agentpack") {
    issues.push(`${name} uses command "agentpack"; Claude Desktop may not inherit your shell PATH, rerun \`agentpack install claude-desktop --write\``);
  } else if (path.isAbsolute(command) && !existsSync(command)) {
    issues.push(`${name} command does not exist: ${command}`);
  }

  if (!args.includes("mcp")) {
    issues.push(`${name} args should include "mcp"`);
  }

  if (command && command !== "agentpack") {
    const entrypoint = args[0];
    if (!entrypoint || entrypoint === "mcp") {
      issues.push(`${name} should pass an absolute Agentpack entrypoint before "mcp"; rerun \`agentpack install claude-desktop --write\``);
    } else if (!path.isAbsolute(entrypoint)) {
      issues.push(`${name} Agentpack entrypoint should be absolute: ${entrypoint}; rerun \`agentpack install claude-desktop --write\``);
    } else if (!existsSync(entrypoint)) {
      issues.push(`${name} Agentpack entrypoint does not exist: ${entrypoint}; rerun \`agentpack install claude-desktop --write\``);
    }
  }

  return issues;
}

function readGitignoreLines(gitignorePath: string): string[] {
  return readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function hasIgnorePattern(lines: string[], pattern: string): boolean {
  const normalized = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  return lines.some((line) => {
    const normalizedLine = line.endsWith("/") ? line.slice(0, -1) : line;
    return normalizedLine === normalized;
  });
}

function getAgentpackServerName(root: string): string {
  const slug = path.basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "agentpack" ? "agentpack" : `agentpack-${slug || "repo"}`;
}

function readJson(filePath: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      value: JSON.parse(readFileSync(filePath, "utf8"))
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readConfiguredRoot(server: unknown): string | undefined {
  if (!isRecord(server)) {
    return undefined;
  }

  const env = getRecord(server, "env");
  if (typeof env?.AGENTPACK_ROOT === "string") {
    return env.AGENTPACK_ROOT;
  }

  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
  return readRootArg(args);
}

function readRootArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--root") {
      return args[index + 1];
    }
    if (arg.startsWith("--root=")) {
      return arg.slice("--root=".length);
    }
  }

  return undefined;
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function renderDoctor(checks: DoctorCheck[]): { ok: boolean; text: string } {
  const ok = checks.every((check) => check.status !== "fail");
  const text = [
    "Agentpack doctor",
    "",
    ...checks.map((check) => `[${check.status}] ${check.name}: ${check.detail}`)
  ].join("\n");

  return { ok, text };
}
