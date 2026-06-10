# Agentpack MVP

## Positioning

Agentpack helps coding agents continue repo work without rediscovering context, re-reading unchanged sources, or repeating dead ends.

The project is local-first and open-source by default. Optional hosted sync can come later, but the core value must work fully on a developer machine.

Agentpack is a task-state ledger, not an automatic memory engine. Humans can record and export state manually through the CLI; MCP-connected coding agents can follow generated project instructions and call the same tools while they work.

## Non-goals

- Do not store full chat transcripts by default.
- Do not pretend to access hidden agent memory.
- Do not auto-capture every tool call or agent action in v0.
- Do not upload code or task state anywhere.
- Do not require embeddings or hosted LLM calls in v0.
- Do not implement deterministic environment replay in v0.

## v0 Commands

```bash
agentpack init
agentpack source add <file> --summary <text>
agentpack source status
agentpack record decision <text>
agentpack record dead-end <text>
agentpack evidence add --kind test-output --file <path>
agentpack note <text>
agentpack run <command>
agentpack checkpoint -m <summary> --status <text> --next <item>
agentpack resume --preset agent --query <text>
agentpack export --to markdown --preset chat --query <text>
agentpack diff
agentpack replay
agentpack doctor
agentpack mcp
agentpack install codex
agentpack install claude
agentpack install claude-desktop
agentpack install cursor
```

## v0 File Format

`--query` is optional. Without it, resume/export include the full Source Cache. With it, Agentpack uses local lexical matching to include full source summaries and snippets for query-relevant records. Query-unrelated records remain visible as compact path/status/topic/guidance stubs; changed or missing query-unrelated records are shown as warning stubs and point to `source_status` for full stale details. If nothing matches, Agentpack keeps compact stubs for all recorded sources and tells the caller to rerun without `--query` when the full Source Cache is needed.

```text
.agentpack/
  config.json
  state.json
  events.jsonl
  sources.json
  checkpoints/
  evidence/
  instructions/
  exports/
  cache/
```

`events.jsonl` is the append-only task ledger. `sources.json` records file hashes, summaries, and optional snippets. `checkpoints/` stores materialized resume snapshots plus git metadata.

Agentpack files are ignored by git by default. `agentpack init` appends the local-only Agentpack patterns to the project `.gitignore` when needed and preserves existing project rules. `.agentpack/` is local working state, not a repository artifact. Client integration files such as `.mcp.json`, `.codex/`, `.claude/`, `AGENTS.md`, and `CLAUDE.md` are also local developer setup for v0 and should normally stay ignored.

Client install commands use the repo name when writing MCP server keys, for example `agentpack-example-app`, so ignored local configs in different repos do not shadow a global `agentpack` server.

Team sharing is intentionally out of scope until after local-only workflows stabilize. The first sharing surface should be explicit export/import bundles, not committing live ledger state or local client config.

## Budget Policy

Budget packing is deterministic. The v0 token estimate is intentionally approximate and simple:

```text
estimated_tokens = ceil(characters / 4)
```

Generated resumes include the requested budget, estimated usage, and a budget status line. A positive explicit budget is a hard ceiling for the local estimate. If the requested budget is too small, Agentpack reports which required sections were truncated and which optional sections were omitted when that metadata fits; extremely small budgets use a strict clipped fallback.

Resume sections are prioritized:

1. Goal, status, and next actions.
2. Git state.
3. Source cache and "do not re-open unless changed" guidance.
4. Decisions.
5. Dead ends.
6. Evidence.
7. Compact recent timeline digest.

The timeline digest is intentionally compact. Full event history stays available through `agentpack replay`; resume output should avoid repeating source summaries, decisions, and evidence previews that already appear in dedicated sections.

Suggested presets:

```text
1200: quick status ping
4000: compact manual handoff
8000: deeper coding-agent handoff
16000: large debugging session or review
```

MCP clients should choose the smallest budget that preserves next-action safety. Humans can override it per command.
