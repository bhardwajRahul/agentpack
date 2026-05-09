# MCP

`agentpack mcp` starts a local stdio MCP server.

The MCP stdio transport uses newline-delimited JSON-RPC messages over stdin/stdout. The client launches Agentpack as a subprocess, sends JSON-RPC messages to stdin, and reads JSON-RPC responses from stdout. Agentpack must not write non-MCP logs to stdout.

Reference: [Model Context Protocol transports](https://modelcontextprotocol.io/docs/concepts/transports).

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

## Manual Smoke

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

## Security Notes

- The server operates only on the nearest `.agentpack/` root.
- It does not make network calls.
- It writes task state to local files only.
- It should treat stdout as protocol-only output.
