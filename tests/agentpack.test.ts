import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS } from "../src/mcp/server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "src", "agentpack.js");

test("creates a pack, records source context, checkpoints, and exports handoff", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('hello agentpack')\n", "utf8");

  run(dir, ["init"]);
  assert.match(readFileSync(path.join(dir, ".gitignore"), "utf8"), /\.agentpack\//);
  run(dir, ["set", "goal", "Ship a tiny Agentpack MVP"]);
  run(dir, ["source", "add", "index.js", "--summary", "Entry point already inspected."]);
  assert.match(run(dir, ["source", "status"]), /UNCHANGED index\.js/);
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
  assert.match(resume, /Ship a tiny Agentpack MVP/);
  assert.match(resume, /Ready for handoff/);
  assert.match(resume, /Open MCP contract/);
  assert.match(resume, /Source Cache/);
  assert.match(resume, /Do not re-open unless needed or unless hash changed/);
  assert.match(resume, /command-output/);
  assert.match(resume, /exit code: 0/);

  const exported = run(dir, ["export", "--to", "chatgpt", "--preset", "agent"]);
  assert.match(exported, /chatgpt-handoff\.md/);
  assert.equal(existsSync(path.join(dir, ".agentpack", "exports", "chatgpt-handoff.md")), true);

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
    "resume"
  ]);
});

function run(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}
