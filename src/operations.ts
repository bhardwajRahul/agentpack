import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getFileRecord, normalizePath, sha256File } from "./core/hash.js";
import { getGitInfo } from "./core/git.js";
import { listTasks, readPassport } from "./core/tasks.js";
import {
  appendEvent,
  getPackPath,
  listCheckpoints,
  PACK_DIR_MODE,
  PACK_FILE_MODE,
  readEvents,
  readSources,
  withPackWriteLock,
  writeSources
} from "./core/store.js";
import { createId } from "./core/ids.js";
import { redactForRoot } from "./core/redaction.js";
import type { AgentpackEvent, SourceRecord, TaskStatus } from "./core/types.js";

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
  gitStatus: string | null;
}

export type SourceStatusKind = SourceStatus["status"];

export interface LedgerStatus {
  tasks: Record<TaskStatus, number>;
  events: {
    count: number;
    bytes: number;
  };
  evidence: {
    files: number;
    bytes: number;
    events: number;
    referenced: number;
    unreferenced: number;
    oldest: string | null;
  };
  checkpoints: {
    count: number;
    bytes: number;
    oldest: string | null;
  };
  exports: {
    files: number;
    bytes: number;
  };
  sources: {
    recorded: number;
    unchanged: number;
    changed: number;
    missing: number;
  };
}

export function addSourceRecord(root: string, filePath: string, options: SourceRecordOptions = {}): SourceRecord {
  return writeSourceRecord(root, filePath, {
    summary: options.summary || "Reviewed source.",
    snippet: options.snippet || "",
    eventType: "source"
  });
}

export function reviewSourceRecord(root: string, filePath: string, options: SourceRecordOptions = {}): SourceRecord {
  const summary = (options.summary || "").trim();
  if (!summary) {
    throw new Error("source review requires --summary <text>; changed source conclusions must be refreshed by semantic review, not hash-only refresh.");
  }

  return writeSourceRecord(root, filePath, {
    summary,
    snippet: options.snippet || "",
    eventType: "source-review"
  });
}

function writeSourceRecord(
  root: string,
  filePath: string,
  options: { summary: string; snippet: string; eventType: "source" | "source-review" }
): SourceRecord {
  return withPackWriteLock(root, () => {
    const source = getFileRecord(root, filePath, {
      summary: redactForRoot(root, options.summary),
      snippet: redactForRoot(root, options.snippet)
    });
    const state = readSources(root);
    const existing = state.sources.findIndex((item) => item.path === source.path);

    if (existing >= 0) {
      state.sources[existing] = source;
    } else {
      state.sources.push(source);
    }

    writeSources(root, state);
    appendEvent(root, options.eventType, {
      path: source.path,
      hash: source.hash,
      summary: source.summary
    });
    return source;
  });
}

export function removeSourceRecord(root: string, filePath: string): SourceRecord {
  return withPackWriteLock(root, () => {
    const normalizedPath = normalizeSourcePath(root, filePath);
    const state = readSources(root);
    const existing = state.sources.findIndex((source) => source.path === normalizedPath);

    if (existing < 0) {
      throw new Error(`No source record found for ${normalizedPath}`);
    }

    const removed = state.sources[existing];
    if (!removed) {
      throw new Error(`No source record found for ${normalizedPath}`);
    }

    state.sources.splice(existing, 1);
    writeSources(root, state);
    appendEvent(root, "source-remove", {
      path: removed.path,
      hash: removed.hash
    });
    return removed;
  });
}

export function pruneMissingSourceRecords(root: string): SourceRecord[] {
  return withPackWriteLock(root, () => {
    const state = readSources(root);
    const removed: SourceRecord[] = [];
    const kept: SourceRecord[] = [];

    for (const source of state.sources || []) {
      if (existsSync(path.join(root, source.path))) {
        kept.push(source);
      } else {
        removed.push(source);
      }
    }

    if (removed.length === 0) {
      return removed;
    }

    state.sources = kept;
    writeSources(root, state);
    appendEvent(root, "source-prune", {
      mode: "missing",
      count: removed.length,
      paths: removed.map((source) => source.path)
    });
    return removed;
  });
}

export function addEvidence(root: string, options: EvidenceOptions = {}): AgentpackEvent {
  const kind = options.kind || "note";
  const content = redactForRoot(root, readEvidenceContent(root, options));
  const id = createId("ev");
  const extension = kind === "json" ? "json" : "txt";
  const evidencePath = path.join("evidence", `${id}.${extension}`);
  const absolutePath = getPackPath(root, evidencePath);
  const exitCode = options.exitCode === undefined || options.exitCode === null ? null : Number(options.exitCode);

  mkdirSync(path.dirname(absolutePath), { recursive: true, mode: PACK_DIR_MODE });
  writeFileSync(absolutePath, content, { encoding: "utf8", mode: PACK_FILE_MODE });

  return appendEvent(root, "evidence", {
    kind,
    path: evidencePath,
    command: redactForRoot(root, options.command || ""),
    exitCode: Number.isFinite(exitCode) ? exitCode : null
  });
}

function normalizeSourcePath(root: string, inputPath: string): string {
  const absolutePath = path.resolve(root, inputPath);
  const relativePath = path.relative(root, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to remove source record outside project root: ${inputPath}`);
  }

  return normalizePath(relativePath);
}

export function getSourceStatus(root: string, filePath: string): SourceStatus | null {
  const normalizedPath = normalizeSourcePath(root, filePath);
  return getSourceStatuses(root).find((source) => source.path === normalizedPath) || null;
}

export function getSourceStatuses(root: string, filters: SourceStatusKind[] = []): SourceStatus[] {
  const sources = readSources(root).sources || [];
  const gitStatuses = getGitStatuses(root);
  const filterSet = new Set(filters);

  const statuses: SourceStatus[] = sources.map((source) => {
    const absolutePath = path.join(root, source.path);
    const currentHash = existsSync(absolutePath) ? sha256File(absolutePath) : null;
    const status: SourceStatusKind = currentHash === null
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
      recordedAt: source.recordedAt,
      gitStatus: gitStatuses.get(source.path) || null
    };
  });

  if (filterSet.size === 0) {
    return statuses;
  }

  return statuses.filter((source) => filterSet.has(source.status));
}

export function formatSourceStatuses(root: string, filters: SourceStatusKind[] = []): string {
  const allStatuses = getSourceStatuses(root);
  const statuses = filters.length > 0
    ? allStatuses.filter((source) => filters.includes(source.status))
    : allStatuses;
  const gitStatuses = getGitStatuses(root);

  if (allStatuses.length === 0) {
    return formatNoSourceRecords(gitStatuses);
  }

  if (statuses.length === 0) {
    return `No ${formatStatusFilter(filters)} source records.`;
  }

  const recordedPaths = new Set(allStatuses.map((source) => source.path));
  const unrecordedGitChanges = [...gitStatuses.entries()]
    .filter(([filePath]) => !recordedPaths.has(filePath))
    .map(([filePath, status]) => `- ${status} ${filePath}`);

  const sourceBlocks = statuses.map((source) => {
    const guidance = source.status === "unchanged"
      ? "do not re-open unless needed"
      : "re-open before relying on prior conclusions";

    return [
      `${source.status.toUpperCase()} ${source.path}`,
      `  summary: ${source.summary || "No summary recorded."}`,
      `  recorded: ${source.recordedAt}`,
      `  hash: ${formatHashStatus(source.status)}`,
      `  git: ${source.gitStatus || "clean"}`,
      `  meaning: ${formatSourceMeaning(source.status)}`,
      `  guidance: ${guidance}`
    ].join("\n");
  });

  const blocks = [
    "Agentpack source status tracks recorded source conclusions, not the full git working tree.",
    ...sourceBlocks
  ];

  if (unrecordedGitChanges.length > 0) {
    blocks.push([
      "Git changes not recorded as Agentpack sources:",
      ...unrecordedGitChanges
    ].join("\n"));
  }

  return redactForRoot(root, blocks.join("\n\n"));
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

export function getLedgerStatus(root: string): LedgerStatus {
  const events = readEvents(root);
  const evidenceEvents = events.filter((event) => event.type === "evidence");
  const referencedEvidence = referencedEvidenceIds(root, events);
  const sourceCounts = countSourceStatuses(getSourceStatuses(root));
  const checkpoints = listCheckpoints(root);
  const evidenceStats = directoryStats(getPackPath(root, "evidence"));
  const checkpointStats = directoryStats(getPackPath(root, "checkpoints"));
  const exportStats = directoryStats(getPackPath(root, "exports"));

  return {
    tasks: countTasks(root),
    events: {
      count: events.length,
      bytes: fileSize(getPackPath(root, "events.jsonl"))
    },
    evidence: {
      files: evidenceStats.files,
      bytes: evidenceStats.bytes,
      events: evidenceEvents.length,
      referenced: evidenceEvents.filter((event) => referencedEvidence.has(event.id)).length,
      unreferenced: evidenceEvents.filter((event) => !referencedEvidence.has(event.id)).length,
      oldest: oldestTimestamp(evidenceEvents)
    },
    checkpoints: {
      count: checkpoints.length,
      bytes: checkpointStats.bytes,
      oldest: checkpoints[0] || null
    },
    exports: {
      files: exportStats.files,
      bytes: exportStats.bytes
    },
    sources: sourceCounts
  };
}

export function formatLedgerStatus(root: string): string {
  const status = getLedgerStatus(root);
  return [
    "Ledger status",
    `Tasks: ${status.tasks.active} active, ${status.tasks.parked} parked, ${status.tasks.blocked} blocked, ${status.tasks.verifying} verifying, ${status.tasks.completed} completed, ${status.tasks.abandoned} abandoned`,
    `Events: ${status.events.count} entries, ${formatBytes(status.events.bytes)}`,
    `Evidence: ${status.evidence.files} files, ${formatBytes(status.evidence.bytes)} (${status.evidence.events} events, ${status.evidence.referenced} referenced, ${status.evidence.unreferenced} unreferenced)`,
    `Checkpoints: ${status.checkpoints.count} snapshots, ${formatBytes(status.checkpoints.bytes)}`,
    `Exports: ${status.exports.files} files, ${formatBytes(status.exports.bytes)}`,
    `Sources: ${status.sources.recorded} recorded, ${status.sources.unchanged} unchanged, ${status.sources.changed} changed, ${status.sources.missing} missing`,
    status.evidence.oldest ? `Oldest evidence: ${status.evidence.oldest}` : "Oldest evidence: none",
    status.checkpoints.oldest ? `Oldest checkpoint: ${status.checkpoints.oldest}` : "Oldest checkpoint: none",
    "",
    "No cleanup was performed."
  ].join("\n");
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

function countTasks(root: string): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    active: 0,
    parked: 0,
    blocked: 0,
    verifying: 0,
    completed: 0,
    abandoned: 0
  };

  for (const task of listTasks(root)) {
    counts[task.status] += 1;
  }

  return counts;
}

function referencedEvidenceIds(root: string, events: AgentpackEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    for (const evidenceId of evidenceIdsFromEvent(event)) {
      ids.add(evidenceId);
    }
  }

  for (const task of listTasks(root)) {
    try {
      for (const evidenceId of readPassport(root, task.id).verification.evidence || []) {
        ids.add(evidenceId);
      }
    } catch {
      // Ledger status is diagnostic-only; unreadable task details should not crash the whole inventory.
    }
  }
  return ids;
}

function evidenceIdsFromEvent(event: AgentpackEvent): string[] {
  if (!Array.isArray(event.evidence)) {
    return [];
  }

  return event.evidence.filter(
    (evidenceId): evidenceId is string => typeof evidenceId === "string" && evidenceId.length > 0
  );
}

function countSourceStatuses(statuses: SourceStatus[]): LedgerStatus["sources"] {
  const counts = {
    recorded: statuses.length,
    unchanged: 0,
    changed: 0,
    missing: 0
  };

  for (const source of statuses) {
    counts[source.status] += 1;
  }

  return counts;
}

function directoryStats(dirPath: string): { files: number; bytes: number } {
  if (!existsSync(dirPath)) {
    return { files: 0, bytes: 0 };
  }

  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = directoryStats(entryPath);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(entryPath).size;
    }
  }
  return { files, bytes };
}

function fileSize(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0;
}

function oldestTimestamp(events: AgentpackEvent[]): string | null {
  const timestamps = events.map((event) => event.ts).filter(Boolean).sort();
  return timestamps[0] || null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function formatNoSourceRecords(gitStatuses: Map<string, string>): string {
  const lines = [
    "No source records yet. Use `agentpack source add <file> --summary <text>` after inspecting important files."
  ];

  if (gitStatuses.size > 0) {
    lines.push(
      "",
      "Git changes not recorded as Agentpack sources:",
      ...[...gitStatuses.entries()].map(([filePath, status]) => `- ${status} ${filePath}`)
    );
  }

  return lines.join("\n");
}

function formatStatusFilter(filters: SourceStatusKind[]): string {
  if (filters.length === 0) {
    return "matching";
  }
  return filters.join(" or ");
}

function formatHashStatus(status: SourceStatus["status"]): string {
  if (status === "unchanged") {
    return "matches recorded hash";
  }
  if (status === "missing") {
    return "file missing";
  }
  return "differs from recorded hash";
}

function formatSourceMeaning(status: SourceStatus["status"]): string {
  if (status === "unchanged") {
    return "recorded summary is valid for the current file content";
  }
  if (status === "missing") {
    return "recorded file is missing; prior summary may only be useful as history";
  }
  return "recorded summary may be stale because file content changed";
}

function getGitStatuses(root: string): Map<string, string> {
  const git = getGitInfo(root);
  const statuses = new Map<string, string>();

  if (!git.available || !git.status) {
    return statuses;
  }

  for (const line of git.status.split("\n")) {
    const parsed = parseGitStatusLine(line);
    if (parsed) {
      statuses.set(parsed.path, parsed.status);
    }
  }

  return statuses;
}

function parseGitStatusLine(line: string): { path: string; status: string } | null {
  if (line.length < 4) {
    return null;
  }

  const code = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() || rawPath : rawPath;
  return {
    path: filePath,
    status: gitStatusLabel(code)
  };
}

function gitStatusLabel(code: string): string {
  if (code.includes("?")) {
    return "untracked";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  if (code.includes("R")) {
    return "renamed";
  }
  if (code.includes("A")) {
    return "added";
  }
  if (code.includes("M")) {
    return "modified";
  }
  return "changed";
}
