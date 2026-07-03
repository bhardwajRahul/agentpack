import { existsSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendEvent,
  getPackPath,
  listCheckpoints,
  PACK_DIR_MODE,
  PACK_FILE_MODE,
  readEvents,
  readSources,
  withPackWriteLock
} from "./store.js";
import { listTasks, readPassport } from "./tasks.js";
import type { AgentpackEvent } from "./types.js";

export const DEFAULT_KEEP_CHECKPOINTS = 30;
export const DEFAULT_EVIDENCE_AGE_DAYS = 30;

const CHECKPOINT_HEAVY_FILES = ["diff.patch", "git-status.txt", "resume.md"];
const SOURCE_EVENT_TYPES = new Set(["source", "source-review", "source-prune"]);

export interface CompactOptions {
  keepCheckpoints?: number;
  evidenceAgeDays?: number;
  purge?: boolean;
}

export interface CompactPlan {
  keepCheckpoints: number;
  evidenceAgeDays: number;
  purge: boolean;
  checkpointsToSlim: string[];
  checkpointFilesToMove: number;
  checkpointBytes: number;
  eventsTotal: number;
  eventsToArchive: number;
  evidenceToArchive: string[];
  evidenceBytes: number;
}

export interface CompactResult {
  plan: CompactPlan;
  archiveDir: string | null;
  eventsFile: string | null;
}

export function buildCompactPlan(root: string, options: CompactOptions = {}): CompactPlan {
  const keepCheckpoints = normalizeCount(options.keepCheckpoints, DEFAULT_KEEP_CHECKPOINTS);
  const evidenceAgeDays = normalizeCount(options.evidenceAgeDays, DEFAULT_EVIDENCE_AGE_DAYS);
  const events = readEvents(root);

  const checkpointsToSlim: string[] = [];
  let checkpointFilesToMove = 0;
  let checkpointBytes = 0;
  const checkpoints = listCheckpoints(root);
  for (const checkpointId of checkpoints.slice(0, Math.max(checkpoints.length - keepCheckpoints, 0))) {
    const heavyFiles = CHECKPOINT_HEAVY_FILES
      .map((name) => getPackPath(root, "checkpoints", checkpointId, name))
      .filter((filePath) => existsSync(filePath));
    if (heavyFiles.length === 0) {
      continue;
    }
    checkpointsToSlim.push(checkpointId);
    checkpointFilesToMove += heavyFiles.length;
    checkpointBytes += heavyFiles.reduce((total, filePath) => total + statSync(filePath).size, 0);
  }

  const archivableEventIds = supersededSourceEventIds(root, events);

  const referencedEvidence = referencedEvidenceIds(root, events);
  const evidenceCutoff = Date.now() - evidenceAgeDays * 24 * 60 * 60 * 1000;
  const evidenceToArchive: string[] = [];
  let evidenceBytes = 0;
  for (const event of events) {
    if (event.type !== "evidence" || referencedEvidence.has(event.id)) {
      continue;
    }
    if (Date.parse(event.ts) >= evidenceCutoff) {
      continue;
    }
    const fileName = safeEvidenceFileName(event.path);
    if (!fileName) {
      continue;
    }
    const filePath = getPackPath(root, "evidence", fileName);
    // Event paths come from persisted (and importable) ledger data; only plain regular
    // files directly inside evidence/ may ever be moved or deleted.
    let stats;
    try {
      stats = lstatSync(filePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    evidenceToArchive.push(fileName);
    evidenceBytes += stats.size;
  }

  return {
    keepCheckpoints,
    evidenceAgeDays,
    purge: Boolean(options.purge),
    checkpointsToSlim,
    checkpointFilesToMove,
    checkpointBytes,
    eventsTotal: events.length,
    eventsToArchive: archivableEventIds.size,
    evidenceToArchive,
    evidenceBytes
  };
}

export function applyCompactPlan(root: string, options: CompactOptions = {}): CompactResult {
  return withPackWriteLock(root, () => {
    const plan = buildCompactPlan(root, options);
    if (plan.checkpointsToSlim.length === 0 && plan.eventsToArchive === 0 && plan.evidenceToArchive.length === 0) {
      return { plan, archiveDir: null, eventsFile: null };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveDir = plan.purge ? null : getPackPath(root, "archive");

    for (const checkpointId of plan.checkpointsToSlim) {
      for (const name of CHECKPOINT_HEAVY_FILES) {
        const filePath = getPackPath(root, "checkpoints", checkpointId, name);
        if (!existsSync(filePath)) {
          continue;
        }
        if (archiveDir) {
          moveIntoArchive(filePath, path.join(archiveDir, "checkpoints", checkpointId, name));
        } else {
          unlinkSync(filePath);
        }
      }
    }

    const events = readEvents(root);
    const archivableEventIds = supersededSourceEventIds(root, events);
    let eventsFile: string | null = null;
    if (archivableEventIds.size > 0) {
      const kept: string[] = [];
      const archived: string[] = [];
      for (const event of events) {
        (archivableEventIds.has(event.id) ? archived : kept).push(JSON.stringify(event));
      }
      if (archiveDir) {
        eventsFile = path.join(archiveDir, `events-${stamp}.jsonl`);
        mkdirSync(path.dirname(eventsFile), { recursive: true, mode: PACK_DIR_MODE });
        writeFileSync(eventsFile, archived.map((line) => `${line}\n`).join(""), { encoding: "utf8", mode: PACK_FILE_MODE });
      }
      const stagedPath = getPackPath(root, "cache", `.events-compact-${stamp}`);
      mkdirSync(path.dirname(stagedPath), { recursive: true, mode: PACK_DIR_MODE });
      writeFileSync(stagedPath, kept.map((line) => `${line}\n`).join(""), { encoding: "utf8", mode: PACK_FILE_MODE });
      renameSync(stagedPath, getPackPath(root, "events.jsonl"));
    }

    for (const fileName of plan.evidenceToArchive) {
      const filePath = getPackPath(root, "evidence", fileName);
      let stats;
      try {
        stats = lstatSync(filePath);
      } catch {
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      if (archiveDir) {
        moveIntoArchive(filePath, path.join(archiveDir, "evidence", fileName));
      } else {
        unlinkSync(filePath);
      }
    }

    appendEvent(root, "ledger-compact", {
      keepCheckpoints: plan.keepCheckpoints,
      evidenceAgeDays: plan.evidenceAgeDays,
      purge: plan.purge,
      checkpointsSlimmed: plan.checkpointsToSlim.length,
      eventsArchived: plan.eventsToArchive,
      evidenceArchived: plan.evidenceToArchive.length
    });

    return { plan, archiveDir, eventsFile };
  });
}

export function formatCompactPlan(plan: CompactPlan, applied: boolean): string {
  const nothing = plan.checkpointsToSlim.length === 0 && plan.eventsToArchive === 0 && plan.evidenceToArchive.length === 0;
  const verb = plan.purge ? "purge" : "archive";
  const lines = [
    applied ? `Ledger compact applied (${verb} mode)` : `Ledger compact plan (dry run, ${verb} mode)`,
    `- Checkpoints: keep newest ${plan.keepCheckpoints} full; slim ${plan.checkpointsToSlim.length} older snapshot(s), moving ${plan.checkpointFilesToMove} file(s), ${formatBytes(plan.checkpointBytes)} (checkpoint.json always stays)`,
    `- Events: ${verb} ${plan.eventsToArchive} superseded source-cache event(s) of ${plan.eventsTotal} total; decisions, dead ends, evidence, and checkpoints always stay`,
    `- Evidence: ${verb} ${plan.evidenceToArchive.length} unreferenced file(s) older than ${plan.evidenceAgeDays} day(s), ${formatBytes(plan.evidenceBytes)}`
  ];
  if (nothing) {
    lines.push("Nothing to compact.");
  } else if (!applied) {
    lines.push("To apply:", "  agentpack ledger compact --write");
  }
  return lines.join("\n");
}

// Keep the newest source-family event per path still present in sources.json; everything
// older is already reflected in sources.json and only inflates every future resume read.
function supersededSourceEventIds(root: string, events: AgentpackEvent[]): Set<string> {
  const currentPaths = new Set((readSources(root).sources || []).map((source) => source.path));
  const newestPerPath = new Map<string, string>();
  for (const event of events) {
    const eventPath = typeof event.path === "string" ? event.path : "";
    if ((event.type === "source" || event.type === "source-review") && currentPaths.has(eventPath)) {
      newestPerPath.set(eventPath, event.id);
    }
  }

  const archivable = new Set<string>();
  const keepIds = new Set(newestPerPath.values());
  for (const event of events) {
    if (SOURCE_EVENT_TYPES.has(event.type) && !keepIds.has(event.id)) {
      archivable.add(event.id);
    }
  }
  return archivable;
}

export function countFullCheckpoints(root: string): number {
  return listCheckpoints(root).filter((checkpointId) =>
    CHECKPOINT_HEAVY_FILES.some((name) => existsSync(getPackPath(root, "checkpoints", checkpointId, name)))
  ).length;
}

export function referencedEvidenceIds(root: string, events: AgentpackEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (Array.isArray(event.evidence)) {
      for (const evidenceId of event.evidence) {
        if (typeof evidenceId === "string" && evidenceId.length > 0) {
          ids.add(evidenceId);
        }
      }
    }
  }

  for (const task of listTasks(root)) {
    try {
      for (const evidenceId of readPassport(root, task.id).verification.evidence || []) {
        ids.add(evidenceId);
      }
    } catch {
      // Compaction must not fail on one unreadable passport; its evidence simply stays referenced-unknown and untouched.
    }
  }
  return ids;
}

function safeEvidenceFileName(eventPath: unknown): string | null {
  if (typeof eventPath !== "string" || !eventPath.startsWith("evidence/")) {
    return null;
  }
  const fileName = eventPath.slice("evidence/".length);
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
    return null;
  }
  return fileName;
}

function moveIntoArchive(sourcePath: string, targetPath: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true, mode: PACK_DIR_MODE });
  renameSync(sourcePath, targetPath);
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
