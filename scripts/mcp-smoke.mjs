#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "src", "agentpack.js");
const workspace = mkdtempSync(path.join(tmpdir(), "agentpack-mcp-smoke-"));

let server;

try {
  writeFileSync(path.join(workspace, "index.js"), "console.log('agentpack mcp smoke')\n", "utf8");
  runCli(["init"]);
  runCli(["set", "goal", "Exercise Agentpack MCP smoke flow."]);

  server = spawn(process.execPath, [cliPath, "mcp"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const client = createJsonRpcClient(server);

  const initialize = await client.request("initialize", {});
  assertEqual(initialize.result?.serverInfo?.name, "agentpack", "initialize returned the Agentpack server name");

  const toolsResponse = await client.request("tools/list", {});
  const toolNames = toolsResponse.result?.tools?.map((tool) => tool.name).sort() || [];
  for (const expected of ["load_context", "record_decision", "record_source", "resume", "source_status"]) {
    assertIncludes(toolNames, expected, `tools/list includes ${expected}`);
  }

  await client.request("tools/call", {
    name: "record_decision",
    arguments: {
      text: "MCP smoke can record decisions.",
      files: ["index.js"]
    }
  });

  await client.request("tools/call", {
    name: "record_source",
    arguments: {
      path: "index.js",
      summary: "Temporary smoke source inspected through MCP."
    }
  });

  const sourceStatus = await client.request("tools/call", {
    name: "source_status",
    arguments: {}
  });
  assertMatch(sourceStatus.result?.content?.[0]?.text || "", /UNCHANGED index\.js/, "source_status reports unchanged source");

  const resume = await client.request("tools/call", {
    name: "resume",
    arguments: {
      preset: "quick"
    }
  });
  const resumeText = resume.result?.content?.[0]?.text || "";
  assertMatch(resumeText, /Exercise Agentpack MCP smoke flow/, "resume contains the smoke goal");
  assertMatch(resumeText, /MCP smoke can record decisions/, "resume contains the MCP decision");

  console.log("MCP server OK");
  console.log(`Tools: ${toolNames.join(", ")}`);
  console.log("Flow: initialize -> tools/list -> record_decision -> record_source -> source_status -> resume");
} catch (error) {
  console.error("MCP smoke failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (server) {
    await stopServer(server);
  }
  rmSync(workspace, { recursive: true, force: true });
}

function runCli(args) {
  execFileSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    stdio: "pipe"
  });
}

function createJsonRpcClient(child) {
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.on("exit", (code, signal) => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error(`MCP server exited before response ${id}; code=${code}, signal=${signal}, stderr=${stderr.trim()}`));
    }
  });

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;

      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response ${id}; stderr=${stderr.trim()}`));
        }, 2000);

        pending.set(id, {
          resolve(message) {
            clearTimeout(timer);
            if (message.error) {
              reject(new Error(`${method} failed: ${message.error.message}`));
              return;
            }
            resolve(message);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return promise;
    }
  };
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };

    child.once("exit", finish);
    child.kill();
    setTimeout(finish, 500).unref();
  });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(values, expected, message) {
  if (!values.includes(expected)) {
    throw new Error(`${message}: missing ${expected}`);
  }
}

function assertMatch(value, pattern, message) {
  if (!pattern.test(value)) {
    throw new Error(`${message}: ${pattern} did not match`);
  }
}
