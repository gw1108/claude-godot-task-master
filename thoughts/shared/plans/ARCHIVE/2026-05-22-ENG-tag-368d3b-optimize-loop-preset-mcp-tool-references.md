# Optimize Loop Preset MCP Tool References Implementation Plan

## Overview
Rewrite the `default` loop preset to name MCP tools explicitly (eliminating `ToolSearch` round-trips), convert all five presets to a function-factory shape so `projectRoot` is injected deterministically, and replace the CLI binary pre-flight check with a config-file MCP readiness probe.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md`

## Current State
- `packages/tm-core/src/modules/loop/presets/default.ts:10-29` — `DEFAULT_PRESET` is a plain `string` constant; steps 1, 2, 7 use natural-language task-master references (`"Run task-master next (or use MCP)"`) that force the LLM to call `ToolSearch` to find the MCP tool schema before dispatching.
- `packages/tm-core/src/modules/loop/presets/index.ts:16-22` — `PRESETS: Record<LoopPreset, string>` stores raw strings; `getPreset(name)` returns `string`.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:496-505` — `resolvePrompt()` returns `PRESETS[prompt]` directly (a string).
- `packages/tm-core/src/modules/loop/services/loop.service.ts:55-87` — `checkTaskMasterAvailable()` spawns `task-master --version` via `spawnSync`.
- `packages/tm-core/src/modules/loop/services/loop.service.ts:184-190` — `run()` calls `checkTaskMasterAvailable()` when `config.prompt === 'default' && !config.sandbox`.
- No `PresetCtx` type exists anywhere. No `.mcp.json` read exists in the loop module.

## Desired End State
- `DEFAULT_PRESET` is a function `(ctx: PresetCtx) => string`; steps 1, 2, 7 name `mcp__task-master-ai__next_task`, `mcp__task-master-ai__get_task`, `mcp__task-master-ai__set_task_status` with full parameter blocks including `projectRoot: ctx.projectRoot`.
- All four other presets are wrapped as `(_ctx: PresetCtx) => STRING_CONTENT` (zero-arg-style).
- `PRESETS` type is `Record<LoopPreset, (ctx: PresetCtx) => string>`.
- `resolvePrompt()` calls `PRESETS[prompt]({ projectRoot: this.projectRoot })`.
- `checkTaskMasterAvailable()` is removed; `checkMcpServerAvailable(serverAlias: string)` replaces it — reads `<projectRoot>/.mcp.json` synchronously, returns `{ available: boolean; error?: string }`.
- `run()` calls `checkMcpServerAvailable('task-master-ai')` under the same gate.
- `PresetCtx = { projectRoot: string }` lives in `types.ts`.
- Tests updated to match the new function-shaped exports.
- Snapshot file deleted so it regenerates against the new prompt text.

## What We Are NOT Doing
- Rewriting `duplication.ts`, `entropy.ts`, `linting.ts`, or `test-coverage.ts` prompt bodies — only their wrapper shape changes.
- Modifying steps 3, 4, 5, 6, 8, 9 of `default.ts`.
- Adding a CLI fallback path in the prompt.
- Live MCP tool ping in the readiness probe.
- Changing `TASK_MASTER_TOOLS` tier defaults.
- Recovery from mid-loop MCP disconnect.
- Touching `LoopDomain`, `buildContextHeader`, or `buildPrompt`.

---

## Phase 1: Add `PresetCtx` type and convert all presets to function shape

### Goal
Introduce `PresetCtx` in `types.ts`, rewrite `default.ts` prompt body with explicit MCP tool names, wrap the other four preset strings in zero-arg functions, and update the `index.ts` registry type — all without touching `LoopService` yet.

### Changes

#### 1. Add `PresetCtx` type
**File:** `packages/tm-core/src/modules/loop/types.ts`
**Change:** Append `PresetCtx` export after the existing `LoopPreset` union (around line 13).

```ts
/** Context passed to preset factory functions so projectRoot is injected at call time */
export type PresetCtx = { projectRoot: string };
```

#### 2. Rewrite `default.ts`
**File:** `packages/tm-core/src/modules/loop/presets/default.ts`
**Change:** Replace the entire file. The export changes from a `string` constant to a function. Steps 1, 2, and 7 now name explicit MCP tools with full JSON-ish parameter blocks. Doc-comment updated.

```ts
import type { PresetCtx } from '../types.js';

/**
 * Default preset for Taskmaster loop — general task completion.
 *
 * Dispatch strategy: every task-master call names the exact MCP tool
 * (mcp__task-master-ai__<tool>) and the full parameter object so the host
 * can route directly without a ToolSearch round-trip. The task-master-ai MCP
 * server presence is verified once before the loop starts via
 * LoopService.checkMcpServerAvailable (see loop.service.ts).
 */
export const DEFAULT_PRESET = (ctx: PresetCtx): string =>
    `TASK: Implement ONE task/subtask from the Taskmaster backlog.

PROCESS:
1. Call mcp__task-master-ai__next_task with { "projectRoot": "${ctx.projectRoot}" } to get the next available task/subtask.
2. Call mcp__task-master-ai__get_task with { "id": "<task id>", "projectRoot": "${ctx.projectRoot}" } to read full task details.
3. Implement following codebase patterns.
4. Write tests alongside implementation.
5. Run type check (e.g., \`npm run typecheck\`, \`tsc --noEmit\`).
6. Run tests (e.g., \`npm test\`, \`npm run test\`).
7. Call mcp__task-master-ai__set_task_status with { "id": "<task id>", "status": "done", "projectRoot": "${ctx.projectRoot}" } to mark complete.
8. Commit with message: feat(<scope>): <what was implemented>
9. Append super-concise notes to progress file: task ID, what was done. If there were any mistakes or false assumptions, append them as learnings.

IMPORTANT:
- Complete ONLY ONE task per iteration.
- Keep changes small and focused.
- Do NOT start another task after completing one.
- If all tasks are done, output <loop-complete>ALL_DONE</loop-complete>.
- If blocked, output <loop-blocked>REASON</loop-blocked>.
`;
```

#### 3. Wrap `test-coverage.ts`
**File:** `packages/tm-core/src/modules/loop/presets/test-coverage.ts`
**Change:** Add the `PresetCtx` import and wrap the existing `TEST_COVERAGE_PRESET` string constant in a function. Keep all existing prompt text verbatim.

```ts
import type { PresetCtx } from '../types.js';

const TEST_COVERAGE_PRESET_TEXT = `... (existing string content verbatim) ...`;

export const TEST_COVERAGE_PRESET = (_ctx: PresetCtx): string => TEST_COVERAGE_PRESET_TEXT;
```

Apply the same pattern to `linting.ts` (→ `LINTING_PRESET`), `duplication.ts` (→ `DUPLICATION_PRESET`), and `entropy.ts` (→ `ENTROPY_PRESET`).

#### 4. Update `presets/index.ts`
**File:** `packages/tm-core/src/modules/loop/presets/index.ts`
**Change:** Import `PresetCtx`, update `PRESETS` type, update `getPreset` return type. `isPreset` and `PRESET_NAMES` are unchanged.

```ts
import type { LoopPreset, PresetCtx } from '../types.js';

export const PRESETS: Record<LoopPreset, (ctx: PresetCtx) => string> = {
    default: DEFAULT_PRESET,
    'test-coverage': TEST_COVERAGE_PRESET,
    linting: LINTING_PRESET,
    duplication: DUPLICATION_PRESET,
    entropy: ENTROPY_PRESET
};

// PRESET_NAMES and isPreset are unchanged — `value in PRESETS` still works

export function getPreset(name: LoopPreset): (ctx: PresetCtx) => string {
    return PRESETS[name];
}
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for tm-core: `npm run test -w @tm/core`

---

## Phase 2: Update `LoopService` — wire `resolvePrompt` and replace CLI check

### Goal
Make `LoopService.resolvePrompt()` call the preset function with `{ projectRoot }`, remove `checkTaskMasterAvailable()`, and add `checkMcpServerAvailable(serverAlias)` that does a sync `.mcp.json` read. Update the call site in `run()`.

### Changes

#### 1. Update imports in `loop.service.ts`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Add `readFileSync` from `node:fs` for the sync config probe; keep existing `node:fs/promises` imports.

```ts
import { readFileSync, existsSync } from 'node:fs';
// (existing imports unchanged)
```

#### 2. Add `checkMcpServerAvailable()` method
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Add new method replacing `checkTaskMasterAvailable`. Insert at the same location (after `checkSandboxAuth`, before private helpers).

```ts
/**
 * Verify that the named MCP server is wired up in the project's .mcp.json.
 *
 * Config-only check (sync file read, no IPC) — fast enough to run on every
 * loop start. A live tool ping was rejected as too heavy for a precondition.
 */
checkMcpServerAvailable(serverAlias: string): { available: boolean; error?: string } {
    const mcpConfigPath = path.join(this.projectRoot, '.mcp.json');
    if (!existsSync(mcpConfigPath)) {
        return {
            available: false,
            error: `MCP config not found at ${mcpConfigPath}. Add a .mcp.json with a "${serverAlias}" mcpServers entry.`
        };
    }
    try {
        const raw = readFileSync(mcpConfigPath, 'utf-8');
        const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        if (!config.mcpServers || !(serverAlias in config.mcpServers)) {
            return {
                available: false,
                error: `MCP server "${serverAlias}" not found in ${mcpConfigPath}. Add it under mcpServers.`
            };
        }
        return { available: true };
    } catch (err) {
        return {
            available: false,
            error: `Failed to read ${mcpConfigPath}: ${(err as Error).message}`
        };
    }
}
```

#### 3. Remove `checkTaskMasterAvailable()` method
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:54-86`
**Change:** Delete the entire `checkTaskMasterAvailable()` method (lines 46–86 including its JSDoc).

#### 4. Update call site in `run()`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:179-191`
**Change:** Replace the comment block and the `checkTaskMasterAvailable` call with `checkMcpServerAvailable`.

```ts
// The default preset routes all task-master calls through the MCP server.
// Verify it is configured in .mcp.json once up front — fail fast rather than
// discovering the gap during the first iteration.
// Skip in sandbox mode: the host .mcp.json doesn't govern the container.
if (config.prompt === 'default' && !config.sandbox) {
    const mcpCheck = this.checkMcpServerAvailable('task-master-ai');
    if (!mcpCheck.available) {
        const errorMsg = mcpCheck.error || 'task-master-ai MCP server not configured';
        this.reportError(config.callbacks, errorMsg);
        return this.buildErrorResult(loopStart, errorMsg, config.callbacks);
    }
}
```

#### 5. Update `resolvePrompt()`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts:496-505`
**Change:** Call the preset function with the context object instead of returning the string directly.

```ts
private async resolvePrompt(prompt: string): Promise<string> {
    if (this.isPreset(prompt)) {
        return PRESETS[prompt]({ projectRoot: this.projectRoot });
    }
    const content = await readFile(prompt, 'utf-8');
    if (!content.trim()) {
        throw new Error(`Custom prompt file '${prompt}' is empty`);
    }
    return content;
}
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for tm-core: `npm run test -w @tm/core`
- [ ] Format check passes: `npm run format-check`

---

## Phase 3: Update tests

### Goal
Update `presets.spec.ts` and `loop.service.spec.ts` to match the new function-shaped preset exports and the renamed `checkMcpServerAvailable` method. Delete the stale snapshot file so it regenerates.

### Changes

#### 1. Delete stale snapshot
**File:** `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap`
**Change:** Delete this file entirely. Vitest will recreate it when tests run against the updated string content produced by calling the preset functions.

#### 2. Update `presets.spec.ts`
**File:** `packages/tm-core/src/modules/loop/presets/presets.spec.ts`
**Change:** Introduce a shared `TEST_CTX: PresetCtx = { projectRoot: '/test/project' }` fixture. Update all assertions that assumed preset values are strings to call through the function. Key changes:

```ts
import type { PresetCtx } from '../types.js';
const TEST_CTX: PresetCtx = { projectRoot: '/test/project' };

// In 'PRESETS record' describe block:
it('has entries for all preset names', () => {
    for (const name of PRESET_NAMES) {
        expect(PRESETS[name]).toBeDefined();
        expect(typeof PRESETS[name]).toBe('function');   // was 'string'
    }
});

it('has non-empty content for each preset', () => {
    for (const name of PRESET_NAMES) {
        expect(PRESETS[name](TEST_CTX).length).toBeGreaterThan(0);  // call the function
    }
});

// getPreset tests — call the returned function:
it('returns content for default preset', () => {
    const content = getPreset('default')(TEST_CTX);   // was: getPreset('default')
    expect(content).toBeTruthy();
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
});

// Individual preset constant tests:
it('exports DEFAULT_PRESET', () => {
    expect(DEFAULT_PRESET).toBeDefined();
    expect(typeof DEFAULT_PRESET).toBe('function');   // was 'string'
    expect(DEFAULT_PRESET(TEST_CTX).length).toBeGreaterThan(0);
});

// Snapshot tests — call through:
it('default preset matches snapshot', () => {
    expect(DEFAULT_PRESET(TEST_CTX)).toMatchSnapshot();  // was: DEFAULT_PRESET
});

// Structure validation — call through:
it.each(PRESET_NAMES)('%s contains <loop-complete> marker', (preset) => {
    const content = getPreset(preset)(TEST_CTX);   // call the function
    expect(content).toMatch(/<loop-complete>/);
});
```

Apply the same call-through pattern to every assertion that previously operated on the string value directly.

Also add a test asserting that `DEFAULT_PRESET` injects `projectRoot` into the output:
```ts
describe('default preset projectRoot injection', () => {
    it('embeds the provided projectRoot in the prompt', () => {
        const content = DEFAULT_PRESET({ projectRoot: '/my/project' });
        expect(content).toContain('/my/project');
    });
});
```

#### 3. Update `loop.service.spec.ts`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
**Change:** Replace the `checkTaskMasterAvailable()` describe block (lines 183–243) with a `checkMcpServerAvailable()` block. Mock `node:fs` instead of `node:child_process` for this test.

```ts
import * as fs from 'node:fs';
vi.mock('node:fs');

describe('checkMcpServerAvailable()', () => {
    it('returns available=true when .mcp.json contains the server alias', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ mcpServers: { 'task-master-ai': { command: 'npx' } } })
        );
        const service = new LoopService(defaultOptions);
        const result = service.checkMcpServerAvailable('task-master-ai');
        expect(result.available).toBe(true);
    });

    it('returns available=false when .mcp.json does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        const service = new LoopService(defaultOptions);
        const result = service.checkMcpServerAvailable('task-master-ai');
        expect(result.available).toBe(false);
        expect(result.error).toContain('.mcp.json');
    });

    it('returns available=false when server alias is missing from mcpServers', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ mcpServers: { 'other-server': {} } })
        );
        const service = new LoopService(defaultOptions);
        const result = service.checkMcpServerAvailable('task-master-ai');
        expect(result.available).toBe(false);
        expect(result.error).toContain('"task-master-ai"');
    });

    it('returns available=false when .mcp.json is invalid JSON', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('not-json');
        const service = new LoopService(defaultOptions);
        const result = service.checkMcpServerAvailable('task-master-ai');
        expect(result.available).toBe(false);
        expect(result.error).toMatch(/Failed to read/);
    });
});
```

Also update the `run()` describe block: anywhere `mockSpawnSync` was called an extra time for the `task-master --version` pre-flight (e.g., `loop.service.spec.ts:411-412`: `// 1 task-master --version precondition + 3 claude iterations`), remove that +1 from the count and instead mock `fs.existsSync` / `fs.readFileSync` to return a valid MCP config.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for tm-core (snapshot regenerates clean): `npm run test -w @tm/core`
- [x] Format check passes: `npm run format-check`
- [x] No snapshot assertion failures (only snapshot creation)

---

## Manual Verification (run after ALL phases are complete)

- [ ] `task-master loop --preset default --max-iterations 1 --tracelevel trace` runs without error against a project that has `.mcp.json` configured with `task-master-ai`
- [ ] Trace output in `.taskmaster/progress.txt` shows NO `### [TRACE] Tool: ToolSearch input` block before the first `mcp__task-master-ai__*` tool call in that iteration
- [ ] Running the same command against a project **without** `.mcp.json` emits an error referencing `.mcp.json` and exits before iterating
- [ ] The four non-default presets (`test-coverage`, `linting`, `duplication`, `entropy`) still resolve to the correct string content when used in a loop run

## Manual Testing Steps
1. Build: `npm run turbo:build`
2. Run with MCP configured: `task-master loop --preset default --max-iterations 1 --tracelevel trace`
3. Open `.taskmaster/progress.txt` and search for `ToolSearch` — confirm no match in the iteration's tool sequence before the first `mcp__task-master-ai__` call.
4. Temporarily rename `.mcp.json` to `.mcp.json.bak` and re-run step 2 — confirm the loop exits immediately with a message referencing `.mcp.json`.
5. Restore `.mcp.json.bak` → `.mcp.json`.

## References
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md`
- Preset registry: `packages/tm-core/src/modules/loop/presets/index.ts:16-22`
- `checkTaskMasterAvailable` (to remove): `packages/tm-core/src/modules/loop/services/loop.service.ts:54-86`
- `resolvePrompt` (to update): `packages/tm-core/src/modules/loop/services/loop.service.ts:496-505`
- `run()` call site (to update): `packages/tm-core/src/modules/loop/services/loop.service.ts:184-190`
- MCP config read pattern: `src/utils/create-mcp-config.js:72-99`
