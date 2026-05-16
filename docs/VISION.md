# Vision

## Strategic North Star

Agentpack makes agent continuity native to the repo.

It is a neutral task passport for agentic workspaces: a compact, portable record of decisions, source conclusions, evidence, dead ends, checkpoints, and next actions that survives chat compaction, client switches, worktree handoffs, machines, branches, and orchestrators.

## Product Bet

As agent UIs evolve from chat boxes into execution workspaces, handoffs will become common: chat to worktree, IDE to background agent, local repo to cloud sandbox, Claude to Codex, Cursor to CI.

Branches and transcripts are not enough. Agents need reviewed task state that is portable, inspectable, and client-neutral.

Agentpack is not trying to replace execution engines. Codex, Claude Code, Cursor, LangGraph, Temporal, OpenAI Agents SDK, and similar systems can own execution loops, retries, approvals, tool calls, and durable runs. Agentpack should own the neutral repo-scoped continuity layer that those surfaces can share.

## What Agentpack Should Own

- repo-native continuity
- semantic checkpoints
- source-inspection cache
- dead-end memory
- evidence-linked handoffs
- MCP-first access
- portable bundles between worktrees, machines, and clients
- orchestrator recipes later

## Operating Principles

- Git stores code state. Agentpack stores reviewed task state.
- Execution engines run the work. Agentpack preserves what future agents need to continue it.
- Continuity should be native to the repo, not reconstructed from chat history.
- Prefer small, inspectable, local files before hosted sync or hidden databases.
- Prefer portable MCP, CLI, and file surfaces over framework lock-in.
- Record durable context, not every action.

## Non-Goals

- Do not become a general chat archive.
- Do not replace LangGraph, Temporal, OpenAI Agents SDK, Codex, Claude Code, Cursor, or other execution engines.
- Do not make cloud sync or hosted memory required for the core workflow.
- Do not treat automatic full-session capture as the default source of truth.
- Do not require embeddings or network calls before deterministic file/hash/source summaries stop being enough.
