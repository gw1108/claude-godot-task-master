---
researcher: gw1108
original_question: "Change task-master trace option to not log to console. Console logging is a little slow so remove it from --trace and --verbose, but keep any file writes."
ticket: tag-ea3aac
---

# Research Question: Silence Console Output for `--tracelevel verbose`/`trace` While Preserving File Writes

## Refined Question
The loop command's `--tracelevel <none|verbose|trace>` flag currently routes its
output to the console via callbacks in `apps/cli/src/commands/loop.command.ts`,
which makes loop iterations slower than necessary. We want both `verbose` and
`trace` levels to stop printing their level-specific output to the terminal,
while preserving (and, for `verbose`, introducing) progress-file writes so the
same information is still recoverable after the run. Output that is not gated
on the trace level — basic loop banners, the final summary, errors, and
subprocess stderr passthrough — should keep behaving exactly as it does today.

Research should determine:
- Exactly which callbacks/console writes are "verbose-level-specific" vs.
  "trace-level-specific" vs. "always-on," so we know what to mute and what to
  leave alone.
- How the current trace-only file-write path in `loop.service.ts`
  (`traceLines` buffer + `appendFile(progressFile, …)`) is structured, so we
  can extend the same mechanism to emit verbose-level events into the
  progress file.
- What the MCP loop tool surfaces today and what an equivalent "console-quiet,
  file-rich" behavior looks like there.

## Research Areas

1. **Verbose- and trace-gated console callbacks (CLI)** — In
   `apps/cli/src/commands/loop.command.ts` `createOutputCallbacks()`
   (lines ~209–349), identify which callbacks are unconditionally wired
   (`onIterationStart`, `onText`, `onToolUse`, `onError`, `onStderr`,
   `onOutput`, `onIterationEnd`) vs. wired only inside the `if (verbose)` and
   `if (trace)` branches (`onLoopStart`, `onLoopEnd`, `onPromptSent`,
   `onToolInput`, `onToolResult`, `onIterationSummary`). Map each callback to
   the exact `console.log`/`console.error`/`process.stderr.write` it performs.
   This produces the definitive list of console writes that must be muted for
   `verbose`/`trace`.

2. **Existing trace progress-file writer (tm-core)** — In
   `packages/tm-core/src/modules/loop/services/loop.service.ts` (around lines
   663–852), document how `traceLines` is allocated only when
   `atLeast(level, 'trace') && progressFile`, what content is pushed into it
   (iteration header, prompt-sent block, tool-input/result entries, summary,
   token usage), and how the buffer is flushed via `appendFile` at iteration
   end. This is the template we will extend to cover verbose-level events.

3. **Verbose-level event surface** — Catalog the events that are currently
   verbose-only on the console (`onText`, `onToolUse`, `onLoopStart`,
   `onLoopEnd`) and decide how each maps into a progress-file record. Of
   particular interest: `onText` may produce large volumes of streamed text
   that the file format needs to absorb without breaking the existing trace
   sections; `onLoopStart`/`onLoopEnd` are loop-scoped (not per-iteration), so
   they need a write location outside the iteration buffer.

4. **Trace-level token usage and summary visibility** — `onIterationSummary`
   currently prints token usage and tool-call counts to the console in trace
   mode. Confirm whether the same data already lands in the progress file
   today (via `traceLines.push(...)` in the service), or whether some pieces
   only exist on the console. If anything is console-only today, it needs to
   be added to the file output so muting the console does not lose
   information.

5. **MCP loop surface** — Inspect the MCP loop tool (search for `loop` in
   `apps/mcp` and any tool wiring under `mcp__task-master-ai__loop`) to
   determine: (a) does it accept `tracelevel`? (b) does it install its own
   `LoopOutputCallbacks` that write to a transport that is the moral
   equivalent of "the console" (stdout/log lines streamed back to the MCP
   client)? (c) what file-write expectations should mirror the CLI change?

6. **Always-on console output (out of scope to silence, in scope to confirm)** —
   Verify the writes that must remain untouched: the `Starting Task Master
   Loop...` / `Preset:` / `Max iterations:` banner block in `execute()`
   (~lines 124–144), `displayResult()` (~lines 364–377), and the
   unconditional `onError`/`onStderr`/`onIterationStart`/`onIterationEnd`
   callbacks. The research should explicitly enumerate these so the
   implementation plan can call them out as "do not touch."

## Clarifications Gathered
- **Q:** The flag is `--tracelevel <none|verbose|trace>` — does "--trace and --verbose" refer to the `verbose` and `trace` levels of that single flag?
  **A:** Yes, both refer to that single `--tracelevel` flag's `verbose` and `trace` levels.
- **Q:** Should all callbacks fall silent for verbose/trace (including iteration headers, `onText`, `onToolUse`, `onError`, `onLoopStart/End`), or only the level-specific ones?
  **A:** Researcher's call — determine which callbacks are verbose/trace-level-specific (currently mounted only inside the `if (verbose)` / `if (trace)` branches) and silence those; leave non-level-specific callbacks alone.
- **Q:** Today `verbose` writes nothing to the progress file — only `trace` does. After removing its console output, should `verbose` start writing to the file too?
  **A:** Yes. Rework `verbose` so its events are emitted to the progress file so the level still does something.
- **Q:** Should error output (`onError`, `onStderr`) and the unconditional banners (`Starting Task Master Loop...`, `Loop Complete` summary) be removed from console too?
  **A:** No — keep anything that is not verbose- or trace-specific exactly as it is today.
- **Q:** Is the MCP loop tool in scope, or CLI-only?
  **A:** Both MCP and CLI are in scope.

## Edge Cases to Address
- `onText` can stream very large bodies of text from the model; the verbose
  file format needs to capture these without corrupting existing trace
  sections or producing unreadably long single-line entries.
- `onLoopStart` / `onLoopEnd` fire outside any single iteration — the existing
  per-iteration `traceLines` buffer cannot hold them. Identify where these
  one-shot loop-scoped writes should land in the progress file (header
  section? footer? a top-level "Loop" section?).
- `onIterationSummary` includes optional `tokenUsage` (absent on older Claude
  CLI versions or aborted runs). The file writer must tolerate the missing
  field without printing `undefined`.
- The progress file is appended to across iterations; if a run is aborted
  mid-iteration, the verbose write for that iteration may be partial. Confirm
  the existing flush boundary (end of iteration) is acceptable for verbose
  too, or document the loss-on-abort behavior.
- Trace mode already includes verbose's events implicitly (since
  `verbose = level === 'verbose' || level === 'trace'`). The implementation
  must avoid double-writing verbose events when level is `trace`.
- MCP transport may already buffer output in memory before sending — silencing
  "console" there might mean dropping a callback that an MCP client relies on.
  Research should clarify whether the MCP loop is expected to stream events to
  the client at all today.

## Files Provided by User
- _(none — question was self-contained; investigation will pivot off the loop
  command and service files identified above.)_
