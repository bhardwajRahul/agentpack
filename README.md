# Agentpack

[![npm version](https://img.shields.io/npm/v/agentpack-cli)](https://www.npmjs.com/package/agentpack-cli)
[![CI](https://github.com/ihorponom/agentpack/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ihorponom/agentpack/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/agentpack-cli)](https://www.npmjs.com/package/agentpack-cli)
[![license](https://img.shields.io/npm/l/agentpack-cli)](LICENSE)

Repo-native task continuity for AI coding agents.

> Coding agents forget. Agentpack gives them the task state they need to continue.

Mirror: [Codeberg](https://codeberg.org/ihorponom/agentpack). Issues, releases, and npm provenance stay on GitHub.

Agents lose continuity across chats, clients, worktrees, and compaction. Agentpack stores reviewed task state in repo-local `.agentpack/` so MCP-connected coding agents can continue without rediscovering context or repeating dead ends, while avoiding unnecessary source re-reading when a current hash-validated conclusion is sufficient.

## Product Contract

Agentpack is a local-first continuity layer for repo-scoped coding work. Execution engines run the work. Git stores code state. Agentpack stores reviewed task state so the next agent can continue safely.

Agentpack keeps a compact, inspectable task ledger in `.agentpack/` and exposes that state through simple surfaces:

- a local MCP server
- project instructions such as `AGENTS.md`, `CLAUDE.md`, and Cursor rules
- CLI commands for setup, inspection, debugging, and fallback
- files in `.agentpack/`

`.agentpack/` is local task state and is ignored by git by default. Agentpack is designed first for coding agents such as Codex, Claude Code, Cursor, and other MCP clients. Markdown export is available for manual handoff when MCP is unavailable.

The normal workflow is hybrid: generated client instructions tell MCP-connected agents when to load context, record durable decisions, attach evidence, cache reviewed source conclusions, and checkpoint meaningful progress. Humans can still use the CLI directly when they want to inspect state, debug MCP, run demos, or fall back to a web chat.

## Core Idea

Agentpack stores the reviewed task state a future agent needs:

- goal, current status, and next actions
- decisions and failed approaches
- evidence and test outputs
- relevant files and source conclusions
- repo name, branch, commit hash, and git diff
- compact resume context under a rough token budget

The source cache is deliberately lightweight. Agentpack stores metadata, hashes, summaries, and optional snippets, not a full copy of the repository.

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
- manage a current Task Passport for task-scoped handoff and verification
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
See [docs/agentpack-architecture.html](docs/agentpack-architecture.html) for the architecture and flow map.
See [docs/CLI.md](docs/CLI.md) for manual CLI and web-chat fallback commands.
See [docs/DEMOS.md](docs/DEMOS.md) for compact continuity demo outlines.
See [docs/VISION.md](docs/VISION.md) for the strategic north star.

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
node dist/src/agentpack.js task --help
```

This repo uses Agentpack itself through MCP — see [docs/DOGFOOD.md](docs/DOGFOOD.md) for the working protocol and [docs/SETUP.md](docs/SETUP.md) for the full setup guide. Release process is documented in [docs/RELEASING.md](docs/RELEASING.md).

To verify the local MCP server without configuring an agent client yet:

```bash
npm run mcp:smoke
```

The smoke runner creates a temporary Agentpack workspace, starts `agentpack mcp`, sends `initialize` and `tools/list`, exercises source status plus Task Passport lifecycle tools, then deletes the temporary workspace.

## Hybrid Agent Loop

Agentpack's default loop is MCP-connected and agent-led:

1. The agent starts a session by loading compact Agentpack context for the repo.
2. Before relying on prior source conclusions, it checks whether recorded files are unchanged, changed, or missing.
3. While working, it records durable decisions, failed approaches, useful evidence, and reviewed source conclusions.
4. At handoff or completion time, it verifies the Task Passport, prints a compact handoff, and finalizes the task when verification is final.
5. At a coherent boundary, it creates a checkpoint with status, next actions, git state, and a compact resume.
6. The next Codex, Claude Code, Cursor, or MCP-capable agent continues from that task state instead of rebuilding it from chat history.

The CLI mirrors this loop for humans, demos, debugging, and web-chat fallback. See `agentpack task --help` and [docs/CLI.md](docs/CLI.md) for manual commands.

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

## Context Budgets

Agentpack compresses task state with a rough local token estimate so agents can resume with the useful state, not a pile of history. A positive explicit budget is a hard ceiling for that estimate. `load_context`, `resume`, and `export` can focus Source Cache with a local `--query` filter: matched sources keep full summaries/snippets, query-unrelated sources stay visible as compact path/status/topic/guidance stubs, and stale query-unrelated records point agents to `source_status` before relying on them.

See [docs/CLI.md](docs/CLI.md) for manual budget and export commands.

## MCP

`agentpack mcp` is the primary runtime surface for connected coding agents. It starts a local stdio MCP server with tools for reading and writing task state:

- `load_context`
- `record_decision`
- `record_dead_end`
- `attach_evidence`
- `record_source`
- `source_status`
- `task_audit`
- `release_preflight`
- `task_handoff`
- `task_list`
- `task_park`
- `task_role`
- `task_start`
- `task_status`
- `task_switch`
- `task_update`
- `task_update_verification`
- `task_finalize`
- `checkpoint`
- `resume`
- `diff`
- `replay`

See [docs/MCP.md](docs/MCP.md) for the current MCP contract and smoke-test flow.

## Roadmap

Current:

- repo-local `.agentpack/` ledger
- local MCP server
- Codex, Claude Code, Claude Desktop, and Cursor installers
- current Task Passport workflow for task-scoped handoff
- compact handoff view for switching chats, clients, worktrees, or agents
- reviewed source cache with file hashes
- decisions, dead ends, evidence, checkpoints, and budgeted resumes
- markdown fallback export

Next:

- workstream separation for multiple parked or handed-off task passports
- semantic checkpoints and evidence-linked handoffs
- explicit export/import bundles for worktrees, machines, and clients
- orchestrator recipes

See [docs/ROADMAP.md](docs/ROADMAP.md) for the detailed roadmap.
