---
topic: "Silence Console Output for `--tracelevel verbose`/`trace` While Preserving File Writes"
tags: [research, codebase, loop, trace, cli, mcp, progress-file]
status: complete
source_question: thoughts/shared/questions/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md
---

# Research: Silence Console Output for `--tracelevel verbose`/`trace` While Preserving File Writes

## Research Question
The loop command's `--tracelevel <none|verbose|trace>` flag currently routes its
output to the console via callbacks in `apps/cli/src/commands/loop.command.ts`.
We want both `verbose` and `trace` levels to stop printing their level-specific
output to the terminal, while preserving (and, for `verbose`, introducing)
progress-file writes so the same information is still recoverable after the
run. Always-on output (basic loop banners, the final summary, errors, and
subprocess stderr passthrough) should keep behaving exactly as it does today.

## Summary

The trace-level surface is split into three concentric tiers driven by
`atLeast(level, threshold)` (`packages/tm-core/src/modules/loop/services/trace-level.ts`):

- **Always-on (NORMAL+)** — fired regardless of level: `onIterationStart`,
  `onError`, `onIterationEnd`, `onLoopStart`/`onLoopEnd` (the service invokes
  these without an `atLeast` gate, even though the CLI today only WIRES
  `onLoopStart`/`onLoopEnd` under `if (verbose)`). `onOutput` is reachable only
  in the silent `spawnSync` path (i.e. `traceLevel='none'`).
- **VERBOSE-tier** — reachable only when `atLeast(level, 'verbose')`, because the
  service routes to `executeVerboseIteration` and a stream-json pipe:
  `onText`, `onToolUse`, `onStderr`.
- **TRACE-tier** — gated explicitly by `atLeast(level, 'trace')` inside the
  service: `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`.

The CLI wires the VERBOSE-tier callbacks (`onText`, `onToolUse`) unconditionally
inside `createOutputCallbacks` even at `none` (they are only reachable when the
service is in the verbose path, so they are functionally verbose-gated). It then
adds `onLoopStart`/`onLoopEnd` inside `if (verbose)`, and the TRACE-tier
callbacks inside `if (trace)`. Every level-specific callback writes via
`console.log` / `console.error`; nothing in the CLI writes to a file.

The service today owns one file-write path: a per-iteration `traceLines: string[]`
buffer allocated only when `atLeast(level, 'trace') && progressFile`. It captures
the iteration header, the LLM input (prompt), tool inputs, tool results, and an
aggregated iteration-summary block (tool calls, tokens, final result). The
buffer is flushed via `appendFile(progressFile, ...)` inside `child.on('close')`
at end of each iteration. There are NO file writes for `verbose` today — that
level is entirely console-only.

The MCP loop tool (`apps/mcp/src/tools/loop/loop.tool.ts`) exposes `traceLevel`
in its Zod schema and forwards it to `tmCore.loop.run(...)`, but it installs
**zero** `LoopOutputCallbacks`. The trace-tier file-write path still fires
(because it lives inside the service and only depends on `progressFile` +
`level`), but every verbose/trace callback goes nowhere. The MCP tool returns
the full `LoopResult` as a single JSON-in-text blob after `run()` resolves; it
emits nothing to the MCP client during the run.

## Detailed Findings

### 1. Verbose- and trace-gated console callbacks (CLI)

File: `apps/cli/src/commands/loop.command.ts`

The `createOutputCallbacks(level)` factory (lines 209–349) constructs the
callback bag in three blocks:

**Block A — wired unconditionally** (lines 212–249):

| Callback | Console write | Lines |
|---|---|---|
| `onIterationStart(iteration, total)` | `console.log()` + `console.log(chalk.cyan('━━━ Iteration N of M ━━━'))` | 213–216 |
| `onText(text)` | `console.log(text)` — streams Claude's assistant text | 217–219 |
| `onToolUse(toolName)` | `console.log(chalk.dim(\`  → ${toolName}\`))` | 220–222 |
| `onError(message, severity)` | `console.error(chalk.yellow/red('[Loop Warning/Error] ...'))` | 223–229 |
| `onStderr(iteration, text)` | `process.stderr.write(chalk.dim('[Iteration N] ') + text)` | 230–232 |
| `onOutput(output)` | `console.log(output)` | 233–235 |
| `onIterationEnd(iteration)` | `console.log(chalk.green/red/yellow('  Iteration N completed: status'))` | 236–248 |

Even though `onText` and `onToolUse` are declared without an `if (verbose)`
gate here, the service only invokes them inside `executeVerboseIteration`
(line 567 in `loop.service.ts` routes to that path on
`atLeast(level, 'verbose')`). At `level='none'` the service takes the silent
`spawnSync` branch and these callbacks are never called. So `onText` and
`onToolUse` are **functionally verbose-tier console writes** even though the
CLI declares them unconditionally.

`onStderr` is also functionally verbose-tier for the same reason — the silent
branch uses `stdio: ['inherit', 'pipe', 'pipe']` and only invokes
`onOutput(stdout+stderr)`, not `onStderr`.

`onOutput` is the inverse: it is reached only in the silent (`level='none'`)
branch, at `loop.service.ts:607`.

**Block B — wired only inside `if (verbose)`** (lines 253–264):

| Callback | Console write |
|---|---|
| `onLoopStart(startedAt)` | `console.log(chalk.dim('[Loop Start] <iso>'))` |
| `onLoopEnd(finishedAt, totalDuration)` | `console.log(chalk.dim('[Loop End] <iso> (formatted-duration)'))` |

**Block C — wired only inside `if (trace)`** (lines 266–346):

| Callback | Console writes |
|---|---|
| `onPromptSent(iteration, prompt)` | `console.log('')`, `console.log(chalk.magenta('[trace] LLM input (iteration N):'))`, `console.log(chalk.dim(prompt))`, `console.log('')` |
| `onToolInput(toolName, input)` | `console.log(chalk.magenta('[trace] <tool> input:'), chalk.dim(formatTraceValue(input)))` |
| `onToolResult(toolName, result)` | `console.log(chalk.magenta('[trace] <tool> result:'), chalk.dim(formatTraceValue(result)))` |
| `onIterationSummary(iteration, summary)` | Multiple `console.log` calls: header, tool-call list, token-usage breakdown (input/output/cache write/cache read/total), final result block. See lines 305–344 for exact structure. |

These three blocks are the definitive list. Block B + Block C are the writes
that must be muted for `--tracelevel verbose` and `--tracelevel trace`. Block A
must be left alone (per the question file's "always-on" decision).

Caveat: `onText`, `onToolUse`, `onStderr` are in Block A textually but
functionally only fire when `level ≥ 'verbose'`. The question file's stated
intent is "silence level-specific output" — if the goal is for `verbose` to
write nothing to the console, these three are part of "verbose-level-specific
console writes" even though they are mounted unconditionally in the CLI today.
The implementation plan must decide whether to (a) leave them mounted and rely
on the service never invoking them at `level='none'`, then drop their bodies in
verbose/trace mode, or (b) mount them only at `level='none'` (where they will
never fire anyway).

### 2. Existing trace progress-file writer (tm-core)

File: `packages/tm-core/src/modules/loop/services/loop.service.ts`

The per-iteration trace buffer is allocated at line 665:

```typescript
const traceLines: string[] | undefined =
    atLeast(level, 'trace') && progressFile ? [] : undefined;
```

This buffer is **trace-only** today; `verbose` skips it entirely.

#### Writes into `traceLines`

| Site | Lines | Content |
|---|---|---|
| Iteration header | 669–672 | `## Iteration N` and `### LLM input\n\`\`\`text\n<truncated prompt>\n\`\`\`` |
| Per tool-input | 1010–1013 | `### Tool: <name> input\n` + `formatJsonBlockForFile(block.input)` (a ```json fenced block, truncated to 10 000 chars) |
| Per tool-result | 1027–1030 | `### Tool: <label> result\n` + `formatJsonBlockForFile(block.content)` |
| Aggregated iteration summary | 837–843 | `buildIterationSummaryBlock(iterationNum, { toolCalls, finalResult, tokenUsage })` — markdown list with tool-call counts, token breakdown (input/output/cache write/cache read/total), and a truncated ```text fenced "Final result" block. See lines 402–451. |
| Section separator | 844 | `'---'` |

#### Flush

Lines 846–852, inside `child.on('close')`:

```typescript
appendFile(
    progressFile,
    '\n' + traceLines.join('\n\n') + '\n',
    'utf-8'
).catch((err: unknown) => {
    rejectOnce(err);
});
```

`appendFile` is called once per iteration at iteration end. A flush failure
rejects the iteration's promise, which propagates out of `run()` as an
unhandled error.

#### Supporting helpers (already present, reusable for verbose)

- `truncateForFile(text, maxChars=10_000)` — lines 386–390. Appends a
  `… [truncated, N more chars]` suffix.
- `formatJsonBlockForFile(value)` — lines 392–400. Pretty-prints to JSON,
  wraps in `\`\`\`json` fence, runs through `truncateForFile`.
- `buildIterationSummaryBlock(iterationNum, summary)` — lines 402–451. Already
  tolerates missing `tokenUsage` (gated by `if (summary.tokenUsage)`) and
  missing `finalResult` (gated by `if (summary.finalResult)`).

#### Header/footer file writes (already always-on)

These run regardless of `traceLevel`:

- `initProgressFile(config, startedAt)` — lines 338–360. Writes a banner block:
  `# Taskmaster Loop Progress`, `# Started: <iso>`, optional `# Brief:`,
  `# Preset:`, `# Max Iterations:`, optional `# Tag:`, then `---`.
- `appendFinalSummary(file, result)` — lines 362–384. Writes a `# Loop Complete: <iso>` footer block with total iterations, tasks completed, final status,
  total duration in ms.

### 3. Verbose-level event surface

Today, when `level='verbose'`, the service invokes the following callbacks but
the CLI is the only sink and writes only to the console (no file):

| Event source | Callback | Notes |
|---|---|---|
| Service routes to verbose path at line 567; spawn stream-json pipe | — | Triggers everything below |
| Per stream-json `assistant` event with `text` block | `onText(block.text)` (line 1000) | Can be large — partial assistant messages stream in chunks |
| Per stream-json `assistant` event with `tool_use` block | `onToolUse(block.name)` (line 1002) | Just the tool name; no input |
| Stderr from child process | `onStderr(iterationNum, stderrText)` (line 781) | Functionally verbose-tier (the silent path doesn't invoke it) |
| `run()` start (line 197) | `onLoopStart(startedAt, totalIterations)` | One-shot, loop-scoped; CLI wires it only inside `if (verbose)` |
| `finalize()` (line 291) and `buildErrorResult()` (line 307) | `onLoopEnd(finishedAt, totalDuration)` | One-shot, loop-scoped |

#### File-write surface implications

- `onText` is **per-chunk streamed text**. There is no current file capture
  for assistant text. To preserve verbose output to a file, this needs a sink
  that can absorb multiple writes per iteration. Two natural shapes the
  existing code suggests:
  - Aggregate per-iteration into a buffer (similar to `traceLines`) and flush
    at iteration end. This avoids many tiny `appendFile` calls.
  - Append immediately on each call. Higher I/O cost, but live tail-able.
  The current `traceLines` pattern uses the first shape. The verbose section
  would need a separate slot or a unified-with-trace buffer.
- `onToolUse` is small per-event but frequent.
- `onLoopStart`/`onLoopEnd` are loop-scoped, not per-iteration. The existing
  `traceLines` buffer is allocated INSIDE `executeVerboseIteration` and is
  per-iteration — it cannot hold these one-shot events. The closest existing
  precedent is `initProgressFile()` (called once before the loop at
  `run()` line 193) and `appendFinalSummary()` (called once in `finalize`
  line 290). New verbose loop-scoped writes would slot alongside these:
  before `initProgressFile`'s footer `---` line, or after the start banner.

### 4. Trace-level token usage and summary visibility

`onIterationSummary` is invoked at `loop.service.ts:820–829`:

```typescript
if (atLeast(level, 'trace') && callbacks?.onIterationSummary) {
    const toolCalls = Array.from(toolCallCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    callbacks.onIterationSummary(iterationNum, {
        toolCalls,
        finalResult: finalResult || undefined,
        ...(tokenUsage && { tokenUsage })
    });
}
```

Immediately after (lines 831–853), the same data is written to the progress
file via `buildIterationSummaryBlock`:

```typescript
if (traceLines && progressFile) {
    const toolCalls = Array.from(toolCallCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    traceLines.push(
        this.buildIterationSummaryBlock(iterationNum, {
            toolCalls,
            finalResult: finalResult || undefined,
            ...(tokenUsage && { tokenUsage })
        })
    );
    traceLines.push('---');

    appendFile(progressFile, '\n' + traceLines.join('\n\n') + '\n', 'utf-8')
        .catch((err: unknown) => { rejectOnce(err); });
}
```

**Verdict: trace iteration-summary content is already fully duplicated to the
file.** The console block in `loop.command.ts:291–345` and the file block built
by `buildIterationSummaryBlock` (`loop.service.ts:402–451`) emit the same
three pieces of information:

- Tool-call breakdown (name + count, sorted descending)
- Token usage (input, output, optional cache-write, optional cache-read,
  total) — both sides correctly handle `tokenUsage === undefined`
- Final result text

The CLI rendering uses `toLocaleString()` for token formatting and `chalk`
coloring; the file uses plain text but the same `toLocaleString()` formatting.
Nothing on the trace iteration-summary path is console-only — silencing the
console block does not lose information.

The `onPromptSent`, `onToolInput`, and `onToolResult` callbacks are likewise
mirrored: the file gets them via the `### LLM input`, `### Tool: <name> input`,
and `### Tool: <name> result` blocks (lines 670–672, 1011–1013, 1028–1030).

### 5. MCP loop surface

File: `apps/mcp/src/tools/loop/loop.tool.ts`

**Schema (lines 11–71)** — `traceLevel` is exposed as a Zod enum with the same
choices as the CLI:

```typescript
traceLevel: z
    .enum(['none', 'verbose', 'trace'])
    .optional()
    .default('none')
    .describe(
        'Trace verbosity: "none" (default) | "verbose" (streaming output) | "trace" (full tool call detail).'
    ),
```

Other relevant fields: `progressFile` (string, optional — passes through),
`includeOutput`, `sessionPersistence`, `prompt`, `iterations`, `sleepSeconds`,
`sandbox`, `tag`, `projectRoot` (required).

**Call site (lines 106–116)** — the tool builds a `LoopConfig` literal and
calls `tmCore.loop.run(...)` with **no `callbacks` field**:

```typescript
const result = await tmCore.loop.run({
    prompt,
    iterations,
    sleepSeconds,
    sandbox,
    traceLevel,
    includeOutput,
    sessionPersistence,
    progressFile,
    tag
});
```

**Logging (lines 104, 118–120, 128–131)** — only the FastMCP structured logger
is used; no `console.*` or `process.stderr.write`:

```typescript
log.info(`Starting loop in ${projectRoot}`);                       // 104
// after run() resolves:
log.info(
    `Loop finished: ${result.finalStatus}, ${result.tasksCompleted} tasks completed`
);                                                                 // 118–120
// in catch:
log.error(`Error in loop: ${error.message}`);                      // 128
log.debug(error.stack);                                            // 130
```

The `log` object is `context.log` from FastMCP — it forwards to the MCP
protocol logger, not stdout. The same `context.log` is also wired into the
tmCore logger via `loggerConfig: { mcpMode: true, logCallback: context.log }`
at `apps/mcp/src/shared/utils.ts:408–409`.

**Return value (lines 122–126)** — uses `handleApiResult`, which produces a
single MCP `ContentResult` text blob containing
`JSON.stringify({ data: result, version, tag }, null, 2)`. On error it returns
`{ content: [...], isError: true }`.

**MCP findings versus CLI:**

| Concern | CLI | MCP |
|---|---|---|
| Exposes `tracelevel` / `traceLevel`? | Yes (`--tracelevel`) | Yes (`traceLevel`) |
| Installs `LoopOutputCallbacks`? | Yes — Block A always, Block B if verbose, Block C if trace | **No** — zero callbacks installed |
| Writes anything to console / stdout / stderr? | Yes (banners + Block A/B/C) | No |
| Writes anything to progress file? | Indirectly — service writes when `level='trace'` | Indirectly — same service-side path; works because it depends only on `progressFile` + `level` |
| Streams progress to the consumer mid-run? | Yes (console writes happen as events fire) | No — single JSON blob after `run()` resolves |

There is no concept of "console" inside the MCP tool that needs silencing.
Silence is the default state. The interesting MCP-side asymmetry for this
ticket is that **the MCP tool today gets nothing from the verbose tier** —
not in stdout, not in the file (today), and not in the returned blob (the
returned blob contains only `LoopResult`, not Claude's streamed text). After
this ticket, the file becomes the only verbose-tier sink for both CLI and MCP.

### 6. Always-on console output (out of scope to silence)

File: `apps/cli/src/commands/loop.command.ts`

**In `execute()`, lines 124–144** (the pre-loop banner):

```typescript
console.log(chalk.cyan('Starting Task Master Loop...'));
console.log(chalk.dim(`Preset: ${prompt}`));
console.log(chalk.dim(`Max iterations: ${iterations}`));
console.log(chalk.dim(`Mode: ${options.sandbox ? 'Docker sandbox' : 'Claude CLI'}`));
// Optional "Next task to work on:" block for default preset (lines 132–143)
console.log();
```

Also at line 114: `displayCommandHeader(this.tmCore, { tag, storageType })`
(another console writer, called before the banner).

Sandbox-auth writes (lines 174–197, only reached on `--sandbox`):
`Checking sandbox auth...`, `✓ Sandbox ready`, `Sandbox needs authentication. ...`,
`Please complete auth, then Ctrl+C to continue.`, `✓ Auth complete`.

**In `displayResult()`, lines 364–377** (the post-loop summary):

```typescript
console.log();
console.log(chalk.bold('Loop Complete'));
console.log(chalk.dim('─'.repeat(40)));
console.log(`Total iterations: ${result.totalIterations}`);
console.log(`Tasks completed: ${result.tasksCompleted}`);
console.log(`Final status: ${this.formatStatus(result.finalStatus)}`);
if (typeof result.totalDuration === 'number') {
    console.log(`Total time: ${this.formatDuration(result.totalDuration)}`);
}
if (result.errorMessage) {
    console.log(chalk.red(`Error: ${result.errorMessage}`));
}
```

**In `createOutputCallbacks` (Block A above)**, the unconditional callbacks at
lines 213–248 must remain as console writers. Per the question file's stated
intent, these are the always-on writes that should not change. They cover:

- `onIterationStart` — the `━━━ Iteration N of M ━━━` separator
- `onError` — `[Loop Error]` / `[Loop Warning]` messages
- `onStderr` — `[Iteration N] <stderr text>` passthrough
- `onIterationEnd` — `Iteration N completed: <status>` line
- `onOutput` — only fired in `level='none'`; the silent-path's stdout dump

As noted in §1, `onText` and `onToolUse` are textually in Block A but
functionally verbose-tier — implementation needs to decide whether they count
as "always-on" (CLI declaration) or "level-specific" (effective behavior).

## Edge Cases Addressed

- **Large `onText` payloads.** `onText` is called per-chunk (the stream-json
  format streams partial assistant text); a single iteration can generate many
  calls. The existing `truncateForFile` helper (`loop.service.ts:386–390`)
  caps individual entries at 10 000 chars with a `… [truncated, N more chars]`
  suffix. The `traceLines` buffer accumulates per iteration and flushes once at
  end, so the per-iteration cost is one `appendFile` call regardless of chunk
  count. For verbose, a similar aggregate-then-flush pattern fits the existing
  shape. A separate decision: whether to concatenate all `onText` chunks into
  a single "LLM output" block per iteration, or write each chunk as its own
  block — the existing trace path captures the LLM *input* once per iteration
  (line 670) but does not capture LLM *output* text chunks at all, only the
  final `result` event (line 722). So verbose has nowhere to inherit chunk-by-
  chunk concatenation from; the implementation has a clean choice.

- **`onLoopStart` / `onLoopEnd` are loop-scoped, not iteration-scoped.** The
  per-iteration `traceLines` buffer at `loop.service.ts:665` is allocated
  inside `executeVerboseIteration` — it does not exist when `onLoopStart`
  fires (line 197 in `run()`, before any iteration), nor when `onLoopEnd`
  fires (line 291 in `finalize`, after all iterations). The existing file-
  write hooks at loop scope are `initProgressFile()` (called at line 193 in
  `run()`) and `appendFinalSummary()` (called at line 290 in `finalize`).
  These are the natural insertion points for verbose loop-scoped file writes.

- **Missing `tokenUsage`.** Both the console and file paths already tolerate
  this. CLI: `if (summary.tokenUsage) { ... }` at `loop.command.ts:316`. File:
  `if (summary.tokenUsage) { ... }` at `loop.service.ts:425` inside
  `buildIterationSummaryBlock`. `extractTokenUsage` at `loop.service.ts:491–533`
  returns `undefined` when every count is missing/zero (older Claude CLI
  versions, aborted runs). No new code is needed for this tolerance — the
  pattern is already there.

- **Abort mid-iteration.** The trace flush at `loop.service.ts:846–852` runs
  inside `child.on('close')`. If a run is aborted mid-iteration (e.g. SIGTERM,
  user Ctrl+C, child error before close), the buffer never flushes — the
  iteration's content is lost. There is no progressive write today. For
  verbose, inheriting this same end-of-iteration flush boundary is the
  simplest extension. If progressive flushing is wanted, the iteration handler
  in `executeVerboseIteration` (lines 643–865) is the only site that would
  need to call `appendFile` on each event rather than buffering.

- **Avoiding double-writes at `level='trace'`.** Because
  `atLeast('trace', 'verbose') === true`, any verbose-tier file write code
  added inside `handleStreamEvent` or `executeVerboseIteration` will also fire
  when `level='trace'`. The existing trace blocks (LLM input header line 670,
  tool-input line 1010, tool-result line 1027) gate themselves with
  `atLeast(level, 'trace')`. New verbose code that runs unconditionally inside
  `executeVerboseIteration` (which is only reached when `atLeast(level,
  'verbose')`) would not need an extra gate — but it MUST not duplicate
  events that trace already writes. For example, trace already captures the
  LLM input at line 670; a verbose-tier write of the same input would
  double-write at `level='trace'`. The clean separation today is:
  - Trace writes: LLM input (prompt), per-tool inputs, per-tool results,
    aggregated summary, separator.
  - Verbose writes (after this ticket): whatever maps to `onText`,
    `onToolUse`, `onLoopStart`, `onLoopEnd` — none of which trace currently
    captures.

  So the natural split is: verbose adds NEW sections covering its unique
  events, trace continues to write its existing sections, and they coexist
  without overlap.

- **MCP "console" semantics.** The MCP loop tool does not write to a console-
  equivalent sink at all today. It installs no `LoopOutputCallbacks` (so no
  per-event side effects), and the only output channel is the deferred
  `LoopResult` JSON blob returned by `handleApiResult`. There is no streaming
  to the MCP client, no `reportProgress`, no `sendNotification`. The "silence
  the console" change has no MCP-side console to silence. The MCP-side change
  set is bounded by: (a) confirming that the service-internal verbose file-
  write path the CLI gets will also fire under MCP (it will, because it
  depends only on `progressFile` + `level`, not on `callbacks`); and (b)
  optionally adding callbacks for MCP-side observability — out of scope unless
  the implementation plan explicitly adds it.

## Code References

### CLI
- `apps/cli/src/commands/loop.command.ts:42–87` — `LoopCommand` constructor; `--tracelevel` option declaration at lines 70–77.
- `apps/cli/src/commands/loop.command.ts:89–171` — `execute()`; pre-loop banner at 124–144, `LoopConfig` build at 150–163.
- `apps/cli/src/commands/loop.command.ts:124–144` — Always-on pre-loop banner (`Starting Task Master Loop...`, `Preset:`, `Max iterations:`, `Mode:`, optional next-task line).
- `apps/cli/src/commands/loop.command.ts:209–349` — `createOutputCallbacks(level)`.
  - Lines 212–249 — Block A (unconditional declarations).
  - Lines 253–264 — Block B (`if (verbose)` — `onLoopStart`, `onLoopEnd`).
  - Lines 266–346 — Block C (`if (trace)` — `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`).
- `apps/cli/src/commands/loop.command.ts:351–362` — `formatTraceValue(value)` helper (500-char string cap / 1000-char JSON cap, `…` suffix).
- `apps/cli/src/commands/loop.command.ts:364–377` — `displayResult()` always-on post-loop summary.
- `apps/cli/src/commands/loop.command.ts:384–399` — `formatDuration(ms)` helper used by `onLoopEnd` and `displayResult`.

### tm-core
- `packages/tm-core/src/modules/loop/types.ts:60–102` — `LoopOutputCallbacks` interface.
- `packages/tm-core/src/modules/loop/types.ts:107–108` — `LoopTraceLevel` string union.
- `packages/tm-core/src/modules/loop/types.ts:113–166` — `LoopConfig`.
- `packages/tm-core/src/modules/loop/types.ts:171–191` — `LoopIteration`.
- `packages/tm-core/src/modules/loop/services/trace-level.ts:3–14` — `TRACE_LEVEL_WEIGHTS` constant and `atLeast` predicate.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:159–261` — `run()` orchestrator. Lines 164–172 validate trace+sandbox incompatibility; line 197 `onLoopStart`; line 201 `onIterationStart`; lines 206–208 trace-gated `onPromptSent`; line 223 `onIterationEnd`.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:270–293` — `finalize()`; line 290 `appendFinalSummary`; line 291 `onLoopEnd`.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:295–318` — `buildErrorResult()`; line 307 `onLoopEnd` on pre-flight failure.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:320–336` — `reportError()` helper.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:338–360` — `initProgressFile()` (always-on file header).
- `packages/tm-core/src/modules/loop/services/loop.service.ts:362–384` — `appendFinalSummary()` (always-on file footer).
- `packages/tm-core/src/modules/loop/services/loop.service.ts:386–400` — `truncateForFile`, `formatJsonBlockForFile` helpers.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:402–451` — `buildIterationSummaryBlock()` (tolerates missing `tokenUsage`/`finalResult`).
- `packages/tm-core/src/modules/loop/services/loop.service.ts:554–624` — `executeIteration()` silent path (level='none'); line 607 `onOutput`.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:643–865` — `executeVerboseIteration()`. Line 665 `traceLines` allocation; lines 668–673 iteration header pushed to buffer; line 781 `onStderr`; lines 820–829 trace `onIterationSummary`; lines 832–853 flush to `progressFile`.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:976–1034` — `handleStreamEvent()`. Line 1000 `onText`; line 1002 `onToolUse`; lines 1003–1015 trace tool-input handling (callback + `traceLines.push`); lines 1022–1033 trace tool-result handling.

### MCP
- `apps/mcp/src/tools/loop/loop.tool.ts:11–71` — Zod schema; `traceLevel` enum at lines 37–43.
- `apps/mcp/src/tools/loop/loop.tool.ts:78–131` — `registerLoopTool(server)`; `tmCore.loop.run({...})` at lines 106–116 (no `callbacks` field); `log.info` / `log.error` / `log.debug` only — no `console.*`.
- `apps/mcp/src/tools/loop/index.ts:1` — re-exports `registerLoopTool`.
- `apps/mcp/src/index.ts:7` — re-exports the loop tool module.
- `apps/mcp/src/shared/utils.ts:126–194` — `handleApiResult()` builds the FastMCP `ContentResult` (single JSON-in-text blob).
- `apps/mcp/src/shared/utils.ts:408–409` — `withToolContext` wires tmCore logger to `context.log`.
- `mcp-server/src/tools/tool-registry.js:52` and line 105 — `registerLoopTool` import and registry entry.

## Architecture Documentation

### Trace-level routing pattern

The flow at `loop.service.ts` is concentric:

1. `run()` decides streaming-vs-silent for the entire run via
   `streaming = atLeast(level, 'verbose')` at line 165, then routes each
   iteration to either `executeIteration` (silent) or
   `executeVerboseIteration` (streaming) at line 567.
2. Inside the streaming path, trace-only side effects are gated by
   `atLeast(level, 'trace')` at lines 206, 723, 820, 1003, 1022, and 666 (the
   `traceLines` allocation).
3. The CLI mirror is `verbose = level === 'verbose' || level === 'trace'` and
   `trace = level === 'trace'` at `loop.command.ts:210–211`.

This pattern means there are only two places to make a verbose vs trace
decision: the service (for behavior — spawn mode, stream parsing) and the
presentation layer (for surface — what fires from each callback).

### Service-owned file writes vs. presentation-layer console writes

Today: **all file writes live in the service**, **all console writes live in
the presentation layer**. The service writes file content via:

- `initProgressFile` (always-on, called once)
- Per-iteration trace flush (trace-only, called once per iteration)
- `appendFinalSummary` (always-on, called once)

Extending verbose to also write to the file means adding service-owned writes
(matching the pattern), not pushing file-write logic into the CLI. This keeps
both CLI and MCP automatically file-rich without per-presenter wiring.

### Callback "tiers" model

| Tier | Callbacks | Service gates? | CLI gates today? |
|---|---|---|---|
| Always-on (any level) | `onIterationStart`, `onError`, `onIterationEnd`, `onLoopStart`, `onLoopEnd` | No `atLeast` gate — all paths invoke | `onIterationStart`/`onError`/`onIterationEnd` declared unconditionally; `onLoopStart`/`onLoopEnd` declared under `if (verbose)` |
| Verbose-tier (verbose+trace) | `onText`, `onToolUse`, `onStderr`, `onOutput` (inverse — only at `none`) | Reachable only via verbose path (line 567) | Declared unconditionally in Block A |
| Trace-tier (trace only) | `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary` | Explicit `atLeast(level, 'trace')` gate | Declared inside `if (trace)` block |

Note the asymmetry: the CLI's "if (verbose)" block today only wraps
`onLoopStart`/`onLoopEnd`. The actual verbose-tier events
(`onText`/`onToolUse`/`onStderr`) are declared unconditionally and rely on the
service to gate invocation.

## Historical Context (from thoughts/shared/)

Three completed tickets directly inform this work; all three were committed on
2026-05-19 and are archived in `thoughts/shared/<area>/ARCHIVE/`.

### `tag-38a2bd` — Trace callbacks & progress-file persistence

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Inventory of all 11 trace callbacks and their emit points; ANSI handling strategy; truncation/formatting patterns.
- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Phase-by-phase plan that introduced the formatting helpers and per-iteration buffer logic currently in `loop.service.ts`.
- `thoughts/shared/claude-code-design/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Design decisions: service-internal writes, trace-gated callbacks only, 10 KB truncation per entry, fenced JSON blocks, per-iteration buffer flushed at iteration end, halt-the-loop failure policy, markdown structure.

This is the source of `traceLines`, `truncateForFile`, `formatJsonBlockForFile`,
and `buildIterationSummaryBlock`. The "extend trace's mechanism to also cover
verbose" framing in the current question file maps directly onto this prior
work.

### `tag-79bd39` — `--tracelevel` enum refactor

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — Maps every site that produced/consumed `verbose`/`trace` booleans; identifies ~10 gate sites in `loop.service.ts`; documents Commander enum-validation patterns.
- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — Introduced `LoopTraceLevel`, the `trace-level.ts` helper, and `atLeast`.
- `thoughts/shared/claude-code-design/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — Decisions: Commander `.choices()`, `traceLevel?: LoopTraceLevel`, hard removal of boolean fields, `atLeast()` helper, sandbox-incompatibility error format, level export rules, "trace implies verbose" lives in `@tm/core`.

This is why the gating predicate is `atLeast(level, 'trace')` rather than two
booleans, and why the CLI surface is one `--tracelevel` flag with `.choices()`.

### `tag-6af922` — Session persistence flag

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`
- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`
- `thoughts/shared/claude-code-design/ARCHIVE/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`

Less directly relevant — added the `--session-persistence` flag visible in
the current CLI command and MCP schema. Cited because it documents the same
"CLI option ↔ MCP Zod schema ↔ LoopConfig field" plumbing pattern this
ticket will likely mirror if it touches the schema.

## Related Research

- `thoughts/shared/questions/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md` — The source question file for this research.
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Direct predecessor; this ticket extends the mechanism it introduced.
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — Establishes the `LoopTraceLevel` / `atLeast` vocabulary used throughout.

## Open Questions

- **Should `onText` chunks be concatenated into one per-iteration "LLM output"
  block, or written as separate sequential blocks?** The existing
  `buildIterationSummaryBlock` already captures the `finalResult` (from the
  stream-json `result` event) — that is the complete final assistant message
  text. If the design accepts "final result is enough," verbose may not need
  to capture chunk-by-chunk `onText` at all, only `onToolUse` and
  `onLoopStart`/`onLoopEnd`. If the design wants live chunked output in the
  file, a new per-iteration "LLM output stream" section is needed.
- **Where should `onLoopStart` / `onLoopEnd` file content land?** Options
  visible in the existing code: (a) append to the `initProgressFile` /
  `appendFinalSummary` blocks (these already write the loop-scoped header
  and footer); (b) emit dedicated `# Loop start` / `# Loop end` blocks
  alongside but separate. Either fits the current file shape.
- **Should the MCP tool grow callbacks for observability** (e.g. forwarding
  events to the FastMCP `context.log`), or is the deferred JSON blob
  sufficient? The question file flagged MCP as in-scope but the only
  console-equivalent there is `context.log`, which is opt-in. Today the tool
  installs no callbacks at all.
- **Is the end-of-iteration flush boundary acceptable for verbose?** The
  existing trace flush is end-of-iteration and accepts loss-on-abort. The
  question file flagged this as something to "confirm acceptable or
  document." No code change is needed if the answer is "yes, accept it."
