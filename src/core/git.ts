import { execFileSync } from "node:child_process";
import type { GitInfo } from "./types.js";

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

export function getGitInfo(root: string): GitInfo {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);

  if (!topLevel) {
    return {
      available: false,
      branch: null,
      head: null,
      status: "",
      diff: ""
    };
  }

  return {
    available: true,
    topLevel,
    branch: runGit(root, ["branch", "--show-current"]) || "detached",
    head: runGit(root, ["rev-parse", "--short", "HEAD"]),
    status: runGit(root, ["status", "--short"]),
    diff: runGit(root, ["diff", "--"])
  };
}
