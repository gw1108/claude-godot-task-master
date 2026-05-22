---
researcher: George (georgetw1108@gmail.com)
original_question: "Instead of trace logging all tool usage into the progress file, make it so that there is a new file for each iteration. The goal is to keep the progress.txt file more clean and the additional details that come from trace or verbose should be a per iteration file. In buildIterationSummaryBlock in packages/tm-core/src/modules/loop/services/loop.service.ts:403-452, it'll list some tool calls. Let's add an easier human readable line detailing the total tool calls, total task-master toolcalls, write tool calls, non-write tool calls, an estimated context used, and a percent of the 1M context used if we are using Opus. And let's also add this data to a total loop file so that we can see what is the cumulative summary of tokens used and tool calls used per task-master loop."
ticket: tag-e4a52d
---

# Research Question: Split loop logging into per-iteration files, add tool-call/context summary, and emit a cumulative per-loop totals file

## Refined Question
Redesign the `LoopService` logging surface in `packages/tm-core/src/modules/loop/services/loop.service.ts` so that:

1. **`progress.txt` becomes a high-signal, one-line-per-iteration log.** All of the existing per-iteration content currently flushed by `executeVerboseIteration` (the `## Iteration N` header, the `### Iteration N summary` block produced by `buildIterationSummaryBlock` at `loop.service.ts:403-452`, and every trace-tagged `### LLM input` / `### Tool: <name> input` / `### Tool: <name> result` JSON block) moves out of `progress.txt`. What remains in `progress.txt` for each iteration is only the new human-readable summary line (see #2).

2. **A new per-iteration file is written as a sibling of `progress.txt`.** Naming: `<progressFile-stem>.iter-NN.<ext>` (e.g. `progress.iter-01.md` next to `progress.txt`). This file contains everything currently written by the iteration block — `## Iteration N`, the full iteration summary block (tool-call breakdown, token table, final result), and all trace-level details — at the trace/verbose level the loop was run with.

3. **`buildIterationSummaryBlock` gains a new human-readable summary line** with all of:
   - Total tool calls (sum of `toolCallCounts` values)
   - Total task-master tool calls (names matching the strict prefix `mcp__task-master-ai__*`)
   - Write tool calls (`Write`, `Edit`, `MultiEdit`, `NotebookEdit` — local file-mutation tools only; Bash and MCP task-master tools do NOT count as writes)
   - Non-write tool calls (total minus the write bucket)
   - Estimated context used: `inputTokens + cacheCreationInputTokens + cacheReadInputTokens` from `LoopTokenUsage` (`types.ts:36-47`)
   - Percent of 1M context used, rendered as `(X% of 1M)`, but ONLY when the model id reported on the stream-json `result` event contains `"opus"`. Otherwise the percentage is omitted.

   This same summary line is the single line that lands in `progress.txt` for that iteration.

4. **The new summary fields are also threaded into `LoopOutputCallbacks.onIterationSummary`** (`types.ts:97-104`) so the CLI/MCP layer can render them in trace mode. Extend the existing summary payload — do not introduce a new callback.

5. **A new cumulative "loop totals" file is written once, at `finalize()`**, as a sibling of `progress.txt` (e.g. `<progressFile-stem>.totals.md`). It contains:
   - Cumulative totals: total iterations, total tool calls, total task-master / write / non-write counts, total tokens broken out as input/output/cache_read/cache_create, total estimated context, total wall-clock duration, tasks completed, final status.
   - A markdown table with one row per iteration: iteration #, tool calls, tm calls, writes, non-writes, total tokens, estimated context, % of 1M (when Opus).

   This file is built once when the loop ends (success or early exit) inside `finalize` / `appendFinalSummary`. A mid-loop crash is acceptable and yields no totals file.

## Research Areas

1. **Current logging surfaces & flush points** — Map exactly what `initProgressFile` (`loop.service.ts:339`), `executeVerboseIteration`'s `iterationFileLines` flush (`loop.service.ts:874-899`), `buildIterationSummaryBlock` (`loop.service.ts:403-452`), `tagEntry` (`loop.service.ts:454-486`), and `appendFinalSummary` (`loop.service.ts:363-385`) write today, so the refactor moves content rather than losing it. Include how the verbose-only path (no trace) still gets a summary block in the progress file via the always-on `toolCallCounts` tally (`loop.service.ts:1049-1054`).

2. **Per-iteration file naming & creation** — Derive the sibling filename from `LoopConfig.progressFile` (stem + `.iter-NN` + original extension, zero-padded to width 2 unless `config.iterations > 99`). Confirm `path.parse`/`path.format` covers Windows paths cleanly given the repo runs on win32. Decide whether the file is opened once and appended to as the iteration progresses, or assembled in memory and written once at iteration close (current pattern is "buffer then flush"; preserving it is simplest).

3. **Tool-call classification** — `toolCallCounts` is keyed by `block.name` from the stream-json `assistant`/`tool_use` event (`loop.service.ts:1047-1054`). Categorization rules to implement as helpers on the service:
   - Task-master: `name.startsWith('mcp__task-master-ai__')`
   - Write: `name` ∈ {`Write`, `Edit`, `MultiEdit`, `NotebookEdit`}
   - Non-write: total − write
   Confirm whether the categorization belongs in `LoopService` or in a sibling helper module (favoring single source of truth for the rules so the CLI/MCP can reuse them via the callback payload).

4. **Token / context math & model detection** — Estimated context per iteration = `inputTokens + (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0)` from `LoopTokenUsage`. The Opus gate needs the model id, which the loop currently does not capture: the stream-json `result` event from Claude CLI typically carries a `model` (or `modelId`) field that `extractTokenUsage` (`loop.service.ts:526-568`) does not inspect. Research whether to (a) capture the model id alongside `tokenUsage` and pipe it into `buildIterationSummaryBlock`, or (b) read it from the `system`/`init` event at the start of the stream. Percentage is `estimatedContext / 1_000_000 * 100`, rendered to one decimal, only when the captured model id matches `/opus/i`.

5. **`LoopOutputCallbacks.onIterationSummary` extension** — Extend the `summary` parameter type at `types.ts:97-104` with the new counts (totalToolCalls, taskMasterToolCalls, writeToolCalls, nonWriteToolCalls, estimatedContext, percentOf1M?) and the captured model id. Backwards compatibility for existing CLI/MCP callers should be considered (additive fields only). The new fields fire in trace mode (same gate as today).

6. **Cumulative totals file** — Written once inside `finalize()` after the iteration loop ends, regardless of `finalStatus` (success, early exit, blocked, max_iterations, error with iterations completed). Sourced from the `LoopIteration[]` plus a service-level accumulator that mirrors what's in each iteration's summary. Decide whether the accumulator lives on the `LoopService` instance or is rebuilt by walking the iterations at finalize time (favor "rebuild at finalize" to keep state local — but that requires the per-iteration counts to be stored on `LoopIteration`, which they currently are not). If we don't want to widen `LoopIteration`, the service must accumulate as iterations complete.

7. **Backward compatibility & opt-outs** — Behavior changes when `traceLevel = 'none'` (no streaming): the verbose-only path doesn't exist, so per-iteration files only apply at `verbose` or `trace`. Confirm `progress.txt` still gets the iteration summary line at all trace levels (or only when streaming is active), and whether `--include-output` interacts with the split.

## Clarifications Gathered

- **Q:** What should the per-iteration file layout look like?
  **A:** Sibling files next to `progress.txt` (e.g. `progress.iter-01.md`).

- **Q:** What should remain in `progress.txt` vs. move out to the per-iteration file?
  **A:** Only the new human-readable summary line in `progress.txt`. The full iteration summary block (tool-call breakdown, token table, final result) and all trace details move to the per-iteration file.

- **Q:** How should we classify 'write' tool calls?
  **A:** Local file-mutation tools only: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`. Bash and MCP task-master tools are NOT counted as writes.

- **Q:** What should 'estimated context used' mean, and how do we handle the Opus % gate?
  **A:** `input + cache_creation + cache_read`. Show `(X% of 1M)` only when the model id reported by the stream contains `"opus"`; otherwise omit the percentage.

- **Q:** What goes into the cumulative loop file?
  **A:** Totals + a per-iteration markdown table (iter #, tool calls, tm calls, writes, non-writes, tokens, % of 1M).

- **Q:** When and where should the cumulative file be written?
  **A:** Once, at `finalize()` — no incremental rewrites. A mid-loop crash yielding no totals file is acceptable.

- **Q:** How should the new human-readable summary line surface in the CLI/MCP beyond files?
  **A:** Extend the existing `LoopOutputCallbacks.onIterationSummary` payload with the new counts/context fields (trace mode, as today). No new dedicated callback.

- **Q:** How precise should the 'task-master tool call' match be?
  **A:** Strict prefix `mcp__task-master-ai__*`. Bash-shelled `task-master ...` calls are not detected (we only see the tool name, not Bash args).

## Edge Cases to Address

- **Model id absent from `result` event.** Some Claude CLI versions or aborted runs may omit `model`. Behavior: omit the `% of 1M` segment, do not crash.
- **No `tokenUsage` for the iteration.** Already happens today (older CLIs, aborted runs — see `extractTokenUsage` returning undefined at `loop.service.ts:545-551`). The new summary line must still render with "tokens: n/a" / "context: n/a" and skip the percentage.
- **No tool calls in an iteration.** Summary line must render with zeros, not be skipped.
- **`traceLevel = 'none'`** (no streaming). The verbose path is bypassed entirely, so per-iteration files are not produced. Decide whether `progress.txt` still gets a summary line for non-streaming iterations (likely no — there's no `toolCallCounts` source). Document this clearly.
- **Pre-flight failures** (`buildErrorResult` path at `loop.service.ts:300-319`). No iterations were ever executed; the cumulative totals file should NOT be written in this case (an empty totals file is misleading).
- **Early-exit statuses** (`complete`, `blocked`) in `finalize`. The cumulative file should still be written with whatever iterations were completed.
- **Filename collisions / re-runs.** If `progress.txt` already exists and is appended to (current `initProgressFile` behavior at `loop.service.ts:355-360`), per-iteration files from the prior run may exist. Decide between (a) overwrite, (b) suffix with run id, (c) refuse to start — current `progress.txt` append-on-reuse precedent suggests (a) overwrite per-iteration files for the current iteration range.
- **Windows path handling.** All file paths must be derived via `path.parse`/`path.format`, not string concatenation, because the repo's primary working directory is on Windows.
- **More than 99 iterations.** Zero-pad iteration suffix dynamically (`String(i).padStart(String(config.iterations).length, '0')`) so sort order stays lexicographic.
- **Cache fields undefined on `LoopTokenUsage`.** `cacheCreationInputTokens` / `cacheReadInputTokens` are optional (`types.ts:42-44`); the context-used formula must coalesce to 0.
- **`mcp__task-master-ai__*` tool that is also a "write" intent** (e.g., `set_task_status`, `add_task`). Per the chosen classification rule, these are counted under task-master but NOT under write — write is restricted to the four local file tools.
- **Display in `progress.txt` for an iteration that produced no summary line** (e.g., trace level off, or error before any tool calls). Either skip the iteration in `progress.txt` or emit a minimal `Iteration N: <status> (no telemetry)` line — pick one and stay consistent.

## Files Provided by User

- `packages/tm-core/src/modules/loop/services/loop.service.ts` — Primary file. `buildIterationSummaryBlock` at lines 403-452 is the explicit anchor; the flush at lines 874-899, `initProgressFile` at 339-361, `appendFinalSummary` at 363-385, `extractTokenUsage` at 526-568, and `handleStreamEvent`'s tool-call tally at 1043-1086 are the surrounding surfaces this work touches.
- `packages/tm-core/src/modules/loop/types.ts` — Type definitions for `LoopConfig`, `LoopIteration`, `LoopResult`, `LoopTokenUsage`, and `LoopOutputCallbacks.onIterationSummary` that need additive extension.
