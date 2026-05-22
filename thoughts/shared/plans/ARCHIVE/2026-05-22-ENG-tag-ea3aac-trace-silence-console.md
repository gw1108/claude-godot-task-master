# Silence Console Output for --verbose/--trace While Preserving File Writes — Implementation Plan

## Overview
Remove all level-specific console callbacks from the CLI loop command so `--verbose` and `--trace` no longer print per-event output to the terminal, while introducing progress-file writes for verbose-level and preserving existing trace-level file writes. Add minimal mid-run observability to a new MCP loop tool.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md`

## Current State

**Service** (`packages/tm-core/src/modules/loop/services/loop.service.ts`):
- `traceLines` buffer allocated at `trace && progressFile` (line ~650) — verbose has no file writes at all
- Iteration header `## Iteration N` AND `### LLM input` both pushed inside same `if (traceLines)` block (lines 654–658) — LLM input is not trace-gated separately
- Iteration summary pushed at `if (traceLines && progressFile)` (line ~818), gated behind `buildIterationSummaryBlock` call
- `onIterationSummary` callback invoked at `if (trace && callbacks?.onIterationSummary)` (lines 806–815)
- `appendFile` flush is end-of-iteration, fire-and-forget (lines 832–838)
- No `verbose` field in `LoopConfig`; `LoopTraceLevel` type and `atLeast` predicate do not exist

**CLI** (`apps/cli/src/commands/loop.command.ts`):
- `createOutputCallbacks(verbose: boolean, trace = false)` (line 192) registers callbacks in three groups:
  - Always-on (lines 196–233): `onIterationStart`, `onText`, `onToolUse`, `onError`, `onStderr`, `onOutput`, `onIterationEnd`
  - `if (verbose)` block (lines 237–248): `onLoopStart`, `onLoopEnd` — print ISO timestamps to console
  - `if (trace)` block (lines 250–330): `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary` — print detailed trace output to console
- `formatTraceValue` helper (lines 335–346) — only used by trace block
- Called from `execute()` at line 145 as `this.createOutputCallbacks(effectiveVerbose, trace)` where `effectiveVerbose = verbose || trace` (line 132)

**MCP** (`apps/mcp/src/tools/loop/`): Does not exist. No MCP loop tool is implemented.

**Key types** (`packages/tm-core/src/modules/loop/types.ts`):
- `LoopOutputCallbacks` interface: lines 60–102
- `LoopConfig` type: lines 107–166, contains `callbacks?: LoopOutputCallbacks` and `trace: boolean` (no `verbose` field)

## Desired End State

- `--verbose` run: terminal shows only always-on output (banners, iteration start/end separators, errors, stderr passthrough). Progress file gains one `## Iteration N` block per iteration with tool-call breakdown, token usage, and `finalResult`.
- `--trace` run: same terminal silence plus file gains additionally `### LLM input`, per-tool input, and per-tool result blocks on top of the verbose content.
- Normal run (no flags): unchanged — `onOutput` still prints iteration output.
- MCP loop tool created with `onError` and `onIterationEnd` callbacks for mid-run visibility via `context.log`.

## What We Are NOT Doing

- Introducing `LoopTraceLevel` enum or `atLeast` predicate
- Changing always-on CLI banners (`displayCommandHeader`, pre-loop `Starting Task Master Loop...` block, `displayResult()`, sandbox-auth writes)
- Changing `initProgressFile()` header or `appendFinalSummary()` footer formats
- Progressive (per-event) file flushing — end-of-iteration flush is retained
- Chunked `onText` capture
- Wiring verbose/trace callbacks to `context.log` in MCP
- Changing the `--tracelevel` flag (it doesn't exist; `--verbose` and `--trace` flags remain unchanged)
- Changing trace's existing per-iteration file content (LLM input, per-tool input, per-tool result stay)
- Changing the MCP tool's Zod schema or JSON-blob return shape

---

## Phase 1: Core — Add `verbose` to LoopConfig and loosen service buffer allocation

### Goal
Extend `LoopConfig` with a `verbose` flag so the service can allocate the per-iteration file buffer at `verbose || trace`, and split the iteration-start push block so `## Iteration N` fires at verbose+ while `### LLM input` remains trace-only. Rename `traceLines` to `iterationFileLines` for clarity.

### Changes

#### LoopConfig type
**File:** `packages/tm-core/src/modules/loop/types.ts`
**Change:** Add `verbose?: boolean` field to `LoopConfig`. Place it adjacent to the existing `trace?: boolean` field.

```ts
// In LoopConfig (near the existing trace field):
verbose?: boolean;
```

#### Loop service — buffer allocation and iteration-start block
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

**Change 1:** Destructure `verbose` from config (wherever `trace` is destructured).
```ts
// Before (approx):
const { trace, progressFile, ... } = config;

// After:
const { verbose, trace, progressFile, ... } = config;
```

**Change 2:** Rename `traceLines` → `iterationFileLines` throughout the file (all occurrences) and loosen the allocation condition.
```ts
// Before (line ~650):
const traceLines: string[] | undefined =
    trace && progressFile ? [] : undefined;

// After:
const iterationFileLines: string[] | undefined =
    (verbose || trace) && progressFile ? [] : undefined;
```

**Change 3:** Split the iteration-start push block so only `## Iteration N` fires at verbose+ and `### LLM input` is gated to trace.
```ts
// Before (lines ~654–658):
if (traceLines) {
    traceLines.push(`## Iteration ${iterationNum}`);
    traceLines.push(
        `### LLM input\n\`\`\`text\n${this.truncateForFile(prompt)}\n\`\`\``
    );
}

// After:
if (iterationFileLines) {
    iterationFileLines.push(`## Iteration ${iterationNum}`);
    if (trace) {
        iterationFileLines.push(
            `### LLM input\n\`\`\`text\n${this.truncateForFile(prompt)}\n\`\`\``
        );
    }
}
```

**Change 4:** Rename all remaining `traceLines` references to `iterationFileLines` (per-tool input push ~line 990, per-tool result push ~line 1006, iteration-summary block ~lines 817–838). The optional-chaining form `traceLines?.push(...)` becomes `iterationFileLines?.push(...)`. The flush block condition `if (traceLines && progressFile)` becomes `if (iterationFileLines)` (since `iterationFileLines` being defined already guarantees `progressFile` is set via the allocation condition).

```ts
// Iteration summary block — before (lines ~817–838):
if (traceLines && progressFile) {
    const toolCalls = ...;
    traceLines.push(this.buildIterationSummaryBlock(...));
    traceLines.push('---');
    appendFile(progressFile, '\n' + traceLines.join('\n\n') + '\n', 'utf-8')
        .catch((err: unknown) => { rejectOnce(err); });
}

// After:
if (iterationFileLines) {
    const toolCalls = ...;
    iterationFileLines.push(this.buildIterationSummaryBlock(...));
    iterationFileLines.push('---');
    appendFile(progressFile!, '\n' + iterationFileLines.join('\n\n') + '\n', 'utf-8')
        .catch((err: unknown) => { rejectOnce(err); });
}
```

Note: `progressFile!` non-null assertion is safe because `iterationFileLines` is only defined when `progressFile` is truthy. Alternatively keep `progressFile` with a type-narrowing `if (iterationFileLines && progressFile)` if TypeScript requires it.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for core: `npm run test -w @tm/core`

---

## Phase 2: CLI — Remove Level-Specific Console Callbacks

### Goal
Reduce `createOutputCallbacks` to only the five always-on callbacks (`onIterationStart`, `onError`, `onStderr`, `onOutput`, `onIterationEnd`). Remove `onText`, `onToolUse`, the `if (verbose)` block, the `if (trace)` block, and the `formatTraceValue` helper. Pass `verbose` to the LoopConfig so the service can gate file writes correctly.

### Changes

#### Remove always-registered verbose-tier callbacks
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** Delete `onText` (lines 201–203) and `onToolUse` (lines 204–206) from the initial `callbacks` object literal in `createOutputCallbacks`.

```ts
// Before — always-on block includes:
onText: (text: string) => {
    console.log(text);
},
onToolUse: (toolName: string) => {
    console.log(chalk.dim(`  → ${toolName}`));
},

// After — these two entries are removed entirely.
```

#### Remove if (verbose) block
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** Delete lines 237–248 in full (the `if (verbose) { callbacks.onLoopStart = ...; callbacks.onLoopEnd = ...; }` block).

#### Remove if (trace) block
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** Delete lines 250–330 in full (the `if (trace) { callbacks.onPromptSent = ...; callbacks.onToolInput = ...; callbacks.onToolResult = ...; callbacks.onIterationSummary = ...; }` block).

#### Remove formatTraceValue helper
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** Delete lines 335–346 (the `private formatTraceValue(value: unknown): string` method) entirely.

#### Pass verbose to LoopConfig
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** In `execute()`, locate where `tmCore.loop.run(...)` is called and add `verbose: effectiveVerbose` to the config object passed to it.

```ts
// Find the tmCore.loop.run call in execute() and add the verbose field:
const result = await this.tmCore.loop.run({
    // ... existing fields ...
    verbose: effectiveVerbose,  // <-- ADD THIS LINE
    trace,
    callbacks: this.createOutputCallbacks(effectiveVerbose, trace),
});
```

`effectiveVerbose` is already computed at line 132 as `verbose || trace`. This propagates the flag into `LoopConfig.verbose` so the service allocates `iterationFileLines` correctly when `--verbose` is passed.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for CLI: `npm run test -w @tm/cli`
- [x] No TypeScript errors from unused `formatTraceValue` removal (verify no other callers with grep)

---

## Phase 3: MCP — Create Minimal Loop Tool

### Goal
Create `apps/mcp/src/tools/loop/loop.tool.ts` following the existing autopilot tool pattern (`apps/mcp/src/tools/autopilot/start.tool.ts`). Wire `onError` → `log.error`/`log.warn` and `onIterationEnd` → `log.info` for mid-run MCP client visibility. Register the tool in the MCP tool index.

### Changes

#### New MCP loop tool file
**File:** `apps/mcp/src/tools/loop/loop.tool.ts` *(create new)*
**Change:** Model after `apps/mcp/src/tools/autopilot/start.tool.ts`. Use `withToolContext` from `apps/mcp/src/shared/utils.ts` and `handleApiResult` for the response.

```ts
import { z } from 'zod';
import { withToolContext } from '../../shared/utils.js';
import { handleApiResult } from '../../shared/utils.js';
import type { ToolDefinition } from '../../shared/types.js';

export const loopToolDefinition: ToolDefinition = {
    name: 'loop',
    description: 'Run the Task Master loop to autonomously work through tasks',
    parameters: z.object({
        projectRoot: z.string().describe('Absolute path to the project root'),
        iterations: z.number().optional().describe('Maximum number of iterations'),
        prompt: z.string().optional().describe('Prompt preset (default: "default")'),
        progressFile: z.string().optional().describe('Path to write progress output'),
    }),
    execute: withToolContext(async ({ log, tmCore, args }) => {
        log.info('Starting Task Master loop...');

        const result = await tmCore.loop.run({
            projectRoot: args.projectRoot,
            iterations: args.iterations,
            prompt: args.prompt,
            progressFile: args.progressFile,
            callbacks: {
                onError: (message, severity) => {
                    if (severity === 'warning') {
                        log.warn(message);
                    } else {
                        log.error(message);
                    }
                },
                onIterationEnd: (iteration) => {
                    log.info(
                        `Iteration ${iteration.iteration} completed: ${iteration.status}`
                    );
                },
            },
        });

        return handleApiResult({
            result: { success: true, data: result },
            log,
            projectRoot: args.projectRoot,
        });
    }),
};
```

Note: Verify the exact `ToolDefinition` / `withToolContext` / `handleApiResult` call shapes against `apps/mcp/src/tools/autopilot/start.tool.ts` before finalising — use it as the authoritative reference.

#### New index file for loop tools
**File:** `apps/mcp/src/tools/loop/index.ts` *(create new)*

```ts
export { loopToolDefinition } from './loop.tool.js';
```

#### Register in MCP tools index
**File:** `apps/mcp/src/tools/index.ts` (or wherever autopilot/tasks tools are registered)
**Change:** Import and add `loopToolDefinition` to the tools array/map. Mirror the pattern used for autopilot tools exactly.

```ts
// Add alongside existing imports:
export { loopToolDefinition } from './loop/index.js';

// And add loopToolDefinition to the registration array/map where other tools are registered.
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] MCP app builds: `npm run build -w @tm/mcp`
- [x] No missing export errors in `apps/mcp/src/tools/index.ts`

---

## Manual Verification (run after ALL phases are complete)

- [ ] `task-master loop --iterations 2` (normal mode): terminal shows banners, iteration separators, iteration output via `onOutput`. No change from before.
- [ ] `task-master loop --verbose --iterations 2 --progress-file /tmp/loop-progress.md`: terminal shows only banners and always-on output (no streaming text, no tool-use lines, no Loop Start/End timestamps). Progress file contains `## Iteration 1` blocks with tool-call breakdown, token usage, and final result.
- [ ] `task-master loop --trace --iterations 2 --progress-file /tmp/loop-progress.md`: terminal shows only always-on output (no `[trace] LLM input`, no `[trace] tool input/result`, no `[trace] LLM final output`). Progress file contains verbose content plus `### LLM input`, per-tool input, and per-tool result blocks.
- [ ] MCP loop tool: run loop via MCP client and confirm `log.info` messages appear per iteration, `log.error`/`log.warn` appear on error.

## Manual Testing Steps
1. Build all: `npm run turbo:build`
2. Run `task-master loop --help` — confirm `--verbose` and `--trace` flags still present
3. Run `task-master loop --verbose --iterations 1 --progress-file /tmp/v.md` against a project with tasks; confirm terminal is quiet (no text streaming), then `cat /tmp/v.md` and confirm iteration summary block is present
4. Run `task-master loop --trace --iterations 1 --progress-file /tmp/t.md`; confirm terminal is quiet; confirm `/tmp/t.md` has `### LLM input` and per-tool blocks in addition to the summary
5. Run without flags: confirm `onOutput` still prints iteration result as before

## References
- Original ticket: `tag-ea3aac`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md`
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md`
- LoopOutputCallbacks interface: `packages/tm-core/src/modules/loop/types.ts:60–102`
- LoopConfig type: `packages/tm-core/src/modules/loop/types.ts:107–166`
- Loop service buffer allocation: `packages/tm-core/src/modules/loop/services/loop.service.ts:650`
- Iteration-summary block: `packages/tm-core/src/modules/loop/services/loop.service.ts:817–838`
- CLI createOutputCallbacks: `apps/cli/src/commands/loop.command.ts:192–333`
- MCP tool pattern reference: `apps/mcp/src/tools/autopilot/start.tool.ts`
- withToolContext / handleApiResult: `apps/mcp/src/shared/utils.ts:390–439`
