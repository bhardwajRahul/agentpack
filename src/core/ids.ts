import { randomBytes } from "node:crypto";

export function createId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(3).toString("hex");
  return `${prefix}_${stamp}_${suffix}`;
}
