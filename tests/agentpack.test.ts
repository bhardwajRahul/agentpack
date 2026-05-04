import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMcpServer, TOOL_DEFINITIONS } from "../src/mcp/server.js";

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

test("serves MCP JSON-RPC tools over newline-delimited stdio", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('mcp')\n", "utf8");
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

  const resume = await mcp.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "resume",
      arguments: {
        preset: "quick"
      }
    }
  });
  assert.match(resume.result.content[0].text, /Exercise MCP smoke flow/);
  assert.match(resume.result.content[0].text, /MCP can record decisions/);

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8");
  assert.match(events, /MCP can record decisions through stdio/);
});

function run(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
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
