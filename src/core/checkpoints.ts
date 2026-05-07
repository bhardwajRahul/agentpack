import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildResume } from "./resume.js";
import { getGitInfo } from "./git.js";
import {
  appendEvent,
  getPackPath,
  listCheckpoints,
  readJson,
  readState,
  withPackWriteLock,
  writeJson,
  writeState
} from "./store.js";
import { redactForRoot } from "./redaction.js";
import type { AgentpackConfig, GitInfo } from "./types.js";

interface CheckpointOptions {
  summary?: string;
  status?: string;
  nextActions?: string[];
}

interface CheckpointManifest {
  schemaVersion?: number;
  id?: string;
  summary?: string;
  status?: string;
  git?: Partial<GitInfo>;
}

export function createCheckpoint(root: string, options: CheckpointOptions = {}) {
  return withPackWriteLock(root, () => {
    const state = readState(root);
    const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
    const git = getGitInfo(root);
    const id = checkpointId();
    const checkpointPath = getPackPath(root, "checkpoints", id);
    const summary = redactForRoot(root, options.summary || "Checkpoint created.");

    mkdirSync(checkpointPath, { recursive: true });

    if (options.status) {
      state.currentStatus = redactForRoot(root, options.status);
    }

    if (options.nextActions && options.nextActions.length > 0) {
      state.nextActions = options.nextActions.map((item) => redactForRoot(root, item));
    }

    state.currentCheckpoint = id;
    writeState(root, state);

    const manifest = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      summary,
      status: state.currentStatus,
      nextActions: state.nextActions || [],
      git: {
        available: git.available,
        branch: git.branch,
        head: git.head
      }
    };

    writeJson(path.join(checkpointPath, "checkpoint.json"), manifest);
    writeFileSync(path.join(checkpointPath, "git-status.txt"), redactForRoot(root, git.status || ""), "utf8");

    if (config.includeGitDiff !== false) {
      writeFileSync(path.join(checkpointPath, "diff.patch"), redactForRoot(root, git.diff || ""), "utf8");
    }

    const resume = buildResume(root, { budget: config.defaultBudget || 4000 });
    writeFileSync(path.join(checkpointPath, "resume.md"), resume.markdown, "utf8");

    appendEvent(root, "checkpoint", {
      checkpointId: id,
      summary,
      status: state.currentStatus
    });

    return { id, path: checkpointPath, manifest };
  });
}

export function diffCheckpoints(root: string, fromId?: string, toId?: string): string {
  const checkpoints = listCheckpoints(root);
  if (checkpoints.length === 0) {
    return "No checkpoints yet.";
  }

  const latest = checkpoints[checkpoints.length - 1];
  if (!latest) {
    return "No checkpoints yet.";
  }

  const to = toId || latest;
  const from = fromId || checkpoints[checkpoints.length - 2] || latest;
  const fromManifest = readJson<CheckpointManifest>(getPackPath(root, "checkpoints", from, "checkpoint.json"), {});
  const toManifest = readJson<CheckpointManifest>(getPackPath(root, "checkpoints", to, "checkpoint.json"), {});

  return [
    "# Agentpack Checkpoint Diff",
    "",
    `From: ${from}`,
    `To: ${to}`,
    "",
    "## Summary",
    `- From: ${fromManifest.summary || "No summary"}`,
    `- To: ${toManifest.summary || "No summary"}`,
    "",
    "## Status",
    `- From: ${fromManifest.status || "No status"}`,
    `- To: ${toManifest.status || "No status"}`,
    "",
    "## Git",
    `- From: ${formatGitRef(fromManifest.git)}`,
    `- To: ${formatGitRef(toManifest.git)}`
  ].join("\n");
}

function checkpointId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatGitRef(git: Partial<GitInfo> = {}): string {
  if (!git.available) {
    return "not available";
  }
  return `${git.branch || "unknown"} @ ${git.head || "unknown"}`;
}
