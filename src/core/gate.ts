import path from "node:path";
import { getGitBranchState, listStagedFiles } from "./git.js";
import { normalizePath } from "./hash.js";
import { getPackPath, readJson } from "./store.js";
import { getCurrentPassport } from "./tasks.js";
import type { AgentpackConfig, GateMode, TaskStatus } from "./types.js";

export type GateDecision = "allow" | "warn" | "block";

export interface GateFinding {
  code: "no-active-task" | "task-not-active" | "out-of-scope" | "branch-drift" | "passport-unreadable";
  level: "warn" | "block";
  message: string;
}

export interface GateReport {
  mode: GateMode;
  decision: GateDecision;
  taskId: string | null;
  taskStatus: TaskStatus | null;
  findings: GateFinding[];
}

export interface GateOptions {
  files?: string[];
  staged?: boolean;
  mode?: GateMode;
}

export function evaluateGate(root: string, options: GateOptions = {}): GateReport {
  const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
  const mode = options.mode || config.gateMode || "warn";

  if (mode === "off") {
    return { mode, decision: "allow", taskId: null, taskStatus: null, findings: [] };
  }

  const violation = (code: GateFinding["code"], message: string): GateFinding => ({
    code,
    level: mode === "block" ? "block" : "warn",
    message
  });
  const findings: GateFinding[] = [];
  let taskId: string | null = null;
  let taskStatus: TaskStatus | null = null;

  let passport: ReturnType<typeof getCurrentPassport> = null;
  try {
    passport = getCurrentPassport(root);
  } catch (error) {
    findings.push({
      code: "passport-unreadable",
      level: "warn",
      message: `Cannot read current task passport: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  const files = collectGateFiles(root, options);

  if (passport) {
    taskId = passport.id;
    taskStatus = passport.status;

    if (passport.status !== "active") {
      findings.push(violation("task-not-active", taskNotActiveMessage(passport.status)));
    }

    if (passport.writeScope.length > 0 && files.length > 0) {
      const outOfScope = files.filter((file) => !isInWriteScope(file, passport.writeScope));
      if (outOfScope.length > 0) {
        findings.push(violation(
          "out-of-scope",
          `Outside the task write scope: ${outOfScope.join(", ")}. Extend the scope with \`agentpack task update --write-scope <path>\`, switch tasks, or start the right task.`
        ));
      }
    }

    if (passport.branch) {
      const git = getGitBranchState(root);
      if (git.available && git.branch && git.branch !== passport.branch) {
        // Branch drift stays advisory even in block mode; head drift is left to `task audit` because
        // every commit during normal work moves HEAD.
        findings.push({
          code: "branch-drift",
          level: "warn",
          message: `Branch drift: task ${passport.id} was started on ${passport.branch}, current branch is ${git.branch}.`
        });
      }
    }
  } else if (findings.length === 0) {
    findings.push(violation(
      "no-active-task",
      "No current task passport. Start one with `agentpack task start <title>` before editing code."
    ));
  }

  const decision: GateDecision = findings.some((finding) => finding.level === "block")
    ? "block"
    : findings.length > 0
      ? "warn"
      : "allow";

  return { mode, decision, taskId, taskStatus, findings };
}

export function formatGateReport(report: GateReport): string {
  if (report.findings.length === 0) {
    return "Gate: ok";
  }
  const lines = report.findings.map((finding) => `- [${finding.level}] ${finding.message}`);
  return [`Gate: ${report.decision} (mode: ${report.mode})`, ...lines].join("\n");
}

function collectGateFiles(root: string, options: GateOptions): string[] {
  const files: string[] = [];
  if (options.staged) {
    files.push(...listStagedFiles(root));
  }
  for (const file of options.files || []) {
    const absolutePath = path.resolve(root, file);
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      continue;
    }
    files.push(relativePath);
  }
  return [...new Set(files.map((file) => normalizePath(file)))];
}

function isInWriteScope(file: string, writeScope: string[]): boolean {
  return writeScope.some((entry) => entry === "." || file === entry || file.startsWith(`${entry}/`));
}

function taskNotActiveMessage(status: TaskStatus): string {
  if (status === "verifying") {
    return "Current task is verifying. Finish or record verification before editing code, or park it for unrelated work.";
  }
  if (status === "parked") {
    return "Current task is parked. Switch to it, or start the task this work belongs to.";
  }
  if (status === "blocked") {
    return "Current task is blocked. Resolve or park it before editing code.";
  }
  return "Current task is closed. Start or switch to an open task before editing code.";
}
