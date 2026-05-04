import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createId } from "./ids.js";
import type { AgentpackEvent, AgentpackState, SourcesFile } from "./types.js";

export const PACK_DIR = ".agentpack";
export const SCHEMA_VERSION = 1;

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
  const entry = `${PACK_DIR}/`;
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());

  if (lines.includes(entry) || lines.includes(PACK_DIR)) {
    return;
  }

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, `${existing}${prefix}${entry}\n`, "utf8");
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
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  writeJson(getPackPath(root, "state.json"), {
    ...state,
    updatedAt: new Date().toISOString()
  });
}

export function readSources(root: string): SourcesFile {
  return readJson<SourcesFile>(getPackPath(root, "sources.json"), { schemaVersion: SCHEMA_VERSION, sources: [] });
}

export function writeSources(root: string, sources: SourcesFile): void {
  writeJson(getPackPath(root, "sources.json"), sources);
}

export function appendEvent(root: string, type: string, payload: Record<string, unknown> = {}): AgentpackEvent {
  const event = {
    id: createId("evt"),
    ts: new Date().toISOString(),
    type,
    ...payload
  };

  writeFileSync(getPackPath(root, "events.jsonl"), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "a"
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
