# MCP

`agentpack mcp` starts a local stdio MCP server. This is Agentpack's primary runtime surface for connected coding agents.

The MCP stdio transport uses newline-delimited JSON-RPC messages over stdin/stdout. The client launches Agentpack as a subprocess, sends JSON-RPC messages to stdin, and reads JSON-RPC responses from stdout. Agentpack must not write non-MCP logs to stdout.

Reference: [Model Context Protocol transports](https://modelcontextprotocol.io/docs/concepts/transports).

## Default Client Loop

Generated Codex, Claude Code, and Cursor instructions tell connected agents to use the MCP tools as a small hybrid continuity loop:

1. Start by calling `load_context` with a focused query and compact preset.
2. Call `source_status` before relying on previously recorded source conclusions.
3. Record durable decisions, dead ends, evidence, and reviewed source conclusions while working.
4. Call `checkpoint` after meaningful progress so the next session inherits status, next actions, git state, and compact resume context.

The CLI exposes the same operations for setup, inspection, debugging, demos, and web-chat fallback. See [CLI.md](CLI.md) for manual command examples.

## Tools

- `load_context`
- `record_decision`
- `record_dead_end`
- `attach_evidence`
- `record_source`
- `source_status`
- `checkpoint`
- `resume`
- `diff`
- `replay`

`load_context` and `resume` accept `query`, `budget`, and `preset`. When `query` is present, Agentpack filters Source Cache locally: matched sources keep full summaries/snippets, changed or missing source records are always shown in full, and unrelated unchanged sources remain visible as compact path/status/topic/guidance stubs. If nothing matches, Agentpack keeps the full Source Cache to avoid false-negative filtering. This saves tokens without hiding which recorded files exist.

## Smoke Test

In normal use, a client such as Codex, Claude Code, or Cursor starts `agentpack mcp`. For development, run the local smoke command:

```bash
npm run mcp:smoke
```

It creates a temporary Agentpack workspace, starts `agentpack mcp`, sends JSON-RPC messages over stdio, and removes the temporary workspace after the check.

The test suite also exercises the same newline-delimited JSON-RPC flow in memory:

```bash
npm test
```

The smoke test verifies:

- `initialize`
- `tools/list`
- `tools/call record_decision`
- `tools/call record_source`
- `tools/call source_status`
- `tools/call resume`
- notification messages do not produce responses

## Client Setup

Use dry-run install first:

```bash
agentpack install codex
agentpack install claude
agentpack install claude-desktop
agentpack install cursor
```

Apply only after reviewing the plan:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install claude-desktop --write
agentpack install cursor --write
```

See [INTEGRATIONS.md](INTEGRATIONS.md) for target-specific files and manual global config steps.

After changing Agentpack itself and running `npm run build`, reconnect or restart any already-running MCP client. Stdio MCP clients keep the server process alive, so they do not automatically load the newly built `dist/` files.

If `load_context` reports the wrong Pack root, check for a stale global client config that starts Agentpack with a hard-coded `--root` or `cwd`. Project-local configs should start Codex and Claude Code with `agentpack mcp` so the server resolves the repo-local `.agentpack/` root. Global clients such as Claude Desktop should set an explicit `--root` and matching `AGENTPACK_ROOT` because they do not have a project cwd.

Avoid reusing the same MCP server name across global and project-local configs. Agentpack installers use `agentpack` for the Agentpack repo itself and `agentpack-<repo-name>` for other repos, so a project-local server such as `agentpack-example-app` does not shadow a global `agentpack` server.

## Security Notes

- The server operates only on the nearest `.agentpack/` root.
- It does not make network calls.
- It writes task state to local files only.
- It should treat stdout as protocol-only output.
