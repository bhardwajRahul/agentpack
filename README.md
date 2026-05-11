<p align="center">
  <img src="assets/agentpack-logo.jpg" alt="Agentpack logo" width="180">
</p>

# Agentpack

Local task-state ledger for AI coding agents.

> Coding agents forget. Agentpack gives them the task state they need to continue.

Agentpack helps coding agents continue long-running repo work without rediscovering context, re-reading unchanged sources, or repeating dead ends.

## Product Contract

Agentpack is a local-first open-source tool for repo-scoped coding work. It is not a general AI memory, a knowledge graph, or a chat archive. Instead, it keeps a compact task ledger in `.agentpack/` and exposes that state through simple surfaces:

- files in `.agentpack/`
- CLI commands
- a local MCP server
- project instructions such as `AGENTS.md`, `CLAUDE.md`, and Cursor rules

`.agentpack/` is local task state and is ignored by git by default. Agentpack is designed first for coding agents such as Codex, Claude Code, Cursor, and other MCP clients. Markdown export exists as a fallback for manual handoff, not as the primary workflow.

## v0 Scope

The first version is intentionally small:

- initialize a local `.agentpack/`
- record decisions, dead ends, evidence, and inspected sources
- store file hashes so agents can avoid re-reading unchanged files
- check whether recorded sources are unchanged, changed, or missing
- create checkpoints with git status, git diff, and generated resume context
- run a minimal local MCP server for coding-agent clients
- export a budgeted markdown handoff for manual fallback workflows

## Quick Start

```bash
npm install -g agentpack-cli
agentpack init
agentpack source add src/index.ts --summary "Main CLI entrypoint. Re-open only if hash changed."
agentpack source status
agentpack record decision "Use file-first JSON/JSONL storage for the MVP."
agentpack run "npm test"
agentpack checkpoint -m "CLI skeleton works; MCP server is next." --status "Ready for MCP polish" --next "Test MCP JSON-RPC flow"
agentpack resume --preset agent --query "MCP server"
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

This repo uses Agentpack itself through MCP. See [docs/DOGFOOD.md](docs/DOGFOOD.md) for the working protocol.

To verify the local MCP server without configuring an agent client yet:

```bash
npm run mcp:smoke
```

The smoke runner creates a temporary Agentpack workspace, starts `agentpack mcp`, sends `initialize`, `tools/list`, and a short `resume` flow, then deletes the temporary workspace.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for safe Codex, Claude Code, and Cursor setup.
See [docs/agentpack-flow.html](docs/agentpack-flow.html) for a visual execution flow.

## Coding-Agent Loop

Agentpack's core loop is built for coding agents working in the same repo over long sessions, compaction, restarts, or handoffs:

```bash
agentpack resume --preset agent --query "MCP install"
agentpack source status
agentpack checkpoint -m "MCP install tested" --status "Ready for docs polish" --next "Update integration docs"
```

`resume --preset agent` gives the next coding agent the current goal, status, next actions, git state, durable decisions, dead ends, evidence, and source-cache guidance under a rough context budget. `source status` tells the agent which recorded source conclusions are still valid and which files need to be reopened. It compares the current file content to the hash recorded with the source conclusion; it is not a replacement for `git status`. Each recorded source shows hash status and git status separately, and git changes that were never recorded as sources are listed separately.

For manual web-chat fallback, `export --to markdown --preset chat` writes a handoff file under `.agentpack/exports/`. For the normal coding-agent workflow, `resume --preset agent` prints a larger task state directly in the terminal or MCP response. Add `--query` when you want Source Cache to include full summaries for sources relevant to the next task, always include changed/missing source records in full, and keep compact path/status/topic stubs for the rest.

In a new session, start by loading Agentpack MCP context, or by pasting a markdown handoff when MCP is not available. Then inspect only the files marked changed or missing. During work, record durable decisions, failed approaches, evidence, and source conclusions. End a coherent step with a checkpoint so the next agent inherits a compact state instead of a pile of chat history.

## Security Posture

Agentpack keeps the v0 supply chain deliberately small:

- zero runtime dependencies
- exact dev dependency versions
- committed `package-lock.json`
- `ignore-scripts=true`
- no telemetry
- no network calls during normal CLI or MCP operation
- best-effort redaction for common secret-looking values in stored context and handoff outputs
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

`--budget` is an approximate token target for generated handoff context. v0 uses a simple estimate, so the number is a practical target, not an exact API token count. Resume output includes estimated usage and a budget status line that says whether any sections were omitted or truncated.

`--query` is an optional local filter for Source Cache. It uses deterministic lexical matching, not embeddings or network calls. Matching sources keep their summaries and snippets; changed or missing source records are always shown in full; non-matching unchanged sources stay visible as compact stubs with path, short topic, hash status, meaning, and guidance. If nothing matches, Agentpack keeps the full Source Cache to avoid false-negative filtering.

Suggested defaults:

- `1200`: quick status ping
- `4000`: compact manual handoff
- `8000`: deeper coding-agent handoff
- `16000`: large debugging session or review

When unsure, start with:

```bash
agentpack resume --preset quick --query "MCP install"
agentpack resume --preset agent --query "MCP install"
```

## MCP

`agentpack mcp` starts a stdio MCP server with tools for reading and writing task state:

- `load_context`
- `record_decision`
- `record_dead_end`
- `attach_evidence`
- `record_source`
- `source_status`
- `checkpoint`
- `resume`
- `diff`
- `replay`

See [docs/MCP.md](docs/MCP.md) for the current MCP contract and smoke-test flow.

## Roadmap

```text
v0: CLI + local source cache + markdown fallback export
v1: local MCP server + coding-agent installers
v2: stronger repo/file hashes, richer retrieval, and smarter budget packing
v3: shareable .agentpack bundle
v4: optional hosted sync/share
```
