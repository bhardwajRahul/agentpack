<!-- agentpack:start -->
# Agentpack

Use Agentpack as the task-state ledger for this repo.

At the start of a task:
- call `load_context` with a small preset first
- call `source_status` before re-reading previously inspected files

During work:
- call `record_source` after inspecting an important file, with a concise conclusion
- call `record_decision` for durable technical/product decisions
- call `record_dead_end` when an approach failed and should not be repeated
- call `attach_evidence` for useful test output, command output, or verification notes

Default cadence:
- start with Agentpack context
- work locally without recording every micro-step
- record durable findings and evidence before a checkpoint
- use full safe mode for risky or release-like changes

Before re-reading an unchanged source file, prefer the recorded source conclusion unless the task requires fresh inspection.

After meaningful progress, call `checkpoint` with:
- summary
- current status
- next actions
<!-- agentpack:end -->
