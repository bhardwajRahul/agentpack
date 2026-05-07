import { appendEvent, requirePackRoot } from "../core/store.js";
import { buildResume } from "../core/resume.js";
import { createCheckpoint, diffCheckpoints } from "../core/checkpoints.js";
import { addEvidence, addSourceRecord, formatSourceStatuses, getSourceStatuses, replayEvents } from "../operations.js";
import type { Readable, Writable } from "node:stream";
import { resolveBudget } from "../core/presets.js";
import { redactForRoot } from "../core/redaction.js";

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "load_context",
    description: "Load compact Agentpack context for the current task.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        budget: { type: "number" },
        preset: { type: "string" }
      }
    }
  },
  {
    name: "record_decision",
    description: "Record a decision made during the task.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["text"]
    }
  },
  {
    name: "record_dead_end",
    description: "Record a failed approach so future agents avoid repeating it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        reason: { type: "string" },
        files: { type: "array", items: { type: "string" } }
      },
      required: ["text"]
    }
  },
  {
    name: "attach_evidence",
    description: "Attach evidence such as test output, command output, notes, or links.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        content: { type: "string" },
        path: { type: "string" },
        command: { type: "string" },
        exitCode: { type: "number" }
      }
    }
  },
  {
    name: "record_source",
    description: "Record that a source file was inspected, including its current hash and conclusion.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        summary: { type: "string" },
        snippet: { type: "string" }
      },
      required: ["path"]
    }
  },
  {
    name: "source_status",
    description: "Check whether recorded source conclusions are still valid based on file hashes.",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "boolean" }
      }
    }
  },
  {
    name: "checkpoint",
    description: "Create an Agentpack checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        status: { type: "string" },
        nextActions: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "resume",
    description: "Generate a budgeted markdown resume.",
    inputSchema: {
      type: "object",
      properties: {
        budget: { type: "number" },
        preset: { type: "string" },
        query: { type: "string" }
      }
    }
  },
  {
    name: "diff",
    description: "Compare checkpoints.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" }
      }
    }
  },
  {
    name: "replay",
    description: "Replay the task timeline.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" }
      }
    }
  }
];

export function startMcpServer(startDir: string, input: Readable = process.stdin, output: Writable = process.stdout): void {
  const root = requirePackRoot(startDir);
  let buffer = "";

  input.setEncoding("utf8");
  input.on("data", (chunk: string | Buffer) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      handleMessage(root, line, output);
    }
  });
}

function handleMessage(root: string, line: string, output: Writable): void {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    send(output, null, null, { code: -32700, message: errorMessage(error) });
    return;
  }

  if (!request.id && request.method?.startsWith("notifications/")) {
    return;
  }

  try {
    const result = route(root, request.method, request.params || {});
    send(output, request.id, result);
  } catch (error) {
    send(output, request.id, null, { code: -32000, message: errorMessage(error) });
  }
}

function route(root: string, method: string | undefined, params: Record<string, unknown>): unknown {
  if (method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      },
      serverInfo: {
        name: "agentpack",
        version: "0.0.0"
      }
    };
  }

  if (method === "tools/list") {
    return { tools: TOOL_DEFINITIONS };
  }

  if (method === "tools/call") {
    return callTool(root, text(params.name), objectValue(params.arguments));
  }

  if (method === "resources/list") {
    return {
      resources: [
        {
          uri: "agentpack://resume/latest",
          name: "Latest Agentpack resume",
          mimeType: "text/markdown"
        }
      ]
    };
  }

  if (method === "resources/read") {
    const resume = buildResume(root, { budget: 4000 });
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: "text/markdown",
          text: resume.markdown
        }
      ]
    };
  }

  if (method === "prompts/list") {
    return {
      prompts: [
        {
          name: "agentpack_resume",
          description: "Resume work from Agentpack context."
        },
        {
          name: "agentpack_checkpoint",
          description: "Checkpoint meaningful progress into Agentpack."
        }
      ]
    };
  }

  if (method === "prompts/get") {
    return {
      description: "Agentpack workflow prompt",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Use Agentpack to load context before work and checkpoint decisions, dead ends, source conclusions, and evidence as you progress."
          }
        }
      ]
    };
  }

  throw new Error(`Unsupported MCP method: ${method}`);
}

function callTool(root: string, name: string, args: Record<string, unknown>): unknown {
  if (name === "load_context" || name === "resume") {
    const budget = resolveBudget({
      budget: numberValue(args.budget, 0),
      preset: text(args.preset)
    }, 4000);
    const resume = buildResume(root, { budget, query: text(args.query) });
    return toolText(resume.markdown);
  }

  if (name === "record_decision") {
    const event = appendEvent(root, "decision", {
      text: redactForRoot(root, text(args.text)),
      files: stringArray(args.files),
      evidence: stringArray(args.evidence)
    });
    return toolText(`Recorded decision ${event.id}.`);
  }

  if (name === "record_dead_end") {
    const event = appendEvent(root, "dead-end", {
      text: redactForRoot(root, text(args.text)),
      reason: redactForRoot(root, text(args.reason)),
      files: stringArray(args.files)
    });
    return toolText(`Recorded dead end ${event.id}.`);
  }

  if (name === "attach_evidence") {
    const event = addEvidence(root, {
      kind: text(args.kind),
      content: text(args.content),
      path: text(args.path),
      command: text(args.command),
      exitCode: numberValue(args.exitCode, Number.NaN)
    });
    return toolText(`Attached evidence ${event.id}.`);
  }

  if (name === "record_source") {
    const source = addSourceRecord(root, text(args.path), {
      summary: text(args.summary) || "Reviewed source.",
      snippet: text(args.snippet)
    });
    return toolText(`Recorded source ${source.path} (${source.hash.slice(0, 12)}).`);
  }

  if (name === "source_status") {
    if (booleanValue(args.json, false)) {
      return toolText(redactForRoot(root, JSON.stringify(getSourceStatuses(root), null, 2)));
    }
    return toolText(formatSourceStatuses(root));
  }

  if (name === "checkpoint") {
    const checkpoint = createCheckpoint(root, {
      summary: text(args.summary),
      status: text(args.status),
      nextActions: stringArray(args.nextActions)
    });
    return toolText(`Created checkpoint ${checkpoint.id}.`);
  }

  if (name === "diff") {
    const diff = diffCheckpoints(root, text(args.from) || undefined, text(args.to) || undefined);
    return toolText(redactForRoot(root, diff));
  }

  if (name === "replay") {
    const replay = replayEvents(root, numberValue(args.limit, 30));
    return toolText(redactForRoot(root, replay));
  }

  throw new Error(`Unknown tool: ${name}`);
}

function toolText(textValue: string): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: textValue
      }
    ]
  };
}

function send(output: Writable, id: JsonRpcRequest["id"], result: unknown, error: JsonRpcError | null = null): void {
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    id
  };

  if (error) {
    payload.error = error;
  } else {
    payload.result = result;
  }

  output.write(`${JSON.stringify(payload)}\n`);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
