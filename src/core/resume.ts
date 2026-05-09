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

  const { markdown, omittedSections, truncatedSections } = packSections(header, sections, budget);
  const redacted = withStableBudgetMetadata(markdown, config, budget, omittedSections, truncatedSections);

  return {
    markdown: redacted,
    estimatedTokens: estimateTokens(redacted),
    budget,
    omittedSections,
    truncatedSections,
    truncated: truncatedSections.length > 0 || omittedSections.length > 0
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
    const meaning = status === "unchanged"
      ? "Matches recorded source hash. Summary is current for this file content."
      : "Does not match recorded source hash.";

    return [
      `- ${source.path}`,
      `  - status: ${status}`,
      `  - summary: ${source.summary || "No summary recorded."}`,
      source.snippet ? `  - snippet: ${source.snippet}` : null,
      `  - meaning: ${meaning}`,
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

  const counts = eventTypeCounts(events);
  const recentCheckpoints = events
    .filter((event) => event.type === "checkpoint")
    .slice(-3)
    .map((event) => `  - ${event.ts}: ${shortLabel(event)}`);
  const recentNonSourceEvents = events
    .filter((event) => event.type !== "source" && event.type !== "checkpoint")
    .slice(-8)
    .map((event) => `  - ${event.ts} [${event.type}] ${shortLabel(event)}`);
  const recentSourcePaths = uniqueRecent(
    events
      .filter((event) => event.type === "source")
      .map((event) => text(event.path))
      .filter(Boolean),
    8
  );

  return [
    `- Total events: ${events.length} (${counts}).`,
    "- Source details are in Source Cache; evidence details are in Evidence.",
    recentSourcePaths.length ? `- Recent source records: ${recentSourcePaths.join(", ")}` : null,
    recentCheckpoints.length ? "Recent checkpoints:" : null,
    ...recentCheckpoints,
    recentNonSourceEvents.length ? "Recent non-source events:" : null,
    ...recentNonSourceEvents,
    "- Full chronology: `agentpack replay`."
  ].filter((line): line is string => Boolean(line));
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

function eventTypeCounts(events: AgentpackEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) || 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

function shortLabel(event: AgentpackEvent): string {
  const label = text(event.text)
    || text(event.summary)
    || text(event.kind)
    || text(event.path)
    || text(event.checkpointId)
    || "No label";

  return truncateOneLine(label, 140);
}

function uniqueRecent(values: string[], limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const value of [...values].reverse()) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
    if (output.length >= limit) {
      break;
    }
  }

  return output.reverse();
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function withStableBudgetMetadata(
  markdown: string,
  config: Partial<AgentpackConfig>,
  budget: number,
  omittedSections: string[],
  truncatedSections: string[]
): string {
  let estimatedTokens = estimateTokens(redact(markdown, config));
  let redacted = "";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    redacted = redact(addBudgetMetadata(markdown, budget, estimatedTokens, omittedSections, truncatedSections), config);
    const nextEstimate = estimateTokens(redacted);
    if (nextEstimate === estimatedTokens) {
      return redacted;
    }
    estimatedTokens = nextEstimate;
  }

  return redacted;
}

function addBudgetMetadata(
  markdown: string,
  budget: number,
  estimatedTokens: number,
  omittedSections: string[],
  truncatedSections: string[]
): string {
  const lines = markdown.split("\n");
  const budgetLineIndex = lines.findIndex((line) => line.startsWith("Budget: "));
  if (budgetLineIndex < 0) {
    return markdown;
  }

  const usage = budget
    ? `Estimated usage: ~${estimatedTokens} tokens (${Math.round((estimatedTokens / budget) * 100)}% of target)`
    : `Estimated usage: ~${estimatedTokens} tokens`;
  const status = formatBudgetStatus(budget, omittedSections, truncatedSections);

  lines.splice(budgetLineIndex + 1, 0, usage, `Budget status: ${status}`);
  return lines.join("\n");
}

function formatBudgetStatus(budget: number, omittedSections: string[], truncatedSections: string[]): string {
  if (!budget) {
    return "unbounded";
  }

  const details = [];
  if (truncatedSections.length > 0) {
    details.push(`truncated ${truncatedSections.join(", ")}`);
  }
  if (omittedSections.length > 0) {
    details.push(`omitted ${omittedSections.join(", ")}`);
  }

  return details.length > 0 ? `limited; ${details.join("; ")}` : "within target";
}
