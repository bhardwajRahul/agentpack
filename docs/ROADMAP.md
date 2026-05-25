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

## Near-Term Roadmap

### Now: Post-v0.1.12 Dogfood

Goal: dogfood the released v0.1.12 package and the local post-release Task Passport ergonomics patch before deciding whether to cut v0.1.13.

Recent dogfood confirmed these workflow pains and fixes:

- `task audit` was too noisy, so metadata drift is now separated from action-required task warnings
- quick current-task inspection was missing, so `agentpack task status` now exists
- switching chats or agents needed a compact task-first summary, so local main now has `agentpack task handoff`
- ending a task required too many manual steps, so local main now has `agentpack task finalize`
- the release flow is still manual, but it is tolerable enough to keep release automation deferred
- ledger cadence still needs dogfood attention so agents avoid recording every micro-step

Patch only blockers or cohesive ergonomics improvements during this period. Prefer safe, reviewable chunks that move the product forward without turning every tiny observation into a release.

### Current Patch: Task Passport Ergonomics

Implemented locally after v0.1.12:

- `agentpack task status`: short human-readable current task view
- `agentpack task handoff`: compact current-passport handoff for chat/client/worktree switches
- `agentpack task finalize`: a small ritual for evidence-backed verification and close
- softer audit output that separates action-required issues from accepted metadata warnings

Dogfood these together before deciding on a v0.1.13 release. Do not describe `task finalize` as available in the published v0.1.12 package.

### Release Flow

If release friction stays real after another release:

- add a `release:patch` helper or script
- make it do the version bump, checklist reminder, and maybe local preflight
- do not automate GitHub Actions or npm polling unless explicitly requested

### Docs And Product

After dogfood:

- update this roadmap to reflect the real post-Task-Passport state
- document the recommended multi-chat workflow: implementation, design review, and teach/learn
- simplify README positioning around the idea that Agentpack is a continuity ledger, not general AI memory

### Later

Only after the short dogfood and ergonomics pass:

- role lanes inside Task Passport
- better source-cache refresh ergonomics
- structured handoff between separate chats
- maybe `agentpack task handoff` as a compact current-passport-first export

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
