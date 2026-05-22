# Prepend Trace-Level Tag to Gated Lines in `progress.txt` — Implementation Plan

## Overview
Add `[VERBOSE]` / `[TRACE]` prefix tags to every level-gated line that `LoopService` writes to the progress file, by migrating the iteration line buffer to a typed-entry structure and applying a central `tagEntry` helper at the single gated flush site.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md`

## Current State

All code lives in one file:
**`packages/tm-core/src/modules/loop/services/loop.service.ts`**

- **Line 666** — buffer declared as `string[] | undefined`:
  ```ts
  const iterationFileLines: string[] | undefined = progressFile ? [] : undefined;
  ```
- **Five push sites** accumulate level-gated lines as plain strings:
  - Line 671: `iterationFileLines.push(\`## Iteration ${iterationNum}\`)` — always pushed when `progressFile` is set (verbose-minimum)
  - Lines 672–676: `if (atLeast(level, 'trace')) { iterationFileLines.push(\`### LLM input\n\`\`\`text\n...\n\`\`\`\`) }` — trace-gated
  - Lines 1016–1019: `iterationFileLines?.push(\`### Tool: ${block.name} input\n...\`)` — inside outer `atLeast(level, 'trace')` guard
  - Lines 1033–1035: `iterationFileLines?.push(\`### Tool: ${label} result\n...\`)` — inside outer trace guard
  - Lines 841–847: `iterationFileLines.push(this.buildIterationSummaryBlock(...))` — verbose-minimum (no extra guard beyond `progressFile`)
  - Line 848: `iterationFileLines.push('---')` — always-on separator in the buffer
- **Flush block (lines 836–856)**:
  ```ts
  if (iterationFileLines) {
      iterationFileLines.push(this.buildIterationSummaryBlock(...));
      iterationFileLines.push('---');
      appendFile(progressFile!, '\n' + iterationFileLines.join('\n\n') + '\n', 'utf-8')
          .catch((err: unknown) => { rejectOnce(err); });
  }
  ```
- `initProgressFile` (lines 338–360) and `appendFinalSummary` (lines 362–384) are fully independent write paths; neither touches `iterationFileLines`.
- `formatJsonBlockForFile` (lines 392–400) returns a single `string` with embedded `\n`s wrapping JSON in a ` ```json ``` ` fence.
- `buildIterationSummaryBlock` (lines 402–451) returns a single `string` with embedded `\n`s — a `### Iteration N summary` markdown section with bullet lists and optional ` ```text ``` ` fences.

## Desired End State

Every line emitted from the gated buffer to the progress file has a `[VERBOSE]` or `[TRACE]` prefix:

| Original line | Tagged form |
|---|---|
| `## Iteration 1` | `## [VERBOSE] Iteration 1` |
| `### LLM input` | `### [TRACE] LLM input` |
| `### Tool: bash input` | `### [TRACE] Tool: bash input` |
| `### Tool: bash result` | `### [TRACE] Tool: bash result` |
| `### Iteration 1 summary` | `### [VERBOSE] Iteration 1 summary` |
| `- Tool calls:` | `[VERBOSE] - Tool calls:` |
| `  - bash: 3` | `[VERBOSE]   - bash: 3` |
| ` ```json ` (fence marker) | ` ```json ` (unchanged) |
| `{ "key": "val" }` (inside fence) | `{ "key": "val" }` (unchanged) |
| `---` (separator) | `---` (unchanged) |

Rules:
- Header lines (`/^(#{1,6})\s+/`): tag placed *inside* the hashes — `## [VERBOSE] rest`
- Non-header body lines: tag prepended at column 0 — `[VERBOSE] <original_line>` (blank lines stay blank)
- Lines inside fenced code blocks (and fence-marker lines): pass through untagged
- The always-on `---` separator entry passes through untagged

## What We Are NOT Doing

- Tagging anything in `initProgressFile` or `appendFinalSummary`
- Changing tag spelling — `[VERBOSE]` and `[TRACE]` are fixed literals
- Changing header-vs-body placement rule
- Modifying `LoopTraceLevel`, `atLeast`, or `TRACE_LEVEL_WEIGHTS`
- Adding ANSI styling to the progress file
- Refactoring `formatJsonBlockForFile` or `buildIterationSummaryBlock` to return `string[]`
- Manual visual verification of nested-list Markdown rendering

---

## Phase 1: Migrate `iterationFileLines` to Typed Buffer Entries

### Goal
Replace the `string[]` buffer with `Array<{level: 'verbose' | 'trace' | 'separator', content: string}>` and update all five push sites to supply an explicit level — so the flush-time tagger can choose between `[VERBOSE]` and `[TRACE]` without inspecting string content.

### Changes

#### 1. Buffer Type Declaration
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Line 666 — change the array type from `string[]` to the typed union.

```ts
// Before
const iterationFileLines: string[] | undefined = progressFile ? [] : undefined;

// After
type IterationFileLine = { level: 'verbose' | 'trace' | 'separator'; content: string };
const iterationFileLines: IterationFileLine[] | undefined = progressFile ? [] : undefined;
```

> Place the `IterationFileLine` type alias at the top of the file (near the other local type aliases) or inline just above the variable declaration, whichever is less disruptive. It is file-private; no need to export.

#### 2. Push Site — Iteration Header (line 671)
**Change:** Wrap plain string with `{ level: 'verbose', content: ... }`.

```ts
// Before
iterationFileLines.push(`## Iteration ${iterationNum}`);

// After
iterationFileLines.push({ level: 'verbose', content: `## Iteration ${iterationNum}` });
```

#### 3. Push Site — LLM Input Block (lines 672–676)
**Change:** Wrap with `{ level: 'trace', content: ... }`.

```ts
// Before
iterationFileLines.push(
    `### LLM input\n\`\`\`text\n${this.truncateForFile(prompt)}\n\`\`\``
);

// After
iterationFileLines.push({
    level: 'trace',
    content: `### LLM input\n\`\`\`text\n${this.truncateForFile(prompt)}\n\`\`\``
});
```

#### 4. Push Site — Tool Input Block (lines 1016–1019)
**Change:** Wrap with `{ level: 'trace', content: ... }`.

```ts
// Before
iterationFileLines?.push(
    `### Tool: ${block.name} input\n` + this.formatJsonBlockForFile(block.input)
);

// After
iterationFileLines?.push({
    level: 'trace',
    content: `### Tool: ${block.name} input\n` + this.formatJsonBlockForFile(block.input)
});
```

#### 5. Push Site — Tool Result Block (lines 1033–1035)
**Change:** Wrap with `{ level: 'trace', content: ... }`.

```ts
// Before
iterationFileLines?.push(
    `### Tool: ${label} result\n` + this.formatJsonBlockForFile(block.content)
);

// After
iterationFileLines?.push({
    level: 'trace',
    content: `### Tool: ${label} result\n` + this.formatJsonBlockForFile(block.content)
});
```

#### 6. Push Site — Iteration Summary Block (lines 841–847, inside flush block)
**Change:** Wrap with `{ level: 'verbose', content: ... }`.

```ts
// Before
iterationFileLines.push(
    this.buildIterationSummaryBlock(iterationNum, {
        toolCalls,
        finalResult: finalResult || undefined,
        ...(tokenUsage && { tokenUsage })
    })
);

// After
iterationFileLines.push({
    level: 'verbose',
    content: this.buildIterationSummaryBlock(iterationNum, {
        toolCalls,
        finalResult: finalResult || undefined,
        ...(tokenUsage && { tokenUsage })
    })
});
```

#### 7. Push Site — Separator (line 848)
**Change:** Wrap with `{ level: 'separator', content: '---' }`.

```ts
// Before
iterationFileLines.push('---');

// After
iterationFileLines.push({ level: 'separator', content: '---' });
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass: `npm run test -w @tm/core`
- [x] Format check passes: `npm run format-check`

---

## Phase 2: Implement `tagEntry` Helper and Wire into Gated Flush

### Goal
Add a private `tagEntry` method (or a file-private function) that walks a typed buffer entry line-by-line, prepending `[VERBOSE]` or `[TRACE]` according to the tagging rules, then replace the raw `iterationFileLines.join('\n\n')` in the flush block with a tagged join.

### Changes

#### 1. Add `tagEntry` Private Method
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Add the method to the `LoopService` class body (or as a module-level function just above the class). Place it near the other file-writing helpers (`formatJsonBlockForFile`, `buildIterationSummaryBlock`).

```ts
private tagEntry(entry: IterationFileLine): string {
    if (entry.level === 'separator') return entry.content;

    const tag = entry.level === 'trace' ? 'TRACE' : 'VERBOSE';
    const lines = entry.content.split('\n');
    let inFence = false;
    const tagged: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (/^```\w*$/.test(trimmed)) {
            inFence = !inFence;
            tagged.push(line); // fence markers are untagged
            continue;
        }
        if (inFence) {
            tagged.push(line); // fenced body lines are untagged
            continue;
        }
        if (trimmed === '') {
            tagged.push(line); // blank lines stay blank
            continue;
        }
        const headerMatch = /^(#{1,6})(\s+.*)$/.exec(line);
        if (headerMatch) {
            // Insert tag inside the hashes: "## [VERBOSE] rest"
            tagged.push(`${headerMatch[1]} [${tag}]${headerMatch[2]}`);
        } else {
            // Body line: tag at column 0
            tagged.push(`[${tag}] ${line}`);
        }
    }

    return tagged.join('\n');
}
```

> The regex `/^(#{1,6})(\s+.*)$/` captures the hash prefix (group 1) and the space+rest (group 2). Inserting the tag gives `## [VERBOSE] Iteration 1` — one space between `##` and `[VERBOSE]`, one space between `[VERBOSE]` and the heading text (from `headerMatch[2]` which begins with a space).

#### 2. Wire `tagEntry` into the Flush Block (lines 850–853)
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Replace the raw `.join('\n\n')` with a mapped-then-joined form.

```ts
// Before
appendFile(
    progressFile!,
    '\n' + iterationFileLines.join('\n\n') + '\n',
    'utf-8'
).catch((err: unknown) => { rejectOnce(err); });

// After
appendFile(
    progressFile!,
    '\n' + iterationFileLines.map((e) => this.tagEntry(e)).join('\n\n') + '\n',
    'utf-8'
).catch((err: unknown) => { rejectOnce(err); });
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass: `npm run test -w @tm/core`
- [x] Format check passes: `npm run format-check`

---

## Phase 3: Add Pinning Tests

### Goal
Add positive assertions for every tagged form so a future regression that drops or misplaces a tag will fail a test.

### Changes

#### 1. New Test: `[VERBOSE]` Tags on Verbose-Minimum Lines
**File:** `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
**Change:** Add a new `it(...)` block inside the `'trace file persistence'` describe block. Use `traceLevel: 'verbose'` and the `childProcess.spawnSync` code path (non-streaming) so you don't need `makeMockSpawnChild`.

```ts
it('tags verbose-minimum lines with [VERBOSE] in the progress file', async () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 1,
        output: [],
        signal: null
    });

    await service.run({
        prompt: 'check lint',
        iterations: 1,
        sleepSeconds: 0,
        progressFile: '/test/progress.txt',
        traceLevel: 'verbose'
    });

    const calls = vi.mocked(fsPromises.appendFile).mock.calls;
    const iterCall = calls.find(
        ([, c]) => typeof c === 'string' && (c as string).includes('[VERBOSE]')
    );
    expect(iterCall).toBeDefined();
    const content = iterCall![1] as string;
    expect(content).toContain('## [VERBOSE] Iteration 1');
    expect(content).toContain('### [VERBOSE] Iteration 1 summary');
    // Separator passes through untagged
    expect(content).toContain('---');
    expect(content).not.toContain('[VERBOSE] ---');
});
```

#### 2. New Test: `[TRACE]` Tags on Trace-Minimum Lines
**File:** `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
**Change:** Add a second `it(...)` block using `traceLevel: 'trace'` with the `makeMockSpawnChild` helper and a `tool_use` + `tool_result` event pair so all five tagged forms appear.

```ts
it('tags trace-minimum lines with [TRACE] and verbose-minimum with [VERBOSE]', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
        makeMockSpawnChild([
            JSON.stringify({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } }
                    ]
                }
            }),
            JSON.stringify({
                type: 'user',
                message: {
                    content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt' }]
                }
            }),
            JSON.stringify({ type: 'result', result: 'done' })
        ]) as unknown as ReturnType<typeof childProcess.spawn>
    );

    await service.run({
        prompt: 'check lint',
        iterations: 1,
        sleepSeconds: 0,
        progressFile: '/test/progress.txt',
        traceLevel: 'trace'
    });

    const calls = vi.mocked(fsPromises.appendFile).mock.calls;
    const iterCall = calls.find(
        ([, c]) => typeof c === 'string' && (c as string).includes('## [VERBOSE] Iteration')
    );
    expect(iterCall).toBeDefined();
    const content = iterCall![1] as string;

    // Verbose-minimum headers
    expect(content).toContain('## [VERBOSE] Iteration 1');
    expect(content).toContain('### [VERBOSE] Iteration 1 summary');

    // Trace-minimum headers
    expect(content).toContain('### [TRACE] LLM input');
    expect(content).toContain('### [TRACE] Tool: bash input');
    expect(content).toContain('### [TRACE] Tool: bash result');

    // Fence markers and fenced body pass through untagged
    expect(content).not.toContain('[TRACE] ```');
    expect(content).not.toContain('[VERBOSE] ```');
});
```

#### 3. New Test: Body Lines in Summary Block Get `[VERBOSE]` Prefix
**File:** `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
**Change:** Add a third `it(...)` block using `traceLevel: 'verbose'` with `spawnSync` returning a result that includes token usage, so `buildIterationSummaryBlock` emits bullet-list body lines.

```ts
it('prefixes body lines in iteration summary block with [VERBOSE]', async () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }),
        stderr: '',
        pid: 1,
        output: [],
        signal: null
    });

    await service.run({
        prompt: 'check lint',
        iterations: 1,
        sleepSeconds: 0,
        progressFile: '/test/progress.txt',
        traceLevel: 'verbose'
    });

    const calls = vi.mocked(fsPromises.appendFile).mock.calls;
    const iterCall = calls.find(
        ([, c]) =>
            typeof c === 'string' && (c as string).includes('[VERBOSE]')
    );
    expect(iterCall).toBeDefined();
    const content = iterCall![1] as string;
    // Body bullet lines should be prefixed
    expect(content).toMatch(/\[VERBOSE\]\s+- input:/);
    expect(content).toMatch(/\[VERBOSE\]\s+- output:/);
});
```

> **Note:** The exact format of `spawnSync` stdout for token usage parsing should be validated by running the test and adjusting the mock value to match what `LoopService` actually reads. If `spawnSync` does not feed token usage (it may come only from streaming), use the `makeMockSpawnChild` helper with `traceLevel: 'verbose'` and a `result` event carrying `usage`.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass (including new tests): `npm run test -w @tm/core`
- [x] Format check passes: `npm run format-check`
- [x] All existing trace-file-persistence tests still pass (no previously-passing test should regress)

---

## Manual Verification (run after ALL phases are complete)

- [ ] `task-master loop --trace verbose` on a real project writes `## [VERBOSE] Iteration 1` in `progress.txt`
- [ ] `task-master loop --trace trace` writes `### [TRACE] LLM input`, `### [TRACE] Tool: <name> input`, `### [TRACE] Tool: <name> result`
- [ ] `### [VERBOSE] Iteration N summary` appears for every completed iteration
- [ ] Fence-marker lines (` ```json `, ` ```text `, ` ``` `) appear without any `[VERBOSE]` or `[TRACE]` prefix
- [ ] The `---` separator between iterations appears without any prefix
- [ ] The banner written by `initProgressFile` (header `# Taskmaster Loop Progress`) has no `[VERBOSE]` prefix
- [ ] The final summary written by `appendFinalSummary` (`# Loop Complete`) has no prefix

## Manual Testing Steps

1. Build the project: `npm run turbo:build`
2. Run a short loop against a real project with `traceLevel: 'verbose'`:
   ```
   task-master loop --iterations 1 --trace verbose --progress /tmp/progress-verbose.txt "echo hello"
   ```
3. Open `/tmp/progress-verbose.txt` and confirm `## [VERBOSE] Iteration 1` and `### [VERBOSE] Iteration 1 summary` are present; confirm fence blocks and `---` are untagged.
4. Repeat with `--trace trace` and confirm `### [TRACE] LLM input` and tool-call headers appear.
5. Open the file in VS Code Preview or GitHub and confirm Markdown renders correctly (code fences are intact).

## References

- Original ticket: `.pipeline_state_tag-ecef09.json`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md`
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md`
- Loop service: `packages/tm-core/src/modules/loop/services/loop.service.ts:666`
- Loop spec: `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
- Trace level utilities: `packages/tm-core/src/modules/loop/services/trace-level.ts`
