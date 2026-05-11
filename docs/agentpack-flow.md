# Agentpack Execution Flow

```mermaid
flowchart TD
  cli["agentpack <cmd><br/>Terminal / CI"]
  mcp["agentpack mcp<br/>Codex / Claude Code / Cursor / Desktop"]

  cli --> dispatch["Command dispatch<br/>src/cli/index.ts"]
  mcp --> root["MCP root resolution<br/>--root > AGENTPACK_ROOT > cwd"]
  root --> server["MCP tool server<br/>src/mcp/server.ts"]
  server --> dispatch

  dispatch --> init["init<br/>create .agentpack/<br/>append local-only .gitignore patterns"]
  dispatch --> install["install client<br/>project-local config<br/>or Desktop merge snippet"]
  dispatch --> sourceAdd["source add<br/>hash file + store source conclusion"]
  dispatch --> sourceStatus["source status<br/>UNCHANGED / CHANGED / MISSING"]
  dispatch --> records["record_decision<br/>record_dead_end<br/>attach_evidence"]
  dispatch --> checkpoint["checkpoint<br/>state + event + snapshot"]
  dispatch --> resume["resume / load_context<br/>budgeted task context"]
  dispatch --> replay["replay / diff<br/>timeline or checkpoint delta"]
  dispatch --> doctor["doctor<br/>pack health + MCP setup checks"]

  init --> storage
  install --> localConfig["Project-local client config<br/>.codex/config.toml<br/>.mcp.json<br/>.cursor/mcp.json"]
  sourceAdd --> operations["src/operations.ts<br/>hash + git status helpers"]
  sourceStatus --> operations
  records --> storage
  checkpoint --> checkpoints["src/core/checkpoints.ts<br/>serialized writes under .lock"]
  resume --> resumeBuilder["src/core/resume.ts<br/>pack root header + query filter"]
  resumeBuilder --> budget["src/core/budget.ts<br/>truncate / omit sections"]
  doctor --> doctorCore["src/core/doctor.ts<br/>local ignores + stale roots + source cache"]

  operations --> storage
  checkpoints --> storage
  budget --> output
  replay --> output
  sourceStatus --> output
  doctorCore --> output

  storage[(".agentpack/<br/>state.json<br/>sources.json<br/>events.jsonl<br/>checkpoints/<br/>evidence/<br/>instructions/")]
  output["Output to coding agent<br/>Pack root<br/>Git state<br/>Source cache guidance<br/>Decisions / dead ends / evidence<br/>Next actions"]

  classDef entry fill:#0c2044,stroke:#388bfd,color:#c9d1d9;
  classDef rootNode fill:#2a1d00,stroke:#d29922,color:#c9d1d9;
  classDef command fill:#161b22,stroke:#30363d,color:#c9d1d9;
  classDef core fill:#0a2a14,stroke:#3fb950,color:#c9d1d9;
  classDef store fill:#1a0c3a,stroke:#8957e5,color:#c9d1d9;
  classDef out fill:#0a2020,stroke:#39d353,color:#c9d1d9;

  class cli,mcp entry;
  class root rootNode;
  class dispatch,init,install,sourceAdd,sourceStatus,records,checkpoint,resume,replay,doctor command;
  class server,operations,checkpoints,resumeBuilder,budget,doctorCore,localConfig core;
  class storage store;
  class output out;
```

## Notes

- Normal CLI commands find the nearest `.agentpack/` root upward from the current working directory after `agentpack init`.
- MCP clients can also pass an explicit root. Agentpack resolves MCP roots as `--root`, then `AGENTPACK_ROOT`, then `cwd`.
- Codex, Claude Code, and Cursor use project-local config. Claude Desktop needs a merge snippet because its config is global.
- `.agentpack/` is local-only by default and should not be committed in v0.
