# Token Benchmarks

Agentpack should earn the context it asks an agent to spend. These benchmarks
measure whether Agentpack outputs are carrying useful task state or just adding
ritual overhead.

This is a repo-maintenance benchmark, not an installed `agentpack` command. Run
it from a checkout of this repo:

```bash
npm run build
node scripts/benchmark-token-overhead.mjs
```

Optional flags:

```bash
node scripts/benchmark-token-overhead.mjs --json
node scripts/benchmark-token-overhead.mjs --keep-fixtures
```

The script creates temporary repositories, initializes Agentpack, records
representative task/source/evidence state, and compares Agentpack-assisted
outputs against direct git/file inspection baselines.

## Scenarios

- Tiny question: `agentpack task status` versus `git status --short --branch`.
- Latest-diff review: quick resume with a review query versus status plus diff.
- Resumed implementation: chat-budget resume versus status plus relevant file reads.
- Stale Source Cache triage: `source status --changed --missing` versus status plus diff.
- Release-prep handoff: `task handoff` versus status, recent log, and release files.

These are deliberately small and local. They are meant to catch direction and
regressions before optimizing, not to model every real project.

## Metrics

The benchmark reports:

- Agentpack: plain text produced by the Agentpack command.
- MCP total: the same text inside a modeled JSON-RPC `tools/call` response.
- MCP overhead: protocol wrapper only, excluding Agentpack's text body.
- Direct: the likely git/file output an agent would inspect without Agentpack.
- AP-direct and MCP-direct: positive values are token overhead; negative values
  mean the Agentpack path was shorter than the direct baseline.
- Section breakdown: Markdown resume outputs are split by `##` section so growth
  can be attributed to buckets such as Source Cache, Evidence, or Current Task
  Passport.

Token counts use Agentpack's existing rough estimate:

```text
ceil(characters / 4)
```

That keeps the benchmark dependency-free and aligned with resume budget logic.
Use it for relative comparison, not exact model billing.

## Reading Results

Good overhead is context that avoids work: task objective, next action, source
conclusions, verification status, stale-source guidance, and handoff warnings.

Bad overhead is repeated ceremony: duplicated summaries, unchanged source dumps,
large timelines, evidence previews that do not answer the scenario, or protocol
metadata that dominates tiny calls.

If a scenario grows, decide which bucket changed before optimizing:

- MCP wrapper growth points to tool response shape or excessive envelope use.
- Source Cache growth points to query filtering, stale-source warning stubs, or
  summary caps.
- Evidence growth points to preview limits or evidence selection.
- Resume growth points to required section budgets and omitted/truncated
  metadata.

Prefer one narrow improvement at a time, then rerun the benchmark and a focused
test or smoke check.
