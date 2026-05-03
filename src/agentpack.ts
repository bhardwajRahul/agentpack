#!/usr/bin/env node
import { runCli } from "./cli/index.js";

runCli(process.argv.slice(2), process.cwd()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agentpack: ${message}\n`);
  process.exitCode = 1;
});
