---
topic: "Eliminate ToolSearch round-trip in Taskmaster default loop preset (CLI-only rewrite of DEFAULT_PRESET)"
tags: [research, codebase, loop, presets, default-preset, mcp, cli, tool-search, prompt-engineering]
status: complete
source_question: thoughts/shared/questions/2026-05-22-ENG-tag-ba8154-loop-preset-cli-only-tool-search.md
---

# Research: Eliminate ToolSearch round-trip in Taskmaster default loop preset

## Research Question

How should the `DEFAULT_PRESET` in `packages/tm-core/src/modules/loop/presets/default.ts:10-29` be rewritten so that each loop iteration uses the `task-master` CLI exclusively — never invoking `mcp__task-master-ai__*` tools — in order to eliminate the `ToolSearch` round-trip the LLM currently performs when it reads "Run task-master next (or use MCP)"? The audit must cover all 9 process steps (not just step 1) and the rewrite must minimize tool calls, latency, and total tokens/context per iteration while preserving correct behavior. Only `default.ts` is in scope.

## Summary

The DEFAULT_PRESET string is a static template literal that is concatenated with a small runtime context header (`@<progressFile> @CLAUDE.md\n\nLoop iteration N of M`) and shipped verbatim as the `-p` argument to a `claude` subprocess in every iteration (`packages/tm-core/src/modules/loop/services/loop.service.ts:496-521`, `985`). No system-prompt wrapping or templating happens between definition and dispatch, so wording changes inside the template literal flow directly to the model.

The only step in the 9-step PROCESS block that explicitly mentions MCP is step 1 (`"Run task-master next (or use MCP) to get the next available task/subtask."`). Steps 2 and 7 already prescribe bare `task-master` CLI invocations. Steps 3–6 are framework-agnostic (implement / write tests / type check / run tests) and contain no tool-selection language. Step 8 is `git commit` (unrelated). Step 9 says "Append super-concise notes to progress file" without naming the file path — the path `.taskmaster/loop-progress.txt` lives only in the runtime context header, not in the preset body.

The CLI binary is verified once before the loop starts via `LoopService.checkTaskMasterAvailable()` (`loop.service.ts:55-87`), which calls `spawnSync('task-master', ['--version'])` — invoked only when `config.prompt === 'default'` and not in sandbox mode (`loop.service.ts:184-191`). There is **no per-iteration MCP availability check**: the preset's "(or use MCP)" hedge is purely advisory text with no infrastructure to back it up.

The loop has 5 presets total (`default`, `test-coverage`, `linting`, `duplication`, `entropy`), but only `default` mentions MCP. The other 4 already use bare CLI commands (mostly `npm`/`pnpm`/`eslint`/`tsc`) and `@.taskmaster/loop-progress.txt` file references. They are the de-facto template for a CLI-only style. There are two tests that pin the wording: a vitest snapshot at `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap:3-24` and structural assertions at `presets.spec.ts:190-283`. Any rewrite must update the snapshot and continue to satisfy the structural rules (which intentionally exempt `default` from markdown-header and `## Files Available` requirements).

## Detailed Findings

### Research Area 1 — MCP tool deferral mechanics

The behavior is observable in this very session. The pre-tool-call `<system-reminder>` listed every `mcp__task-master-ai__*` tool as deferred: "Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query `select:<name>[,<name>...]` to load tool schemas before calling them." That confirms the load-bearing assumption: any text in the preset that names or even gestures at an `mcp__*` tool gives the model a reason to fire `ToolSearch select:mcp__task-master-ai__next_task` before the first useful action. A bare `task-master ...` invocation, by contrast, is dispatched through `Bash`, whose schema is always loaded — no `ToolSearch` round-trip is required.

The current "(or use MCP)" wording in `default.ts:13` is the only place in the preset that flags MCP as a legal path. It is sufficient on its own to trigger the speculative `ToolSearch` because the model has been told MCP tools exist (via the deferred-tools reminder) and the prompt has told it MCP is an alternative.

### Research Area 2 — Per-step audit of `default.ts:10-29`

Walking each numbered step in the existing preset (verbatim from `default.ts` and confirmed against the snapshot at `presets.spec.ts.snap:3-24`):

1. `Run task-master next (or use MCP) to get the next available task/subtask.` — **Only step that names MCP.** This is the primary lever. Removing the parenthetical hedge is necessary; replacing it with something assertive (e.g., wrapping the command in backticks and dropping the parenthetical entirely) is sufficient.
2. `Read task details with task-master show <id>.` — Already CLI. No MCP-friendly hedge nearby. The `<id>` placeholder follows the same convention used in `assets/scripts_README.md:418-424`, `apps/docs/getting-started/quick-start/tasks-quick.mdx:41`, and `.taskmaster/CLAUDE.md:15`.
3. `Implement following codebase patterns.` — No tool mentioned; nothing to change for the MCP audit.
4. `Write tests alongside implementation.` — No tool mentioned.
5. ``Run type check (e.g., `npm run typecheck`, `tsc --noEmit`).`` — Backtick-wrapped shell commands. No MCP-friendly hedge.
6. ``Run tests (e.g., `npm test`, `npm run test`).`` — Backtick-wrapped shell commands. No MCP-friendly hedge.
7. `Mark complete: task-master set-status --id=<id> --status=done` — Already CLI. Canonical `--id=<id> --status=<status>` form (named flags, no positional). Same shape used in `packages/claude-code-plugin/agents/task-executor.md:27-28`, `assets/AGENTS.md:17`, and `assets/scripts_README.md:123-132`.
8. `Commit with message: feat(<scope>): <what was implemented>` — `git commit`; unrelated to Taskmaster tool selection.
9. `Append super-concise notes to progress file: task ID, what was done. If there was any mistakes or false assumptions, append them into a learning.` — Free-text instruction. The progress file path itself is **not in the preset body** — the runtime context header at `loop.service.ts:507-513` prepends `@<config.progressFile> @CLAUDE.md`. With the default config the file is `.taskmaster/loop-progress.txt` (referenced literally in all four specialized presets and in `scripts/loop.sh:48`).

Across all 9 steps, only step 1 contains an MCP-friendly hedge. Steps 2 and 7 are already bare CLI. The audit conclusion is that the rewrite needs to do exactly two things: (a) remove "(or use MCP)" from step 1, and (b) optionally tighten step 9 so it cannot be read as inviting the `mcp__task-master-ai__update_subtask` tool as a "logging mechanism" (see Edge Cases below).

### Research Area 3 — CLI command correctness and completeness

The canonical CLI forms used elsewhere in the repo:

- `task-master next` — bare, no flags. Used in `assets/AGENTS.md:15`, `.taskmaster/CLAUDE.md:15`, `apps/docs/capabilities/loop.mdx:141`, `scripts/loop.sh:41`.
- `task-master show <id>` — positional form preferred in agent prompts. Subtask IDs use dot notation: `task-master show 1.2` (`.kiro/steering/dev_workflow.md:325`, `assets/scripts_README.md:418-424`). The `--id=<id>` flag form is also legal (`apps/docs/getting-started/quick-start/tasks-quick.mdx:41`).
- `task-master set-status --id=<id> --status=done` — always named flags; no positional form. Confirmed by `packages/claude-code-plugin/agents/task-executor.md:27-28`, `assets/AGENTS.md:17`, `assets/scripts_README.md:123-132`, `scripts/loop.sh:47`.
- `task-master update-subtask --id=<id> --prompt="..."` — exists and is the canonical way to attach implementation notes to a subtask. Used in `.taskmaster/CLAUDE.md:183,324,327`, `apps/docs/command-reference.mdx:86-89`, `tests/e2e/run_e2e.sh:772`, `tests/e2e/run_fallback_verification.sh:210`. **However**, none of the current loop presets call this command — step 9 across all presets is a raw file append, not a `task-master update-subtask` invocation.

There is **no `task-master` subcommand for appending to the loop progress file.** Two mechanisms exist instead:
- Infrastructure-level appends, done by `LoopService` itself via `appendFile` from `node:fs/promises` for loop header and final summary (`loop.service.ts:360`, `:378`, `:894`).
- Agent-level appends, instructed in free text in every preset (`default.ts:21`, `linting.ts:23`, `duplication.ts:23`, `entropy.ts:32`, `test-coverage.ts:30`). The agent is expected to do a direct file write (e.g., a `Bash echo >> .taskmaster/loop-progress.txt` or a `Write`/`Edit` tool call). The `apps/docs/capabilities/loop.mdx:65` docs confirm "Agents append notes about what they completed."

Net: every step in the current preset is either already covered by `task-master` CLI or is intentionally a raw file/tool action. The CLI is sufficient — there is no missing capability that would force an MCP fallback.

### Research Area 4 — Token / context cost comparison

Per-iteration cost today (CLI-or-MCP path the LLM tends to pick when "(or use MCP)" is present):
- `ToolSearch select:mcp__task-master-ai__next_task` round-trip = 1 tool call + tool result containing the schema(s).
- The deferred-tool `<system-reminder>` that lands when `mcp__task-master-ai__*` schemas are loaded carries ~44 tool names plus their docstrings (visible in the session reminder fired during this research). Empirically each schema is several hundred tokens once descriptions and input parameters are pulled in.
- Plus the actual `mcp__task-master-ai__next_task` invocation.
- Total: 2 tool calls + 1 large schema payload before any useful work happens.

Per-iteration cost after the CLI-only rewrite:
- `Bash task-master next` = 1 tool call. `Bash` schema is always loaded — no `ToolSearch` needed.
- No MCP schemas loaded into context.
- Total: 1 tool call, no schema payload.

Saving per iteration: 1 tool round-trip and the entire MCP schema payload (estimated several thousand tokens of input context, since the deferred-tools reminder lists ~44 task-master tools that all become candidates once `ToolSearch` fires). Over a 50-iteration loop that compounds significantly. Note this is **best-case savings against the typical behavior**, not against worst-case — a model that already knew not to consult MCP would skip `ToolSearch` voluntarily. The rewrite makes the cheap path the only path.

A secondary saving comes from eliminating the model's deliberation latency: it no longer has to "decide" between CLI and MCP at step 1.

### Research Area 5 — Phrasing patterns that lock the LLM to CLI

Comparing the 4 other presets (`linting`, `duplication`, `entropy`, `test-coverage`) reveals the in-repo idiom for CLI-only steps:

- **Backtick-wrap inline commands.** All four specialized presets wrap shell commands in backtick inline code, e.g. ``Run lint command (`pnpm lint`, `npm run lint`, `eslint .`, etc.)`` (`linting.ts:11`). The current `default.ts` is half-and-half: backticks on steps 5–6 but bare prose for the `task-master` calls on steps 1, 2, and 7. Normalizing all command-bearing steps to backtick-wrapped inline code is consistent with the established style.
- **No "(or use X)" hedges anywhere else.** None of the 4 specialized presets offer alternative tools — they prescribe exactly one command form per step. The `(or use MCP)` clause in `default.ts:13` is a one-of-a-kind hedge.
- **No explicit "do not use MCP" guards anywhere in the repo.** The presets don't tell the model what *not* to do at the tool level. Adding such a guard is unprecedented in this codebase but is one option for belt-and-suspenders suppression of the speculative `ToolSearch`. The cheaper option, based on the in-repo idiom, is to simply not mention MCP and rely on the prescribed backtick-wrapped `task-master` commands to be unambiguous.
- **Imperative verb + backtick-wrapped command is the dominant idiom.** "Run `task-master next`" is closer to the style of the other presets than "Run task-master next" (the current form).
- **Plain-text section labels are required for `default`.** `presets.spec.ts:258-264` and `:278-283` explicitly carve out `default` as the one preset that uses plain-text labels (`TASK:`, `PROCESS:`, `IMPORTANT:`) instead of markdown headers, and the one preset that does **not** have a `## Files Available` section. Switching `default` to markdown headers would require updating those tests. Keeping the plain-text labels is the lowest-friction path.

### Research Area 6 — Regression safety

- **Precondition still holds.** `LoopService.checkTaskMasterAvailable()` is called at `loop.service.ts:184-191` whenever `config.prompt === 'default'` and `!config.sandbox`. It calls `spawnSync('task-master', ['--version'])` with `shell: process.platform === 'win32'`. The check fires before the first iteration. The rewrite does not change the precondition; if anything it tightens the contract by removing the "(or use MCP)" hedge that gave the model permission to ignore a missing CLI.
- **Sandbox path unchanged.** Sandbox mode skips the precondition check (the host PATH doesn't reflect the container's PATH), but the preset string is identical inside and outside the sandbox — the container is expected to have `task-master` on its PATH too. No code anywhere assumes MCP is available in the sandbox.
- **No caller assumes MCP usage.** Searched across `apps/cli/src/commands/loop.command.ts`, `apps/mcp/src/tools/loop/loop.tool.ts`, and `packages/tm-core/src/modules/loop/`. Both the CLI entry (`loop.command.ts:90`) and the MCP entry (`apps/mcp/src/tools/loop/loop.tool.ts:106-116`) pass the user's `--prompt` value straight through to `LoopDomain.run()`. Nothing inspects the preset body or detects MCP-tool availability. The MCP loop tool just dispatches the same `claude -p ...` subprocess as the CLI path.
- **Tests that pin the wording.** Two test surfaces would break on edit:
  - The Vitest snapshot at `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap:3-24` is a full text snapshot. Must be updated with `--update-snapshots` (or by deleting and regenerating).
  - Structural assertions at `presets.spec.ts:190-283`. The rewrite must continue to satisfy: (a) contains `<loop-complete>` and `<loop-blocked>` markers (`:224-231`), (b) contains numbered process steps `^\d+\.` (`:207-211`), (c) contains `## Important` or `^IMPORTANT:` (`:213-220`), (d) mentions "one task"/"only one" (`:236-250`), (e) references `loop-progress|progress` (`:252-256`), (f) contains `^PROCESS:` (`:268-273`). The `default` preset is explicitly **excluded** from the markdown-header rule (`:258-265`), the `## Files Available` rule (`:276-283`), and the `@` file-reference rule (`:197-205`).

## Edge Cases Addressed

1. **The LLM may still speculatively call `ToolSearch` because `mcp__task-master-ai__*` is listed as deferred in the harness reminder, even with a CLI-only prompt.**
   The deferred-tools reminder lives at the harness level — the preset cannot remove it. The mitigation visible in this repo is to (a) drop every mention of MCP from the preset, and (b) make the prescribed CLI command unambiguous (imperative verb + backtick-wrapped exact command). Whether to add an explicit "do not use `mcp__task-master-ai__*` — use the `task-master` CLI via Bash" guard is a judgment call: it is the most reliable suppression but adds tokens and is unprecedented in this codebase. No evidence either way exists in the repo about how strongly the model speculates after MCP mentions are removed.

2. **Step 9 ("Append… to progress file") may tempt the LLM into `mcp__task-master-ai__update_subtask` as a "logging mechanism".**
   The risk exists because `update-subtask` is real and is documented as the canonical way to attach implementation notes to a subtask (`.taskmaster/CLAUDE.md:183,324,327`). The mitigations visible in the other 4 presets: name the file explicitly. `linting.ts:23`, `duplication.ts:23`, `entropy.ts:32`, and `test-coverage.ts:30` all phrase this as `Append to progress file: ...` while the runtime header `@.taskmaster/loop-progress.txt` makes the file reference unambiguous. The `default.ts:21` wording is consistent with that style. Naming the file path directly inside the preset body (e.g., `Append to .taskmaster/loop-progress.txt: ...`) would harden it further, at the cost of duplicating what the runtime header already does.

3. **`task-master` not on PATH per-iteration.**
   `checkTaskMasterAvailable()` catches this **once** before the loop starts (`loop.service.ts:184-191`). There is no per-iteration fallback to MCP — and now that the preset will be CLI-only, that's still fine. The "(or use MCP)" hedge was never load-bearing for this case because (a) the check fires before iteration 1 and exits the loop on failure, and (b) the loop infrastructure has no mechanism to detect MCP availability at any point. Sandbox mode skips the check (`:184`), so a missing `task-master` inside the container would surface as a runtime error in the model's tool result, which is the same failure mode the current "(or use MCP)" hedge produces today.

4. **Inconsistent shapes across steps today** — `task-master next` (no backticks, no flags), `task-master show <id>` (no backticks, positional placeholder), `task-master set-status --id=<id> --status=done` (no backticks, named flags), shell commands in steps 5–6 (with backticks). The in-repo idiom (all 4 specialized presets) is uniform backtick-wrapping of every shell/CLI command. Normalizing the `default` preset to that idiom is the smallest change that yields a cohesive CLI sequence the model can read as one homogeneous channel.

## Code References

- `packages/tm-core/src/modules/loop/presets/default.ts:10-29` — the preset string under audit
- `packages/tm-core/src/modules/loop/presets/index.ts:16-22,27,34,43` — `PRESETS` registry, `PRESET_NAMES`, `getPreset`, `isPreset`
- `packages/tm-core/src/modules/loop/presets/__snapshots__/presets.spec.ts.snap:3-24` — Vitest snapshot pinning the exact `default` text
- `packages/tm-core/src/modules/loop/presets/presets.spec.ts:190-283` — structural assertions; `:258-265,276-283,197-205` exempt `default` from markdown rules
- `packages/tm-core/src/modules/loop/services/loop.service.ts:55-87` — `checkTaskMasterAvailable` implementation (`spawnSync('task-master', ['--version'])`)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:184-191` — precondition gate (`prompt === 'default' && !sandbox`)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:496-505` — `resolvePrompt` (preset vs. file path)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:507-513` — `buildContextHeader` (`@<progressFile> @CLAUDE.md\n\nLoop iteration N of M`)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:515-521` — `buildPrompt` (header + preset, verbatim)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:970-993` — `buildCommandArgs` (`['-p', prompt, '--dangerously-skip-permissions', ...]`)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:360,378,894` — infra-level `appendFile` for progress header / summary
- `apps/cli/src/commands/loop.command.ts:49-54,89-165` — CLI `--prompt` option, default `'default'`, passed through to `LoopDomain.run`
- `apps/mcp/src/tools/loop/loop.tool.ts:106-116` — MCP loop tool path; identical dispatch
- `packages/tm-core/src/modules/loop/loop-domain.ts:60-74,184-199` — `LoopDomain.run` + `buildConfig` (defaults `prompt` to `'default'`)
- `packages/tm-core/src/modules/loop/presets/linting.ts:4-34` — sibling preset; backtick-wrapped CLI idiom
- `packages/tm-core/src/modules/loop/presets/duplication.ts:4-34` — sibling preset
- `packages/tm-core/src/modules/loop/presets/entropy.ts:4-?` — sibling preset
- `packages/tm-core/src/modules/loop/presets/test-coverage.ts:4-41` — sibling preset; "Do NOT" guard style
- `scripts/loop.sh:36-56` — legacy shell version of the same prompt (also has "(or use MCP)" hedge); marked "Keeping here for reference, but using the new task-master loop command instead"

## Architecture Documentation

- **Preset is static text, not a template.** No substitution variables, no system-prompt wrapping. What lives in the template literal is what reaches the model, except for the runtime header concatenated by `buildPrompt`.
- **Single dispatch surface.** Both `apps/cli` and `apps/mcp` route through `LoopDomain.run → LoopService.run → buildPrompt → spawn('claude', ['-p', prompt, ...])`. There is exactly one place where the preset becomes a prompt.
- **Precondition is one-shot, not per-iteration.** `checkTaskMasterAvailable` is by design fired only before iteration 1; the comment at `loop.service.ts:50-54` explains: "Verifying availability once up front lets us fail fast with a clear install instruction, instead of paying tokens every iteration on a SETUP line the LLM cannot usefully act on." The same philosophy applies to MCP — the loop infrastructure does not check MCP availability at any point, so the MCP hedge in the prompt was never backed by infrastructure.
- **`default` is intentionally the odd preset.** The four specialized presets share a markdown-headers + `## Files Available` + `@`-file-reference idiom. The `default` preset uses plain-text labels and relies on the runtime context header for file references. This asymmetry is encoded in `presets.spec.ts:258-265,276-283,197-205` as exemptions.
- **Bash-channel commands have always-loaded schemas.** Anything dispatched via `Bash` (i.e., `task-master ...`, `npm ...`, `git ...`) does not trigger `ToolSearch`. MCP-namespaced tools (`mcp__server__tool`) are deferred and require a `ToolSearch select:` round-trip.

## Historical Context (from thoughts/shared/)

The original question file `thoughts/shared/questions/2026-05-22-ENG-tag-ba8154-loop-preset-cli-only-tool-search.md` is the only active document on this exact topic. The archived research/plans relate to adjacent loop work (trace levels, session persistence, progress-file logging), and none of them have edited the preset wording. Notable adjacent context:

- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — refactor of `--verbose`/`--trace` into a hierarchical `--tracelevel` enum.
- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — persisting trace output to the progress file without ANSI codes.
- `thoughts/shared/plans/ARCHIVE/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md` — trace-level prefixing for progress.txt lines.
- `thoughts/shared/plans/ARCHIVE/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md` — silencing console output via trace levels.
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-6af922-session-persistence-flag.md` — `--no-session-persistence` flag plumbing.

None of these touch the MCP/CLI choice in the preset. The "(or use MCP)" wording has been present since the original `scripts/loop.sh:40` (now marked as kept "for reference") and was preserved verbatim when the loop was ported into `default.ts`. No prior document records a deliberate decision to keep the MCP hedge — it appears to be incidental carryover.

## Related Research

- `thoughts/shared/questions/2026-05-22-ENG-tag-ba8154-loop-preset-cli-only-tool-search.md` — the refined question that drove this research

## Open Questions

- Should the rewrite add an explicit "do not use `mcp__task-master-ai__*`" guard, or rely on the absence of any MCP mention plus uniform backtick-wrapped CLI commands? No prior preset in this codebase uses an explicit anti-tool guard, but the harness still surfaces the MCP tools as deferred regardless of preset wording, which is a residual source of `ToolSearch` temptation that the preset alone cannot fully extinguish.
- Should step 9 name `.taskmaster/loop-progress.txt` directly inside the preset body, or continue to rely on the runtime context header (`@.taskmaster/loop-progress.txt`) to identify the file? Naming it inside the preset would harden against the `update-subtask` temptation, at the cost of duplicating the file reference.
- The legacy `scripts/loop.sh:40` carries the same "(or use MCP)" wording. Out of scope for this question (which is `default.ts` only), but worth noting that the rewrite leaves the shell-script form un-updated.
