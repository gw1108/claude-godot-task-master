# `--session-persistence` Flag for `task-master loop` Implementation Plan

## Overview
Add `--session-persistence <true|false>` to `task-master loop` so that by default every loop iteration appends `--no-session-persistence` to the claude invocation, preventing session history pollution. Expose the same control through a new MCP `loop` tool.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`

## Current State

- `LoopConfig` (`packages/tm-core/src/modules/loop/types.ts`) has no `sessionPersistence` field.
- `LoopService.buildCommandArgs(prompt, sandbox, verbose)` (`packages/tm-core/src/modules/loop/services/loop.service.ts:905`) builds the argv for claude but does not append `--no-session-persistence`.
  - Sandbox branch returns `['sandbox', 'run', 'claude', '-p', prompt]`
  - Non-sandbox branch returns `['-p', prompt, '--dangerously-skip-permissions', ...verboseFlags]`
- `LoopDomain.buildConfig(partial)` (`packages/tm-core/src/modules/loop/loop-domain.ts:184`) has no `sessionPersistence` default.
- `LoopCommandOptions` (`apps/cli/src/commands/loop.command.ts:22`) does not include `sessionPersistence`.
- No MCP `loop` tool exists. New TypeScript tools in `apps/mcp/src/tools/` are registered via `mcp-server/src/tools/tool-registry.js`, which imports them from `@tm/mcp` and maps them in `toolRegistry`.

## Desired End State

- `LoopConfig.sessionPersistence?: boolean` — if `false` (the default), `--no-session-persistence` is appended to every claude invocation regardless of sandbox mode; if `true`, nothing extra is appended.
- `LoopDomain.buildConfig` applies `sessionPersistence ?? false` as the default.
- `LoopService.buildCommandArgs` accepts and applies the flag in both sandbox and non-sandbox branches.
- CLI exposes `--session-persistence <true|false>` with a strict parser that rejects any value other than the literal strings `"true"` or `"false"` (throws `InvalidArgumentError`). Default is `false`.
- A new `apps/mcp/src/tools/loop/loop.tool.ts` exposes tool ID `loop` with full `LoopConfig` surface (prompt, iterations, sleepSeconds, sandbox, traceLevel, output/includeOutput, sessionPersistence, progressFile, tag). Registered in `mcp-server/src/tools/tool-registry.js` under key `loop`.
- Changeset: `minor` bump for `task-master-ai`.

## What We Are NOT Doing

- Adding `--session-persistence` to `task-master start`, `clusters start`, or any `ClaudeExecutor` path.
- Migrating any non-print path to interactive `--print` mode.
- Runtime version probing of sandboxed claude binary.
- Adding MCP wrappers for `start` or `clusters start`.
- Touching `--verbose`, `--trace`, or the parallel tag-79bd39 `--tracelevel` refactor.
- Adding a deprecation banner for previous loop runs losing `claude --resume` capability.

---

## Phase 1: Core Layer — Types, Service, Domain, and Core Tests

### Goal
Land all `@tm/core` changes: extend `LoopConfig`, thread `sessionPersistence` through `buildCommandArgs`, set the default in `buildConfig`, and cover the new branches with unit tests.

### Changes

#### 1a. Extend `LoopConfig` type
**File:** `packages/tm-core/src/modules/loop/types.ts`
**Change:** Add `sessionPersistence?: boolean` to the `LoopConfig` interface, after `includeOutput`.

```ts
// In LoopConfig interface, after includeOutput:
sessionPersistence?: boolean;
```

#### 1b. Update `buildCommandArgs` in `LoopService`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
**Change:** Add `sessionPersistence: boolean` as the fourth parameter. Append `'--no-session-persistence'` when `sessionPersistence === false` in both branches.

```ts
private buildCommandArgs(
    prompt: string,
    sandbox: boolean,
    verbose: boolean,
    sessionPersistence: boolean
): string[] {
    if (sandbox) {
        const args = ['sandbox', 'run', 'claude', '-p', prompt];
        if (!sessionPersistence) {
            args.push('--no-session-persistence');
        }
        return args;
    }

    const args = ['-p', prompt, '--dangerously-skip-permissions'];
    if (verbose) {
        args.push('--output-format', 'stream-json', '--verbose');
    }
    if (!sessionPersistence) {
        args.push('--no-session-persistence');
    }
    return args;
}
```

**Change:** Update the call site of `buildCommandArgs` inside `executeIteration`. Add `sessionPersistence: boolean` as the last parameter to `executeIteration`, and thread it through from `run()`:

```ts
// In run(), extract from config:
const sessionPersistence = config.sessionPersistence ?? false;

// Pass to executeIteration (add as 8th argument, after progressFile):
const iteration = await this.executeIteration(
    prompt, i, sandbox, includeOutput, level, callbacks, progressFile, sessionPersistence
);

// In executeIteration signature (add last parameter):
private async executeIteration(
    prompt: string,
    iteration: number,
    sandbox: boolean,
    includeOutput: boolean,
    level: LoopTraceLevel,
    callbacks: LoopOutputCallbacks | undefined,
    progressFile: string | undefined,
    sessionPersistence: boolean
): Promise<LoopIteration> {
    // ...
    const args = this.buildCommandArgs(prompt, sandbox, atLeast(level, 'verbose'), sessionPersistence);
    // ...
}
```

#### 1c. Add `sessionPersistence` default to `buildConfig`
**File:** `packages/tm-core/src/modules/loop/loop-domain.ts`
**Change:** Add `sessionPersistence: partial.sessionPersistence ?? false` in `buildConfig`, mirroring the `sandbox ?? false` and `includeOutput ?? false` pattern:

```ts
private buildConfig(partial: Partial<LoopConfig>): LoopConfig {
    return {
        iterations:         partial.iterations ?? 10,
        prompt:             partial.prompt ?? 'default',
        progressFile:       partial.progressFile ?? path.join(this.projectRoot, '.taskmaster', 'progress.txt'),
        sleepSeconds:       partial.sleepSeconds ?? 5,
        tag:                partial.tag,
        sandbox:            partial.sandbox ?? false,
        includeOutput:      partial.includeOutput ?? false,
        traceLevel:         partial.traceLevel ?? 'none',
        sessionPersistence: partial.sessionPersistence ?? false,
        brief:              partial.brief,
        callbacks:          partial.callbacks
    };
}
```

#### 1d. Unit tests for `buildCommandArgs`
**File:** `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`
**Change:** Add a `describe('sessionPersistence in buildCommandArgs')` block. Since `buildCommandArgs` is private, assert on the args passed to `mockSpawnSync` via the `run()` integration path. Cover 4 cases: `{sandbox:false, sessionPersistence:false}`, `{sandbox:false, sessionPersistence:true}`, `{sandbox:true, sessionPersistence:false}`, `{sandbox:true, sessionPersistence:true}`.

```ts
describe('sessionPersistence in buildCommandArgs', () => {
    it('appends --no-session-persistence when sessionPersistence is false (non-sandbox)', async () => {
        // arrange: mockSpawnSync returns success, sandbox:false, sessionPersistence:false
        await service.run({ ...minimalConfig, sandbox: false, sessionPersistence: false });
        expect(mockSpawnSync).toHaveBeenCalledWith(
            'claude',
            expect.arrayContaining(['--no-session-persistence']),
            expect.any(Object)
        );
    });

    it('does NOT append --no-session-persistence when sessionPersistence is true (non-sandbox)', async () => {
        await service.run({ ...minimalConfig, sandbox: false, sessionPersistence: true });
        const callArgs = mockSpawnSync.mock.calls[0][1] as string[];
        expect(callArgs).not.toContain('--no-session-persistence');
    });

    it('appends --no-session-persistence when sessionPersistence is false (sandbox)', async () => {
        await service.run({ ...minimalConfig, sandbox: true, sessionPersistence: false });
        expect(mockSpawnSync).toHaveBeenCalledWith(
            'docker',
            expect.arrayContaining(['--no-session-persistence']),
            expect.any(Object)
        );
    });

    it('does NOT append --no-session-persistence when sessionPersistence is true (sandbox)', async () => {
        await service.run({ ...minimalConfig, sandbox: true, sessionPersistence: true });
        const callArgs = mockSpawnSync.mock.calls[0][1] as string[];
        expect(callArgs).not.toContain('--no-session-persistence');
    });
});
```

Note: Check the existing spec for the correct `minimalConfig` variable name and `mockSpawnSync` reference. The sandbox tests may need the same bypass of the auth/streaming preflight checks used in the existing sandbox test (e.g., the pattern at line 502–526).

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for core: `npm run test -w @tm/core`
- [x] Format check passes: `npm run format-check`

---

## Phase 2: CLI Layer — Flag and CLI Tests

### Goal
Wire the `--session-persistence <true|false>` option into the CLI command and verify parsing, default, and invalid-value rejection.

### Changes

#### 2a. Add `sessionPersistence` to `LoopCommandOptions`
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** Add `sessionPersistence?: boolean` to the `LoopCommandOptions` interface:

```ts
interface LoopCommandOptions {
    // ... existing fields ...
    sessionPersistence?: boolean;
}
```

#### 2b. Add `parseSessionPersistence` helper and Commander option
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** Add a strict parser function (alongside or below the existing `parseTraceLevel` or similar parsers). Add the option to the Commander command. This introduces the first value-taking boolean option in the CLI — the strict parser is essential since Commander doesn't natively parse `true`/`false` strings as booleans.

```ts
function parseSessionPersistence(value: string): boolean {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new InvalidArgumentError(
        `Invalid value "${value}". Expected "true" or "false".`
    );
}
```

In the command builder (`.addOption` block):
```ts
.addOption(
    new Option(
        '--session-persistence <true|false>',
        'Persist the claude session for each loop iteration. Default: false (sessions are NOT persisted, preventing history pollution). Pass "true" to enable persistence (e.g., to allow claude --resume on a specific iteration).'
    )
    .argParser(parseSessionPersistence)
    .default(false)
)
```

#### 2c. Pass `sessionPersistence` to `LoopConfig` in `execute`
**File:** `apps/cli/src/commands/loop.command.ts`
**Change:** In the `execute` method where the `Partial<LoopConfig>` is assembled, add:

```ts
sessionPersistence: options.sessionPersistence ?? false,
```

#### 2d. Unit tests for the new option
**File:** `apps/cli/src/commands/loop.command.spec.ts`
**Change:** In the `option parsing` describe block, add assertions for `--session-persistence`:

```ts
it('session-persistence defaults to false', () => {
    const opt = findOption(command, '--session-persistence');
    expect(opt?.defaultValue).toBe(false);
});

it('passes sessionPersistence true to LoopConfig when --session-persistence true', async () => {
    await executeCommand(['--session-persistence', 'true', ...otherRequiredArgs]);
    expect(mockLoopRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionPersistence: true })
    );
});

it('passes sessionPersistence false to LoopConfig when --session-persistence false', async () => {
    await executeCommand(['--session-persistence', 'false', ...otherRequiredArgs]);
    expect(mockLoopRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionPersistence: false })
    );
});

it('rejects invalid --session-persistence value', async () => {
    // Commander calls argParser at parse time — test that the option throws
    expect(() =>
        command.parseOptions(['--session-persistence', 'yes'])
    ).toThrow(/invalid/i);
});
```

Note: Check the existing spec for the exact `findOption`, `executeCommand`, and `mockLoopRun` patterns. Use the `validateIterations` test block as a style reference.

#### 2e. CLI integration test for invalid value exit code
**File:** `apps/cli/tests/integration/commands/loop.command.test.ts`
**Change:** In the `validation errors` describe block, add:

```ts
it('exits with code 1 when --session-persistence is given an invalid value', () => {
    const result = runLoop(['--session-persistence', 'yes']);
    expect(result.exitCode).toBe(1);
    expect(result.output.toLowerCase()).toContain('invalid');
    expect(result.output.toLowerCase()).toContain('session-persistence');
});
```

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass for CLI: `npm run test -w @tm/cli`
- [x] Format check passes: `npm run format-check`

---

## Phase 3: MCP Layer — New `loop` Tool and Registration

### Goal
Create the MCP `loop` tool that mirrors the full CLI surface, register it in the tool registry, and add integration tests.

### Changes

#### 3a. Create the loop tool file
**File:** `apps/mcp/src/tools/loop/loop.tool.ts` (new file)
**Pattern:** Mirror `apps/mcp/src/tools/autopilot/start.tool.ts` — Zod schema at module level, `registerLoopTool(server: FastMCP)` export, `withToolContext`, `handleApiResult`, calls `tmCore.loop.run(partial)`.

```ts
/**
 * @fileoverview loop MCP tool
 * Run task-master loop iterations via MCP
 */

import type { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { ToolContext } from '../../shared/types.js';
import { handleApiResult, withToolContext } from '../../shared/utils.js';

const LoopSchema = z.object({
    prompt: z
        .string()
        .optional()
        .describe('Loop prompt or preset name. Defaults to "default" (runs the built-in task-master preset).'),
    iterations: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of loop iterations. Defaults to 10 (or pending task count for the default preset).'),
    sleepSeconds: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Seconds to wait between iterations. Defaults to 5.'),
    sandbox: z
        .boolean()
        .optional()
        .default(false)
        .describe('Run each iteration inside a docker sandbox. Default: false.'),
    traceLevel: z
        .enum(['none', 'verbose', 'trace'])
        .optional()
        .default('none')
        .describe('Trace verbosity: "none" (default) | "verbose" (streaming output) | "trace" (full tool call detail).'),
    includeOutput: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include claude stdout in the loop result. Default: false.'),
    sessionPersistence: z
        .boolean()
        .optional()
        .default(false)
        .describe('Persist the claude session for each iteration. Default: false (appends --no-session-persistence to each claude call, preventing session history pollution).'),
    progressFile: z
        .string()
        .optional()
        .describe('Absolute path to the progress file. Defaults to <projectRoot>/.taskmaster/progress.txt.'),
    tag: z
        .string()
        .optional()
        .describe('Task tag to scope the loop to. Omit to use the currently active tag.'),
    projectRoot: z
        .string()
        .describe('Absolute path to the project root directory.')
});

type LoopArgs = z.infer<typeof LoopSchema>;

/**
 * Register the loop MCP tool with the server
 */
export function registerLoopTool(server: FastMCP) {
    server.addTool({
        name: 'loop',
        description:
            'Run task-master loop: repeatedly invoke claude with a prompt (or the built-in default preset) for up to N iterations, sleeping between each. Use this to drive autonomous task completion without manual intervention.',
        parameters: LoopSchema,
        annotations: {
            title: 'Run Task Master Loop'
        },
        execute: withToolContext(
            'loop',
            async (args: LoopArgs, { log, tmCore }: ToolContext) => {
                const {
                    prompt,
                    iterations,
                    sleepSeconds,
                    sandbox,
                    traceLevel,
                    includeOutput,
                    sessionPersistence,
                    progressFile,
                    tag,
                    projectRoot
                } = args;

                try {
                    log.info(`Starting loop in ${projectRoot}`);

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

                    log.info(
                        `Loop finished: ${result.finalStatus}, ${result.tasksCompleted} tasks completed`
                    );

                    return handleApiResult({
                        result: { success: true, data: result },
                        log,
                        projectRoot
                    });
                } catch (error: any) {
                    log.error(`Error in loop: ${error.message}`);
                    if (error.stack) {
                        log.debug(error.stack);
                    }
                    return handleApiResult({
                        result: {
                            success: false,
                            error: { message: `Loop failed: ${error.message}` }
                        },
                        log,
                        projectRoot
                    });
                }
            }
        )
    });
}
```

Note: `withToolContext` injects `tmCore` using `projectRoot` from the args. Confirm this matches the pattern in other tools — if `projectRoot` must come from a specific arg position, verify against `apps/mcp/src/shared/utils.ts`.

#### 3b. Create the loop tool barrel
**File:** `apps/mcp/src/tools/loop/index.ts` (new file)

```ts
export { registerLoopTool } from './loop.tool.js';
```

#### 3c. Export from `apps/mcp/src/index.ts`
**File:** `apps/mcp/src/index.ts`
**Change:** Add the loop tool exports alongside the existing `export *` lines:

```ts
export * from './tools/loop/index.js';
```

#### 3d. Register in the legacy tool registry
**File:** `mcp-server/src/tools/tool-registry.js`
**Change:** Import and register `registerLoopTool`:

```js
// In the @tm/mcp import block (around line 40):
import {
    registerAutopilotAbortTool,
    // ... existing imports ...
    registerLoopTool        // add this
} from '@tm/mcp';

// In toolRegistry object (after the generate entry, around line 103):
loop: registerLoopTool,
```

The `loop` tool goes in `toolRegistry` only (not `coreTools` or `standardTools`), making it available in the `all` tier.

#### 3e. MCP integration tests
**File:** `apps/mcp/tests/integration/tools/loop.tool.test.ts` (new file)
**Pattern:** Mirror `apps/mcp/tests/integration/tools/get-tasks.tool.test.ts` — use `execFileSync` + `@modelcontextprotocol/inspector --cli`, `mkdtempSync`/`rmSync`, and `callMCPTool` helper. Use per-test 15 000 ms timeout.

Test cases:
1. **Happy path — default sessionPersistence**: Call `loop` with `{ prompt: 'echo test', iterations: 1, projectRoot }`. Assert result has `success: true` and `finalStatus` is present. (Will fail/error since no claude is available in test env — skip or mark with `.skip` if needed, but include the structure.)
2. **Parameter pass-through — sessionPersistence**: Mock or verify that `sessionPersistence: false` is the default when not provided.
3. **Tool is registered**: Call with invalid args and verify the MCP server returns a tool-not-found vs. validation error (proves registration).

> **Note:** Full integration tests for `loop` require a real claude binary and are expected to be slow or skipped in CI. Follow the pattern of existing loop CLI integration tests that set `timeout: 5000` and catch errors.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit/integration tests pass for MCP: `npm run test -w @tm/mcp`
- [x] Format check passes: `npm run format-check`

---

## Phase 4: Changeset

### Goal
Publish a user-facing `minor` changelog entry documenting the new flag and MCP tool.

### Changes

**File:** `.changeset/loop-session-persistence.md` (new file)

```markdown
---
"task-master-ai": minor
---

`task-master loop` now accepts a `--session-persistence <true|false>` flag. The default is `false`, which appends `--no-session-persistence` to every claude invocation so loop iterations do not pollute `claude --resume` history. Pass `--session-persistence true` to opt back in to session persistence. Invalid values (anything other than the literal strings `"true"` or `"false"`) are rejected at parse time. A new MCP `loop` tool exposes the same full parameter surface (prompt, iterations, sleepSeconds, sandbox, traceLevel, includeOutput, sessionPersistence, progressFile, tag) for programmatic control over loop execution. Requires a recent version of `claude` CLI that supports `--no-session-persistence` (available in claude with `--print` support).
```

### Automated Verification
- [x] Changeset file exists and has correct frontmatter: `cat .changeset/loop-session-persistence.md`

---

## Manual Verification (run after ALL phases are complete)

- [ ] `task-master loop --help` shows `--session-persistence <true|false>` with default `false`
- [ ] `task-master loop --session-persistence true` — loop runs without appending `--no-session-persistence` to claude argv (verify via verbose output or by inspecting process args)
- [ ] `task-master loop --session-persistence false` — loop run includes `--no-session-persistence` in claude argv
- [ ] `task-master loop --session-persistence yes` — exits with code 1, output contains "invalid"
- [ ] `task-master loop` (no flag) — behaves identically to `--session-persistence false` (default)
- [ ] MCP `loop` tool is callable via inspector: `npx @modelcontextprotocol/inspector --cli node dist/mcp-server.js --tool loop --tool-arg projectRoot=$(pwd) --tool-arg prompt=echo`
- [ ] MCP `loop` tool `sessionPersistence` defaults to `false` when omitted

## Manual Testing Steps
1. `npm run turbo:build` — rebuild dist artifacts
2. `task-master loop --help` — confirm flag appears
3. `task-master loop --session-persistence yes` — confirm exit 1 and error message
4. `TASK_MASTER_TOOLS=all npx task-master@local` (or via MCP inspector) — confirm `loop` tool is listed

## References
- Original ticket: `thoughts/shared/questions/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`
- Research: `thoughts/shared/research/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`
- Design: `thoughts/shared/claude-code-design/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`
- Changeset precedent: `.changeset/loop-tracelevel-option.md`
- MCP tool pattern: `apps/mcp/src/tools/autopilot/start.tool.ts`
- MCP registration: `mcp-server/src/tools/tool-registry.js:59–103`
- Loop service: `packages/tm-core/src/modules/loop/services/loop.service.ts:905`
- Loop domain: `packages/tm-core/src/modules/loop/loop-domain.ts:184`
