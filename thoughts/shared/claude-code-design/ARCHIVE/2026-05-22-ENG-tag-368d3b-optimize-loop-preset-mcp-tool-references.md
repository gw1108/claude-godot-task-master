---
topic: "Eliminate LLM Tool-Search Overhead in Taskmaster Loop Presets by Using Explicit MCP Tool Names"
tags: [design, loop, presets, mcp, tag-368d3b]
status: complete
source_research: thoughts/shared/research/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md
---

# Design: Eliminate LLM Tool-Search Overhead in Taskmaster Loop Presets by Using Explicit MCP Tool Names

## Problem Statement

The `default` Taskmaster loop preset instructs the LLM in natural language ("Run task-master next (or use MCP)…") to invoke task-master. Because the `mcp__task-master-ai__*` tools are exposed to the host as deferred tools (names visible, schemas not loaded), the LLM must call `ToolSearch` to fetch a schema before it can invoke the MCP tool. At `--tracelevel trace`, this shows up as `### [TRACE] Tool: ToolSearch input` blocks at the start of each iteration's first task-master call. The goal is to rewrite every task-master step in the preset to name the exact MCP tool plus a complete parameter shape, so the LLM routes directly to the tool and the `ToolSearch` step is eliminated. CLI invocation form is removed from the prompt body entirely; the loop service's local CLI binary check is replaced with an MCP-side readiness probe.

## Research Source

`thoughts/shared/research/2026-05-22-ENG-tag-368d3b-optimize-loop-preset-mcp-tool-references.md`

## Design Decisions

### Scope of preset rewrite
**Choice:** Only `packages/tm-core/src/modules/loop/presets/default.ts` is rewritten. The other four presets (`duplication.ts`, `entropy.ts`, `linting.ts`, `test-coverage.ts`) are not modified.
**Rationale:** Research found these four presets contain no `task-master <cmd>` text and drive their workflows entirely through shell tools (`npx jscpd`, `pnpm lint`, etc.). They have no MCP discovery vector to optimize. The generic mention of `complexity-report` in `entropy.ts:24` is a noun, not a command invocation.

### Steps inside `default.ts` that are rewritten
**Choice:** Only steps 1, 2, and 7 are rewritten. Steps 5 and 6 (typecheck/test "e.g." Bash hints) and steps 8 and 9 (commit, progress notes) are left as-is. The opening framing line `TASK: Implement ONE task/subtask from the Taskmaster backlog.` is kept verbatim.
**Rationale:** Research showed that the typecheck/test hints resolve through the `Bash` tool, whose schema is always loaded — they do not contribute to MCP `ToolSearch` overhead. The `TASK: …` line has no behavioral impact on tool routing. Steps 8 and 9 were explicitly declared out of scope in the source question. Limiting the rewrite to the three lines that actually trigger `ToolSearch` keeps the change minimal and easy to verify.

### Wording style for MCP tool references
**Choice:** Tool name + full parameter block (JSON-ish shape) on every rewritten step. Each step explicitly names `mcp__task-master-ai__<tool>` and lists the full parameter object the LLM must pass, with `projectRoot` always included.
**Rationale:** Of the three candidate phrasings (bare name; name + brief param hint; name + full param block), the full param block leaves the least room for the LLM to guess parameter shape and therefore the least incentive to call `ToolSearch` to confirm a schema. The slight prompt-length cost (a few dozen tokens) is outweighed by eliminating one `ToolSearch` round-trip per iteration at trace level. Maps to the research's "cause (i) is the primary trigger" finding — the LLM bypasses `ToolSearch` when it sees a fully-qualified name with parameter cues.

### Concrete shape per call
**Choice:** The three task-master calls in `default.ts` become:

- Step 1 → `mcp__task-master-ai__next_task` with `{ projectRoot: "<resolved abs path>" }`.
- Step 2 → `mcp__task-master-ai__get_task` with `{ id: "<task id>", projectRoot: "<resolved abs path>" }`.
- Step 7 → `mcp__task-master-ai__set_task_status` with `{ id: "<task id>", status: "done", projectRoot: "<resolved abs path>" }`.

**Rationale:** These three tools are all in the `core` MCP tier per the research catalog, so no `TASK_MASTER_TOOLS` tier change is needed at the documented baseline. The parameter sets are the minimal-required schemas from the research table (`next-task.js:28-40`, `get-task.tool.ts:15-29`, `set-task-status.tool.ts:12-25`). The `status` enum value `"done"` is fixed (this step is the completion step).

### `projectRoot` injection mechanism
**Choice:** Convert `DEFAULT_PRESET` from a plain `string` constant to a function `(ctx: { projectRoot: string }) => string`. `LoopService.resolvePrompt` calls the function with `{ projectRoot: this.projectRoot }`. The other four preset files are wrapped as zero-arg functions `() => STRING_CONSTANT` so the `PRESETS` registry has a uniform value type.
**Rationale:** The user requirement is that `projectRoot` is substituted deterministically in code, not left as a placeholder for the LLM to fill in. A function-shaped preset is type-safe, avoids informal `{{placeholder}}` syntax, and makes the dependency on `projectRoot` explicit in the preset signature. Wrapping the unchanged presets as zero-arg functions keeps the registry homogeneous (`Record<string, (ctx: PresetCtx) => string>` where `PresetCtx = { projectRoot: string }`); zero-arg presets ignore the argument. The registry type — and therefore the `isPreset` predicate — stays a single-line change.

### CLI binary check replaced by MCP readiness probe
**Choice:** Remove `LoopService.checkTaskMasterAvailable` and its `task-master --version` spawn. Add `LoopService.checkMcpServerAvailable(serverAlias: string)` that performs a **config-only check**: verify the named server (`'task-master-ai'`) exists as an entry in the resolved Claude Code MCP config (`.mcp.json` / equivalent merged config). No live tool invocation, no IPC. Call site in `run()` keeps the same gating (`config.prompt === 'default' && !config.sandbox`) but invokes the new method.
**Rationale:** Once the preset no longer references the CLI, verifying the CLI binary is the wrong heuristic — a user with the MCP server configured but no global CLI install would be blocked unnecessarily. A config-only check is fast (sync file read), adds no startup latency, and signals the right precondition (the MCP server is wired up). A live tool ping was considered but rejected as too heavy for a precondition check that runs on every loop start. The generic `checkMcpServerAvailable(serverAlias)` signature keeps the helper reusable if future presets reference other MCP servers, without requiring the caller to know the internal config layout.

### Preset doc-comment update
**Choice:** Replace the existing `default.ts:5-9` comment block with new text that (a) states MCP-by-name as the dispatch strategy, (b) notes that the `task-master-ai` MCP server's presence is verified once before the loop starts via `LoopService.checkMcpServerAvailable`, and (c) drops the obsolete reference to CLI verification.
**Rationale:** The current comment becomes factually wrong once CLI references leave the prompt and the CLI check is removed. The replacement explains the rewrite's intent (avoid host-side `ToolSearch` overhead) so the reason for the verbose JSON-ish parameter blocks is discoverable by future readers.

### Verification approach
**Choice:** The implementation must capture a before/after trace pair: `task-master loop --tracelevel trace --max-iterations 1` run against the same project, once on the current `default.ts` and once on the rewritten version. Diff `.taskmaster/progress.txt` for `### [TRACE] Tool: ToolSearch input` blocks; the rewrite is considered successful when no `ToolSearch` block appears in the iteration's tool-call sequence prior to the first `mcp__task-master-ai__*` call. This is a verification requirement of the design, not just a nice-to-have.
**Rationale:** Research found no live trace artifact in the repo, so the "did this actually work" answer cannot be derived statically. A trace diff is the only direct, observable confirmation that cause (i) — ambiguous phrasing forcing `ToolSearch` — was the dominant trigger and that the rewrite addresses it.

## Out of Scope

- Rewriting any preset other than `default.ts`.
- Modifying steps 3, 4, 5, 6, 8, 9 of `default.ts` (implementation, tests, typecheck/test Bash hints, commit, progress notes).
- Replacing the typecheck/test `e.g.` hints with deterministic commands — they don't trigger MCP `ToolSearch` and Bash-tool resolution latency is a separate optimization category.
- Adding a "fall back to CLI if MCP is unavailable" path in the prompt — the question explicitly mandates MCP-only.
- A live MCP tool ping in the readiness probe (chose config-only).
- Changes to `TASK_MASTER_TOOLS` tier defaults or the tier system. All three referenced tools are already in the `core` tier.
- Recovery from mid-loop MCP disconnect. Research confirmed there is no existing code path for this and the question did not request one.
- Touching the `mcp__task-master-ai__loop` tool or adding a recursion guard — no preset references it and the existing `Do NOT start another task after completing one.` line is sufficient.
- Modifying `LoopDomain`, `buildContextHeader`, or `buildPrompt` beyond what is required to thread `projectRoot` into `resolvePrompt`.

## Open Questions

None. All design axes are resolved.
