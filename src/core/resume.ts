import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { estimateTokens, packSections } from "./budget.js";
import { getGitInfo } from "./git.js";
import { sha256File } from "./hash.js";
import {
  getPackPath,
  readEvents,
  readJson,
  readSources,
  readState
} from "./store.js";
import { redact } from "./redaction.js";
import type { AgentpackConfig, AgentpackEvent, GitInfo, SourceRecord } from "./types.js";

interface ResumeOptions {
  budget?: number;
  query?: string;
}

export function buildResume(root: string, options: ResumeOptions = {}) {
  const budget = Number(options.budget || 0);
  const state = readState(root);
  const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
  const sources = readSources(root).sources || [];
  const events = readEvents(root);
  const git = getGitInfo(root);
  const generatedAt = new Date().toISOString();

  const header = [
    "# Agentpack Resume",
    "",
    `Generated: ${generatedAt}`,
    budget ? `Budget: ~${budget} tokens` : "Budget: unbounded",
    options.query ? `Query: ${options.query}` : null
  ].filter(Boolean).join("\n");

  const sections = [
    {
      title: "Current State",
      required: true,
      text: section("Current State", [
        `Goal: ${state.goal || "Not set"}`,
        `Status: ${state.currentStatus || "Not set"}`,
        state.currentCheckpoint ? `Current checkpoint: ${state.currentCheckpoint}` : null,
        "",
        "Next actions:",
        ...(state.nextActions && state.nextActions.length > 0
          ? state.nextActions.map((item) => `- ${item}`)
          : ["- Not set"])
      ])
    },
    {
      title: "Git State",
      required: true,
      text: section("Git State", formatGit(git))
    },
    {
      title: "Source Cache",
      required: true,
      text: section("Source Cache", formatSources(root, sources))
    },
    {
      title: "Decisions",
      text: section("Decisions", formatEvents(events, "decision"))
    },
    {
      title: "Dead Ends",
      text: section("Dead Ends", formatEvents(events, "dead-end"))
    },
    {
      title: "Evidence",
      text: section("Evidence", formatEvidence(root, events))
    },
    {
      title: "Recent Timeline",
      text: section("Recent Timeline", formatTimeline(events))
    }
  ];

  const { markdown, omittedSections } = packSections(header, sections, budget);
  const redacted = redact(markdown, config);

  return {
    markdown: redacted,
    estimatedTokens: estimateTokens(redacted),
    omittedSections
  };
}

function section(title: string, lines: Array<string | null | undefined>): string {
  const body = lines.filter((line) => line !== null && line !== undefined).join("\n").trimEnd();
  return `## ${title}\n${body || "- No entries yet."}`;
}

function formatGit(git: GitInfo): string[] {
  if (!git.available) {
    return ["- Git repository not detected."];
  }

  return [
    `- Branch: ${git.branch || "unknown"}`,
    `- Commit: ${git.head || "unknown"}`,
    "- Changed files:",
    ...(git.status ? git.status.split("\n").map((line) => `  - ${line}`) : ["  - None"]),
    git.diff ? `- Current diff characters: ${git.diff.length}` : "- Current diff: none"
  ];
}

function formatSources(root: string, sources: SourceRecord[]): string[] {
  if (!sources.length) {
    return [
      "- No inspected sources recorded yet.",
      "- Use `agentpack source add <file> --summary <text>` after reading important files."
    ];
  }

  return sources.map((source) => {
    const absolutePath = path.join(root, source.path);
    let status = "missing";
    if (existsSync(absolutePath)) {
      status = sha256File(absolutePath) === source.hash ? "unchanged" : "changed";
    }

    const guidance = status === "unchanged"
      ? "Do not re-open unless needed or unless hash changed."
      : "Re-open before relying on prior conclusions.";

    return [
      `- ${source.path}`,
      `  - status: ${status}`,
      `  - summary: ${source.summary || "No summary recorded."}`,
      source.snippet ? `  - snippet: ${source.snippet}` : null,
      `  - guidance: ${guidance}`
    ].filter(Boolean).join("\n");
  });
}

function formatEvents(events: AgentpackEvent[], type: string): string[] {
  const filtered = events.filter((event) => event.type === type);
  if (!filtered.length) {
    return ["- No entries yet."];
  }

  return filtered.slice(-20).map((event) => {
    const files = stringArray(event.files);
    const filesText = files.length ? ` Files: ${files.join(", ")}.` : "";
    const reason = text(event.reason);
    const reasonText = reason ? ` Reason: ${reason}.` : "";
    return `- ${event.ts}: ${text(event.text) || text(event.summary) || "No text."}${reasonText}${filesText}`;
  });
}

function formatEvidence(root: string, events: AgentpackEvent[]): string[] {
  const evidenceEvents = events.filter((event) => event.type === "evidence");
  if (!evidenceEvents.length) {
    return ["- No evidence attached yet."];
  }

  return evidenceEvents.slice(-20).map((event) => {
    const eventPath = text(event.path);
    const file = eventPath ? getPackPath(root, eventPath) : null;
    const preview = file && existsSync(file)
      ? previewText(readFileSync(file, "utf8"))
      : text(event.content);
    const lines = [
      `- ${event.ts}: ${text(event.kind) || "note"}`,
      text(event.command) ? `  - command: ${text(event.command)}` : null,
      event.exitCode !== undefined && event.exitCode !== null ? `  - exit code: ${String(event.exitCode)}` : null,
      eventPath ? `  - path: ${eventPath}` : null,
      preview ? `  - preview: ${preview}` : null
    ];

    return lines.filter(Boolean).join("\n");
  });
}

function formatTimeline(events: AgentpackEvent[]): string[] {
  if (!events.length) {
    return ["- No events yet."];
  }

  return events.slice(-30).map((event) => {
    const label = text(event.text) || text(event.summary) || text(event.kind) || text(event.checkpointId);
    return `- ${event.ts} [${event.type}] ${label}`.trim();
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function previewText(value: string): string {
  return value
    .slice(0, 360)
    .replace(/\s+/g, " ")
    .trim();
}
