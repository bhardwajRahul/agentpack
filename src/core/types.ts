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

export type TaskStatus = "active" | "parked" | "blocked" | "verifying" | "completed" | "abandoned";
export type TaskRoleName = "scout" | "builder" | "reviewer" | "archivist";
export type TaskRoleStatus = "pending" | "active" | "done" | "blocked";
export type TaskRisk = "low" | "medium" | "high" | "unknown";

export interface TaskRoleState {
  status: TaskRoleStatus;
  summary: string;
}

export interface TaskVerification {
  status: "unknown" | "pending" | "passed" | "failed" | "accepted";
  evidence: string[];
  summary: string;
}

export interface TaskPassport {
  schemaVersion: number;
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  objective: string;
  constraints: string[];
  branch: string | null;
  baseHead: string | null;
  currentHead: string | null;
  worktree: string;
  writeScope: string[];
  risk: TaskRisk;
  roles: Partial<Record<TaskRoleName, TaskRoleState>>;
  verification: TaskVerification;
  nextActions: string[];
  tags: string[];
  blockedReason?: string;
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
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  aheadCommits: string[];
  status: string;
  diff: string;
}
