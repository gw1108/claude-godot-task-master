---
topic: "Persist `--trace` output to the loop progress file without ANSI color codes"
tags: [design, loop, trace, progress-file, tm-core]
status: complete
research_source: thoughts/shared/research/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md
---

# Design: Persist `--trace` output to the loop progress file (plain text)

## Problem Statement

When `task-master loop --trace` runs, the trace-mode information that is currently chalk-rendered to the terminal (LLM prompt, tool inputs, tool results, per-iteration summary including token usage) must also be appended to the progress log file (`--progress-file`, default `.taskmaster/progress.txt`) as plain UTF-8 text — no ANSI escape sequences and no terminal-only styling. The file must be plain "by construction" (the writer never sees chalk output), in line with the repo rule that all business logic lives in `@tm/core` and presentation concerns (chalk, formatting for the terminal) stay in `apps/cli`.

## Research Source

[thoughts/shared/research/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md](../research/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md)

## Design Decisions

### Architectural seam — where the file writes live

**Choice:** Option (a) from the research — service-internal writes inside `LoopService`, called at the same emit sites as the existing trace callbacks.

**Rationale:** The CLI's chalk callbacks receive *raw* values from the service (strings, JSON objects, structured token-usage). Chalk is never imported in `@tm/core`. By doing the file writes inside `LoopService` (using its existing `await appendFile(..., 'utf-8')` idiom from `initProgressFile`/`appendFinalSummary`), the persisted text is plain by construction — there is no possible code path that lets an ANSI escape sequence reach the writer. This also matches the repo's "business logic in tm-core, presentation in CLI" rule: deciding *to persist* is business logic; only the CLI's chalk styling is presentation. Options (b) "new plain-text sink callback" and (c) "CLI wraps each chalk callback and strips ANSI" both push file I/O into the CLI and re-introduce the chalk/plain duality the requirement explicitly wants to avoid.

### Scope of persisted events

**Choice:** Trace-gated callbacks only — `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary` (including its `tokenUsage` rows). Iteration boundaries are implicit via the `## Iteration N` headers. `onText`, `onToolUse`, `onStderr`, `onError`, and the loop-level `onLoopStart`/`onLoopEnd` markers are **not** persisted; the run header and final summary written by `initProgressFile`/`appendFinalSummary` continue to cover loop-level boundaries.

**Rationale:** The trace flag is the explicit user signal for "I want the deep forensic record." Persisting the four trace-gated callbacks captures the input/output/tool boundary at full fidelity; the existing run header + final summary already cover loop start/end. Stderr is skipped because (i) it is not gated by trace today, and (ii) it is the only raw-text source that could carry ANSI from the Claude CLI subprocess — skipping it eliminates the need to vendor or share an ANSI-strip utility into `@tm/core`. `onError` warnings remain a terminal-only surface for now.

### Truncation policy for persisted payloads

**Choice:** Per-entry cap of **10,000 characters** (10 KB) applied at write time inside the service. CLI display continues to use its own `formatTraceValue` 500/1000-char caps unchanged.

**Rationale:** The file is the forensic source of truth and should hold realistic prompts and tool results, but uncapped persistence creates a real risk of runaway file growth on large file-reads or web-fetch tool results. A 10 KB cap is generous enough to capture typical LLM prompts and tool payloads in full while preventing a single multi-MB tool result from bloating the log. Truncated entries are marked with a `… [truncated, N more chars]` suffix so a reader knows the entry was clipped.

### JSON formatting for tool input/result payloads

**Choice:** Pretty-printed JSON — `JSON.stringify(value, null, 2)` — fenced in a ```` ```json ```` code block.

**Rationale:** The file is markdown-ish already (`# H1` headers, `---` separators) and the framing is human-readable forensic log, not machine-parseable JSONL. Pretty matches the CLI's `formatTraceValue` and the `logger.ts` convention. Fencing inside ```` ```json ```` keeps the JSON visually separated from the surrounding markdown when viewed in any editor that renders markdown, and lets a reader copy-paste valid JSON without stripping leading indentation.

### Concurrency strategy

**Choice:** Per-iteration in-memory buffer, flushed once in the `child.on('close')` handler at `loop.service.ts:697-732` (the same site that already fires `onIterationSummary`). One `await appendFile` per iteration.

**Rationale:** `processBufferedLines` can synchronously fire multiple `onToolInput`/`onToolResult` callbacks within a single `data` event when an assistant turn contains multiple `tool_use` blocks. If each one triggered an independent `await appendFile`, several writes can be scheduled before any resolves, and POSIX `O_APPEND` atomicity is not guaranteed for the multi-KB payloads we now allow. Buffering per iteration and flushing once at close eliminates interleave risk by construction, naturally serializes with the existing `appendFinalSummary` write, and matches the existing "two writes per run" cadence (now: `initProgressFile` → N iteration blocks → `appendFinalSummary`). The file-visibility lag (entries appear at iteration close, not as they happen) is acceptable because the terminal already shows live data and the file is for after-the-fact inspection.

### Failure policy on appendFile errors

**Choice:** Halt the loop. Let the error propagate up through `run()` to the CLI's outer `try/catch` and exit 1 — identical to the existing `initProgressFile` / `appendFinalSummary` failure behavior.

**Rationale:** The codebase's existing two progress-file writes already use this strict policy with no local try/catch. Diverging the trace writes to "warn and continue" would introduce a second policy for the same file and risk silently losing trace data the user explicitly asked for. If the disk is full or permissions are wrong, halting is the honest signal.

### File format inside the progress file

**Choice:** Trace data is written inside the same `---`-delimited run block written by `initProgressFile` and `appendFinalSummary`. Per-iteration grouping uses markdown headers:

```
## Iteration N

### LLM input
```text
<prompt body (truncated at 10 KB)>
```

### Tool: <name> input
```json
<JSON.stringify(input, null, 2), truncated at 10 KB>
```

### Tool: <name> result
```json
<JSON.stringify(result, null, 2), truncated at 10 KB>
```

### Iteration N summary
- Tool calls:
  - <toolName>: <count>
- Tokens:
  - input: 1,234
  - output: 567
  - cache write: 89   (only if present)
  - cache read: 12    (only if present)
  - total: 2,468
- Final result:
```text
<text>
```

---
```

A trailing `---` terminates the iteration block so a mid-run abort does not corrupt the next run's header.

**Rationale:** Matches the existing markdown-ish idiom of the file (`# H1`, `---`, `-` bullets). `## Iteration N` makes a single run easy to scan; `### …` subsections let readers jump to a specific phase. Fenced code blocks preserve formatting and isolate JSON / prompt text from the surrounding markdown.

### Test layer

**Choice:** Unit specs only, added to `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`. Use the existing `vi.mock('node:fs/promises')` + `expect(fsPromises.appendFile).toHaveBeenCalledWith(path, expect.stringContaining(...), 'utf-8')` idiom.

**Rationale:** This matches the existing pattern at `loop.service.spec.ts:775-827`. Coverage targets:
1. `onPromptSent` raw text reaches `appendFile` and contains no ANSI escape bytes.
2. `onToolInput` / `onToolResult` JSON reaches `appendFile` pretty-printed and capped at 10 KB.
3. `onIterationSummary` token-usage rows reach `appendFile` formatted as the spec'd markdown.
4. With multiple `tool_use` blocks in one iteration, exactly one `appendFile` call happens per iteration (validates the buffer-flush model).
5. Truncation marker (`… [truncated, N more chars]`) appears when a payload exceeds 10 KB.

The existing CLI integration test (`apps/cli/tests/integration/commands/loop.command.test.ts`) is not extended — it does not inspect the progress file today and adding content assertions there would duplicate the unit-level checks against a real spawned binary.

## Out of Scope

- Persisting `onStderr` (raw Claude CLI stderr). Avoided to sidestep the need for ANSI stripping inside `@tm/core`.
- Persisting `onError` warnings (malformed stream-json, parse failures). Stays terminal-only.
- Persisting `onText` / `onToolUse` streaming lines. Iteration-summary tool table already conveys the tool-call count; the final assistant text is captured in the iteration summary's "Final result" block.
- A separate `traceFile` / `verboseLogFile` config field. The existing `progressFile` is the single output target.
- Sharing or moving the `stripAnsiCodes` regex into `@tm/core/src/common/`. Not needed for the chosen scope.
- Changes to the CLI's `formatTraceValue` truncation (500/1000). Terminal limits stay terminal limits.
- Changes to `LoopOutputCallbacks` shape. No new callbacks; no new fields.
- Integration tests that spawn the real CLI binary and read back `progress.txt`.

## Open Questions

None. All design axes are resolved.
