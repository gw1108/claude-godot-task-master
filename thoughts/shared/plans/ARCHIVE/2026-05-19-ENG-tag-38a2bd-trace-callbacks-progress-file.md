# Persist `--trace` Output to the Loop Progress File (Plain Text) Implementation Plan

## Overview
Add per-iteration plain-text trace appends to the loop progress file in `LoopService`, so that when `--trace` is active the LLM prompt, tool inputs/results, and iteration summary are written to `progressFile` as plain UTF-8 markdown — no ANSI codes, no chalk — while keeping all chalk styling exclusively in the CLI layer.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md`

## Current State
- `packages/tm-core/src/modules/loop/services/loop.service.ts` — the main service; imports `appendFile` from `node:fs/promises` at line 6. Two existing call sites: `initProgressFile` (lines 335–357) and `appendFinalSummary` (lines 359–380), both using `await appendFile(path, content, 'utf-8')`.
- Trace callbacks (`onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`) are invoked in the service with raw values:
  - `onPromptSent(i, prompt)` at line 205 in `run()`, guarded by `config.trace`
  - `onToolInput(name, input)` at line 866 in `handleStreamEvent()`, guarded by `trace`
  - `onToolResult(name, result)` at line 881 in `handleStreamEvent()`, guarded by `trace`
  - `onIterationSummary(iterationNum, summary)` at lines 713–722 in `child.on('close')` inside `executeVerboseIteration`, guarded by `trace && callbacks?.onIterationSummary`
- `progressFile` is not a class field; it flows through the service as `config.progressFile` (`LoopConfig.progressFile: string`, `types.ts:113`).
- `executeVerboseIteration` uses a local `traceLines` accumulation pattern for `toolCallCounts` (a `Map<string, number>` at line 577), flushed at `child.on('close')` (lines 697–732) — this is the model for the new per-iteration buffer.
- `handleStreamEvent` is a private class method called from the `processLine` closure inside `executeVerboseIteration`; it receives `callbacks`, `trace`, `toolCallCounts`, and other iteration-scoped state as parameters.
- `loop.service.spec.ts` mocks `node:fs/promises` at module level (`vi.mock('node:fs/promises')`, line 21) and sets `vi.mocked(fsPromises.appendFile).mockResolvedValue(undefined)` in `beforeEach` (line 35). Assertions use `expect(fsPromises.appendFile).toHaveBeenCalledWith(path, expect.stringContaining('...'), 'utf-8')` (lines 793–825).
- `LoopTokenUsage` shape (`types.ts:33–44`): `{ inputTokens, outputTokens, cacheCreationInputTokens?, cacheReadInputTokens?, totalTokens }`.
- `LoopToolCallSummary` shape (`types.ts:18–23`): `{ name: string; count: number }`.

## Desired End State
When `task-master loop --trace` runs:
1. Each iteration appends one block to `config.progressFile` using a single `await appendFile` call (per the buffer-flush model).
2. The block has the format defined in the design: `## Iteration N`, `### LLM input` (fenced ` ```text `), `### Tool: <name> input` / `### Tool: <name> result` (fenced ` ```json `), `### Iteration N summary` (bullet list + fenced ` ```text ` for final result), trailing `---`.
3. All payloads are capped at 10,000 characters with a `… [truncated, N more chars]` suffix when exceeded.
4. JSON payloads are `JSON.stringify(value, null, 2)`-formatted inside ` ```json ` fences.
5. The file contains no ANSI escape sequences — plain UTF-8 by construction.
6. Errors from `appendFile` propagate up through `run()` exactly like `initProgressFile` / `appendFinalSummary` failures (no local try/catch).
7. Five new unit tests in `loop.service.spec.ts` cover the 5 design-specified coverage targets.

## What We Are NOT Doing
- Persisting `onStderr`, `onError`, `onText`, or `onToolUse` streaming lines.
- Adding a separate `traceFile` / `verboseLogFile` config field.
- Changing `LoopOutputCallbacks` shape (no new callbacks or fields).
- Changing the CLI's `formatTraceValue` truncation (500/1000 chars).
- Sharing or adding `stripAnsiCodes` into `@tm/core`.
- Extending the CLI integration test (`apps/cli/tests/integration/commands/loop.command.test.ts`).
- Writing to `progressFile` when `config.trace` is false.

---

## Phase 1: Plain-text formatting helpers

### Goal
Add three private helper methods to `LoopService` that produce plain-text markdown segments for the progress file — no chalk, no ANSI — so all subsequent phases can call them without thinking about format details.

### Changes

#### LoopService — new private helpers
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Add three private methods after `appendFinalSummary` (around line 380), before the class closing brace.

```ts
// Insert after appendFinalSummary (line 380), before closing brace

private truncateForFile(text: string, maxChars = 10_000): string {
  if (text.length <= maxChars) return text;
  const remaining = text.length - maxChars;
  return `${text.slice(0, maxChars)}… [truncated, ${remaining} more chars]`;
}

private formatJsonBlockForFile(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  return '```json\n' + this.truncateForFile(json) + '\n```';
}

private buildIterationSummaryBlock(
  iterationNum: number,
  summary: {
    toolCalls: Array<{ name: string; count: number }>;
    finalResult?: string;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      totalTokens: number;
    };
  }
): string {
  const lines: string[] = [`### Iteration ${iterationNum} summary`];

  if (summary.toolCalls.length > 0) {
    lines.push('- Tool calls:');
    for (const tc of summary.toolCalls) {
      lines.push(`  - ${tc.name}: ${tc.count}`);
    }
  }

  if (summary.tokenUsage) {
    const u = summary.tokenUsage;
    lines.push('- Tokens:');
    lines.push(`  - input: ${u.inputTokens.toLocaleString()}`);
    lines.push(`  - output: ${u.outputTokens.toLocaleString()}`);
    if (u.cacheCreationInputTokens !== undefined) {
      lines.push(`  - cache write: ${u.cacheCreationInputTokens.toLocaleString()}`);
    }
    if (u.cacheReadInputTokens !== undefined) {
      lines.push(`  - cache read: ${u.cacheReadInputTokens.toLocaleString()}`);
    }
    lines.push(`  - total: ${u.totalTokens.toLocaleString()}`);
  }

  if (summary.finalResult) {
    lines.push('- Final result:');
    lines.push('```text');
    lines.push(this.truncateForFile(summary.finalResult));
    lines.push('```');
  }

  return lines.join('\n');
}
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for tm-core: `npm run test -w @tm/core`

---

## Phase 2: Per-iteration trace buffer and file flush

### Goal
Wire the three helper methods into `executeVerboseIteration` (and its callee `handleStreamEvent`) to accumulate a per-iteration trace buffer and flush it with one `await appendFile` call at `child.on('close')`. Wire the prompt header in `run()` by passing it into `executeVerboseIteration`.

### Changes

#### 2a. `handleStreamEvent` — add `traceLines` parameter
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

Find the `handleStreamEvent` private method signature. Add an optional `traceLines?: string[]` parameter as the last parameter. Inside the method, alongside each existing trace callback invocation, push the corresponding formatted block to `traceLines` if it is defined.

```ts
// In the handleStreamEvent method signature, add:
//   traceLines?: string[]
// as the last parameter.

// Alongside the existing onToolInput callback (around line 866):
if (trace) {
  toolCallCounts?.set(block.name, (toolCallCounts.get(block.name) ?? 0) + 1);
  if (block.input !== undefined) {
    callbacks?.onToolInput?.(block.name, block.input);
    // NEW: push tool input block to per-iteration buffer
    traceLines?.push(
      `### Tool: ${block.name} input\n` + this.formatJsonBlockForFile(block.input)
    );
  }
}

// Alongside the existing onToolResult callback (around line 881):
if (trace && event.type === 'user') {
  for (const block of event.message.content) {
    if (block.type === 'tool_result') {
      callbacks?.onToolResult?.(block.name, block.content);
      // NEW: push tool result block to per-iteration buffer
      const label = block.name ?? 'unknown';
      traceLines?.push(
        `### Tool: ${label} result\n` + this.formatJsonBlockForFile(block.content)
      );
    }
  }
}
```

#### 2b. All call sites of `handleStreamEvent`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

Every existing call to `this.handleStreamEvent(...)` inside the `processLine` closure in `executeVerboseIteration` must pass the new `traceLines` argument. Example:

```ts
// Before (inside processLine closure, executeVerboseIteration):
this.handleStreamEvent(event, callbacks, trace, toolCallCounts, ...otherArgs);

// After:
this.handleStreamEvent(event, callbacks, trace, toolCallCounts, ...otherArgs, traceLines);
```

(Adjust to match the actual parameter order once you've read the full signature.)

#### 2c. `executeVerboseIteration` — add `tracePrompt` parameter and buffer
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

Add an optional `tracePrompt?: string` parameter to `executeVerboseIteration`.

At the top of the function body (after the existing local variable declarations, around line 577), initialize the trace buffer:

```ts
// NEW: per-iteration trace buffer (only allocated when trace + progressFile)
const traceLines: string[] | undefined =
  trace && config.progressFile ? [] : undefined;

// NEW: seed with iteration header + LLM input block
if (traceLines && tracePrompt !== undefined) {
  traceLines.push(`## Iteration ${iterationNum}`);
  traceLines.push(
    `### LLM input\n\`\`\`text\n${this.truncateForFile(tracePrompt)}\n\`\`\``
  );
}
```

In the `child.on('close')` handler (around lines 712–732), after the existing `onIterationSummary` invocation block, add the summary + flush:

```ts
// Inside child.on('close'), after the existing onIterationSummary block:
if (traceLines && config.progressFile) {
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

  // Single appendFile per iteration — await inside the Promise executor
  // using the resolveOnce-based async chain is not available here; use a
  // fire-and-forget that rejects into the outer Promise via a captured reject.
  appendFile(
    config.progressFile,
    '\n' + traceLines.join('\n\n') + '\n',
    'utf-8'
  ).catch((err: unknown) => {
    // Propagate to the outer run() try/catch (same failure policy as initProgressFile)
    rejectOnce(err);
  });
}
```

> **Note on `rejectOnce`:** The `child.on('close')` handler already uses `resolveOnce` (a one-shot resolve guard). You need a paired `rejectOnce` guard captured from the outer `new Promise(...)` executor. If one does not already exist, introduce it alongside `resolveOnce`:
> ```ts
> let settled = false;
> const resolveOnce = (v: LoopIterationResult) => { if (!settled) { settled = true; resolve(v); } };
> const rejectOnce   = (e: unknown)            => { if (!settled) { settled = true; reject(e); } };
> ```

#### 2d. `run()` — pass prompt into `executeVerboseIteration`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`

At the call site in `run()` where `executeVerboseIteration` is invoked (after the `onPromptSent` block at line 205), pass the prompt when trace is active:

```ts
// Before (existing onPromptSent block and executeVerboseIteration call):
if (config.trace) {
  config.callbacks?.onPromptSent?.(i, prompt);
}
// ... eventually:
result = await this.executeVerboseIteration(iterationNum, config, callbacks, trace, ...);

// After — pass prompt for file writing:
if (config.trace) {
  config.callbacks?.onPromptSent?.(i, prompt);
}
// ... eventually:
result = await this.executeVerboseIteration(
  iterationNum,
  config,
  callbacks,
  trace,
  ...otherArgs,
  config.trace ? prompt : undefined  // tracePrompt
);
```

(Adjust to match the actual `executeVerboseIteration` call site parameter order.)

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for tm-core: `npm run test -w @tm/core`
- [x] Unit tests pass for cli: `npm run test -w @tm/cli`

---

## Phase 3: Unit tests

### Goal
Add 5 new unit test cases to `loop.service.spec.ts` that cover the design's specified coverage targets using the existing `vi.mock('node:fs/promises')` + `expect.stringContaining` idiom.

### Changes

#### New test cases in `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
**Change:** Add a new `describe('trace file persistence', ...)` block after the existing `'progress file operations'` block (around line 828).

```ts
describe('trace file persistence', () => {
  // Shared setup: a trace-mode run with a mocked verbose execution path
  // uses the existing spawnMock / vi.mocked(spawn) pattern to simulate
  // one iteration of child process output.

  it('test 1 — onPromptSent raw text reaches appendFile without ANSI sequences', async () => {
    // Arrange: run with trace=true, a known prompt string
    // Act: call service.run(config) with config.trace = true
    // Assert:
    //   - fsPromises.appendFile has been called with config.progressFile
    //   - the content arg contains the prompt string
    //   - the content arg does NOT match /\x1b\[[0-9;]*m/ (ANSI escape regex)
    const prompt = 'Do the next task';
    // ... set up mock spawn that immediately closes with exit 0 ...
    await service.run({ ...baseConfig, trace: true, prompt });
    const calls = vi.mocked(fsPromises.appendFile).mock.calls;
    const traceCall = calls.find(([, content]) =>
      typeof content === 'string' && content.includes(prompt)
    );
    expect(traceCall).toBeDefined();
    expect(traceCall![1] as string).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it('test 2 — onToolInput JSON reaches appendFile pretty-printed and capped at 10 KB', async () => {
    // Arrange: mock spawn to emit a stream event with a tool_use block
    //   whose input is a large object that serializes to > 10,000 chars
    // Act: run with trace=true
    // Assert:
    //   - appendFile content contains '```json'
    //   - appendFile content contains '… [truncated,'
    const bigInput = { data: 'x'.repeat(15_000) };
    // ... mock stream event with tool_use block carrying bigInput ...
    await service.run({ ...baseConfig, trace: true });
    const calls = vi.mocked(fsPromises.appendFile).mock.calls;
    const traceCall = calls.find(([, c]) =>
      typeof c === 'string' && c.includes('```json')
    );
    expect(traceCall![1] as string).toContain('… [truncated,');
  });

  it('test 3 — onIterationSummary token-usage rows reach appendFile as specified markdown', async () => {
    // Arrange: mock spawn to emit a stream event with usage data
    //   { inputTokens: 1234, outputTokens: 567, totalTokens: 1801 }
    // Act: run with trace=true
    // Assert:
    //   - appendFile content contains 'input: 1,234'
    //   - appendFile content contains 'output: 567'
    //   - appendFile content contains 'total: 1,801'
    await service.run({ ...baseConfig, trace: true });
    const calls = vi.mocked(fsPromises.appendFile).mock.calls;
    const traceCall = calls.find(([, c]) =>
      typeof c === 'string' && c.includes('Iteration') && c.includes('summary')
    );
    expect(traceCall![1] as string).toContain('input: 1,234');
    expect(traceCall![1] as string).toContain('output: 567');
    expect(traceCall![1] as string).toContain('total: 1,801');
  });

  it('test 4 — multiple tool_use blocks in one iteration produce exactly one appendFile call for that iteration', async () => {
    // Arrange: mock spawn to emit two tool_use blocks in a single data event
    // Act: run with trace=true for 1 iteration
    // Assert:
    //   - fsPromises.appendFile call count === 2 total
    //     (1 from initProgressFile + 1 trace flush; appendFinalSummary is call 3 but
    //      only fires when loop finishes — adjust based on actual call order)
    //   - Specifically: only ONE call contains '## Iteration 1'
    vi.mocked(fsPromises.appendFile).mockClear();
    await service.run({ ...baseConfig, trace: true, iterations: 1 });
    const iterCalls = vi.mocked(fsPromises.appendFile).mock.calls.filter(
      ([, c]) => typeof c === 'string' && (c as string).includes('## Iteration 1')
    );
    expect(iterCalls).toHaveLength(1);
  });

  it('test 5 — truncation marker appears when payload exceeds 10 KB', async () => {
    // Arrange: construct a string of 10,001 characters
    // Act: call the private truncateForFile helper directly
    //   (cast service to any to access private method)
    const svc = service as unknown as { truncateForFile: (s: string, n?: number) => string };
    const longStr = 'a'.repeat(10_001);
    const result = svc.truncateForFile(longStr);
    // Assert:
    expect(result).toContain('… [truncated, 1 more chars]');
    expect(result.startsWith('a'.repeat(10_000))).toBe(true);
  });
});
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] All 5 new tests pass: `npm run test -w @tm/core`
- [x] No existing tests regress: `npm run test -w @tm/core` (full suite green)

---

## Manual Verification (run after ALL phases are complete)

- [ ] `task-master loop --trace --iterations 1` writes an `## Iteration 1` block to `.taskmaster/progress.txt`
- [ ] The written block contains `### LLM input`, at least one `### Tool:` section, and `### Iteration 1 summary`
- [ ] Running `cat .taskmaster/progress.txt | grep -P '\x1b\['` produces no output (no ANSI codes)
- [ ] When a tool result payload is artificially large (> 10 KB), the `… [truncated,` suffix appears in the file
- [ ] Running without `--trace` produces no `## Iteration` blocks in `progress.txt`
- [ ] A mid-run abort (Ctrl-C) does not corrupt the next run's header (trailing `---` is present)

## Manual Testing Steps
1. Build: `npm run turbo:build`
2. Run one iteration with trace: `task-master loop --trace --iterations 1 --prompt "list tasks"`
3. Inspect the progress file: `type .taskmaster\progress.txt` (Windows) or `cat .taskmaster/progress.txt`
4. Verify the block structure matches the design's format specification
5. Run without `--trace`: `task-master loop --iterations 1 --prompt "list tasks"` — confirm no `## Iteration` blocks appear in progress.txt

## References
- Original ticket: tag-38a2bd
- Research: `thoughts/shared/research/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md`
- Design: `thoughts/shared/claude-code-design/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md`
- Related patterns:
  - `loop.service.ts:335` — `initProgressFile` (appendFile idiom)
  - `loop.service.ts:359` — `appendFinalSummary` (appendFile idiom)
  - `loop.service.ts:697` — `child.on('close')` flush site
  - `loop.service.ts:866` — `onToolInput` emit site
  - `loop.service.ts:881` — `onToolResult` emit site
  - `loop.service.spec.ts:793` — `expect.stringContaining` appendFile assertion idiom
  - `apps/cli/src/commands/loop.command.ts:335` — `formatTraceValue` (CLI truncation, not to be changed)
