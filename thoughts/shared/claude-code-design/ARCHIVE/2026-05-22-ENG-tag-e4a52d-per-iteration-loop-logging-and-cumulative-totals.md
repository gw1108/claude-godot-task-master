---
topic: "Per-Iteration Loop Logging and Cumulative Totals"
tags: [design, tm-core, loop-service, progress-file, trace-level, tag-e4a52d]
status: complete
research_source: thoughts/shared/research/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md
---

# Design: Per-Iteration Loop Logging and Cumulative Totals

## Problem Statement

`LoopService` currently funnels every iteration's header, summary block, and trace-level details into a single `progress.txt` file. The file becomes long and low-signal: an operator scanning it cannot quickly see "how many tool calls did iteration 3 make, how much context did it burn, and which iteration ran out of budget." We want `progress.txt` to become a high-signal one-line-per-iteration ledger, push the verbose/trace detail into per-iteration sibling files (`<stem>.iter-NN<ext>`), enrich each iteration's summary with tool-call classification (total / task-master / writes / non-writes) and estimated context usage (with `% of 1M` for Opus models), and emit a once-per-run cumulative totals file (`<stem>.totals<ext>`) at `finalize()`.

## Research Source

`thoughts/shared/research/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md`

## Design Decisions

### Model id capture site
**Choice:** Capture only from the `system`/`init` stream event.
**Rationale:** The `system` event arrives reliably at stream start across CLI versions and is independent of whether a `result` event ultimately reports a model field. Adding one new `event.type === 'system'` branch to `processLine` (alongside today's `assistant`/`user`/`result` branches) is a minimal extension. We avoid threading model capture through the existing `extractTokenUsage` path, keeping that helper focused on usage math. If `system` does not carry a model id (older CLI), `modelId` stays `undefined` and the `(X% of 1M)` segment is silently omitted — already an accepted edge case in the research.

### Telemetry accumulator placement
**Choice:** Service-level private `iterationTelemetry` array on `LoopService`.
**Rationale:** YAGNI-aligned (single consumer — the `finalize()` totals writer). Avoids widening the public `LoopIteration` type with fields no presentation layer reads today. The accumulator is local to a `run()` call because `LoopDomain.run` instantiates a fresh service per call (`loop-domain.ts:60-74`), so there is no cross-run state-bleed risk. Keeps the public surface area unchanged while keeping the totals file independent of whatever telemetry future iterations want to track.

### `traceLevel = 'none'` policy for `progress.txt`
**Choice:** Skip per-iteration lines entirely when `traceLevel = 'none'`.
**Rationale:** In `none` mode there is no `toolCallCounts` map and no stream-json parsing — the new summary line has no data to render. Emitting a placeholder like `Iteration N: <status> (no telemetry)` adds noise without information. With this choice, `none`-mode `progress.txt` retains only the `initProgressFile` header and the `appendFinalSummary` footer, which matches the existing "minimal in none mode" behavior. The cumulative totals file is also not written in `none` mode (no per-iteration data to aggregate).

### Per-iteration sibling file collision policy
**Choice:** Overwrite `<stem>.iter-NN<ext>` for each iteration in the current run.
**Rationale:** Aligns with the research-signaled default. Truncate-and-write per iteration keeps the file set in sync with the current run; the run-id-suffix alternative would create sprawl and require threading a new parameter through `LoopConfig`/CLI/MCP. `progress.txt` continues to append (existing precedent at `initProgressFile`) and the new totals file is overwritten once per `finalize()`.

### Tool-classification helper location
**Choice:** Private methods on `LoopService` (e.g. `classifyToolCalls(counts: Map<string, number>)`).
**Rationale:** Today there is one consumer — the service itself. The module-organization rules in `CLAUDE.md` ("YAGNI for Abstractions … don't extract until 2+ consumers") favor keeping the helpers private. This matches the existing pattern alongside `extractTokenUsage`, `parseCompletion`, and `buildIterationSummaryBlock`. Promotion to a standalone `services/tool-classification.ts` file is a cheap refactor if a second consumer ever appears.

### Per-iteration summary block format
**Choice:** Multi-line bullet block. Keep the existing per-tool-name list as a second bullet section.
**Rationale:** The per-tool list preserves debuggability (which tool ran how many times) and the new aggregated `Tool calls` block makes the classification view greppable in one place. To avoid two `- Tool calls:` headers in the same block, the existing per-tool list is renamed to `- Tool calls by name:`. The new `- Context:` bullet combines token count and percent for the same iteration; the percent segment is omitted when the model id is absent/non-Opus or when token usage is unavailable.

Shape of the new summary block (within the existing `### Iteration N summary` heading):

```
- Tool calls: 12 total
  - Task-master: 7
  - Writes: 2
  - Non-writes: 3
- Tool calls by name:
  - Bash: 3
  - Edit: 2
  - mcp__task-master-ai__next_task: 7
- Tokens:
  - Input: 12,300
  - Output: 4,210
  - Cache read: 380,000
  - Cache write: 20,000
  - Total: 416,510
- Context: 412,500 tokens (41.3% of 1M)
- Final result: ...
```

### Number formatting
**Choice:** Thousands separators (`Number.prototype.toLocaleString('en-US')`) for all aggregated numbers in both the per-iteration summary block and the cumulative totals file.
**Rationale:** Matches the chosen preview. The aggregated numbers (tokens, context, totals) are read by humans skimming the file; the readability gain at 412,500 vs 412500 outweighs the modest cost to downstream parsing. The per-iteration markdown table in the totals file uses the same formatting.

### File-routing seam
**Choice:** Reuse the existing `iterationFileLines` buffer pipeline. At iteration close, the buffer is flushed to `<stem>.iter-NN<ext>` (truncate-write) instead of `progress.txt`. A separate, much smaller `appendFile` writes only the new human-readable summary block to `progress.txt`.
**Rationale:** Keeps the `tagEntry` post-processing intact (the per-iteration sibling continues to carry `[VERBOSE]`/`[TRACE]` line tags). Single seam, single buffer, two writes — minimal divergence from today's flow.

### `onIterationSummary` payload extension
**Choice:** Additive fields on the existing callback payload: `totalToolCalls`, `taskMasterToolCalls`, `writeToolCalls`, `nonWriteToolCalls`, `estimatedContext`, `percentOf1M?`, `modelId?`. No new callback.
**Rationale:** The CLI (`apps/cli/src/commands/loop.command.ts:209-243`) does not register `onIterationSummary` and the MCP tool registers no callbacks at all, so additive fields cannot break either consumer. `LoopDomain` is a pass-through. This keeps a single source of truth in tm-core: the service computes counts and percentages once, the payload ships them, and any future presentation layer reads them without re-classifying.

### Filename derivation
**Choice:** Use `path.parse(config.progressFile)` and `path.format({ dir, name: `${name}.iter-${padded}`, ext })`. Padding width = `String(config.iterations).length` so suffixes sort lexicographically. The totals filename uses the same recipe with `name: `${name}.totals``.
**Rationale:** `path.parse`/`path.format` handles Windows drive letters and trailing separators cleanly (the repo runs on win32). Dynamic padding accommodates >99-iteration runs without breaking sort order.

### Pre-flight failure handling
**Choice:** No per-iteration files and no totals file are written for `buildErrorResult` failures.
**Rationale:** `buildErrorResult` already bypasses `finalize()`, so plumbing the totals write into `finalize()` (alongside `appendFinalSummary`) naturally segregates pre-flight failures. No special-casing required.

### Cumulative totals file content
**Choice:** A header section with cumulative aggregates plus a markdown table with one row per iteration.
**Rationale:** The header gives the at-a-glance total; the table gives per-iteration drill-down without having to open N sibling files. Header fields: total iterations, total tool calls (with classification breakdown), total tokens (input/output/cache read/cache write/total), total estimated context, total wall-clock duration, tasks completed, final status. Table columns: `Iter | Tool calls | TM | Writes | Non-writes | Total tokens | Est. context | % of 1M`. The `% of 1M` column is rendered per-iteration only when that iteration's captured model id matched `/opus/i`; otherwise the cell is `—`.

## Out of Scope

- Splitting the existing `Tokens:` bullet block in the per-iteration summary (it remains as today, unchanged).
- Adding any new CLI flag or MCP parameter. The new behavior is gated by the existing `traceLevel` setting; no opt-out flag for per-iteration file emission.
- Promoting the new `iterationTelemetry` accumulator to a public type on `LoopIteration`. Stays private to `LoopService`.
- Detecting `task-master ...` shell invocations through `Bash` — only the `mcp__task-master-ai__*` prefix is classified as task-master; intent through `Bash` is counted under non-writes.
- Touching `LoopDomain`, `apps/cli`, or `apps/mcp`. The `onIterationSummary` payload is widened additively; no consumer is required to read the new fields.
- Console output behavior — silence and trace prefixes remain unchanged; only file writes are restructured.
- Run-id suffixing or refuse-to-start collision modes for per-iteration files.

## Open Questions

None. All design axes were resolved during iteration.
