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
- task passports as the handoff artifact
- semantic checkpoints
- source-inspection cache
- dead-end memory
- evidence-linked handoffs
- MCP-first access
- portable bundles between worktrees, machines, and clients
- orchestrator recipes later

## Task Passport Model

A Task Passport is the handoff artifact for one coherent unit of agentic work. It should capture the objective, constraints, write scope, relevant source conclusions, decisions, dead ends, evidence, verification state, checkpoints, and next actions.

One active Task Passport should own the work in a repo worktree by default. A repo can keep many closed or parked passports over time, but Agentpack should not turn one working directory into a backlog or a multi-task merge engine.

Workstreams are how passports stay separated across repo work, branches, and worktrees. They are for history, parked work, and handoff boundaries, not a substitute for issue tracking or code conflict resolution.

Multi-role agents should collaborate inside one Task Passport:

- Scout: inspect sources and record source conclusions
- Builder: make changes inside the declared write scope
- Reviewer: check the diff, risks, and verification
- Archivist: record evidence, checkpoints, and handoff state

Agentpack should support those role lanes as lightweight prompts, metadata, and consistency checks before it attempts any heavier orchestration.

## Operating Principles

- Git stores code state. Agentpack stores reviewed task state.
- Execution engines run the work. Agentpack preserves what future agents need to continue it.
- Continuity should be native to the repo, not reconstructed from chat history.
- One Task Passport owns the current work; multiple roles can contribute to it.
- Prefer small, inspectable, local files before hosted sync or hidden databases.
- Prefer portable MCP, CLI, and file surfaces over framework lock-in.
- Record durable context, not every action.

## Non-Goals

- Do not become a general chat archive.
- Do not become an issue tracker or backlog manager.
- Do not try to solve code merge conflicts between parallel tasks.
- Do not replace LangGraph, Temporal, OpenAI Agents SDK, Codex, Claude Code, Cursor, or other execution engines.
- Do not make cloud sync or hosted memory required for the core workflow.
- Do not treat automatic full-session capture as the default source of truth.
- Do not require embeddings or network calls before deterministic file/hash/source summaries stop being enough.
