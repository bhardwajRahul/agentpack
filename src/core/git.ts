import { execFileSync } from "node:child_process";
import type { GitInfo } from "./types.js";

interface GetGitInfoOptions {
  includeDiff?: boolean;
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trimEnd();
  } catch {
    return "";
  }
}

export function getGitInfo(root: string, options: GetGitInfoOptions = {}): GitInfo {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);

  if (!topLevel) {
    return {
      available: false,
      branch: null,
      head: null,
      upstream: null,
      ahead: null,
      behind: null,
      aheadCommits: [],
      status: "",
      diffStat: "",
      diff: ""
    };
  }

  const upstream = runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) || null;
  const counts = upstream ? parseAheadBehind(runGit(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])) : null;
  const aheadCommits = upstream && counts && counts.ahead > 0
    ? runGit(root, ["log", "--oneline", "--no-decorate", "--max-count=5", `${upstream}..HEAD`])
      .split("\n")
      .filter(Boolean)
    : [];

  return {
    available: true,
    topLevel,
    branch: runGit(root, ["branch", "--show-current"]) || "detached",
    head: runGit(root, ["rev-parse", "--short", "HEAD"]),
    upstream,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
    aheadCommits,
    status: runGit(root, ["status", "--short"]),
    diffStat: runGit(root, ["diff", "--shortstat", "--"]),
    diff: options.includeDiff ? runGit(root, ["diff", "--"]) : ""
  };
}

function parseAheadBehind(output: string): { ahead: number; behind: number } | null {
  const [aheadRaw, behindRaw] = output.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw || "", 10);
  const behind = Number.parseInt(behindRaw || "", 10);

  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}
