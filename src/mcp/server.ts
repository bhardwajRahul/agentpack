import { appendEvent, requirePackRoot } from "../core/store.js";
import { buildResume } from "../core/resume.js";
import { createCheckpoint, diffCheckpoints } from "../core/checkpoints.js";
import {
  exportTaskBundle,
  formatBundleExportResult,
  formatBundleImportPlan,
  formatBundleImportResult,
  formatBundleInspectResult,
  importTaskBundle,
  inspectTaskBundle,
  planTaskBundleImport
} from "../core/bundles.js";
import { buildReleasePreflightReport } from "../core/release.js";
import { addEvidence, addSourceRecord, formatSourceStatuses, getSourceStatuses, replayEvents, type SourceStatusKind } from "../operations.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { BUDGET_PRESET_NAMES, isBudgetPreset, resolveBudget, type BudgetPreset } from "../core/presets.js";
import { evaluateGate } from "../core/gate.js";
import { redactForRoot } from "../core/redaction.js";
import {
  auditCurrentTask,
  finalizeAdvisories,
  finalizeCurrentTask,
  formatCurrentTaskHandoff,
  formatCurrentTaskStatus,
  formatTaskAuditReport,
  formatTaskList,
  formatTaskRoleResult,
  getCurrentTaskRole,
  listTasks,
  parkCurrentTask,
  startTask,
  switchTask,
  TASK_ROLE_NAMES,
  TASK_ROLE_STATUSES,
  type TaskStartOptions,
  type TaskUpdateOptions,
  updateCurrentTaskPassport,
  updateCurrentTaskRole,
  updateCurrentTaskVerification
} from "../core/tasks.js";

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
    description: "Load a token-budgeted markdown resume of Agentpack state for the current task: Task Passport status and next actions, git state, query-relevant decisions, dead ends, and source conclusions, plus gate warnings when the task lifecycle needs attention. Call once at the start of a session or task, before reading code; re-call only for a different query or budget. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Focused free-text query for the current task. Matching source records keep full summaries; unrelated records collapse to compact stubs to save tokens."
        },
        budget: {
          type: "number",
          description: "Approximate token budget for the resume. Takes precedence over preset. Default 4000."
        },
        preset: {
          type: "string",
          enum: BUDGET_PRESET_NAMES,
          description: "Named token budget: quick (1200), chat (4000), agent (8000), or deep (16000). Use quick for task-start orientation."
        }
      }
    }
  },
  {
    name: "record_decision",
    description: "Append a durable technical or product decision to the Agentpack ledger so future sessions inherit it. Call for decisions that matter beyond this session (architecture, contracts, tradeoffs), not for routine preferences or per-edit narration. Writes one event under .agentpack/; secret-like values are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The decision and its rationale, in one or two sentences."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths the decision applies to."
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Evidence ids (from attach_evidence) supporting the decision."
        }
      },
      required: ["text"]
    }
  },
  {
    name: "record_dead_end",
    description: "Record an approach that failed so future agents do not repeat it. Call when an attempted direction is abandoned for a durable reason, not for ordinary debugging iterations. Writes one event under .agentpack/; secret-like values are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The approach that was tried and abandoned."
        },
        reason: {
          type: "string",
          description: "Why it failed or must not be retried."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths involved in the failed approach."
        }
      },
      required: ["text"]
    }
  },
  {
    name: "attach_evidence",
    description: "Store verification output (test results, command output, review findings, notes, or links) as a file under .agentpack/evidence/ plus a ledger event, returning an evidence id to reference from task_update_verification, task_finalize, or record_decision. Call for meaningful verification worth preserving; for small tasks prefer one aggregated evidence item over many per-command items. Provide the body inline via content or from a file via path.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Free-form label such as test, command, note, link, or json. Defaults to note; kind json stores the file with a .json extension."
        },
        content: {
          type: "string",
          description: "Inline evidence body. Ignored when path is set."
        },
        path: {
          type: "string",
          description: "Repo-relative path to an existing file whose contents become the evidence body (alternative to content)."
        },
        command: {
          type: "string",
          description: "Command that produced the output, stored as metadata."
        },
        exitCode: {
          type: "number",
          description: "Exit code of that command, stored as metadata."
        }
      }
    }
  },
  {
    name: "record_source",
    description: "Record a durable conclusion about a source file in the Source Cache: stores the file's current content hash with your summary so future sessions can reuse the conclusion until the file changes. Call after inspecting an important file when the conclusion is reusable; do not record every file read, and re-record only when the conclusion itself changed. Writes under .agentpack/.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repo-relative path of the inspected file."
        },
        summary: {
          type: "string",
          description: "Durable conclusion about the file. Always provide one; the fallback is a generic 'Reviewed source.'"
        },
        snippet: {
          type: "string",
          description: "Optional short excerpt worth keeping with the conclusion."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "source_status",
    description: "Check whether recorded source conclusions are unchanged, changed, or missing by re-hashing the files; use changed/missing filters for stale source-cache triage. Call when you need a full stale-source check beyond what load_context already showed; do not repeat it when a recent load_context, task_audit, or status check answered the question. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        },
        changed: {
          type: "boolean",
          description: "Only report sources whose content hash changed since recorded."
        },
        missing: {
          type: "boolean",
          description: "Only report recorded sources whose files no longer exist."
        }
      }
    }
  },
  {
    name: "task_audit",
    description: "Audit the current Task Passport for continuity risks: stale or missing sources, branch/head drift, worktree mismatch, missing next actions or write scope, and open verification. Call before finalizing, after a long gap, or when drift is suspected; skip when a recent audit already answered it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      }
    }
  },
  {
    name: "release_preflight",
    description: "Report local release readiness: release metadata, Trusted Publisher wiring, and the manual release-prep commands. Read-only — never pushes, tags, publishes, or creates GitHub Releases. Call when preparing a release, not during routine work.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "bundle_export",
    description: "Export one Task Passport with its decisions, dead ends, source conclusions, and optionally evidence to a redacted agentpack.task-bundle JSON file, for sharing tasks across repos, machines, or agents. Writes only the new bundle file at outputPath; pack state is unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task Passport id to export. Defaults to the current task."
        },
        outputPath: {
          type: "string",
          description: "Destination bundle file: must be a new repo-relative path outside .agentpack/ and .git/; existing files and symlink escapes are rejected."
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative source paths whose Source Cache records to include."
        },
        includeEvidence: {
          type: "boolean",
          description: "Include referenced evidence file contents. Defaults to true."
        }
      },
      required: ["outputPath"]
    }
  },
  {
    name: "bundle_inspect",
    description: "Validate and summarize an untrusted task bundle file: schema and digest status, origin, included records, and warnings. Read-only — never writes pack state. Call before planning or applying an import of a bundle you did not produce.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the bundle JSON file to inspect."
        },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "bundle_import_plan",
    description: "Plan a task bundle import against this pack without writing anything: returns create, idempotent, or conflict actions with an explicit read-only guarantee. Call to preview exactly what bundle_import with write: true would do.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the bundle JSON file to plan against this pack."
        },
        asNew: {
          type: "boolean",
          description: "Preview importing under a deterministic new task id instead of the bundle's original id (resolves id collisions)."
        },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "bundle_import",
    description: "Import a task bundle into this pack. By default it only returns the read-only import plan; nothing is written unless write is true. A write import runs under a pack lock, creates a parked task with local verification reset to unknown, retains the bundle and an import manifest, and never changes the current-task pointer. Inspect or plan untrusted bundles first.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the bundle JSON file to import."
        },
        write: {
          type: "boolean",
          description: "Apply the import. When false or omitted, only the read-only plan is returned."
        },
        asNew: {
          type: "boolean",
          description: "Resolve a task-id collision by importing under a deterministic new id."
        },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "task_handoff",
    description: "Generate a compact handoff for the current Task Passport — objective, constraints, write scope, next actions, verification, drift, and audit summary — so another chat, client, worktree, or agent can continue the work. Call before switching contexts. Read-only.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "task_start",
    description: "Create a new Task Passport and make it current, persisting it under .agentpack/. Call when starting a coherent phase of work and no task is active; it refuses to replace an active, blocked, or verifying current task — park or finalize that task first. Declare writeScope so the task gate can protect the task's boundaries.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short imperative task title."
        },
        objective: {
          type: "string",
          description: "What done looks like for this task."
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Rules the work must respect."
        },
        writeScope: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths or globs this task is allowed to modify."
        },
        nextActions: {
          type: "array",
          items: { type: "string" },
          description: "Initial concrete next steps."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form labels for grouping tasks."
        },
        risk: {
          type: "string",
          enum: ["unknown", "low", "medium", "high"],
          description: "Risk level of the task."
        }
      },
      required: ["title"]
    }
  },
  {
    name: "task_status",
    description: "Print a quick summary of the current Task Passport (status, objective, next actions, verification) plus gate warnings, without scanning the source cache. Call for a fast lifecycle check; use task_audit for the full continuity audit. Read-only.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "task_role",
    description: "Read focused guidance and current state for one Task Passport role lane, or update the lane by passing both status and summary. Role state is advisory metadata inside the current passport: it does not start agents, grant write authority, or change task lifecycle or verification. Without status and summary the call is read-only; updates write to the passport, and identical retries are no-ops.",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: TASK_ROLE_NAMES,
          description: "Role lane to read or update."
        },
        status: {
          type: "string",
          enum: TASK_ROLE_STATUSES,
          description: "New lane status; requires summary in the same call."
        },
        summary: {
          type: "string",
          description: "Durable summary of the lane's state; requires status in the same call."
        },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      },
      required: ["role"]
    }
  },
  {
    name: "task_list",
    description: "List all Task Passports with id, status, title, and branch; the current task is marked with an asterisk. Call to find a task id for task_switch or to review open work. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      }
    }
  },
  {
    name: "task_switch",
    description: "Make another open Task Passport current by id; a parked target resumes as active. Park or finalize a different active, blocked, or verifying current task first; closed tasks cannot be switched to. Updates the current-task pointer under .agentpack/.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Task Passport id to switch to (see task_list)."
        }
      },
      required: ["id"]
    }
  },
  {
    name: "task_park",
    description: "Mark the current Task Passport parked so unrelated work can start without finalizing it. Use for intentionally deferred work: parking preserves verification state and the task can be resumed later with task_switch. Do not park to skip verification of finished work; use task_finalize to close it instead.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "task_update_verification",
    description: "Update the current Task Passport verification state. A final verdict (passed, failed, or accepted) moves the task lifecycle to verifying; pending or unknown returns it to active. Call after attach_evidence so the verdict is evidence-backed; identical repeated calls are no-ops.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["unknown", "pending", "passed", "failed", "accepted"],
          description: "Verification status to set."
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Evidence ids from attach_evidence backing this verdict."
        },
        summary: {
          type: "string",
          description: "Short summary of what was verified and how."
        }
      }
    }
  },
  {
    name: "task_finalize",
    description: "Close the current Task Passport. Requires verification to already be passed, failed, or accepted, or that final status passed explicitly via status. Use task_park for deferred work instead of closing it; accepted finalization with remaining next actions requires force. Returns non-blocking hygiene advisories (uncommitted in-scope changes, remaining next actions, missing checkpoint).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["passed", "failed", "accepted"],
          description: "Final verification status to set while closing."
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Evidence ids from attach_evidence backing the final verdict."
        },
        summary: {
          type: "string",
          description: "Closing summary; mention relevant commit hashes here."
        },
        force: {
          type: "boolean",
          description: "Allow accepted finalization even though next actions remain."
        }
      }
    }
  },
  {
    name: "task_update",
    description: "Patch the current Task Passport without changing lifecycle status. List fields (constraints, writeScope, nextActions, tags) append and deduplicate; omitted fields are preserved; empty or no-op updates fail. Pass clearNextActions to replace the next-actions list instead of appending, e.g. to clear a stale plan before finalizing.",
    inputSchema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "Replacement objective text."
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Constraints to append."
        },
        writeScope: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths or globs to append to the write scope."
        },
        nextActions: {
          type: "array",
          items: { type: "string" },
          description: "Next steps to append, or the full replacement list when clearNextActions is true."
        },
        clearNextActions: {
          type: "boolean",
          description: "Replace the next actions with the provided nextActions (or clear them) instead of appending."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form labels to append."
        },
        risk: {
          type: "string",
          enum: ["unknown", "low", "medium", "high"],
          description: "New risk level for the task."
        }
      }
    }
  },
  {
    name: "checkpoint",
    description: "Save a durable progress checkpoint under .agentpack/checkpoints, capturing summary and git state (branch, commit, diff) and updating the pack-level status and next actions that seed the next session's load_context. Call after meaningful progress, before ending a session, or before risky changes — not after every small step.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What was accomplished and decided since the last checkpoint."
        },
        status: {
          type: "string",
          description: "Current overall status line, replacing the previous one."
        },
        nextActions: {
          type: "array",
          items: { type: "string" },
          description: "Concrete next steps, replacing the previous list when non-empty."
        }
      }
    }
  },
  {
    name: "resume",
    description: "Generate the same token-budgeted markdown resume as load_context: Task Passport state, git state, query-relevant records, and gate warnings. Prefer load_context at task start; use resume for ad-hoc re-reads with a different query or budget mid-session. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        budget: {
          type: "number",
          description: "Approximate token budget for the resume. Takes precedence over preset. Default 4000."
        },
        preset: {
          type: "string",
          enum: BUDGET_PRESET_NAMES,
          description: "Named token budget: quick (1200), chat (4000), agent (8000), or deep (16000)."
        },
        query: {
          type: "string",
          description: "Focused free-text query. Matching source records keep full summaries; unrelated records collapse to compact stubs."
        }
      }
    }
  },
  {
    name: "diff",
    description: "Compare two checkpoints, showing their summaries, status lines, and git refs side by side. Defaults to comparing the previous checkpoint against the latest. Call to see what changed between sessions. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Checkpoint id to compare from. Defaults to the second-most-recent checkpoint."
        },
        to: {
          type: "string",
          description: "Checkpoint id to compare to. Defaults to the latest checkpoint."
        }
      }
    }
  },
  {
    name: "replay",
    description: "Print a chronological timeline of recent Agentpack ledger events (decisions, dead ends, evidence, source records, checkpoints, task events), one line per event with timestamp and type. Call to audit how the task history unfolded when a resume is not enough; not part of the routine load_context/checkpoint loop. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of most recent events to show. Defaults to 30."
        }
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
        version: readPackageVersion()
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
    const preset = mcpBudgetPreset(args.preset);
    const budget = resolveBudget({
      budget: numberValue(args.budget, 0),
      ...(preset ? { preset } : {})
    }, 4000);
    const resume = buildResume(root, { budget, query: text(args.query) });
    return toolText(appendGateWarnings(root, resume.markdown));
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
    const filters = sourceStatusFilters(args);
    if (booleanValue(args.json, false)) {
      return toolText(redactForRoot(root, JSON.stringify(getSourceStatuses(root, filters), null, 2)));
    }
    return toolText(formatSourceStatuses(root, filters));
  }

  if (name === "task_audit") {
    const report = auditCurrentTask(root, getSourceStatuses(root));
    if (booleanValue(args.json, false)) {
      return toolText(redactForRoot(root, JSON.stringify(report, null, 2)));
    }
    return toolText(redactForRoot(root, formatTaskAuditReport(report)));
  }

  if (name === "release_preflight") {
    const report = buildReleasePreflightReport(root);
    return toolText(redactForRoot(root, report.text));
  }

  if (name === "bundle_export") {
    const result = exportTaskBundle(root, {
      taskId: text(args.taskId) || "current",
      outputPath: text(args.outputPath),
      sourcePaths: stringArray(args.sources),
      includeEvidence: booleanValue(args.includeEvidence, true),
      producerVersion: readPackageVersion()
    });
    return toolText(redactForRoot(root, formatBundleExportResult(result)));
  }

  if (name === "bundle_inspect") {
    const result = inspectTaskBundle(text(args.path));
    if (booleanValue(args.json, false)) {
      return toolText(JSON.stringify(result, null, 2));
    }
    return toolText(formatBundleInspectResult(result));
  }

  if (name === "bundle_import_plan") {
    const plan = planTaskBundleImport(root, text(args.path), { asNew: booleanValue(args.asNew, false) });
    if (booleanValue(args.json, false)) {
      return toolText(JSON.stringify(plan, null, 2));
    }
    return toolText(formatBundleImportPlan(plan));
  }

  if (name === "bundle_import") {
    const options = { asNew: booleanValue(args.asNew, false) };
    if (!booleanValue(args.write, false)) {
      const plan = planTaskBundleImport(root, text(args.path), options);
      if (booleanValue(args.json, false)) {
        return toolText(JSON.stringify(plan, null, 2));
      }
      return toolText(formatBundleImportPlan(plan));
    }
    const result = importTaskBundle(root, text(args.path), options);
    if (booleanValue(args.json, false)) {
      return toolText(JSON.stringify(result, null, 2));
    }
    return toolText(formatBundleImportResult(result));
  }

  if (name === "task_handoff") {
    return toolText(redactForRoot(root, formatCurrentTaskHandoff(root, getSourceStatuses(root))));
  }

  if (name === "task_start") {
    const startOptions: TaskStartOptions = {
      title: redactForRoot(root, text(args.title)),
      constraints: stringArray(args.constraints).map((item) => redactForRoot(root, item)),
      writeScope: stringArray(args.writeScope),
      nextActions: stringArray(args.nextActions).map((item) => redactForRoot(root, item)),
      tags: stringArray(args.tags)
    };
    const objective = redactForRoot(root, text(args.objective));
    const risk = taskRisk(args.risk);
    if (objective) {
      startOptions.objective = objective;
    }
    if (risk) {
      startOptions.risk = risk;
    }
    const passport = startTask(root, startOptions);
    return toolText(`Started task ${passport.id}.`);
  }

  if (name === "task_status") {
    return toolText(appendGateWarnings(root, redactForRoot(root, formatCurrentTaskStatus(root))));
  }

  if (name === "task_role") {
    const role = text(args.role);
    const status = text(args.status);
    const summary = text(args.summary);
    if (Boolean(status) !== Boolean(summary)) {
      throw new Error("task_role updates require both status and summary");
    }
    const result = status && summary
      ? updateCurrentTaskRole(root, role, status, redactForRoot(root, summary))
      : getCurrentTaskRole(root, role);
    if (booleanValue(args.json, false)) {
      return toolText(redactForRoot(root, JSON.stringify(result, null, 2)));
    }
    return toolText(redactForRoot(root, formatTaskRoleResult(result)));
  }

  if (name === "task_list") {
    const tasks = listTasks(root);
    if (tasks.length === 0) {
      return toolText("No task passports yet. Call `task_start` first.");
    }
    if (booleanValue(args.json, false)) {
      return toolText(redactForRoot(root, JSON.stringify(tasks, null, 2)));
    }
    return toolText(redactForRoot(root, formatTaskList(tasks)));
  }

  if (name === "task_switch") {
    const taskId = text(args.id).trim();
    if (!taskId) {
      throw new Error("task_switch requires a task id");
    }
    const passport = switchTask(root, taskId);
    return toolText(`Switched to task ${passport.id} (${passport.status}).`);
  }

  if (name === "task_park") {
    const passport = parkCurrentTask(root);
    return toolText(`Parked task ${passport.id}.`);
  }

  if (name === "task_update_verification") {
    const result = updateCurrentTaskVerification(root, {
      status: text(args.status),
      evidence: stringArray(args.evidence),
      summary: redactForRoot(root, text(args.summary))
    });
    const { passport } = result;
    if (!result.changed) {
      return toolText(`Verification unchanged for task ${passport.id} (${passport.verification.status}).`);
    }
    return toolText(`Updated verification for task ${passport.id} (${passport.verification.status}).`);
  }

  if (name === "task_finalize") {
    const passport = finalizeCurrentTask(root, {
      status: text(args.status),
      evidence: stringArray(args.evidence),
      summary: redactForRoot(root, text(args.summary)),
      force: booleanValue(args.force, false)
    });
    const advisories = finalizeAdvisories(root, passport);
    const advisoryText = advisories.length > 0
      ? `\n\nAdvisories:\n${advisories.map((advisory) => `- ${advisory}`).join("\n")}`
      : "";
    return toolText(`Finalized task ${passport.id} (${passport.verification.status}).${advisoryText}`);
  }

  if (name === "task_update") {
    const updateOptions: TaskUpdateOptions = {
      constraints: stringArray(args.constraints).map((item) => redactForRoot(root, item)),
      writeScope: stringArray(args.writeScope),
      nextActions: stringArray(args.nextActions).map((item) => redactForRoot(root, item)),
      tags: stringArray(args.tags)
    };
    const objective = redactForRoot(root, text(args.objective));
    const risk = taskRisk(args.risk);
    if (objective) {
      updateOptions.objective = objective;
    }
    if (risk) {
      updateOptions.risk = risk;
    }
    if (booleanValue(args.clearNextActions, false)) {
      updateOptions.clearNextActions = true;
    }
    const passport = updateCurrentTaskPassport(root, updateOptions);
    return toolText(`Updated task ${passport.id}.`);
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

// MCP-warn layer: state-reading tools carry current gate findings so any MCP client sees
// lifecycle/drift warnings without needing client-specific hooks.
function appendGateWarnings(root: string, body: string): string {
  try {
    const report = evaluateGate(root, {});
    if (report.findings.length === 0) {
      return body;
    }
    const lines = report.findings.map((finding) => `- [${finding.level}] ${finding.message}`);
    return `${body}\n\n## Gate Warnings\n${lines.join("\n")}`;
  } catch {
    return body;
  }
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

function mcpBudgetPreset(value: unknown): BudgetPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !isBudgetPreset(value)) {
    throw new Error(`Unknown budget preset: ${String(value)}. Expected one of: ${BUDGET_PRESET_NAMES.join(", ")}.`);
  }

  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sourceStatusFilters(args: Record<string, unknown>): SourceStatusKind[] {
  const filters: SourceStatusKind[] = [];
  if (booleanValue(args.changed, false)) {
    filters.push("changed");
  }
  if (booleanValue(args.missing, false)) {
    filters.push("missing");
  }
  return filters;
}

function taskRisk(value: unknown): "low" | "medium" | "high" | "unknown" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "unknown" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`Unknown task risk: ${String(value)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
