import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getGitInfo } from "./git.js";
import { normalizePath, sha256 } from "./hash.js";
import { redactForRoot } from "./redaction.js";
import { getPackPath, readEvents, readJson, readSources } from "./store.js";
import { formatCurrentTaskHandoff, getCurrentPassport, readPassport } from "./tasks.js";
import type {
  AgentpackConfig,
  AgentpackEvent,
  BundleExportOptions,
  BundleExportResult,
  BundleInspectResult,
  SourceRecord,
  TaskBundle,
  TaskBundleEvidence,
  TaskBundleOrigin,
  TaskBundleSource
} from "./types.js";

const BUNDLE_KIND = "agentpack.task-bundle";
const BUNDLE_SCHEMA_VERSION = 1;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 100;
const MAX_EVIDENCE = 50;
const MAX_EVIDENCE_CONTENT_BYTES = 256 * 1024;

export function exportTaskBundle(root: string, options: BundleExportOptions): BundleExportResult {
  if (!options.outputPath.trim()) {
    throw new Error("bundle export requires --output <file>");
  }

  const passport = options.taskId && options.taskId !== "current"
    ? readPassport(root, options.taskId)
    : getCurrentPassport(root);
  if (!passport) {
    throw new Error("No current task. Run `agentpack task start <title>` first or pass --task <id>.");
  }

  const outputPath = path.resolve(root, options.outputPath);
  const sourcePaths = normalizeBundleSourcePaths(root, options.sourcePaths || []);
  const sources = selectedSources(root, sourcePaths);
  const evidence = options.includeEvidence === false ? [] : referencedEvidence(root, passport.verification.evidence);
  const git = getGitInfo(root);
  const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
  const origin = bundleOrigin(root, config.projectName || path.basename(root), git.branch, git.head);
  const handoff = formatCurrentTaskHandoff(root);

  const bundleBase = deepRedact(root, {
    kind: BUNDLE_KIND,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    producer: {
      name: "agentpack-cli",
      version: options.producerVersion || "unknown"
    },
    origin,
    task: {
      id: passport.id,
      title: passport.title,
      objective: passport.objective,
      constraints: passport.constraints,
      writeScope: passport.writeScope,
      risk: passport.risk,
      tags: passport.tags,
      nextActions: passport.nextActions,
      originalStatus: passport.status,
      originVerification: passport.verification
    },
    handoffMarkdown: handoff,
    sources,
    evidence
  }) as Omit<TaskBundle, "bundleId" | "exportedAt">;

  const bundleId = digestBundlePayload(bundleBase);
  const bundle: TaskBundle = {
    ...bundleBase,
    bundleId,
    exportedAt: new Date().toISOString()
  };
  const content = `${stableStringify(bundle)}\n`;

  if (Buffer.byteLength(content, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} byte limit.`);
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");

  return {
    bundleId,
    outputPath,
    taskId: passport.id,
    sources: bundle.sources.length,
    evidence: bundle.evidence.length,
    bytes: Buffer.byteLength(content, "utf8")
  };
}

export function inspectTaskBundle(filePath: string): BundleInspectResult {
  const absolutePath = path.resolve(filePath);
  const stat = statSync(absolutePath);
  if (stat.size > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} byte limit.`);
  }

  const raw = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const bundle = assertBundleShape(parsed);
  const digest = digestBundlePayload(stripBundleEnvelope(bundle));
  if (digest !== bundle.bundleId) {
    throw new Error(`Bundle digest mismatch: expected ${digest}, got ${bundle.bundleId}`);
  }

  const warnings = validateBundleRecords(bundle);
  return {
    valid: true,
    bundleId: bundle.bundleId,
    digestStatus: "valid",
    schemaVersion: bundle.schemaVersion,
    producer: bundle.producer,
    origin: bundle.origin,
    task: {
      id: bundle.task.id,
      title: bundle.task.title,
      originalStatus: bundle.task.originalStatus,
      verificationStatus: bundle.task.originVerification.status
    },
    counts: {
      sources: bundle.sources.length,
      evidence: bundle.evidence.length
    },
    warnings
  };
}

export function formatBundleExportResult(result: BundleExportResult): string {
  return [
    `Exported bundle ${result.bundleId}`,
    `Task: ${result.taskId}`,
    `Path: ${result.outputPath}`,
    `Included: ${result.sources} source(s), ${result.evidence} evidence item(s), ${result.bytes} bytes`
  ].join("\n");
}

export function formatBundleInspectResult(result: BundleInspectResult): string {
  return [
    `Bundle ${result.bundleId}`,
    `Status: ${result.valid ? "valid" : "invalid"} (${result.digestStatus} digest)`,
    `Task: ${result.task.id} - ${result.task.title}`,
    `Origin: ${result.origin.projectName}${result.origin.branch ? ` @ ${result.origin.branch}` : ""}${result.origin.head ? ` (${result.origin.head})` : ""}`,
    `Original status: ${result.task.originalStatus}`,
    `Verification: ${result.task.verificationStatus}`,
    `Included: ${result.counts.sources} source(s), ${result.counts.evidence} evidence item(s)`,
    result.warnings.length > 0 ? `Warnings: ${result.warnings.join("; ")}` : "Warnings: none"
  ].join("\n");
}

function normalizeBundleSourcePaths(root: string, sourcePaths: string[]): string[] {
  const normalized = sourcePaths.map((sourcePath) => normalizeBundlePath(root, sourcePath));
  return [...new Set(normalized)].sort();
}

function normalizeBundlePath(root: string, inputPath: string): string {
  if (!inputPath.trim()) {
    throw new Error("bundle source paths must not be empty");
  }
  if (path.isAbsolute(inputPath)) {
    throw new Error(`Refusing absolute bundle source path: ${inputPath}`);
  }

  const absolutePath = path.resolve(root, inputPath);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing bundle source path outside project root: ${inputPath}`);
  }
  return normalizePath(relativePath);
}

function selectedSources(root: string, sourcePaths: string[]): TaskBundleSource[] {
  if (sourcePaths.length > MAX_SOURCES) {
    throw new Error(`Bundle source count exceeds ${MAX_SOURCES}.`);
  }

  const sourceRecords = new Map(readSources(root).sources.map((source) => [source.path, source]));
  return sourcePaths.map((sourcePath) => {
    const source = sourceRecords.get(sourcePath);
    if (!source) {
      throw new Error(`No recorded source conclusion for ${sourcePath}. Run source add/review first or omit it.`);
    }
    return bundleSource(source);
  });
}

function bundleSource(source: SourceRecord): TaskBundleSource {
  return {
    path: source.path,
    hash: source.hash,
    size: source.size,
    recordedAt: source.recordedAt,
    summary: source.summary,
    snippet: source.snippet
  };
}

function referencedEvidence(root: string, evidenceIds: string[]): TaskBundleEvidence[] {
  const ids = [...new Set(evidenceIds)];
  if (ids.length > MAX_EVIDENCE) {
    throw new Error(`Bundle evidence count exceeds ${MAX_EVIDENCE}.`);
  }
  const events = readEvents(root).filter((event) => event.type === "evidence");
  const byId = new Map(events.map((event) => [event.id, event]));
  return ids.map((id) => {
    const event = byId.get(id);
    if (!event) {
      throw new Error(`Referenced evidence event not found: ${id}`);
    }
    return bundleEvidence(root, event);
  });
}

function bundleEvidence(root: string, event: AgentpackEvent): TaskBundleEvidence {
  const evidencePath = typeof event.path === "string" ? event.path : "";
  const normalizedPath = normalizeEvidencePath(evidencePath);
  const absolutePath = getPackPath(root, normalizedPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Referenced evidence file not found: ${evidencePath}`);
  }

  const stat = statSync(absolutePath);
  if (stat.size > MAX_EVIDENCE_CONTENT_BYTES) {
    throw new Error(`Evidence ${event.id} exceeds ${MAX_EVIDENCE_CONTENT_BYTES} byte limit.`);
  }

  const kind = typeof event.kind === "string" ? event.kind : "note";
  const content = readFileSync(absolutePath, "utf8");
  if (kind === "json") {
    JSON.parse(content);
  }

  return {
    originId: event.id,
    kind,
    command: typeof event.command === "string" ? event.command : "",
    exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
    content,
    contentDigest: `sha256:${sha256(content)}`
  };
}

function normalizeEvidencePath(evidencePath: string): string {
  if (!evidencePath || path.isAbsolute(evidencePath)) {
    throw new Error(`Refusing invalid evidence path: ${evidencePath || "(empty)"}`);
  }
  const normalized = normalizePath(path.normalize(evidencePath));
  if (normalized.startsWith("../") || normalized === ".." || !normalized.startsWith("evidence/")) {
    throw new Error(`Refusing evidence path outside evidence directory: ${evidencePath}`);
  }
  return normalized;
}

function bundleOrigin(root: string, projectName: string, branch: string | null, head: string | null): TaskBundleOrigin {
  const repository = sanitizeRepositoryLocator(readOriginUrl(root));
  return repository
    ? { projectName, repository, branch, head }
    : { projectName, branch, head };
}

function readOriginUrl(root: string): string {
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function sanitizeRepositoryLocator(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.startsWith("file:") || path.isAbsolute(value) || value.startsWith(".")) {
    return undefined;
  }

  const withoutGitPrefix = value.startsWith("git+") ? value.slice(4) : value;
  if (/^https?:\/\//i.test(withoutGitPrefix) || /^ssh:\/\//i.test(withoutGitPrefix)) {
    try {
      const url = new URL(withoutGitPrefix);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return undefined;
    }
  }

  const scpLike = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpLike) {
    return `ssh://${scpLike[1]}/${scpLike[2]}`;
  }

  return undefined;
}

function deepRedact(root: string, value: unknown): unknown {
  if (typeof value === "string") {
    return redactExportString(root, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(root, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepRedact(root, item)])
    );
  }
  return value;
}

function redactExportString(root: string, value: string): string {
  const redacted = redactForRoot(root, value);
  return redacted.split(root).join("[REDACTED:WORKTREE]");
}

function assertBundleShape(value: unknown): TaskBundle {
  if (!isRecord(value)) {
    throw new Error("Bundle must be a JSON object.");
  }
  if (value.kind !== BUNDLE_KIND) {
    throw new Error("Unsupported bundle kind.");
  }
  if (value.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported bundle schema version: ${String(value.schemaVersion)}`);
  }
  if (typeof value.bundleId !== "string" || !value.bundleId.startsWith("sha256:")) {
    throw new Error("Bundle is missing a sha256 bundleId.");
  }
  if (typeof value.exportedAt !== "string") {
    throw new Error("Bundle is missing exportedAt.");
  }
  if (!isRecord(value.producer) || value.producer.name !== "agentpack-cli" || typeof value.producer.version !== "string") {
    throw new Error("Bundle producer is invalid.");
  }
  if (
    !isRecord(value.origin) ||
    typeof value.origin.projectName !== "string" ||
    !optionalString(value.origin.repository) ||
    !nullableString(value.origin.branch) ||
    !nullableString(value.origin.head)
  ) {
    throw new Error("Bundle origin is invalid.");
  }
  if (
    !isRecord(value.task) ||
    typeof value.task.id !== "string" ||
    typeof value.task.title !== "string" ||
    typeof value.task.objective !== "string" ||
    !stringArrayValue(value.task.constraints) ||
    !stringArrayValue(value.task.writeScope) ||
    !taskRiskValue(value.task.risk) ||
    !stringArrayValue(value.task.tags) ||
    !stringArrayValue(value.task.nextActions) ||
    !taskStatusValue(value.task.originalStatus) ||
    !isRecord(value.task.originVerification) ||
    !verificationStatusValue(value.task.originVerification.status) ||
    !stringArrayValue(value.task.originVerification.evidence) ||
    typeof value.task.originVerification.summary !== "string"
  ) {
    throw new Error("Bundle task is invalid.");
  }
  if (typeof value.handoffMarkdown !== "string") {
    throw new Error("Bundle handoffMarkdown must be a string.");
  }
  if (!Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) {
    throw new Error(`Bundle sources must be an array with at most ${MAX_SOURCES} items.`);
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE) {
    throw new Error(`Bundle evidence must be an array with at most ${MAX_EVIDENCE} items.`);
  }
  for (const source of value.sources) {
    if (
      !isRecord(source) ||
      typeof source.path !== "string" ||
      typeof source.hash !== "string" ||
      typeof source.size !== "number" ||
      typeof source.recordedAt !== "string" ||
      typeof source.summary !== "string" ||
      typeof source.snippet !== "string"
    ) {
      throw new Error("Bundle source entry is invalid.");
    }
  }
  for (const evidence of value.evidence) {
    if (
      !isRecord(evidence) ||
      typeof evidence.originId !== "string" ||
      typeof evidence.kind !== "string" ||
      typeof evidence.command !== "string" ||
      !(typeof evidence.exitCode === "number" || evidence.exitCode === null) ||
      typeof evidence.content !== "string" ||
      typeof evidence.contentDigest !== "string"
    ) {
      throw new Error("Bundle evidence entry is invalid.");
    }
  }

  return value as unknown as TaskBundle;
}

function validateBundleRecords(bundle: TaskBundle): string[] {
  const warnings: string[] = [];
  for (const source of bundle.sources) {
    validateRelativeBundlePath(source.path, "source");
  }
  for (const writePath of bundle.task.writeScope) {
    validateRelativeBundlePath(writePath, "write scope", true);
  }
  for (const evidence of bundle.evidence) {
    if (evidence.contentDigest !== `sha256:${sha256(evidence.content)}`) {
      throw new Error(`Evidence digest mismatch for ${evidence.originId}.`);
    }
    if (Buffer.byteLength(evidence.content, "utf8") > MAX_EVIDENCE_CONTENT_BYTES) {
      throw new Error(`Evidence ${evidence.originId} exceeds ${MAX_EVIDENCE_CONTENT_BYTES} byte limit.`);
    }
    if (evidence.kind === "json") {
      JSON.parse(evidence.content);
    }
  }
  if (bundle.task.originVerification.evidence.length > bundle.evidence.length) {
    warnings.push("verification references evidence not included in this bundle");
  }
  return warnings;
}

function validateRelativeBundlePath(filePath: string, label: string, allowDot = false): void {
  if (allowDot && filePath === ".") {
    return;
  }
  const normalized = normalizePath(path.posix.normalize(filePath));
  if (
    !filePath ||
    filePath.includes("\\") ||
    path.isAbsolute(filePath) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid ${label} path in bundle: ${filePath || "(empty)"}`);
  }
}

function stripBundleEnvelope(bundle: TaskBundle): Omit<TaskBundle, "bundleId" | "exportedAt"> {
  const { bundleId: _bundleId, exportedAt: _exportedAt, ...payload } = bundle;
  return payload;
}

function digestBundlePayload(payload: Omit<TaskBundle, "bundleId" | "exportedAt">): string {
  return `sha256:${sha256(stableStringify(payload))}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function stringArrayValue(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function taskRiskValue(value: unknown): boolean {
  return value === "low" || value === "medium" || value === "high" || value === "unknown";
}

function taskStatusValue(value: unknown): boolean {
  return value === "active" ||
    value === "parked" ||
    value === "blocked" ||
    value === "verifying" ||
    value === "completed" ||
    value === "abandoned";
}

function verificationStatusValue(value: unknown): boolean {
  return value === "unknown" ||
    value === "pending" ||
    value === "passed" ||
    value === "failed" ||
    value === "accepted";
}
