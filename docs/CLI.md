# Manual CLI and Fallback

Agentpack's default workflow is MCP-connected: generated project instructions guide Codex, Claude Code, Cursor, and other MCP clients to load context, record durable task state, and checkpoint progress while they work.

Use the CLI directly when you want to inspect state yourself, debug an MCP setup, run a demo, or create a manual handoff for a web chat that cannot connect to local stdio MCP.

Use `agentpack <command> --help` for command-specific help. These help screens do not require an initialized `.agentpack/` directory and do not execute the command.

## Inspect State

```bash
agentpack resume --preset agent --query "MCP install"
agentpack source status
agentpack source status --changed
agentpack source status --missing
agentpack ledger status
agentpack doctor
agentpack replay
agentpack diff
agentpack release preflight
```

`resume --preset agent` shows the current goal, status, next actions, git state, durable decisions, dead ends, evidence, and source-cache guidance under a rough context budget.

`source status` tells you which recorded source conclusions are still valid and which files need to be reopened. It compares current file content to the hash recorded with the source conclusion; it is not a replacement for `git status`. Use `--changed` or `--missing` to focus triage on stale records.

Changed source records require semantic review, not hash-only refresh. After reopening a changed file and confirming the durable conclusion, update the record with a fresh summary:

```bash
agentpack source review src/checkout.ts --summary "Checkout totals still flow through calculateTotals; tax handling moved into normalizeLineItems."
```

To clean up stale source-cache entries after files are deleted or conclusions are no longer useful:

```bash
agentpack source prune --missing
agentpack source remove docs/old-file.md
```

`source prune --missing` only removes records whose files no longer exist. `source remove <file>` removes one explicit source record.

`ledger status` prints a read-only hygiene inventory: task counts, event/evidence/checkpoint/export sizes, referenced evidence counts, and source-cache status counts. It does not delete, compact, archive, or refresh anything.

`doctor` checks pack setup, local integration config, git availability, and source-cache health. Changed or missing source records are warnings, not setup failures; use `agentpack source status --changed --missing` to review details before a release-like handoff.

`release preflight` prints a read-only release-prep report and checklist for
this repo. It checks local release metadata and Trusted Publisher wiring, then
prints the manual release-prep commands. It does not push, tag, publish, or
create GitHub Releases.

## Task Passports

Task Passport support is the first step toward task-scoped handoffs. The current CLI can create and inspect a local passport under `.agentpack/tasks/`:

```bash
agentpack task start "Fix checkout discount bug" \
  --objective "Make discount totals consistent across cart and checkout" \
  --write-scope src/checkout.ts \
  --write-scope src/cart.ts
agentpack task update \
  --next "Run focused regression tests" \
  --write-scope tests/checkout.test.ts \
  --risk medium
agentpack task list
agentpack task status
agentpack task verify --status passed --evidence evt_... --summary "Focused checks passed"
agentpack task handoff
agentpack task finalize
```

Write scopes are repo-relative paths. `.` means the repository root.

The common workflow is:

1. `task start` declares the work.
2. `task status` gives a quick current-task view.
3. `task update` keeps objective, scope, risk, or next actions current.
4. `task verify` records the verification result and linked evidence.
5. `task handoff` prints the compact summary for another chat, client, worktree, or agent.
6. `task finalize` closes the task after verification is final.

When work is deferred so another task can become current, use `task park`
instead of `task finalize`. Finalization is the end-of-task ritual; parking is
the pause-and-switch ritual.

Use `agentpack task --help` for the task-focused command list.

`task start` refuses to replace an active, blocked, or verifying current task; park or close the current task first when starting unrelated work. Invalid risk values are rejected instead of being treated as unknown.

`task audit` checks the current passport for branch/head drift, missing next actions, open verification, closed-task anomalies, and source-cache metadata drift. Metadata warnings are shown separately so they do not look like action-required task failures.

`task passport` prints the current `passport.json`. `task switch <id>` points the worktree at another open passport. `task block --reason <text>`, `task park`, and `task close` remain available for explicit lifecycle control. `task update-verification` remains available as a compatibility alias for `task verify`.

`task finalize --status accepted` refuses to close a task that still has next
actions, because that usually means the task should be parked instead. Pass
`--force` only when those remaining next actions are intentionally historical
and the task is genuinely accepted as-is.

Repeated identical verification updates are treated as no-ops, so retrying the same `task verify` command does not add duplicate task events.

When a current passport exists, `resume` and MCP `load_context` include it above the repo-level ledger so agents can see the active task before broader history.

## Record Durable State

Use these commands sparingly. Agentpack is not an activity logger; record the context a future agent would actually need.

```bash
agentpack record decision "Use project-local MCP config instead of editing global config automatically"
agentpack record dead-end "GUI apps may not inherit shell PATH for MCP launchers." --reason "Cursor and Claude Desktop can start outside the login shell"
agentpack source add src/integrations/install.ts --summary "Install flow writes project-local client config and generated agent instructions."
agentpack evidence add --kind test-output --file test.log
agentpack checkpoint -m "MCP install tested" --status "Ready for docs polish" --next "Update integration docs"
```

For command output, `agentpack run "npm test"` can capture useful evidence while also running the command.

## Web-Chat Handoff

When MCP is unavailable, export a compact markdown handoff and paste it into the next chat:

```bash
agentpack export --to markdown --preset chat --query "MCP install"
```

For the normal coding-agent workflow, prefer MCP and `resume --preset agent`. Markdown export is a fallback for clients that cannot read local MCP tools.

## Structured Bundles

Structured task bundles are an explicit portability surface for read-only task
handoff between workspaces:

```bash
agentpack bundle export --task current --output checkout.agentpack-bundle.json \
  --source src/checkout.ts
agentpack bundle inspect checkout.agentpack-bundle.json [--json]
agentpack bundle import-plan checkout.agentpack-bundle.json [--json]
```

`bundle export` writes one redacted, deterministic JSON file containing a
portable passport snapshot, compact handoff, explicitly selected source
conclusions, and referenced text/JSON evidence. The existing markdown `export`
command remains unchanged.

`bundle inspect` validates and summarizes a bundle without requiring an
initialized pack.

`bundle import-plan` validates the same untrusted bundle, compares its task id
and retained bundle digest with the destination workspace, and reports a
create, idempotent, or conflict outcome. It is read-only, also works before
`agentpack init`, and returns an explicit empty write set in JSON mode.

Write-enabled import and `--as-new` conflict remapping are not implemented yet.

See [TASK-PASSPORT.md](TASK-PASSPORT.md) for the bundle schema, inclusion rules,
security boundaries, and collision behavior.

## Budgets

`--budget` is a hard ceiling for Agentpack's approximate local token estimate. The presets are:

- `1200`: quick status ping
- `4000`: compact manual handoff
- `8000`: deeper coding-agent handoff
- `16000`: large debugging session or review

`--query` locally filters Source Cache: matched sources keep full summaries/snippets, and query-unrelated sources stay visible as compact path/status/topic/guidance stubs. Changed or missing query-unrelated records are warning stubs, not trusted conclusions; run `agentpack source status --changed --missing` for full stale details. If nothing matches, Agentpack keeps compact stubs for all recorded sources and tells you to rerun without `--query` when the full Source Cache is needed.
