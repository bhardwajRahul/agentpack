<p align="center">
  <img src="assets/agentpack-logo.jpg" alt="Agentpack logo" width="180">
</p>

# Agentpack

Portable savegames and context budgets for AI coding agents.

> Agents forget. Agentpack lets work continue.

Agentpack helps AI agents continue work without rediscovering context, re-reading unchanged sources, or repeating dead ends.

## Product Contract

Agentpack is a local-first open-source tool. It does not connect to an agent's hidden memory or chat history. Instead, it keeps a portable task state in `.agentpack/` and exposes that state through simple surfaces:

- files in `.agentpack/`
- CLI commands
- a local MCP server
- project instructions such as `AGENTS.md`, `CLAUDE.md`, and Cursor rules

`.agentpack/` is local task state and is ignored by git by default. Export or bundle sanitized context when you want to hand work to another agent or chat.

## v0 Scope

The first version is intentionally small:

- initialize a local `.agentpack/`
- record decisions, dead ends, evidence, and inspected sources
- store file hashes so agents can avoid re-reading unchanged files
- check whether recorded sources are unchanged, changed, or missing
- create checkpoints with git status, git diff, and generated resume context
- export a budgeted handoff for ChatGPT or another manual target
- run a minimal local MCP server for agent clients

## Quick Start

```bash
npm install -g agentpack-cli
agentpack init
agentpack source add src/index.ts --summary "Main CLI entrypoint. Re-open only if hash changed."
agentpack source status
agentpack record decision "Use file-first JSON/JSONL storage for the MVP."
agentpack run "npm test"
agentpack checkpoint -m "CLI skeleton works; MCP server is next." --status "Ready for MCP polish" --next "Test MCP JSON-RPC flow"
agentpack resume --preset chat
agentpack export --to chatgpt --preset chat
agentpack doctor
```

For local development in this repo:

```bash
fnm use 22
npm ci --ignore-scripts
npm test
npm run mcp:smoke
node dist/src/agentpack.js --help
```

If `npm` is not available yet, install Node through `fnm` first:

```bash
brew install fnm
fnm install 22
fnm default 22
```

Then add this to `~/.zshrc` and restart the terminal:

```bash
eval "$(fnm env --use-on-cd --shell zsh)"
```

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide.

To verify the local MCP server without configuring an agent client yet:

```bash
npm run mcp:smoke
```

The smoke runner creates a temporary Agentpack workspace, starts `agentpack mcp`, sends `initialize`, `tools/list`, and a short `resume` flow, then deletes the temporary workspace.

## Security Posture

Agentpack keeps the v0 supply chain deliberately small:

- zero runtime dependencies
- exact dev dependency versions
- committed `package-lock.json`
- `ignore-scripts=true`
- no telemetry
- no network calls during normal CLI or MCP operation
- npm provenance prepared for future public releases

## Core Idea

Agentpack stores:

- goal and current status
- next actions
- decisions
- dead ends and failed approaches
- evidence and test outputs
- relevant files and source conclusions
- repo name, branch, commit hash, and git diff
- compact resume context under a rough token budget

The source cache is deliberately lightweight. Agentpack stores metadata, hashes, summaries, and optional snippets, not a full copy of the repository.

## Context Budgets

`--budget` is an approximate token target for generated handoff context. v0 uses a simple estimate, so the number is a practical ceiling, not a guarantee.

Suggested defaults:

- `1200`: quick status ping
- `4000`: normal chat handoff
- `8000`: deeper coding-agent handoff
- `16000`: large debugging session or review

When unsure, start with:

```bash
agentpack resume --preset chat
agentpack export --to chatgpt --preset chat
```

## MCP

`agentpack mcp` starts a stdio MCP server with tools for reading and writing task state:

- `load_context`
- `record_decision`
- `record_dead_end`
- `attach_evidence`
- `record_source`
- `checkpoint`
- `resume`
- `diff`
- `replay`

See [docs/MCP.md](docs/MCP.md) for the current MCP contract and smoke-test flow.

## Roadmap

```text
v0: CLI + markdown/json export + local source cache
v1: local MCP server + client installers
v2: stronger repo/file hashes, richer retrieval, and smarter budget packing
v3: shareable .agentpack bundle
v4: optional hosted sync/share
```
