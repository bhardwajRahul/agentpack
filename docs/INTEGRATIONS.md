# Integrations

Agentpack integrates through local project files, CLI, and MCP. It does not write hidden global configuration by default.

## Client Matrix

| Client | Instruction file | MCP config surface | Status |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | Project-local `.codex/config.toml`, plus a generated `.agentpack/instructions/codex-mcp.example.toml` review snippet | Tested |
| Claude Code | `CLAUDE.md` | Project-local `.mcp.json` in the repo root | Tested |
| Claude Desktop | None automatically read from the repo | User-local Claude Desktop config, copied from generated `.agentpack/instructions/claude-desktop-mcp.example.json` | Tested |
| Cursor | `.cursor/rules/agentpack.mdc` | Project-local `.cursor/mcp.json` | Tested |
| Git (any client) | Pre-commit gate hook | None; installs `.git/hooks/pre-commit` via `agentpack install git-hooks --write` | Tested |
| Web chats | Markdown handoff | No local stdio MCP support; use `agentpack export` | Manual fallback |

Coding-agent clients use the same `agentpack mcp` server. The difference is where each client expects instructions and MCP configuration to live. Web chats are fallback targets for pasted markdown handoffs; they are not a primary integration surface.

Generated integration files are local developer setup by default. Until Agentpack has an explicit shared/team mode, keep `.agentpack/`, `.codex/`, `.claude/`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, and similar client config files out of origin unless a repo deliberately chooses to version its own agent policy.

Generated files under `.agentpack/instructions/` are local helper snippets. They are created only when you run the matching installer, and `agentpack init` adds the Agentpack local-only patterns to `.gitignore` without replacing existing project rules.

## Where Files Live

In a local project setup:

- `CLAUDE.md`: repo-root project instructions for Claude Code.
- `.mcp.json`: repo-root project MCP config for Claude Code.
- `AGENTS.md`: repo-root project instructions for Codex.
- `.codex/config.toml`: repo-local Codex MCP config created by `agentpack install codex --write`.
- `.agentpack/instructions/codex-mcp.example.toml`: local Codex config snippet, created by `agentpack install codex --write`.
- `.agentpack/instructions/claude-desktop-mcp.example.json`: local Claude Desktop config snippet, created by `agentpack install claude-desktop --write`.

If a snippet is missing, run the matching `agentpack install <target> --write`. Running `agentpack install claude --write` does not create Codex or Claude Desktop snippets.

## Safe Install Flow

Run `agentpack init` once per repo to create `.agentpack/` and local ignore rules. Then install the client integrations you actually want to use in that repo. Each `agentpack install <target> --write` command configures one client surface; it does not replace `init`, and installing one client does not create files for the others.

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

Agentpack only writes project-local files and `.agentpack/instructions/*`. These files are intended to stay ignored/local. Agentpack does not silently edit global files such as `~/.codex/config.toml`, `~/.claude.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, or `~/.cursor/mcp.json`.

Generated MCP server names are repo-specific to avoid collisions when several repos are open in the same client. The Agentpack repo itself keeps the short name `agentpack`; other repos use `agentpack-<repo-name>`, such as `agentpack-example-app`.

## Codex

```bash
agentpack install codex --write
```

This writes:

- `AGENTS.md`
- `.codex/config.toml`
- `.agentpack/instructions/codex.md`
- `.agentpack/instructions/codex-mcp.example.toml`

Agentpack does not edit `~/.codex/config.toml`. The project-local `.codex/config.toml` entry starts MCP with:

```toml
[mcp_servers.agentpack-example-app]
command = "agentpack"
args = ["mcp"]
```

Do not keep an older global `~/.codex/config.toml` entry with `args = ["mcp", "--root", "/some/project"]` or `cwd = "/some/project"`. That makes every Codex session reuse that old repo's `.agentpack/` state even after you run `agentpack init` in a new repo.

If Agentpack still reports the wrong Pack root in Codex, remove the stale global `mcp_servers.agentpack` block, keep the project-local `.codex/config.toml`, then restart or reconnect the MCP server.

Official reference: [Codex configuration reference](https://developers.openai.com/codex/config-reference).

## Claude Code

```bash
agentpack install claude --write
```

This writes:

- `CLAUDE.md`
- `.mcp.json`
- `.claude/settings.json`
- `.agentpack/instructions/claude.md`

The `.mcp.json` file is project-local. Claude Code treats project-scoped MCP config as shareable project config and prompts before using project-scoped servers. Agentpack names the server after the repo, for example `agentpack-example-app`, so it does not shadow a global `agentpack` server.

The `.claude/settings.json` merge adds one PreToolUse hook (`task gate --client claude`, launched through the current Node executable and Agentpack entrypoint rather than the shell `PATH`) on the `Edit|Write|MultiEdit|NotebookEdit` tools. Before each file edit, Claude Code runs the gate against the current Task Passport: in the default `warn` mode a violation is injected as additional context so the agent can self-correct; with `"gateMode": "block"` in `.agentpack/config.json` the edit is denied with the reason. Existing settings keys and hooks are preserved; re-running the installer does not duplicate the hook and upgrades older PATH-based hook entries in place. Because the launcher path pins the Node install, re-run `agentpack install claude --write` after switching Node versions.

Official reference: [Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp) and [hooks reference](https://code.claude.com/docs/en/hooks.md).

## Claude Desktop

```bash
agentpack install claude-desktop --write
```

This writes:

- `.agentpack/instructions/claude-desktop.md`
- `.agentpack/instructions/claude-desktop-mcp.example.json`

Claude Desktop does not read this repo's `.mcp.json` or `CLAUDE.md`. To enable Agentpack manually in Claude Desktop on macOS, review `.agentpack/instructions/claude-desktop-mcp.example.json` and merge the generated Agentpack server entry into:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Do not copy the generated snippet over the Desktop config file. That can delete existing Claude Desktop MCP servers. Merge only the generated `mcpServers.<server-name>` entry.

Safe manual flow:

```bash
agentpack install claude-desktop --write
cat .agentpack/instructions/claude-desktop-mcp.example.json
mkdir -p "$HOME/Library/Application Support/Claude"
open -e "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

If the config file does not exist yet, create it with the generated snippet content. If it already exists, add only this entry under its existing `mcpServers` object:

```json
"agentpack-example-app": {
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/agentpack.js", "mcp", "--root", "/absolute/path/to/your/project"],
  "env": {
    "AGENTPACK_ROOT": "/absolute/path/to/your/project"
  }
}
```

Then restart Claude Desktop. The generated snippet launches Agentpack through the current Node executable and Agentpack entrypoint, rather than relying on `agentpack` being available in Claude Desktop's GUI `PATH`. If Claude Desktop reports that the MCP server disconnected or cannot start, rerun `agentpack install claude-desktop --write`, merge the refreshed snippet, then restart Claude Desktop. Keep both the `--root` argument and the `AGENTPACK_ROOT` env value pointed at the project whose `.agentpack/` state you want Claude Desktop to use.

Claude Desktop has no project-local repo config. If it lists several Agentpack servers, use the repo-specific server key from the generated snippet for the repo you are working in. If you switch one Claude Desktop server from one repo to another, update both that server's `--root` value and `AGENTPACK_ROOT`, then restart Claude Desktop.

One Claude Desktop server entry points to one Agentpack repo at a time. To expose multiple repos at once, add multiple `mcpServers` entries with different names and different `AGENTPACK_ROOT` values, but expect duplicated Agentpack tool names in the client UI.

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
The generated MCP entry launches Agentpack through the current Node executable and Agentpack entrypoint, rather than relying on `agentpack` being available in Cursor's GUI `PATH`.

After writing the config, open this folder as the Cursor workspace and reload the Cursor window so project MCP is re-read. Then open Cursor's MCP Servers menu and enable `agentpack` if it appears toggled off. Cursor empty-window sessions do not load project `.cursor/mcp.json`.

If Agentpack tools still do not appear in Cursor, run:

```bash
agentpack doctor
```

Look for the `Cursor MCP` check. If Cursor still does not expose Agentpack tools, use the CLI equivalents while debugging Cursor's MCP connection:

```bash
agentpack resume --preset agent
agentpack source status
agentpack checkpoint -m "<summary>" --status "<status>" --next "<next action>"
```

Official reference: [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol).

## Git Hooks

```bash
agentpack install git-hooks --write
```

This installs a `pre-commit` hook that runs `agentpack task gate --staged` against the files staged for commit. It is the client-neutral enforcement layer: it works the same for Codex, Claude Code, Cursor, and human commits.

- In the default `warn` mode, findings are printed and the commit proceeds.
- With `"gateMode": "block"` in `.agentpack/config.json`, lifecycle and write-scope violations fail the commit (exit code 2); branch drift stays advisory.
- The hook is skipped silently when `agentpack` is not on `PATH`, and `task gate` exits 0 quietly in repos without `.agentpack/`, so the hook never breaks unrelated workflows.
- The hook fails the commit only on gate exit code 2 (block mode). Any other gate error — for example an outdated `agentpack` binary — prints a notice and lets the commit through.

If a foreign `pre-commit` hook already exists, the installer leaves it untouched and writes `.agentpack/instructions/pre-commit-gate.example.sh` for a manual merge instead. If `core.hooksPath` points outside the repository (for example a shared global hooks directory), the installer refuses to write there and only generates the snippet.

Packs that live in a subdirectory of the repository are supported: the hook is installed at the repository's own hooks directory and changes into the pack directory before running the gate. A repository with several packs gets one shared hook that gates each pack — running the installer from another pack adds it to the list, and a pack whose directory disappears is skipped. The commit is blocked when any gated pack blocks.

Clients without a hook surface (Codex today) still get gate findings through MCP: `load_context` and `task_status` responses append a `Gate Warnings` section whenever the current passport has lifecycle or drift findings.

## Verify

Before connecting an agent client:

```bash
npm run mcp:smoke
```

After installing the integration, restart the client if it does not pick up new MCP config automatically.
