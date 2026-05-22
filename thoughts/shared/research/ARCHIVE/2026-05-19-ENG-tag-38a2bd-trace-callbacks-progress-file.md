---
topic: "Persist `--trace` output to the loop progress file without ANSI color codes"
tags: [research, codebase, loop, trace, progress-file, tm-core, cli, ansi, chalk]
status: complete
source_question: thoughts/shared/questions/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md
---

# Research: Persist `--trace` output to the loop progress file without ANSI color codes

## Research Question

When `task-master loop --trace` runs, the same trace-mode information that is currently rendered to the terminal via chalk-decorated callbacks (LLM prompt, tool inputs, tool results, iteration summary including token usage) should also be appended to the progress log file (`--progress-file`, default `.taskmaster/progress.txt`) as plain text — no ANSI escape sequences and no terminal-only chalk styling. Investigate the current trace callback wiring, the existing progress-file write path in `@tm/core`, and identify the right architectural seam to add file persistence such that the file always receives clean text by construction (not by post-hoc stripping), in line with the repo rule that all business logic lives in `@tm/core` and presentation concerns (chalk, formatting for the terminal) stay in `apps/cli`.

## Summary

The CLI's trace callbacks (`onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`) are invoked from `LoopService` with **raw, unformatted values** (strings, `unknown` objects, structured token-usage objects) — the chalk styling is applied entirely inside `apps/cli/src/commands/loop.command.ts:251-329`. The progress file is only written in two service-internal helpers (`initProgressFile` at `loop.service.ts:335-357` and `appendFinalSummary` at `loop.service.ts:359-381`) and never receives any trace-event data today. There is no `traceFile` / `verboseLogFile` field on `LoopConfig` or `LoopOutputCallbacks`, and no existing ANSI-stripping enters the service path because no ANSI ever enters the service path — chalk lives only in the CLI.

The natural architectural seam for "plain text by construction" is therefore inside `LoopService` itself: when `config.trace` is true and `config.progressFile` is set, the service emits a parallel set of plain-text writes (header + each trace event + summary) using its existing `await appendFile(..., 'utf-8')` pattern at the same call sites where the callbacks fire (lines 199, 205, 220, 713-722, 860, 862, 869, 881). This keeps chalk strictly in `apps/cli`, never lets ANSI escape codes touch the writer, reuses the already-awaited sequential write pattern (no queue needed because writes are naturally serialized within a single iteration), and matches the existing progress-file structure (`# ` headers + `---` separators).

The codebase has a hand-rolled `stripAnsiCodes` regex at `scripts/modules/utils.js:1948-1954` and a sibling `ANSI_REGEX` at `apps/cli/src/utils/pager.ts:10-18`, but no `strip-ansi` npm package is installed and no @tm/core-side strip utility exists. With the recommended service-side write path, no stripping is needed for chalk — but `onStderr` text from the Claude CLI subprocess is captured raw with `stdio: ['inherit', 'pipe', 'pipe']` and forwarded unfiltered (`loop.service.ts:672-674`), so if stderr is persisted it would need the regex applied at write time.

Test coverage today uses `vi.mock('node:fs/promises')` and `expect(fsPromises.appendFile).toHaveBeenCalledWith(path, expect.stringContaining(substring), 'utf-8')` to assert the two existing writes — there is no integration test that reads back actual file contents, and no test asserts trace data lands in the file.

## Detailed Findings

### Trace Callback Inventory & Emit Points

All callback invocation sites live in `packages/tm-core/src/modules/loop/services/loop.service.ts`. Each receives raw values; the CLI is the only place chalk styling is applied (`apps/cli/src/commands/loop.command.ts:192-333`).

| Callback | Service emit site | Raw value passed | Mode gate | CLI styling |
| --- | --- | --- | --- | --- |
| `onPromptSent` | `loop.service.ts:205` (inside `run()` per-iteration loop) | `(iteration: number, prompt: string)` — fully assembled prompt string from `buildPrompt()` | `config.trace` truthy | `chalk.magenta` header + `chalk.dim(prompt)` (`loop.command.ts:251-258`) |
| `onToolInput` | `loop.service.ts:869` (in `handleStreamEvent` assistant→tool_use branch) | `(toolName: string, input: unknown)` — raw parsed JSON | `trace && block.input !== undefined` | `chalk.magenta` label + `chalk.dim(formatTraceValue(input))` (`loop.command.ts:259-264`) |
| `onToolResult` | `loop.service.ts:881` (in `handleStreamEvent` user-event branch) | `(toolName: string \| undefined, result: unknown)` — raw parsed JSON | `trace && event.type === 'user'` | `chalk.magenta` + `chalk.dim(formatTraceValue(result))` (`loop.command.ts:265-274`) |
| `onIterationSummary` | `loop.service.ts:713-722` (inside `executeVerboseIteration`'s `child.on('close')`) | `(iteration: number, { toolCalls: {name,count}[], finalResult?: string, tokenUsage?: LoopTokenUsage })` — structured object | `trace && callbacks?.onIterationSummary` | All formatting in CLI: tool table, token rows with `toLocaleString()`, final result block (`loop.command.ts:275-329`) |
| `onText` | `loop.service.ts:860` | `(text: string)` — raw Claude text block | streaming (verbose **or** trace) | bare `console.log(text)` (`loop.command.ts:201-203`) |
| `onToolUse` | `loop.service.ts:862` | `(toolName: string)` | streaming (verbose **or** trace) | `chalk.dim("  → toolName")` (`loop.command.ts:204-206`) |
| `onIterationStart` | `loop.service.ts:199` | `(iteration: number, total: number)` | all modes | `chalk.cyan("━━━ Iteration N of M ━━━")` (`loop.command.ts:197-200`) |
| `onIterationEnd` | `loop.service.ts:220` | `(iteration: LoopIteration)` structured object | all modes | status-colored line (`loop.command.ts:220-232`) |
| `onLoopStart` | `loop.service.ts:195` | `(startedAt: Date, totalIterations: number)` | all modes (CLI registers only when `verbose`) | `chalk.dim("[Loop Start] <ISO>")` (`loop.command.ts:238-240`) |
| `onLoopEnd` | `loop.service.ts:288` (in `finalize`) and `loop.service.ts:304` (in `buildErrorResult`) | `(finishedAt: Date, totalDuration: number)` | all modes (CLI registers only when `verbose`) | `chalk.dim("[Loop End] ...")` (`loop.command.ts:241-246`) |
| `onError` | `loop.service.ts:169, 182, 523, 534, 625-629, 655-659, 679, 704-708` (all via `reportError`) | `(message: string, severity?: 'warning' \| 'error')` | all modes | `chalk.yellow` (warning) or `chalk.red` (error) (`loop.command.ts:207-213`) |
| `onStderr` | `loop.service.ts:673-675` (in `child.stderr.on('data')`) | `(iteration: number, text: string)` — **raw stderr bytes from Claude CLI** | streaming only | `process.stderr.write(chalk.dim(...) + text)` — no ANSI strip (`loop.command.ts:214-216`) |
| `onOutput` | `loop.service.ts:529` (non-verbose `executeIteration`) | `(output: string)` — stdout+stderr concatenated | non-verbose only | `console.log(output)` (`loop.command.ts:217-219`) |

**Key observation**: every value that ends up rendered with chalk on the terminal is passed into the callback **before** chalk is applied. The service has zero chalk imports. This means file persistence implemented inside the service is "plain by construction".

### Architectural Placement of File Writes

The repo's `CLAUDE.md` is explicit: all business logic lives in `@tm/core`; CLI is a thin presentation layer. The three options enumerated in the question file map as follows.

**(a) Service writes raw payloads directly when `trace=true`.** Requires extending `LoopService` with a small private helper (e.g. `appendTraceEntry(progressFile, kind, payload)`) called at the same emit sites as the callbacks (lines 199, 205, 220, 713, 860, 862, 869, 881). Reuses the existing `await appendFile(file, text, 'utf-8')` pattern from `initProgressFile` / `appendFinalSummary`. No chalk is in scope — zero chance of ANSI in the file. Aligns with the repo rule because the *decision to persist* is business logic; the CLI keeps only display concerns. This is the option that matches the existing architecture.

**(b) A new plain-text sink callback (e.g. `onTraceLog(line)`).** Pushes the formatting decision to the CLI, then the CLI both `console.log`s a chalked version and `await appendFile`s a plain version. Forces the CLI to own file I/O — currently it does none. Doubles the number of writes scheduled per event. Re-introduces the chalk/plain duality the question wants to avoid.

**(c) CLI wraps each chalk callback and strips ANSI for the file copy.** Worst option: file I/O in the CLI, and the file's plain-text quality depends on a regex catching every escape sequence chalk emits (current `stripAnsiCodes` regex `/\x1b\[[0-9;]*m/g` covers SGR but not other CSI variants).

**Recommendation surface**: option (a) — *service-internal write at each existing callback emit site*. This is what the file describes as "plain text by construction". No additional callback fields are required on `LoopOutputCallbacks`; the service uses `config.progressFile` and `config.trace`/`config.verbose` flags it already has. `LoopConfig` is at `packages/tm-core/src/modules/loop/types.ts:107-166` and already carries `progressFile: string`, `verbose?: boolean`, `trace?: boolean`.

### ANSI Handling Strategy

No `strip-ansi` or `ansi-regex` npm package is installed anywhere in the monorepo (no `package.json` references). Two hand-rolled implementations exist:

- `scripts/modules/utils.js:1948-1954` — `stripAnsiCodes(text)` using `/\x1b\[[0-9;]*m/g`. Tests at `tests/unit/utils-strip-ansi.test.js:9-56` exercise color codes, multi-param sequences (`\x1b[1;31m`), reset codes (`\x1b[39m`), multiline text, non-string pass-through.
- `apps/cli/src/utils/pager.ts:10-18` — same regex assigned to a `ANSI_REGEX` constant, used by `visibleLength()` for terminal-width measurement before piping to `less`.

The regex matches only SGR (color/style) sequences (`CSI ... m`) — it does not strip cursor-movement, erase-line, or other CSI variants.

With approach (a) chosen, ANSI cannot enter the writer because the writer runs inside `@tm/core` where chalk is not imported (the service's only dependency on text formatting is `JSON.stringify` and string concatenation). The Claude CLI subprocess is invoked with `stdio: ['inherit', 'pipe', 'pipe']` at `loop.service.ts:589-592` and `509-515`; stdout is a pipe (Claude defaults to non-color on non-TTY) but **stderr is also a pipe and could still carry ANSI** depending on Claude's internal color logic, since no `--no-color` flag is passed in `buildCommandArgs` (`loop.service.ts:789-804`). If `onStderr` content is persisted, the regex would need to be applied at write time. The `onText` payload (`block.text` from the parsed stream-json event) is plain JSON-decoded text and is safe by construction.

### Log Format Inside the Progress File

The current file format is established by two helpers:

`initProgressFile` (`loop.service.ts:335-357`) writes:
```
<existing content>
\n
# Taskmaster Loop Progress
# Started: <ISO timestamp>
# Brief: <brief>           (if config.brief)
# Preset: <prompt>
# Max Iterations: <N>
# Tag: <tag>               (if config.tag)
\n
---
\n
```

`appendFinalSummary` (`loop.service.ts:359-381`) writes:
```
\n
---
# Loop Complete: <finishedAt ISO>
- Total iterations: N
- Tasks completed: N
- Final status: <status>
- Total duration: Nms      (if numeric)
\n
```

The format is markdown-ish: `# H1`, `---` horizontal rules, `-` bullet lists, all UTF-8. Trace entries should fit this idiom. A natural per-iteration grouping (matching the existing leading `---` separator pattern) would be:

```
## Iteration N
### LLM input
<prompt body, possibly fenced>
### Tool: <name> input
<JSON.stringify(input, null, 2) body>
### Tool: <name> result
<JSON.stringify(result, null, 2) body>
### Iteration N tool-call summary
- <toolName>: <count>
### Iteration N token usage
- input: 1,234
- output: 567
- cache write: 89  (if present)
- cache read: 12   (if present)
- total: 2,468
### LLM final output
<text>
```

**Truncation**: the CLI today truncates via `formatTraceValue` (`loop.command.ts:335-346`) at 500 chars for strings and 1000 chars for JSON — these limits exist to keep terminal output scannable. The question explicitly frames the file as "forensic"; for a log file the truncation defaults are not load-bearing. The choice between "same 500/1000 truncation" vs "full payload" is a product decision (see Open Questions).

**Pretty vs compact JSON**: existing comparable patterns in the codebase split:
- `formatTraceValue` uses `JSON.stringify(value, null, 2)` (pretty) for display.
- The activity logger at `packages/tm-core/src/modules/storage/adapters/activity-logger.ts:44-63` uses compact `JSON.stringify(logEntry) + '\n'` (JSONL).
- The logger at `packages/tm-core/src/common/logger/logger.ts:184-186` uses pretty for object args.

Pretty matches the human-readable "forensic log" framing; compact matches machine-parseable JSONL conventions.

### Ordering, Concurrency, and Failure Mode

The existing two writes (`initProgressFile`, `appendFinalSummary`) are sequential and `await`ed — there is no write queue anywhere in `@tm/core`. The activity logger (`activity-logger.ts:44-63`) follows the same `await fs.appendFile` pattern without a queue.

Within a single iteration the trace events fire from two contexts:
- `run()` (line 205) — `onPromptSent`, called synchronously before `executeIteration` returns; one event.
- `handleStreamEvent` (lines 860, 862, 869, 881) — `onText`, `onToolUse`, `onToolInput`, `onToolResult`, called from `processBufferedLines` inside `child.stdout.on('data')`. **Multiple tool_use blocks within a single assistant turn fire in rapid synchronous succession.**
- `executeVerboseIteration` `close` handler (line 713-722) — `onIterationSummary`, one event per iteration.

If each trace entry calls `await appendFile`, Node's microtask scheduling means concurrent appends to the same file *can* interleave at the filesystem level if multiple are scheduled before any resolve. POSIX `O_APPEND` writes for short payloads are atomic, but typed trace payloads can be many KB. Three concurrency strategies are viable:

1. **Per-iteration in-memory buffer** flushed once per iteration in the `close` handler. Simplest; no interleave risk; trade-off: trace lines aren't visible in the file until the iteration ends (matches `onIterationSummary` timing already).
2. **Per-service write queue** — a `Promise` chain (`this._writeChain = this._writeChain.then(() => appendFile(...))`) ensures strict serialization. Adds a few lines, no library needed.
3. **Direct `await appendFile` from each emit site** — relies on POSIX O_APPEND atomicity per write. Works for short lines but risks interleave for large JSON dumps.

The `child.stdout.on('data')` handler is synchronous-into-Node — it can fire `processBufferedLines` multiple times per tick before any awaited write resolves. Option 1 or 2 is safer than option 3.

**Failure policy**: existing writes have no local try/catch — any `appendFile` or `mkdir` error propagates up through `run()` to the CLI's outer `try/catch` at `loop.command.ts:150` and exits 1. The same policy applied to trace writes would *halt the loop* on a single disk-full or permission error. The question's third option ("warn via `onError` and continue") fits the codebase's existing `reportError(..., 'warning')` pattern (used for JSON parse failures at `loop.service.ts:625-629`).

### Test Coverage

All tests use Vitest. Key files:

- **`packages/tm-core/src/modules/loop/services/loop.service.spec.ts`** — module-mocks `node:fs/promises` and `node:child_process`. Existing progress-file assertions (lines 775-827) use:
  ```typescript
  expect(fsPromises.appendFile).toHaveBeenCalledWith(
      '/test/progress.txt',
      expect.stringContaining('# Taskmaster Loop Progress'),
      'utf-8'
  );
  ```
  Tests private methods via `(service as unknown as { handleStreamEvent: ... }).handleStreamEvent` casts (lines 672-721 for `handleStreamEvent`, 904-910 for `parseCompletion`, 961-965 for `extractTokenUsage`, 1100-1107 for `buildContextHeader`).
- **`apps/cli/src/commands/loop.command.spec.ts`** — module-mocks `@tm/core`; `mockLoopRun = vi.fn().mockResolvedValue(...)`. Exercises real `createOutputCallbacks` via `(loopCommand as any).createOutputCallbacks.bind(loopCommand)` and asserts against `consoleLogSpy.mock.calls.flat().join(' ')` (e.g. lines 246, 334). No filesystem; no service execution.
- **`apps/cli/tests/integration/commands/loop.command.test.ts`** — real `fs.mkdtempSync` tmpdir per test (line 32); runs the CLI binary via `execSync`. No callback or content assertions today; only exit-code and stdout substring checks.
- **`packages/tm-core/tests/integration/loop/loop-tmcore-access.test.ts`** — only integration test that writes real `.taskmaster/tasks/tasks.json` and `config.json` with `fs.writeFileSync` and cleans up in `afterEach`.

**Existing assertion idiom for file content**: `expect.stringContaining(substring)` against the mocked `appendFile` call args — no test reads back from disk except the CLI binary integration test, and that test does not inspect the progress file.

**Gap**: zero tests assert that `onPromptSent`, `onToolInput`, `onToolResult`, or `onIterationSummary` data reaches `fsPromises.appendFile`. Zero tests assert absence of ANSI in any persisted content.

### `LoopConfig` and `LoopOutputCallbacks` Shape

From `packages/tm-core/src/modules/loop/types.ts:60-166`:

`LoopOutputCallbacks` (lines 60-102) — 13 optional callbacks, all listed in the table above. No file-related field.

`LoopConfig` (lines 107-166):
- Required: `iterations: number`, `prompt: LoopPreset | string`, `progressFile: string`, `sleepSeconds: number`.
- Optional: `tag`, `sandbox`, `includeOutput`, `verbose`, `trace`, `brief`, `callbacks`.

There is no `traceFile`, no separate verbose-log path. The single `progressFile` field is the only file output target the service knows about, and the CLI defaults it to `'.taskmaster/progress.txt'` (relative string) at `loop.command.ts:71` while the domain default at `loop-domain.ts:188-191` is `path.join(this.projectRoot, '.taskmaster', 'progress.txt')`.

## Edge Cases Addressed

- **Chalk-decorated strings carrying ANSI into the file**: impossible under approach (a) because chalk is not imported in `@tm/core`. The service receives raw values from `block.input`, `block.text`, `summary.tokenUsage`, etc. — none of these are produced by chalk in the codebase.
- **`onStderr` may carry ANSI from Claude CLI itself**: confirmed possible. `loop.service.ts:589-592` spawns `claude` with `stdio: ['inherit', 'pipe', 'pipe']` and no `--no-color`; stderr is piped (non-TTY) but Claude may still emit color depending on its own logic. If stderr is persisted, the `/\x1b\[[0-9;]*m/g` regex used at `scripts/modules/utils.js:1948-1954` would need to be applied at write time (or moved into a shared util in `@tm/core/src/common/`).
- **Very large LLM prompts and tool results**: `buildPrompt` produces arbitrarily long strings; tool results from large file reads or web fetches can be many KB. CLI truncates at 500/1000 chars; file policy is a product decision (see Open Questions).
- **Concurrent async appends from multiple tool_use blocks in one assistant turn**: real risk because `processBufferedLines` (`loop.service.ts:655`) processes multiple stream-json lines per `data` event synchronously. Mitigations are per-iteration buffering or a service-level write-chain (a `Promise` chain field on `LoopService`).
- **`appendFile` failures mid-run**: existing writes propagate up unhandled; trace writes can either match this (halt) or use the existing `reportError(..., 'warning')` pattern (warn + continue) seen at `loop.service.ts:625-629` for JSON parse failures.
- **Sandbox + `--trace` incompatibility**: short-circuit at `loop.service.ts:162-170` fires **before** `initProgressFile` (line 192), `_isRunning = true` (line 186), and `onLoopStart` (line 195). The progress file is untouched on this error path. `buildErrorResult` fires `onLoopEnd` (line 304) and returns. Same is true for the `task-master` availability check at lines 177-184.
- **Non-JSON / malformed stream-json lines**: already handled via `reportError(..., 'warning')` at `loop.service.ts:625-629` and `655-659`. If trace persistence writes these warnings, the CLI's existing yellow-warning display path remains the user-facing surface; persisting the warning text would let post-hoc inspection see them.
- **Mid-iteration aborts / crashes**: `initProgressFile` writes a leading `\n` before the header so a partially-written iteration's tail is followed by a clean separator. `appendFinalSummary` runs in `finalize` which is the success path; pre-flight error paths use `buildErrorResult` and skip the final summary. Per-iteration trace blocks should likewise terminate with their own `---` so a mid-run abort doesn't break the next run's header.
- **Existing-run grouping**: `initProgressFile` always appends (`appendFile`, never `writeFile`), so prior runs remain at the top of the file separated by `---`. Per-iteration trace blocks must be written *between* the current run's header and final summary; the natural insertion point is each callback emit site after `_isRunning = true`.

## Code References

### Service-side emit sites and writes
- `packages/tm-core/src/modules/loop/services/loop.service.ts:6` — imports `appendFile, mkdir, readFile` from `node:fs/promises`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:162-170` — sandbox + verbose/trace incompatibility guard, fires before any file write
- `packages/tm-core/src/modules/loop/services/loop.service.ts:177-184` — `task-master` CLI precondition check, same early-return shape
- `packages/tm-core/src/modules/loop/services/loop.service.ts:192` — `initProgressFile` call site (after guards, before iteration loop)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:195` — `onLoopStart`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:199` — `onIterationStart`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:205` — `onPromptSent` (trace-only)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:220` — `onIterationEnd`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:287` — `appendFinalSummary` call site
- `packages/tm-core/src/modules/loop/services/loop.service.ts:288` — `onLoopEnd` (success path)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:304` — `onLoopEnd` (error path via `buildErrorResult`)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:321-333` — `reportError` helper routing to `callbacks.onError`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:335-357` — `initProgressFile` (mkdir + appendFile, awaited, no try/catch)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:359-381` — `appendFinalSummary` (appendFile, awaited)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:509-515` — non-verbose `spawnSync` with `stdio: ['inherit', 'pipe', 'pipe']`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:589-592` — verbose `spawn` with same stdio
- `packages/tm-core/src/modules/loop/services/loop.service.ts:625-629` — `reportError(..., 'warning')` for malformed stream-json lines
- `packages/tm-core/src/modules/loop/services/loop.service.ts:655-659` — `reportError(..., 'warning')` for `processBufferedLines` throw
- `packages/tm-core/src/modules/loop/services/loop.service.ts:672-674` — `onStderr` emit (raw Claude CLI stderr, possibly ANSI)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:697-732` — `child.on('close')` handler containing `onIterationSummary` emit
- `packages/tm-core/src/modules/loop/services/loop.service.ts:713-722` — `onIterationSummary` (trace-only)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:789-804` — `buildCommandArgs` (no `--no-color` flag)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:837-885` — `handleStreamEvent` containing `onText` (line 860), `onToolUse` (line 862), `onToolInput` (line 869), `onToolResult` (line 881)

### CLI-side wiring
- `apps/cli/src/commands/loop.command.ts:71` — `progressFile` default `'.taskmaster/progress.txt'` (relative)
- `apps/cli/src/commands/loop.command.ts:132` — `effectiveVerbose = verbose || trace` (trace implies verbose)
- `apps/cli/src/commands/loop.command.ts:145` — `callbacks: this.createOutputCallbacks(effectiveVerbose, trace)`
- `apps/cli/src/commands/loop.command.ts:150` — top-level `try/catch` and `process.exit(1)` (only file-error containment today)
- `apps/cli/src/commands/loop.command.ts:192-333` — `createOutputCallbacks` (entire chalk-styling surface)
- `apps/cli/src/commands/loop.command.ts:201-203` — `onText` handler (no chalk)
- `apps/cli/src/commands/loop.command.ts:204-206` — `onToolUse` (chalk.dim)
- `apps/cli/src/commands/loop.command.ts:207-213` — `onError` (chalk.red/yellow)
- `apps/cli/src/commands/loop.command.ts:214-216` — `onStderr` (chalk.dim prefix + raw text)
- `apps/cli/src/commands/loop.command.ts:217-219` — `onOutput` (no chalk)
- `apps/cli/src/commands/loop.command.ts:220-232` — `onIterationEnd` (status-colored)
- `apps/cli/src/commands/loop.command.ts:238-240` — `onLoopStart` (verbose-only)
- `apps/cli/src/commands/loop.command.ts:241-246` — `onLoopEnd` (verbose-only)
- `apps/cli/src/commands/loop.command.ts:251-258` — `onPromptSent` chalk surface
- `apps/cli/src/commands/loop.command.ts:259-274` — `onToolInput` / `onToolResult` chalk surface
- `apps/cli/src/commands/loop.command.ts:275-329` — `onIterationSummary` chalk surface (tool-call table + token usage rows + final result)
- `apps/cli/src/commands/loop.command.ts:335-346` — `formatTraceValue` (500/1000-char truncation, pretty JSON)

### Types
- `packages/tm-core/src/modules/loop/types.ts:60-102` — `LoopOutputCallbacks` definition
- `packages/tm-core/src/modules/loop/types.ts:107-166` — `LoopConfig` definition

### Domain facade
- `packages/tm-core/src/modules/loop/loop-domain.ts:188-191` — default `progressFile = path.join(this.projectRoot, '.taskmaster', 'progress.txt')` when CLI passes `undefined`

### ANSI handling (existing utilities)
- `scripts/modules/utils.js:1948-1954` — `stripAnsiCodes` (`/\x1b\[[0-9;]*m/g`)
- `scripts/modules/utils.js:1995` — export
- `apps/cli/src/utils/pager.ts:10-18` — `ANSI_REGEX` + `visibleLength`
- `tests/unit/utils-strip-ansi.test.js:9-56` — coverage for `stripAnsiCodes`

### File-write patterns
- `packages/tm-core/src/modules/storage/adapters/activity-logger.ts:44-63` — JSONL `appendFile` pattern (closest sibling pattern)
- `packages/tm-core/src/modules/config/services/config-persistence.service.ts:60-69` — atomic temp-file `writeFile` + `rename` (for JSON state, not relevant to log append)
- `packages/tm-core/src/common/logger/logger.ts:184-186` — pretty `JSON.stringify(arg, null, 2)` formatter

### Test files
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:20-21` — `vi.mock('node:child_process')`, `vi.mock('node:fs/promises')`
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:775-827` — progress-file assertion pattern (`expect.stringContaining`)
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:672-721` — private-cast `handleStreamEvent` invocation for trace tests
- `apps/cli/src/commands/loop.command.spec.ts:311-341` — `createOutputCallbacks` callback assertion via `(loopCommand as any)` cast
- `apps/cli/src/commands/loop.command.spec.ts:618-734` — trace callback assertions against console output
- `apps/cli/tests/integration/commands/loop.command.test.ts:32` — `fs.mkdtempSync` real tmpdir setup
- `packages/tm-core/tests/integration/loop/loop-tmcore-access.test.ts:37-69` — real `.taskmaster` directory setup

## Architecture Documentation

**Layering**: `apps/cli` (presentation) → `@tm/core` `LoopDomain` (facade, `packages/tm-core/src/modules/loop/loop-domain.ts`) → `LoopService` (`packages/tm-core/src/modules/loop/services/loop.service.ts`, business logic + I/O). The CLI imports `LoopConfig`, `LoopOutputCallbacks`, `LoopResult`, `LoopIteration`, `TmCore`, `createTmCore`, `PRESET_NAMES` directly from `@tm/core` (`loop.command.ts:6-14`).

**Module organization**: the loop module follows the "domain owns its logic end-to-end" rule from `CLAUDE.md`. Presets live alongside services in `packages/tm-core/src/modules/loop/presets/`. Types live in `packages/tm-core/src/modules/loop/types.ts`. The barrel export at `packages/tm-core/src/modules/loop/index.ts` is the public surface.

**Discoverable naming**: file suffixes follow the convention (`*.service.ts`, `*.spec.ts`, `*.ts` for types). Tests are co-located alongside source.

**Callback design**: all 13 callbacks pass raw values; presentation formatting is the CLI's responsibility. This is a deliberate separation that approach (a) preserves and approach (b)/(c) would partially erode.

**Concurrency model**: single-threaded JS, sequential iterations, awaited I/O at every existing call site. No queue, no batching, no debouncing anywhere in `@tm/core`'s loop module.

## Historical Context (from thoughts/shared/)

- `thoughts/shared/questions/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — the refined question driving this research. No prior research documents, design documents, or implementation plans exist under `thoughts/shared/` for the loop trace persistence topic.

## Related Research

None. This is the first research document in `thoughts/shared/research/` on `LoopService`, the trace flow, or progress-file persistence.

## Open Questions

These remain "not specified" in the question file and need a product decision before implementation:

1. **Scope of persisted callbacks**: trace-only callbacks (`onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`) only? Or also `onText`, `onToolUse`, `onStderr`, iteration markers when `--trace` is on?
2. **`--verbose` (without `--trace`)**: should it persist anything beyond what's already in the header/summary?
3. **Truncation**: match the CLI's 500/1000-char `formatTraceValue` limits, or persist full payloads?
4. **JSON formatting**: pretty (`JSON.stringify(value, null, 2)`) like the CLI's display layer, or compact one-line like the activity logger?
5. **Token usage block**: include the `onIterationSummary.tokenUsage` rows in the file?
6. **`onStderr` persistence**: persist? If yes, apply the SGR regex from `scripts/modules/utils.js:1948-1954` (and decide whether to move it to `packages/tm-core/src/common/`)?
7. **`onError` warnings (malformed stream-json, parse failures)**: persist?
8. **`appendFile` failure policy**: halt loop (current pattern), warn-and-continue (matches existing `reportError(..., 'warning')`), or silent?
9. **Concurrency strategy**: per-iteration in-memory buffer flushed on iteration close, per-service `Promise` chain, or rely on POSIX `O_APPEND` atomicity for short writes?
10. **Section grouping**: trace data inside the same `---`-delimited run block written by `initProgressFile` + `appendFinalSummary`, or in its own block? (Implementation note: appending between header and final-summary naturally falls inside the same block.)
11. **Absolute vs. relative `progressFile` paths**: should the service resolve the CLI's `'.taskmaster/progress.txt'` relative path against `projectRoot`, the same way `LoopDomain.buildConfig` does when `progressFile` is `undefined`?
12. **Test layer**: unit specs using `vi.mock('node:fs/promises')` and `expect.stringContaining(...)` (matches existing pattern) vs integration tests with real tmpdir (matches `loop.command.test.ts` and `loop-tmcore-access.test.ts` patterns) — or both?
13. **Per-iteration header style**: `## Iteration N` (markdown H2) vs inline `[trace] …` prefix lines vs separate `### LLM input` / `### Tool: X input` subsections.
