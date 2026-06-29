# Task Passport

Task Passport is the handoff artifact for one coherent unit of agent work.

It exists for continuity, not bureaucracy.

It captures the reviewed state a future agent needs in order to continue the current task without rediscovering context, repeating dead ends, or guessing what is safe to touch.

It stores reviewed durable state, not raw agent activity.

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
active -> verifying         task verify
verifying -> active         verification found more work
verifying -> completed      task finalize
active -> completed         task finalize --status accepted [--force when next actions remain]
active -> abandoned         task abandon
parked -> abandoned         stale parked task is discarded
blocked -> abandoned        blocked task is discarded
```

Closed statuses are `completed` and `abandoned`. Closed passports remain inspectable history but should not appear in the default resume unless they are query-relevant.

## CLI Shape

Current CLI surface:

```bash
agentpack task start "Fix checkout discount bug" \
  --objective "Make discount totals consistent across cart and checkout" \
  --write-scope src/checkout.ts \
  --write-scope src/cart.ts

agentpack task list
agentpack task status
agentpack task handoff
agentpack task passport
agentpack task switch task_20260518_source_cleanup
agentpack task update --next "Run focused regression tests" --write-scope tests/checkout.test.ts --risk medium
agentpack task audit
agentpack task park
agentpack task block --reason "Waiting for API decision"
agentpack task verify --status passed --evidence evt_... --summary "Focused checks passed"
agentpack task finalize
agentpack task --help
```

`resume` and MCP `load_context` read the current passport automatically when one
exists. Its status and next actions become authoritative in Current State, then
the full passport and broader repo-level ledger follow. Without a current
passport, Current State uses the legacy repo-level fallback. If the current
pointer still references a closed passport, `resume` labels its next actions as
historical so they are not mistaken for active instructions.

The normal human-facing sequence is: start the task, keep status/scope/next actions current, record verification with evidence, print a handoff when another agent or chat may continue, then finalize only after verification is final.

Temporary work switching uses `task park`, not `task finalize`. Parking keeps a
passport open and switchable while unrelated work becomes current. Finalization
means the task is complete, failed, or explicitly accepted as-is.

Review requests follow the same current-task check. A review that verifies the
current active or verifying task is verification work for that passport; record
the review evidence and checkpoint there. Start, switch, or park into a separate
review task only when the review is unrelated to the current task.

`task start` creates a new current passport only when there is no current task, the current task is closed, or the current task is parked. If the current task is active, blocked, or verifying, Agentpack asks you to park or close it first so unrelated work does not silently overwrite the handoff pointer. Invalid risk values are rejected instead of being treated as unknown.

`task switch <id>` resumes a parked passport as `active`. When a different current task is active, blocked, or verifying, park or finalize it before switching; Agentpack does not silently rewrite that task's lifecycle state. Closed target tasks remain unswitchable.

`task status` prints a short current-task view without scanning source-cache status. Use it for a quick human check before reaching for `task audit`.

MCP exposes the same start/status/list/switch path for connected agents through `task_start`, `task_status`, `task_list`, `task_switch`, and `task_park`. Blocking, explicit close, and full passport JSON inspection remain CLI-only until dogfooding shows they are needed through MCP.

**`task handoff`** prints a compact current-passport handoff for switching chats, clients, worktrees, or agents. It includes objective, constraints, write scope, next actions, verification, drift, and audit summary without dumping the full passport JSON.

**`task audit`** is a diagnostic pass for continuity risk. It checks the current passport for branch/head drift, missing next actions, open verification, closed-current-task anomalies, and source-cache metadata drift. Metadata warnings are shown separately so stale source records do not look like action-required task failures.

`task update` patches the current passport without changing lifecycle status. It can add objective, constraints, write scope, next actions, tags, and risk after the task has already started. List fields append and deduplicate; omitted fields are preserved. Empty or no-op updates fail, and unknown risk values are rejected.

`task verify` updates the verification state. Without flags it marks verification as `pending`; with `--status`, `--evidence`, and `--summary` it links verification to recorded evidence so the audit warning can become a reviewed result. `task update-verification` remains available as a compatibility alias.

`task finalize` is the compact end-of-task ritual. It closes the current task only after verification is already `passed`, `failed`, or `accepted`, or when that final status is passed explicitly with `--status`. It refuses to close unknown or pending verification by default. `task finalize --status accepted` also refuses to close a task with remaining next actions unless `--force` is passed; use `task park` for deferred work. `task close` remains available for explicit manual closure.

## Portable Bundle Contract

Structured bundles are an explicit handoff surface, separate from the current
markdown export. A bundle moves reviewed task continuity between local
workspaces without committing live `.agentpack/` state or pretending to move
the Git working tree. Export, inspect, and read-only import planning are
implemented; applying a bundle is still future work.

The first bundle format is one inspectable UTF-8 JSON file, conventionally
named `*.agentpack-bundle.json`. It is not a zip archive and cannot contain
scripts, binaries, source files, or hidden client configuration.

Target envelope:

```json
{
  "kind": "agentpack.task-bundle",
  "schemaVersion": 1,
  "bundleId": "sha256:<canonical-payload-hash>",
  "exportedAt": "2026-06-23T12:00:00.000Z",
  "producer": {
    "name": "agentpack-cli",
    "version": "0.1.x"
  },
  "origin": {
    "projectName": "example-app",
    "repository": "https://example.invalid/org/example-app",
    "branch": "feature/checkout",
    "head": "abc1234"
  },
  "task": {
    "id": "task_example",
    "title": "Fix checkout totals",
    "objective": "Make totals consistent",
    "constraints": [],
    "writeScope": ["src/checkout.ts"],
    "risk": "medium",
    "tags": [],
    "nextActions": [],
    "originalStatus": "active",
    "originVerification": {
      "status": "passed",
      "summary": "Focused tests passed.",
      "evidence": ["evt_example"]
    }
  },
  "handoffMarkdown": "Task handoff...",
  "sources": [],
  "evidence": []
}
```

`bundleId` is computed from a canonicalized payload that excludes `bundleId`
and `exportedAt`. Stable key ordering and array ordering make inspection and
duplicate detection deterministic even when two exports have different
timestamps.

The portable task payload includes the title, objective, constraints, write
scope, risk, tags, next actions, optional role lanes, original status, and
original verification.
Absolute worktree paths and the source pack's `tasks/current` pointer are never
portable fields. Origin branch, head, task id, and verification remain
provenance; importing them does not claim that the destination workspace has
the same Git state or has locally re-verified the task.

The optional repository locator is credential-free and redacted; export drops
user info, query strings, fragments, or nonportable local remote paths. Source
entries contain only repo-relative path, hash, size, recorded time, summary,
and optional snippet. Evidence entries contain origin id, kind, redacted
command/exit code, UTF-8 text or JSON content, and a content digest.

Bundle contents are intentionally bounded:

- include a redacted compact handoff for human inspection
- include source conclusions selected explicitly with repeatable source paths;
  write scope, including `.`, never implicitly exports recorded sources
- include only text or JSON evidence referenced by the passport verification,
  unless evidence is explicitly disabled
- exclude repo config/state, current-task pointers, client config, caches,
  checkpoints, Git patches, source file contents, unreferenced evidence, and
  the broad repo event stream
- exclude repo-level decisions and dead ends from structured import because the
  current storage model cannot prove they belong to this task; users can still
  carry broader read-only context through the existing markdown export

Every string is redacted again at the export boundary. Export refuses absolute
or parent-traversal paths, paths inside `.agentpack/` or `.git/`, symlink escapes,
and existing output files. Import treats the bundle as untrusted input: validate
kind/schema, digest, path safety, field types, count limits, and byte limits
before planning any write.

`bundle import-plan` is read-only and reports an explicit empty write set. It
validates the bundle before comparing the task id and retained bundle digest
with destination state; an uninitialized destination is treated as a create
candidate without creating `.agentpack/`.

Write-enabled import applies as a rollback-protected transaction under the pack
write lock only with an explicit write flag. A successful import never replaces
the current task. It creates a non-current `parked` passport with
local branch/head/worktree metadata; origin metadata stays attached to the
import record. Origin verification is historical provenance, while local
verification starts as `unknown` until the destination workspace verifies the
handoff.

Collision rules:

- no local task id collision: preserve the origin task id and import it parked
- the same bundle digest was already imported: report an idempotent no-op
- the task id exists with different content: refuse by default; an explicit
  `--as-new` remaps the task id and all imported references
- evidence id and digest both match: reuse it; an id collision with different
  content is remapped and origin-verification references are rewritten
- an imported source path whose local file matches the imported hash may fill
  an absent source record; an existing local conclusion wins
- a missing or hash-mismatched local source is not written to Source Cache;
  keep it in the stored bundle provenance and report a stale-source warning

The applied bundle is retained under
`.agentpack/tasks/<task-id>/imports/<portable-bundle-id>.bundle.json`; a sibling
`<portable-bundle-id>.import.json` records created, reused, skipped, and
remapped records. Apply rolls back synchronous write failures, but does not
promise a general rollback command. A future removal operation must use that
import manifest and delete only records created by the import that remain
unreferenced; reused local sources or evidence are never rollback candidates.

The existing `agentpack export --to markdown`, `resume`, and `task handoff`
contracts remain unchanged. Markdown import and automatic sync are out of scope
for the first structured format.

Required verification for the complete write-enabled implementation:

- canonical export produces a stable payload digest and survives
  export/inspect/import-plan round trips
- redaction removes configured secrets, credential-bearing remote components,
  and absolute workspace paths from every exported string
- inspect and default import perform no pack writes; invalid schema, digest,
  size, count, or path input fails before a plan can be applied
- apply is atomic and leaves `tasks/current` unchanged on success or failure
- imported tasks are parked with local verification unknown while origin status
  and verification remain inspectable provenance
- task/evidence idempotency, conflicting ids with `--as-new`, source hash
  matches, and stale/missing source warnings have focused regression tests
- CLI and MCP produce equivalent plans/results from the same core functions
- a clean-repo dogfood smoke exports from one workspace, inspects without a
  pack, imports into another workspace, and resumes the parked task explicitly

## Role Lanes

Roles are coordination lanes inside one passport, not separate tasks or runtime workers.

- Scout: read-oriented; records source conclusions, risks, and known unknowns
- Builder: write-oriented; works inside the declared write scope
- Reviewer: read-oriented; checks diff, tests, risks, and regression surface
- Archivist: state-oriented; records evidence, checkpoints, and handoff notes

Each configured lane stores only a status (`pending`, `active`, `done`, or
`blocked`) and a durable summary. Use the same safe surface from CLI or MCP:

```bash
agentpack task role reviewer
agentpack task role reviewer --status done \
  --summary "Reviewed the diff and focused regression coverage; no blockers."
```

The query form is read-only and returns focused guidance. Updates require both
status and summary, are idempotent, and append one task event only when state
changes. Configured lanes appear in task status, handoff, and resume in the
fixed order Scout, Builder, Reviewer, Archivist. A blocked lane is an audit
warning; it does not automatically block the whole task. Builder without a
declared write scope is also an audit warning.

Roles are metadata and just-in-time prompts, not a multi-agent runtime,
scheduler, owner registry, authorization layer, or orchestration system. They
never change task lifecycle or verification automatically. External
orchestrators can map their own workers onto these lanes without Agentpack
becoming the runtime. Structured bundles carry configured lanes; older
passports and bundles with no `roles` field load as an empty role map.

## Consistency Rules

Agentpack should warn before work continues when:

- the current git branch does not match the passport branch
- the current git head moved since the last passport update
- the current worktree path does not match the passport worktree
- a source conclusion in the current context is changed or missing
- a new active passport would overlap another open passport's write scope
- a non-pending Builder role has no declared write scope
- a configured role lane is blocked
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
