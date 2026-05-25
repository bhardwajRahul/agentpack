# Roadmap

## North Star

Agentpack makes agent continuity native to the repo.

It is a neutral task passport for agentic workspaces: a compact, portable record of decisions, source conclusions, evidence, dead ends, checkpoints, and next actions that survives chat compaction, client switches, worktree handoffs, machines, branches, and orchestrators.

See [VISION.md](VISION.md) for the fuller strategic framing.
See [TASK-PASSPORT.md](TASK-PASSPORT.md) for the target Task Passport schema and state transitions.

## Product Principles

- Local-first.
- No telemetry.
- No network calls by default.
- Zero runtime dependencies while practical.
- Git stores code state; Agentpack stores task context.
- `.agentpack/` is local state and ignored by git by default.
- Client integration files are local by default for v0; do not require teams to commit `.mcp.json`, `.codex/`, `.claude/`, `AGENTS.md`, or `CLAUDE.md`.
- Prefer simple file formats over hidden databases until the need is obvious.
- Avoid framework lock-in; integrate through CLI, files, MCP, and project instructions.
- Install Agentpack once, initialize it per repo, and keep chats/sessions out of the core model.
- Prefer reviewed task state over automatic full-session capture.

## State Model

Agentpack has five layers:

1. Tool install: the `agentpack` binary is installed once on a developer machine.
2. Repo init: each repo gets its own local `.agentpack/` directory.
3. Repo source cache: inspected source conclusions and file hashes can be reused across tasks in the same repo.
4. Task Passport: objective, constraints, write scope, status, decisions, dead ends, evidence, verification, checkpoints, and next actions belong to one coherent unit of work.
5. Role lanes: Scout, Builder, Reviewer, and Archivist can contribute to the current passport without creating separate tasks.

Agent sessions and web chats are transport surfaces. They should be able to resume, write, and hand off a task, but they are not first-class Agentpack state.

One active Task Passport owns the work in a repo worktree by default. Multiple passports can exist as closed history, parked work, or separate worktree handoffs, but Agentpack should not become a backlog manager or a code-conflict resolver.

Sharing passport state across machines or teammates is intentionally post-local-stability work. Prefer explicit sanitized export/import bundles before considering committed or synced shared state.

Target task UX:

```bash
agentpack init
agentpack task start "Claude Desktop MCP install" --write-scope src/integrations/install.ts --write-scope docs/INTEGRATIONS.md
agentpack task list
agentpack task switch claude-desktop-mcp-install
agentpack task passport
agentpack resume --preset agent
agentpack checkpoint -m "Desktop config tested"
agentpack task verify --status passed --summary "Desktop config tested"
agentpack task finalize
```

Target file shape:

```text
.agentpack/
  config.json
  sources.json
  tasks/
    current
    claude-desktop-mcp-install/
      passport.json
      events.jsonl
      checkpoints/
      evidence/
      exports/
```

This keeps source knowledge reusable across a repo while preventing unrelated work from mixing decisions, dead ends, and next actions. If another open passport claims overlapping write scope, Agentpack should warn and point the user toward reusing the current passport, parking one task, or moving work into a separate worktree.

Target consistency checks:

- current passport branch/head/worktree are visible in context
- source conclusions are validated by file hash
- write-scope overlap is detected before new work starts
- role lanes are advisory and scoped; Scout/Reviewer are read-oriented, Builder claims writes, Archivist records durable handoff state
- checkpoints remain append-only snapshots for recovery and handoff

## Dogfood Success Metrics

Agentpack should prove itself first in this repo. Measure whether it reduces repeated work and handoff friction while keeping the ledger compact.

Useful signals:

- resume usefulness: a fresh agent can explain the current task, constraints, relevant files, risks, and next action after `load_context` or `resume`
- re-read avoidance: unchanged source conclusions let agents skip re-opening files unless the task requires fresh inspection
- dead-end avoidance: recorded failed approaches are not repeated in later sessions
- handoff time: a new agent can continue meaningful work within a few minutes after context load
- verification quality: important changes have evidence, test output, or explicit reasoning attached before checkpoint
- ledger health: `agentpack doctor` reports zero changed or missing source records before release-like handoff
- overhead: recording useful state stays lightweight enough that it does not interrupt normal coding flow

The target is reliable continuation of the work that was worth preserving.

## Development Direction

Agentpack should grow by proving repo-native continuity in real work before adding orchestration breadth.

Priorities:

- make Task Passport handoff reliable and low-friction
- keep source-cache metadata useful without making audits noisy
- define workstream separation only after single-passport dogfood is stable
- support explicit, inspectable handoff/export between chats, clients, worktrees, and machines
- add orchestrator recipes after the local CLI/MCP contract is boring and stable
- keep release and ledger discipline simple enough to use during real work

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

## v0.4: Coding-Agent Demo

Goal: show the wow effect.

Before polishing the public demo, dogfood the workflow in this repo with the protocol in `AGENTS.md` and `docs/DOGFOOD.md`.

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
- Task Passport schema and one-current-passport workflow.
- Workstream separation for parked work, history, and worktree handoffs.
- Lightweight role lanes for Scout, Builder, Reviewer, and Archivist.
- Write-scope and stale-state warnings.
- Security model documented.
- npm publish as `agentpack-cli`.
- Good demo and examples.
- Public MCP-directory listing after the next polished release, for example FindMCP, mcp-list.com, MCPKit, MCP Server Directory, or similar current directories.

## Later

- Backup/export/import bundles for moving local task state between workspaces or fresh clones without committing live `.agentpack/` state.
- Shareable bundles.
- Optional imports from markdown handoffs.
- Orchestrator adapters.
- Optional hosted sync.
- UI.
- Embeddings or semantic indexing only after file/hash/source summaries stop being enough.
