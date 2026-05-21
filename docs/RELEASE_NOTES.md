# Release Notes Draft

## Next patch release

Draft scope since `0.1.10`:

- Add Task Passport update flow for objective, constraints, write scope, next actions, tags, and risk.
- Expose `task_update` through MCP alongside `task_audit` and `task_update_verification`.
- Preserve `.` as a repo-root write scope.
- Protect the current-passport workflow: `task start` now refuses to replace active, blocked, or verifying work.
- Reject invalid task risk values consistently in `task start`, `task update`, and MCP `task_update`.
- Clarify generated Codex, Claude, and Cursor instructions so agents use compact ledger cadence instead of repeated status checks or per-file source-record spam.
- Add collaboration modes and safety guidance to generated project instructions.
- Align CLI, MCP, Dogfood, and Task Passport docs with the implemented behavior.

Verification before release:

- `npm test`
- `npm run mcp:smoke`
- `npm pack --dry-run`
- privacy scan for local paths and secret-like values
- `git diff --check`
- `agentpack doctor`
- `agentpack task audit`

Release gate:

- Complete final review of the accumulated local commits.
- Push only after review is accepted.
- Cut the npm release only after the pushed branch is stable and docs match the release scope.
