import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createId } from "./ids.js";
import type { AgentpackEvent, AgentpackState, SourcesFile } from "./types.js";

export const PACK_DIR = ".agentpack";
export const SCHEMA_VERSION = 1;
export const AGENTPACK_IGNORE_PATTERNS = [
  `${PACK_DIR}/`,
  ".codex",
  ".claude",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md"
];

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;
const heldLocks = new Set<string>();
const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);

export function findPackRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(current, PACK_DIR))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function requirePackRoot(startDir: string): string {
  const root = findPackRoot(startDir);
  if (!root) {
    throw new Error("No .agentpack directory found. Run `agentpack init` first.");
  }
  return root;
}

export function initPack(root: string): string {
  const packPath = path.join(root, PACK_DIR);
  const now = new Date().toISOString();

  mkdirSync(packPath, { recursive: true });
  for (const dir of ["checkpoints", "evidence", "instructions", "exports", "cache"]) {
    mkdirSync(path.join(packPath, dir), { recursive: true });
  }

  writeJsonIfMissing(path.join(packPath, "config.json"), {
    schemaVersion: SCHEMA_VERSION,
    projectName: path.basename(root),
    redactions: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN"
    ],
    defaultBudget: 4000,
    includeGitDiff: true
  });

  writeJsonIfMissing(path.join(packPath, "state.json"), {
    schemaVersion: SCHEMA_VERSION,
    goal: null,
    currentStatus: "Initialized Agentpack.",
    nextActions: [],
    currentCheckpoint: null,
    createdAt: now,
    updatedAt: now
  });

  writeJsonIfMissing(path.join(packPath, "sources.json"), {
    schemaVersion: SCHEMA_VERSION,
    sources: []
  });

  if (!existsSync(path.join(packPath, "events.jsonl"))) {
    writeFileSync(path.join(packPath, "events.jsonl"), "", "utf8");
  }

  ensurePackIgnored(root);

  return packPath;
}

export function ensurePackIgnored(root: string): void {
  const gitignorePath = path.join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = AGENTPACK_IGNORE_PATTERNS.filter((pattern) => !hasIgnorePattern(lines, pattern));

  if (!missing.length) {
    return;
  }

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
}

function hasIgnorePattern(lines: string[], pattern: string): boolean {
  const normalized = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  return lines.some((line) => {
    const normalizedLine = line.endsWith("/") ? line.slice(0, -1) : line;
    return normalizedLine === normalized;
  });
}

export function getPackPath(root: string, ...parts: string[]): string {
  return path.join(root, PACK_DIR, ...parts);
}

export function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function writeJson(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonIfMissing(filePath: string, value: unknown): void {
  if (!existsSync(filePath)) {
    writeJson(filePath, value);
  }
}

export function readState(root: string): AgentpackState {
  const state = readJson<AgentpackState | null>(getPackPath(root, "state.json"), null);
  if (!state) {
    throw new Error("Agentpack state.json is missing. Run `agentpack init` again.");
  }
  return state;
}

export function writeState(root: string, state: AgentpackState): void {
  withPackWriteLock(root, () => {
    writeJson(getPackPath(root, "state.json"), {
      ...state,
      updatedAt: new Date().toISOString()
    });
  });
}

export function readSources(root: string): SourcesFile {
  return readJson<SourcesFile>(getPackPath(root, "sources.json"), { schemaVersion: SCHEMA_VERSION, sources: [] });
}

export function writeSources(root: string, sources: SourcesFile): void {
  withPackWriteLock(root, () => {
    writeJson(getPackPath(root, "sources.json"), sources);
  });
}

export function appendEvent(root: string, type: string, payload: Record<string, unknown> = {}): AgentpackEvent {
  const event = {
    id: createId("evt"),
    ts: new Date().toISOString(),
    type,
    ...payload
  };

  withPackWriteLock(root, () => {
    writeFileSync(getPackPath(root, "events.jsonl"), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a"
    });
  });

  return event;
}

export function readEvents(root: string): AgentpackEvent[] {
  const content = readFileSync(getPackPath(root, "events.jsonl"), "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentpackEvent);
}

export function listCheckpoints(root: string): string[] {
  const checkpointsPath = getPackPath(root, "checkpoints");
  if (!existsSync(checkpointsPath)) {
    return [];
  }

  return readdirSync(checkpointsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function withPackWriteLock<T>(root: string, fn: () => T): T {
  const lockPath = getPackPath(root, ".lock");

  if (heldLocks.has(lockPath)) {
    return fn();
  }

  acquireLock(lockPath);
  heldLocks.add(lockPath);

  try {
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    releaseLock(lockPath);
  }
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

function acquireLock(lockPath: string): void {
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }

      removeStaleLock(lockPath);

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Agentpack state lock: ${lockPath}`);
      }

      sleepSync(25);
    }
  }
}

function releaseLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
}

function removeStaleLock(lockPath: string): void {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > STALE_LOCK_MS) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
