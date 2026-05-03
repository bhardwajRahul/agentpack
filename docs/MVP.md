# Agentpack MVP

## Positioning

Agentpack helps AI agents continue work without rediscovering context, re-reading unchanged sources, or repeating dead ends.

The project is local-first and open-source by default. Optional hosted sync can come later, but the core value must work fully on a developer machine.

## Non-goals

- Do not store full chat transcripts by default.
- Do not pretend to access hidden agent memory.
- Do not upload code or task state anywhere.
- Do not require embeddings or hosted LLM calls in v0.
- Do not implement deterministic environment replay in v0.

## v0 Commands

```bash
agentpack init
agentpack source add <file> --summary <text>
agentpack record decision <text>
agentpack record dead-end <text>
agentpack evidence add --kind test-output --file <path>
agentpack checkpoint -m <summary>
agentpack resume --budget 4000
agentpack export --to chatgpt --budget 4000
agentpack diff
agentpack replay
agentpack mcp
agentpack install codex
agentpack install claude
agentpack install cursor
```

## v0 File Format

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

## Budget Policy

Budget packing is deterministic and approximate. The v0 token estimate is intentionally simple:

```text
estimated_tokens = ceil(characters / 4)
```

Resume sections are prioritized:

1. Goal, status, and next actions.
2. Git state.
3. Source cache and "do not re-open unless changed" guidance.
4. Decisions.
5. Dead ends.
6. Evidence.
7. Recent timeline.

