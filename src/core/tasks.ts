import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getGitInfo } from "./git.js";
import { normalizePath } from "./hash.js";
import { createId } from "./ids.js";
import {
  getPackPath,
  readJson,
  SCHEMA_VERSION,
  withPackWriteLock,
  writeJson
} from "./store.js";
import type { AgentpackEvent, TaskPassport, TaskRisk, TaskStatus, TaskVerification } from "./types.js";

export interface TaskStartOptions {
  title: string;
  objective?: string;
  constraints?: string[];
  writeScope?: string[];
  nextActions?: string[];
  tags?: string[];
  risk?: TaskRisk;
}

export interface TaskListItem {
  id: string;
  title: string;
  status: TaskStatus;
  branch: string | null;
  current: boolean;
  updatedAt: string;
  writeScope: string[];
}

export interface TaskVerificationUpdateOptions {
  status?: TaskVerification["status"] | string;
  evidence?: string[];
  summary?: string;
}

export interface TaskUpdateOptions {
  objective?: string;
  constraints?: string[];
  writeScope?: string[];
  nextActions?: string[];
  tags?: string[];
  risk?: TaskRisk;
}

export interface TaskAuditSourceStatus {
  path: string;
  status: "unchanged" | "changed" | "missing";
}

export interface TaskAuditIssue {
  level: "ok" | "warn";
  message: string;
  category?: "task" | "metadata";
}

export interface TaskAuditReport {
  passport: TaskPassport | null;
  issues: TaskAuditIssue[];
}

const CLOSED_STATUSES = new Set<TaskStatus>(["completed", "abandoned"]);
const VERIFICATION_STATUSES = new Set<TaskVerification["status"]>(["unknown", "pending", "passed", "failed", "accepted"]);

export function startTask(root: string, options: TaskStartOptions): TaskPassport {
  if (!options.title.trim()) {
    throw new Error("task start requires a title");
  }

  return withPackWriteLock(root, () => {
    ensureTasksDir(root);
    const currentTask = getCurrentPassport(root);
    if (currentTask && !CLOSED_STATUSES.has(currentTask.status) && currentTask.status !== "parked") {
      throw new Error(
        `Current task ${currentTask.id} is ${currentTask.status}; park or close it before starting a new task.`
      );
    }

    const now = new Date().toISOString();
    const git = getGitInfo(root);
    const id = createTaskId(options.title);
    const passport: TaskPassport = {
      schemaVersion: SCHEMA_VERSION,
      id,
      title: options.title.trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      objective: options.objective?.trim() || options.title.trim(),
      constraints: uniqueStrings(options.constraints || []),
      branch: git.branch,
      baseHead: git.head,
      currentHead: git.head,
      worktree: root,
      writeScope: normalizeWriteScope(root, options.writeScope || []),
      risk: options.risk || "unknown",
      roles: {},
      verification: {
        status: "unknown",
        evidence: [],
        summary: ""
      },
      nextActions: uniqueStrings(options.nextActions || []),
      tags: uniqueStrings(options.tags || [])
    };

    writePassport(root, passport);
    writeCurrentTaskId(root, passport.id);
    appendTaskEvent(root, passport.id, "task-start", {
      title: passport.title,
      status: passport.status,
      writeScope: passport.writeScope
    });
    return passport;
  });
}

export function listTasks(root: string): TaskListItem[] {
  const current = readCurrentTaskId(root);
  return listTaskIds(root)
    .map((id) => readPassport(root, id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((passport) => ({
      id: passport.id,
      title: passport.title,
      status: passport.status,
      branch: passport.branch,
      current: passport.id === current,
      updatedAt: passport.updatedAt,
      writeScope: passport.writeScope
    }));
}

export function getCurrentPassport(root: string): TaskPassport | null {
  const current = readCurrentTaskId(root);
  return current ? readPassport(root, current) : null;
}

export function readPassport(root: string, taskId: string): TaskPassport {
  const passport = readJson<TaskPassport | null>(passportPath(root, taskId), null);
  if (!passport) {
    throw new Error(`Task passport not found: ${taskId}`);
  }
  return passport;
}

export function switchTask(root: string, taskId: string): TaskPassport {
  return withPackWriteLock(root, () => {
    const passport = readPassport(root, taskId);
    if (CLOSED_STATUSES.has(passport.status)) {
      throw new Error(`Cannot switch to closed task ${taskId}`);
    }
    writeCurrentTaskId(root, passport.id);
    appendTaskEvent(root, passport.id, "task-switch", {
      status: passport.status
    });
    return passport;
  });
}

export function parkCurrentTask(root: string): TaskPassport {
  return updateCurrentTask(root, "parked", "task-park");
}

export function blockCurrentTask(root: string, reason = ""): TaskPassport {
  return updateCurrentTask(root, "blocked", "task-block", {
    blockedReason: reason
  });
}

export function updateCurrentTaskPassport(root: string, options: TaskUpdateOptions = {}): TaskPassport {
  return patchCurrentTask(root, "task-update", (existing) => {
    const objective = options.objective?.trim() || "";
    const constraints = uniqueStrings(options.constraints || []);
    const writeScope = normalizeWriteScope(root, options.writeScope || []);
    const nextActions = uniqueStrings(options.nextActions || []);
    const tags = uniqueStrings(options.tags || []);

    if (!hasTaskUpdate({ objective, constraints, writeScope, nextActions, tags }, options.risk)) {
      throw new Error("task update requires at least one non-empty field");
    }

    const patch: Partial<TaskPassport> = {};
    if (objective) {
      patch.objective = objective;
    }
    if (constraints.length > 0) {
      patch.constraints = mergeStringLists(existing.constraints, constraints);
    }
    if (writeScope.length > 0) {
      patch.writeScope = mergeStringLists(existing.writeScope, writeScope);
    }
    if (nextActions.length > 0) {
      patch.nextActions = mergeStringLists(existing.nextActions, nextActions);
    }
    if (tags.length > 0) {
      patch.tags = mergeStringLists(existing.tags, tags);
    }
    if (options.risk) {
      patch.risk = options.risk;
    }

    if (!changesTaskPassport(existing, patch)) {
      throw new Error("task update did not change the current task");
    }

    return patch;
  });
}

export function updateCurrentTaskVerification(root: string, options: TaskVerificationUpdateOptions = {}): TaskPassport {
  return updateCurrentTask(root, "verifying", "task-verify", (existing) => ({
    verification: {
      status: parseVerificationStatus(options.status),
      evidence: uniqueStrings([
        ...(existing.verification?.evidence || []),
        ...(options.evidence || [])
      ]),
      summary: options.summary === undefined
        ? existing.verification?.summary || ""
        : options.summary.trim()
    }
  }));
}

export function closeCurrentTask(root: string): TaskPassport {
  return updateCurrentTask(root, "completed", "task-close", {
    closedAt: new Date().toISOString()
  });
}

export function auditCurrentTask(root: string, sourceStatuses: TaskAuditSourceStatus[] = []): TaskAuditReport {
  const issues: TaskAuditIssue[] = [];
  let passport: TaskPassport | null;

  try {
    passport = getCurrentPassport(root);
  } catch (error) {
    return {
      passport: null,
      issues: [
        { level: "warn", message: `Cannot read current task passport: ${error instanceof Error ? error.message : String(error)}` }
      ]
    };
  }

  if (!passport) {
    return {
      passport,
      issues: [
        { level: "warn", message: "No current task passport. Run `agentpack task start <title>` before relying on task-scoped handoff." }
      ]
    };
  }

  const git = getGitInfo(root);
  const staleSources = sourceStatuses.filter((source) => source.status !== "unchanged");

  issues.push({ level: "ok", message: `Current task: ${passport.id} [${passport.status}] ${passport.title}` });

  if (CLOSED_STATUSES.has(passport.status)) {
    issues.push({ level: "warn", message: "Current task is closed. Start or switch to an open task before continuing work." });
  }

  if (!passport.nextActions.length) {
    issues.push({ level: "warn", message: "Task has no next actions." });
  }

  if (passport.verification.status === "unknown" || passport.verification.status === "pending") {
    issues.push({ level: "warn", message: `Verification is ${passport.verification.status}. Attach evidence or close the loop before handoff.` });
  }

  if (!passport.writeScope.length) {
    issues.push({ level: "warn", message: "Task has no write scope; future agents may not know the intended blast radius." });
  }

  if (git.available) {
    if (passport.branch && git.branch && passport.branch !== git.branch) {
      issues.push({ level: "warn", message: `Branch drift: passport branch is ${passport.branch}, current branch is ${git.branch}.` });
    }
    if (passport.currentHead && git.head && passport.currentHead !== git.head) {
      issues.push({ level: "warn", message: `HEAD drift: passport head is ${passport.currentHead}, current head is ${git.head}.` });
    }
  } else {
    issues.push({ level: "warn", message: "Git repository not detected; branch/head drift cannot be checked." });
  }

  if (!samePath(root, passport.worktree)) {
    issues.push({ level: "warn", message: "Worktree path differs from the current pack root; verify this passport belongs to this workspace." });
  }

  if (staleSources.length > 0) {
    issues.push({
      level: "warn",
      category: "metadata",
      message: `Source cache metadata has ${staleSources.length} changed or missing record(s): ${staleSources.map((source) => source.path).join(", ")}. Refresh only records whose durable conclusions changed.`
    });
  } else {
    issues.push({ level: "ok", category: "metadata", message: "No changed or missing recorded source conclusions." });
  }

  if (issues.filter((issue) => issue.category !== "metadata").every((issue) => issue.level === "ok")) {
    issues.push({ level: "ok", message: "No action-required task warnings." });
  }

  return { passport, issues };
}

export function formatTaskAuditReport(report: TaskAuditReport): string {
  const taskIssues = report.issues.filter((issue) => issue.category !== "metadata");
  const metadataIssues = report.issues.filter((issue) => issue.category === "metadata");
  return [
    "Task audit",
    ...taskIssues.map((issue) => `[${issue.level}] ${issue.message}`),
    ...(metadataIssues.length
      ? [
          "",
          "Metadata",
          ...metadataIssues.map((issue) => `[${issue.level}] ${issue.message}`)
        ]
      : [])
  ].join("\n");
}

export function formatCurrentTaskStatus(root: string): string {
  let passport: TaskPassport | null;

  try {
    passport = getCurrentPassport(root);
  } catch (error) {
    return [
      "Task status",
      `[warn] Cannot read current task passport: ${error instanceof Error ? error.message : String(error)}`
    ].join("\n");
  }

  if (!passport) {
    return [
      "Task status",
      "[warn] No current task passport. Run `agentpack task start <title>` before relying on task-scoped handoff."
    ].join("\n");
  }

  const git = getGitInfo(root);
  const drift = formatTaskDrift(passport, git);
  const nextAction = passport.nextActions[0] || "(none)";
  const writeScope = passport.writeScope.length > 0 ? passport.writeScope.join(", ") : "(none)";
  const verification = passport.verification?.status || "unknown";

  return [
    "Task status",
    `${passport.title} [${passport.status}]`,
    `ID: ${passport.id}`,
    `Branch: ${passport.branch || "(unknown)"}`,
    `Risk: ${passport.risk || "unknown"}`,
    `Verification: ${verification}`,
    `Next: ${nextAction}`,
    `Write scope: ${writeScope}`,
    `Drift: ${drift}`
  ].join("\n");
}

function formatTaskDrift(passport: TaskPassport, git: ReturnType<typeof getGitInfo>): string {
  if (!git.available) {
    return "git unavailable";
  }
  const issues: string[] = [];
  if (passport.branch && git.branch && passport.branch !== git.branch) {
    issues.push(`branch ${passport.branch} -> ${git.branch}`);
  }
  if (passport.currentHead && git.head && passport.currentHead !== git.head) {
    issues.push(`HEAD ${passport.currentHead} -> ${git.head}`);
  }
  return issues.length > 0 ? issues.join("; ") : "none";
}

function updateCurrentTask(
  root: string,
  status: TaskStatus,
  eventType: string,
  patch: Partial<TaskPassport> | ((existing: TaskPassport) => Partial<TaskPassport>) = {}
): TaskPassport {
  return patchCurrentTask(root, eventType, (existing) => ({
    ...(typeof patch === "function" ? patch(existing) : patch),
    status
  }));
}

function patchCurrentTask(
  root: string,
  eventType: string,
  patch: Partial<TaskPassport> | ((existing: TaskPassport) => Partial<TaskPassport>) = {}
): TaskPassport {
  return withPackWriteLock(root, () => {
    const current = readCurrentTaskId(root);
    if (!current) {
      throw new Error("No current task. Run `agentpack task start <title>` first.");
    }

    const existing = readPassport(root, current);
    if (CLOSED_STATUSES.has(existing.status)) {
      throw new Error(`Cannot update closed task ${current}`);
    }

    const now = new Date().toISOString();
    const git = getGitInfo(root);
    const resolvedPatch = typeof patch === "function" ? patch(existing) : patch;
    const passport: TaskPassport = {
      ...existing,
      ...resolvedPatch,
      currentHead: git.head,
      updatedAt: now
    };

    if (passport.status === "completed" || passport.status === "abandoned") {
      passport.closedAt = passport.closedAt || now;
    }

    writePassport(root, passport);
    appendTaskEvent(root, passport.id, eventType, {
      status: passport.status,
      objective: passport.objective,
      writeScope: passport.writeScope,
      nextActions: passport.nextActions,
      risk: passport.risk,
      reason: passport.blockedReason || "",
      verificationStatus: passport.verification.status,
      evidence: passport.verification.evidence
    });
    return passport;
  });
}

function hasTaskUpdate(options: Omit<TaskUpdateOptions, "risk">, risk: TaskRisk | undefined): boolean {
  return Boolean(
    options.objective ||
    risk !== undefined ||
    (options.constraints && options.constraints.length > 0) ||
    (options.writeScope && options.writeScope.length > 0) ||
    (options.nextActions && options.nextActions.length > 0) ||
    (options.tags && options.tags.length > 0)
  );
}

function mergeStringLists(existing: string[], incoming: string[] | undefined): string[] {
  return uniqueStrings([...existing, ...(incoming || [])]);
}

function changesTaskPassport(existing: TaskPassport, patch: Partial<TaskPassport>): boolean {
  return Boolean(
    (patch.objective !== undefined && patch.objective !== existing.objective) ||
    (patch.risk !== undefined && patch.risk !== existing.risk) ||
    (patch.constraints !== undefined && !sameStringList(patch.constraints, existing.constraints)) ||
    (patch.writeScope !== undefined && !sameStringList(patch.writeScope, existing.writeScope)) ||
    (patch.nextActions !== undefined && !sameStringList(patch.nextActions, existing.nextActions)) ||
    (patch.tags !== undefined && !sameStringList(patch.tags, existing.tags))
  );
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parseVerificationStatus(value: TaskVerificationUpdateOptions["status"]): TaskVerification["status"] {
  const status = String(value || "pending");
  if (VERIFICATION_STATUSES.has(status as TaskVerification["status"])) {
    return status as TaskVerification["status"];
  }
  throw new Error(`Unknown verification status: ${status}`);
}

function createTaskId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  return `${createId("task")}_${slug}`;
}

function ensureTasksDir(root: string): void {
  mkdirSync(getPackPath(root, "tasks"), { recursive: true });
}

function listTaskIds(root: string): string[] {
  const tasksPath = getPackPath(root, "tasks");
  if (!existsSync(tasksPath)) {
    return [];
  }

  return readdirSync(tasksPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(passportPath(root, entry.name)))
    .map((entry) => entry.name);
}

function passportPath(root: string, taskId: string): string {
  return getPackPath(root, "tasks", taskId, "passport.json");
}

function taskEventsPath(root: string, taskId: string): string {
  return getPackPath(root, "tasks", taskId, "events.jsonl");
}

function currentTaskPath(root: string): string {
  return getPackPath(root, "tasks", "current");
}

function readCurrentTaskId(root: string): string | null {
  const filePath = currentTaskPath(root);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, "utf8").trim() || null;
}

function writeCurrentTaskId(root: string, taskId: string): void {
  ensureTasksDir(root);
  writeFileSync(currentTaskPath(root), `${taskId}\n`, "utf8");
}

function writePassport(root: string, passport: TaskPassport): void {
  const taskPath = getPackPath(root, "tasks", passport.id);
  mkdirSync(path.join(taskPath, "checkpoints"), { recursive: true });
  mkdirSync(path.join(taskPath, "evidence"), { recursive: true });
  mkdirSync(path.join(taskPath, "exports"), { recursive: true });
  if (!existsSync(taskEventsPath(root, passport.id))) {
    writeFileSync(taskEventsPath(root, passport.id), "", "utf8");
  }
  writeJson(passportPath(root, passport.id), passport);
}

function appendTaskEvent(root: string, taskId: string, type: string, payload: Record<string, unknown>): AgentpackEvent {
  const event: AgentpackEvent = {
    id: createId("evt"),
    ts: new Date().toISOString(),
    type,
    ...payload
  };
  writeFileSync(taskEventsPath(root, taskId), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "a"
  });
  return event;
}

function normalizeWriteScope(root: string, writeScope: string[]): string[] {
  return uniqueStrings(writeScope.map((item) => {
    const absolutePath = path.resolve(root, item);
    const relativePath = path.relative(root, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing write scope outside project root: ${item}`);
    }
    return normalizePath(relativePath || ".");
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
