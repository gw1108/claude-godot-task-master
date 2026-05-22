# Per-Iteration Loop Logging and Cumulative Totals Implementation Plan

## Overview
Transform `LoopService`'s progress file output from a single flat log into a three-file system: a high-signal compact ledger in `progress.txt`, verbose per-iteration sibling files (`<stem>.iter-NN<ext>`), and a once-per-run cumulative totals file (`<stem>.totals<ext>`). Adds tool-call classification (task-master / writes / non-writes) and estimated context usage (with `% of 1M` for Opus models) to iteration summaries.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md`

## Current State
- **`loop.service.ts`** (1099 lines) — all logic lives here
  - `initProgressFile` (line 339): appends header block to `config.progressFile`
  - `appendFinalSummary` (line 363): appends footer block to `config.progressFile`
  - `buildIterationSummaryBlock` (line 403): builds markdown summary with per-tool list and token block
  - `tagEntry` (line 454): prefixes entries with `[VERBOSE]`/`[TRACE]` tags
  - `extractTokenUsage` (line 526): parses token usage from stream events
  - `executeVerboseIteration` (lines 686–914): async iteration runner, manages `iterationFileLines` buffer and `toolCallCounts` map
  - `processLine` closure (line 744): routes parsed stream events; handles `assistant`, `user`, `result` event types; no `system` handler exists
  - `handleStreamEvent` (line 1022): populates `toolCallCounts` on `tool_use` blocks
  - Buffer flush at close (lines 874–899): `appendFile` of the entire `iterationFileLines` buffer to `config.progressFile`
  - `finalize()` (line 271): calls `appendFinalSummary`, fires `onLoopEnd`, returns `LoopResult`
- **`types.ts`** — `onIterationSummary` payload at lines 97–104 has `toolCalls`, `finalResult?`, `tokenUsage?` only
- **No** `system` event model-ID capture exists anywhere in the service

## Desired End State
- `progress.txt`: one compact line per iteration (iteration number, status, tool-call classification counts, context tokens + % of 1M when applicable)
- `<stem>.iter-NN<ext>`: per-iteration sibling file containing full verbose/trace buffer (overwrite each run)
- `<stem>.totals<ext>`: written once at `finalize()`, cumulative aggregates header + per-iteration markdown table
- `buildIterationSummaryBlock` output includes: new classification block (`Tool calls: N total / Task-master / Writes / Non-writes`), renamed per-tool list (`Tool calls by name:`), new `Context:` bullet with token count and `(X% of 1M)` when Opus
- `onIterationSummary` payload extended with `totalToolCalls`, `taskMasterToolCalls`, `writeToolCalls`, `nonWriteToolCalls`, `estimatedContext`, `percentOf1M?`, `modelId?`
- `traceLevel = 'none'`: no per-iteration files and no totals file written (existing none-mode behavior preserved)

## What We Are NOT Doing
- Splitting the existing `Tokens:` bullet block — it remains structurally unchanged
- Adding any new CLI flag, MCP parameter, or `LoopConfig` field
- Promoting `IterationTelemetry` to a public exported type
- Detecting `task-master ...` shell invocations through `Bash` — only `mcp__task-master-ai__*` prefix counts
- Touching `LoopDomain`, `apps/cli`, `apps/mcp` — the payload widening is additive and backward-compatible
- Changing console output behavior (silence/trace prefixes unchanged)
- Run-id suffixing or collision-refuse modes for per-iteration files

---

## Phase 1: Private Helpers, Classification, and Summary Block Enhancements

### Goal
Add all private helper methods and extend `buildIterationSummaryBlock` so the richer summary format is ready before touching the file-routing logic.

### Changes

#### Internal telemetry type + service field
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

**After the `IterationFileLine` type (line 26), add:**
```ts
type IterationTelemetry = {
  iterationNum: number;
  totalToolCalls: number;
  taskMasterToolCalls: number;
  writeToolCalls: number;
  nonWriteToolCalls: number;
  tokenUsage?: LoopTokenUsage;
  estimatedContext: number;
  percentOf1M?: number;
  modelId?: string;
  status: LoopIteration['status'];
  duration?: number;
};
```

**After `private _isRunning = false` (line 35), add:**
```ts
private iterationTelemetry: IterationTelemetry[] = [];
```

#### Tool-call classification — static set + private method
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

**After the class opening (before the constructor, line ~36), add static set:**
```ts
private static readonly WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit'
]);
```

**After `extractTokenUsage` (line 568), add:**
```ts
private classifyToolCalls(counts: Map<string, number>): {
  totalToolCalls: number;
  taskMasterToolCalls: number;
  writeToolCalls: number;
  nonWriteToolCalls: number;
} {
  let total = 0, tm = 0, writes = 0;
  for (const [name, count] of counts) {
    total += count;
    if (name.startsWith('mcp__task-master-ai__')) tm += count;
    if (LoopService.WRITE_TOOLS.has(name)) writes += count;
  }
  return {
    totalToolCalls: total,
    taskMasterToolCalls: tm,
    writeToolCalls: writes,
    nonWriteToolCalls: total - writes,
  };
}
```

#### File-path helpers — sibling and totals
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

**After `classifyToolCalls`, add:**
```ts
private iterationFilePath(
  progressFile: string,
  iterationNum: number,
  totalIterations: number
): string {
  const padWidth = String(totalIterations).length;
  const padded = String(iterationNum).padStart(padWidth, '0');
  const p = path.parse(progressFile);
  return path.format({ dir: p.dir, name: `${p.name}.iter-${padded}`, ext: p.ext });
}

private totalsFilePath(progressFile: string): string {
  const p = path.parse(progressFile);
  return path.format({ dir: p.dir, name: `${p.name}.totals`, ext: p.ext });
}
```

#### Model ID capture — `system` event branch in `processLine`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

**In `executeVerboseIteration`, near where `tokenUsage` is declared (line ~741), add:**
```ts
let modelId: string | undefined;
```

**In `processLine`, after the `result` event block (lines 766–772), add:**
```ts
if (event.type === 'system' && typeof (event as Record<string, unknown>).model === 'string') {
  modelId = (event as Record<string, unknown>).model as string;
}
```

#### Extend `buildIterationSummaryBlock` signature and output
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Lines 403–452 — extend the `summary` parameter type and the rendered output

Extend the parameter object to add:
```ts
totalToolCalls?: number;
taskMasterToolCalls?: number;
writeToolCalls?: number;
nonWriteToolCalls?: number;
estimatedContext?: number;
percentOf1M?: number;
modelId?: string;
```

Replace the existing `- Tool calls:` section with:
```ts
if (summary.totalToolCalls !== undefined) {
  lines.push(`- Tool calls: ${summary.totalToolCalls.toLocaleString('en-US')} total`);
  if (summary.taskMasterToolCalls !== undefined)
    lines.push(`  - Task-master: ${summary.taskMasterToolCalls.toLocaleString('en-US')}`);
  if (summary.writeToolCalls !== undefined)
    lines.push(`  - Writes: ${summary.writeToolCalls.toLocaleString('en-US')}`);
  if (summary.nonWriteToolCalls !== undefined)
    lines.push(`  - Non-writes: ${summary.nonWriteToolCalls.toLocaleString('en-US')}`);
}

// Rename existing per-tool list header from "- Tool calls:" to "- Tool calls by name:"
if (summary.toolCalls.length > 0) {
  lines.push('- Tool calls by name:');
  for (const tc of summary.toolCalls) {
    lines.push(`  - ${tc.name}: ${tc.count.toLocaleString('en-US')}`);
  }
}
```

After the `Tokens:` block, add:
```ts
if (summary.estimatedContext !== undefined) {
  const pct = summary.percentOf1M !== undefined
    ? ` (${summary.percentOf1M.toFixed(1)}% of 1M)`
    : '';
  lines.push(`- Context: ${summary.estimatedContext.toLocaleString('en-US')} tokens${pct}`);
}
```

Update existing `toLocaleString()` calls in the Tokens block to pass `'en-US'` explicitly for consistency.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass: `npm run test -w @tm/core`
- [ ] Format check passes: `npm run format-check`

---

## Phase 2: File-Routing Seam and Telemetry Accumulation

### Goal
Route the per-iteration verbose buffer to `<stem>.iter-NN<ext>` (truncate-write), write only a compact line to `progress.txt`, and push an `IterationTelemetry` record into the service-level accumulator.

### Changes

#### Compact progress-line builder — new private method
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

**Add after `totalsFilePath`:**
```ts
private buildProgressLine(
  iterationNum: number,
  status: LoopIteration['status'],
  classification: { totalToolCalls: number; taskMasterToolCalls: number; writeToolCalls: number; nonWriteToolCalls: number },
  estimatedContext?: number,
  percentOf1M?: number
): string {
  const toolPart = `tools: ${classification.totalToolCalls.toLocaleString('en-US')} (TM:${classification.taskMasterToolCalls} W:${classification.writeToolCalls} NW:${classification.nonWriteToolCalls})`;
  const ctxPart = estimatedContext !== undefined
    ? ` | ctx: ${estimatedContext.toLocaleString('en-US')} tokens${percentOf1M !== undefined ? ` (${percentOf1M.toFixed(1)}% of 1M)` : ''}`
    : '';
  return `- Iter ${iterationNum}: ${status} | ${toolPart}${ctxPart}`;
}
```

#### File-routing seam — replace the buffer-flush block
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Replace the `appendFile(progressFile!, ...)` block at lines 874–899 (the entire `if (iterationFileLines)` block in the `'close'` handler) with:

```ts
if (iterationFileLines) {
  const toolCalls = Array.from(toolCallCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const classification = this.classifyToolCalls(toolCallCounts);
  const estimatedContext =
    (tokenUsage?.inputTokens ?? 0) +
    (tokenUsage?.cacheCreationInputTokens ?? 0) +
    (tokenUsage?.cacheReadInputTokens ?? 0);
  const percentOf1M =
    modelId && /opus/i.test(modelId) && tokenUsage != null
      ? (estimatedContext / 1_000_000) * 100
      : undefined;

  // Full verbose/trace block → per-iteration sibling file (truncate-write)
  iterationFileLines.push({
    level: 'verbose',
    content: this.buildIterationSummaryBlock(iterationNum, {
      toolCalls,
      finalResult: finalResult || undefined,
      ...(tokenUsage && { tokenUsage }),
      ...classification,
      estimatedContext,
      ...(percentOf1M !== undefined && { percentOf1M }),
      ...(modelId !== undefined && { modelId }),
    }),
  });
  iterationFileLines.push({ level: 'separator', content: '---' });

  const siblingPath = this.iterationFilePath(progressFile!, iterationNum, config.iterations);
  writeFile(
    siblingPath,
    iterationFileLines.map((e) => this.tagEntry(e)).join('\n\n') + '\n',
    'utf-8'
  ).catch((err: unknown) => { rejectOnce(err); });

  // Compact summary line → progress.txt (append)
  appendFile(
    progressFile!,
    this.buildProgressLine(iterationNum, /* status captured below */, classification, estimatedContext, percentOf1M) + '\n',
    'utf-8'
  ).catch((err: unknown) => { rejectOnce(err); });

  // Accumulate telemetry for totals file
  this.iterationTelemetry.push({
    iterationNum,
    ...classification,
    tokenUsage: tokenUsage ?? undefined,
    estimatedContext,
    ...(percentOf1M !== undefined && { percentOf1M }),
    ...(modelId !== undefined && { modelId }),
    status: /* LoopIteration status set later; use a placeholder or restructure */,
    duration: undefined, // set after the iteration resolves
  });
}
```

> **Note on `status`**: The `status` value is determined by `parseCompletion` which runs before the `'close'` handler resolves (captured in `finalResult` + `exitCode`). At the point of the `'close'` event, `parseCompletion` has not yet been called — it is called in `executeVerboseIteration`'s promise chain after the child closes. To capture status in the telemetry, the `IterationTelemetry` record should be finalized *after* `executeVerboseIteration` returns, in the `run()` loop at lines 211–225. The telemetry push inside the close handler should store everything except `status`/`duration`, then the caller in `run()` updates those two fields after `executeIteration` resolves.

**Implementation approach for status/duration:** Maintain a `Map<number, IterationTelemetry>` keyed by iteration number, or use a simpler pattern: push a partial record inside the close handler, then in `run()` after `executeIteration` returns, find the last telemetry entry and patch `status` and `duration` from the returned `LoopIteration`.

```ts
// In run() loop, after executeIteration returns (line ~224):
const telemetry = this.iterationTelemetry.find(t => t.iterationNum === i);
if (telemetry) {
  telemetry.status = iteration.status;
  telemetry.duration = iteration.duration;
}
```

#### Reset `iterationTelemetry` at run start
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** In `run()`, before the `initProgressFile` call (line 194), add:
```ts
this.iterationTelemetry = [];
```

#### Import `writeFile` from `node:fs/promises`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** The file already imports `appendFile` and `mkdir` from `node:fs/promises` (check exact import location). Add `writeFile` to that import:
```ts
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass: `npm run test -w @tm/core`
- [ ] Format check passes: `npm run format-check`
- [x] After a verbose-mode run, `progress.txt` contains only compact `- Iter N:` lines (no `## Iteration N` blocks)
- [x] After a verbose-mode run, `progress.iter-01.txt` (or equivalent padding) exists and contains the full verbose block

---

## Phase 3: `onIterationSummary` Payload Extension and Cumulative Totals File

### Goal
Widen the `onIterationSummary` type in `types.ts` with the new classification fields, update the callback invocation in `loop.service.ts`, and add the `writeTotalsFile()` method wired into `finalize()`.

### Changes

#### Widen `onIterationSummary` payload — types.ts
**File:** `packages/tm-core/src/modules/loop/types.ts`
**Change:** Lines 97–104 — extend the `summary` parameter with optional fields:

```ts
onIterationSummary?: (
  iteration: number,
  summary: {
    toolCalls: LoopToolCallSummary[];
    finalResult?: string;
    tokenUsage?: LoopTokenUsage;
    totalToolCalls?: number;
    taskMasterToolCalls?: number;
    writeToolCalls?: number;
    nonWriteToolCalls?: number;
    estimatedContext?: number;
    percentOf1M?: number;
    modelId?: string;
  }
) => void;
```

All new fields are optional (`?`) so neither the CLI nor MCP needs changes.

#### Update `onIterationSummary` invocation site
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Lines 862–872 — the existing invocation fires only at `atLeast(level, 'trace')`. Extend the payload passed to the callback to include the new fields (reuse the `classification`, `estimatedContext`, `percentOf1M`, and `modelId` variables already computed in Phase 2's file-routing block):

```ts
if (atLeast(level, 'trace') && callbacks?.onIterationSummary) {
  const toolCalls = Array.from(toolCallCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  callbacks.onIterationSummary(iterationNum, {
    toolCalls,
    finalResult: finalResult || undefined,
    ...(tokenUsage && { tokenUsage }),
    totalToolCalls: classification.totalToolCalls,
    taskMasterToolCalls: classification.taskMasterToolCalls,
    writeToolCalls: classification.writeToolCalls,
    nonWriteToolCalls: classification.nonWriteToolCalls,
    estimatedContext,
    ...(percentOf1M !== undefined && { percentOf1M }),
    ...(modelId !== undefined && { modelId }),
  });
}
```

> **Refactor note:** The `classification`, `estimatedContext`, `percentOf1M`, and `modelId` variables are computed in Phase 2's file-routing block. Since both the file-routing block and the callback invocation run in the same `'close'` handler scope, extract the computations into variables before the `if (iterationFileLines)` block so they're accessible to both branches.

#### Cumulative totals file writer — new private method
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

**Add `writeTotalsFile` after `appendFinalSummary` (line ~385):**
```ts
private async writeTotalsFile(
  progressFile: string,
  result: LoopResult,
  telemetry: IterationTelemetry[]
): Promise<void> {
  if (telemetry.length === 0) return;

  let totalTools = 0, totalTM = 0, totalWrites = 0, totalNW = 0;
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0, totalTokens = 0;
  let totalContext = 0;

  for (const t of telemetry) {
    totalTools += t.totalToolCalls;
    totalTM += t.taskMasterToolCalls;
    totalWrites += t.writeToolCalls;
    totalNW += t.nonWriteToolCalls;
    totalContext += t.estimatedContext;
    if (t.tokenUsage) {
      totalInput += t.tokenUsage.inputTokens;
      totalOutput += t.tokenUsage.outputTokens;
      totalCacheWrite += t.tokenUsage.cacheCreationInputTokens ?? 0;
      totalCacheRead += t.tokenUsage.cacheReadInputTokens ?? 0;
      totalTokens += t.tokenUsage.totalTokens;
    }
  }

  const fmt = (n: number) => n.toLocaleString('en-US');
  const durationLine = typeof result.totalDuration === 'number'
    ? `- Total duration: ${fmt(result.totalDuration)}ms\n` : '';

  const tableHeader = `| Iter | Tool calls | TM | Writes | Non-writes | Total tokens | Est. context | % of 1M |`;
  const tableSep   = `|------|------------|----|----|--------|---------|-------|----------|`;
  const tableRows = telemetry.map(t => {
    const pct = t.percentOf1M !== undefined ? `${t.percentOf1M.toFixed(1)}%` : '—';
    const tok = t.tokenUsage ? fmt(t.tokenUsage.totalTokens) : '—';
    return `| ${t.iterationNum} | ${fmt(t.totalToolCalls)} | ${fmt(t.taskMasterToolCalls)} | ${fmt(t.writeToolCalls)} | ${fmt(t.nonWriteToolCalls)} | ${tok} | ${fmt(t.estimatedContext)} | ${pct} |`;
  }).join('\n');

  const content = [
    '# Loop Totals',
    `- Final status: ${result.finalStatus}`,
    `- Tasks completed: ${fmt(result.tasksCompleted)}`,
    `- Total iterations: ${fmt(result.totalIterations)}`,
    durationLine.trimEnd(),
    '',
    '## Tool Call Totals',
    `- Total: ${fmt(totalTools)}`,
    `  - Task-master: ${fmt(totalTM)}`,
    `  - Writes: ${fmt(totalWrites)}`,
    `  - Non-writes: ${fmt(totalNW)}`,
    '',
    '## Token Totals',
    `- Input: ${fmt(totalInput)}`,
    `- Output: ${fmt(totalOutput)}`,
    `- Cache read: ${fmt(totalCacheRead)}`,
    `- Cache write: ${fmt(totalCacheWrite)}`,
    `- Total: ${fmt(totalTokens)}`,
    `- Estimated context: ${fmt(totalContext)} tokens`,
    '',
    '## Per-Iteration Summary',
    tableHeader,
    tableSep,
    tableRows,
    '',
  ].join('\n');

  await writeFile(this.totalsFilePath(progressFile), content, 'utf-8');
}
```

#### Wire `writeTotalsFile` into `finalize()`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** In `finalize()` (lines 271–294), after the `appendFinalSummary` call (line 291), add:
```ts
if (this.iterationTelemetry.length > 0) {
  await this.writeTotalsFile(config.progressFile, result, this.iterationTelemetry);
}
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass: `npm run test -w @tm/core`
- [ ] Format check passes: `npm run format-check`

---

## Phase 4: Tests

### Goal
Add unit tests covering classification logic, file path helpers, the new summary block format, file routing, and the totals file — ensuring regressions are caught automatically.

### Changes

#### New test cases in `loop.service.spec.ts`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`

Add a new `describe('per-iteration file routing', ...)` block alongside the existing `describe('trace file persistence', ...)` block:

```ts
// 1. classifyToolCalls
it('classifies task-master, write, and non-write tool calls correctly', () => {
  const counts = new Map([
    ['mcp__task-master-ai__next_task', 5],
    ['Edit', 2],
    ['Write', 1],
    ['Bash', 3],
  ]);
  // Access via a test-accessible wrapper or make the method package-visible
  // Pattern: call through the public API + mock child process, or extract helper to a testable unit
});

// 2. iterationFilePath padding
it('pads iteration numbers to width of totalIterations', () => {
  // 10 iterations → 'progress.iter-01.txt' through 'progress.iter-10.txt'
  // 100 iterations → 'progress.iter-001.txt' etc.
});

// 3. totalsFilePath derivation
it('derives totals path correctly from progressFile', () => {
  // 'progress.txt' → 'progress.totals.txt'
  // '.taskmaster/loop-progress.txt' → '.taskmaster/loop-progress.totals.txt'
});

// 4. progress.txt receives compact line only (not full ## Iteration N block)
it('appends only a compact line to progress.txt after each verbose iteration', async () => {
  // Use makeMockSpawnChild factory (line 806) to emit fake stream events
  // Assert: vi.mocked(fsPromises.appendFile) calls where path === progressFile
  //         do NOT contain '## Iteration' — only '- Iter N: ...' lines
});

// 5. sibling file receives full verbose block
it('writes full verbose block to iter sibling file via writeFile', async () => {
  // Assert: vi.mocked(fsPromises.writeFile) is called with a path matching /\.iter-01\.txt$/
  //         and content contains '## Iteration 1'
});

// 6. totals file written at finalize
it('writes totals file at finalize with per-iteration markdown table', async () => {
  // Assert: vi.mocked(fsPromises.writeFile) is called with a path matching /\.totals\.txt$/
  //         and content contains '# Loop Totals' and the table header row
});

// 7. onIterationSummary receives classification fields at trace level
it('includes classification counts in onIterationSummary at trace level', async () => {
  // Assert totalToolCalls, taskMasterToolCalls, writeToolCalls, nonWriteToolCalls in payload
});

// 8. modelId captured from system event flows into percent calculation
it('includes percentOf1M when system event reports an opus model id', async () => {
  // Emit a fake system event with model: 'claude-opus-4-7'
  // Assert progress compact line contains '% of 1M'
});

// 9. none-mode: no sibling file, no totals file written
it('does not write sibling or totals files in none traceLevel mode', async () => {
  // Assert: vi.mocked(fsPromises.writeFile) never called with iter or totals path
});
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass: `npm run test -w @tm/core`
- [ ] Format check passes: `npm run format-check`
- [x] All new test cases pass (no `.only` / `.skip` markers)

---

## Manual Verification (run after ALL phases are complete)

- [ ] `traceLevel = 'verbose'` run: `progress.txt` contains one `- Iter N:` line per iteration, no `## Iteration` sections
- [ ] `traceLevel = 'verbose'` run: `progress.iter-01.txt` (or appropriate padding) exists alongside `progress.txt` with full verbose content
- [ ] `traceLevel = 'verbose'` run: `progress.totals.txt` exists with a `# Loop Totals` header, correct cumulative token counts, and a per-iteration markdown table
- [ ] Tool-call classification is correct: `mcp__task-master-ai__*` tools counted under Task-master; `Edit`/`Write` under Writes
- [ ] Context `% of 1M` appears in the summary block and progress line when model matches `/opus/i`; `—` in the totals table when model is not Opus
- [ ] `traceLevel = 'none'` run: no sibling files and no totals file created; `progress.txt` contains only the header and footer blocks (existing behavior)
- [ ] Multi-digit iteration count (>9): sibling files named `progress.iter-01.txt` through `progress.iter-10.txt` (zero-padded correctly)

## Manual Testing Steps
1. Build: `npm run turbo:build`
2. Run a short verbose loop: `task-master loop --trace-level verbose --iterations 3 --progress-file /tmp/test-progress.txt`
3. Inspect `ls /tmp/test-progress*.txt` — expect `test-progress.txt`, `test-progress.iter-01.txt`, `test-progress.iter-02.txt`, `test-progress.iter-03.txt`, `test-progress.totals.txt`
4. `cat /tmp/test-progress.txt` — confirm compact format
5. `cat /tmp/test-progress.iter-01.txt` — confirm full verbose block with new Tool calls / Context bullets
6. `cat /tmp/test-progress.totals.txt` — confirm totals file with markdown table

## References
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md`
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-e4a52d-per-iteration-loop-logging-and-cumulative-totals.md`
- Primary implementation file: `packages/tm-core/src/modules/loop/services/loop.service.ts`
- Types: `packages/tm-core/src/modules/loop/types.ts:97-104` (`onIterationSummary`), `:116-169` (`LoopConfig`), `:36-47` (`LoopTokenUsage`)
- Trace level utility: `packages/tm-core/src/modules/loop/services/trace-level.ts`
- Test harness: `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:806` (`makeMockSpawnChild`)
- `handleStreamEvent` tool-call population: `loop.service.ts:1050-1054`
- Existing `tagEntry` post-processor: `loop.service.ts:454-486`
- `finalize()` entry point: `loop.service.ts:271-294`
- System event reference in codebase: `hack/visualize.ts:296`
