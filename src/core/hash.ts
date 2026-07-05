import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { SourceRecord } from "./types.js";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256(readFileSync(filePath));
}

export function getFileRecord(root: string, inputPath: string, extra: Pick<SourceRecord, "summary" | "snippet">): SourceRecord {
  const absolutePath = resolveRegularFileWithin(root, inputPath, "source file");
  const relativePath = path.relative(root, absolutePath);
  const stat = lstatSync(absolutePath);

  return {
    path: normalizePath(relativePath),
    hash: sha256File(absolutePath),
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    recordedAt: new Date().toISOString(),
    ...extra
  };
}

export function resolveRegularFileWithin(root: string, inputPath: string, label: string): string {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, inputPath);
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing ${label} outside ${absoluteRoot}: ${inputPath}`);
  }

  let current = absoluteRoot;
  const segments = relativePath.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link ${label}: ${inputPath}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Refusing ${label} through a non-directory: ${inputPath}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`Refusing non-regular ${label}: ${inputPath}`);
    }
  }

  const realRoot = realpathSync(absoluteRoot);
  const realPath = realpathSync(absolutePath);
  const realRelative = path.relative(realRoot, realPath);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Refusing ${label} outside ${absoluteRoot}: ${inputPath}`);
  }
  return absolutePath;
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
