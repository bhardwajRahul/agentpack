# Roadmap

## North Star

Agentpack is a local task-state layer for AI-assisted development. It captures useful working context that usually gets lost in chats: decisions, dead ends, inspected sources, evidence, checkpoints, and budgeted resumes.

Agentpack is not an orchestrator. It is the portable context ledger for humans, single agents, and agent teams working on a repo.

## Product Principles

- Local-first.
- No telemetry.
- No network calls by default.
- Zero runtime dependencies while practical.
- Git stores code state; Agentpack stores task context.
- `.agentpack/` is local state and ignored by git by default.
- Prefer simple file formats over hidden databases until the need is obvious.
- Avoid framework lock-in; integrate through CLI, files, MCP, and project instructions.

## v0.1: Usable Manual CLI

Goal: useful in any repo without MCP.

- Budget presets: `quick`, `chat`, `agent`, `deep`.
- Top-level `agentpack note`.
- `agentpack run <command>` to capture command output as evidence.
- Clear docs for setup, budgets, and local `.agentpack/` state.
- Keep runtime dependency-free.

## v0.2: Better Capture

Goal: make capture-as-you-go natural.

- `checkpoint --status --next` polish.
- `source status` for changed/unchanged/missing inspected files.
- Better evidence summaries in `resume`.
- Redaction tests.
- `doctor` command for repo/setup/MCP readiness.

## v0.3: Useful MCP

Goal: agents record task state while they work.

- Test MCP JSON-RPC flows.
- Polish tool contracts.
- `install codex`.
- `install claude`.
- `install cursor`.
- Project instructions that tell agents when to call tools.

## v0.4: Handoff Demo

Goal: show the wow effect.

Demo story:

1. Agent starts a bugfix.
2. Agent records inspected sources.
3. Agent runs tests and records failure.
4. Agent records a dead end.
5. Agent checkpoints.
6. New agent resumes under a 4k budget.
7. New agent avoids repeated work.

## v1.0: Reliable Local Tool

- Stable `.agentpack/` schema.
- Stable CLI.
- Stable MCP tools.
- Security model documented.
- npm publish as `agentpack-cli`.
- Good demo and examples.

## Later

- Shareable bundles.
- Optional imports from markdown handoffs.
- Orchestrator adapters.
- Optional hosted sync.
- UI.
- Embeddings or semantic indexing only after file/hash/source summaries stop being enough.
