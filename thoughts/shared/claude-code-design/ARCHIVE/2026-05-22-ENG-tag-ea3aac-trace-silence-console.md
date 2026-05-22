---
topic: "Silence Console Output for `--tracelevel verbose`/`trace` While Preserving File Writes"
tags: [design, loop, trace, cli, mcp, progress-file]
ticket: tag-ea3aac
status: design-ready
research: thoughts/shared/research/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md
---

# Design: Silence Console Output for `--tracelevel verbose`/`trace` While Preserving File Writes

## Problem Statement

The loop command's `--tracelevel <none|verbose|trace>` flag routes its level-specific output to the terminal via `console.log`/`console.error` callbacks in `apps/cli/src/commands/loop.command.ts`. These per-event console writes slow iterations down measurably. We want both `verbose` and `trace` levels to stop printing their level-specific output to the terminal, while preserving — and, for `verbose`, introducing — progress-file writes so the same information is still recoverable after the run. Always-on output (pre-loop banner, post-loop summary, errors, subprocess stderr passthrough, iteration-start/end separators) must keep behaving exactly as it does today. The MCP loop tool is also in scope: it has no console-equivalent today, but it should gain minimal mid-run visibility via `context.log` and inherit the new file writes for free.

## Research Source

`thoughts/shared/research/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md`

## Design Decisions

### Axis 1 — Verbose per-iteration file content
**Choice:** Summary-only. Verbose writes one `## Iteration N` block per iteration containing the tool-call breakdown, token usage, and `finalResult`. No chunked `onText` capture.

**Rationale:** `buildIterationSummaryBlock` (`loop.service.ts:402–451`) already captures `finalResult` from the stream-json `result` event — that is the complete final assistant message. Chunked `onText` would either require many tiny `appendFile` calls (defeating the speed motivation) or a per-iteration buffer that adds memory pressure for marginal gain over `finalResult`. Tool-call counts come from the existing `toolCallCounts` map; token usage from the existing `extractTokenUsage`. `buildIterationSummaryBlock` already tolerates missing `tokenUsage`/`finalResult`, so no new tolerance code is needed.

Implication: the existing trace-only gate on the iteration-summary push (`loop.service.ts:820–853`) is loosened to `atLeast(level, 'verbose')`. Trace continues to add its richer per-iteration content (LLM input, per-tool input, per-tool result) on top of the verbose summary.

### Axis 2 — Loop-scoped events (`onLoopStart` / `onLoopEnd`)
**Choice:** Skip — no new file writes for these callbacks. The CLI's verbose-mode `[Loop Start]` / `[Loop End]` console lines are removed (they are verbose-tier console writes, which the ticket silences).

**Rationale:** `initProgressFile()` (`loop.service.ts:338–360`) already writes `# Taskmaster Loop Progress` + `# Started: <iso>` + config block at loop start. `appendFinalSummary()` (`loop.service.ts:362–384`) already writes `# Loop Complete: <iso>` + total iterations + tasks completed + final status + total duration at loop end. Adding dedicated `# Loop start` / `# Loop end` blocks would duplicate information already present. The `onLoopStart` / `onLoopEnd` callbacks remain invoked by the service (they are always-on at the service level), but no presenter wires them to a sink.

### Axis 3 — MCP observability
**Choice:** Wire two minimal MCP callbacks: `onError` → `context.log.error` and `onIterationEnd` → `context.log.info` (status line per iteration). Do not wire verbose- or trace-tier callbacks.

**Rationale:** The MCP tool today emits nothing during a run; the only signal a client gets is the deferred JSON blob after `run()` resolves. Adding minimal always-on callbacks gives MCP clients live progress and error visibility without reintroducing the per-token-stream cost that motivates this ticket. Forwarding verbose/trace events to `context.log` would defeat the purpose — each `onText` chunk would cost an MCP protocol message. Verbose/trace content remains file-only, identical between CLI and MCP because the service-side file path depends only on `progressFile` + `level`. Clients that want richer observability read the `progressFile`.

### Axis 4 — Flush boundary for verbose
**Choice:** End-of-iteration flush, matching today's trace flush. One `appendFile` per iteration inside `child.on('close')`. Loss-on-abort (mid-iteration SIGTERM, Ctrl+C, child error before close) is accepted and will be called out in the implementation plan's testing notes.

**Rationale:** Progressive per-event flushing would re-introduce per-event disk I/O, which directly conflicts with the speed motivation. The existing trace flush already accepts loss-on-abort and there has been no reported pain from that boundary. Keeping verbose on the same boundary keeps the buffer-and-flush mechanism uniform; the verbose code path simply joins the existing `traceLines` machinery (renamed conceptually to a per-iteration buffer that is allocated at verbose+).

### Axis 5 — CLI wiring of `onText` / `onToolUse`
**Choice:** Drop both callbacks from `createOutputCallbacks` entirely. `onStderr` stays mounted (subprocess stderr passthrough is always-on per the question file). The `if (verbose)` and `if (trace)` blocks in the CLI are removed in full.

**Rationale:** The service uses optional chaining (`callbacks?.onText`, `callbacks?.onToolUse`) so undefined callbacks are skipped silently. Removing the declarations is cleaner than no-op bodies or conditional mounts that never fire. After this change `createOutputCallbacks` keeps only the always-on bag: `onIterationStart`, `onError`, `onStderr`, `onOutput`, `onIterationEnd`. The CLI surface becomes a faithful renderer of always-on events; file-rich verbose/trace content is the service's responsibility.

## Architecture Implications (derived from the above)

These follow directly from the decisions above and are recorded here so the implementation plan can be written against a fixed shape.

### Service (`packages/tm-core/src/modules/loop/services/loop.service.ts`)

- Allocate the per-iteration buffer at `atLeast(level, 'verbose') && progressFile` (currently `'trace'`). Keep the variable name `traceLines` or rename to something neutral (`iterationFileLines` / `progressLines`); the implementation plan picks.
- Per-iteration push sites change as follows:
  - Iteration header (`## Iteration N`, currently at lines 668–672) — push at verbose+.
  - LLM input block (`### LLM input`, currently at lines 670–672) — keep gated to `atLeast(level, 'trace')`. This corresponds to `onPromptSent`, which is trace-tier.
  - Per-tool input (lines 1010–1013) — keep gated to trace.
  - Per-tool result (lines 1027–1030) — keep gated to trace.
  - Iteration summary (lines 837–843, via `buildIterationSummaryBlock`) — loosen gate to verbose+.
  - Section separator `'---'` — push at verbose+.
- Flush (`appendFile`) site at lines 846–852 remains end-of-iteration, gated on the buffer being non-empty (same as today).
- The trace-tier `onIterationSummary` callback invocation at lines 820–829 is unchanged. The verbose-tier file write happens in addition to (not instead of) the callback. At `level='verbose'` the callback is absent because the CLI no longer wires it; at `level='trace'` the callback fires for the CLI (which has now removed it too) — practically this means `onIterationSummary` may stay invoked by the service but is unused by any presenter. The implementation plan decides whether to keep the callback for future reuse or remove the invocation.

### CLI (`apps/cli/src/commands/loop.command.ts`)

- `createOutputCallbacks(level)` reduces to declaring only: `onIterationStart`, `onError`, `onStderr`, `onOutput`, `onIterationEnd`.
- Remove the `if (verbose)` block (lines ~253–264) entirely — `onLoopStart` / `onLoopEnd` console writes are gone.
- Remove the `if (trace)` block (lines ~266–346) entirely — `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary` are gone from the CLI.
- Remove `onText` and `onToolUse` declarations.
- The `formatTraceValue` helper (lines 351–362) becomes unreferenced and is removed.
- `--tracelevel` flag, parsing, and forwarding to `LoopConfig` are unchanged. All always-on banners (`execute()` lines 124–144, `displayResult()` lines 364–377, `displayCommandHeader`, sandbox-auth writes) are unchanged.

### MCP (`apps/mcp/src/tools/loop/loop.tool.ts`)

- Build a `LoopOutputCallbacks` object with two entries: `onError(message, severity)` forwarding to `log.error` / `log.warn` (or `log.info` for the `info` severity), and `onIterationEnd(iteration)` forwarding to `log.info` with a short status string. Pass it to `tmCore.loop.run({ ..., callbacks })`.
- Zod schema, the deferred JSON return value via `handleApiResult`, and existing `log.info` / `log.error` / `log.debug` at lines 104, 118–120, 128–131 are unchanged.

## Out of Scope

- Always-on CLI banners and footer: `displayCommandHeader`, the pre-loop `Starting Task Master Loop...` block in `execute()`, `displayResult()`, and sandbox-auth writes (`Checking sandbox auth...`, `✓ Sandbox ready`, etc.) are not touched.
- Always-on file writes: `initProgressFile()` header and `appendFinalSummary()` footer formats are not changed.
- Progressive (per-event) file flushing — explicitly rejected in Axis 4.
- Chunked `onText` capture (separate or aggregated) — explicitly rejected in Axis 1.
- Wiring verbose- or trace-tier callbacks to `context.log` on the MCP side — explicitly rejected in Axis 3.
- The MCP tool's Zod schema, the JSON-blob return shape, and the FastMCP logger plumbing (`apps/mcp/src/shared/utils.ts:408–409`) are unchanged.
- The `--tracelevel` CLI flag, the `LoopTraceLevel` type, the `atLeast` predicate, and the streaming-vs-silent service routing (`loop.service.ts:567`) are unchanged.
- Trace's existing per-iteration content (LLM input, per-tool input, per-tool result) — it stays exactly as is. This ticket adds verbose content; it does not refactor trace.
- Adding any new color/chalk usage. The remaining console callbacks keep their current formatting.

## Open Questions

None. All five design axes are resolved.
