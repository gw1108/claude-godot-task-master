---
topic: "--session-persistence flag across task-master commands that invoke claude"
tags: [research, codebase, loop, start, clusters-start, claude-executor, mcp, session-persistence]
status: complete
source_question: thoughts/shared/questions/2026-05-19-ENG-tag-6af922-session-persistence-flag.md
---

# Research: `--session-persistence` flag across task-master commands that invoke claude

## Research Question

Add an optional `--session-persistence=<true|false>` flag to **every** task-master command that spawns the `claude` CLI. When the value is `false`, task-master appends `--no-session-persistence` to the claude argv. The default is `false` for **all** affected commands (`loop`, `start`, `clusters start`, and any other path that goes through `ClaudeExecutor`). Expose the same option as a parameter on the corresponding MCP tools.

Research must produce: (a) the complete list of code paths to change, (b) the exact plumbing pattern for both CLI and MCP, (c) verification that `claude --no-session-persistence` is the real CLI flag, and (d) the test/changeset surface needed.

## Summary

The `claude --no-session-persistence` flag is **real and confirmed** in `claude --help` for `2.1.145 (Claude Code)`. It is a bare boolean flag that disables on-disk session persistence and works only with `--print` / `-p`.

Four code paths in this monorepo spawn the `claude` binary:

1. **`LoopService`** (`packages/tm-core/src/modules/loop/services/loop.service.ts`) — the only path with a dedicated `buildCommandArgs` argv builder; supports `--sandbox`, `--verbose`, `--trace`. Always uses `-p <prompt>`.
2. **`StartCommand` → `TaskExecutionService.prepareExecutionCommand`** (`apps/cli/src/commands/start.command.ts` + `packages/tm-core/src/modules/tasks/services/task-execution-service.ts`) — builds `{ executable: 'claude', args: [taskPrompt] }` with the prompt as the bare first positional argument (no `-p`).
3. **`ClusterStartCommand.launchClaudeSession`** (`apps/cli/src/commands/cluster-start.command.ts`) — spawns `claude` with **empty args** (`[]`) and writes the prompt via stdin. Uses `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var.
4. **`ClaudeExecutor.runClaude`** (`packages/tm-core/src/modules/execution/executors/claude-executor.ts`) — generic executor used by the older `ExecutorService` stack; args are `[prompt, ...additionalFlags]` with no `-p`.

MCP wrappers exist today for autopilot and basic tasks tools only — there is **no MCP tool for `loop`, `start`, or `clusters start`**. The MCP tool pattern (Zod v3 schemas → `handleApiResult`/`withToolContext`) is established under `apps/mcp/src/tools/`.

Path 3 (clusters start, stdin-based) does **not** use `--print`, so `--no-session-persistence` would have no effect there per the claude CLI's documented constraint. This is the most significant edge case the implementation must address (see Open Questions).

The codebase has **no existing value-taking boolean Commander option** (`.option('--flag <bool>', ...)` with a `true|false` argument). Implementing `--session-persistence <true|false>` will introduce the first one. The closest analogue is the `--parallel <n>` option in `cluster-start.command.ts` which uses an inline parser + `InvalidArgumentError`.

## Detailed Findings

### Research Area 1 — Inventory of claude-invoking entry points

#### 1a. `LoopService` (loop)

- **File:** `packages/tm-core/src/modules/loop/services/loop.service.ts`
- **Spawn sites:**
  - `loop.service.ts:49` — `spawnSync('task-master', ['--version'])` (preflight, not claude)
  - `loop.service.ts:83-85` — `spawnSync('docker', ['sandbox', 'run', 'claude', '-p', 'Say OK'])` (sandbox auth probe)
  - `loop.service.ts:112-120` — `spawnSync('docker', ['sandbox', 'run', 'claude', ...])` (interactive auth)
  - `loop.service.ts:580` — `spawnSync(command, args, ...)` — sync iteration (`command = 'docker' | 'claude'`)
  - `loop.service.ts:676` — `spawn(command, args, ...)` — streaming/verbose iteration
- **Argv builder:** `buildCommandArgs(prompt, sandbox, verbose)` at `loop.service.ts:906-921`
  - Sandbox: `['sandbox', 'run', 'claude', '-p', prompt]` (passed to `docker`)
  - Non-sandbox: `['-p', prompt, '--dangerously-skip-permissions']`
  - Non-sandbox + verbose: appends `'--output-format', 'stream-json', '--verbose'`
- **Callers:** `LoopDomain.run()` → `LoopService.run()`; CLI entry `apps/cli/src/commands/loop.command.ts`
- **MCP wrapper:** **None exists.**

#### 1b. `StartCommand` (start) → `TaskExecutionService`

- **CLI file:** `apps/cli/src/commands/start.command.ts`
- **Service file:** `packages/tm-core/src/modules/tasks/services/task-execution-service.ts`
- **Argv builder:** `TaskExecutionService.prepareExecutionCommand` at `task-execution-service.ts:235-255` returns `{ executable: 'claude', args: [taskPrompt], cwd }`. **The prompt is the bare first positional argument — no `-p` flag.**
- **Spawn site:** `start.command.ts:279` — `spawn(command.executable, command.args, { cwd, stdio: 'inherit', shell: false })`
- **`StartCommandOptions` (start.command.ts:26-33):** `id?`, `format?`, `project?`, `dryRun?`, `force?`, `noStatusUpdate?` — **no sandbox/verbose/trace**.
- **Domain wiring:** `TasksDomain.start` (`tasks-domain.ts:295`) → `TaskExecutionService.startTask` (`task-execution-service.ts:48`) → `prepareExecutionCommand` (line 105 or 115 for dry-run)
- **MCP wrapper:** **None exists** for the CLI's top-level `start`. (`apps/mcp/src/tools/autopilot/start.tool.ts` wraps the **autopilot** start workflow, which is a different code path.)

#### 1c. `ClusterStartCommand` (clusters start)

- **File:** `apps/cli/src/commands/cluster-start.command.ts`
- **Spawn site:** `cluster-start.command.ts:197` — `spawn('claude', [], { cwd, stdio: ['pipe', 'inherit', 'inherit'], shell: false, env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } })`
- **Argv builder:** None — args are **always `[]`**. The prompt is written to stdin at `cluster-start.command.ts:207-209`: `this.childProcess.stdin?.write(prompt); this.childProcess.stdin?.end();`
- **`ClusterStartOptions` (cluster-start.command.ts:22-30):** `tag?`, `dryRun?`, `parallel?`, `resume?`, `continueOnFailure?`, `json?`, `project?` — no sandbox/verbose/trace.
- **Domain wiring:** `TmCore.cluster.buildExecutionPlan(...)` → `TmCore.cluster.buildPrompt(plan)` → `launchClaudeSession(prompt, projectRoot)`
- **MCP wrapper:** **None exists.**

#### 1d. `ClaudeExecutor` (generic execution path)

- **File:** `packages/tm-core/src/modules/execution/executors/claude-executor.ts`
- **Spawn sites:**
  - `claude-executor.ts:35` — `spawn('which', [this.claudeConfig.command!], ...)` — availability check
  - `claude-executor.ts:96` — `spawn(this.claudeConfig.command!, args, { cwd, shell: false, stdio: 'inherit' })`
- **Argv builder:** Inline at `claude-executor.ts:89` — `const args = [prompt, ...this.claudeConfig.additionalFlags!];`. **Prompt is bare positional — no `-p`.**
- **Config interface:** `ClaudeExecutorConfig` at `packages/tm-core/src/modules/execution/types.ts:63-67`: `command?`, `systemPrompt?`, `additionalFlags?`. No sandbox/verbose/trace fields.
- **Callers:** `ExecutorFactory.create` → `ExecutorService.executeTask` and `ClusterSequencerService` (parallel cluster execution)
- **Spec coverage:** None — no `.spec.ts` files exist under `packages/tm-core/src/modules/execution/`.

#### 1e. Non-claude spawn sites (out of scope, confirmed)

- `apps/cli/src/utils/auto-update/restart.ts:22` — spawns `task-master`
- `apps/cli/src/utils/auto-update/install.ts:147,258` — spawns `npm`
- `apps/cli/src/utils/pager.ts:49` — spawns `less`
- `packages/ai-sdk-provider-grok-cli/src/grok-cli-language-model.ts:74,124` — spawns `grok`
- `apps/extension/src/utils/mcpClient.ts` — MCP transport (not direct spawn)

### Research Area 2 — Flag plumbing (CLI)

#### Existing flag flow in `loop`

```
CLI invocation
  --sandbox / --verbose / --trace / --no-output
        ↓
loop.command.ts: LoopCommandOptions (21-31)
        ↓
loop.command.ts:execute() (69-153)
  - normalizes options.* with ?? false / ?? true
  - derives effectiveVerbose = options.verbose || options.trace (line 132)
  - builds Partial<LoopConfig> (lines 133-146)
        ↓
LoopDomain.run(partial) → buildConfig() applies domain defaults
  (loop-domain.ts:184-199, e.g. sandbox: partial.sandbox ?? false)
        ↓
LoopService.run(config)
  - validates streaming+sandbox at loop.service.ts:165-169
  - calls executeIteration() / executeVerboseIteration()
        ↓
loop.service.ts:563 — const command = sandbox ? 'docker' : 'claude';
loop.service.ts:906-921 — buildCommandArgs(prompt, sandbox, verbose) → string[]
```

Key file:line anchors:
- `apps/cli/src/commands/loop.command.ts:21-31` — `LoopCommandOptions`
- `apps/cli/src/commands/loop.command.ts:56-65` — flag declarations
- `apps/cli/src/commands/loop.command.ts:129-146` — normalization + config construction
- `packages/tm-core/src/modules/loop/types.ts:107-166` — `LoopConfig`
- `packages/tm-core/src/modules/loop/loop-domain.ts:184-199` — `buildConfig` defaults
- `packages/tm-core/src/modules/loop/services/loop.service.ts:906-921` — `buildCommandArgs`

#### Plumbing pattern to apply for `--session-persistence`

For **each** of the four paths, add a `sessionPersistence: boolean` field with default `false` at the same layer that already holds command options:

| Path | CLI options field | Service/Domain config field | Argv mutation site |
|---|---|---|---|
| `loop` | `LoopCommandOptions.sessionPersistence` (loop.command.ts:21-31) | `LoopConfig.sessionPersistence` (types.ts:107-166), default in `LoopDomain.buildConfig` (loop-domain.ts:184-199) | `buildCommandArgs` (loop.service.ts:906-921) — append `'--no-session-persistence'` when false in both branches |
| `start` | `StartCommandOptions.sessionPersistence` (start.command.ts:26-33) | Add to `TaskExecutionService.startTask` options; route through `prepareExecutionCommand` (task-execution-service.ts:235-255) | Append `'--no-session-persistence'` to `args` in `prepareExecutionCommand` — but note args currently lack `-p`/`--print`; see Open Questions |
| `clusters start` | `ClusterStartOptions.sessionPersistence` (cluster-start.command.ts:22-30) | Plumb through `ClusterStartOptions` and `launchClaudeSession` | Cluster path uses **empty argv + stdin** — flag would not function without also adding `--print`; see Open Questions |
| `ClaudeExecutor` | n/a (no CLI exposure of its own) | `ClaudeExecutorConfig.sessionPersistence` (execution/types.ts:63-67), or add to `additionalFlags` from caller | `claude-executor.ts:89` — extend args inline |

#### Commander declaration shape

There is **no existing value-taking boolean** pattern in the codebase to copy. The recommended composition from existing patterns:

```typescript
import { Command, InvalidArgumentError } from 'commander';

.option(
  '--session-persistence <true|false>',
  'Keep claude session history (default: false)',
  (v) => {
    if (v !== 'true' && v !== 'false') {
      throw new InvalidArgumentError(
        '--session-persistence must be "true" or "false"'
      );
    }
    return v === 'true';
  }
)
```

Anchored on `cluster-start.command.ts:13` (import) and `cluster-start.command.ts:60-76` (`--parallel <n>` parser using `InvalidArgumentError`).

#### Default wiring

Existing pattern in `loop.command.ts:129-141` (`options.verbose ?? false`) and `loop-domain.ts:184-199` (domain-side `partial.sandbox ?? false`) applies. With Commander, an omitted `--session-persistence` leaves `options.sessionPersistence === undefined`; the CLI normalizes with `options.sessionPersistence ?? false`, and the domain layer applies the same `?? false` as a safety net.

### Research Area 3 — Flag plumbing (MCP)

**Critical finding: there are NO MCP tools today for `loop`, `start` (CLI top-level), or `clusters start`.** Only autopilot workflow tools and basic task management tools exist:

- `apps/mcp/src/tools/autopilot/{start,resume,next,status,complete,commit,finalize,abort,create-pr}.tool.ts`
- `apps/mcp/src/tools/tasks/{get-tasks,get-task,generate,set-task-status}.tool.ts`
- Entry: `apps/mcp/src/index.ts`
- Shared: `apps/mcp/src/shared/{types,utils}.ts`

To expose `--session-persistence` on MCP per the original ask, the implementation must **first create MCP wrappers for loop/start/cluster-start**. That is outside the strict scope of "add a flag" — it is a net-new MCP surface. See Open Questions.

#### Established MCP boolean parameter convention

From `apps/mcp/src/tools/autopilot/start.tool.ts` (Zod v3 due to Draft-07 JSON Schema constraint documented in `apps/mcp/src/tools/README-ZOD-V3.md`):

```typescript
force: z
  .boolean()
  .optional()
  .default(false)
  .describe('Force start even if workflow state exists')
```

For symmetry with CLI:
```typescript
sessionPersistence: z
  .boolean()
  .optional()
  .default(false)
  .describe('Keep claude session history (default: false)')
```

### Research Area 4 — Verification of `--no-session-persistence`

Confirmed against `claude --help` from `claude` version `2.1.145 (Claude Code)`. Exact help text:

```
--no-session-persistence
  Disable session persistence - sessions will not be saved to
  disk and cannot be resumed (only works with --print)
```

**Constraints:**
- Boolean (no value).
- Works only in combination with `--print` / `-p` (non-interactive mode).
- Effect: session not saved to disk; not resumable via `--resume` / `--continue`.

Other session-related flags that exist (not what we want, but for context):
- `-c, --continue` — continue most recent conversation in cwd
- `-r, --resume [value]` — resume by session id
- `--session-id <uuid>` — use specific session id
- `--fork-session` — when resuming, create new session id
- `--from-pr [value]` — resume PR-linked session
- `-n, --name <name>` — display name for session

### Research Area 5 — Default semantics and value parsing

#### Value-taking form

Use `--session-persistence <true|false>` (space-separated value) — Commander accepts both `--session-persistence false` and `--session-persistence=false` for any `<value>` option declaration. The codebase has no existing precedent for the `--flag=<bool>` form; the closest precedent is the `--parallel <n>` integer parser at `cluster-start.command.ts:60-76`.

#### Accepted forms and validation

Recommended parser (only accept exact `"true"` / `"false"` strings, case-sensitive, no shorthand) using `InvalidArgumentError`:

```typescript
(v) => {
  if (v !== 'true' && v !== 'false') {
    throw new InvalidArgumentError(
      '--session-persistence must be "true" or "false"'
    );
  }
  return v === 'true';
}
```

This rejects `--session-persistence=yes`, `--session-persistence=1`, `--session-persistence=TRUE`, etc., per the edge case in the question.

#### Default and omitted flag

- Commander leaves `options.sessionPersistence === undefined` when the flag is omitted.
- CLI normalization at the `execute()` site applies `options.sessionPersistence ?? false` (same pattern as `verbose ?? false` at `loop.command.ts:129`).
- Domain layer in each path applies `partial.sessionPersistence ?? false` as second safety net (same pattern as `partial.sandbox ?? false` at `loop-domain.ts:193`).
- Result: omitting the flag is equivalent to passing `--session-persistence false`.

#### Consistency with `--no-output`

The `--no-output` Commander negation pattern at `loop.command.ts:57-60` is a **different shape** — it is a boolean negation flag with no value, and Commander auto-sets the implicit `output` field to `true` by default. The new flag does **not** use this pattern. It is a value-taking flag, per Q3 in the question.

### Research Area 6 — Sandbox interaction

#### Loop path

`buildCommandArgs` at `loop.service.ts:906-921` already handles two branches. The new flag must be appended in both:

- **Sandbox branch (line 911-913):** current `['sandbox', 'run', 'claude', '-p', prompt]` → append `'--no-session-persistence'` after `prompt` when `sessionPersistence === false`. The flag is delivered to claude via `docker sandbox run claude -p <prompt> --no-session-persistence`. (Whether the sandboxed claude binary in the docker image supports this flag is unverified; needs runtime check or version assumption.)
- **Non-sandbox branch (line 915):** current `['-p', prompt, '--dangerously-skip-permissions']` → append `'--no-session-persistence'` when false. Order: after `--dangerously-skip-permissions` is fine; ordering doesn't matter for claude CLI flags.

#### Start path

`task-execution-service.ts:235-255` currently produces `{ executable: 'claude', args: [taskPrompt] }`. The prompt is a bare positional argument. **There is no `-p`/`--print` flag in this argv**, which means `claude --no-session-persistence` would be rejected by claude per the documented "only works with --print" constraint. The start command also currently spawns with `stdio: 'inherit'`, suggesting it expects interactive use — which is incompatible with `--print`. See Open Questions.

#### Clusters start path

`cluster-start.command.ts:197` spawns `claude` with `[]` (empty argv) and writes the prompt via stdin. The session is interactive (`stdio: ['pipe', 'inherit', 'inherit']`). Same constraint applies — `--no-session-persistence` requires `--print`, which is incompatible with the current interactive stdin-fed pattern. See Open Questions.

#### ClaudeExecutor path

`claude-executor.ts:89` produces `[prompt, ...additionalFlags]` — bare prompt as first positional, no `-p`. Same constraint as start.

### Research Area 7 — Verbose / trace interaction

The flag is **orthogonal** to `--verbose`, `--trace`, and `--sandbox` for the `loop` path:

- `--verbose` / `--trace` flow into `buildCommandArgs(prompt, sandbox, verbose)` and toggle the `--output-format stream-json --verbose` triplet at `loop.service.ts:917-919`. They do not interact with session persistence.
- `--sandbox` reshapes the command from `claude` to `docker` and the args from `[...]` to `['sandbox', 'run', 'claude', ...]`. The new flag appends after the prompt in either branch.
- The existing `streaming && sandbox` conflict guard at `loop.service.ts:165-169` is unrelated to session persistence and does not need to change.

No interaction conflict found. The `tag-79bd39` tracelevel refactor (active research at `thoughts/shared/research/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md`) is independent and proceeds in parallel.

### Research Area 8 — Tests and changeset

#### Test surface to update / add

| Test file | Current pattern | New tests needed |
|---|---|---|
| `packages/tm-core/src/modules/loop/services/loop.service.spec.ts` | `expect.arrayContaining([...])` for argv content; `expect.objectContaining({...})` for spawn options; `vi.mock('node:child_process')` module mock with `mockSpawnSync.mockReturnValue(...)` | Add tests: (a) non-sandbox + sessionPersistence=false → argv contains `--no-session-persistence`; (b) non-sandbox + sessionPersistence=true → argv does **not** contain it; (c) sandbox + sessionPersistence=false → docker argv contains it after prompt; (d) verbose + sessionPersistence=false composes correctly. **No existing tests use `toEqual([exact array])` for the claude argv** — but if any exact-position assertions exist they need updating (the prompt-arg index test at `loop.service.spec.ts:1028-1031` uses `spawnCall[1][1]` for the prompt, which is index-stable). |
| `apps/cli/src/commands/loop.command.spec.ts` | `expect.objectContaining({...})` against `mockLoopRun` call args; direct invocation via `(loopCommand as any).execute.bind(loopCommand)`; mocks `@tm/core` via `vi.mock` | Add tests: (a) `execute({ sessionPersistence: true })` → config has `sessionPersistence: true`; (b) `execute({})` → config has `sessionPersistence: false` (default); (c) invalid value triggers Commander `InvalidArgumentError` (would require `parseAsync` against full Command instance, not direct `execute`). |
| `apps/cli/src/commands/cluster-start.command.spec.ts` | `cmd.options.find(o => o.long === '--flag-name')` for option existence; one literal-args spawn assertion at line 187-199 | Add: option existence check; if cluster path actually appends the flag (see Open Questions), update the spawn assertion. |
| `apps/cli/tests/integration/commands/loop.command.test.ts` | Real `execSync` against built binary; `toContain` on stdout/stderr text | Add: invalid `--session-persistence=yes` → exit code 1 and error mentions "session-persistence". |
| `packages/tm-core/src/modules/execution/` | **No spec files exist** | If `ClaudeExecutor` gains the flag, a new spec file is the right scope. |
| `apps/mcp/tests/integration/tools/` | Pattern in `generate.tool.test.ts` | Only relevant if MCP tools for loop/start/cluster-start are created. |

#### Pre-existing tests that would break

The audit found **no test that does `expect(args).toEqual([exact array])`** for the claude argv. Existing assertions use `expect.arrayContaining([...])` which tolerates additional elements. The one literal `[]` assertion is in `cluster-start.command.spec.ts:187-199` for the empty-argv spawn — that would need updating only if the cluster path actually emits the flag (deferred to Open Questions).

This is good news: the default-false case appending `--no-session-persistence` unconditionally will not break existing `arrayContaining`-style tests in `loop.service.spec.ts`. The `cluster-start` literal-`[]` assertion would only break if the cluster path is modified.

#### Changeset

Per `CLAUDE.md` ("Add a changeset for code changes"), a changeset is required. Location: `.changeset/`.

Convention from `.changeset/loop-trace-level.md` and similar `minor` entries:

```markdown
---
"task-master-ai": minor
---

Add a `--session-persistence <true|false>` flag to `task-master loop`,
`task-master start`, and `task-master clusters start`. By default
(`--session-persistence false`), task-master passes `--no-session-persistence`
to claude so iterations don't pollute the project's resumable session history.
```

Bump type: `minor` (new flag, backward-compatible). Pattern matches `.changeset/loop-trace-level.md` and `.changeset/loop-timestamps.md`.

## Edge Cases Addressed

1. **Invalid value (`--session-persistence=yes`, `=1`, etc.):** Use Commander `InvalidArgumentError` in the option parser (precedent: `cluster-start.command.ts:60-76`). The parser must reject anything other than literal `"true"` / `"false"`.

2. **`--session-persistence` with no value:** Commander's `<value>` (angle brackets) makes the value **required**. Omitting it will produce a Commander error automatically ("error: option '--session-persistence <true|false>' argument missing"). No custom handling needed.

3. **Sandbox argv ordering:** In `buildCommandArgs` sandbox branch (`loop.service.ts:911-913`), append `--no-session-persistence` after `-p <prompt>`: `['sandbox', 'run', 'claude', '-p', prompt, '--no-session-persistence']`. claude CLI is position-insensitive for these flags.

4. **MCP boolean type consistency:** Use `z.boolean().optional().default(false).describe(...)` per `apps/mcp/src/tools/autopilot/start.tool.ts` precedent (Zod v3).

5. **Claude CLI does not support the flag:** Confirmed it DOES support it. No alternative needed.

6. **Existing tests asserting exact argv:** None found. `loop.service.spec.ts` uses `arrayContaining`. `cluster-start.command.spec.ts` has one literal-`[]` assertion at line 187-199 that would need updating only if the cluster path is changed (see Open Questions).

7. **(New) `--print` constraint:** Claude documents that `--no-session-persistence` "only works with --print". The loop path already passes `-p` (which is `--print` shorthand) at `loop.service.ts:915`. The start, cluster-start, and ClaudeExecutor paths do **NOT** currently pass `-p` and use interactive `stdio: 'inherit'`. See Open Questions.

## Code References

### Primary spawn sites
- `packages/tm-core/src/modules/loop/services/loop.service.ts:906-921` — `buildCommandArgs` (the argv builder)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:563` — `const command = sandbox ? 'docker' : 'claude';`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:579,646` — call sites of `buildCommandArgs`
- `packages/tm-core/src/modules/tasks/services/task-execution-service.ts:235-255` — `prepareExecutionCommand` for start
- `apps/cli/src/commands/start.command.ts:279` — `spawn(command.executable, command.args, ...)`
- `apps/cli/src/commands/cluster-start.command.ts:197` — `spawn('claude', [], ...)`
- `apps/cli/src/commands/cluster-start.command.ts:207-209` — stdin write
- `packages/tm-core/src/modules/execution/executors/claude-executor.ts:89,96` — `args = [prompt, ...additionalFlags]` and spawn

### CLI option layer
- `apps/cli/src/commands/loop.command.ts:21-31` — `LoopCommandOptions`
- `apps/cli/src/commands/loop.command.ts:56-65` — option declarations
- `apps/cli/src/commands/loop.command.ts:129-146` — option normalization + config build
- `apps/cli/src/commands/start.command.ts:26-33` — `StartCommandOptions`
- `apps/cli/src/commands/cluster-start.command.ts:22-30` — `ClusterStartOptions`
- `apps/cli/src/commands/cluster-start.command.ts:13,60-76` — `InvalidArgumentError` precedent

### Domain/config layer
- `packages/tm-core/src/modules/loop/types.ts:107-166` — `LoopConfig`
- `packages/tm-core/src/modules/loop/loop-domain.ts:184-199` — `buildConfig` defaults
- `packages/tm-core/src/modules/execution/types.ts:63-67` — `ClaudeExecutorConfig`

### MCP layer (for future expansion)
- `apps/mcp/src/index.ts` — server entry point and tool registration
- `apps/mcp/src/tools/autopilot/start.tool.ts` — boolean parameter Zod v3 pattern
- `apps/mcp/src/shared/{types,utils}.ts` — `ToolContext`, `handleApiResult`, `withToolContext`
- `apps/mcp/src/tools/README-ZOD-V3.md` — Zod v3 requirement explanation

### Test files
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:140-147,260-268,432-438` — argv assertion patterns
- `apps/cli/src/commands/loop.command.spec.ts:572-617` — verbose/trace config-passthrough tests
- `apps/cli/src/commands/cluster-start.command.spec.ts:187-199` — spawn call shape (literal `[]` args)
- `apps/cli/tests/integration/commands/loop.command.test.ts` — integration test pattern

### Changesets
- `.changeset/loop-trace-level.md` — minor-bump flag-addition prose precedent
- `.changeset/loop-timestamps.md` — similar precedent

## Architecture Documentation

### Current claude argv composition by path

| Path | Command | Argv pattern | Has `-p`/`--print`? | Stdio |
|---|---|---|---|---|
| `loop` (non-sandbox) | `claude` | `['-p', prompt, '--dangerously-skip-permissions', ...]` | Yes (`-p`) | `['inherit','pipe','pipe']` |
| `loop` (sandbox) | `docker` | `['sandbox', 'run', 'claude', '-p', prompt]` | Yes (`-p`) | `['inherit','pipe','pipe']` |
| `start` | `claude` | `[taskPrompt]` (prompt is bare positional) | **No** | `'inherit'` |
| `clusters start` | `claude` | `[]` (prompt via stdin) | **No** | `['pipe','inherit','inherit']` |
| `ClaudeExecutor` | `claude` (configurable) | `[prompt, ...additionalFlags]` | **No** (unless caller adds via additionalFlags) | `'inherit'` |

This table makes explicit that **only the loop path is currently compatible with `--no-session-persistence` semantics** as documented by the claude CLI ("only works with --print").

### Three-layer CLI plumbing convention

The codebase consistently uses:
1. **CLI layer** (`apps/cli/src/commands/*.command.ts`): Commander option declarations, `*CommandOptions` interface, normalization via `??` defaults, build `Partial<*Config>`, pass to domain.
2. **Domain layer** (`packages/tm-core/src/modules/*/`-domain.ts): `buildConfig(partial)` applies domain defaults via `??`, delegates to service.
3. **Service layer** (`packages/tm-core/src/modules/*/services/*.service.ts`): Performs the work, builds argv, calls `spawn`/`spawnSync`.

### Commander conventions
- Negation flags: `--no-foo` → implicit boolean default `true`, sets `false` when present (precedent: `--no-output` at `loop.command.ts:57-60`, `--no-status-update` at `start.command.ts:73-76`, `--no-header`, `--no-cache`).
- Bare boolean flags: `--flag` → `undefined` when absent, `true` when present (precedent: `--sandbox`, `--verbose`, `--trace`).
- Value-taking integer with custom parser: `--parallel <n>` with `InvalidArgumentError` (precedent: `cluster-start.command.ts:60-76`).
- **Value-taking boolean with custom parser: no existing precedent** — this PR introduces the pattern.

### MCP conventions
- Zod v3 (not v4) per `apps/mcp/src/tools/README-ZOD-V3.md` for Draft-07 JSON Schema compatibility.
- Boolean parameters: `z.boolean().optional().default(false).describe(...)`.
- Tool handler returns via `handleApiResult(...)`.
- Tool registered via `withToolContext(server, tmCore, ...)`.

## Historical Context (from thoughts/shared/)

- `thoughts/shared/questions/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — Active parallel refactor replacing `--verbose`/`--trace` booleans with `--tracelevel <none|verbose|trace>`. Independent of session-persistence work; both can land in parallel.
- `thoughts/shared/research/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — Complete research for the tracelevel refactor mapping out all callback gating, sandbox compatibility, and test coverage sites. Confirms the same `LoopConfig` / `buildCommandArgs` plumbing model.
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Completed work on persisting `--trace` output to the loop progress file. Documents trace callback architecture inside `LoopService` and per-iteration buffer flush model.
- `thoughts/shared/claude-code-design/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Architectural decision: write progress-file output inside `LoopService` at the same emit sites as trace callbacks, per-iteration buffer flush, 10KB truncation, JSON formatting.
- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — Implementation plan for the trace persistence work; provides concrete `LoopService` shape that this work will extend.

## Related Research

- `thoughts/shared/questions/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` (tag-79bd39, active)
- `thoughts/shared/research/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` (tag-79bd39, active)
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` (tag-38a2bd, archived)

## Open Questions

1. **`--print` constraint for non-loop paths.** Claude CLI documents that `--no-session-persistence` "only works with --print". Three of the four paths (`start`, `clusters start`, `ClaudeExecutor`) currently do NOT pass `-p`/`--print` and use interactive stdio. To honor the original ask ("All. loop, start, clusters start, and any other path through ClaudeExecutor"), the implementation must either:
   - (a) Also add `-p`/`--print` to those paths' argv when `sessionPersistence=false`, which **changes them from interactive to non-interactive mode** — a substantial behavior change.
   - (b) Restructure `start`/`cluster-start`/`ClaudeExecutor` to use `-p` everywhere (likely breaks current interactive UX).
   - (c) Document that `--session-persistence` is a **no-op** in interactive paths and only meaningful in `loop` (the only `--print`-based path today). The flag is still accepted on those commands for API symmetry but emits a warning or is silently inert.
   - (d) Limit the flag to `loop` only in this PR, and revisit `start`/`cluster-start`/`ClaudeExecutor` separately once a `--print` migration is in scope.

2. **No MCP wrappers for `loop`, `start`, `clusters start` exist today.** The original ask says "Expose the same option as a parameter on the corresponding MCP tools." Implementation must decide:
   - (a) Add the flag to the CLI now; create MCP wrappers in a follow-up. The flag is on the CLI surface only.
   - (b) Create MCP wrappers as part of this PR to expose `loop`/`start`/`clusters start` over MCP with `sessionPersistence` from day one. This expands scope considerably.
   - The autopilot start tool (`apps/mcp/src/tools/autopilot/start.tool.ts`) is a **different code path** from the CLI's top-level `start` — it does not spawn claude.

3. **Sandboxed claude binary version.** The `--no-session-persistence` flag was verified against host `claude` v2.1.145. Whether the claude binary inside the docker sandbox (invoked via `docker sandbox run claude ...`) is the same version / supports the flag is unverified. A runtime smoke test or a documented minimum-version assumption is warranted.

4. **Default-false breaks existing user workflows?** Users who previously ran `task-master loop` and relied on a resumable session for `claude --resume` afterward would lose that capability silently. Whether to surface this in a `--help` note or first-run notice is a UX call.
