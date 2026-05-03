import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SourceRecord } from "./types.js";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256(readFileSync(filePath));
}

export function getFileRecord(root: string, inputPath: string, extra: Pick<SourceRecord, "summary" | "snippet">): SourceRecord {
  const absolutePath = path.resolve(root, inputPath);
  const relativePath = path.relative(root, absolutePath);
  const stat = statSync(absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to record file outside project root: ${inputPath}`);
  }

  return {
    path: normalizePath(relativePath),
    hash: sha256File(absolutePath),
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    recordedAt: new Date().toISOString(),
    ...extra
  };
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
