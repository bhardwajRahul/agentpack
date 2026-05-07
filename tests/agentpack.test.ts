import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.match(run(dir, ["source", "status"]), /git may still have uncommitted changes/);
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
  assert.match(resume, /git may still have uncommitted changes/);
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
    "resume",
    "source_status"
  ]);
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
  assert.match(status, /git: modified/);
  assert.match(status, /Git changes not recorded as Agentpack sources/);
  assert.match(status, /untracked other\.js/);
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
  const claudeMcp = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(claudeMcp.mcpServers.agentpack, {
    type: "stdio",
    command: "agentpack",
    args: ["mcp"]
  });

  run(dir, ["install", "cursor", "--write"]);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /task-state ledger/);
  const cursorMcp = JSON.parse(readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursorMcp.mcpServers.agentpack, {
    type: "stdio",
    command: "agentpack",
    args: ["mcp", "--root", "${workspaceFolder}"]
  });

  const codexInstall = run(dir, ["install", "codex", "--write"]);
  assert.match(codexInstall, /No global Codex config is modified/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /agentpack:start/);
  const codexSnippet = readFileSync(path.join(dir, ".agentpack", "instructions", "codex-mcp.example.toml"), "utf8");
  assert.match(codexSnippet, /\[mcp_servers\.agentpack\]/);
  assert.match(codexSnippet, /args = \["mcp", "--root"/);
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

  const sourceStatus = await mcp.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {}
    }
  });
  assert.match(sourceStatus.result.content[0].text, /UNCHANGED index\.js/);
  assert.match(sourceStatus.result.content[0].text, /do not re-open unless needed/);
  assert.match(sourceStatus.result.content[0].text, /git may still have uncommitted changes/);

  const resume = await mcp.send({
    jsonrpc: "2.0",
    id: 6,
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
