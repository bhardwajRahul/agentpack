# Integrations

Agentpack integrates through project files, CLI, and MCP. It does not write hidden global configuration by default.

## Client Matrix

| Client | Instruction file | MCP config surface | Status |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | User-local `~/.codex/config.toml`, copied from generated `.agentpack/instructions/codex-mcp.example.toml` | Tested |
| Claude Code | `CLAUDE.md` | Project-local `.mcp.json` in the repo root | Tested |
| Claude Desktop | None automatically read from the repo | User-local Claude Desktop config, copied from generated `.agentpack/instructions/claude-desktop-mcp.example.json` | Generated, not tested yet |
| Cursor | `.cursor/rules/agentpack.mdc` | Project-local `.cursor/mcp.json` | Generated, not tested yet |
| ChatGPT web / Claude web | Markdown handoff | No local stdio MCP support in v0; use `agentpack export` | Manual handoff |

All clients use the same `agentpack mcp` server. The difference is where each client expects instructions and MCP configuration to live.

Generated files under `.agentpack/instructions/` are local helper snippets. They are created only when you run the matching installer, and `.agentpack/` is ignored by git by default.

## Where Files Live

In the current project:

- `CLAUDE.md`: repo-root project instructions for Claude Code.
- `.mcp.json`: repo-root project MCP config for Claude Code.
- `AGENTS.md`: repo-root project instructions for Codex.
- `.agentpack/instructions/codex-mcp.example.toml`: local Codex config snippet, created by `agentpack install codex --write`.
- `.agentpack/instructions/claude-desktop-mcp.example.json`: local Claude Desktop config snippet, created by `agentpack install claude-desktop --write`.

If a snippet is missing, run the matching `agentpack install <target> --write`. Running `agentpack install claude --write` does not create Codex or Claude Desktop snippets.

## Safe Install Flow

Preview first:

```bash
agentpack install codex
agentpack install claude
agentpack install claude-desktop
agentpack install cursor
```

`install` defaults to dry-run mode. It shows the files Agentpack would create or update and prints the command needed to apply the plan.

Apply explicitly:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install claude-desktop --write
agentpack install cursor --write
```

Force preview explicitly:

```bash
agentpack install claude --dry-run
```

Agentpack only writes project-local files and `.agentpack/instructions/*`. It does not silently edit global files such as `~/.codex/config.toml`, `~/.claude.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, or `~/.cursor/mcp.json`.

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

## Claude Desktop

```bash
agentpack install claude-desktop --write
```

This writes:

- `.agentpack/instructions/claude-desktop.md`
- `.agentpack/instructions/claude-desktop-mcp.example.json`

Claude Desktop does not read this repo's `.mcp.json` or `CLAUDE.md`. To enable Agentpack manually in Claude Desktop on macOS, review `.agentpack/instructions/claude-desktop-mcp.example.json` and merge the `agentpack` server into:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Do not copy the generated snippet over the Desktop config file. That can delete existing Claude Desktop MCP servers. Merge only the `mcpServers.agentpack` entry.

Safe manual flow:

```bash
agentpack install claude-desktop --write
cat .agentpack/instructions/claude-desktop-mcp.example.json
mkdir -p "$HOME/Library/Application Support/Claude"
open -e "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

If the config file does not exist yet, create it with the generated snippet content. If it already exists, add only this entry under its existing `mcpServers` object:

```json
"agentpack": {
  "command": "agentpack",
  "args": ["mcp", "--root", "/absolute/path/to/your/project"]
}
```

Then restart Claude Desktop. If the Desktop app cannot find `agentpack`, replace `"command": "agentpack"` in the snippet with an absolute executable path. Keep the `--root` argument pointed at the project whose `.agentpack/` state you want Claude Desktop to use.

For a future low-friction Desktop install, Agentpack should ship a Desktop Extension/MCP bundle instead of asking users to edit JSON manually.

Official references: [MCP local server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) and [Anthropic Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions).

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
