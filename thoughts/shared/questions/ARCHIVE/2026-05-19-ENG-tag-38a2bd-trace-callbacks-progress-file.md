---
original_question: "Hook the trace callbacks to also append the strings they emit into the progress file when using the --trace option with task-master loop. Make sure it does not write chalk's ANSI color codes into the plain txt log file and it only writes appropriate text."
ticket: tag-38a2bd
---

# Research Question: Persist `--trace` output to the loop progress file without ANSI color codes

## Refined Question

When `task-master loop --trace` runs, the same trace-mode information that is currently rendered to the terminal via chalk-decorated callbacks (LLM prompt, tool inputs, tool results, iteration summary including token usage) should also be appended to the progress log file (`--progress-file`, default `.taskmaster/progress.txt`) as plain text — no ANSI escape sequences and no terminal-only chalk styling. Investigate the current trace callback wiring, the existing progress-file write path in `@tm/core`, and identify the right architectural seam to add file persistence such that the file always receives clean text by construction (not by post-hoc stripping), in line with the repo rule that all business logic lives in `@tm/core` and presentation concerns (chalk, formatting for the terminal) stay in `apps/cli`.

## Research Areas

1. **Trace callback inventory & emit points** — Enumerate every callback the CLI registers in `LoopCommand.createOutputCallbacks` (`apps/cli/src/commands/loop.command.ts`) and where each is invoked inside `LoopService` (`packages/tm-core/src/modules/loop/services/loop.service.ts`, especially `executeVerboseIteration`, `handleStreamEvent`, and the trace-only branch). Distinguish: trace-only (`onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`) vs. streaming-or-trace (`onText`, `onToolUse`) vs. all-modes (`onIterationStart`, `onIterationEnd`, `onLoopStart`, `onLoopEnd`, `onError`, `onStderr`, `onOutput`). Document what raw value each carries before chalk is applied.

2. **Architectural placement of the file writes** — Compare options against the repo's "business logic in `@tm/core` only" rule:
   - (a) Service writes raw payloads directly to the progress file when `trace=true` (no chalk ever in scope).
   - (b) A new plain-text sink callback (e.g. `onTraceLog(line)`) implemented in CLI alongside the existing chalk ones.
   - (c) CLI wraps each chalk callback and writes a stripped copy to the file.
   Recommend the option that best preserves separation of concerns and avoids ANSI ever entering the writer.

3. **ANSI handling strategy** — If approach (a) is selected, confirm that ANSI is impossible by construction. If (b)/(c), evaluate `strip-ansi` (already in the dep tree?) vs. an inline regex. Specifically investigate whether `onStderr` text from the Claude CLI itself can contain ANSI that must also be stripped when persisted.

4. **Log format inside the progress file** — Map out how trace entries should render in the existing markdown-ish progress file (which already uses `# headers` and `---` separators via `initProgressFile`/`appendFinalSummary`). Cover: per-iteration headings, prefixes like `[trace] LLM input (iteration N):`, code-fence wrapping of long blobs, formatting of structured data (tool inputs/results, token-usage table), and a truncation policy. The CLI today truncates inputs/results to 500/1000 chars via `formatTraceValue` — decide whether the file gets the same truncation or the untruncated payload (this is the user's "appropriate text" — what's appropriate for a forensic log?).

5. **Ordering, concurrency, and failure mode** — Multiple `appendFile` calls invoked from synchronous callback contexts can interleave or fire-and-forget. Decide between a serialized write queue, per-iteration batching, or relying on append atomicity for short writes. Define the failure policy: `appendFile` errors → halt the loop, warn via `onError` and continue, or silently swallow.

6. **Test coverage** — Inspect existing tests (`packages/tm-core/src/modules/loop/services/loop.service.spec.ts`, `apps/cli/src/commands/loop.command.spec.ts`, `apps/cli/tests/integration/commands/loop.command.test.ts`) for the current progress-file contract. Plan new spec coverage that verifies: trace strings appear in the file when `--trace` is on, no ANSI escapes anywhere in the file content (assert via regex), non-trace runs leave the file unchanged, and the progress file remains valid (existing header + final-summary blocks still produced correctly).

## Clarifications Gathered

- **Q:** Should only the trace-only callbacks be persisted, or also `onText`/`onToolUse`/`onStderr`/iteration markers when `--trace` is on?
  **A:** not specified
- **Q:** Should `--verbose` (without `--trace`) also write anything new to the file, or is this strictly `--trace`-only?
  **A:** not specified
- **Q:** Preferred architecture: (a) service writes raw values directly, (b) new plain-text sink callback, or (c) CLI strips ANSI from its decorated strings?
  **A:** not specified
- **Q:** If stripping is required, prefer the `strip-ansi` package or a small inline regex?
  **A:** not specified
- **Q:** Should `onStderr` (which may carry ANSI from Claude CLI) be persisted, and if so, stripped?
  **A:** not specified
- **Q:** Structured per-iteration headers vs. inline `[trace] …` prefixes for trace entries?
  **A:** not specified
- **Q:** Full content or the existing 500/1000-char truncation for long prompts, tool inputs, and tool results?
  **A:** not specified
- **Q:** Pretty JSON vs. one-line stringified for tool input/result payloads?
  **A:** not specified
- **Q:** Include the token-usage block from `onIterationSummary` in the file?
  **A:** not specified
- **Q:** On `appendFile` failure: halt, warn-and-continue, or silently skip?
  **A:** not specified
- **Q:** Serialize writes via a queue or accept potential interleave with `console.log` order?
  **A:** not specified
- **Q:** Must this work the same for `progressFile` paths outside `.taskmaster/` (absolute paths)?
  **A:** not specified
- **Q:** Should trace data live inside the same `---`-delimited run section that `initProgressFile`/`appendFinalSummary` produce, or in its own section?
  **A:** not specified
- **Q:** Test location: unit specs hitting a tmpdir, or integration tests?
  **A:** not specified

## Edge Cases to Address

- Chalk-decorated strings would carry ANSI escape sequences (`[...m`) into the file; verify the chosen design makes this impossible — not merely improbable.
- `onStderr` may receive ANSI emitted by the Claude CLI itself (not from chalk in our codebase) — needs to be considered separately if stderr is persisted.
- Very large LLM prompts and tool result payloads (can be many KB) — confirm policy for truncation vs. full capture in the file.
- Concurrent async appends from callbacks fired in tight succession (multiple tool_use blocks within a single assistant turn) may interleave bytes; need ordering guarantees or explicit acceptance of interleave.
- `appendFile` failures mid-run (disk full, permission denied, path outside `.taskmaster/`) — define behavior.
- Sandbox mode is incompatible with `--trace` and short-circuits early in `LoopService.run`; ensure no file writes occur on that error path beyond the existing header.
- Non-JSON or malformed stream-json lines are already logged via `reportError(..., 'warning')` — decide whether those warnings are also persisted.
- Trace mode runs that abort or crash mid-iteration must not leave the progress file in a partially-written, malformed state that breaks the final-summary append.
- Existing behavior already appends a header on every run (`initProgressFile` appends rather than overwrites) — confirm trace data is grouped under the current run's header, not bleeding into a prior run's section.

## Files Provided by User

- `.pipeline_state_tag-38a2bd.json` — Pipeline state file naming this task; its `tag-38a2bd` identifier is required in the output filename.
