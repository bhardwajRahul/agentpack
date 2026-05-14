# Agentpack

Local task-state ledger for AI coding agents.

> Coding agents forget. Agentpack gives them the task state they need to continue.

Agentpack helps coding agents continue long-running repo work without rediscovering context, re-reading unchanged sources, or repeating dead ends.

## Product Contract

Agentpack is a local-first open-source tool for repo-scoped coding work. It is not a general AI memory, a knowledge graph, an automatic activity logger, or a chat archive. Instead, it keeps a compact task ledger in `.agentpack/` and exposes that state through simple surfaces:

- files in `.agentpack/`
- CLI commands
- a local MCP server
- project instructions such as `AGENTS.md`, `CLAUDE.md`, and Cursor rules

`.agentpack/` is local task state and is ignored by git by default. Agentpack is designed first for coding agents such as Codex, Claude Code, Cursor, and other MCP clients. Markdown export exists as a fallback for manual handoff, not as the primary workflow.

The core contract is simple: Git stores code state; Agentpack stores reviewed task state. It captures the decisions, source conclusions, evidence, and checkpoints that help the next agent continue correctly.

## When Agentpack Helps

Agentpack is for durable task continuity. It helps when:

- Claude compacts context and the next agent needs the useful state back
- you start a new chat or coding-agent session
- you move or copy a project folder and want the repo's task state to move with it
- you switch between Claude Code, Cursor, Codex, or another MCP client
- you return to a refactor or bugfix later
- another agent needs to continue from your checkpoint

The cost benefit is a side effect: agents spend less time re-reading unchanged files and re-explaining decisions because the repo keeps the task state locally.

## v0 Scope

The first version is intentionally small:

- initialize a local `.agentpack/`
- record decisions, dead ends, evidence, and inspected sources
- store file hashes so agents can avoid re-reading unchanged files
- check whether recorded sources are unchanged, changed, or missing
- create checkpoints with git status, git diff, and generated resume context
- run a minimal local MCP server for coding-agent clients
- export a budgeted markdown handoff for manual fallback workflows

## Install

Agentpack requires Node.js >= 20.

```bash
npm install -g agentpack-cli
agentpack --version
```

If you don't have Node yet, install it through [`fnm`](https://github.com/Schniz/fnm):

```bash
brew install fnm
fnm install 22
fnm default 22
echo 'eval "$(fnm env --use-on-cd --shell zsh)"' >> ~/.zshrc
exec zsh
```

## Quick Start

```bash
cd path/to/your/repo
agentpack init
agentpack install codex --write
# or: agentpack install claude --write
# or: agentpack install cursor --write
# or: agentpack install claude-desktop --write  (writes a snippet to merge manually)
```

Run `agentpack init` once per repo. Then run `agentpack install <client> --write` for each coding-agent client you want to use in that repo.

Restart or reconnect the coding-agent client. The generated project instructions tell the agent to load Agentpack context at the start, record durable decisions/sources/evidence while working, and checkpoint meaningful progress.

Use `agentpack doctor` to verify the local setup. Use `agentpack resume --preset agent --query "<topic>"` when you want to inspect the task state yourself.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for safe Codex, Claude Code, Cursor, and Claude Desktop setup.
See [docs/agentpack-flow.md](docs/agentpack-flow.md) for a visual execution flow.
See [docs/DEMOS.md](docs/DEMOS.md) for compact continuity demo outlines.

## Verify a workflow-published release

Versions published by the GitHub Actions release workflow ship with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). To verify that tarball was built from a known commit of this repo:

```bash
npm audit signatures
```

For those versions, you can also inspect the attestation manually at <https://www.npmjs.com/package/agentpack-cli> under the **Provenance** tab — it links back to the exact commit, workflow run, and build environment that produced the package.

## Contributing / local development

Clone the repo and use Node 22:

```bash
fnm use 22
npm ci --ignore-scripts
npm test
npm run mcp:smoke
node dist/src/agentpack.js --help
```

This repo uses Agentpack itself through MCP — see [docs/DOGFOOD.md](docs/DOGFOOD.md) for the working protocol and [docs/SETUP.md](docs/SETUP.md) for the full setup guide. Release process is documented in [docs/RELEASING.md](docs/RELEASING.md).

To verify the local MCP server without configuring an agent client yet:

```bash
npm run mcp:smoke
```

The smoke runner creates a temporary Agentpack workspace, starts `agentpack mcp`, sends `initialize`, `tools/list`, and a short `resume` flow, then deletes the temporary workspace.

## Coding-Agent Loop

Agentpack works as a hybrid loop. Humans can save and export state manually through the CLI, while MCP-connected coding agents can follow the generated project instructions and call Agentpack tools during the task.

For a manual CLI flow:

```bash
agentpack resume --preset agent --query "MCP install"
agentpack source status
agentpack record decision "Use project-local MCP config instead of editing global config automatically"
agentpack checkpoint -m "MCP install tested" --status "Ready for docs polish" --next "Update integration docs"
agentpack export --to markdown --preset chat --query "MCP install"
```

For a large refactor, you can also tell the agent directly: "Before you start, load Agentpack context; while you work, record durable decisions, source conclusions, dead ends, and test evidence; checkpoint when the step is coherent." The generated `AGENTS.md`, `CLAUDE.md`, and Cursor rules say the same thing, so connected agents can do this without turning every action into a log entry.

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
- release workflow publishing through GitHub Actions with npm provenance and Trusted Publisher OIDC (no long-lived npm tokens)

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
