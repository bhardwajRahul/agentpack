import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getFileRecord, sha256File } from "./core/hash.js";
import {
  appendEvent,
  getPackPath,
  readEvents,
  readSources,
  writeSources
} from "./core/store.js";
import { createId } from "./core/ids.js";
import { redactForRoot } from "./core/redaction.js";
import type { AgentpackEvent, SourceRecord } from "./core/types.js";

interface SourceRecordOptions {
  summary?: string;
  snippet?: string;
}

interface EvidenceOptions {
  kind?: string;
  content?: string;
  text?: string;
  file?: string;
  path?: string;
  command?: string;
  exitCode?: number | string | null;
}

export interface SourceStatus {
  path: string;
  status: "unchanged" | "changed" | "missing";
  summary: string;
  recordedHash: string;
  currentHash: string | null;
  recordedAt: string;
}

export function addSourceRecord(root: string, filePath: string, options: SourceRecordOptions = {}): SourceRecord {
  const source = getFileRecord(root, filePath, {
    summary: redactForRoot(root, options.summary || "Reviewed source."),
    snippet: redactForRoot(root, options.snippet || "")
  });
  const state = readSources(root);
  const existing = state.sources.findIndex((item) => item.path === source.path);

  if (existing >= 0) {
    state.sources[existing] = source;
  } else {
    state.sources.push(source);
  }

  writeSources(root, state);
  appendEvent(root, "source", {
    path: source.path,
    hash: source.hash,
    summary: source.summary
  });
  return source;
}

export function addEvidence(root: string, options: EvidenceOptions = {}): AgentpackEvent {
  const kind = options.kind || "note";
  const content = redactForRoot(root, readEvidenceContent(root, options));
  const id = createId("ev");
  const extension = kind === "json" ? "json" : "txt";
  const evidencePath = path.join("evidence", `${id}.${extension}`);
  const absolutePath = getPackPath(root, evidencePath);
  const exitCode = options.exitCode === undefined || options.exitCode === null ? null : Number(options.exitCode);

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");

  return appendEvent(root, "evidence", {
    kind,
    path: evidencePath,
    command: redactForRoot(root, options.command || ""),
    exitCode: Number.isFinite(exitCode) ? exitCode : null
  });
}

export function getSourceStatuses(root: string): SourceStatus[] {
  const sources = readSources(root).sources || [];

  return sources.map((source) => {
    const absolutePath = path.join(root, source.path);
    const currentHash = existsSync(absolutePath) ? sha256File(absolutePath) : null;
    const status = currentHash === null
      ? "missing"
      : currentHash === source.hash
        ? "unchanged"
        : "changed";

    return {
      path: source.path,
      status,
      summary: source.summary || "",
      recordedHash: source.hash,
      currentHash,
      recordedAt: source.recordedAt
    };
  });
}

export function formatSourceStatuses(root: string): string {
  const statuses = getSourceStatuses(root);

  if (statuses.length === 0) {
    return "No source records yet. Use `agentpack source add <file> --summary <text>` after inspecting important files.";
  }

  return redactForRoot(root, statuses.map((source) => {
    const guidance = source.status === "unchanged"
      ? "do not re-open unless needed"
      : "re-open before relying on prior conclusions";

    return [
      `${source.status.toUpperCase()} ${source.path}`,
      `  summary: ${source.summary || "No summary recorded."}`,
      `  recorded: ${source.recordedAt}`,
      `  guidance: ${guidance}`
    ].join("\n");
  }).join("\n\n"));
}

export function replayEvents(root: string, limit = 50): string {
  const events = readEvents(root).slice(-Number(limit || 50));
  if (!events.length) {
    return "No Agentpack events yet.";
  }

  return events.map((event) => {
    const label = event.text || event.summary || event.kind || event.path || event.checkpointId || "";
    return `${event.ts} [${event.type}] ${label}`.trim();
  }).join("\n");
}

function readEvidenceContent(root: string, options: EvidenceOptions): string {
  const inputPath = options.file || options.path;
  if (inputPath) {
    const absolutePath = path.resolve(root, inputPath);
    const relativePath = path.relative(root, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing to attach evidence outside project root: ${inputPath}`);
    }
    return readFileSync(absolutePath, "utf8");
  }

  return String(options.content || options.text || "");
}
