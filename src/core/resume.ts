import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
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
import { getCurrentPassport } from "./tasks.js";
import type { AgentpackConfig, AgentpackEvent, GitInfo, SourceRecord, TaskPassport } from "./types.js";

interface ResumeOptions {
  budget?: number;
  query?: string;
}

interface SourceEntry {
  source: SourceRecord;
  status: string;
  meaning: string;
  guidance: string;
  score: number;
}

export function buildResume(root: string, options: ResumeOptions = {}) {
  const budget = Number(options.budget || 0);
  const state = readState(root);
  const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
  const sources = readSources(root).sources || [];
  const events = readEvents(root);
  const git = getGitInfo(root);
  const currentTask = readCurrentTaskForResume(root);
  const generatedAt = new Date().toISOString();

  const header = [
    "# Agentpack Resume",
    "",
    `Pack root: ${formatPackRoot(root)}`,
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
    currentTask ? {
      title: "Current Task Passport",
      required: true,
      text: section("Current Task Passport", formatCurrentTaskPassport(currentTask, git))
    } : null,
    {
      title: "Git State",
      required: true,
      text: section("Git State", formatGit(git))
    },
    {
      title: "Source Cache",
      required: true,
      text: section("Source Cache", formatSources(root, sources, options.query))
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
  ].filter((entry): entry is { title: string; required?: boolean; text: string } => Boolean(entry));

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

function formatPackRoot(root: string): string {
  const home = os.homedir();
  const relativeToHome = path.relative(home, root);

  if (relativeToHome && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return path.join("~", relativeToHome);
  }

  return root;
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

function readCurrentTaskForResume(root: string): TaskPassport | null {
  try {
    return getCurrentPassport(root);
  } catch {
    return null;
  }
}

function formatCurrentTaskPassport(passport: TaskPassport, git: GitInfo): string[] {
  const drift = formatTaskDrift(passport, git);
  return [
    `- ID: ${passport.id}`,
    `- Title: ${passport.title}`,
    `- Status: ${passport.status}`,
    `- Objective: ${passport.objective || "Not set"}`,
    passport.constraints.length ? "- Constraints:" : null,
    ...passport.constraints.map((item) => `  - ${item}`),
    `- Risk: ${passport.risk}`,
    `- Worktree: ${formatPackRoot(passport.worktree)}`,
    `- Branch: ${passport.branch || "unknown"}`,
    passport.writeScope.length ? "- Write scope:" : "- Write scope: Not set",
    ...passport.writeScope.map((item) => `  - ${item}`),
    `- Verification: ${passport.verification.status}${passport.verification.summary ? ` - ${passport.verification.summary}` : ""}`,
    passport.verification.evidence.length ? `- Verification evidence: ${passport.verification.evidence.join(", ")}` : null,
    passport.nextActions.length ? "- Task next actions:" : "- Task next actions: Not set",
    ...passport.nextActions.map((item) => `  - ${item}`),
    drift
  ].filter((line): line is string => Boolean(line));
}

function formatTaskDrift(passport: TaskPassport, git: GitInfo): string | null {
  if (!git.available) {
    return "- Drift: Git repository not detected; verify task state manually.";
  }

  const drift: string[] = [];
  if (passport.branch && git.branch && passport.branch !== git.branch) {
    drift.push(`branch changed from ${passport.branch} to ${git.branch}`);
  }
  if (passport.currentHead && git.head && passport.currentHead !== git.head) {
    drift.push(`HEAD changed from ${passport.currentHead} to ${git.head}`);
  }

  return drift.length ? `- Drift: ${drift.join("; ")}. Verify task state before continuing.` : "- Drift: none detected.";
}

function formatSources(root: string, sources: SourceRecord[], query = ""): string[] {
  if (!sources.length) {
    return [
      "- No inspected sources recorded yet.",
      "- Use `agentpack source add <file> --summary <text>` after reading important files."
    ];
  }

  const queryTerms = tokenizeQuery(query);
  const entries = sources.map((source) => {
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

    return {
      source,
      status,
      meaning,
      guidance,
      score: queryTerms.length > 0 ? scoreSource(source, queryTerms) : 0
    };
  });

  if (!queryTerms.length) {
    return entries.map((entry) => formatSourceEntry(entry, "full"));
  }

  const matched = entries
    .filter((entry) => entry.score > 0 || entry.status !== "unchanged")
    .sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path));
  const matchedPaths = new Set(matched.map((entry) => entry.source.path));
  const unmatched = entries.filter((entry) => !matchedPaths.has(entry.source.path));
  const staleCount = matched.filter((entry) => entry.status !== "unchanged").length;

  if (!matched.length) {
    return [
      `- Query filter: no source summaries matched \`${query}\`; full Source Cache retained to avoid false-negative filtering.`,
      ...entries.map((entry) => formatSourceEntry(entry, "full"))
    ];
  }

  return [
    `- Query filter: full summaries for ${matched.length} relevant or stale source(s), compact stubs for ${unmatched.length} unchanged source(s).`,
    staleCount > 0 ? `- Stale source records shown in full: ${staleCount} changed/missing.` : null,
    "- Compact stubs keep path/status/topic/guidance but omit full summaries to preserve budget.",
    "- For full omitted summaries, call `source_status` or rerun without `--query`.",
    ...matched.map((entry) => formatSourceEntry(entry, "full")),
    ...unmatched.map((entry) => formatSourceEntry(entry, "stub"))
  ].filter((line): line is string => Boolean(line));
}

function formatSourceEntry(entry: SourceEntry, mode: "full" | "stub"): string {
  const lines = [
    `- ${entry.source.path}`,
    `  - status: ${entry.status}`,
    mode === "stub" ? `  - topic: ${topicHint(entry.source.summary)}` : null,
    mode === "full"
      ? `  - summary: ${entry.source.summary || "No summary recorded."}`
      : "  - summary: omitted by query filter",
    mode === "full" && entry.source.snippet ? `  - snippet: ${entry.source.snippet}` : null,
    `  - meaning: ${entry.meaning}`,
    `  - guidance: ${entry.guidance}`
  ];

  return lines.filter(Boolean).join("\n");
}

const QUERY_STOPWORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "agentpack",
  "cache",
  "code",
  "context",
  "contexts",
  "current",
  "file",
  "files",
  "from",
  "into",
  "source",
  "sources",
  "task",
  "tasks",
  "that",
  "this",
  "with",
  "work",
  "working"
]);

function tokenizeQuery(query: string): string[] {
  return uniqueTokens(query).filter((term) => !QUERY_STOPWORDS.has(term));
}

function scoreSource(source: SourceRecord, queryTerms: string[]): number {
  const basename = path.basename(source.path);
  const pathText = normalizedText(source.path);
  const basenameText = normalizedText(basename);
  const summaryText = normalizedText(source.summary);
  const snippetText = normalizedText(source.snippet);
  const pathTokens = uniqueTokens(source.path);
  const basenameTokens = uniqueTokens(basename);
  const summaryTokens = uniqueTokens(source.summary);
  const snippetTokens = uniqueTokens(source.snippet);
  let score = 0;

  for (const term of queryTerms) {
    score += scoreField(term, basenameText, basenameTokens, 8, 4);
    score += scoreField(term, pathText, pathTokens, 6, 3);
    score += scoreField(term, summaryText, summaryTokens, 3, 1);
    score += scoreField(term, snippetText, snippetTokens, 1, 1);
  }

  return score;
}

function scoreField(
  term: string,
  textValue: string,
  tokens: string[],
  exactScore: number,
  fuzzyScore: number
): number {
  if (tokens.includes(term)) {
    return exactScore;
  }

  if (term.length >= 4 && tokens.some((token) => token.startsWith(term) || term.startsWith(token))) {
    return fuzzyScore;
  }

  return term.length >= 5 && textValue.includes(term) ? Math.max(1, fuzzyScore) : 0;
}

function uniqueTokens(value: string): string[] {
  const seen = new Set<string>();
  const tokens = normalizedText(value)
    .split(/[^a-z0-9]+/u)
    .filter((term) => term.length >= 3);

  for (const token of tokens) {
    seen.add(token);
  }

  return [...seen];
}

function normalizedText(value: string): string {
  return String(value || "").toLowerCase();
}

function topicHint(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No summary recorded.";
  }

  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/u);
  return truncateOneLine(sentenceMatch?.[1] || normalized, 80);
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
