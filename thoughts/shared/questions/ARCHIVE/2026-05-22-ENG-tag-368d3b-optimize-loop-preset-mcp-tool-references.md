---
researcher: George
original_question: "The Taskmaster loop preset at packages/tm-core/src/modules/loop/presets/default.ts:10-29 currently instructs the LLM with one ambiguous line: 1. Run task-master next (or use MCP) to get the next available task/subtask. mcp__task-master-ai__next_task is called after first doing a tool search. Can we optimize the prompt so it knows exactly what mcps to call without doing a tool search?"
ticket: tag-368d3b
---

# Research Question: Eliminate LLM Tool-Search Overhead in Taskmaster Loop Presets by Using Explicit MCP Tool Names

## Refined Question
The Taskmaster loop presets in `packages/tm-core/src/modules/loop/presets/` (including `default.ts:10-29` and all sibling presets — `duplication.ts`, `entropy.ts`, `linting.ts`, `test-coverage.ts`) instruct the LLM in natural language ("Run task-master next (or use MCP)…"). When the loop runs at `--trace` level, traces show the LLM performing a tool-search step before invoking `mcp__task-master-ai__next_task`. We want to rewrite every step in every preset that calls task-master to name the exact MCP tool (e.g., `mcp__task-master-ai__next_task`, `mcp__task-master-ai__get_task`, `mcp__task-master-ai__set_task_status`) so the LLM routes directly to the tool without a discovery step. CLI form (`task-master <cmd>`) should be removed from the prompts entirely — MCP only.

Research must produce: (a) the exact MCP tool name for every task-master CLI command currently referenced in any preset, (b) a list of every preset line that needs rewriting, (c) confirmation that the rewrite eliminates the tool-search step (verified against `--trace` output), and (d) a recommendation on whether non-task-master fuzzy hints (typecheck/test command "e.g." examples) and the `TASK_MASTER_TOOLS` tier setting affect the optimization.

## Research Areas
1. **MCP tool name catalog** — Inventory every task-master CLI command referenced across all preset files and map each to its canonical `mcp__task-master-ai__<name>` form. Confirm naming convention and required parameters at the schema level so the prompt names match what the LLM can actually call.
2. **Preset audit (all files)** — Enumerate every line in `default.ts`, `duplication.ts`, `entropy.ts`, `linting.ts`, `test-coverage.ts` that references `task-master <cmd>` or alludes to MCP usage. Produce a per-file rewrite target list.
3. **Trace-level evidence** — Read the `--trace` output from a recent `task-master loop` run to identify the exact step(s) where the tool-search occurs. This is the ground truth that the optimization must eliminate. Investigate `packages/tm-core/src/modules/loop/services/trace-level.ts` and any trace artifacts under the repo (look for the `.pipeline_state_tag-368d3b.json` and related trace files).
4. **MCP-vs-CLI fallback semantics** — `LoopService.checkTaskMasterAvailable` verifies the CLI before the loop starts. If presets reference MCP exclusively, determine: (a) whether MCP availability is/should also be verified up-front, (b) what happens if MCP disconnects mid-loop, and (c) whether the preset comment block needs updating to reflect the new precondition.
5. **Tool-search trigger root cause** — Determine *why* the LLM tool-searches today. Candidates: (i) ambiguous "or use MCP" phrasing without a concrete name, (ii) MCP server's lazy connection (the system-reminder shows tools appearing on-demand), (iii) tier-loading lag for non-core tools. Knowing the actual trigger determines whether naming the tool inline is sufficient, or whether additional measures (e.g., a warm-up tool call, explicit tier guidance) are needed.
6. **Tier-aware prompting (`TASK_MASTER_TOOLS`)** — The MCP server exposes `core` (7 tools), `standard` (14), or `all` (42+) tools depending on the `TASK_MASTER_TOOLS` env var. Verify that every tool name the rewritten presets will reference exists in the `core` tier (the documented minimum baseline) — specifically `next_task`, `get_task`, `set_task_status`, `update_subtask`, `expand_task`, `parse_prd`, `get_tasks`. Flag any preset that needs a tool outside core so users can be told which tier to enable.
7. **Non-task-master fuzzy hints (typecheck/test)** — `default.ts:17-18` uses "e.g., `npm run typecheck`, `tsc --noEmit`" and "e.g., `npm test`, `npm run test`". Determine from trace evidence whether these also cause discovery overhead (likely a Bash call, not an MCP search, but worth confirming). Decide whether they should be made deterministic in the same pass or left alone.

## Clarifications Gathered
- **Q:** MCP-only or dual (MCP + CLI) tool naming in the prompt?
  **A:** MCP only. Replace all `task-master <cmd>` references with explicit `mcp__task-master-ai__<name>` instructions.
- **Q:** Scope — only `default.ts` or all preset files?
  **A:** All preset files in `packages/tm-core/src/modules/loop/presets/`, including `default.ts`.
- **Q:** Optimize only step 1, or every step that touches task-master?
  **A:** All steps in any preset that call task-master.
- **Q:** Should typecheck/test "e.g." command hints (lines 17–18) also be made deterministic?
  **A:** Researcher's call — investigate and recommend.
- **Q:** Assume `TASK_MASTER_TOOLS=core` baseline, or account for all tiers?
  **A:** Researcher's call — investigate and recommend.
- **Q:** Are commit (step 8) and progress-notes (step 9) in scope?
  **A:** Out of scope.
- **Q:** Is there trace/log evidence of the tool-search step to optimize against?
  **A:** Yes — traces/logs produced when running `task-master loop` with the `--trace` (trace level: `trace`) option. Pipeline state file `.pipeline_state_tag-368d3b.json` is present at the repo root and may contain relevant trace data.

## Edge Cases to Address
- A preset references a CLI command that does not have a `core`-tier MCP equivalent — research must flag this and decide whether to (a) keep the CLI form for that step only, (b) require a higher tier, or (c) propose adding the tool to core.
- MCP server is configured but not yet connected when the loop iteration begins (the system-reminder describes `task-master-ai` as "still connecting" on cold start). Determine whether the LLM should be told to wait/retry, or whether `LoopService` should verify MCP readiness.
- The preset comment block in `default.ts:5-9` documents that "task-master CLI availability is verified once before the loop starts" — this comment may become stale if MCP becomes the primary path. Note that the comment also needs updating.
- A preset references a generic task-master concept (e.g., "the Taskmaster backlog") rather than a specific command. Decide whether that's still acceptable framing or needs to be rewritten.
- The `mcp__task-master-ai__loop` MCP tool itself exists — verify that presets are *not* meant to call it (would cause recursion) and document the boundary.
- Trace-level output may itself be verbose; confirm that the trace-level service (`trace-level.ts`) is the right place to look for the discovery-step evidence.

## Files Provided by User
- `packages/tm-core/src/modules/loop/presets/default.ts` (lines 10–29) — the specific preset showing the ambiguous wording that caused the LLM to tool-search.
- `.pipeline_state_tag-368d3b.json` (repo root, untracked) — likely contains pipeline state from a recent traced run; relevant for trace-evidence research area.
