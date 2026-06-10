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
import { getGitInfo } from "../src/core/git.js";
import { buildResume } from "../src/core/resume.js";
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
  assert.match(help, /agentpack ledger status/);
  assert.match(help, /docs\/CLI\.md has the full manual/);
  assert.doesNotMatch(help, /Advanced\/debug commands/);
  assert.doesNotMatch(help, /agentpack record decision/);
  assert.match(help, /--version/);

  const taskHelp = run(dir, ["task", "--help"]);
  assert.match(taskHelp, /Agentpack Task Passports/);
  assert.match(taskHelp, /Common workflow/);
  assert.match(taskHelp, /task handoff/);
  assert.match(taskHelp, /task finalize refuses unknown or pending verification/);

  const resumeHelp = run(dir, ["resume", "--help"]);
  assert.match(resumeHelp, /agentpack resume/);
  assert.match(resumeHelp, /--preset quick\|chat\|agent\|deep/);
  assert.doesNotMatch(resumeHelp, /Pack root:/);

  const installHelp = run(dir, ["install", "--help"]);
  assert.match(installHelp, /agentpack install codex\|claude\|claude-desktop\|cursor/);
  assert.match(installHelp, /Defaults to dry-run/);

  const ledgerHelp = run(dir, ["ledger", "--help"]);
  assert.match(ledgerHelp, /agentpack ledger status/);
  assert.match(ledgerHelp, /No cleanup is performed/);

  const releaseHelp = run(dir, ["release", "--help"]);
  assert.match(releaseHelp, /agentpack release preflight/);
  assert.match(releaseHelp, /does not push, tag, publish, or create GitHub Releases/);

  const initHelp = run(dir, ["init", "--help"]);
  assert.match(initHelp, /agentpack init/);
  assert.match(initHelp, /Initialize \.agentpack\//);
  assert.equal(existsSync(path.join(dir, ".agentpack")), false);
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
  const evidenceOutput = run(dir, ["evidence", "add", "--kind", "test-output", "--content", "Tests pass."]);
  const decisionEvidenceId = evidenceOutput.match(/Attached evidence ([^\n]+)/)?.[1] || "";
  assert.match(decisionEvidenceId, /^evt_/);
  run(dir, ["record", "decision", "Evidence can support durable decisions.", "--evidence", decisionEvidenceId]);
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
  assert.ok(estimatedTokensFromResume(tinyResume) <= 80);

  const strictFallbackResume = buildResume(dir, { budget: 40 });
  assert.ok(strictFallbackResume.estimatedTokens <= 40);
  assert.match(strictFallbackResume.markdown, /\[Truncated to fit budget\]$/);

  const markerlessFallbackResume = buildResume(dir, { budget: 5 });
  assert.ok(markerlessFallbackResume.estimatedTokens <= 5);
  assert.doesNotMatch(markerlessFallbackResume.markdown, /\[Truncated to fit budget\]/);

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

  const ledger = run(dir, ["ledger", "status"]);
  assert.match(ledger, /Ledger status/);
  assert.match(ledger, /Tasks: 0 active, 0 parked, 0 blocked, 0 verifying, 0 completed, 0 abandoned/);
  assert.match(ledger, /Events: \d+ entries, /);
  assert.match(ledger, /Evidence: 2 files, .* \(2 events, 1 referenced, 1 unreferenced\)/);
  assert.match(ledger, /Checkpoints: 1 snapshots, /);
  assert.match(ledger, /Exports: 2 files, /);
  assert.match(ledger, /Sources: 1 recorded, 0 unchanged, 1 changed, 0 missing/);
  assert.match(ledger, /No cleanup was performed\./);

  const doctor = run(dir, ["doctor"]);
  assert.match(doctor, /Agentpack doctor/);
  assert.match(doctor, /\[ok\] Pack/);
  assert.match(doctor, /\[ok\] \.gitignore/);
  assert.match(doctor, /\[warn\] Sources: 1 recorded, 1 changed, 0 missing; run `agentpack source status --changed --missing` for details/);
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
    "release_preflight",
    "replay",
    "resume",
    "source_status",
    "task_audit",
    "task_finalize",
    "task_handoff",
    "task_park",
    "task_start",
    "task_status",
    "task_update",
    "task_update_verification"
  ]);

  const sourceStatusTool = TOOL_DEFINITIONS.find((tool) => tool.name === "source_status");
  assert.match(sourceStatusTool?.description || "", /changed, or missing/);
  assert.match(sourceStatusTool?.description || "", /stale source-cache triage/);
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

test("doctor clarifies when Claude Desktop points only at other repos", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-other-repo-test-"));
  const otherRoot = mkdtempSync(path.join(os.tmpdir(), "agentpack-other-root-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
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
    assert.match(doctor, /\[warn\] Claude Desktop: no Claude Desktop Agentpack server points at this repo/);
    assert.match(doctor, /only fix this if you expect Claude Desktop to use this repo/);
    assert.match(doctor, /Existing Agentpack Desktop roots: agentpack-other=/);
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

test("loads full git diff only when requested and preserves checkpoint patches", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-git-diff-test-"));
  writeFileSync(path.join(dir, "tracked.txt"), "committed\n", "utf8");
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agentpack@example.com"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["add", "tracked.txt"]);
  commit(dir, "initial");
  run(dir, ["init"]);

  writeFileSync(path.join(dir, "tracked.txt"), "committed\nworking tree marker\n", "utf8");

  const summaryOnly = getGitInfo(dir);
  assert.equal(summaryOnly.diff, "");
  assert.match(summaryOnly.diffStat || "", /1 file changed/);
  assert.match(buildResume(dir).markdown, /Current diff: 1 file changed, 1 insertion/);

  const withDiff = getGitInfo(dir, { includeDiff: true });
  assert.match(withDiff.diff, /working tree marker/);

  run(dir, ["checkpoint", "-m", "Capture working tree patch."]);
  const checkpoints = readdirSync(path.join(dir, ".agentpack", "checkpoints")).sort();
  const latest = checkpoints[checkpoints.length - 1];
  assert.ok(latest);
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "checkpoints", latest, "diff.patch"), "utf8"),
    /working tree marker/
  );
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

  const doctor = run(dir, ["doctor"]);
  assert.match(doctor, /\[warn\] Sources: 2 recorded, 0 changed, 1 missing; run `agentpack source status --changed --missing` for details/);

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

test("release preflight is read-only and checks release prep basics", async () => {
  const noPackDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-nopack-"));
  const noPack = runExpectFailureOutput(noPackDir, ["release", "preflight"]);
  assert.match(noPack, /Agentpack release preflight/);
  assert.match(noPack, /\[fail\] Pack: No \.agentpack directory found/);
  assert.match(noPack, /Result: fix failed checks before release prep/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-test-"));
  writeReleaseFixture(dir);
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  runGit(dir, ["add", ".gitignore", ".github", "docs", "package.json", "package-lock.json"]);
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
  runGit(dir, ["branch", "-M", "main"]);
  addReleaseRemote(dir);

  const preflight = run(dir, ["release", "preflight"]);
  assert.match(preflight, /Agentpack release preflight/);
  assert.match(preflight, /\[ok\] package\.json: agentpack-cli@1\.2\.3/);
  assert.match(preflight, /\[ok\] package-lock\.json: version matches 1\.2\.3/);
  assert.match(preflight, /\[ok\] Git: main @ [0-9a-f]+, in sync with origin\/main/);
  assert.match(preflight, /\[ok\] Publish workflow: Trusted Publisher release workflow is present/);
  assert.match(preflight, /\[ok\] Release docs: weekly cadence and pre-flight checklist are documented/);
  assert.match(preflight, /Release actions are intentionally manual/);
  assert.match(preflight, /Result: ready for release-prep checks/);

  const mcp = createMcpHarness(dir);
  const releasePreflight = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "release_preflight",
      arguments: {}
    }
  });
  assert.match(releasePreflight.result.content[0].text, /Agentpack release preflight/);
  assert.match(releasePreflight.result.content[0].text, /Release actions are intentionally manual/);
});

test("release preflight blocks upstream drift and token-based npm auth", () => {
  const aheadDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-ahead-test-"));
  writeReleaseFixture(aheadDir);
  initializeReleaseRepo(aheadDir);
  writeFileSync(path.join(aheadDir, "README.md"), "# Local change\n", "utf8");
  runGit(aheadDir, ["add", "README.md"]);
  commit(aheadDir, "local change");

  const ahead = runExpectFailureOutput(aheadDir, ["release", "preflight"]);
  assert.match(ahead, /\[fail\] Git: main is ahead of origin\/main by 1 commit\(s\); push reviewed commits before release prep/);
  assert.match(ahead, /Result: fix failed checks before release prep/);

  const behindDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-behind-test-"));
  writeReleaseFixture(behindDir);
  const remote = initializeReleaseRepo(behindDir);
  const cloneDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-upstream-clone-"));
  runGit(os.tmpdir(), ["clone", "--branch", "main", remote, cloneDir]);
  runGit(cloneDir, ["config", "user.name", "Agentpack Test"]);
  runGit(cloneDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(cloneDir, "README.md"), "# Remote change\n", "utf8");
  runGit(cloneDir, ["add", "README.md"]);
  commit(cloneDir, "remote change");
  runGit(cloneDir, ["push", "origin", "main"]);
  runGit(behindDir, ["fetch", "origin"]);

  const behind = runExpectFailureOutput(behindDir, ["release", "preflight"]);
  assert.match(behind, /\[fail\] Git: main is behind origin\/main by 1 commit\(s\); update main before release prep/);

  const tokenDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-token-test-"));
  writeReleaseFixture(tokenDir, [
    "name: Publish to npm",
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
    "        env:",
    "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
    ""
  ].join("\n"));
  initializeReleaseRepo(tokenDir);

  const token = runExpectFailureOutput(tokenDir, ["release", "preflight"]);
  assert.match(token, /\[fail\] Publish workflow: must not reference NPM_TOKEN or NODE_AUTH_TOKEN when using Trusted Publisher/);
});

test("resume surfaces upstream drift and local commits before optional ledger sections", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-resume-git-test-"));
  writeReleaseFixture(dir);
  initializeReleaseRepo(dir);
  run(dir, ["set", "goal", "Keep release train context visible."]);
  run(dir, [
    "task",
    "start",
    "Prepare next release batch",
    "--objective",
    "Carry local commits as next-release candidates until the weekly batch.",
    "--write-scope",
    "README.md",
    "--next",
    "Review local commits before release prep"
  ]);
  writeFileSync(path.join(dir, "README.md"), "# Local release candidate\n", "utf8");
  runGit(dir, ["add", "README.md"]);
  commit(dir, "local release candidate");

  run(dir, [
    "record",
    "decision",
    "Use weekly batch release cadence; local commits remain next-release candidates until Thursday release prep."
  ]);
  run(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--summary",
    "Context handoff checks passed."
  ]);

  for (let index = 0; index < 10; index += 1) {
    run(dir, ["record", "decision", `Release decision ${index} should be optional under a tight budget.`]);
  }

  const resume = run(dir, ["resume", "--budget", "520", "--query", "release cadence local commits verification"]);
  assert.ok(estimatedTokensFromResume(resume) <= 520);
  assert.match(resume, /Upstream: origin\/main \(1 ahead, 0 behind\)/);
  assert.match(resume, /Local commits ahead of upstream:\n  - [0-9a-f]+ local release candidate/);
  assert.match(resume, /Relevant Context/);
  assert.match(resume, /Use weekly batch release cadence; local commits remain next-release candidates until Thursday release prep/);
  assert.match(resume, /Verification: passed - Context handoff checks passed\./);
  assert.match(resume, /Review local commits before release prep/);
  assert.match(resume, /Budget status: limited/);
  assert.match(resume, /omitted .*Decisions.*Recent Timeline/);
});

test("preserves query-relevant source context just above the compact context budget", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-resume-mid-budget-test-"));
  run(dir, ["init"]);

  for (let index = 0; index < 20; index += 1) {
    const fileName = `source-${index}.js`;
    writeFileSync(path.join(dir, fileName), `console.log(${index})\n`, "utf8");
    run(dir, [
      "source",
      "add",
      fileName,
      "--summary",
      index === 0
        ? "Needle context must survive the mid-budget transition."
        : `Unrelated source summary ${index} expands the filtered Source Cache.`
    ]);
  }

  const resume = run(dir, ["resume", "--budget", "1201", "--query", "needle context"]);
  assert.ok(estimatedTokensFromResume(resume) <= 1201);
  assert.doesNotMatch(resume, /## Relevant Context/);
  assert.match(resume, /## Source Cache/);
  assert.match(resume, /Needle context must survive the mid-budget transition/);
});

test("requires semantic review to refresh changed source records", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-review-test-"));
  writeFileSync(path.join(dir, "reviewed.js"), "console.log('reviewed v1')\n", "utf8");

  run(dir, ["init"]);
  run(dir, ["source", "add", "reviewed.js", "--summary", "Reviewed v1 behavior."]);
  writeFileSync(path.join(dir, "reviewed.js"), "console.log('reviewed v2')\n", "utf8");

  const changedStatus = run(dir, ["source", "status", "--changed"]);
  assert.match(changedStatus, /CHANGED reviewed\.js/);
  assert.doesNotMatch(changedStatus, /UNCHANGED reviewed\.js/);

  const missingStatus = run(dir, ["source", "status", "--missing"]);
  assert.match(missingStatus, /No missing source records/);

  assert.match(
    runExpectError(dir, ["source", "add", "reviewed.js", "--summary", "Blindly update hash."]),
    /use `agentpack source review reviewed\.js --summary <text>` after semantic review/
  );

  const stillChanged = run(dir, ["source", "status", "--changed"]);
  assert.match(stillChanged, /CHANGED reviewed\.js/);

  assert.match(
    runExpectError(dir, ["source", "review", "reviewed.js"]),
    /source review requires --summary <text>/
  );

  const review = run(dir, ["source", "review", "reviewed.js", "--summary", "Reviewed v2 behavior."]);
  assert.match(review, /Reviewed source reviewed\.js/);

  const noChanged = run(dir, ["source", "status", "--changed"]);
  assert.match(noChanged, /No changed source records/);

  const refreshedStatus = run(dir, ["source", "status"]);
  assert.match(refreshedStatus, /UNCHANGED reviewed\.js/);
  assert.match(refreshedStatus, /summary: Reviewed v2 behavior\./);

  const changedJson = JSON.parse(run(dir, ["source", "status", "--changed", "--json"])) as unknown[];
  assert.deepEqual(changedJson, []);

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; path?: string });
  assert.equal(events.some((event) => event.type === "source-review" && event.path === "reviewed.js"), true);
});

test("filters MCP source_status to changed and missing records", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-source-status-test-"));
  writeFileSync(path.join(dir, "active.js"), "console.log('active')\n", "utf8");
  writeFileSync(path.join(dir, "changed.js"), "console.log('changed v1')\n", "utf8");
  writeFileSync(path.join(dir, "missing.js"), "console.log('missing')\n", "utf8");

  run(dir, ["init"]);
  run(dir, ["source", "add", "active.js", "--summary", "Active source was inspected."]);
  run(dir, ["source", "add", "changed.js", "--summary", "Changed source was inspected."]);
  run(dir, ["source", "add", "missing.js", "--summary", "Missing source was inspected."]);
  writeFileSync(path.join(dir, "changed.js"), "console.log('changed v2')\n", "utf8");
  unlinkSync(path.join(dir, "missing.js"));

  const mcp = createMcpHarness(dir);
  const tools = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  });
  const sourceStatusTool = tools.result.tools.find((tool: { name: string }) => tool.name === "source_status");
  assert.ok(sourceStatusTool);
  assert.ok(sourceStatusTool.inputSchema.properties.changed);
  assert.ok(sourceStatusTool.inputSchema.properties.missing);

  const changed = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {
        changed: true
      }
    }
  });
  assert.match(changed.result.content[0].text, /CHANGED changed\.js/);
  assert.doesNotMatch(changed.result.content[0].text, /UNCHANGED active\.js/);
  assert.doesNotMatch(changed.result.content[0].text, /MISSING missing\.js/);

  const stale = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {
        changed: true,
        missing: true
      }
    }
  });
  assert.match(stale.result.content[0].text, /CHANGED changed\.js/);
  assert.match(stale.result.content[0].text, /MISSING missing\.js/);
  assert.doesNotMatch(stale.result.content[0].text, /UNCHANGED active\.js/);

  const missingJson = await mcp.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {
        missing: true,
        json: true
      }
    }
  });
  const parsed = JSON.parse(missingJson.result.content[0].text) as Array<{ path: string; status: string }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.path, "missing.js");
  assert.equal(parsed[0]?.status, "missing");
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
  const eventCountBeforeNoop = taskEventCount(dir, passed.id);
  assert.match(run(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--evidence",
    "evt_task_test",
    "--summary",
    "Focused task passport checks passed."
  ]), /Verification unchanged for task .* \(passed\)/);
  assert.equal(taskEventCount(dir, passed.id), eventCountBeforeNoop);
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
  const closedResume = run(dir, ["resume", "--preset", "agent"]);
  assert.match(closedResume, /Status: completed/);
  assert.match(closedResume, /Task next actions \(historical; task is closed\):\n  - Wire CLI/);
  assert.match(runExpectError(dir, ["task", "block", "--reason", "Too late"]), /Cannot update closed task/);

  assert.match(run(dir, ["task", "start", "Repo-wide follow-up", "--write-scope", "."]), /Started task task_/);
  const repoWide = JSON.parse(run(dir, ["task", "passport"]));
  assert.deepEqual(repoWide.writeScope, ["."]);
  assert.doesNotMatch(run(dir, ["task", "audit"]), /Task has no write scope/);

  assert.match(run(dir, ["task", "close"]), /Closed task/);
  assert.match(run(dir, ["task", "start", "Finalize direct", "--write-scope", ".", "--next", "Resume later"]), /Started task task_/);
  assert.match(runExpectError(dir, [
    "task",
    "finalize",
    "--status",
    "accepted",
    "--summary",
    "Small docs task accepted."
  ]), /Use `agentpack task park` for deferred work/);
  assert.match(run(dir, [
    "task",
    "finalize",
    "--status",
    "accepted",
    "--summary",
    "Small docs task accepted.",
    "--force"
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
  writeFileSync(path.join(dir, "src", "stale.ts"), "export const stale = 'v1';\n", "utf8");
  writeFileSync(path.join(dir, "docs", "setup.md"), "# Setup\n", "utf8");
  writeFileSync(path.join(dir, "docs", "obsolete.md"), "# Obsolete\n", "utf8");

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
  run(dir, [
    "source",
    "add",
    "src/stale.ts",
    "--summary",
    "Stale source used to export a v1 marker."
  ]);
  run(dir, [
    "source",
    "add",
    "docs/obsolete.md",
    "--summary",
    "Obsolete docs described a removed setup note."
  ]);
  writeFileSync(path.join(dir, "src", "stale.ts"), "export const stale = 'v2';\n", "utf8");
  unlinkSync(path.join(dir, "docs", "obsolete.md"));

  const filtered = run(dir, ["resume", "--preset", "deep", "--query", "auth session"]);
  assert.match(filtered, /Query filter: full summaries for 1 query-relevant source\(s\), compact stubs for 4 query-unrelated source\(s\)/);
  assert.match(filtered, /Query-unrelated stale stubs: 2 changed\/missing/);
  assert.match(filtered, /src\/auth\.ts/);
  assert.match(filtered, /Authentication middleware validates sessions/);
  assert.match(filtered, /src\/billing\.ts/);
  assert.match(filtered, /docs\/setup\.md/);
  assert.match(filtered, /src\/stale\.ts/);
  assert.match(filtered, /docs\/obsolete\.md/);
  assert.match(filtered, /status: unchanged; topic: Billing worker calculates invoices/);
  assert.match(filtered, /status: unchanged; topic: Developer setup docs/);
  assert.match(filtered, /status: changed; topic: Stale source used to export a v1 marker\. \(recorded\); guidance: call `source_status` before relying/);
  assert.match(filtered, /status: missing; topic: Obsolete docs described a removed setup note\. \(recorded\); guidance: call `source_status` before relying/);
  assert.doesNotMatch(filtered, /summary: Billing worker calculates invoices/);
  assert.doesNotMatch(filtered, /summary: Developer setup docs/);
  assert.doesNotMatch(filtered, /summary: Stale source used to export a v1 marker/);
  assert.doesNotMatch(filtered, /summary: Obsolete docs described a removed setup note/);

  const unfiltered = run(dir, ["resume", "--preset", "deep"]);
  assert.match(unfiltered, /Billing worker calculates invoices/);
  assert.match(unfiltered, /Developer setup docs/);
  assert.match(unfiltered, /summary: Stale source used to export a v1 marker/);
  assert.match(unfiltered, /summary: Obsolete docs described a removed setup note/);

  const noMatch = run(dir, ["resume", "--preset", "deep", "--query", "vector database"]);
  assert.match(noMatch, /no source summaries matched `vector database`; showing compact stubs for all 5 recorded source\(s\)/);
  assert.match(noMatch, /Billing worker calculates invoices/);
  assert.match(noMatch, /Developer setup docs/);
  assert.match(noMatch, /Query-unrelated stale stubs: 2 changed\/missing/);
  assert.doesNotMatch(noMatch, /summary: Authentication middleware validates sessions/);
  assert.doesNotMatch(noMatch, /summary: Billing worker calculates invoices/);
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
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Coding defaults/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /do not log secrets/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /design mode: do not write code/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Task lifecycle gate/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /treat review mode as a scope check/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /park deferred work with `task_park`\/`task park`/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /do not finalize a task just to free the current slot/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /PR bodies, release notes, or branch names/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /avoid branch names with AI or agent-style prefixes/);
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
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /Task lifecycle gate/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /separate review task only for unrelated reviews/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /finalization means verification is passed, failed, or explicitly accepted as complete/);
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
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Git and PR hygiene/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /do not add AI or agent prefixes/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /`claude\/`, `codex\/`, `ai\/`, or `agent\/`/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Focused skills\/rules/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /treat named modes as explicit collaboration preferences/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /checkpoint mode: summarize what was decided/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Task lifecycle gate/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /verifying, blocked, closed/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /keep reviews that verify the current active\/verifying task inside that task/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /do not mutate a review task into implementation work/);
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

test("parks current task over MCP so a new task can start", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-park-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('park')\n", "utf8");
  run(dir, ["init"]);

  const mcp = createMcpHarness(dir);

  const taskStart = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "Parkable MCP task",
        nextActions: ["Resume later"]
      }
    }
  });
  assert.match(taskStart.result.content[0].text, /Started task task_/);

  const refusedFinalize = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "task_finalize",
      arguments: {
        status: "accepted",
        summary: "Pause for another task."
      }
    }
  });
  assert.match(refusedFinalize.error?.message, /Use `agentpack task park` for deferred work/);

  const taskPark = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "task_park",
      arguments: {}
    }
  });
  assert.match(taskPark.result.content[0].text, /Parked task task_/);
  const parkedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(parkedPassport.status, "parked");
  assert.equal(parkedPassport.title, "Parkable MCP task");

  const replacementStart = await mcp.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "Replacement MCP task"
      }
    }
  });
  assert.match(replacementStart.result.content[0].text, /Started task task_/);

  const status = await mcp.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "task_status",
      arguments: {}
    }
  });
  assert.match(status.result.content[0].text, /Replacement MCP task \[active\]/);

  const tasks = run(dir, ["task", "list"]);
  assert.match(tasks, /- task_.* \[parked\] Parkable MCP task/);
  assert.match(tasks, /\* task_.* \[active\] Replacement MCP task/);
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
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "..", "package.json"), "utf8")) as { version: string };
  assert.equal(initialize.result.serverInfo.version, pkg.version);

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

  const taskStatusBeforeStart = await mcp.send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "task_status",
      arguments: {}
    }
  });
  assert.match(taskStatusBeforeStart.result.content[0].text, /Task status/);
  assert.match(taskStatusBeforeStart.result.content[0].text, /No current task passport/);

  const taskStart = await mcp.send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "MCP verification flow",
        objective: "Exercise MCP task lifecycle flow.",
        constraints: ["Keep task lifecycle reachable through MCP."],
        writeScope: ["index.js"],
        nextActions: ["Finish MCP verification"],
        tags: ["mcp-lifecycle"],
        risk: "medium"
      }
    }
  });
  assert.match(taskStart.result.content[0].text, /Started task task_/);
  const startedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(startedPassport.title, "MCP verification flow");
  assert.equal(startedPassport.objective, "Exercise MCP task lifecycle flow.");
  assert.deepEqual(startedPassport.constraints, ["Keep task lifecycle reachable through MCP."]);
  assert.deepEqual(startedPassport.writeScope, ["index.js"]);
  assert.deepEqual(startedPassport.nextActions, ["Finish MCP verification"]);
  assert.deepEqual(startedPassport.tags, ["mcp-lifecycle"]);
  assert.equal(startedPassport.risk, "medium");

  const taskStatusAfterStart = await mcp.send({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "task_status",
      arguments: {}
    }
  });
  assert.match(taskStatusAfterStart.result.content[0].text, /MCP verification flow \[active\]/);
  assert.match(taskStatusAfterStart.result.content[0].text, /ID: task_/);
  assert.match(taskStatusAfterStart.result.content[0].text, /Verification: unknown/);
  assert.match(taskStatusAfterStart.result.content[0].text, /Next: Finish MCP verification/);
  assert.match(taskStatusAfterStart.result.content[0].text, /Write scope: index\.js/);

  const duplicateTaskStart = await mcp.send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "Overlapping MCP task"
      }
    }
  });
  assert.match(duplicateTaskStart.error?.message, /park or close it before starting a new task/);

  const taskHandoff = await mcp.send({
    jsonrpc: "2.0",
    id: 12,
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
    id: 13,
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
    id: 14,
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
    id: 15,
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
  assert.deepEqual(mcpUpdatedPassport.constraints, ["Keep task lifecycle reachable through MCP.", "Keep MCP task updates additive."]);
  assert.deepEqual(mcpUpdatedPassport.writeScope, ["index.js", "."]);
  assert.deepEqual(mcpUpdatedPassport.nextActions, ["Finish MCP verification", "Inspect updated passport"]);
  assert.deepEqual(mcpUpdatedPassport.tags, ["mcp-lifecycle", "mcp-task-update"]);
  assert.equal(mcpUpdatedPassport.risk, "medium");

  const eventCountBeforeMcpNoop = taskEventCount(dir, mcpUpdatedPassport.id);
  const taskVerifyNoop = await mcp.send({
    jsonrpc: "2.0",
    id: 16,
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
  assert.match(taskVerifyNoop.result.content[0].text, /Verification unchanged for task .* \(passed\)/);
  assert.equal(taskEventCount(dir, mcpUpdatedPassport.id), eventCountBeforeMcpNoop);

  const invalidMcpRisk = await mcp.send({
    jsonrpc: "2.0",
    id: 17,
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
    id: 18,
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
    id: 19,
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
  assert.match(resume.result.content[0].text, /Query filter: full summaries for 1 query-relevant source\(s\), compact stubs for 1 query-unrelated source\(s\)/);
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

function runExpectFailureOutput(cwd: string, args: string[]): string {
  try {
    run(cwd, args);
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return String(failure.stdout || failure.stderr || failure.message || error);
  }
  assert.fail(`Expected command to fail: agentpack ${args.join(" ")}`);
}

function estimatedTokensFromResume(output: string): number {
  const match = output.match(/Estimated usage: ~(\d+) tokens/);
  assert.ok(match, "resume should include estimated token usage");
  const tokenText = match[1];
  assert.ok(tokenText, "resume should include numeric estimated token usage");
  return Number.parseInt(tokenText, 10);
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
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function writeReleaseFixture(dir: string, publishWorkflow?: string): void {
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "1.2.3",
    publishConfig: {
      access: "public",
      provenance: true
    }
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "agentpack-cli",
        version: "1.2.3"
      }
    }
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, ".github", "workflows", "publish.yml"), publishWorkflow || [
    "name: Publish to npm",
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
  ].join("\n"), "utf8");
  writeFileSync(path.join(dir, "docs", "RELEASING.md"), [
    "# Releasing",
    "",
    "Use a weekly release cadence for normal releases.",
    "",
    "## Pre-flight checklist",
    "",
    "- npm test",
    ""
  ].join("\n"), "utf8");
}

function initializeReleaseRepo(dir: string): string {
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  runGit(dir, ["add", ".gitignore", ".github", "docs", "package.json", "package-lock.json"]);
  commit(dir, "initial");
  runGit(dir, ["branch", "-M", "main"]);
  return addReleaseRemote(dir);
}

function addReleaseRemote(dir: string): string {
  const remote = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-remote-"));
  runGit(remote, ["init", "--bare"]);
  runGit(dir, ["remote", "add", "origin", remote]);
  runGit(dir, ["push", "-u", "origin", "main"]);
  return remote;
}

function commit(dir: string, message: string): void {
  runGit(dir, [
    "-c",
    "user.name=Agentpack Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message
  ]);
}

function taskEventCount(root: string, taskId: string): number {
  const eventsPath = path.join(root, ".agentpack", "tasks", taskId, "events.jsonl");
  return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length;
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
