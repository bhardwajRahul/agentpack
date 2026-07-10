import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGitHooksPath, getGitRepoBounds } from "../core/git.js";
import { getPackPath, readJson } from "../core/store.js";

const INSTALL_TARGETS = ["codex", "claude", "claude-desktop", "cursor", "git-hooks"] as const;
const GATE_HOOK_MARKER = "# agentpack:gate";
const GATE_ROOT_MARKER = "# agentpack:root-base64 ";
const CLAUDE_GATE_MARKER = "task gate --client claude";
const CODEX_GATE_MARKER = "task gate --client codex";
const CURSOR_GATE_MARKER = "task gate --client cursor";

export function formatClientGateCommand(
  execPath: string,
  entrypoint: string,
  client: "claude" | "codex" | "cursor",
  platform: "posix" | "win32"
): string {
  const quote = platform === "win32" ? windowsCommandQuote : shellQuote;
  return `${quote(execPath)} ${quote(entrypoint)} task gate --client ${client}`;
}

function clientGateCommand(client: "claude" | "codex" | "cursor"): string {
  return formatClientGateCommand(
    process.execPath,
    agentpackEntrypoint(),
    client,
    process.platform === "win32" ? "win32" : "posix"
  );
}

function codexGateCommand(platform: "posix" | "win32"): string {
  return formatClientGateCommand(process.execPath, agentpackEntrypoint(), "codex", platform);
}

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
- call \`load_context\` with \`preset: "quick"\` and a focused query for the current task first
- call \`source_status\` only when you need a full stale-source check beyond the context you just loaded

Task lifecycle gate:
- before implementation, confirm the current Task Passport is the right active task for this phase and branch
- declare a write scope when starting a task (\`task_start\`/\`task start --write-scope <path>\`), so the task gate can protect its boundaries; a repo-wide task can still start without one, but scope should be the default, not an afterthought
- if the current task is verifying, blocked, closed, or has unexplained branch/head drift, stop and resolve it before editing code
- treat review mode as a scope check, not an automatic new Task Passport: keep reviews that verify the current active/verifying task inside that task as evidence/checkpoint; park, switch, or start a separate review task only for unrelated reviews
- park deferred work with \`task_park\`/\`task park\`, or switch/close only when appropriate, before starting unrelated work
- do not finalize a task just to free the current slot; finalization means verification is passed, failed, or explicitly accepted as complete
- verification order: iterate checks with verification pending and fix freely; when no edits remain, commit the in-scope changes and confirm the commit changed nothing (clean tree, hooks silent) before recording the final verdict
- no external wait: end with one \`task_finalize\` call carrying the final status, evidence, and commit hash, so no verifying window opens
- external wait (review, PR merge, re-score): record \`passed\` via \`task_update_verification\`, then \`task_park\`; switching back keeps the task verifying while that final verdict is frozen, so finalize after the external result or set verification to pending before making changes
- a recorded final verdict moves the task to verifying and freezes code changes; to commit already-verified changes from there, set verification back to pending, commit, then re-record the verdict
- keep next actions current: clear or replace a stale plan (\`task update --clear-next-actions\`) before finalizing, so closed passports read as history, not as open work
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
  executable?: boolean;
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
  validateInstallPlan(root, plan);
  const statuses = plan.files.map((file) => ({
    file,
    status: fileStatus(file.filePath, file.content)
  }));

  if (!dryRun) {
    applyPlan(root, plan);
  }

  return formatInstallResult(root, plan, statuses, dryRun);
}

function buildInstallPlan(root: string, target: InstallTarget): InstallPlan {
  const serverName = mcpServerName(root);

  if (target === "codex") {
    const codexSnippetPath = getPackPath(root, "instructions", "codex-mcp.example.toml");
    return {
      target,
      files: [
        writeFilePlan(root, ".agentpack/instructions/codex.md", "Write Codex-specific Agentpack workflow instructions.", INSTRUCTIONS),
        managedBlockPlan(root, "AGENTS.md", "Add or update the Agentpack block in AGENTS.md.", INSTRUCTIONS),
        tomlTablePlan(root, ".codex/config.toml", "Add the Agentpack MCP server to project-local Codex config.", `mcp_servers.${serverName}`, codexMcpTomlTable(serverName), "mcp_servers.agentpack"),
        codexHooksMergePlan(root),
        writeFilePlan(root, ".agentpack/instructions/codex-mcp.example.toml", "Write a Codex MCP config snippet for manual review.", codexTomlSnippet(serverName))
      ],
      notes: [
        "No global Codex config is modified.",
        `Codex should use the project-local .codex/config.toml entry named ${serverName} for this repo.`,
        "The project PreToolUse hook runs `agentpack task gate` before apply_patch edits; Codex requires the hook definition to be reviewed and trusted before it runs.",
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
        jsonMergePlan(root, ".mcp.json", "Add the Agentpack MCP server to project .mcp.json.", serverName, claudeMcpServer()),
        claudeHooksMergePlan(root)
      ],
      notes: [
        "Only project-local files are modified.",
        `The Claude Code MCP server key is ${serverName} to avoid cross-repo name collisions.`,
        "Claude Code prompts before using project-scoped MCP servers from .mcp.json.",
        "The PreToolUse hook runs `agentpack task gate` before file edits; it warns by default and blocks only when gateMode is \"block\" in .agentpack/config.json.",
        "The hook launches the gate through the current Node executable and Agentpack entrypoint, not the shell PATH; re-run this install after switching Node versions."
      ]
    };
  }

  if (target === "git-hooks") {
    const hooksPath = getGitHooksPath(root);
    if (!hooksPath) {
      throw new Error("install git-hooks requires a git repository");
    }
    const preCommitPath = path.join(hooksPath, "pre-commit");
    const snippetRelativePath = ".agentpack/instructions/pre-commit-gate.example.sh";
    const files = [
      writeFilePlan(root, snippetRelativePath, "Write the gate pre-commit snippet for manual review.", preCommitGateScript([root]))
    ];
    const notes = [
      "The pre-commit hook runs `agentpack task gate --staged` on the staged files.",
      "Warn mode (default) prints findings and allows the commit; \"gateMode\": \"block\" in .agentpack/config.json makes violations fail the commit.",
      "The hook is skipped silently when the agentpack binary is not on PATH."
    ];
    const bounds = getGitRepoBounds(root);
    const insideRepo = bounds && (isWithin(bounds.topLevel, hooksPath) || isWithin(bounds.commonDir, hooksPath));
    if (!insideRepo) {
      notes.push(`Git hooks path ${hooksPath} is outside this repository (custom core.hooksPath); not writing there. Append the gate call manually from ${snippetRelativePath}.`);
      return { target, files, notes };
    }
    const existing = existsSync(preCommitPath) ? readFileSync(preCommitPath, "utf8") : "";
    if (!existing || existing.includes(GATE_HOOK_MARKER)) {
      const roots = [...new Set([...parseGateHookRoots(existing), root])];
      if (roots.length > 1) {
        notes.push(`The hook gates ${roots.length} packs in this repository: ${[...roots].sort().join(", ")}.`);
      } else if (bounds && bounds.topLevel !== root) {
        notes.push(`The hook runs the gate for the Agentpack pack at ${root}; installing from another pack in this repository adds it to the same hook.`);
      }
      files.push({
        filePath: preCommitPath,
        description: "Install the Agentpack gate pre-commit hook.",
        content: preCommitGateScript(roots),
        executable: true
      });
    } else {
      notes.push(`Existing pre-commit hook detected and left untouched. Append the gate call manually from ${snippetRelativePath}.`);
    }
    return { target, files, notes };
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
      ignorePatternPlan(root, ".cursor", "Keep project-local Cursor integration files out of git."),
      writeFilePlan(root, ".agentpack/instructions/cursor.md", "Write Cursor-specific Agentpack workflow instructions.", cursorInstructions()),
      writeFilePlan(root, ".cursor/rules/agentpack.mdc", "Write a Cursor project rule for Agentpack.", cursorInstructions()),
      jsonMergePlan(root, ".cursor/mcp.json", "Add the Agentpack MCP server to Cursor project MCP config.", serverName, cursorMcpServer()),
      cursorHooksMergePlan(root)
    ],
    notes: [
      "Only project-local files are modified.",
      "Cursor reads project-specific MCP servers from .cursor/mcp.json when this folder is opened as the workspace.",
      "The project preToolUse hook runs `agentpack task gate` before Write and Delete tools; warn mode allows silently, while block mode denies violations with feedback.",
      "After writing the config, reload the Cursor window, open MCP Servers, and enable the Agentpack server if it is toggled off.",
      "The Cursor MCP entry uses an absolute Node launcher so Cursor does not depend on your shell/fnm/nvm PATH."
    ]
  };
}

function applyPlan(root: string, plan: InstallPlan): void {
  const writes: Array<{ filePath: string; previous: string | null }> = [];
  const createdDirectories: Array<{ deepest: string; shallowest: string }> = [];

  try {
    for (const file of plan.files) {
      validateInstallPath(root, file.filePath);
      const directory = path.dirname(file.filePath);
      const firstCreated = mkdirSync(directory, { recursive: true });
      if (firstCreated) {
        createdDirectories.push({ deepest: directory, shallowest: firstCreated });
      }
      const previous = existsSync(file.filePath) ? readFileSync(file.filePath, "utf8") : null;
      if (previous === file.content) {
        if (file.executable) {
          chmodSync(file.filePath, 0o755);
        }
        continue;
      }
      writes.push({ filePath: file.filePath, previous });
      writeFileSync(file.filePath, file.content, "utf8");
      if (file.executable) {
        chmodSync(file.filePath, 0o755);
      }
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const write of [...writes].reverse()) {
      try {
        const current = existsSync(write.filePath) ? readFileSync(write.filePath, "utf8") : null;
        if (current === write.previous) {
          continue;
        }
        if (write.previous === null) {
          unlinkSync(write.filePath);
        } else {
          writeFileSync(write.filePath, write.previous, "utf8");
        }
      } catch {
        rollbackFailed = true;
      }
    }
    for (const created of [...createdDirectories].reverse()) {
      removeEmptyDirectoryChain(created.deepest, created.shallowest);
    }
    if (rollbackFailed) {
      throw new Error(`Install failed and rollback was incomplete; review the files listed in the plan. Original error: ${String(error)}`);
    }
    throw new Error(`Install failed; already-written files were rolled back. Original error: ${String(error)}`);
  }
}

function removeEmptyDirectoryChain(deepest: string, shallowest: string): void {
  let current = deepest;
  while (true) {
    try {
      rmdirSync(current);
    } catch {
      // Directory is missing or holds pre-existing/user files; leave it intact.
      return;
    }
    if (current === shallowest) {
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
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

function ignorePatternPlan(root: string, pattern: string, description: string): InstallFile {
  const filePath = path.join(root, ".gitignore");
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const normalized = pattern.replace(/\/$/, "");
  const present = existing.split(/\r?\n/).some((line) => line.trim().replace(/\/$/, "") === normalized);
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  return {
    filePath,
    description,
    content: present ? existing : `${existing}${prefix}${pattern}\n`
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

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function preCommitGateScript(roots: string[]): string {
  // git runs hooks from the repository top level; packs may live in subdirectories,
  // and one repository can hold several packs — the hook gates each listed pack.
  const gateLines = [...roots].sort().flatMap((root) => [
    `  ${GATE_ROOT_MARKER}${Buffer.from(root, "utf8").toString("base64")}`,
    `  run_gate ${shellQuote(root)}`
  ]);
  return [
    "#!/bin/sh",
    GATE_HOOK_MARKER,
    "# Agentpack task gate: checks staged files against the current Task Passport of each listed pack.",
    "# Warn mode prints findings and allows the commit; block mode fails the commit with exit code 2.",
    "overall=0",
    "run_gate() {",
    "  if [ -d \"$1\" ]; then",
    "    (cd \"$1\" && agentpack task gate --staged)",
    "    gate_status=$?",
    "    if [ \"$gate_status\" -eq 2 ]; then",
    "      overall=2",
    "    elif [ \"$gate_status\" -ne 0 ]; then",
    "      echo \"agentpack task gate exited with $gate_status for $1; commit allowed (gate skipped)\"",
    "    fi",
    "  fi",
    "}",
    "if command -v agentpack >/dev/null 2>&1; then",
    ...gateLines,
    "fi",
    "exit $overall",
    ""
  ].join("\n");
}

function validateInstallPlan(root: string, plan: InstallPlan): void {
  for (const file of plan.files) {
    validateInstallPath(root, file.filePath);
  }
}

function validateInstallPath(root: string, filePath: string): void {
  const bounds = getGitRepoBounds(root);
  const bases = [root, bounds?.topLevel, bounds?.commonDir]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  const absolutePath = path.resolve(filePath);
  const base = bases.find((candidate) => isWithin(candidate, absolutePath));
  if (!base) {
    throw new Error(`Install path escapes the repository: ${filePath}`);
  }

  const relative = path.relative(base, absolutePath);
  let current = base;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      break;
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Install path contains a symbolic link: ${filePath}`);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function windowsCommandQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function parseGateHookRoots(script: string): string[] {
  const roots: string[] = [];
  for (const line of script.split("\n")) {
    const encoded = line.trim().startsWith(GATE_ROOT_MARKER)
      ? line.trim().slice(GATE_ROOT_MARKER.length)
      : "";
    if (encoded) {
      try {
        roots.push(Buffer.from(encoded, "base64").toString("utf8"));
        continue;
      } catch {
        // Fall through to the legacy quoted-line parser.
      }
    }
    const match = line.match(/^\s*run_gate "(.+)"\s*$/);
    if (match?.[1]) {
      roots.push(match[1]);
    }
  }
  return roots;
}

function claudeHooksMergePlan(root: string): InstallFile {
  const filePath = path.join(root, ".claude", "settings.json");
  const existing = readJson<Record<string, unknown>>(filePath, {});
  const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];

  const withoutGate = preToolUse.filter((entry) => !JSON.stringify(entry).includes(CLAUDE_GATE_MARKER));
  withoutGate.push({
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    hooks: [{ type: "command", command: clientGateCommand("claude") }]
  });

  const next = {
    ...existing,
    hooks: { ...hooks, PreToolUse: withoutGate }
  };

  return {
    filePath,
    description: "Add the Agentpack gate PreToolUse hook to project Claude Code settings.",
    content: `${JSON.stringify(next, null, 2)}\n`
  };
}

function codexHooksMergePlan(root: string): InstallFile {
  const filePath = path.join(root, ".codex", "hooks.json");
  const existing = readJson<Record<string, unknown>>(filePath, {});
  const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const withoutGate = preToolUse.filter((entry) => !JSON.stringify(entry).includes(CODEX_GATE_MARKER));
  withoutGate.push({
    matcher: "^apply_patch$",
    hooks: [{
      type: "command",
      command: codexGateCommand("posix"),
      commandWindows: codexGateCommand("win32"),
      statusMessage: "Checking Agentpack task scope"
    }]
  });

  return {
    filePath,
    description: "Add the Agentpack gate PreToolUse hook to project Codex config.",
    content: `${JSON.stringify({ ...existing, hooks: { ...hooks, PreToolUse: withoutGate } }, null, 2)}\n`
  };
}

function cursorHooksMergePlan(root: string): InstallFile {
  const filePath = path.join(root, ".cursor", "hooks.json");
  const existing = readJson<Record<string, unknown>>(filePath, {});
  const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
  const preToolUse = Array.isArray(hooks.preToolUse) ? [...hooks.preToolUse] : [];
  const withoutGate = preToolUse.filter((entry) => !JSON.stringify(entry).includes(CURSOR_GATE_MARKER));
  withoutGate.push({
    command: clientGateCommand("cursor"),
    matcher: "Write|Delete"
  });

  return {
    filePath,
    description: "Add the Agentpack gate preToolUse hook to project Cursor config.",
    content: `${JSON.stringify({ ...existing, version: existing.version || 1, hooks: { ...hooks, preToolUse: withoutGate } }, null, 2)}\n`
  };
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
