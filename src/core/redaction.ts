import { getPackPath, readJson } from "./store.js";
import type { AgentpackConfig } from "./types.js";

const SECRET_VALUE_PATTERN = /((api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s"']+/gi;

export function redact(text: string, config: { redactions?: string[] } = {}): string {
  let output = String(text || "");

  output = output.replace(SECRET_VALUE_PATTERN, "$1$3[REDACTED]");

  for (const name of config.redactions || []) {
    const value = process.env[name];
    if (value) {
      output = output.split(value).join(`[REDACTED:${name}]`);
    }
  }

  return output;
}

export function redactForRoot(root: string, text: string): string {
  const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
  return redact(text, config);
}
