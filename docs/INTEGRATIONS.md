# Integrations

Agentpack integrates through project files, CLI, and MCP. It does not write hidden global configuration by default.

## Client Matrix

| Client | Instruction file | MCP config surface | Status |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | User-local `~/.codex/config.toml`, copied from `.agentpack/instructions/codex-mcp.example.toml` | Tested |
| Claude Code | `CLAUDE.md` | Project-local `.mcp.json` | Tested |
| Cursor | `.cursor/rules/agentpack.mdc` | Project-local `.cursor/mcp.json` | Generated, not tested yet |
| ChatGPT web / Claude web | Markdown handoff | No local stdio MCP support in v0; use `agentpack export` | Manual handoff |
| Claude Desktop | Not installed by v0 | Desktop app MCP config or extension flow | Future |

All clients use the same `agentpack mcp` server. The difference is where each client expects instructions and MCP configuration to live.

## Safe Install Flow

Preview first:

```bash
agentpack install codex
agentpack install claude
agentpack install cursor
```

`install` defaults to dry-run mode. It shows the files Agentpack would create or update and prints the command needed to apply the plan.

Apply explicitly:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install cursor --write
```

Force preview explicitly:

```bash
agentpack install claude --dry-run
```

Agentpack only writes project-local files and `.agentpack/instructions/*`. It does not silently edit global files such as `~/.codex/config.toml`, `~/.claude.json`, or `~/.cursor/mcp.json`.

## Codex

```bash
agentpack install codex --write
```

This writes:

- `AGENTS.md`
- `.agentpack/instructions/codex.md`
- `.agentpack/instructions/codex-mcp.example.toml`

Agentpack does not edit `~/.codex/config.toml`. To enable MCP in Codex, review `.agentpack/instructions/codex-mcp.example.toml` and paste the snippet into your Codex config manually.

Official reference: [Codex configuration reference](https://developers.openai.com/codex/config-reference).

## Claude Code

```bash
agentpack install claude --write
```

This writes:

- `CLAUDE.md`
- `.mcp.json`
- `.agentpack/instructions/claude.md`

The `.mcp.json` file is project-local. Claude Code treats project-scoped MCP config as shareable project config and prompts before using project-scoped servers.

Official reference: [Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp).

## Cursor

```bash
agentpack install cursor --write
```

This writes:

- `.cursor/rules/agentpack.mdc`
- `.cursor/mcp.json`
- `.agentpack/instructions/cursor.md`

The Cursor MCP config uses `${workspaceFolder}` so it can point Agentpack at the current project root without hard-coding your local filesystem path.

Official reference: [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol).

## Verify

Before connecting an agent client:

```bash
npm run mcp:smoke
```

After installing the integration, restart the client if it does not pick up new MCP config automatically.
