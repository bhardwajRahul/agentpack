import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getGitInfo } from "./git.js";
import { findPackRoot, getPackPath, PACK_DIR } from "./store.js";
import { getSourceStatuses } from "../operations.js";

type CheckStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  status: CheckStatus;
  name: string;
  detail: string;
}

export function buildDoctorReport(startDir: string): { ok: boolean; text: string } {
  const checks: DoctorCheck[] = [];
  const root = findPackRoot(startDir);

  if (!root) {
    checks.push({
      status: "fail",
      name: "Pack",
      detail: "No .agentpack directory found. Run `agentpack init`."
    });
    return renderDoctor(checks);
  }

  checks.push({
    status: "ok",
    name: "Pack",
    detail: `.agentpack found at ${getPackPath(root)}`
  });

  for (const file of ["config.json", "state.json", "sources.json", "events.jsonl"]) {
    checks.push({
      status: existsSync(getPackPath(root, file)) ? "ok" : "fail",
      name: file,
      detail: existsSync(getPackPath(root, file)) ? "present" : "missing"
    });
  }

  checks.push(checkGitignore(root));

  const git = getGitInfo(root);
  checks.push({
    status: git.available ? "ok" : "warn",
    name: "Git",
    detail: git.available ? `${git.branch || "unknown"} @ ${git.head || "unknown"}` : "not a git repository"
  });

  const sourceStatuses = getSourceStatuses(root);
  const changed = sourceStatuses.filter((source) => source.status === "changed").length;
  const missing = sourceStatuses.filter((source) => source.status === "missing").length;
  checks.push({
    status: changed || missing ? "warn" : "ok",
    name: "Sources",
    detail: `${sourceStatuses.length} recorded, ${changed} changed, ${missing} missing`
  });

  checks.push({
    status: "ok",
    name: "Node",
    detail: process.version
  });

  return renderDoctor(checks);
}

function checkGitignore(root: string): DoctorCheck {
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return {
      status: "warn",
      name: ".gitignore",
      detail: "missing; .agentpack/ may be committed accidentally"
    };
  }

  const content = readFileSync(gitignorePath, "utf8");
  const ignored = content.split(/\r?\n/).map((line) => line.trim()).some((line) => {
    return line === `${PACK_DIR}/` || line === PACK_DIR;
  });

  return {
    status: ignored ? "ok" : "warn",
    name: ".gitignore",
    detail: ignored ? ".agentpack/ ignored" : ".agentpack/ is not ignored"
  };
}

function renderDoctor(checks: DoctorCheck[]): { ok: boolean; text: string } {
  const ok = checks.every((check) => check.status !== "fail");
  const text = [
    "Agentpack doctor",
    "",
    ...checks.map((check) => `[${check.status}] ${check.name}: ${check.detail}`)
  ].join("\n");

  return { ok, text };
}
