---
topic: "Split loop logging into per-iteration files, add tool-call/context summary, and emit a cumulative per-loop totals file"
tags: [research, codebase, tm-core, loop-service, progress-file, trace-level, tag-e4a52d]
status: complete
source_question: thoughts/shared/questions/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md
---

# Research: Per-Iteration Loop Logging and Cumulative Totals

## Research Question

Redesign the `LoopService` logging surface so that:

1. `progress.txt` becomes a high-signal, one-line-per-iteration log (only the new human-readable summary line per iteration).
2. A new per-iteration sibling file (`<stem>.iter-NN.<ext>`) holds the full `## Iteration N` block, the iteration summary block, and all trace-level details.
3. `buildIterationSummaryBlock` gains a new human-readable line with total tool calls, total `mcp__task-master-ai__*` calls, write tool calls (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`), non-write tool calls, estimated context used (`input + cache_creation + cache_read`), and `(X% of 1M)` when the model id contains `"opus"`.
4. The new counts/context fields are threaded through `LoopOutputCallbacks.onIterationSummary` (additive — no new callback).
5. A cumulative totals file (`<stem>.totals.<ext>`) is written once at `finalize()` containing cumulative totals plus a per-iteration markdown table.

## Summary

The change touches a single file end-to-end (`packages/tm-core/src/modules/loop/services/loop.service.ts`) plus an additive type extension in `packages/tm-core/src/modules/loop/types.ts`. The data needed for the new summary line (tool call names, token usage) is already captured by today's code paths — the missing pieces are: (a) the classification helpers themselves (no existing code categorizes tool names by category), (b) the model id (today's code does not read any `model` field from the stream), and (c) the file-routing logic to split content between `progress.txt`, the per-iteration sibling, and the new totals file.

The CLI (`apps/cli/src/commands/loop.command.ts`) does not register `onIterationSummary` today, so additive field changes to that callback's payload are safe for the CLI; the MCP tool (`apps/mcp/src/tools/loop/loop.tool.ts`) does not register any callbacks at all. `LoopDomain` (`packages/tm-core/src/modules/loop/loop-domain.ts`) is a thin facade and forwards callbacks unchanged. All existing trace-level tests use a `makeMockSpawnChild` factory that already produces the exact event shapes (`assistant`/`tool_use`, `user`/`tool_result`, `result` with `usage`) that the new code needs; the test harness can be reused as-is.

## Detailed Findings

### Research Area 1 — Current Logging Surfaces & Flush Points

The full lifecycle of progress-file writes today:

1. `initProgressFile` (`loop.service.ts:339-361`) creates the parent directory with `mkdir({ recursive: true })`, then **appends** (not overwrites) a header block to `progress.txt`:
   - `# Taskmaster Loop Progress`
   - `# Started: <ISO>`
   - `# Brief: <brief>` (only when `config.brief` set)
   - `# Preset: <prompt>`
   - `# Max Iterations: <iterations>`
   - `# Tag: <tag>` (only when `config.tag` set)
   - a `---` divider
   The leading `'\n'` (line 358) means re-runs accumulate cleanly when the file already existed.

2. `executeVerboseIteration` (`loop.service.ts:678-911`) — runs only when `atLeast(level, 'verbose')`. Allocates an in-memory `iterationFileLines: IterationFileLine[]` buffer when `progressFile` is set (line 701-703). Initial entries (lines 705-716):
   - `{ level: 'verbose', content: '## Iteration N' }` — always
   - `{ level: 'trace', content: '### LLM input\n```text\n<truncated prompt>\n```' }` — only at trace
   During stream parsing, `handleStreamEvent` pushes trace-level `### Tool: <name> input` and `### Tool: <name> result` entries (lines 1055-1085). At child `close` (lines 874-899), the buffer gets:
   - `buildIterationSummaryBlock` output as a `verbose` entry (lines 880-887)
   - A `{ level: 'separator', content: '---' }` divider
   Then all entries are mapped through `tagEntry` and a **single** `appendFile` call writes the whole iteration block in one shot. The flush is async (returns a promise); errors are caught and propagated via `rejectOnce` to the outer promise.

3. `buildIterationSummaryBlock` (`loop.service.ts:403-452`) builds a `### Iteration N summary` block with three optional sub-sections:
   - `- Tool calls:` followed by `  - <name>: <count>` lines, when `summary.toolCalls.length > 0`
   - `- Tokens:` followed by `  - input/output/cache write/cache read/total` lines, when `summary.tokenUsage` present
   - `- Final result:` followed by a fenced text block, when `summary.finalResult` present
   This block runs at **verbose or trace** — `toolCallCounts` is always tallied (lines 1049-1054), so the verbose-only path still gets a summary block in the progress file.

4. `tagEntry` (`loop.service.ts:454-486`) walks lines and prepends `[VERBOSE]` or `[TRACE]` tags. Code fences are passed through verbatim (so JSON blocks inside `` ```json ``` ` are not tagged). Markdown headers get the tag inserted after `#`s (e.g. `## [VERBOSE] Iteration 1`). The `separator` level returns the content unchanged.

5. `appendFinalSummary` (`loop.service.ts:363-385`) appends, after `finalize()` runs, a `--- # Loop Complete: <iso>` block with totals lines (`Total iterations`, `Tasks completed`, `Final status`, `Total duration: <ms>ms`). It uses `result.finishedAt` so the file timestamp matches what CLI/MCP report.

6. The always-on tool-call tally (`loop.service.ts:1049-1054`) lives in `handleStreamEvent` and runs whenever an `assistant`/`tool_use` block arrives, regardless of trace level — the `Map<string, number>` is built so the per-iteration block in the progress file is correct even in verbose-only mode (no trace).

**No content is lost today.** The verbose-only path produces `## Iteration N` + summary block. The trace path adds `### LLM input`, `### Tool: X input`, `### Tool: X result` blocks. The `none` path bypasses `executeVerboseIteration` entirely (uses `spawnSync`) and writes nothing to `progress.txt` per iteration — only the header from `initProgressFile` and the footer from `appendFinalSummary`.

### Research Area 2 — Per-Iteration File Naming & Creation

There is **no existing sibling-file pattern in the codebase.** All per-iteration content goes into the single `progressFile` path today. The closest existing infrastructure is the `iterationFileLines` buffer and its single-flush `appendFile` at `loop.service.ts:890-898`.

To derive `<stem>.iter-NN<ext>`, `path.parse(config.progressFile)` returns `{ dir, name, ext, base, root }`; `path.format({ dir, name: \`\${name}.iter-\${padded}\`, ext })` recomposes. This works correctly on Windows because the repo runs on win32 (`platform: win32` in the environment) — string concatenation could mishandle paths with trailing separators or drive letters, but `path.parse`/`path.format` does not. (No existing code in the loop module uses `path.parse`; the only `path.*` usage in the service today is `path.dirname(config.progressFile)` at line 343 and `path.join(this.projectRoot, '.mcp.json')` at line 58.)

The "buffer then flush" pattern (currently `iterationFileLines` accumulated → one `appendFile`) maps cleanly to "buffer then write" for the sibling file. Reusing the same buffer-and-tag pipeline preserves the `tagEntry` post-processing.

Iteration suffix width is derived from `config.iterations`: `String(i).padStart(String(config.iterations).length, '0')` keeps lexicographic sort order. For the typical 10-iteration default that produces `.iter-01` through `.iter-10`; for `iterations: 100` it produces `.iter-001` through `.iter-100`.

### Research Area 3 — Tool-Call Classification

`toolCallCounts: Map<string, number>` is the source of truth. Keys are `block.name` from the stream-json `assistant`/`tool_use` event (`loop.service.ts:1047-1054`). The map is always populated regardless of trace level.

**No existing classifier exists in the codebase.** A search for `startsWith('mcp__task-master-ai__')` returns no `.ts` matches. A search for the literal write-tool set `{Write, Edit, MultiEdit, NotebookEdit}` as a constant returns no matches. The only `getToolCategories` function in the repo (`mcp-server/src/tools/tool-registry.js:158-161`) categorizes the MCP **server's exposed tools** by tier (core/standard/all), not Claude tool-call names by classification.

The classification rules from the question:

- **Task-master:** `name.startsWith('mcp__task-master-ai__')` — strict prefix; Bash-shelled `task-master ...` is not detected because the tool name is `Bash`, not `task-master`.
- **Write:** `name ∈ { 'Write', 'Edit', 'MultiEdit', 'NotebookEdit' }` — local file-mutation tools only; Bash and MCP task-master tools do **not** count as writes, even when their intent is a write (e.g., `mcp__task-master-ai__set_task_status` counts under task-master but not under write).
- **Non-write:** `totalToolCalls − writeToolCalls`.
- **Total:** sum of all `toolCallCounts` values.

The four MCP tool prefixes that should be detected are listed in the deferred-tool list for this session — every task-master MCP tool follows the `mcp__task-master-ai__<verb>` shape. The preset prompt file (`packages/tm-core/src/modules/loop/presets/default.ts:16,17,22`) hardcodes these names but does not classify them at runtime.

The natural place for the classifier is alongside `LoopService` (either as a small helper module `services/tool-classification.ts` or as private statics on the service). Since the `onIterationSummary` payload needs the counts and the CLI/MCP would re-render them, single-source-of-truth points to computing them once on the service and shipping the result through the callback.

### Research Area 4 — Token / Context Math & Model Detection

**Today's code does not capture any model id.** The full census of stream-event `type` branches in the service:

| `loop.service.ts` line | `event.type` | Fields read |
|---|---|---|
| 766 | `'result'` | `event.result` (string), `event.usage` (token counts only) |
| 1043 | `'assistant'` | `event.message.content[]` (text, tool_use) |
| 1072 | `'user'` (trace-gated) | `event.message.content[]` (tool_result) |

`extractTokenUsage` (`loop.service.ts:526-568`) reads only `u.input_tokens`, `u.output_tokens`, `u.cache_creation_input_tokens`, `u.cache_read_input_tokens` from the `usage` sub-object — no top-level `model`/`modelId` is inspected. `isValidStreamEvent` (lines 923-964) declares the predicate type with `type`, `message?`, `result?`, `usage?` — no `model` field.

Stream-json events the CLI emits but the service currently ignores: `system` events with `subtype` (recognized only in `/hack/visualize.ts:296` — a developer-only script). The `system` event is typically emitted at stream start with `subtype: 'init'` and may carry `session_id` and (per Claude Code CLI conventions) `model`.

Two natural insertion points:

- **Option A — `result` event.** Co-locate model capture with token-usage capture in `processLine` at `loop.service.ts:766-772`. Pro: single event, single capture site. Con: depends on the model field appearing on `result` (the question file notes "typically carries"; older CLIs may omit it).
- **Option B — `system`/`init` event.** Add a new `event.type === 'system'` branch in `processLine`. Pro: stable across the full stream; arrives at stream start. Con: introduces a new event-type branch and requires confirming the field name (`model`, `modelId`, or nested under `subtype: 'init'`).

The edge case "Model id absent from `result` event" is called out in the question file (line 82) — behavior is to omit the `(X% of 1M)` segment without crashing.

**Context math:**
- Estimated context = `inputTokens + (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0)`.
- `cacheCreationInputTokens` and `cacheReadInputTokens` are optional on `LoopTokenUsage` (`types.ts:42-44`); coalesce to 0.
- Percent = `estimatedContext / 1_000_000 * 100`, rendered to one decimal.
- Gate: render `(X% of 1M)` only when `modelId && /opus/i.test(modelId)`.

### Research Area 5 — `LoopOutputCallbacks.onIterationSummary` Extension

Current shape (`types.ts:97-104`):

```ts
onIterationSummary?: (
  iteration: number,
  summary: {
    toolCalls: LoopToolCallSummary[];
    finalResult?: string;
    tokenUsage?: LoopTokenUsage;
  }
) => void;
```

**Backwards-compat impact:**

- `apps/cli/src/commands/loop.command.ts` — does **not** register `onIterationSummary` (CLI's `createOutputCallbacks()` at `loop.command.ts:209-243` returns only `onIterationStart`, `onError`, `onStderr`, `onOutput`, `onIterationEnd`). Adding fields cannot break the CLI.
- `apps/mcp/src/tools/loop/loop.tool.ts` — passes no `callbacks` at all (verified in `loop.tool.ts:106-116`). Cannot break.
- `packages/tm-core/src/modules/loop/loop-domain.ts:184-200` — forwards `callbacks` unchanged in `buildConfig`. Pure pass-through.

**Additive fields the question requests on the summary payload:**

- `totalToolCalls: number`
- `taskMasterToolCalls: number`
- `writeToolCalls: number`
- `nonWriteToolCalls: number`
- `estimatedContext: number`
- `percentOf1M?: number` (omitted when not Opus or when context is n/a)
- `modelId?: string` (captured from stream; omitted when stream did not report)

These render in trace mode only (same gate as the existing summary callback fires under at `loop.service.ts:863-872`).

### Research Area 6 — Cumulative Totals File

The cumulative file is written once at `finalize()` (`loop.service.ts:271-294`) — the same place `appendFinalSummary` runs today. It must be written for every `finalStatus` that has any executed iteration (`all_complete`, `max_iterations`, `blocked`), but **not** for pre-flight failures via `buildErrorResult` (`loop.service.ts:300-319`) — `buildErrorResult` doesn't call `finalize()`, so the natural plumbing already segregates the cases.

Two accumulator placements:

- **Walk iterations at finalize** — pure functional; relies on each `LoopIteration` carrying the per-iteration counts (tool counts, token usage, classification). Today `LoopIteration` (`types.ts:174-194`) carries only `iteration`, `taskId?`, `status`, `message?`, `duration?`, `output?` — none of the telemetry. Widening `LoopIteration` would be a public-API addition.
- **Service-level accumulator** — `LoopService` keeps a private `iterationTelemetry: PerIterationTelemetry[]` array, mirroring what each iteration's summary contained, and `finalize()` reads it. No public type change. The accumulator is local to the run() call (re-instantiated per run); a fresh service is created by `LoopDomain.run()` (`loop-domain.ts:60-74`), so there's no state-bleed risk across runs.

The cumulative file content per the question:

- **Header section:** total iterations, total tool calls, total task-master / write / non-write, total tokens broken out (input/output/cache_read/cache_create), total estimated context, total wall-clock duration, tasks completed, final status.
- **Per-iteration table:** markdown table with columns `Iter`, `Tool calls`, `TM calls`, `Writes`, `Non-writes`, `Total tokens`, `Est. context`, `% of 1M` (rendered only when the iteration's model id matched opus; otherwise blank/`—`).

### Research Area 7 — Backward Compatibility & Opt-Outs

**`traceLevel = 'none'`** (`loop.service.ts:200-262` main loop, `617-658` non-streaming path): bypasses `executeVerboseIteration` entirely. There is no `toolCallCounts` map and no stream-json parsing — only `spawnSync` and the textual `parseCompletion`. Decisions documented in the question:

- Per-iteration sibling files are **not** produced (no source data).
- `progress.txt` continues to get only the header (from `initProgressFile`) and the footer (from `appendFinalSummary`). The new human-readable summary line cannot be rendered for `none` iterations because there is no telemetry — emit nothing per iteration, or emit a minimal `Iteration N: <status> (no telemetry)` line. The question explicitly says "pick one and stay consistent."

**`--include-output`** (`config.includeOutput`, `types.ts:138`): populates `LoopIteration.output` with the full stdout+stderr text. Currently only used inside the non-streaming path (`loop.service.ts:657`) and the streaming path's resolve (`loop.service.ts:907`). Independent of the file-split; the totals file does not include raw output.

**Re-runs / filename collisions:** `initProgressFile` appends to `progress.txt` if it already exists (`loop.service.ts:355-360`). For per-iteration sibling files, no precedent exists — the question lists three options (overwrite, suffix with run id, refuse to start) and signals "overwrite for the current iteration range" as the precedent-aligned choice. The totals file would also be overwritten.

## Edge Cases Addressed

- **Model id absent from `result` event** — `extractTokenUsage` does not currently inspect `model`; the new code coalesces `modelId` to `undefined` and the percentage segment is skipped without crashing. Behavior matches question line 82.
- **No `tokenUsage` for the iteration** — `extractTokenUsage` already returns `undefined` when usage is missing or all zeros (`loop.service.ts:544-551`). The new summary line must render with `tokens: n/a` / `context: n/a` and omit the percentage. Existing test coverage at `loop.service.spec.ts:1249-1265` confirms the undefined paths.
- **No tool calls in an iteration** — `toolCallCounts` is empty (zero-size Map). The summary line must render with `0` across all four count categories, not be skipped.
- **`traceLevel = 'none'`** — no streaming path; verbose path bypassed. No per-iteration sibling file is produced. The `progress.txt` line policy is a documented choice (skip or minimal line).
- **Pre-flight failures** (`buildErrorResult` at `loop.service.ts:300-319`) — never calls `finalize()`, so the totals file is **not** written. `appendFinalSummary` is also skipped today, which means `progress.txt` for a pre-flight failure has only the `initProgressFile` header (if it ran) plus nothing else. This is already the established behavior.
- **Early-exit statuses** (`complete`, `blocked`) — `finalize()` is reached via `loop.service.ts:227-247`, so the totals file is written with whatever iterations completed. Matches the question's spec.
- **Filename collisions / re-runs** — `initProgressFile` appends today; per-iteration sibling files have no precedent. Default per the question discussion: overwrite per-iteration files for the current iteration range.
- **Windows path handling** — repo runs on win32 (verified in env); `path.parse`/`path.format` handles drive letters and backslashes cleanly; the existing code uses `path.dirname` already at `loop.service.ts:343`.
- **More than 99 iterations** — pad width dynamically with `String(config.iterations).length`.
- **Cache fields undefined on `LoopTokenUsage`** — optional in type (`types.ts:42-44`); coalesce to 0 in the context formula. The existing test at `loop.service.spec.ts:1292-1310` covers the "fields absent" case for `extractTokenUsage`.
- **`mcp__task-master-ai__*` that is also a write intent** — classified as task-master, not write, per the documented rule (`Write`-bucket is restricted to the four local tools).
- **Iteration with no summary line** (e.g., trace off, or stream produced no events) — policy decision; the question requests one consistent choice.

## Code References

### Primary file to modify

- `packages/tm-core/src/modules/loop/services/loop.service.ts:339-361` — `initProgressFile`; emits `progress.txt` header (no per-iteration writes).
- `packages/tm-core/src/modules/loop/services/loop.service.ts:363-385` — `appendFinalSummary`; the natural place to also write the totals sibling file.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:271-294` — `finalize`; calls `appendFinalSummary`. Pre-flight failures bypass it.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:300-319` — `buildErrorResult`; pre-flight failure path; does **not** call `finalize` (no totals file emitted, by design).
- `packages/tm-core/src/modules/loop/services/loop.service.ts:403-452` — `buildIterationSummaryBlock`; extend with the new human-readable summary line.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:454-486` — `tagEntry`; tags will continue to apply to per-iteration sibling content if reused unchanged.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:526-568` — `extractTokenUsage`; candidate insertion point for capturing `model` from the `result` event (Option A).
- `packages/tm-core/src/modules/loop/services/loop.service.ts:744-780` — `processLine` inside `executeVerboseIteration`; alternate model-capture site if reading from `system`/`init` (Option B); also where `tokenUsage` and `finalResult` are accumulated.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:863-872` — trace-mode `onIterationSummary` invocation; payload extension lands here.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:874-899` — single `appendFile` flush of `iterationFileLines` to `progressFile`; this is the seam to redirect to the per-iteration sibling file and emit only the summary line to `progress.txt`.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:923-964` — `isValidStreamEvent`; type predicate to widen if a new field is captured.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:1022-1086` — `handleStreamEvent`; always-on `toolCallCounts` tally is here; new event-type branches go here if Option B is chosen.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:1043-1054` — `toolCallCounts.set(...)`; the always-on tally used by both verbose and trace summary paths.

### Type definitions

- `packages/tm-core/src/modules/loop/types.ts:36-47` — `LoopTokenUsage` (cache fields optional; context formula coalesces undefined to 0).
- `packages/tm-core/src/modules/loop/types.ts:97-104` — `LoopOutputCallbacks.onIterationSummary`; payload to extend with new count/context/model fields (additive).
- `packages/tm-core/src/modules/loop/types.ts:174-194` — `LoopIteration`; today does **not** carry telemetry; decision point on whether to widen it or keep a service-level accumulator.
- `packages/tm-core/src/modules/loop/types.ts:199-216` — `LoopResult`; `finalStatus` enum drives totals-file gating.

### Trace helpers

- `packages/tm-core/src/modules/loop/services/trace-level.ts:3-14` — `TRACE_LEVEL_WEIGHTS` map + `atLeast(level, threshold)`; `'none'=0`, `'verbose'=1`, `'trace'=2`.

### Presentation layers (read-only for this change)

- `apps/cli/src/commands/loop.command.ts:209-243` — `createOutputCallbacks()`; does **not** register `onIterationSummary` today (additive type changes are safe).
- `apps/cli/src/commands/loop.command.ts:56-59` — `--progress-file` option; default `'.taskmaster/progress.txt'`.
- `apps/cli/src/commands/loop.command.ts:246-258` — `displayResult()`; renders `LoopResult` summary to stdout (totals file is independent).
- `apps/mcp/src/tools/loop/loop.tool.ts:11-71` — `LoopSchema`; `progressFile` is `z.string().optional()`.
- `apps/mcp/src/tools/loop/loop.tool.ts:106-116` — call to `tmCore.loop.run({...})`; no `callbacks` field.
- `packages/tm-core/src/modules/loop/loop-domain.ts:60-74` — `LoopDomain.run`; thin facade; instantiates fresh `LoopService` per call.
- `packages/tm-core/src/modules/loop/loop-domain.ts:184-200` — `buildConfig`; applies `progressFile` default via `path.join(this.projectRoot, '.taskmaster', 'progress.txt')` only when the value is `undefined`.

### Existing tests (slot points for new tests)

- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:805-1109` — `describe('trace file persistence', ...)` block; uses `makeMockSpawnChild` factory at lines 806-831 — the right harness to reuse for per-iteration sibling file and totals file assertions.
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:894-924` — token-usage rows in summary block (existing coverage of `buildIterationSummaryBlock` output).
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:926-973` — single `appendFile` per iteration (existing coverage of the flush seam).
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:1234-1331` — `extractTokenUsage` direct unit tests; covers usage absent, all-zero, partial fields.
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:642-698` — only test that asserts `toolCallCounts.get('Bash') === 1` directly via private-method extraction.
- `vi.mocked(fsPromises.writeFile).mock.calls` — currently installed in `beforeEach` (line 37) but **never asserted against** in any existing test; this is the natural mock-target for new sibling and totals file writes.

## Architecture Documentation

### Layering (per `CLAUDE.md`)

All business logic lives in `@tm/core`. `apps/cli` and `apps/mcp` are thin presentation layers. The classification of tool names (task-master / write / non-write), the context-percentage math, and the model-id Opus check all belong inside `LoopService` (or a sibling helper module in the loop module). The CLI/MCP receive the computed numbers through the `onIterationSummary` payload — they never re-compute or re-classify. This matches the existing pattern: the CLI's `displayResult` just renders the `LoopResult` fields produced by tm-core.

### Module organization

`packages/tm-core/src/modules/loop/` already follows the documented layout:

- `loop-domain.ts` — facade
- `services/loop.service.ts` — orchestration
- `services/trace-level.ts` — verbosity helper
- `presets/` — prompt presets
- `types.ts` — domain types

A new classification helper file (e.g. `services/tool-classification.ts`) would slot naturally beside `trace-level.ts` if extracted; alternatively, keeping the helpers as private methods on `LoopService` is consistent with the existing pattern (`extractTokenUsage`, `parseCompletion`, `buildIterationSummaryBlock` are all private methods).

### Stream-json event handling pattern

The existing pattern for capturing data from a specific event type in `processLine`:

```ts
if (event.type === 'result') {
    finalResult = typeof event.result === 'string' ? event.result : '';
    const usage = this.extractTokenUsage(event);
    if (usage) {
        tokenUsage = usage;
    }
}
```

The model-id capture (either on `result` or `system`) would follow the same shape: declare a local `let modelId: string | undefined` near where `tokenUsage` is declared (`loop.service.ts:741`), assign inside the type-checked branch, then pass through into the `iterationFileLines` and `onIterationSummary` payload at the `close` handler.

### Buffer-then-flush pattern for per-iteration files

The current pattern for iteration content (`iterationFileLines.push(...)` → mapped through `tagEntry` → one `appendFile`) maps directly to the new sibling-file flow: the same buffer, the same single write, but routed to `<stem>.iter-NN<ext>` via `path.format` instead of `progress.txt`. `progress.txt` receives a separate, much smaller `appendFile` containing just the human-readable summary line.

## Historical Context (from thoughts/shared/)

The current logging surface was shaped by a sequence of recently-archived design rounds:

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — Replaced `--verbose` and `--trace` booleans with the `--tracelevel <none|verbose|trace>` enum and the `atLeast()` comparison helper. The hierarchical model that the new summary line depends on came from here.

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Established the pattern of persisting trace-level content to the progress file (rather than only emitting it via callbacks). Settled ANSI stripping and the placement of file writes inside the verbose path.

- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md` — Added the `[VERBOSE]` / `[TRACE]` line tagging that `tagEntry` implements. The new split must keep tagging applied to content that moves into the per-iteration sibling file.

- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md` — Established that progress-file writes are independent of console output. The new split inherits this: per-iteration sibling files are emitted whether or not the console is silent.

- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md` — Hardcoded the explicit `mcp__task-master-ai__<verb>` tool names in the presets. The strict prefix the new classifier matches against was already established by this work; the preset file uses the exact same shape the new classifier filters on.

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-6af922-session-persistence-flag.md` — Pattern for additive `LoopConfig` extension and CLI/MCP flag plumbing. Not directly required for this change (the new behavior is opt-in by being controlled by `traceLevel`, no new flag), but useful precedent if a `--no-iteration-files` opt-out is added.

## Related Research

- `thoughts/shared/questions/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md` — Source question for this research.
- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md` — Tagging pattern that survives into the new sibling file.
- `thoughts/shared/claude-code-design/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Foundational pattern for file writes inside the verbose path.

## Open Questions

1. **Model id source — `result` event vs. `system`/`init` event.** The question file documents both options but does not commit. Empirical confirmation needed against the Claude CLI version the repo targets: does the `result` event include `model`/`modelId` reliably? `/hack/visualize.ts:296` only confirms `system` events with `subtype` exist; the exact field name and shape for `model` was not verified by this research.

2. **`LoopIteration` widening vs. service-level accumulator for totals.** The cumulative file needs per-iteration counts. Widening `LoopIteration` (`types.ts:174-194`) with `toolCallCounts`, `tokenUsage`, etc. would let the totals file be rebuilt by walking `iterations[]` at finalize time; the alternative is a private accumulator on the service. The first is a public-API extension (additive but observable); the second is internal-only. No precedent in the repo for either choice in this module — both are viable.

3. **`progress.txt` line for non-streaming iterations** (`traceLevel = 'none'`). With no `toolCallCounts` source, the new human-readable summary line cannot render. Options the question lists: skip the iteration in `progress.txt` entirely, or emit `Iteration N: <status> (no telemetry)`. Needs a one-line decision.

4. **Filename collision policy** for per-iteration sibling files on re-runs (`initProgressFile` appends today). Three options listed (overwrite, run-id suffix, refuse to start). The question signals "overwrite per-iteration files for the current iteration range" as the precedent-aligned default but does not commit.

5. **Helper extraction.** Should classification helpers live as private methods on `LoopService`, or as a separate `services/tool-classification.ts` module (parallel to `services/trace-level.ts`)? The repo's module-organization rule favors private methods unless 2+ consumers exist; today there is only one consumer (the service itself), so private methods are the YAGNI-aligned default.

6. **Token-usage handling when `result` event arrives but `usage` is all zeros.** `extractTokenUsage` returns `undefined` for the all-zero case (`loop.service.ts:544-551`). The new code should mirror this: if `tokenUsage` is undefined, the context line and the percentage are both suppressed, but the tool-call portion still renders.
