import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveMcpStartDir } from "../src/cli/index.js";
import { buildDoctorReport } from "../src/core/doctor.js";
import { startMcpServer, TOOL_DEFINITIONS } from "../src/mcp/server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "src", "agentpack.js");

test("--version and --help run without an initialized pack", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-noinit-"));
  // repoRoot points at the compiled dist/ when tests run, so the real package.json sits one level above.
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "..", "package.json"), "utf8")) as { version: string };

  const version = run(dir, ["--version"]).trim();
  assert.equal(version, pkg.version);

  const versionShort = run(dir, ["-v"]).trim();
  assert.equal(versionShort, pkg.version);

  const help = run(dir, ["--help"]);
  assert.match(help, /Agentpack/);
  assert.match(help, /Default workflow/);
  assert.match(help, /Task Passport/);
  assert.match(help, /docs\/CLI\.md has the full manual/);
  assert.doesNotMatch(help, /Advanced\/debug commands/);
  assert.doesNotMatch(help, /agentpack record decision/);
  assert.match(help, /--version/);

  const taskHelp = run(dir, ["task", "--help"]);
  assert.match(taskHelp, /Agentpack Task Passports/);
  assert.match(taskHelp, /Common workflow/);
  assert.match(taskHelp, /task handoff/);
  assert.match(taskHelp, /task finalize refuses unknown or pending verification/);
});

test("creates a pack, records source context, checkpoints, and exports handoff", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('hello agentpack')\n", "utf8");

  run(dir, ["init"]);
  assert.match(readFileSync(path.join(dir, ".gitignore"), "utf8"), /\.agentpack\//);
  run(dir, ["set", "goal", "Ship a tiny Agentpack MVP"]);
  run(dir, ["source", "add", "index.js", "--summary", "Entry point already inspected."]);
  const initialSourceStatus = run(dir, ["source", "status"]);
  assert.match(initialSourceStatus, /UNCHANGED index\.js/);
  assert.match(initialSourceStatus, /hash: matches recorded hash/);
  assert.match(initialSourceStatus, /meaning: recorded summary is valid for the current file content/);
  run(dir, ["record", "decision", "Use local JSON and JSONL storage for v0."]);
  run(dir, ["note", "This is a local task-state note."]);
  run(dir, ["evidence", "add", "--kind", "test-output", "--content", "Tests pass."]);
  run(dir, ["run", process.execPath, "--version"]);
  run(dir, [
    "checkpoint",
    "-m",
    "First checkpoint",
    "--status",
    "Ready for handoff",
    "--next",
    "Open MCP contract"
  ]);

  const resume = run(dir, ["resume", "--preset", "agent"]);
  assert.match(resume, /Pack root: .+agentpack-test-/);
  assert.match(resume, /Ship a tiny Agentpack MVP/);
  assert.match(resume, /Ready for handoff/);
  assert.match(resume, /Open MCP contract/);
  assert.match(resume, /Estimated usage: ~\d+ tokens/);
  assert.match(resume, /Budget status: within target/);
  assert.match(resume, /Source Cache/);
  assert.match(resume, /Do not re-open unless needed or unless hash changed/);
  assert.match(resume, /Summary is current for this file content/);
  assert.match(resume, /command-output/);
  assert.match(resume, /exit code: 0/);
  const timeline = resume.split("## Recent Timeline")[1] || "";
  assert.match(timeline, /Total events:/);
  assert.match(timeline, /Full chronology: `agentpack replay`/);
  assert.doesNotMatch(timeline, /Entry point already inspected/);

  const tinyResume = run(dir, ["resume", "--budget", "80"]);
  assert.match(tinyResume, /Estimated usage: ~\d+ tokens/);
  assert.match(tinyResume, /Budget status: limited/);

  const exported = run(dir, ["export", "--to", "chatgpt", "--preset", "agent"]);
  assert.match(exported, /chatgpt-handoff\.md/);
  assert.equal(existsSync(path.join(dir, ".agentpack", "exports", "chatgpt-handoff.md")), true);
  const defaultExport = run(dir, ["export", "--preset", "agent"]);
  assert.match(defaultExport, /markdown-handoff\.md/);
  assert.equal(existsSync(path.join(dir, ".agentpack", "exports", "markdown-handoff.md")), true);

  const replay = run(dir, ["replay"]);
  assert.match(replay, /decision/);
  assert.match(replay, /note/);
  assert.match(replay, /command-output/);
  assert.match(replay, /checkpoint/);

  const sourceDb = JSON.parse(readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"));
  assert.equal(sourceDb.sources[0].path, "index.js");

  writeFileSync(path.join(dir, "index.js"), "console.log('changed')\n", "utf8");
  assert.match(run(dir, ["source", "status"]), /CHANGED index\.js/);

  const sourceStatus = JSON.parse(run(dir, ["source", "status", "--json"]));
  assert.equal(sourceStatus[0].status, "changed");

  const doctor = run(dir, ["doctor"]);
  assert.match(doctor, /Agentpack doctor/);
  assert.match(doctor, /\[ok\] Pack/);
  assert.match(doctor, /\[ok\] \.gitignore/);
});

test("exposes expected MCP tools", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "attach_evidence",
    "checkpoint",
    "diff",
    "load_context",
    "record_dead_end",
    "record_decision",
    "record_source",
    "replay",
    "resume",
    "source_status",
    "task_audit",
    "task_finalize",
    "task_handoff",
    "task_update",
    "task_update_verification"
  ]);
});

test("init appends to existing gitignore without overwriting project rules", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-gitignore-test-"));
  const gitignorePath = path.join(dir, ".gitignore");
  const existingGitignore = [
    "# Project rules",
    "dist/",
    "*.log"
  ].join("\n");
  writeFileSync(gitignorePath, existingGitignore, "utf8");

  run(dir, ["init"]);
  const expectedGitignore = [
    existingGitignore,
    ".agentpack/",
    ".codex",
    ".claude",
    ".mcp.json",
    "AGENTS.md",
    "CLAUDE.md",
    ""
  ].join("\n");
  assert.equal(readFileSync(gitignorePath, "utf8"), expectedGitignore);

  run(dir, ["init"]);
  assert.equal(readFileSync(gitignorePath, "utf8"), expectedGitignore);
});

test("doctor warns about local-only ignore gaps and generic project MCP names", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "example-app-doctor-test-"));
  run(dir, ["init"]);
  writeFileSync(path.join(dir, ".gitignore"), ".agentpack/\n", "utf8");
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: {
      agentpack: {
        type: "stdio",
        command: "agentpack",
        args: ["mcp"]
      }
    }
  }, null, 2), "utf8");
  mkdirSync(path.join(dir, ".cursor"), { recursive: true });
  writeFileSync(path.join(dir, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: {
      [expectedMcpServerName(dir)]: {
        type: "stdio",
        command: "agentpack",
        args: ["mcp", "--root", "${workspaceFolder}"]
      }
    }
  }, null, 2), "utf8");

  const doctor = run(dir, ["doctor"]);
  assert.match(doctor, /\[warn\] Local ignores: .*\.mcp\.json/);
  assert.match(doctor, /\[warn\] Project MCP: generic server key "agentpack" can collide across repos/);
  assert.match(doctor, /\[warn\] Cursor MCP: .*Cursor GUI may not inherit your shell PATH/);
});

test("doctor warns about stale project roots and overwritten Claude Desktop config", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "get-cluster-doctor-test-"));
  const staleRoot = mkdtempSync(path.join(os.tmpdir(), "stale-agentpack-root-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "agentpack-get-cluster-doctor-test": {
        type: "stdio",
        command: "agentpack",
        args: ["mcp", "--root", staleRoot]
      }
    }
  }, null, 2), "utf8");
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({ preferences: { coworkWebSearchEnabled: true } }, null, 2),
    "utf8"
  );

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const doctor = buildDoctorReport(dir).text;
    assert.match(doctor, /\[warn\] Project MCP: .*stale --root/);
    assert.match(doctor, /\[warn\] Claude Desktop: config has no mcpServers/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("doctor warns about legacy Claude Desktop launchers and missing entrypoints", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-doctor-test-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  const missingEntrypoint = path.join(dir, "missing-agentpack.js");
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
        "agentpack-legacy": {
          command: "agentpack",
          args: ["mcp", "--root", realpathSync(dir)],
          env: {
            AGENTPACK_ROOT: realpathSync(dir)
          }
        },
        "agentpack-missing": {
          command: process.execPath,
          args: [missingEntrypoint, "mcp", "--root", realpathSync(dir)],
          env: {
            AGENTPACK_ROOT: realpathSync(dir)
          }
        }
      }
    }, null, 2),
    "utf8"
  );

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const doctor = buildDoctorReport(dir).text;
    assert.match(doctor, /\[warn\] Claude Desktop: .*uses command "agentpack"/);
    assert.match(doctor, /Claude Desktop may not inherit your shell PATH/);
    assert.match(doctor, /Agentpack entrypoint does not exist/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("doctor names the Claude Desktop server key for the current repo", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-current-test-"));
  const otherRoot = mkdtempSync(path.join(os.tmpdir(), "agentpack-other-root-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  const serverName = expectedMcpServerName(dir);
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
        [serverName]: {
          command: process.execPath,
          args: [cli, "mcp", "--root", realpathSync(dir)],
          env: {
            AGENTPACK_ROOT: realpathSync(dir)
          }
        },
        "agentpack-other": {
          command: process.execPath,
          args: [cli, "mcp", "--root", otherRoot],
          env: {
            AGENTPACK_ROOT: otherRoot
          }
        }
      }
    }, null, 2),
    "utf8"
  );

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const doctor = buildDoctorReport(dir).text;
    assert.match(doctor, new RegExp(`\\[ok\\] Claude Desktop: server key "${serverName}" points at this pack root`));
    assert.match(doctor, /also has other Agentpack servers/);
    assert.match(doctor, /use the repo-specific server\/tool group/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("mcp root resolution prefers --root, then AGENTPACK_ROOT, then cwd", () => {
  const originalRoot = process.env.AGENTPACK_ROOT;

  try {
    process.env.AGENTPACK_ROOT = "/env/repo";
    assert.equal(resolveMcpStartDir({ root: "/flag/repo" }, "/cwd/repo"), "/flag/repo");
    assert.equal(resolveMcpStartDir({}, "/cwd/repo"), "/env/repo");

    delete process.env.AGENTPACK_ROOT;
    assert.equal(resolveMcpStartDir({}, "/cwd/repo"), "/cwd/repo");
  } finally {
    if (originalRoot === undefined) {
      delete process.env.AGENTPACK_ROOT;
    } else {
      process.env.AGENTPACK_ROOT = originalRoot;
    }
  }
});

test("distinguishes source-cache status from git working tree status", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-git-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('initial')\n", "utf8");

  runGit(dir, ["init"]);
  run(dir, ["init"]);
  runGit(dir, ["add", "index.js", ".gitignore"]);
  runGit(dir, [
    "-c",
    "user.name=Agentpack Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial"
  ]);

  writeFileSync(path.join(dir, "index.js"), "console.log('changed but recorded')\n", "utf8");
  writeFileSync(path.join(dir, "other.js"), "console.log('unrecorded')\n", "utf8");
  run(dir, ["source", "add", "index.js", "--summary", "Current changed version was inspected."]);

  const status = run(dir, ["source", "status"]);
  assert.match(status, /Agentpack source status tracks recorded source conclusions, not the full git working tree/);
  assert.match(status, /UNCHANGED index\.js/);
  assert.match(status, /hash: matches recorded hash/);
  assert.match(status, /git: modified/);
  assert.match(status, /Git changes not recorded as Agentpack sources/);
  assert.match(status, /untracked other\.js/);
});

test("removes explicit and missing source records", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-prune-test-"));
  writeFileSync(path.join(dir, "active.js"), "console.log('active')\n", "utf8");
  writeFileSync(path.join(dir, "stale.js"), "console.log('stale')\n", "utf8");

  run(dir, ["init"]);
  run(dir, ["source", "add", "active.js", "--summary", "Active file was inspected."]);
  run(dir, ["source", "add", "stale.js", "--summary", "Soon-to-be deleted file was inspected."]);
  unlinkSync(path.join(dir, "stale.js"));

  const staleStatus = run(dir, ["source", "status"]);
  assert.match(staleStatus, /UNCHANGED active\.js/);
  assert.match(staleStatus, /MISSING stale\.js/);

  const prune = run(dir, ["source", "prune", "--missing"]);
  assert.match(prune, /Pruned 1 missing source record/);
  assert.match(prune, /- stale\.js/);

  const prunedStatus = run(dir, ["source", "status"]);
  assert.match(prunedStatus, /UNCHANGED active\.js/);
  assert.doesNotMatch(prunedStatus, /stale\.js/);

  const remove = run(dir, ["source", "remove", "active.js"]);
  assert.match(remove, /Removed source active\.js/);

  const sourceDb = JSON.parse(readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"));
  assert.deepEqual(sourceDb.sources, []);

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; path?: string; count?: number });
  assert.equal(events.some((event) => event.type === "source-prune" && event.count === 1), true);
  assert.equal(events.some((event) => event.type === "source-remove" && event.path === "active.js"), true);
});

test("manages a current task passport", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-task-test-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1;\n", "utf8");

  runGit(dir, ["init"]);
  runGit(dir, ["add", "src/index.ts"]);
  runGit(dir, [
    "-c",
    "user.name=Agentpack Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial"
  ]);

  run(dir, ["init"]);
  const started = run(dir, [
    "task",
    "start",
    "Add task passports",
    "--objective",
    "Model current task handoff state.",
    "--constraint",
    "Keep v0 state readable.",
    "--write-scope",
    "src/index.ts",
    "--next",
    "Wire CLI",
    "--tag",
    "task-passport",
    "--risk",
    "low"
  ]);
  assert.match(started, /Started task task_/);
  assert.match(
    runExpectError(dir, ["task", "start", "Overlapping task", "--write-scope", "src/index.ts"]),
    /Current task .* is active; park or close it before starting a new task\./
  );
  assert.match(runExpectError(dir, [
    "task",
    "start",
    "Invalid risk task",
    "--risk",
    "urgent"
  ]), /Unknown task risk: urgent/);

  const taskId = readFileSync(path.join(dir, ".agentpack", "tasks", "current"), "utf8").trim();
  const passportPath = path.join(dir, ".agentpack", "tasks", taskId, "passport.json");
  const passport = JSON.parse(readFileSync(passportPath, "utf8"));
  assert.equal(passport.title, "Add task passports");
  assert.equal(passport.objective, "Model current task handoff state.");
  assert.equal(passport.status, "active");
  assert.deepEqual(passport.constraints, ["Keep v0 state readable."]);
  assert.deepEqual(passport.writeScope, ["src/index.ts"]);
  assert.deepEqual(passport.nextActions, ["Wire CLI"]);
  assert.deepEqual(passport.tags, ["task-passport"]);
  assert.equal(passport.risk, "low");
  assert.equal(passport.worktree, realpathSync(dir));
  assert.equal(existsSync(path.join(dir, ".agentpack", "tasks", taskId, "events.jsonl")), true);

  const list = run(dir, ["task", "list"]);
  assert.match(list, new RegExp(`\\* ${taskId} \\[active\\] Add task passports`));

  const status = run(dir, ["task", "status"]);
  assert.match(status, /Task status/);
  assert.match(status, /Add task passports \[active\]/);
  assert.match(status, new RegExp(`ID: ${taskId}`));
  assert.match(status, /Risk: low/);
  assert.match(status, /Verification: unknown/);
  assert.match(status, /Next: Wire CLI/);
  assert.match(status, /Write scope: src\/index\.ts/);
  assert.match(status, /Drift: none/);

  const handoff = run(dir, ["task", "handoff"]);
  assert.match(handoff, /Task handoff/);
  assert.match(handoff, /Add task passports \[active\]/);
  assert.match(handoff, /Objective: Model current task handoff state\./);
  assert.match(handoff, /Constraints:\n- Keep v0 state readable\./);
  assert.match(handoff, /Write scope:\n- src\/index\.ts/);
  assert.match(handoff, /Next actions:\n- Wire CLI/);
  assert.match(handoff, /Audit: Verification is unknown/);

  const currentPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(currentPassport.id, taskId);

  const resume = run(dir, ["resume", "--preset", "agent"]);
  assert.match(resume, /## Current Task Passport/);
  assert.match(resume, new RegExp(`ID: ${taskId}`));
  assert.match(resume, /Title: Add task passports/);
  assert.match(resume, /Objective: Model current task handoff state\./);
  assert.match(resume, /Keep v0 state readable\./);
  assert.match(resume, /Write scope:\n  - src\/index\.ts/);
  assert.match(resume, /Task next actions:\n  - Wire CLI/);
  assert.match(resume, /Drift: none detected/);

  const initialAudit = run(dir, ["task", "audit"]);
  assert.match(initialAudit, /Task audit/);
  assert.match(initialAudit, new RegExp(`Current task: ${taskId} \\[active\\] Add task passports`));
  assert.match(initialAudit, /Verification is unknown/);
  assert.match(initialAudit, /Metadata/);
  assert.match(initialAudit, /No changed or missing recorded source conclusions/);

  assert.match(run(dir, [
    "task",
    "update",
    "--objective",
    "Model current task handoff state and update it after start.",
    "--constraint",
    "Keep task updates additive.",
    "--write-scope",
    ".",
    "--next",
    "Document task update flow",
    "--tag",
    "task-update",
    "--risk",
    "medium"
  ]), /Updated task .*/);
  const updated = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(updated.objective, "Model current task handoff state and update it after start.");
  assert.deepEqual(updated.constraints, ["Keep v0 state readable.", "Keep task updates additive."]);
  assert.deepEqual(updated.writeScope, ["src/index.ts", "."]);
  assert.deepEqual(updated.nextActions, ["Wire CLI", "Document task update flow"]);
  assert.deepEqual(updated.tags, ["task-passport", "task-update"]);
  assert.equal(updated.risk, "medium");
  assert.match(runExpectError(dir, ["task", "update"]), /task update requires at least one non-empty field/);
  assert.match(runExpectError(dir, ["task", "update", "--next", "Document task update flow"]), /task update did not change the current task/);
  assert.match(runExpectError(dir, ["task", "update", "--objective", ""]), /task update requires at least one non-empty field/);
  assert.match(runExpectError(dir, ["task", "update", "--risk", "urgent"]), /Unknown task risk: urgent/);

  run(dir, ["source", "add", "src/index.ts", "--summary", "Task passport fixture source."]);
  writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 2;\n", "utf8");
  const staleAudit = run(dir, ["task", "audit"]);
  assert.match(staleAudit, /Source cache metadata has 1 changed or missing record\(s\): src\/index\.ts/);
  assert.match(staleAudit, /Refresh only records whose durable conclusions changed/);

  assert.match(run(dir, ["task", "block", "--reason", "Waiting for review"]), /Blocked task/);
  const blocked = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReason, "Waiting for review");

  assert.match(run(dir, ["task", "update-verification"]), /Updated verification for task .* \(pending\)/);
  const verifying = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(verifying.status, "verifying");
  assert.equal(verifying.verification.status, "pending");
  assert.match(runExpectError(dir, ["task", "finalize"]), /task finalize requires verification status passed, failed, or accepted/);

  assert.match(run(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--evidence",
    "evt_task_test",
    "--summary",
    "Focused task passport checks passed."
  ]), /Updated verification for task .* \(passed\)/);
  const passed = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(passed.verification.status, "passed");
  assert.deepEqual(passed.verification.evidence, ["evt_task_test"]);
  assert.equal(passed.verification.summary, "Focused task passport checks passed.");
  assert.doesNotMatch(run(dir, ["task", "audit"]), /Verification is/);
  const verifiedHandoff = run(dir, ["task", "handoff"]);
  assert.match(verifiedHandoff, /Verification: passed - Focused task passport checks passed\./);
  assert.match(verifiedHandoff, /Evidence: evt_task_test/);
  assert.match(verifiedHandoff, /Audit: No action-required task warnings\./);

  assert.match(run(dir, ["task", "finalize"]), /Finalized task .* \(passed\)/);
  const closed = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(closed.status, "completed");
  assert.equal(closed.verification.status, "passed");
  assert.equal(typeof closed.closedAt, "string");
  assert.match(runExpectError(dir, ["task", "block", "--reason", "Too late"]), /Cannot update closed task/);

  assert.match(run(dir, ["task", "start", "Repo-wide follow-up", "--write-scope", "."]), /Started task task_/);
  const repoWide = JSON.parse(run(dir, ["task", "passport"]));
  assert.deepEqual(repoWide.writeScope, ["."]);
  assert.doesNotMatch(run(dir, ["task", "audit"]), /Task has no write scope/);

  assert.match(run(dir, ["task", "close"]), /Closed task/);
  assert.match(run(dir, ["task", "start", "Finalize direct", "--write-scope", "."]), /Started task task_/);
  assert.match(run(dir, [
    "task",
    "finalize",
    "--status",
    "accepted",
    "--summary",
    "Small docs task accepted."
  ]), /Finalized task .* \(accepted\)/);
  const finalized = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.verification.status, "accepted");
  assert.equal(finalized.verification.summary, "Small docs task accepted.");
  assert.match(runExpectError(dir, [
    "task",
    "start",
    "Invalid risk task",
    "--risk",
    "urgent"
  ]), /Unknown task risk: urgent/);
});

test("task status reports missing current passport without requiring audit", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-task-status-test-"));
  run(dir, ["init"]);

  const status = run(dir, ["task", "status"]);
  assert.match(status, /Task status/);
  assert.match(status, /No current task passport/);
});

test("redacts secrets from stored context and handoff outputs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-redaction-test-"));
  const secret = "agentpack-secret-value-12345";
  const priorEnv = process.env.AGENTPACK_TEST_TOKEN;
  process.env.AGENTPACK_TEST_TOKEN = secret;

  try {
    writeFileSync(path.join(dir, "index.js"), "console.log('redaction')\n", "utf8");
    run(dir, ["init"]);

    const configPath = path.join(dir, ".agentpack", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.redactions = [...config.redactions, "AGENTPACK_TEST_TOKEN"];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    run(dir, ["set", "goal", `Investigate ${secret}`]);
    run(dir, ["record", "decision", `Use api_key=${secret} and password=hunter2 for testing only.`]);
    run(dir, [
      "source",
      "add",
      "index.js",
      "--summary",
      `Read source that mentioned ${secret}.`,
      "--snippet",
      `token=${secret}`
    ]);
    run(dir, ["evidence", "add", "--kind", "test-output", "--content", `OPENAI_API_KEY=${secret}\npassword=hunter2`]);
    run(dir, [
      "checkpoint",
      "-m",
      `Checkpoint with ${secret}`,
      "--status",
      `Status has token=${secret}`,
      "--next",
      `Do not leak ${secret}`
    ]);

    const resume = run(dir, ["resume", "--preset", "deep"]);
    const replay = run(dir, ["replay"]);
    const sourceStatus = run(dir, ["source", "status"]);
    const sourceStatusJson = run(dir, ["source", "status", "--json"]);
    run(dir, ["export", "--to", "chatgpt", "--preset", "deep"]);

    const packText = [
      resume,
      replay,
      sourceStatus,
      sourceStatusJson,
      readFileSync(path.join(dir, ".agentpack", "state.json"), "utf8"),
      readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8"),
      readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"),
      readFileSync(path.join(dir, ".agentpack", "exports", "chatgpt-handoff.md"), "utf8"),
      ...readdirSync(path.join(dir, ".agentpack", "checkpoints"))
        .flatMap((checkpointId) => ["checkpoint.json", "resume.md", "diff.patch"].map((fileName) => (
          path.join(dir, ".agentpack", "checkpoints", checkpointId, fileName)
        )))
        .filter((filePath) => existsSync(filePath))
        .map((filePath) => readFileSync(filePath, "utf8")),
      ...readdirSync(path.join(dir, ".agentpack", "evidence"))
        .map((fileName) => readFileSync(path.join(dir, ".agentpack", "evidence", fileName), "utf8"))
    ].join("\n");

    assert.equal(packText.includes(secret), false);
    assert.equal(packText.includes("hunter2"), false);
    assert.match(packText, /\[REDACTED/);
  } finally {
    if (priorEnv === undefined) {
      delete process.env.AGENTPACK_TEST_TOKEN;
    } else {
      process.env.AGENTPACK_TEST_TOKEN = priorEnv;
    }
  }
});

test("keeps recent timeline compact without duplicating source summaries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-timeline-test-"));
  run(dir, ["init"]);

  for (let index = 0; index < 12; index += 1) {
    const fileName = `source-${index}.js`;
    writeFileSync(path.join(dir, fileName), `console.log(${index})\n`, "utf8");
    run(dir, [
      "source",
      "add",
      fileName,
      "--summary",
      `Detailed source summary ${index} that belongs in Source Cache but not in Recent Timeline.`
    ]);
  }

  run(dir, ["record", "decision", "Keep timeline as a compact digest."]);
  run(dir, ["checkpoint", "-m", "Timeline compaction checkpoint."]);

  const resume = run(dir, ["resume", "--preset", "deep"]);
  const timeline = resume.split("## Recent Timeline")[1] || "";

  assert.match(timeline, /Total events:/);
  assert.match(timeline, /source: 12/);
  assert.match(timeline, /Recent source records:/);
  assert.match(timeline, /Recent non-source events:/);
  assert.match(timeline, /Full chronology: `agentpack replay`/);
  assert.doesNotMatch(timeline, /Detailed source summary/);
  assert.equal((timeline.match(/\[checkpoint\]/g) || []).length, 0);
  assert.match(resume, /Detailed source summary 11/);
});

test("filters source cache summaries by query while preserving source stubs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-query-test-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  writeFileSync(path.join(dir, "src", "billing.ts"), "export const billing = true;\n", "utf8");
  writeFileSync(path.join(dir, "docs", "setup.md"), "# Setup\n", "utf8");

  run(dir, ["init"]);
  run(dir, [
    "source",
    "add",
    "src/auth.ts",
    "--summary",
    "Authentication middleware validates sessions and refresh tokens."
  ]);
  run(dir, [
    "source",
    "add",
    "src/billing.ts",
    "--summary",
    "Billing worker calculates invoices and payment retries."
  ]);
  run(dir, [
    "source",
    "add",
    "docs/setup.md",
    "--summary",
    "Developer setup docs for local MCP install."
  ]);

  const filtered = run(dir, ["resume", "--preset", "deep", "--query", "auth session"]);
  assert.match(filtered, /Query filter: full summaries for 1 relevant or stale source\(s\), compact stubs for 2 unchanged source\(s\)/);
  assert.match(filtered, /src\/auth\.ts/);
  assert.match(filtered, /Authentication middleware validates sessions/);
  assert.match(filtered, /src\/billing\.ts/);
  assert.match(filtered, /docs\/setup\.md/);
  assert.match(filtered, /topic: Billing worker calculates invoices/);
  assert.match(filtered, /topic: Developer setup docs/);
  assert.match(filtered, /summary: omitted by query filter/);
  assert.doesNotMatch(filtered, /summary: Billing worker calculates invoices/);
  assert.doesNotMatch(filtered, /summary: Developer setup docs/);

  const unfiltered = run(dir, ["resume", "--preset", "deep"]);
  assert.match(unfiltered, /Billing worker calculates invoices/);
  assert.match(unfiltered, /Developer setup docs/);

  const noMatch = run(dir, ["resume", "--preset", "deep", "--query", "vector database"]);
  assert.match(noMatch, /full Source Cache retained to avoid false-negative filtering/);
  assert.match(noMatch, /Billing worker calculates invoices/);
  assert.match(noMatch, /Developer setup docs/);
});

test("serializes concurrent source record writes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-concurrent-source-test-"));
  const files = Array.from({ length: 16 }, (_, index) => `file-${index}.js`);

  for (const file of files) {
    writeFileSync(path.join(dir, file), `console.log(${JSON.stringify(file)})\n`, "utf8");
  }

  run(dir, ["init"]);

  await Promise.all(files.map((file) => runAsync(dir, [
    "source",
    "add",
    file,
    "--summary",
    `Reviewed ${file}.`
  ])));

  const sourceDb = JSON.parse(readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"));
  const sourcePaths = sourceDb.sources.map((source: { path: string }) => source.path).sort();
  assert.deepEqual(sourcePaths, [...files].sort());

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
  assert.equal(events.filter((event) => event.type === "source").length, files.length);
  assert.equal(existsSync(path.join(dir, ".agentpack", ".lock")), false);
});

test("previews and writes project-local MCP client install files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-install-test-"));
  const serverName = expectedMcpServerName(dir);
  run(dir, ["init"]);

  const defaultPreview = run(dir, ["install", "cursor"]);
  assert.match(defaultPreview, /dry run/);
  assert.match(defaultPreview, /No files were changed/);
  assert.equal(existsSync(path.join(dir, ".cursor", "mcp.json")), false);

  const claudePreview = run(dir, ["install", "claude", "--dry-run"]);
  assert.match(claudePreview, /agentpack install claude --write/);
  assert.equal(existsSync(path.join(dir, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(dir, ".mcp.json")), false);

  const claudeInstall = run(dir, ["install", "claude", "--write"]);
  assert.match(claudeInstall, /Installed Agentpack claude integration/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /agentpack:start/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /preserve existing functionality/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /design mode: do not write code/);
  const claudeMcp = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(claudeMcp.mcpServers[serverName], {
    type: "stdio",
    command: "agentpack",
    args: ["mcp"]
  });
  assert.equal(claudeMcp.mcpServers.agentpack, undefined);

  const claudeDesktopPreview = run(dir, ["install", "claude-desktop"]);
  assert.match(claudeDesktopPreview, /claude-desktop install plan/);
  assert.match(claudeDesktopPreview, /No Claude Desktop global config is modified/);
  assert.equal(existsSync(path.join(dir, ".agentpack", "instructions", "claude-desktop-mcp.example.json")), false);

  const claudeDesktopInstall = run(dir, ["install", "claude-desktop", "--write"]);
  assert.match(claudeDesktopInstall, /Installed Agentpack claude-desktop integration/);
  assert.match(claudeDesktopInstall, /claude_desktop_config\.json/);
  const claudeDesktopSnippet = JSON.parse(readFileSync(
    path.join(dir, ".agentpack", "instructions", "claude-desktop-mcp.example.json"),
    "utf8"
  ));
  assert.equal(claudeDesktopSnippet.mcpServers[serverName].command, process.execPath);
  assert.ok(path.isAbsolute(claudeDesktopSnippet.mcpServers[serverName].args[0]));
  assert.match(claudeDesktopSnippet.mcpServers[serverName].args[0], /agentpack\.js$/);
  assert.equal(claudeDesktopSnippet.mcpServers[serverName].args[0], cli);
  assert.deepEqual(claudeDesktopSnippet.mcpServers[serverName].args.slice(1), ["mcp", "--root", realpathSync(dir)]);
  assert.deepEqual(claudeDesktopSnippet.mcpServers[serverName].env, {
    AGENTPACK_ROOT: realpathSync(dir)
  });
  assert.notDeepEqual(claudeDesktopSnippet.mcpServers[serverName], {
    command: "agentpack",
    args: ["mcp", "--root", realpathSync(dir)],
    env: {
      AGENTPACK_ROOT: realpathSync(dir)
    }
  });
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    /Claude Desktop does not read project-local `\.mcp\.json`/
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    /Do not copy the generated snippet over the Desktop config file/
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    /current Node executable and Agentpack entrypoint/
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    new RegExp(`Generated server key for this repo: \`${serverName}\``)
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    new RegExp(`mcpServers\\.${serverName}`)
  );

  run(dir, ["install", "cursor", "--write"]);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /task-state ledger/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /preserve existing functionality/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /review mode: review the current diff/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /Cursor-specific notes/);
  const cursorMcp = JSON.parse(readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursorMcp.mcpServers[serverName].type, "stdio");
  assert.equal(cursorMcp.mcpServers[serverName].command, process.execPath);
  assert.ok(path.isAbsolute(cursorMcp.mcpServers[serverName].args[0]));
  assert.match(cursorMcp.mcpServers[serverName].args[0], /agentpack\.js$/);
  assert.equal(cursorMcp.mcpServers[serverName].args[0], cli);
  assert.deepEqual(cursorMcp.mcpServers[serverName].args.slice(1), ["mcp", "--root", "${workspaceFolder}"]);
  assert.equal(cursorMcp.mcpServers.agentpack, undefined);

  const codexInstall = run(dir, ["install", "codex", "--write"]);
  assert.match(codexInstall, /No global Codex config is modified/);
  assert.match(codexInstall, /project-local \.codex\/config\.toml/);
  assert.match(codexInstall, /Remove any old ~\/\.codex\/config\.toml agentpack server/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /agentpack:start/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /preserve existing functionality/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /treat named modes as explicit collaboration preferences/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /checkpoint mode: summarize what was decided/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Avoid turning Agentpack into an activity log/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /record_source` only when you have a durable conclusion/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /source_status` only when you need a full stale-source check/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /prefer one aggregated verification evidence and one checkpoint/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /sequence state-changing Agentpack calls/);
  assert.doesNotMatch(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /source_status` before re-reading/);
  const codexConfig = readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, new RegExp(`\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`));
  assert.doesNotMatch(codexConfig, /\[mcp_servers\.agentpack\]/);
  assert.match(codexConfig, /args = \["mcp"\]/);
  assert.doesNotMatch(codexConfig, /--root/);
  assert.doesNotMatch(codexConfig, /cwd =/);
  const codexSnippet = readFileSync(path.join(dir, ".agentpack", "instructions", "codex-mcp.example.toml"), "utf8");
  assert.match(codexSnippet, new RegExp(`\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`));
  assert.match(codexSnippet, /args = \["mcp"\]/);
  assert.doesNotMatch(codexSnippet, /args = \["mcp", "--root"/);
  assert.doesNotMatch(codexSnippet, /cwd =/);
});

test("serves MCP JSON-RPC tools over newline-delimited stdio", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('mcp')\n", "utf8");
  writeFileSync(path.join(dir, "other.js"), "console.log('other')\n", "utf8");
  run(dir, ["init"]);
  run(dir, ["set", "goal", "Exercise MCP smoke flow"]);

  const mcp = createMcpHarness(dir);

  const initialize = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {}
  });
  assert.equal(initialize.result.serverInfo.name, "agentpack");

  const beforeNotification = mcp.messages.length;
  mcp.input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  })}\n`);
  await sleep(20);
  assert.equal(mcp.messages.length, beforeNotification);

  const tools = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === "record_decision"));

  const decision = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "record_decision",
      arguments: {
        text: "MCP can record decisions through stdio.",
        files: ["index.js"]
      }
    }
  });
  assert.match(decision.result.content[0].text, /Recorded decision/);

  const source = await mcp.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "record_source",
      arguments: {
        path: "index.js",
        summary: "MCP smoke source."
      }
    }
  });
  assert.match(source.result.content[0].text, /Recorded source index\.js/);

  const otherSource = await mcp.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "record_source",
      arguments: {
        path: "other.js",
        summary: "Unrelated billing source for query filter coverage."
      }
    }
  });
  assert.match(otherSource.result.content[0].text, /Recorded source other\.js/);

  const sourceStatus = await mcp.send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {}
    }
  });
  assert.match(sourceStatus.result.content[0].text, /UNCHANGED index\.js/);
  assert.match(sourceStatus.result.content[0].text, /do not re-open unless needed/);
  assert.match(sourceStatus.result.content[0].text, /hash: matches recorded hash/);

  const taskAudit = await mcp.send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "task_audit",
      arguments: {}
    }
  });
  assert.match(taskAudit.result.content[0].text, /Task audit/);
  assert.match(taskAudit.result.content[0].text, /No current task passport/);

  run(dir, [
    "task",
    "start",
    "MCP verification flow",
    "--write-scope",
    "index.js",
    "--next",
    "Finish MCP verification"
  ]);

  const taskHandoff = await mcp.send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "task_handoff",
      arguments: {}
    }
  });
  assert.match(taskHandoff.result.content[0].text, /Task handoff/);
  assert.match(taskHandoff.result.content[0].text, /MCP verification flow \[active\]/);
  assert.match(taskHandoff.result.content[0].text, /Next actions:\n- Finish MCP verification/);

  const evidence = await mcp.send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "attach_evidence",
      arguments: {
        kind: "test-output",
        content: "MCP task verification passed."
      }
    }
  });
  const evidenceId = String(evidence.result.content[0].text).match(/Attached evidence ([^.]+)\./)?.[1] || "";
  assert.match(evidenceId, /^evt_/);

  const taskVerify = await mcp.send({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "task_update_verification",
      arguments: {
        status: "passed",
        evidence: [evidenceId],
        summary: "MCP smoke verification passed."
      }
    }
  });
  assert.match(taskVerify.result.content[0].text, /Updated verification for task .* \(passed\)/);

  const verifiedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(verifiedPassport.verification.status, "passed");
  assert.deepEqual(verifiedPassport.verification.evidence, [evidenceId]);
  assert.equal(verifiedPassport.verification.summary, "MCP smoke verification passed.");

  const taskUpdate = await mcp.send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "task_update",
      arguments: {
        objective: "Exercise MCP task update flow.",
        constraints: ["Keep MCP task updates additive."],
        writeScope: ["."],
        nextActions: ["Inspect updated passport"],
        tags: ["mcp-task-update"],
        risk: "medium"
      }
    }
  });
  assert.match(taskUpdate.result.content[0].text, /Updated task .*/);
  const mcpUpdatedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(mcpUpdatedPassport.objective, "Exercise MCP task update flow.");
  assert.deepEqual(mcpUpdatedPassport.constraints, ["Keep MCP task updates additive."]);
  assert.deepEqual(mcpUpdatedPassport.writeScope, ["index.js", "."]);
  assert.deepEqual(mcpUpdatedPassport.nextActions, ["Finish MCP verification", "Inspect updated passport"]);
  assert.deepEqual(mcpUpdatedPassport.tags, ["mcp-task-update"]);
  assert.equal(mcpUpdatedPassport.risk, "medium");

  const invalidMcpRisk = await mcp.send({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "task_update",
      arguments: {
        risk: "urgent"
      }
    }
  });
  assert.equal(invalidMcpRisk.error?.message, "Unknown task risk: urgent");

  const taskFinalize = await mcp.send({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "task_finalize",
      arguments: {}
    }
  });
  assert.match(taskFinalize.result.content[0].text, /Finalized task .* \(passed\)/);
  const finalizedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(finalizedPassport.status, "completed");
  assert.equal(finalizedPassport.verification.status, "passed");

  const resume = await mcp.send({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: {
      name: "resume",
      arguments: {
        preset: "deep",
        query: "smoke flow"
      }
    }
  });
  assert.match(resume.result.content[0].text, /Exercise MCP smoke flow/);
  assert.match(resume.result.content[0].text, /Estimated usage: ~\d+ tokens/);
  assert.match(resume.result.content[0].text, /Query filter: full summaries for 1 relevant or stale source\(s\), compact stubs for 1 unchanged source\(s\)/);
  assert.match(resume.result.content[0].text, /MCP smoke source/);
  assert.match(resume.result.content[0].text, /topic: Unrelated billing source/);
  assert.doesNotMatch(resume.result.content[0].text, /summary: Unrelated billing source/);
  assert.match(resume.result.content[0].text, /MCP can record decisions/);

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8");
  assert.match(events, /MCP can record decisions through stdio/);
});

function run(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runExpectError(cwd: string, args: string[]): string {
  try {
    run(cwd, args);
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; message?: string };
    return String(failure.stderr || failure.message || error);
  }
  assert.fail(`Expected command to fail: agentpack ${args.join(" ")}`);
}

function runAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  });
}

interface McpMessage {
  id?: string | number | null;
  result?: any;
  error?: any;
}

function createMcpHarness(cwd: string): {
  input: PassThrough;
  messages: McpMessage[];
  send: (message: Record<string, unknown>) => Promise<McpMessage>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: McpMessage[] = [];
  let buffer = "";

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        messages.push(JSON.parse(line) as McpMessage);
      }
    }
  });

  startMcpServer(cwd, input, output);

  return {
    input,
    messages,
    async send(message: Record<string, unknown>): Promise<McpMessage> {
      const expectedId = message.id;
      input.write(`${JSON.stringify(message)}\n`);
      return waitForMessage(messages, expectedId);
    }
  };
}

async function waitForMessage(messages: McpMessage[], id: unknown): Promise<McpMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = messages.find((candidate) => candidate.id === id);
    if (message) {
      return message;
    }
    await sleep(10);
  }

  throw new Error(`Timed out waiting for MCP response ${String(id)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function expectedMcpServerName(root: string): string {
  const slug = path.basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return !slug || slug === "agentpack" ? "agentpack" : `agentpack-${slug}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
