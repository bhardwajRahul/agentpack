# Dogfood Workflow

Dogfooding means using Agentpack to develop Agentpack itself. The goal is to prove the workflow in real coding sessions before adding more features.

## Start A Session

Load a small context first:

```text
load_context(preset: "quick")
source_status()
```

Use `agent` instead of `quick` when the task needs more history.

## During Work

Record only durable context. Do not log every thought.

Default cadence:

- At task start, load Agentpack context and source status.
- During normal coding, keep working locally; record only durable decisions, dead ends, source conclusions, and evidence.
- At the end of a coherent step, record the useful sources/evidence, update status and next actions, then checkpoint.
- Use full safe mode for risky or release-like changes: record important findings as they happen and run the full verification loop.

This keeps Agentpack useful without turning every micro-step into ledger traffic.

```text
record_source(path, summary)
record_decision(text, files, evidence)
record_dead_end(text, reason, files)
attach_evidence(kind, content, command, exitCode)
```

Good source summaries are conclusions, not file descriptions:

```text
src/integrations/install.ts: install uses a dry-run plan by default and writes only project-local files with --write.
```

Good dead ends prevent repeated work:

```text
Do not auto-edit ~/.codex/config.toml. It is safer to generate a reviewed snippet for manual install.
```

## End A Meaningful Step

Checkpoint when the repo reaches a coherent state:

```text
checkpoint(
  summary: "Safe MCP install flow is implemented and tested.",
  status: "Codex MCP setup can be dogfooded in this repo.",
  nextActions: ["Run through the handoff demo with a fresh session."]
)
```

Git still owns code history. Agentpack owns task memory.

## What To Watch

While dogfooding, look for friction:

- Did the agent call `load_context` and `source_status` early enough?
- Were unchanged sources avoided when recorded conclusions were enough?
- Were decisions and dead ends recorded at useful moments?
- Was evidence too noisy or too thin?
- Was the checkpoint useful to the next session?

If the answer is no, improve the tool contract or the project instructions before adding larger features.
