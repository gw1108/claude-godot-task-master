---
original_question: "Change the --verbose and --trace options for loop into a singular option like --tracelevel verbose and --tracelevel trace. --tracelevel trace should use the logging level of itself plus every logging level that is less verbose than it like verbose."
ticket: tag-79bd39
---

# Research Question: Replace loop's `--verbose`/`--trace` booleans with a hierarchical `--tracelevel` enum

## Refined Question

The `loop` CLI command currently exposes two independent boolean flags — `--verbose` and `--trace` — and the implementation already encodes an implicit "trace implies verbose" rule (`effectiveVerbose = verbose || trace`). Replace those two flags with a single enum option `--tracelevel <none|verbose|trace>` that makes the hierarchy explicit: each level activates its own behavior plus every less-verbose level below it.

The research must map every place the existing `verbose` and `trace` booleans are produced, passed, consumed, gated on, or asserted against — across CLI, tm-core (`LoopConfig`, `LoopService`, callbacks, progress-file trace persistence), and any other consumers (MCP, extension, presets) — so the refactor can be designed with full knowledge of the blast radius. The `LoopConfig` shape should be unified to a single `traceLevel` field if feasible (no parallel boolean shim).

## Research Areas

1. **CLI option surface** — In `apps/cli/src/commands/loop.command.ts`: how `--verbose` and `--trace` are declared, parsed, defaulted, and combined into `effectiveVerbose`. What `LoopCommandOptions` looks like today, what a `--tracelevel <none|verbose|trace>` replacement looks like, and how Commander validates enum-style options (including case sensitivity behavior — check what Commander does out of the box rather than assume).

2. **LoopConfig contract in tm-core** — In `packages/tm-core/src/modules/loop/types.ts`: how `verbose?: boolean` and `trace?: boolean` are documented and used as the public API. Design the unified replacement (e.g. `traceLevel?: 'none' | 'verbose' | 'trace'`) and confirm whether the two booleans can be removed outright or whether any consumer requires the boolean shape.

3. **Callback gating logic** — In `LoopCommand.createOutputCallbacks` and the service-side equivalents: every site that conditionally attaches or invokes callbacks based on `verbose` or `trace`. Define a clear ordering predicate (`level >= 'verbose'`, `level >= 'trace'`) to replace the boolean checks, and verify the existing "trace implies verbose" rule survives unchanged.

4. **LoopService consumers** — In `packages/tm-core/src/modules/loop/services/loop.service.ts`: every read of `verbose` and `trace`, including stream-json mode selection, the progress-file trace blocks added in commit `e3b7ae12`, and sandbox-incompatibility validation. Enumerate each call site so none is missed during refactor.

5. **Sandbox compatibility constraint** — The current rule rejects `verbose=true` (and therefore `trace=true`) when `sandbox=true`. Confirm where this check lives and restate it as "`traceLevel !== 'none'` is incompatible with `--sandbox`," preserving the same error surface.

6. **Test coverage map** — In `apps/cli/src/commands/loop.command.spec.ts` and `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`: every assertion keyed on `verbose: true`, `trace: true`, `verbose: false`, or `trace: false`. Catalog (a) which assertions describe behavior that survives the refactor and just need their input/output shape updated, vs. (b) which become obsolete, vs. (c) what new tests are needed (invalid `--tracelevel foo`, level ordering, default = `none`).

7. **External consumers** — Search for any other places in the monorepo (MCP server, extension, scripts, docs) that construct a `LoopConfig` or reference the `--verbose`/`--trace` flags. Migrate any found consumer.

8. **Progress-file trace persistence** — The trace-block writes added in commit `e3b7ae12` are gated on the `trace` boolean today. Confirm the gate becomes `traceLevel === 'trace'` (the highest level), and decide whether anything at `verbose` level should ever land in the progress file (current answer is no — preserve that unless a strong reason emerges).

## Clarifications Gathered

- **Q:** What is the complete level set?
  **A:** `none`, `verbose`, `trace` — three discrete levels.
- **Q:** Spelling — `--tracelevel` (one word) or `--trace-level` (kebab-case)? Any short flag?
  **A:** One word: `--tracelevel`. No short flag specified.
- **Q:** Default value when the flag is omitted?
  **A:** `none` — equivalent to today's "neither flag set" behavior.
- **Q:** Case-insensitive or exact-match?
  **A:** Read the code — investigate Commander's default enum validation behavior; do not invent a policy.
- **Q:** Remove old flags outright, deprecate as aliases, or keep alongside?
  **A:** Remove and replace. No deprecated aliases.
- **Q:** Does `LoopConfig` (tm-core) also collapse to a single `traceLevel` field, or keep the booleans?
  **A:** Combine if possible — unify into a single field.
- **Q:** Any MCP or extension consumers that need migrating?
  **A:** Research must figure this out — enumerate them as part of the investigation.
- **Q:** Invalid `--tracelevel foo` handling?
  **A:** Hard error.
- **Q:** Sandbox-incompatibility constraint?
  **A:** Same constraint as today, keyed on level instead of the booleans.
- **Q:** Progress-file trace writes — keep current behavior or change?
  **A:** Research/design decides — current behavior (writes only at trace level) is the baseline unless a strong reason to change emerges.

## Edge Cases to Address

- `--tracelevel` with no value, empty value, or invalid value (`--tracelevel foo`) — should produce a hard error listing valid values.
- Case variations (`--tracelevel TRACE`, `--tracelevel Verbose`) — behavior must be verified against what Commander actually does, not assumed.
- `--tracelevel verbose --sandbox` and `--tracelevel trace --sandbox` — must trigger the same "not compatible with sandbox" error the current `verbose`/`trace` booleans do.
- Default behavior with no flag — must be identical to today's "neither flag passed" run (no loop-timestamp callbacks, no trace blocks in the progress file).
- Level ordering predicate — define a single helper or constant table so future levels can slot in without touching every gate.
- `LoopConfig` consumers outside the CLI (MCP server, extension app, tests, scripts) that today pass `verbose: true` or `trace: true` directly — every one needs migration to `traceLevel`.
- Tests in `loop.command.spec.ts` that today read options off the parsed `Command` object (e.g. the `option parsing` describe block) — verify there's no test that pins the existence of `--verbose` or `--trace` as registered options, since both will be removed.

## Files Provided by User

None directly; the user's question references the on-branch work in `apps/cli/src/commands/loop.command.ts` and `packages/tm-core/src/modules/loop/`.
