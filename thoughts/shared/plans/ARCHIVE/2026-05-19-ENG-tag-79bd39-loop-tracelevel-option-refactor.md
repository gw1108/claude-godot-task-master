# Loop `--tracelevel` Option Refactor Implementation Plan

## Overview
Replace the two boolean flags `--verbose`/`--trace` on `task-master loop` with a single ordered enum `--tracelevel <none|verbose|trace>`. No runtime behavior changes — this is a pure surface rename that makes the hierarchy explicit at the type, CLI, and gate-site levels.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md`
- Research: `thoughts/shared/research/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md`

## Current State
- `LoopConfig` (`packages/tm-core/src/modules/loop/types.ts:139,152`) has two optional booleans: `verbose?: boolean` and `trace?: boolean`.
- `LoopDomain.buildConfig()` (`loop-domain.ts:196-197`) normalizes both to `false` independently.
- `loop.service.ts:162` derives `const streaming = !!(config.verbose || config.trace)` then passes `streaming` and `config.trace` as separate params through `executeIteration` → `executeVerboseIteration` → `handleStreamEvent` (10+ gate sites total).
- `loop.command.ts:21-31` has `LoopCommandOptions` with `verbose?: boolean` and `trace?: boolean`; declares `-v, --verbose` and `--trace` options; computes `effectiveVerbose = verbose || trace` before building `Partial<LoopConfig>`.
- `createOutputCallbacks(verbose: boolean, trace = false)` at `loop.command.ts:192` is the CLI callback factory gated on both booleans.
- No Commander `.choices()` usage exists anywhere in `apps/cli/src/`.

## Desired End State
- New type `LoopTraceLevel = 'none' | 'verbose' | 'trace'` exported from `loop/types.ts`, `loop/index.ts`, and `packages/tm-core/src/index.ts`.
- New internal helper file `packages/tm-core/src/modules/loop/services/trace-level.ts` with `TRACE_LEVEL_WEIGHTS` and `atLeast()` (not exported from any barrel).
- `LoopConfig` has `traceLevel?: LoopTraceLevel` and no `verbose`/`trace` fields.
- `LoopDomain.buildConfig()` normalizes `traceLevel ?? 'none'` once.
- All ~10 gate sites in `loop.service.ts` use `atLeast(level, 'verbose')` and `atLeast(level, 'trace')`.
- `LoopCommandOptions` has `tracelevel?: LoopTraceLevel`; CLI declares `--tracelevel <level>` with `.choices(['none', 'verbose', 'trace'])` and default `'none'`; `effectiveVerbose` deleted.
- `createOutputCallbacks` refactored to accept `level: LoopTraceLevel`.
- All tests updated; error message assertions use `--tracelevel verbose`/`--tracelevel trace`; `mockLoopRun` assertions use `traceLevel: 'trace'` etc.
- A new changeset file documents the CLI rename.

## What We Are NOT Doing
- No runtime behavior changes — mapping `'none'→(false,false)`, `'verbose'→(true,false)`, `'trace'→(true,true)` is exhaustive and identical to current behavior.
- No changes to `docs/configuration.md` `verbose` field (unrelated general config knob, not the loop CLI surface).
- No changes to `scripts/modules/config-manager.js:441` `verbose: z.boolean()` (unrelated general config schema).
- No changes to the spawned Claude CLI `--verbose` flag at `loop.service.ts:916-919` (the subprocess's own flag, kept as-is).
- No changes to autopilot `verbose?: boolean` in `apps/cli/src/commands/autopilot/index.ts:22` (unrelated command).
- No new trace levels (e.g. `'debug'`).
- No case-insensitive handling for `--tracelevel` values.
- No MCP loop tooling.

---

## Phase 1: Add `LoopTraceLevel` type and `atLeast()` helper to `@tm/core`

### Goal
Introduce the new type and the internal ordering helper so they are available for subsequent phases. Barrels are updated so the type is publicly exported from the package root.

### Changes

#### 1a. Add `LoopTraceLevel` to types
**File:** `packages/tm-core/src/modules/loop/types.ts`
**Change:** Add the new type union before the `LoopConfig` interface.

```ts
// Add before the LoopConfig interface definition
export type LoopTraceLevel = 'none' | 'verbose' | 'trace';
```

#### 1b. Create internal `trace-level.ts` helper
**File:** `packages/tm-core/src/modules/loop/services/trace-level.ts` *(new file)*
**Change:** Create with the weight map and `atLeast` helper. Not exported from any barrel.

```ts
import type { LoopTraceLevel } from '../types.js';

export const TRACE_LEVEL_WEIGHTS = {
  none: 0,
  verbose: 1,
  trace: 2,
} as const satisfies Record<LoopTraceLevel, number>;

export function atLeast(level: LoopTraceLevel, threshold: LoopTraceLevel): boolean {
  return TRACE_LEVEL_WEIGHTS[level] >= TRACE_LEVEL_WEIGHTS[threshold];
}
```

#### 1c. Export `LoopTraceLevel` from the loop module barrel
**File:** `packages/tm-core/src/modules/loop/index.ts`
**Change:** Add `LoopTraceLevel` to the existing `export type { ... } from './types.js'` block (currently lines 14–20).

```ts
export type {
    LoopPreset,
    LoopConfig,
    LoopIteration,
    LoopResult,
    LoopOutputCallbacks,
    LoopTraceLevel,           // ← add this line
} from './types.js';
```

#### 1d. Export `LoopTraceLevel` from the `@tm/core` root barrel
**File:** `packages/tm-core/src/index.ts`
**Change:** Add `LoopTraceLevel` to the existing loop type re-export block (currently lines 154–160).

```ts
export type {
    LoopPreset,
    LoopConfig,
    LoopIteration,
    LoopResult,
    LoopOutputCallbacks,
    LoopTraceLevel,           // ← add this line
} from './modules/loop/index.js';
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass (nothing touches the new symbol yet): `npm run test -w @tm/core`

---

## Phase 2: Replace `LoopConfig` booleans and update `buildConfig()`

### Goal
Swap `verbose`/`trace` out of `LoopConfig` for `traceLevel?: LoopTraceLevel` and update `LoopDomain.buildConfig()` to normalize it once at the entry point.

### Changes

#### 2a. Update `LoopConfig` interface
**File:** `packages/tm-core/src/modules/loop/types.ts`
**Change:** Remove the `verbose?` and `trace?` fields; add `traceLevel?: LoopTraceLevel`. The JSDoc for both booleans can be consolidated into the new field.

```ts
export interface LoopConfig {
  iterations: number;
  prompt: LoopPreset | string;
  progressFile: string;
  sleepSeconds: number;
  tag?: string;
  sandbox?: boolean;
  includeOutput?: boolean;
  /**
   * Verbosity level for loop output (default: 'none').
   * 'verbose' streams Claude's work in real-time (NOT compatible with sandbox=true).
   * 'trace' additionally emits onPromptSent, onToolInput, onToolResult, onIterationSummary
   * and writes trace details to the progress file.
   * NOT compatible with sandbox=true.
   */
  traceLevel?: LoopTraceLevel;
  brief?: string;
  callbacks?: LoopOutputCallbacks;
}
```

#### 2b. Update `LoopDomain.buildConfig()`
**File:** `packages/tm-core/src/modules/loop/loop-domain.ts`
**Change:** Replace the two boolean normalization lines (196-197) with a single `traceLevel` normalization.

```ts
private buildConfig(partial: Partial<LoopConfig>): LoopConfig {
    return {
        iterations: partial.iterations ?? 10,
        prompt: partial.prompt ?? 'default',
        progressFile:
            partial.progressFile ??
            path.join(this.projectRoot, '.taskmaster', 'progress.txt'),
        sleepSeconds: partial.sleepSeconds ?? 5,
        tag: partial.tag,
        sandbox: partial.sandbox ?? false,
        includeOutput: partial.includeOutput ?? false,
        traceLevel: partial.traceLevel ?? 'none',   // ← replaces verbose/trace lines
        brief: partial.brief,
        callbacks: partial.callbacks
    };
}
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Format check passes: `npm run format-check`

---

## Phase 3: Refactor `loop.service.ts` gate sites

### Goal
Rewrite all ~10 gate sites in the service to derive `level` once at the top of `run()` and use `atLeast(level, ...)` everywhere. Update private method signatures to thread `level: LoopTraceLevel` instead of separate `verbose`/`trace` booleans.

### Changes

#### 3a. Import `atLeast` at top of service
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Add import for the helper (import relative path since it's in the same `services/` folder).

```ts
import { atLeast } from './trace-level.js';
```

#### 3b. Rewrite `run()` top section — normalize `level`, replace `streaming` derivation, and fix sandbox check
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:162-214`
**Change:** Replace the `streaming` const and sandbox check.

```ts
// Before (lines 162-169):
const streaming = !!(config.verbose || config.trace);
if (streaming && config.sandbox) {
    const flag = config.trace ? '--trace' : '--verbose';
    const errorMsg = `${flag} mode is not supported with sandbox mode...`;
    ...
}

// After:
const level = config.traceLevel ?? 'none';
const streaming = atLeast(level, 'verbose');
if (streaming && config.sandbox) {
    const errorMsg = `--tracelevel ${level} is not supported with sandbox mode. Use --tracelevel ${level} without --sandbox, or set --tracelevel none.`;
    ...
}
```

#### 3c. Replace `config.trace` gate before `executeIteration` call (line 204)
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:204`

```ts
// Before:
if (config.trace) {
    config.callbacks?.onPromptSent?.(i, prompt);
}

// After:
if (atLeast(level, 'trace')) {
    config.callbacks?.onPromptSent?.(i, prompt);
}
```

#### 3d. Update `executeIteration` call site to pass `level` instead of `streaming`/`config.trace`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:213-214`

```ts
// Before:
streaming,
config.trace ?? false,

// After:
level,
```

#### 3e. Update `executeIteration` private signature and internal branch
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:552-565`

```ts
// Before:
private async executeIteration(
    prompt: string,
    iterationNum: number,
    sandbox: boolean,
    includeOutput = false,
    verbose = false,
    trace = false,
    callbacks?: LoopOutputCallbacks,
    progressFile?: string
): Promise<LoopIteration> {
    if (verbose) {
        return this.executeVerboseIteration(
            prompt, iterationNum, command, sandbox, includeOutput,
            trace, startTime, callbacks, progressFile
        );
    }
    ...
}

// After:
private async executeIteration(
    prompt: string,
    iterationNum: number,
    sandbox: boolean,
    includeOutput = false,
    level: LoopTraceLevel = 'none',
    callbacks?: LoopOutputCallbacks,
    progressFile?: string
): Promise<LoopIteration> {
    if (atLeast(level, 'verbose')) {
        return this.executeVerboseIteration(
            prompt, iterationNum, command, sandbox, includeOutput,
            level, startTime, callbacks, progressFile
        );
    }
    ...
}
```

*(Add `import type { LoopTraceLevel } from '../types.js';` if not already present.)*

#### 3f. Update `executeVerboseIteration` signature and internal trace gates
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:~640-839`
**Change:** Replace `trace: boolean` parameter with `level: LoopTraceLevel`; rewrite all trace gates.

```ts
// Before signature:
private async executeVerboseIteration(
    ...
    trace: boolean,
    ...
): Promise<LoopIteration>

// After:
private async executeVerboseIteration(
    ...
    level: LoopTraceLevel,
    ...
): Promise<LoopIteration>
```

Gate rewrites inside the method body:

```ts
// Line ~650: trace buffer allocation
// Before: const traceLines: string[] | undefined = trace && progressFile ? [] : undefined;
// After:
const traceLines: string[] | undefined = atLeast(level, 'trace') && progressFile ? [] : undefined;

// Line ~700: handleStreamEvent call — remove trace param, pass level
// Before: this.handleStreamEvent(event, callbacks, trace, toolCallCounts, traceLines)
// After:  this.handleStreamEvent(event, callbacks, level, toolCallCounts, traceLines)

// Lines ~708-714: token usage gate
// Before: if (trace) { const usage = this.extractTokenUsage(event); ... }
// After:  if (atLeast(level, 'trace')) { const usage = this.extractTokenUsage(event); ... }

// Lines ~806-814: iteration summary gate
// Before: if (trace && callbacks?.onIterationSummary) {
// After:  if (atLeast(level, 'trace') && callbacks?.onIterationSummary) {
```

#### 3g. Update `handleStreamEvent` signature and internal trace gates
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:~960-1010`
**Change:** Replace `trace = false` parameter with `level: LoopTraceLevel = 'none'`; rewrite gates.

```ts
// Before signature:
private handleStreamEvent(event, callbacks, trace = false, toolCallCounts, traceLines)

// After:
private handleStreamEvent(event, callbacks, level: LoopTraceLevel = 'none', toolCallCounts, traceLines)

// Line ~981: tool input trace gate
// Before: if (trace) { toolCallCounts?.set(...); callbacks?.onToolInput?.(...); traceLines?.push(...); }
// After:  if (atLeast(level, 'trace')) { ... }

// Line ~1000: tool result trace gate
// Before: if (trace && event.type === 'user') {
// After:  if (atLeast(level, 'trace') && event.type === 'user') {
```

#### 3h. Update `buildCommandArgs` — no change needed for the method signature
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:906-919`
**Change:** The call site passes the derived `streaming` boolean (still a boolean from `atLeast`), so the signature `buildCommandArgs(prompt: string, sandbox: boolean, verbose: boolean)` is unchanged. The spawned subprocess `--verbose` flag inside this method is explicitly out of scope.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for core: `npm run test -w @tm/core` (loop.service: 70/70)

---

## Phase 4: Update CLI — replace `--verbose`/`--trace` with `--tracelevel`

### Goal
Update the CLI layer to declare `--tracelevel` with Commander `.choices()`, remove `effectiveVerbose`, and refactor `createOutputCallbacks` to accept `level: LoopTraceLevel`.

### Changes

#### 4a. Update `LoopCommandOptions` interface
**File:** `apps/cli/src/commands/loop.command.ts:21-31`
**Change:** Replace `verbose?: boolean` and `trace?: boolean` with `tracelevel?: LoopTraceLevel`.

```ts
import type { LoopTraceLevel } from '@tm/core';

export interface LoopCommandOptions {
    iterations?: string;
    prompt?: string;
    progressFile?: string;
    tag?: string;
    project?: string;
    sandbox?: boolean;
    output?: boolean;
    tracelevel?: LoopTraceLevel;    // ← replaces verbose and trace
}
```

#### 4b. Replace CLI option declarations
**File:** `apps/cli/src/commands/loop.command.ts:61-65`
**Change:** Remove the two boolean options; add the single `--tracelevel` option with `.choices()`.

```ts
// Remove:
.option('-v, --verbose', "Show Claude's work in real-time")
.option(
    '--trace',
    'Show full LLM input/output and tool-call details (implies --verbose)'
)

// Add:
.option(
    '--tracelevel <level>',
    'Loop verbosity: none, verbose, or trace (trace includes verbose output and writes details to the progress file)',
    'none'
)
.choices(['none', 'verbose', 'trace'])
```

#### 4c. Update `execute()` — remove `effectiveVerbose`, pass `traceLevel` directly
**File:** `apps/cli/src/commands/loop.command.ts:129-145`
**Change:** Remove the `verbose`/`trace`/`effectiveVerbose` derivation block; pass `traceLevel` verbatim.

```ts
// Before:
const verbose = options.verbose ?? false;
const trace = options.trace ?? false;
const effectiveVerbose = verbose || trace;
const config: Partial<LoopConfig> = {
    ...
    verbose: effectiveVerbose,
    trace,
    callbacks: this.createOutputCallbacks(effectiveVerbose, trace)
};

// After:
const traceLevel = options.tracelevel ?? 'none';
const config: Partial<LoopConfig> = {
    ...
    traceLevel,
    callbacks: this.createOutputCallbacks(traceLevel)
};
```

#### 4d. Refactor `createOutputCallbacks` to accept `level: LoopTraceLevel`
**File:** `apps/cli/src/commands/loop.command.ts:192`
**Change:** Import `atLeast` from `@tm/core` (it is internal to the loop module, so the CLI should use `atLeast` from the same internal import path, OR derive the two booleans from `atLeast` locally — since `atLeast` is not exported from the barrel, the CLI should derive them from the level directly).

**Decision:** Because `atLeast` is internal (`trace-level.ts` is not exported from the barrel), the CLI derives equivalent booleans using a local inline comparison. This keeps the design rule (CLI is thin, no business logic) without requiring a barrel export.

```ts
private createOutputCallbacks(level: LoopTraceLevel): LoopOutputCallbacks {
    const verbose = level === 'verbose' || level === 'trace';
    const trace = level === 'trace';

    // rest of the method body is unchanged — `verbose` and `trace` local booleans
    // gate the same if-blocks as before
    ...
}
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for CLI: `npm run test -w @tm/cli` (loop: 76/76)

---

## Phase 5: Update all test files

### Goal
Bring all test files into alignment with the new API surface, fixing type errors and updating assertions.

### Changes

#### 5a. `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`

**`LoopConfig` field replacements:**
- All `verbose: true` → `traceLevel: 'verbose'`
- All `trace: true` → `traceLevel: 'trace'`
- `sandbox: true, trace: true` pairs → `sandbox: true, traceLevel: 'trace'`
- `sandbox: true, verbose: true` pairs → `sandbox: true, traceLevel: 'verbose'`

**Error message assertion rewrites (lines 647, 664):**
```ts
// Before:
expect(result.errorMessage).toContain('--trace');      // line 647
expect(result.errorMessage).toContain('--verbose');    // line 664

// After:
expect(result.errorMessage).toContain('--tracelevel trace');    // sandbox+trace conflict
expect(result.errorMessage).toContain('--tracelevel verbose');  // sandbox+verbose conflict
```

**All other trace-mode tests (lines 858-1006) that use `trace: true`:** replace with `traceLevel: 'trace'`. No assertion text changes needed for these — they test `appendFile` call contents, not flag names.

#### 5b. `apps/cli/src/commands/loop.command.spec.ts`

**`execute()` options object replacements:**
- `{ verbose: true }` → `{ tracelevel: 'verbose' }`
- `{ trace: true }` → `{ tracelevel: 'trace' }`
- Default case `{ verbose: false, trace: false }` → `{}` (or `{ tracelevel: 'none' }`)

**`mockLoopRun` assertion rewrites:**
```ts
// Before (line 581-586): trace: true implies verbose: true
expect(mockLoopRun).toHaveBeenCalledWith(
    expect.objectContaining({ trace: true, verbose: true })
);

// After:
expect(mockLoopRun).toHaveBeenCalledWith(
    expect.objectContaining({ traceLevel: 'trace' })
);

// Before (lines 595-601): default
expect(mockLoopRun).toHaveBeenCalledWith(
    expect.objectContaining({ trace: false, verbose: false })
);
// After:
expect(mockLoopRun).toHaveBeenCalledWith(
    expect.objectContaining({ traceLevel: 'none' })
);

// Before (lines 611-617): plain verbose without trace
expect(mockLoopRun).toHaveBeenCalledWith(
    expect.objectContaining({ trace: false, verbose: true })
);
// After:
expect(mockLoopRun).toHaveBeenCalledWith(
    expect.objectContaining({ traceLevel: 'verbose' })
);
```

**`createCallbacks` helper signature (lines 313-342, 620-735):**
The local test helper that wraps `createOutputCallbacks` currently passes `(verbose, trace)` booleans. Update to pass `level: LoopTraceLevel`:
```ts
// Before: createCallbacks(false) / createCallbacks(true) / createCallbacks(false, false) / createCallbacks(true, true)
// After:  createCallbacks('none') / createCallbacks('verbose') / createCallbacks('none') / createCallbacks('trace')
```

#### 5c. `packages/tm-core/tests/integration/loop/loop-core-exports.test.ts`

**Add `LoopTraceLevel` to the exports verification:**
```ts
// In the block that verifies LoopConfig-related exports (around lines 60-75):
expect(typeof loopTypes.LoopTraceLevel).toBe('undefined'); // it's a type, not a value
// OR verify it is part of the exported types list if the test does string-based checking
```

*(Check the exact assertion style used in this file — if it verifies by importing and checking at runtime, no change is needed since type-only exports disappear at runtime. If it checks via string-based export enumeration, add `'LoopTraceLevel'` to the expected list.)*

#### 5d. `packages/tm-core/src/modules/loop/loop-domain.spec.ts` and `types.spec.ts`

These files do not set `verbose` or `trace` on their `LoopConfig` instances (confirmed by research), so they will not need changes unless the type shape change itself triggers a TypeScript inference error. Verify after Phase 2 typecheck.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for core: `npm run test -w @tm/core` (loop.service: 70/70; loop-core-exports, loop-domain, types: all pass)
- [x] Unit tests pass for CLI: `npm run test -w @tm/cli` (loop: 76/76)
- [x] Format check passes: `npm run format-check`

---

## Phase 6: Add changeset

### Goal
Document the user-facing CLI flag rename in a changeset so it appears in the release notes.

### Changes

#### 6a. Create changeset
**Run:** `npx changeset`
**Select:** `@tm/cli` as the changed package; bump type: `minor` (new flag, old flags removed).
**Body (user-facing):**

> `task-master loop` now uses a single `--tracelevel <none|verbose|trace>` option instead of the two separate `--verbose` and `--trace` flags. `--tracelevel verbose` matches the old `--verbose` behavior; `--tracelevel trace` matches the old `--trace` behavior (which also implied verbose streaming). The default is `--tracelevel none`.

*(Alternatively, write the `.changeset/<name>.md` file manually if `npx changeset` is interactive.)*

### Automated Verification
- [x] A new `.changeset/loop-tracelevel-option.md` file exists with the correct bump

---

## Manual Verification (run after ALL phases are complete)

- [ ] `task-master loop --tracelevel verbose --iterations 1 --prompt "say hi"` — runs and streams output in real-time (same as old `--verbose`)
- [ ] `task-master loop --tracelevel trace --iterations 1 --prompt "say hi"` — streams output and writes trace events to the progress file (same as old `--trace`)
- [ ] `task-master loop --iterations 1 --prompt "say hi"` — silent output (same as old default with no flags)
- [ ] `task-master loop --tracelevel verbose --sandbox --iterations 1 --prompt "say hi"` — exits with error message containing `--tracelevel verbose`
- [ ] `task-master loop --tracelevel trace --sandbox --iterations 1 --prompt "say hi"` — exits with error message containing `--tracelevel trace`
- [ ] `task-master loop --tracelevel foo` — exits with Commander parse-time error: `error: option '--tracelevel <level>' argument 'foo' is invalid. Allowed choices are none, verbose, trace.`
- [ ] `task-master loop --verbose` — exits with `error: unknown option '--verbose'` (old flag removed)
- [ ] `task-master loop --trace` — exits with `error: unknown option '--trace'` (old flag removed)

## Manual Testing Steps
1. `npm run turbo:build` from repo root
2. Run each manual verification scenario above using the locally built CLI
3. Inspect the progress file after a `--tracelevel trace` run to confirm trace events are written

## References
- Original ticket: tag-79bd39
- Research: `thoughts/shared/research/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md`
- Design: `thoughts/shared/claude-code-design/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md`
- `LoopConfig` type: `packages/tm-core/src/modules/loop/types.ts:107-166`
- Gate sites: `packages/tm-core/src/modules/loop/services/loop.service.ts:162-1010`
- CLI command: `apps/cli/src/commands/loop.command.ts:21-333`
- Loop module barrel: `packages/tm-core/src/modules/loop/index.ts`
- Core root barrel: `packages/tm-core/src/index.ts:154-161`
- Test files: `loop.service.spec.ts`, `loop.command.spec.ts`, `loop-core-exports.test.ts`
