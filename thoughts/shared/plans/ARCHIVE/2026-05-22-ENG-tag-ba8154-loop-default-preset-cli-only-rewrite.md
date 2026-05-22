# Loop Default Preset CLI-Only Rewrite Implementation Plan

## Overview
Rewrite `DEFAULT_PRESET` in `packages/tm-core/src/modules/loop/presets/default.ts` to remove the MCP hedge from step 1, backtick-wrap all shell/CLI commands, and name the progress file path explicitly in step 9 — eliminating the per-iteration `ToolSearch` round-trip without changing structure or test contracts.

## Source Documents
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-ba8154-loop-default-preset-cli-only-rewrite.md`

## Current State
`packages/tm-core/src/modules/loop/presets/default.ts:13` — step 1 reads:
> `1. Run task-master next (or use MCP) to get the next available task/subtask.`

The "(or use MCP)" parenthetical, combined with the harness-level deferred-tools reminder, gives the LLM permission to speculatively fire `ToolSearch select:mcp__task-master-ai__next_task` before any useful work. Additionally, steps 2, 7, 8 use bare prose for `task-master` commands (no backticks), and step 9 refers to "progress file" ambiguously rather than naming `.taskmaster/loop-progress.txt`.

The structural test file at `packages/tm-core/src/modules/loop/presets/presets.spec.ts:197-205,258-266,276-283` explicitly exempts `default` from markdown-header, `## Files Available`, and `@`-file-reference rules — these exemption assertions must not be modified.

The snapshot at `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap:3-24` pins the full text of `DEFAULT_PRESET` and will fail on any wording change; regeneration is expected.

## Desired End State
`default.ts` exports a `DEFAULT_PRESET` string where:
- Step 1 reads: ``1. Run `task-master next` to get the next available task/subtask.``
- Step 2 reads: ``2. Read task details with `task-master show <id>`.``
- Step 7 reads: ``7. Mark complete: `task-master set-status --id=<id> --status=done` ``
- Step 8 reads: ``8. Commit with message: `feat(<scope>): <what was implemented>` ``
- Step 9 names `.taskmaster/loop-progress.txt` instead of "progress file"
- All other content, structural labels (`TASK:`, `PROCESS:`, `IMPORTANT:`), step count, and `<loop-complete>`/`<loop-blocked>` markers remain unchanged
- All structural assertions in `presets.spec.ts:190-283` pass without modification
- The snapshot is regenerated to match the new wording

## What We Are NOT Doing
- Modifying the 4 specialized presets (`linting.ts`, `duplication.ts`, `entropy.ts`, `test-coverage.ts`)
- Adding an explicit "do not use MCP" guard line to `default.ts`
- Converting `default.ts` to markdown headers or adding `## Files Available`
- Modifying the structural assertions in `presets.spec.ts` (including the `default`-only exemptions)
- Touching `loop.service.ts`, `loop.command.ts`, `loop.tool.ts`, or `scripts/loop.sh`
- Any changes outside `packages/tm-core/`

---

## Phase 1: Rewrite `default.ts` and Regenerate Snapshot

### Goal
Apply all four wording changes to `DEFAULT_PRESET`, then regenerate the Vitest snapshot so both the snapshot test and all structural assertions pass.

### Changes

#### Default Preset Content
**File:** `packages/tm-core/src/modules/loop/presets/default.ts`
**Change:** Replace the full template string with the new CLI-only wording.

Current content (lines 1–29):
```ts
/**
 * Default preset for Taskmaster loop - general task completion
 * Matches the structure of scripts/loop.sh prompt
 *
 * Note: The task-master CLI availability is verified once before the loop
 * starts (see LoopService.checkTaskMasterAvailable). Setup instructions are
 * intentionally not embedded in the prompt to avoid spending tokens on a
 * precondition the LLM cannot act on mid-iteration.
 */
export const DEFAULT_PRESET = `TASK: Implement ONE task/subtask from the Taskmaster backlog.

PROCESS:
1. Run task-master next (or use MCP) to get the next available task/subtask.
2. Read task details with task-master show <id>.
3. Implement following codebase patterns.
4. Write tests alongside implementation.
5. Run type check (e.g., \`npm run typecheck\`, \`tsc --noEmit\`).
6. Run tests (e.g., \`npm test\`, \`npm run test\`).
7. Mark complete: task-master set-status --id=<id> --status=done
8. Commit with message: feat(<scope>): <what was implemented>
9. Append super-concise notes to progress file: task ID, what was done. If there was any mistakes or false assumptions, append them into a learning.

IMPORTANT:
- Complete ONLY ONE task per iteration.
- Keep changes small and focused.
- Do NOT start another task after completing one.
- If all tasks are done, output <loop-complete>ALL_DONE</loop-complete>.
- If blocked, output <loop-blocked>REASON</loop-blocked>.
`;
```

New content — four targeted line edits:
```ts
/**
 * Default preset for Taskmaster loop - general task completion
 * Matches the structure of scripts/loop.sh prompt
 *
 * Note: The task-master CLI availability is verified once before the loop
 * starts (see LoopService.checkTaskMasterAvailable). Setup instructions are
 * intentionally not embedded in the prompt to avoid spending tokens on a
 * precondition the LLM cannot act on mid-iteration.
 */
export const DEFAULT_PRESET = `TASK: Implement ONE task/subtask from the Taskmaster backlog.

PROCESS:
1. Run \`task-master next\` to get the next available task/subtask.
2. Read task details with \`task-master show <id>\`.
3. Implement following codebase patterns.
4. Write tests alongside implementation.
5. Run type check (e.g., \`npm run typecheck\`, \`tsc --noEmit\`).
6. Run tests (e.g., \`npm test\`, \`npm run test\`).
7. Mark complete: \`task-master set-status --id=<id> --status=done\`
8. Commit with message: \`feat(<scope>): <what was implemented>\`
9. Append super-concise notes to \`.taskmaster/loop-progress.txt\`: task ID, what was done. If there was any mistakes or false assumptions, append them into a learning.

IMPORTANT:
- Complete ONLY ONE task per iteration.
- Keep changes small and focused.
- Do NOT start another task after completing one.
- If all tasks are done, output <loop-complete>ALL_DONE</loop-complete>.
- If blocked, output <loop-blocked>REASON</loop-blocked>.
`;
```

**Summary of the four line diffs:**

| Step | Old | New |
|------|-----|-----|
| 1 | `Run task-master next (or use MCP) to get the next available task/subtask.` | ``Run `task-master next` to get the next available task/subtask.`` |
| 2 | `Read task details with task-master show <id>.` | ``Read task details with `task-master show <id>`.`` |
| 7 | `Mark complete: task-master set-status --id=<id> --status=done` | ``Mark complete: `task-master set-status --id=<id> --status=done` `` |
| 8 | `Commit with message: feat(<scope>): <what was implemented>` | ``Commit with message: `feat(<scope>): <what was implemented>` `` |
| 9 | `Append super-concise notes to progress file:` | ``Append super-concise notes to `.taskmaster/loop-progress.txt`:`` |

#### Snapshot Regeneration
**File:** `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap`
**Change:** Auto-regenerated by running vitest with the update flag. Do NOT edit this file manually.

Run from the repo root:
```sh
npm run test -w @tm/core -- --update-snapshots
```

Or, if the workspace test script exposes vitest directly:
```sh
npx vitest run --reporter=verbose --update-snapshots packages/tm-core/src/modules/loop/presets/presets.spec.ts
```

After regeneration, verify the snapshot diff in `__snapshots__/presets.spec.ts.snap` shows only the four changed lines in the `default` preset block and no changes to the other four preset blocks.

### Automated Verification
- [x] Typecheck passes: `npm run turbo:typecheck`
- [x] Unit tests pass (snapshot regenerated, structural assertions green): `npm run test -w @tm/core`
- [x] Format check passes: `npm run format-check`
- [x] Confirm only the `default` snapshot block changed (no other preset snapshots modified): `git diff packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap`

---

## Manual Verification (run after ALL phases are complete)

- [ ] `DEFAULT_PRESET` string no longer contains the substring `"or use MCP"` — verify with `grep "or use MCP" packages/tm-core/src/modules/loop/presets/default.ts` returning no matches
- [ ] `DEFAULT_PRESET` string contains `"loop-progress.txt"` — verify with `grep "loop-progress.txt" packages/tm-core/src/modules/loop/presets/default.ts`
- [ ] Steps 1, 2, 7, 8, and 9 all contain backtick-wrapped commands/paths when read from `getPreset('default')`
- [ ] `presets.spec.ts` structural assertions all pass without modification: the `default`-only exemptions for markdown headers (line 261), `## Files Available` (line 278), and `@` file references (line 197) continue to be exemptions, not failures
- [ ] Running a live loop iteration (e.g., `task-master loop --preset default --dry-run` if supported, or by inspecting the prompt injected into an LLM) shows no `ToolSearch` call for `mcp__task-master-ai__next_task` in step 1

## Manual Testing Steps
1. `npm run turbo:build` to confirm a clean build
2. `npm run test -w @tm/core` — all tests including snapshot must be green
3. Inspect the regenerated snapshot diff: `git diff packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap` — should show only the 5 changed lines inside the `default` block
4. `grep -n "or use MCP" packages/tm-core/src/modules/loop/presets/default.ts` — must return nothing
5. `grep -n "loop-progress.txt" packages/tm-core/src/modules/loop/presets/default.ts` — must return line 9

## References
- Original ticket: `tag-ba8154`
- Research: `thoughts/shared/research/2026-05-22-ENG-tag-ba8154-loop-default-preset-cli-only-tool-search.md`
- Design: `thoughts/shared/claude-code-design/2026-05-22-ENG-tag-ba8154-loop-default-preset-cli-only-rewrite.md`
- Related patterns: `packages/tm-core/src/modules/loop/presets/linting.ts:11` (backtick-wrapped CLI command idiom), `packages/tm-core/src/modules/loop/presets/duplication.ts:23` (explicit `@.taskmaster/loop-progress.txt` reference idiom)
- Structural test exemptions: `packages/tm-core/src/modules/loop/presets/presets.spec.ts:197-205,258-266,276-283`
- Snapshot to regenerate: `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap:3-24`
