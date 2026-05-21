# Task Passport

Task Passport is the handoff artifact for one coherent unit of agentic work.

It captures the reviewed state a future agent needs in order to continue the current task without rediscovering context, repeating dead ends, or guessing what is safe to touch.

## Model

Default rule:

- one active Task Passport owns a repo worktree
- a repo may keep many completed or parked passports over time
- worktrees can carry different active passports
- the shared repo source cache remains repo-level
- decisions, dead ends, evidence, checkpoints, and next actions become passport-scoped

This keeps source knowledge reusable while preventing unrelated work from mixing task state.

## File Shape

Target local layout:

```text
.agentpack/
  config.json
  sources.json
  tasks/
    current
    task_20260518_source_cleanup/
      passport.json
      events.jsonl
      checkpoints/
      evidence/
      exports/
```

`tasks/current` is a small pointer to the active task id for this worktree. If it is missing, Agentpack can fall back to the current v0 repo-level state.

## Passport Schema

`passport.json` should be compact, readable, and safe to inspect manually.

```json
{
  "schemaVersion": 1,
  "id": "task_20260518_source_cleanup",
  "title": "Add source cache cleanup commands",
  "status": "active",
  "createdAt": "2026-05-18T11:00:00.000Z",
  "updatedAt": "2026-05-18T11:30:00.000Z",
  "closedAt": null,
  "objective": "Let Agentpack remove stale source records safely.",
  "constraints": [
    "Preserve existing source add/status behavior",
    "Do not delete source records broadly without an explicit guard"
  ],
  "branch": "main",
  "baseHead": "8d22011",
  "currentHead": "21fe674",
  "worktree": "/path/to/repo",
  "writeScope": [
    "src/checkout.ts",
    "src/cart.ts",
    "tests/checkout.test.ts",
    "docs/checkout.md"
  ],
  "risk": "low",
  "roles": {
    "scout": {
      "status": "done",
      "summary": "Inspected source add/status flow and tests."
    },
    "builder": {
      "status": "done",
      "summary": "Implemented remove/prune commands inside declared write scope."
    },
    "reviewer": {
      "status": "done",
      "summary": "Verified focused tests and checkout smoke coverage."
    },
    "archivist": {
      "status": "done",
      "summary": "Recorded source conclusions, evidence, and checkpoint."
    }
  },
  "verification": {
    "status": "passed",
    "evidence": [
      "evt_example_test_output"
    ],
    "summary": "npm test passed; doctor clean after source cache refresh."
  },
  "nextActions": [
    "Design Task Passport schema and state transitions"
  ],
  "tags": [
    "source-cache",
    "trust-foundation"
  ]
}
```

Required fields for v1:

- `schemaVersion`
- `id`
- `title`
- `status`
- `createdAt`
- `updatedAt`
- `objective`
- `branch`
- `baseHead`
- `worktree`
- `writeScope`
- `nextActions`

Write scopes are repo-relative paths. `.` means the repository root.

Optional but recommended:

- `constraints`
- `currentHead`
- `risk`
- `roles`
- `verification`
- `tags`
- `closedAt`

## Statuses

Initial statuses:

- `active`: current work is in progress in this worktree
- `parked`: intentionally paused and not the current task
- `blocked`: waiting on user input, external dependency, or unresolved risk
- `verifying`: implementation is done, but evidence/review is not complete
- `completed`: task finished with verification or explicit acceptance
- `abandoned`: task stopped and should not be resumed without a new decision

Default context should show the active passport in full, and show parked or blocked passports only as compact references unless explicitly requested.

## State Transitions

Allowed transitions:

```text
none -> active              task start
active -> parked            task park
parked -> active            task switch/resume
active -> blocked           task block
blocked -> active           task unblock/resume
active -> verifying         task update-verification
verifying -> active         verification found more work
verifying -> completed      verification passed
active -> completed         small/docs task accepted directly
active -> abandoned         task abandon
parked -> abandoned         stale parked task is discarded
blocked -> abandoned        blocked task is discarded
```

Closed statuses are `completed` and `abandoned`. Closed passports remain inspectable history but should not appear in the default resume unless they are query-relevant.

## CLI Shape

Target first CLI surface:

```bash
agentpack task start "Fix checkout discount bug" \
  --objective "Make discount totals consistent across cart and checkout" \
  --write-scope src/checkout.ts \
  --write-scope src/cart.ts

agentpack task list
agentpack task passport
agentpack task switch task_20260518_source_cleanup
agentpack task update --next "Run focused regression tests" --write-scope tests/checkout.test.ts --risk medium
agentpack task audit
agentpack task park
agentpack task block --reason "Waiting for API decision"
agentpack task update-verification --status passed --evidence evt_... --summary "Focused checks passed"
agentpack task close
```

`resume` and MCP `load_context` read the current passport automatically when one exists, then show the broader repo-level ledger below it.

`task audit` is a diagnostic pass for continuity risk. It checks the current passport for branch/head drift, missing next actions, open verification, stale source conclusions, and closed-current-task anomalies.

`task update` patches the current passport without changing lifecycle status. It can add objective, constraints, write scope, next actions, tags, and risk after the task has already started. List fields append and deduplicate; omitted fields are preserved. Empty or no-op updates fail, and unknown risk values are rejected.

`task update-verification` updates the verification state. Without flags it marks verification as `pending`; with `--status`, `--evidence`, and `--summary` it links verification to recorded evidence so the audit warning can become a reviewed result.

## Role Lanes

Roles are coordination lanes inside one passport, not separate tasks.

- Scout: read-oriented; records source conclusions, risks, and known unknowns
- Builder: write-oriented; works inside the declared write scope
- Reviewer: read-oriented; checks diff, tests, risks, and regression surface
- Archivist: state-oriented; records evidence, checkpoints, and handoff notes

For v1, roles should be metadata and prompts, not a multi-agent runtime. Orchestrators can later map their own workers onto these lanes.

## Consistency Rules

Agentpack should warn before work continues when:

- the current git branch does not match the passport branch
- the current git head moved since the last passport update
- the current worktree path does not match the passport worktree
- a source conclusion in the current context is changed or missing
- a new active passport would overlap another open passport's write scope
- a Builder role attempts changes outside the declared write scope
- a task is marked completed without evidence or an explicit acceptance note

Agentpack should not try to resolve code conflicts. It should point the user toward one of three safe paths:

- reuse the current passport
- park one task before starting another
- move parallel work into a separate worktree

## Migration

Existing v0 packs should remain valid.

When task support is introduced, Agentpack can create an initial passport from the current repo-level state:

- `goal` becomes `objective`
- `currentStatus` becomes a summary or active status note
- `nextActions` copy into the passport
- existing events remain readable as legacy repo-level events
- `sources.json` stays repo-level

This avoids breaking existing users while moving new work into passport-scoped ledgers.
