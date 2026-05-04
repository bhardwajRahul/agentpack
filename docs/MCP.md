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
- `checkpoint`
- `resume`
- `diff`
- `replay`

## Manual Smoke

In normal use, a client such as Codex, Claude Code, or Cursor starts `agentpack mcp`. For development, the test suite exercises the same newline-delimited JSON-RPC flow in memory:

```bash
npm test
```

The smoke test verifies:

- `initialize`
- `tools/list`
- `tools/call record_decision`
- `tools/call record_source`
- `tools/call resume`
- notification messages do not produce responses

## Security Notes

- The server operates only on the nearest `.agentpack/` root.
- It does not make network calls.
- It writes task state to local files only.
- It should treat stdout as protocol-only output.
