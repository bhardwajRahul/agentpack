# Manual CLI and Fallback

Agentpack's default workflow is MCP-connected: generated project instructions guide Codex, Claude Code, Cursor, and other MCP clients to load context, record durable task state, and checkpoint progress while they work.

Use the CLI directly when you want to inspect state yourself, debug an MCP setup, run a demo, or create a manual handoff for a web chat that cannot connect to local stdio MCP.

## Inspect State

```bash
agentpack resume --preset agent --query "MCP install"
agentpack source status
agentpack replay
agentpack diff
```

`resume --preset agent` shows the current goal, status, next actions, git state, durable decisions, dead ends, evidence, and source-cache guidance under a rough context budget.

`source status` tells you which recorded source conclusions are still valid and which files need to be reopened. It compares current file content to the hash recorded with the source conclusion; it is not a replacement for `git status`.

To clean up stale source-cache entries after files are deleted or conclusions are no longer useful:

```bash
agentpack source prune --missing
agentpack source remove docs/old-file.md
```

`source prune --missing` only removes records whose files no longer exist. `source remove <file>` removes one explicit source record.

## Task Passports

Task Passport support is the first step toward task-scoped handoffs. The current CLI can create and inspect a local passport under `.agentpack/tasks/`:

```bash
agentpack task start "Add source cleanup commands" \
  --objective "Let Agentpack remove stale source records safely" \
  --write-scope src/operations.ts \
  --write-scope src/cli/index.ts
agentpack task list
agentpack task passport
agentpack task block --reason "Waiting for API decision"
agentpack task verify
agentpack task close
```

`task passport` prints the current `passport.json`. `task switch <id>` points the worktree at another open passport. Existing `resume` and MCP tools still use the repo-level v0 ledger until passport-aware context loading is implemented.

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

## Budgets

`--budget` is an approximate token target. The presets are:

- `1200`: quick status ping
- `4000`: compact manual handoff
- `8000`: deeper coding-agent handoff
- `16000`: large debugging session or review

`--query` locally filters Source Cache: matched sources keep full summaries/snippets, changed or missing source records are always shown in full, and unrelated unchanged sources stay visible as compact stubs. If nothing matches, Agentpack keeps the full Source Cache to avoid false-negative filtering.
