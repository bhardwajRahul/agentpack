export interface AgentpackConfig {
  schemaVersion: number;
  projectName: string;
  redactions: string[];
  defaultBudget: number;
  includeGitDiff: boolean;
}

export interface AgentpackState {
  schemaVersion: number;
  goal: string | null;
  currentStatus: string;
  nextActions: string[];
  currentCheckpoint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  recordedAt: string;
  summary: string;
  snippet: string;
}

export interface SourcesFile {
  schemaVersion: number;
  sources: SourceRecord[];
}

export interface AgentpackEvent {
  id: string;
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface GitInfo {
  available: boolean;
  topLevel?: string;
  branch: string | null;
  head: string | null;
  status: string;
  diff: string;
}
