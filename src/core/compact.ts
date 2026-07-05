import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createId } from "./ids.js";
import {
  getPackPath,
  listCheckpoints,
  PACK_DIR_MODE,
  PACK_FILE_MODE,
  readEvents,
  readSources,
  withPackWriteLock
} from "./store.js";
import { listTaskIds, readPassport } from "./tasks.js";
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

  const referencedEvidence = referencedEvidenceIds(root, events, { strict: true });
  // Referenced-ness is tracked by event id, but removal is keyed by file name; a crafted
  // second event aliasing a referenced file's path must not make that file removable.
  const referencedFileNames = new Set<string>();
  for (const event of events) {
    if (event.type !== "evidence" || !referencedEvidence.has(event.id)) {
      continue;
    }
    const fileName = safeEvidenceFileName(event.path);
    if (fileName) {
      referencedFileNames.add(fileName);
    }
  }

  const evidenceCutoff = Date.now() - evidenceAgeDays * 24 * 60 * 60 * 1000;
  const evidenceToArchive: string[] = [];
  const plannedFileNames = new Set<string>();
  let evidenceBytes = 0;
  for (const event of events) {
    if (event.type !== "evidence" || referencedEvidence.has(event.id)) {
      continue;
    }
    const eventTime = Date.parse(event.ts);
    // A malformed timestamp means unknown age, and unknown is never old enough to remove.
    if (!Number.isFinite(eventTime) || eventTime >= evidenceCutoff) {
      continue;
    }
    const fileName = safeEvidenceFileName(event.path);
    if (!fileName || referencedFileNames.has(fileName) || plannedFileNames.has(fileName)) {
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
    plannedFileNames.add(fileName);
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
    const events = readEvents(root);
    const archivableEventIds = supersededSourceEventIds(root, events);
    let eventsFile: string | null = null;
    const cacheDir = getPackPath(root, "cache");
    assertSafePackDirectoryChain(root, cacheDir);
    if (archiveDir) {
      assertSafePackDirectoryChain(root, archiveDir);
    }
    const transactionDir = path.join(cacheDir, `.compact-${createId("txn")}`);
    mkdirSync(transactionDir, { mode: PACK_DIR_MODE });
    const moves: Array<{ source: string; staged: string; target: string | null; location: "source" | "staged" | "target" }> = [];
    const eventsPath = getPackPath(root, "events.jsonl");
    const eventsBackup = path.join(transactionDir, "events.original.jsonl");
    const stagedEvents = path.join(transactionDir, "events.next.jsonl");
    const stagedArchivedEvents = path.join(transactionDir, "events.archived.jsonl");
    let eventsBackedUp = false;
    let eventsReplaced = false;
    let archivedEventsInstalled = false;

    try {
      const kept: string[] = [];
      const archived: string[] = [];
      for (const event of events) {
        (archivableEventIds.has(event.id) ? archived : kept).push(JSON.stringify(event));
      }
      kept.push(JSON.stringify({
        id: createId("evt"),
        ts: new Date().toISOString(),
        type: "ledger-compact",
        keepCheckpoints: plan.keepCheckpoints,
        evidenceAgeDays: plan.evidenceAgeDays,
        purge: plan.purge,
        checkpointsSlimmed: plan.checkpointsToSlim.length,
        eventsArchived: plan.eventsToArchive,
        evidenceArchived: plan.evidenceToArchive.length
      }));
      writeFileSync(stagedEvents, kept.map((line) => `${line}\n`).join(""), { encoding: "utf8", mode: PACK_FILE_MODE });
      if (archivableEventIds.size > 0) {
        writeFileSync(stagedArchivedEvents, archived.map((line) => `${line}\n`).join(""), { encoding: "utf8", mode: PACK_FILE_MODE });
        if (archiveDir) {
          eventsFile = path.join(archiveDir, `events-${stamp}.jsonl`);
          prepareArchiveTarget(root, eventsFile);
        }
      }

      for (const checkpointId of plan.checkpointsToSlim) {
        for (const name of CHECKPOINT_HEAVY_FILES) {
          const source = getPackPath(root, "checkpoints", checkpointId, name);
          if (!existsSync(source)) {
            continue;
          }
          const target = archiveDir ? path.join(archiveDir, "checkpoints", checkpointId, name) : null;
          if (target) {
            prepareArchiveTarget(root, target);
          }
          moves.push({ source, staged: path.join(transactionDir, `item-${moves.length}`), target, location: "source" });
        }
      }
      for (const fileName of plan.evidenceToArchive) {
        const source = getPackPath(root, "evidence", fileName);
        let stats;
        try {
          stats = lstatSync(source);
        } catch {
          continue;
        }
        if (!stats.isFile()) {
          continue;
        }
        const target = archiveDir ? path.join(archiveDir, "evidence", fileName) : null;
        if (target) {
          prepareArchiveTarget(root, target);
        }
        moves.push({ source, staged: path.join(transactionDir, `item-${moves.length}`), target, location: "source" });
      }

      for (const move of moves) {
        renameSync(move.source, move.staged);
        move.location = "staged";
      }

      renameSync(eventsPath, eventsBackup);
      eventsBackedUp = true;
      renameSync(stagedEvents, eventsPath);
      eventsReplaced = true;
      if (eventsFile && archiveDir) {
        renameSync(stagedArchivedEvents, eventsFile);
        archivedEventsInstalled = true;
      }

      if (archiveDir) {
        for (const move of moves) {
          if (!move.target) {
            continue;
          }
          renameSync(move.staged, move.target);
          move.location = "target";
        }
      }

      rmSync(transactionDir, { recursive: true, force: true });
      return { plan, archiveDir, eventsFile };
    } catch (error) {
      let rollbackFailed = false;
      if (eventsBackedUp) {
        try {
          if (eventsReplaced && pathEntryExists(eventsPath)) {
            unlinkSync(eventsPath);
          }
          renameSync(eventsBackup, eventsPath);
        } catch {
          rollbackFailed = true;
        }
      }
      if (archivedEventsInstalled && eventsFile) {
        try {
          unlinkSync(eventsFile);
        } catch {
          rollbackFailed = true;
        }
      }
      for (const move of [...moves].reverse()) {
        try {
          if (move.location === "target" && move.target) {
            renameSync(move.target, move.source);
          } else if (move.location === "staged") {
            renameSync(move.staged, move.source);
          }
        } catch {
          rollbackFailed = true;
        }
      }
      if (!rollbackFailed) {
        rmSync(transactionDir, { recursive: true, force: true });
      }
      if (rollbackFailed) {
        throw new Error(`Ledger compact failed and rollback was incomplete; recovery files remain at ${transactionDir}. Original error: ${String(error)}`);
      }
      throw error;
    }
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

export function referencedEvidenceIds(
  root: string,
  events: AgentpackEvent[],
  options: { strict?: boolean } = {}
): Set<string> {
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

  for (const taskId of listTaskIds(root)) {
    try {
      for (const evidenceId of readPassport(root, taskId).verification.evidence || []) {
        ids.add(evidenceId);
      }
    } catch {
      // An unreadable passport hides which evidence it references. Compaction (strict) must
      // fail closed rather than treat that evidence as unreferenced and removable; diagnostic
      // callers like ledger status stay best-effort.
      if (options.strict) {
        throw new Error(
          `Task passport ${taskId} is unreadable; cannot determine its referenced evidence. Fix or remove the passport before compacting.`
        );
      }
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

function prepareArchiveTarget(root: string, targetPath: string): void {
  const parent = path.dirname(targetPath);
  assertSafePackDirectoryChain(root, parent);
  mkdirSync(parent, { recursive: true, mode: PACK_DIR_MODE });
  assertSafePackDirectoryChain(root, parent);
  if (pathEntryExists(targetPath)) {
    throw new Error(`Ledger compact refuses to overwrite archive target: ${targetPath}`);
  }
}

function assertSafePackDirectoryChain(root: string, directory: string): void {
  const packRoot = getPackPath(root);
  const relative = path.relative(packRoot, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Ledger compact path escapes .agentpack: ${directory}`);
  }
  let current = packRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!pathEntryExists(current)) {
      break;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Ledger compact refuses unsafe directory: ${current}`);
    }
  }
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
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
