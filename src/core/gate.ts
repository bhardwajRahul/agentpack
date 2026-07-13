import path from "node:path";
import { getGitBranchState, listStagedFiles } from "./git.js";
import { normalizePath } from "./hash.js";
import { getPackPath, readJson } from "./store.js";
import { getCurrentPassport, isInWriteScope } from "./tasks.js";
import type { AgentpackConfig, GateMode, TaskStatus } from "./types.js";

export type GateDecision = "allow" | "warn" | "block";

export interface GateFinding {
  code:
    | "no-active-task"
    | "task-not-active"
    | "out-of-scope"
    | "branch-drift"
    | "config-unreadable"
    | "passport-unreadable"
    | "invalid-gate-mode"
    | "no-write-scope"
    | "outside-root"
    | "hook-input-unreadable";
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

const GATE_MODES: readonly GateMode[] = ["off", "warn", "block"];

export function evaluateGate(root: string, options: GateOptions = {}): GateReport {
  let config: Partial<AgentpackConfig> = {};
  let configError: string | null = null;
  try {
    const value = readJson<unknown>(getPackPath(root, "config.json"), {});
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    config = value as Partial<AgentpackConfig>;
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  const requestedMode = configError ? "block" : options.mode || config.gateMode || "warn";
  const modeValid = GATE_MODES.includes(requestedMode);
  // An unrecognized mode falls back to warn instead of silently disabling the gate,
  // and the finding below surfaces the config problem on every run.
  const mode: GateMode = modeValid ? requestedMode : "warn";

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

  if (configError) {
    findings.push({
      code: "config-unreadable",
      level: "block",
      message: `Cannot read .agentpack/config.json; refusing to bypass the task gate: ${configError}`
    });
  }

  if (!modeValid) {
    findings.push({
      code: "invalid-gate-mode",
      level: "warn",
      message: `Unknown gateMode "${String(requestedMode)}" in .agentpack/config.json; using "warn". Valid values: off, warn, block.`
    });
  }

  let passport: ReturnType<typeof getCurrentPassport> = null;
  let passportUnreadable = false;
  try {
    passport = getCurrentPassport(root);
  } catch (error) {
    passportUnreadable = true;
    findings.push(violation(
      "passport-unreadable",
      `Cannot read current task passport: ${error instanceof Error ? error.message : String(error)}`
    ));
  }

  const { files, outsideRoot } = collectGateFiles(root, options);

  // The gate protects repo code: when every checked path resolves outside the
  // repository, or a --staged run stages nothing under this pack root (the
  // commit does not touch this pack), lifecycle findings must not escalate.
  // Invocations with no paths at all keep lifecycle checks; they back the MCP
  // gate-warnings layer.
  const packUntouched = files.length === 0 && (outsideRoot.length > 0 || options.staged === true);

  if (outsideRoot.length > 0) {
    findings.push({
      code: "outside-root",
      level: "warn",
      message: `Outside this repository and not checked by the gate: ${outsideRoot.join(", ")}.`
    });
  }

  if (passport) {
    taskId = passport.id;
    taskStatus = passport.status;

    if (passport.status !== "active" && !packUntouched) {
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
    } else if (passport.writeScope.length === 0 && mode === "block") {
      findings.push({
        code: "no-write-scope",
        level: "warn",
        message: `Task ${passport.id} has no write scope, so block mode cannot enforce file scope. Set one with \`agentpack task update --write-scope <path>\`.`
      });
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
  } else if (!passportUnreadable && !packUntouched) {
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

function collectGateFiles(root: string, options: GateOptions): { files: string[]; outsideRoot: string[] } {
  const files: string[] = [];
  const outsideRoot: string[] = [];
  if (options.staged) {
    files.push(...listStagedFiles(root));
  }
  for (const file of options.files || []) {
    const absolutePath = path.resolve(root, file);
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      outsideRoot.push(file);
      continue;
    }
    files.push(relativePath);
  }
  return {
    files: [...new Set(files.map((file) => normalizePath(file)))],
    outsideRoot: [...new Set(outsideRoot)]
  };
}

function taskNotActiveMessage(status: TaskStatus): string {
  if (status === "verifying") {
    return "Current task is verifying: a final verdict is recorded and code changes are frozen. Finalize the task; to commit already-verified changes, set verification to pending, commit, then re-record the verdict. Park the task for unrelated work.";
  }
  if (status === "parked") {
    return "Current task is parked. Switch to it, or start the task this work belongs to.";
  }
  if (status === "blocked") {
    return "Current task is blocked. Resolve or park it before editing code.";
  }
  return "Current task is closed. Start or switch to an open task before editing code.";
}
