# Design: Rewrite `DEFAULT_PRESET` to be CLI-only and eliminate the per-iteration `ToolSearch` round-trip

## Problem Statement

Each loop iteration that uses the default Taskmaster preset currently pays a `ToolSearch select:mcp__task-master-ai__next_task` round-trip plus the MCP schema payload before any useful work happens. The cause is a single hedge in `packages/tm-core/src/modules/loop/presets/default.ts:13` — step 1 reads "Run task-master next (or use MCP) to get the next available task/subtask." — which, combined with the harness-level deferred-tools reminder, gives the LLM permission to speculatively load MCP tool schemas. The audit confirms that across all 9 process steps only step 1 contains an MCP-friendly hedge; steps 2 and 7 are already bare `task-master` CLI invocations, steps 3–6 and 8 are framework-agnostic, and step 9 is a raw file append. The rewrite must remove the MCP path while preserving correct behavior, the structural test contracts that exempt `default` from markdown-header rules, and the precondition gate that already verifies the CLI is on PATH before iteration 1.

## Research Source

`thoughts/shared/research/2026-05-22-ENG-tag-ba8154-loop-default-preset-cli-only-tool-search.md`

## Design Decisions

### Anti-MCP stance
**Choice:** Silent omission only — remove "(or use MCP)" from step 1; no explicit anti-MCP guard anywhere in the preset.
**Rationale:** No other preset in the codebase (`linting`, `duplication`, `entropy`, `test-coverage`) uses an explicit anti-tool guard; all of them rely on prescribing exactly one command form per step and letting the unambiguous backtick-wrapped CLI invocation do the work. Adding a guard like "do not call `mcp__task-master-ai__*` tools" would be unprecedented in this codebase, add tokens, and re-introduce the literal string `mcp__task-master-ai__` into the prompt — the very token sequence that primes the LLM toward `ToolSearch`. Trusting the in-repo idiom matches the lowest-friction, smallest-diff path that the research established is sufficient for steps 2 and 7 (which never had a hedge and never trigger the speculative round-trip). The residual harness-level deferred-tools reminder is out of the preset's control and cannot be addressed from within `default.ts`.

### Progress-file path location
**Choice:** Name `.taskmaster/loop-progress.txt` directly inside step 9 of the preset body.
**Rationale:** The runtime context header (`@<progressFile> @CLAUDE.md`) at `loop.service.ts:507-513` already references the file, but the preset body's current wording — "Append super-concise notes to progress file" — is ambiguous enough that an LLM could reasonably interpret "progress file" as inviting `task-master update-subtask` (a real, documented CLI for attaching implementation notes to a subtask, referenced in `.taskmaster/CLAUDE.md:183,324,327`). Naming the literal path inside the step matches the explicit-file-path idiom used by all 4 specialized presets (`linting.ts:23`, `duplication.ts:23`, `entropy.ts:32`, `test-coverage.ts:30`) and forecloses the `update-subtask` temptation. The duplication with the runtime header is intentional belt-and-suspenders; the runtime header makes the file readable via `@` reference, while the preset body tells the model where to *write*.

### Backtick wrapping
**Choice:** Backtick-wrap every shell/CLI command across all steps. Normalize steps 1, 2, and 7 to match the existing backtick style of steps 5–6.
**Rationale:** The current preset is half-and-half — steps 5–6 use backtick-wrapped inline code (e.g., ``` `npm run typecheck` ```) while steps 1, 2, and 7 use bare prose for `task-master` commands. All 4 specialized presets uniformly backtick-wrap every shell/CLI command; that is the dominant in-repo idiom. Uniform wrapping gives the model a single homogeneous channel to parse, eliminates the slight ambiguity of bare prose, and tightens the visual contract that "the imperative verb is followed by the exact command to run". The diff cost is trivial.

### Step 1 rewrite shape
**Choice:** ``1. Run `task-master next` to get the next available task/subtask.`` — drop the "(or use MCP)" parenthetical entirely; wrap the command in backticks; keep the rest of the sentence intact.
**Rationale:** Follows directly from the three decisions above. Mirrors the imperative-verb + backtick-command shape of the specialized presets (e.g., ``Run lint command (`pnpm lint`, ...)`` in `linting.ts:11`). Smallest meaningful edit that removes the speculative-`ToolSearch` lever.

### Step labels and overall structure
**Choice:** Preserve the existing plain-text section labels (`TASK:`, `PROCESS:`, `IMPORTANT:`). Preserve the existing numbered-list shape for the 9 steps. Preserve the existing `<loop-complete>` and `<loop-blocked>` markers. Do NOT introduce markdown headers or a `## Files Available` section.
**Rationale:** Structural assertions at `packages/tm-core/src/modules/loop/presets/presets.spec.ts:258-265,276-283,197-205` explicitly carve `default` out from the markdown-header rule, the `## Files Available` rule, and the `@`-file-reference rule. Switching `default` to markdown headers would require updating those exemption tests and would expand the diff far beyond the MCP audit's actual scope. Preserving the plain-text labels is the lowest-friction path and is consistent with the established asymmetry between `default` and the 4 specialized presets.

### Test/snapshot maintenance
**Choice:** Update the Vitest snapshot at `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap:3-24` to reflect the new wording. Do not modify the structural assertions in `presets.spec.ts:190-283`. Verify after rewrite that all structural rules still pass: `<loop-complete>`/`<loop-blocked>` markers, `^\d+\.` numbered steps, `^IMPORTANT:` line, "one task"/"only one" phrasing, `loop-progress|progress` reference, `^PROCESS:` line, and the `default`-only exemptions.
**Rationale:** The snapshot is a full-text pin and will fail on any wording change; that's expected and the regeneration is mechanical. The structural assertions encode the actual behavioral contract and must continue to pass without modification — that contract is the safety net that proves the rewrite hasn't drifted from the preset's role. The plan stage will spell out the exact `vitest -u` (or equivalent) invocation.

## Out of Scope

- The legacy `scripts/loop.sh:40` shell-script form, which carries the same "(or use MCP)" wording but is annotated "Keeping here for reference, but using the new task-master loop command instead". The original question scope restricted this to `default.ts` only.
- The four specialized presets (`linting`, `duplication`, `entropy`, `test-coverage`). They already use bare CLI commands and contain no MCP-friendly hedges.
- The runtime context header builder (`loop.service.ts:507-513`). The `@<progressFile> @CLAUDE.md` prefix is correct; the rewrite leaves it untouched.
- The precondition gate (`checkTaskMasterAvailable` at `loop.service.ts:55-87`). It already does the right thing — the rewrite tightens the contract by removing the hedge that gave the model permission to ignore a missing CLI, but no code changes there.
- Any change to the CLI or MCP entry points (`apps/cli/src/commands/loop.command.ts`, `apps/mcp/src/tools/loop/loop.tool.ts`). Both pass `--prompt` through verbatim; neither inspects the preset body.
- Adding an explicit "do not use MCP" guard line (explicitly rejected per the Anti-MCP stance decision).
- Markdown-header conversion or `## Files Available` section for `default` (explicitly rejected per the Step labels decision; would require modifying test exemptions).
- Changes to the `<loop-complete>`/`<loop-blocked>` marker semantics or the `IMPORTANT:` block content beyond what is already required.

## Open Questions

None. All design axes flagged by the research are resolved above:
- Anti-MCP stance: silent omission, no explicit guard.
- Progress-file path: named in step 9 body.
- Backtick wrapping: uniform across all CLI/shell commands.
- Step 1 wording: ``Run `task-master next` to get the next available task/subtask.``
- Structure/labels: preserve existing plain-text labels and `default`-only test exemptions.
- Tests: snapshot regenerated, structural assertions unchanged.
