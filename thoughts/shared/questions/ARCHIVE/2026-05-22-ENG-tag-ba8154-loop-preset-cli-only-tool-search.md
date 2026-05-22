---
original_question: "The Taskmaster loop preset at packages/tm-core/src/modules/loop/presets/default.ts:10-29 currently instructs the LLM with one ambiguous line: 1. Run task-master next (or use MCP) to get the next available task/subtask. mcp__task-master-ai__next_task is called after first doing a tool search. Can we optimize the prompt so it knows exactly what to call to task-master without first doing a tool search?"
ticket: tag-ba8154
---

# Research Question: Eliminate ToolSearch round-trip in Taskmaster default loop preset

## Refined Question
How should the `DEFAULT_PRESET` in `packages/tm-core/src/modules/loop/presets/default.ts:10-29` be rewritten so that each loop iteration uses the `task-master` CLI exclusively — never invoking `mcp__task-master-ai__*` tools — in order to eliminate the `ToolSearch` round-trip the LLM currently performs when it reads "Run task-master next (or use MCP)"? The audit must cover all 9 process steps (not just step 1) and the rewrite must minimize tool calls, latency, and total tokens/context per iteration while preserving correct behavior. Only `default.ts` is in scope.

## Research Areas

1. **MCP tool deferral mechanics** — Confirm that in the Claude Code harness, listing `mcp__task-master-ai__*` as deferred forces a `ToolSearch select:...` call before invocation, and that purely Bash-based CLI calls (`task-master ...`) skip that requirement entirely. This is the load-bearing assumption behind the "force CLI" direction.

2. **Per-step audit of `default.ts:10-29`** — Walk each of the 9 process steps and identify any phrasing that could lead the LLM to consider MCP. Known points so far:
   - Step 1: explicit "(or use MCP)" — must drop the MCP option.
   - Step 2: `task-master show <id>` — already CLI, but verify there's no MCP-friendly hedge nearby.
   - Steps 3–6: implementation / typecheck / test — already framework-agnostic; verify nothing prompts MCP.
   - Step 7: `task-master set-status --id=<id> --status=done` — already CLI.
   - Step 8: `git commit` — unrelated.
   - Step 9: "Append super-concise notes to progress file" — verify the file path is unambiguous and doesn't suggest an MCP tool.

3. **CLI command correctness and completeness** — For each step that becomes CLI-prescribed, confirm the exact `task-master` subcommand and flags. Verify that the CLI covers everything the prompt needs (next, show, set-status, optionally update-subtask for progress notes) without falling back to MCP for any missing capability.

4. **Token / context cost comparison** — Quantify (or at minimum reason qualitatively about) the savings: how many tool calls per iteration today (ToolSearch + MCP call vs. one Bash call), what tokens are consumed by the deferred-tool system reminders that get pulled in when ToolSearch fires, and how much input context is freed per iteration by never loading MCP schemas.

5. **Phrasing patterns that lock the LLM to CLI** — Research how to phrase steps so the LLM is unambiguously directed to a Bash invocation and doesn't speculatively call ToolSearch. E.g., wrapping commands in backticks, prefixing with "Bash:" or "Run via Bash:", explicit "(do not use MCP)" guards, or restructuring as a code block. Identify what works without bloating the prompt.

6. **Regression safety** — Verify that the rewrite doesn't break anything else: the comment at `default.ts:5-8` already states the CLI is verified once before the loop starts (`LoopService.checkTaskMasterAvailable`), so CLI availability is a precondition; confirm this still holds and that no caller of the preset assumes MCP usage.

## Clarifications Gathered

- **Q:** Force CLI, force MCP, or let the LLM pick?
  **A:** Force CLI exclusively (direction A).

- **Q:** Just step 1, or audit all 9 steps?
  **A:** Audit all 9 steps.

- **Q:** What's the win being measured?
  **A:** Fewer tool calls, lower latency, fewer total tokens and context used (all three).

- **Q:** Scope — just `default.ts`, or other presets too?
  **A:** Just `default.ts`.

- **Q:** Is MCP availability assumed?
  **A:** Not specified — but since the direction is CLI-only, MCP availability becomes irrelevant for this preset.

## Edge Cases to Address

- The LLM may still speculatively call ToolSearch out of habit when it sees `mcp__task-master-ai__*` listed as deferred in the harness reminder, even with a CLI-only prompt. Research what wording (if any) reliably suppresses this.
- Progress-file logging in step 9 should not tempt the LLM into using `mcp__task-master-ai__update_subtask` as a "logging" mechanism — the file path needs to be explicit.
- If a user's loop runs in an environment where `task-master` is NOT on PATH, the current precondition check catches it before the loop starts; confirm no per-iteration fallback to MCP is expected.
- Inconsistent shapes across steps today (`task-master next` vs `task-master show <id>` vs `task-master set-status --id=<id> --status=done`) — a rewrite should normalize formatting so the LLM treats them as one cohesive CLI sequence rather than mixed signals.

## Files Provided by User
- `packages/tm-core/src/modules/loop/presets/default.ts:10-29` — the preset string to be rewritten.
