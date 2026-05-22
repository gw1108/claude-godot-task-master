---
topic: "Eliminate LLM Tool-Search Overhead in Taskmaster Loop Presets by Using Explicit MCP Tool Names"
tags: [research, codebase, loop, presets, mcp, tag-368d3b]
status: complete
source_question: thoughts/shared/questions/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md
---

# Research: Eliminate LLM Tool-Search Overhead in Taskmaster Loop Presets by Using Explicit MCP Tool Names

## Research Question
The Taskmaster loop presets in `packages/tm-core/src/modules/loop/presets/` instruct the LLM in natural language ("Run task-master next (or use MCP)…"). When the loop runs at `--trace`, traces show the LLM performing a tool-search step before invoking `mcp__task-master-ai__next_task`. The work is to rewrite every step in every preset that calls task-master to name the exact MCP tool so the LLM routes directly to it. CLI form (`task-master <cmd>`) should be removed from the prompts entirely — MCP only.

Research deliverables: (a) the exact MCP tool name for every task-master CLI command referenced in any preset, (b) a list of every preset line that needs rewriting, (c) confirmation that the rewrite eliminates the tool-search step (verified against `--trace` output), and (d) a recommendation on whether non-task-master fuzzy hints (typecheck/test command examples) and the `TASK_MASTER_TOOLS` tier setting affect the optimization.

## Summary

There are five preset files in `packages/tm-core/src/modules/loop/presets/`. Only one of them — `default.ts` — actually invokes task-master in its instructions (steps 1, 2, and 7). The other four (`duplication.ts`, `entropy.ts`, `linting.ts`, `test-coverage.ts`) do not reference any `task-master <cmd>` text and instead drive workflows via shell tools (`npx jscpd`, `pnpm lint`, etc.); they do not call the Taskmaster backlog at all.

All three task-master commands referenced by `default.ts` map directly to MCP tools exposed in the **`core`** tier — the default `TASK_MASTER_TOOLS` baseline — so the rewrite does not require any tier change:

| CLI in `default.ts` | MCP tool | Tier | Required params |
|---|---|---|---|
| `task-master next` (step 1) | `mcp__task-master-ai__next_task` | core | `projectRoot` |
| `task-master show <id>` (step 2) | `mcp__task-master-ai__get_task` | core | `id`, `projectRoot` |
| `task-master set-status --id=<id> --status=done` (step 7) | `mcp__task-master-ai__set_task_status` | core | `id`, `status`, `projectRoot` |

The `LoopService` only verifies the CLI binary (`task-master --version`) once before any iterations begin, and only for the `default` preset (`packages/tm-core/src/modules/loop/services/loop.service.ts:55-87, 184-190`). It does not verify MCP server readiness. The MCP server connection itself is handled by Claude Code's host; the `task-master-ai` server is a deferred/lazy connection (system-reminders show it as "still connecting" on cold start, then tools appear via `ToolSearch`).

The `default.ts` preset also includes two non-task-master "e.g." command hints (steps 5 and 6, lines 17–18) that name shell commands (`npm run typecheck`, `npm test`, etc.). These are advisory text for a Bash invocation path, not MCP discovery, so they are out of scope for the MCP-search optimization.

The trace-level service (`packages/tm-core/src/modules/loop/services/trace-level.ts`) is responsible only for the numeric gating of which callbacks fire at `none`/`verbose`/`trace`. The tool-search step itself is emitted by the LLM/host (not by Taskmaster code) — Taskmaster's role is to log it via the `onToolUse`/`onToolInput` callbacks at trace level. No `.pipeline_state_tag-368d3b.json` or other repo-root trace artifact contains tool-search evidence; that file is a separate workflow state machine unrelated to loop traces.

## Detailed Findings

### 1. Preset audit — which presets actually invoke task-master

#### `default.ts` (the only preset referencing task-master)
**File:** `packages/tm-core/src/modules/loop/presets/default.ts:10-29`

Three steps reference task-master CLI commands. All three are in scope for the MCP rewrite (steps 8 and 9 — commit and progress notes — are explicitly out of scope per the question file):

- `default.ts:13` — step 1: `Run task-master next (or use MCP) to get the next available task/subtask.`
- `default.ts:14` — step 2: `Read task details with task-master show <id>.`
- `default.ts:19` — step 7: `Mark complete: task-master set-status --id=<id> --status=done`

Step 1 is the line that explicitly mentions "(or use MCP)" — the ambiguous wording flagged in the original question. Steps 2 and 7 reference CLI only (no "or use MCP" hint), which is presumably why the LLM tool-search shows up specifically at the entry of the iteration: step 1 is the first place where the LLM must decide CLI-vs-MCP and discovers the MCP tool by enumeration.

The preset doc-comment at `default.ts:5-9` says:
> task-master CLI availability is verified once before the loop starts (see LoopService.checkTaskMasterAvailable). Setup instructions are intentionally not embedded in the prompt to avoid spending tokens on a precondition the LLM cannot act on mid-iteration.

This comment becomes stale if the rewrite removes CLI references entirely, because `checkTaskMasterAvailable` still runs the CLI binary check — see Edge Cases below.

#### Other preset files — no task-master CLI references in prompt body

- `duplication.ts:4-34` (`DUPLICATION_PRESET`) — workflow is `npx jscpd .` (step 1) plus generic refactor/test/commit instructions. No `task-master` text anywhere.
- `entropy.ts:5-43` (`ENTROPY_PRESET`) — refers to "tools like `complexity-report`" (line 24) but this is a generic hint without `task-master` prefix; no MCP/CLI command names are given.
- `linting.ts:4-34` (`LINTING_PRESET`) — runs lint/typecheck shell commands (`pnpm lint`, `tsc --noEmit`, etc.); no `task-master` text.
- `test-coverage.ts:4-41` (`TEST_COVERAGE_PRESET`) — runs coverage shell commands (`pnpm coverage`); no `task-master` text.

Result: **only `default.ts` needs MCP rewrites for task-master references**. The other four presets have no `task-master <cmd>` lines to convert. The `complexity-report` mention in `entropy.ts:24` is a generic noun, not a command invocation.

### 2. MCP tool name catalog

There are two MCP server implementations:
- **Production server:** `mcp-server/src/` (JS) — reads `TASK_MASTER_TOOLS`, enforces tiers, exposed via `npx task-master-ai`.
- **TypeScript package:** `apps/mcp/src/` (`@tm/mcp`) — registration helpers imported by the JS server (`mcp-server/src/tools/tool-registry.js:40-54`).

All tools are surfaced to the host with the prefix `mcp__task-master-ai__` (server alias from `.mcp.json`).

#### Tier composition (`mcp-server/src/tools/tool-registry.js`)
- **`core` (7 tools, lines 112–120):** `get_tasks`, `next_task`, `get_task`, `set_task_status`, `update_subtask`, `parse_prd`, `expand_task`
- **`standard` (14 tools, lines 126–135):** core + `initialize_project`, `analyze_project_complexity`, `expand_all`, `add_subtask`, `remove_task`, `add_task`, `complexity_report`
- **`all` (45+ tools, lines 60–106):** everything in `toolRegistry`, including `models`, `rules`, `update*`, `*_dependency`, `*_tag`, `research`, `scope_*_task`, `autopilot_*`, `generate`, `loop`

`TASK_MASTER_TOOLS` is read in `mcp-server/src/tools/index.js:21` and defaults to `"core"` when absent or empty. A switch at line 50 maps the value to the matching array; arbitrary comma-separated values are also accepted (lines 65–129).

#### Mapping for each task-master CLI command currently or potentially in scope

| CLI command | MCP tool name (sans `mcp__task-master-ai__` prefix) | Tier | Required params | Notable optional params | Schema source |
|---|---|---|---|---|---|
| `task-master next` | `next_task` | core | `projectRoot` | `file`, `complexityReport`, `tag` | `mcp-server/src/tools/next-task.js:28-40` |
| `task-master show <id>` | `get_task` | core | `id`, `projectRoot` | `status`, `tag` | `apps/mcp/src/tools/tasks/get-task.tool.ts:15-29` |
| `task-master list` | `get_tasks` | core | `projectRoot` | `status`, `withSubtasks`, `tag` | `apps/mcp/src/tools/tasks/get-tasks.tool.ts:15-30` |
| `task-master set-status --id=<id> --status=done` | `set_task_status` | core | `id`, `status` (enum), `projectRoot` | `tag` | `apps/mcp/src/tools/tasks/set-task-status.tool.ts:12-25` |
| `task-master update-subtask --id=<id> --prompt=...` | `update_subtask` | core | `id`, `projectRoot` (+ `prompt` or `metadata`) | `research`, `metadata`, `file`, `tag` | `mcp-server/src/tools/update-subtask.js:27-52` |
| `task-master expand --id=<id>` | `expand_task` | core | `id`, `projectRoot` | `num`, `research`, `prompt`, `force`, `file`, `tag` | `mcp-server/src/tools/expand-task.js:27-54` |
| `task-master analyze-complexity` | `analyze_project_complexity` | **standard** | `projectRoot` | `threshold`, `research`, `output`, `file`, `ids`, `from`, `to`, `tag` | `mcp-server/src/tools/analyze.js:29-78` |
| `task-master complexity-report` | `complexity_report` | **standard** | `projectRoot` | `file` | `mcp-server/src/tools/complexity-report.js:25-33` |

For the three commands `default.ts` actually uses (`next_task`, `get_task`, `set_task_status`), **all three are in the `core` tier**, so no tier change is required.

`id` accepts `taskIdsSchema` — single ID or comma-separated, including subtask form `"1.2"` and external IDs like `"HAM-123"` (`apps/mcp/src/tools/tasks/get-task.tool.ts:15-29`, `set-task-status.tool.ts:12-25`).

`status` for `set_task_status` is an enum: `pending`, `done`, `in-progress`, `review`, `deferred`, `cancelled`, `blocked` (`apps/mcp/src/tools/tasks/set-task-status.tool.ts:12-25`).

#### Naming caveat — `autopilot_complete`

The registry key in `tool-registry.js:100` is `autopilot_complete`, but the FastMCP registration in `apps/mcp/src/tools/autopilot/complete.tool.ts:32` exposes the tool to clients as `autopilot_complete_phase`. Tier filtering uses the registry key; the on-wire tool name is the latter. Not in scope for the loop preset rewrite, but worth noting for any future preset that needs autopilot.

#### Tools registered outside the tier system
- `autopilot_create_pr` (file at `apps/mcp/src/tools/autopilot/create-pr.tool.ts:58`) — exported but absent from `toolRegistry`.
- `get_operation_status` (file at `mcp-server/src/tools/get-operation-status.js`) — absent from `toolRegistry`.

### 3. Trace-level evidence — where the tool-search step is observed

#### Trace level service
**File:** `packages/tm-core/src/modules/loop/services/trace-level.ts` (14 lines)

Defines `TRACE_LEVEL_WEIGHTS` (`none=0`, `verbose=1`, `trace=2`) and `atLeast(level, threshold)` (`trace-level.ts:3-14`). It has no output logic of its own — it only gates which callbacks fire and which lines land in the progress file.

#### Where trace output is produced
The progress file location defaults to `path.join(this.projectRoot, '.taskmaster', 'progress.txt')` (`packages/tm-core/src/modules/loop/loop-domain.ts:189-191`). It is append-only via `appendFile` (`loop.service.ts:893-903`).

At `--tracelevel trace`, the progress file accumulates these blocks per iteration (`loop.service.ts:682-915, 1026-1090`):
- `## [VERBOSE] Iteration N`
- `### [TRACE] LLM input` — a fenced block containing the full assembled prompt
- For each tool call: `### [TRACE] Tool: <name> input` and `### [TRACE] Tool: <name> result` as fenced JSON blocks
- An iteration summary with sorted tool-call counts

These are populated by callback handlers `onPromptSent`, `onToolUse`, `onToolInput`, `onToolResult`, `onIterationSummary` (`loop.service.ts:851-867, 1051-1089`).

#### What the tool-search step actually is
Taskmaster code does not emit a tool-search line itself. The tool search is an LLM-side decision visible in the assistant stream as one or more invocations of the host's `ToolSearch` tool (the "deferred tools" mechanism — see the system-reminder format `Use ToolSearch with query "select:<name>"`). It will appear in the progress file under `### [TRACE] Tool: ToolSearch input` blocks at trace level. The trigger is that the system-reminder lists `mcp__task-master-ai__*` tools as **deferred** until their schemas are explicitly loaded — the LLM sees only tool names, not schemas, and must either (a) trust a fully-qualified name in the prompt, or (b) call `ToolSearch` first to fetch the schema before invoking the MCP tool.

#### Repo-root state file
**File:** `.pipeline_state_tag-368d3b.json` (untracked)
```json
{ "current_stage": 1, "current_input": "C:\\GameDev\\...\\2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md" }
```
This is not produced by `LoopService`. It belongs to a separate pipeline state machine tracking the multi-stage research workflow (the `tag-368d3b` work item). It contains no tool-search evidence.

#### `.taskmaster/loop-progress.txt`
A hand-written human progress log from 2026-01-08, not generated by `LoopService` — has no `[VERBOSE]`/`[TRACE]` prefixes and is not a usable trace artifact.

No active `--trace` log file from a `task-master loop` run was found in the repo. To produce one for verification, a run such as `task-master loop --tracelevel trace --max-iterations 1` would write to `.taskmaster/progress.txt`.

### 4. MCP-vs-CLI fallback semantics

#### Current state — CLI binary check, no MCP check
**`LoopService.checkTaskMasterAvailable`** runs at `packages/tm-core/src/modules/loop/services/loop.service.ts:55-87`:
- Spawns `task-master --version` via `spawnSync` with `cwd: this.projectRoot`, `timeout: 10000`, `shell: process.platform === 'win32'`.
- On `ENOENT`: returns `'task-master CLI not found. Install with: npm i -g task-master-ai'`.
- On non-zero exit: returns a message including the exit code.
- On success: `{ available: true }`.

Called from `run()` at `loop.service.ts:184-190`, guarded by:
```ts
if (config.prompt === 'default' && !config.sandbox) { /* check */ }
```
- Only runs for the `default` preset.
- Only runs when `sandbox` is off.
- On failure, the run returns immediately with `finalStatus: 'error'`; no iterations are spawned.

**There is no MCP availability check anywhere in the loop module.** MCP connectivity is the responsibility of Claude Code's host (which manages the `task-master-ai` MCP server lifecycle defined in `.mcp.json`). The host handles lazy connection — the system-reminder pattern `MCP servers are still connecting — their tools … will appear shortly` describes exactly this lifecycle for `task-master-ai`.

#### Mid-loop MCP disconnect
The service has no code paths that detect or recover from MCP server disconnection. If MCP drops between iterations, the LLM would fail to call `mcp__task-master-ai__next_task` and the iteration would either error out or the LLM would fall back to a different approach. The host's behavior — not Taskmaster's — determines what happens.

### 5. Tool-search trigger root cause

Three candidate triggers were investigated:

**(i) Ambiguous "or use MCP" phrasing without a concrete name** — `default.ts:13`. The phrase `(or use MCP)` does not specify which MCP tool. The LLM, seeing the `task-master-ai` server's tool names in the deferred-tools list but without schemas loaded, must call `ToolSearch` to fetch a schema before invoking the tool. Naming the tool explicitly (`mcp__task-master-ai__next_task`) and including required parameter cues (`projectRoot`) gives the LLM enough information to invoke the tool directly without `ToolSearch`. The MCP tools start in the deferred state per the system-reminder mechanism — this is the dominant cause.

**(ii) MCP server lazy connection** — `task-master-ai` MCP is described in system-reminders as "still connecting" on cold start, then tools appear via `ToolSearch`. This is host behavior; once the server is connected and schemas are loaded for a given tool, subsequent calls in the same session do not need to re-search. So this primarily affects the first iteration's first MCP call, not every iteration.

**(iii) Tier-loading lag for non-core tools** — Tier loading is static at server boot (`mcp-server/src/tools/index.js:21, 40-54`); there is no per-tool lazy load within a tier. All `core` tools are registered when the server starts. So tier loading is not a runtime trigger.

**Conclusion: cause (i) is the primary trigger.** Including the fully-qualified tool name in the preset (e.g., `mcp__task-master-ai__next_task` with explicit `projectRoot` parameter guidance) lets the LLM bypass `ToolSearch` and call the MCP tool directly.

### 6. Tier-aware prompting (`TASK_MASTER_TOOLS`)

The three commands `default.ts` references map to **core**-tier MCP tools (`next_task`, `get_task`, `set_task_status`). No tier upgrade is needed to support the rewrite at the documented baseline (`TASK_MASTER_TOOLS=core`).

Other task-master commands that *might* enter loop presets in future revisions:
- `update_subtask`, `parse_prd`, `expand_task` — **core**, safe.
- `get_tasks`, `analyze_project_complexity`, `complexity_report`, `add_task`, `expand_all` — **standard**, would require users to set `TASK_MASTER_TOOLS=standard` or higher.
- Everything else (autopilot, tags, dependencies, research, models, rules, scope) — **all** tier only.

### 7. Non-task-master fuzzy hints (typecheck/test)

**Lines in scope:**
- `default.ts:17` — `Run type check (e.g., \`npm run typecheck\`, \`tsc --noEmit\`).`
- `default.ts:18` — `Run tests (e.g., \`npm test\`, \`npm run test\`).`

These are shell-command hints; they do not invoke any MCP tool. The LLM resolves them through the `Bash` tool, whose schema is always loaded (it is a built-in host tool, not deferred). No `ToolSearch` step is required for the `Bash` tool itself. The "e.g." phrasing prompts the LLM to choose between alternatives based on what is actually present in the repo — that decision happens through plain reading of `package.json` (`Read` tool) or by attempting one of the listed commands.

Therefore: **typecheck/test hints do not contribute to the MCP tool-search overhead**. They may still produce *generic* overhead (the LLM may inspect `package.json` to choose among alternatives) but that is a separate optimization category outside the MCP discovery problem described in the question.

The same five preset files share this pattern:
- `duplication.ts:14` — `Run duplication detection (\`npx jscpd .\`, or similar tool)`
- `entropy.ts:24` — `Scan the codebase for code smells (use your judgment or tools like \`complexity-report\`)`
- `linting.ts:14` — `Run lint command (\`pnpm lint\`, \`npm run lint\`, \`eslint .\`, etc.)`
- `linting.ts:15` — `Run type check (\`pnpm typecheck\`, \`tsc --noEmit\`, etc.)`
- `test-coverage.ts:23` — `Run coverage command (\`pnpm coverage\`, \`npm run coverage\`, etc.)`

All are Bash-resolved hints — not MCP discovery vectors.

## Edge Cases Addressed

### Preset references a CLI command without a `core`-tier MCP equivalent
For the three commands actually in `default.ts` (`next`, `show`, `set-status`), all map to core-tier tools. No flag needed. If future loop presets reference `analyze-complexity` or `complexity-report`, those are **standard** tier — users would need `TASK_MASTER_TOOLS=standard` or higher.

### MCP server is configured but not yet connected when the loop iteration begins
The system-reminder `The following MCP servers are still connecting … task-master-ai` describes the host's behavior on cold start. `LoopService` does not detect this; the LLM sees deferred tool names and calls `ToolSearch`, which the host says "will wait for connecting servers and search their tools once available." That mechanism handles the cold-start race transparently — the LLM is not blocked, but a `ToolSearch` call is consumed.

`LoopService.checkTaskMasterAvailable` (`loop.service.ts:55-87`) does not verify MCP readiness. There is no built-in `LoopService` hook to verify the MCP server is connected before iterations begin.

### Preset doc-comment at `default.ts:5-9` becomes stale
The comment currently says "task-master CLI availability is verified once before the loop starts (see `LoopService.checkTaskMasterAvailable`)". The `checkTaskMasterAvailable` method itself still runs `task-master --version` (`loop.service.ts:56-62`) and is still called from `run()` (`loop.service.ts:185-190`). If the rewrite removes CLI references from the prompt body but keeps the CLI check, the comment becomes inconsistent with the prompt content — the precondition the LLM is being told nothing about is still being checked. Updating the comment block to reflect "MCP server tools are invoked by name in the prompt; CLI binary is still verified once before the loop starts as a heuristic" matches reality.

### Preset references a generic task-master concept rather than a specific command
`default.ts:10` opens with `TASK: Implement ONE task/subtask from the Taskmaster backlog.` — this is conceptual framing, not a command. It does not trigger tool search and is acceptable.

### The `mcp__task-master-ai__loop` MCP tool exists — recursion boundary
Verified that `loop` is registered as an MCP tool at `apps/mcp/src/tools/loop/loop.tool.ts:78`, in the **all** tier (`mcp-server/src/tools/tool-registry.js`). No preset currently references it. The `default.ts` instructions explicitly say `Do NOT start another task after completing one.` (line 26) and the loop terminates via `<loop-complete>` or `<loop-blocked>` tags — there is no instruction in any preset that could plausibly induce recursion. No additional guard is required, but the rewrite should not accidentally introduce a reference to `mcp__task-master-ai__loop`.

### Trace-level service is the right place to look for discovery-step evidence
`trace-level.ts` only defines weights and the `atLeast` comparator. The actual progress-file trace lines for tool calls are emitted from `loop.service.ts:1026-1090` (the stream-event handler) and `loop.service.ts:851-867` (the iteration summary). At `--tracelevel trace`, the progress file at `.taskmaster/progress.txt` will contain `### [TRACE] Tool: ToolSearch input` blocks if and only if the LLM called `ToolSearch`. That is the verification point for "did the rewrite eliminate the search step".

## Code References

### Preset files
- `packages/tm-core/src/modules/loop/presets/default.ts:5-9` — preset comment block (may become stale)
- `packages/tm-core/src/modules/loop/presets/default.ts:13` — step 1 (`task-master next (or use MCP)`)
- `packages/tm-core/src/modules/loop/presets/default.ts:14` — step 2 (`task-master show <id>`)
- `packages/tm-core/src/modules/loop/presets/default.ts:17-18` — typecheck/test hints (out of scope for MCP discovery)
- `packages/tm-core/src/modules/loop/presets/default.ts:19` — step 7 (`task-master set-status --id=<id> --status=done`)
- `packages/tm-core/src/modules/loop/presets/duplication.ts:4-34` — no task-master references
- `packages/tm-core/src/modules/loop/presets/entropy.ts:5-43` — no task-master references
- `packages/tm-core/src/modules/loop/presets/linting.ts:4-34` — no task-master references
- `packages/tm-core/src/modules/loop/presets/test-coverage.ts:4-41` — no task-master references
- `packages/tm-core/src/modules/loop/presets/index.ts:16-22, 43-45` — `PRESETS` record, `isPreset` predicate

### Loop service
- `packages/tm-core/src/modules/loop/services/loop.service.ts:55-87` — `checkTaskMasterAvailable` implementation
- `packages/tm-core/src/modules/loop/services/loop.service.ts:184-190` — gated call site (only runs when `prompt === 'default' && !sandbox`)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:496-505` — `resolvePrompt` (preset lookup)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:507-521` — `buildContextHeader`, `buildPrompt`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:970-993` — `buildCommandArgs` (CLI invocation of `claude -p <prompt>`)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:682-915` — `executeVerboseIteration` (stream parsing)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:1026-1090` — `handleStreamEvent` (where tool-use stream events become file lines)
- `packages/tm-core/src/modules/loop/services/trace-level.ts:3-14` — `TRACE_LEVEL_WEIGHTS`, `atLeast`

### MCP tool registrations (for the rewrite targets)
- `mcp-server/src/tools/next-task.js:25-40` — `next_task` registration and schema
- `apps/mcp/src/tools/tasks/get-task.tool.ts:15-36` — `get_task` schema and registration
- `apps/mcp/src/tools/tasks/set-task-status.tool.ts:12-32` — `set_task_status` schema and registration

### Tier system
- `mcp-server/src/tools/index.js:21, 40-54` — `TASK_MASTER_TOOLS` read and dispatch
- `mcp-server/src/tools/tool-registry.js:60-106` — full `toolRegistry`
- `mcp-server/src/tools/tool-registry.js:112-120` — `coreTools` (7)
- `mcp-server/src/tools/tool-registry.js:126-135` — `standardTools` (14)

### Loop entry points
- `apps/cli/src/commands/loop.command.ts:70-77` — CLI `--tracelevel` option
- `apps/cli/src/commands/loop.command.ts:149, 159` — `traceLevel` wiring into `LoopConfig`
- `apps/mcp/src/tools/loop/loop.tool.ts:38-43, 78, 106` — MCP `loop` tool schema, registration, and `traceLevel` pass-through

### Repo-root state files
- `.pipeline_state_tag-368d3b.json` (untracked) — workflow state machine, unrelated to loop trace
- `.taskmaster/loop-progress.txt` — hand-written human log, not generated by `LoopService`

## Architecture Documentation

### Loop module layering
- `LoopDomain` (facade) in `loop-domain.ts` wraps `LoopService` (execution) in `services/loop.service.ts`.
- Two entry points: `apps/cli/src/commands/loop.command.ts` (CLI) and `apps/mcp/src/tools/loop/loop.tool.ts` (MCP). Both call `tmCore.loop.run(config)`.
- Presets live in `presets/*.ts`, registered in `presets/index.ts` via the `PRESETS` record.
- Prompt assembly: `resolvePrompt` (preset name → string), `buildContextHeader` (`@progressFile @CLAUDE.md\n\nLoop iteration i of N`), `buildPrompt` (concat). The result is passed to `claude -p <prompt>` (`loop.service.ts:970-993`).

### Trace-level model
- Three levels: `none` (0), `verbose` (1), `trace` (2). Type at `types.ts:108`.
- Atomic gating via `atLeast(level, threshold)`.
- Three concentric tiers: always-on callbacks, verbose-tier (adds `onText`, `onToolUse`, switches to async `spawn` with `stream-json`), trace-tier (adds `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`, full prompt and per-tool JSON blocks to the progress file).
- File lines for verbose/trace levels are tagged `[VERBOSE]` or `[TRACE]` via `tagEntry` (`loop.service.ts:458-490`).

### MCP tool exposure
- Production server is JS at `mcp-server/src/`; TS tools from `@tm/mcp` (`apps/mcp/src/`) are mounted via `registerTaskMasterTools` (`mcp-server/src/tools/tool-registry.js:40-54`).
- `TASK_MASTER_TOOLS` selects which subset to register at boot.
- The host (Claude Code) sees tool names as `mcp__task-master-ai__<name>` and treats them as deferred until `ToolSearch` loads their schemas.

## Historical Context (from thoughts/shared/)

The current ticket builds on four completed loop-trace-related changes, all archived under `thoughts/shared/{research,plans,questions,claude-code-design}/ARCHIVE/`:

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — introduced the `--tracelevel` enum and `LoopTraceLevel` type, replacing `--verbose`/`--trace` booleans.
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — inventoried the nine trace callbacks (`onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary`, `onText`, `onToolUse`, `onIterationStart`, `onIterationEnd`, `onLoopStart`) and their emit sites in `loop.service.ts`.
- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md` — added `[VERBOSE]`/`[TRACE]` prefixes to the progress-file lines.
- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md` — silenced verbose/trace console output while preserving file writes.

These four items together explain why the trace artifact lands at `.taskmaster/progress.txt` (the default) and why `ToolSearch` calls would appear there at `--tracelevel trace` as `### [TRACE] Tool: ToolSearch input` blocks.

Public documentation of the loop feature lives at `apps/docs/capabilities/loop.mdx`.

## Related Research

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md`
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md`
- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md`
- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md`

## Open Questions

- No live `--trace` log file from a recent `task-master loop` run was located in the repo at the time of research. The verification step "confirm the rewrite eliminates the tool-search step" requires a fresh trace run (e.g., `task-master loop --tracelevel trace --max-iterations 1`) before and after the rewrite, then a diff of `.taskmaster/progress.txt` looking for `### [TRACE] Tool: ToolSearch input` blocks.
- The `default.ts:5-9` doc comment references only CLI verification. Whether to also update `checkTaskMasterAvailable` itself (or add an MCP readiness probe) is a design choice not answerable from research alone.
- Whether the preset rewrite should retain or remove the standalone `TASK: Implement ONE task/subtask from the Taskmaster backlog.` framing line (`default.ts:10`) is a wording call — it does not trigger tool search and has no behavioral impact.
- Whether to enrich `default.ts` step 1 with explicit parameter guidance for `projectRoot` (e.g., "use the absolute path of the project") to further reduce host-side reasoning is a tuning question that would benefit from before/after trace comparison.
