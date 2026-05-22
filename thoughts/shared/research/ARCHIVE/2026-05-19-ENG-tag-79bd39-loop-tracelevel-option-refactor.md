---
topic: "Replace loop's --verbose/--trace booleans with a hierarchical --tracelevel enum"
tags: [research, codebase, loop, cli, tm-core, tag-79bd39]
status: complete
source_question: thoughts/shared/questions/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md
---

# Research: Replace loop's `--verbose`/`--trace` booleans with a hierarchical `--tracelevel` enum

## Research Question

The `loop` CLI command currently exposes two independent boolean flags — `--verbose` and `--trace` — and the implementation already encodes an implicit "trace implies verbose" rule (`effectiveVerbose = verbose || trace`). Replace those two flags with a single enum option `--tracelevel <none|verbose|trace>` that makes the hierarchy explicit: each level activates its own behavior plus every less-verbose level below it. Map every place the existing `verbose` and `trace` booleans are produced, passed, consumed, gated on, or asserted against — across CLI, tm-core (`LoopConfig`, `LoopService`, callbacks, progress-file trace persistence), and any other consumers — so the refactor can be designed with full knowledge of the blast radius.

## Summary

The blast radius is contained to four runtime files and three test files, plus one documentation page. There are no MCP or extension consumers — only the CLI builds a `LoopConfig` for the loop module today. The public package surface (`packages/tm-core/src/index.ts` and `packages/tm-core/src/modules/loop/index.ts`) re-exports `LoopConfig`, so any breaking shape change is a public-API change.

The codebase has zero use of Commander's `.choices(...)` helper today; every existing enum-style option (`--status`, `--format`) is validated by hand inside the action handler. One command (`cluster-start`) does parse-time validation via `argParser` + `InvalidArgumentError` for a numeric option. Both patterns are viable for `--tracelevel`; case sensitivity in the existing patterns is "case-preserving, exact match" (no lowercasing before `includes()` check).

Two test assertions hard-pin the literal strings `'--trace'` and `'--verbose'` inside the sandbox-incompatibility error message — these will fail at the same moment the production error message is rewritten. None of the existing tests exercise Commander's actual `parse()` for `--verbose`/`--trace`; the option declarations on the loop command are currently uncovered by parser-level tests.

The trace-file persistence work landed in commit `e3b7ae12` (visible on this branch) introduced eight distinct sites in `loop.service.ts` that gate progress-file writes on the `trace` flag — every site is enumerated below.

## Detailed Findings

### Research Area 1 — CLI option surface

`apps/cli/src/commands/loop.command.ts` declares both flags on the Commander program:

- `apps/cli/src/commands/loop.command.ts:61` — `.option('-v, --verbose', "Show Claude's work in real-time")`
- `apps/cli/src/commands/loop.command.ts:62-65` — `.option('--trace', 'Show full LLM input/output and tool-call details (implies --verbose)')`

Neither uses `.choices()` or `.argParser()` — both default to `undefined` and `options.verbose ?? false` / `options.trace ?? false` is applied in the action handler.

`LoopCommandOptions` (`apps/cli/src/commands/loop.command.ts:21-31`) is the interface that Commander's parsed-options object is typed as:

```typescript
export interface LoopCommandOptions {
  iterations?: string;
  prompt?: string;
  progressFile?: string;
  tag?: string;
  project?: string;
  sandbox?: boolean;
  output?: boolean;
  verbose?: boolean;
  trace?: boolean;
}
```

Combination into `effectiveVerbose` happens at `apps/cli/src/commands/loop.command.ts:129-132`:

```typescript
const verbose = options.verbose ?? false;
const trace = options.trace ?? false;
// Trace implies verbose - the service uses the same streaming path.
const effectiveVerbose = verbose || trace;
```

The resulting `Partial<LoopConfig>` (`loop.command.ts:133-146`) carries both fields independently:

```typescript
verbose: effectiveVerbose,
trace,
// ...
callbacks: this.createOutputCallbacks(effectiveVerbose, trace)
```

**Commander version:** `^12.1.0` (pinned in `apps/cli/package.json:33`). In Commander 12 the canonical pattern for a fixed string enum is `.choices([...])`, but this codebase has zero uses of `.choices()`. Commander's `.choices()` is case-sensitive by default — it rejects values not in the array exactly (string equality).

**Existing enum-style option patterns in this codebase** (all four are manual; none uses `.choices()`):

1. **`apps/cli/src/commands/set-status.command.ts`** — `VALID_TASK_STATUSES` array + `includes()` check in the action handler. Error format: `Error: Invalid status "foo". Valid options: pending, in-progress, done, ...` → `process.exit(1)`. Case-preserving, exact match. (`set-status.command.ts:22-30`, validation at `set-status.command.ts:139-146`.)

2. **`apps/cli/src/commands/list.command.ts`** — dedicated `validateOptions()` method returning `boolean`, called first inside the action. Validates both `--format` (one of `text`/`json`/`compact`) and `--status`. Errors via `chalk.red(...)` + `process.exit(1)`. Tests at `apps/cli/src/commands/list.command.spec.ts:167-182` cover invalid format. (`list.command.ts:107-111` declaration, `list.command.ts:263-301` validation.)

3. **`apps/cli/src/commands/cluster-start.command.ts:61-76`** — the **only** parse-time validator in the codebase. Uses `argParser` callback that throws `InvalidArgumentError` (imported from `commander` at `cluster-start.command.ts:13`). Commander formats the error as `error: option '--parallel' argument 'abc' is invalid. <message>`. Tests use `cmd.exitOverride()` and `expect(...).rejects.toThrow(...)`. Used for a numeric constraint, not a string enum, but the mechanism applies equally to enums.

4. **`apps/cli/src/commands/start.command.ts:176-184`** — inline `['text', 'json'].includes(...)` check inside `validateOptions()`. No test coverage on the validation path.

Pattern dominance: 3 of 4 use post-parse manual validation in the action; 1 uses parse-time `argParser`. The codebase has no precedent for `.choices()`.

### Research Area 2 — LoopConfig contract in tm-core

`packages/tm-core/src/modules/loop/types.ts:107-166` defines `LoopConfig`. The two boolean fields and their JSDoc:

- `packages/tm-core/src/modules/loop/types.ts:131-139` — `verbose?: boolean` documented as "Show Claude's work in real-time… NOT compatible with `sandbox=true`".
- `packages/tm-core/src/modules/loop/types.ts:141-152` — `trace?: boolean` documented as "implies verbose streaming AND additionally emits… NOT compatible with `sandbox=true` (same constraint as verbose)".

The `LoopOutputCallbacks` JSDoc at `types.ts:51-58` documents the mode hierarchy explicitly:

```
- onLoopStart, onLoopEnd, onIterationStart, onIterationEnd, onError, onStderr: all modes
- onText, onToolUse: VERBOSE or TRACE mode
- onOutput: NORMAL mode only (no --verbose, no --trace)
- onPromptSent, onToolInput, onToolResult, onIterationSummary: TRACE mode only
```

These docstrings — both the field-level JSDoc and the callbacks block — are part of the contract surface and will need rewriting against the `traceLevel` shape.

**Public surface exports:**

- `packages/tm-core/src/modules/loop/index.ts:14-20` re-exports `LoopPreset`, `LoopConfig`, `LoopIteration`, `LoopResult`, `LoopOutputCallbacks`.
- `packages/tm-core/src/index.ts:154-161` re-exports those same types plus `LoopDomain` and `PRESET_NAMES`.

`LoopService` and `LoopServiceOptions` are exported from the loop-module barrel (`packages/tm-core/src/modules/loop/index.ts:10-11`) but **not** from the package-level barrel (`packages/tm-core/src/index.ts`).

No consumer outside the CLI requires the boolean shape — the two booleans can be removed outright (see Research Area 7 for the empty external-consumer set).

### Research Area 3 — Callback gating logic

**In CLI (`apps/cli/src/commands/loop.command.ts:192-330`):**

`createOutputCallbacks(verbose: boolean, trace = false)` has two conditional blocks:

- `loop.command.ts:237-248` — gated on `if (verbose)`: attaches `onLoopStart` (prints `[Loop Start] <ISO>`) and `onLoopEnd` (prints `[Loop End] <ISO> (<duration>)`).
- `loop.command.ts:250-330` — gated on `if (trace)`: attaches `onPromptSent`, `onToolInput`, `onToolResult`, `onIterationSummary` (which renders tool-call counts, token usage, and final LLM output).

The "trace implies verbose" rule is preserved at the call site: `loop.command.ts:145` passes `effectiveVerbose, trace` so the `verbose`-gated block runs whenever trace is true.

**In service (`packages/tm-core/src/modules/loop/services/loop.service.ts`):**

- `loop.service.ts:204-206` — `if (config.trace)` gates `onPromptSent` callback in `run()` itself (called before each `executeIteration`).
- `loop.service.ts:806-815` — `if (trace && callbacks?.onIterationSummary)` gates the iteration-end summary callback inside `executeVerboseIteration`.
- `loop.service.ts:981-993` — inside `handleStreamEvent`, `if (trace)` gates the increment of `toolCallCounts` and the `onToolInput` callback.
- `loop.service.ts:1000-1011` — inside `handleStreamEvent`, `if (trace && event.type === 'user')` gates `onToolResult` callback.

The "verbose-or-trace" streaming gate is `loop.service.ts:162` — `const streaming = !!(config.verbose || config.trace);` — which decides between `executeIteration` (synchronous `spawnSync`) and `executeVerboseIteration` (streaming `spawn`).

A clean ordering predicate for the refactor is straightforward: define `level >= 'verbose'` (true for `verbose` or `trace`) and `level >= 'trace'` (true only for `trace`), e.g., via a numeric weight map. The existing "trace implies verbose" rule survives unchanged — every site that currently fires when `verbose || trace` becomes `level >= 'verbose'`, every site that fires only when `trace` becomes `level === 'trace'`.

### Research Area 4 — LoopService consumers (every read of verbose/trace)

All inside `packages/tm-core/src/modules/loop/services/loop.service.ts`:

| Line | Read | Purpose |
|---|---|---|
| 162 | `!!(config.verbose \|\| config.trace)` | Compute `streaming` flag |
| 165 | `streaming && config.sandbox` | Sandbox incompatibility gate |
| 166 | `config.trace ? '--trace' : '--verbose'` | Pick flag name for error message |
| 204 | `if (config.trace)` | Emit `onPromptSent` callback |
| 213 | `streaming` (passed as `verbose` param) | Pass to `executeIteration` |
| 214 | `config.trace ?? false` | Pass `trace` param to `executeIteration` |
| 557-558 | `verbose = false, trace = false` | `executeIteration` parameter defaults |
| 565 | `if (verbose)` | Branch to `executeVerboseIteration` |
| 641 | `trace: boolean` | `executeVerboseIteration` parameter |
| 651-653 | `trace && progressFile ? [] : undefined` | Allocate `traceLines` buffer |
| 654-659 | `if (traceLines)` | Write LLM-input header into buffer |
| 710 | `if (trace)` | Extract token-usage snapshot |
| 806 | `if (trace && callbacks?.onIterationSummary)` | Emit iteration summary callback |
| 818 | `if (traceLines && progressFile)` | Flush buffer to file |
| 906-921 | `buildCommandArgs(prompt, sandbox, verbose)` | Append `--output-format stream-json --verbose` to Claude CLI args when `verbose=true` |
| 969 | `trace = false` | `handleStreamEvent` parameter default |
| 981 | `if (trace)` | Gate tool-call counting + `onToolInput` |
| 1000 | `if (trace && event.type === 'user')` | Gate `onToolResult` |

The Claude CLI's own `--verbose` flag appended at `loop.service.ts:917-918` is a separate concern — it's part of the spawned subprocess invocation, not the loop's option model. It stays as `--verbose` regardless of how the loop's user-facing flag is renamed.

### Research Area 5 — Sandbox compatibility constraint

The check lives in exactly one place: `loop.service.ts:164-170`:

```typescript
if (streaming && config.sandbox) {
  const flag = config.trace ? '--trace' : '--verbose';
  const errorMsg = `${flag} mode is not supported with sandbox mode. Use ${flag} without --sandbox, or remove ${flag}.`;
  this.reportError(config.callbacks, errorMsg);
  return this.buildErrorResult(loopStart, errorMsg, config.callbacks);
}
```

No CLI-side pre-check exists — the CLI only calls `LoopDomain.run()` and surfaces `LoopResult.errorMessage` via `displayResult()` (`loop.command.ts:358-360`).

Restated as `traceLevel !== 'none'` (or equivalently `level >= 'verbose'`), the constraint is identical. The error-message text mentions `--trace`/`--verbose` by name; after the refactor it must mention `--tracelevel` (and probably the specific level value the user passed).

### Research Area 6 — Test coverage map

**`apps/cli/src/commands/loop.command.spec.ts`** has 11 verbose/trace-touching tests:

| Line | Test | Category |
|---|---|---|
| 314-320 | `createOutputCallbacks` — should NOT attach loop timestamp callbacks when verbose is false | (a) input signature changes |
| 323-342 | `createOutputCallbacks` — should attach loop timestamp callbacks when verbose is true | (a) input signature changes |
| 573-587 | execute integration — should pass trace flag through to loop config (asserts `mockLoopRun` receives `{trace: true, verbose: true}`) | (c) "trace implies verbose" → moves to level-ordering test |
| 589-602 | execute integration — should not enable trace by default (asserts `{trace: false, verbose: false}`) | (b) becomes a `traceLevel === 'none'`-default test |
| 604-617 | execute integration — should preserve plain --verbose without enabling trace | (b) becomes `traceLevel === 'verbose'` test |
| 621-630 | trace callbacks — should not register trace callbacks when trace is false | (a) input signature changes |
| 633-643 | trace callbacks — should register trace callbacks when trace is true | (a) input signature changes |
| 645-657 | trace callbacks — should print the LLM prompt via onPromptSent | (a) input signature changes |
| 659-679 | trace callbacks — should print a tool-call summary at iteration end | (a) input signature changes |
| 681-705 | trace callbacks — should print token usage when included in the summary | (a) input signature changes |
| 707-726 | trace callbacks — should omit cache rows when cache fields are absent | (a) input signature changes |

**`packages/tm-core/src/modules/loop/services/loop.service.spec.ts`** has 9 verbose/trace-touching tests:

| Line | Test | Category |
|---|---|---|
| 366-388 | pre-flight error timing — verbose+sandbox conflict still records duration / calls onLoopEnd | (c) survives — input becomes `traceLevel: 'verbose'` |
| 636-650 | trace mode — should reject trace+sandbox with `--trace`-specific message (`.toContain('--trace')`) | (b) error-message assertion must change |
| 651-665 | trace mode — should reject verbose+sandbox with `--verbose`-specific message (`.toContain('--verbose')`) | (b) error-message assertion must change |
| 667-723 | trace mode — should forward trace-only callbacks through stream event handler | (a) input signature changes |
| 725-773 | trace mode — should NOT emit trace-only callbacks when trace=false | (a) input signature changes |
| 858-880 | trace file persistence test 1 — prompt text reaches appendFile w/o ANSI escapes | (a) input shape changes |
| 882-916 | trace file persistence test 2 — tool input JSON pretty-printed, capped at 10 KB | (a) input shape changes |
| 918-948 | trace file persistence test 3 — token-usage rows reach appendFile | (a) input shape changes |
| 950-996 | trace file persistence test 4 — multiple tool_use blocks → one appendFile call | (a) input shape changes |

**Important gap:** No test in either file exercises Commander's `parse()` for `--verbose`/`--trace`. `loop.command.spec.ts` calls `execute({...})` directly with a plain options object. The option-registration block at `loop.command.spec.ts:136-173` inspects the registered `loopCommand.options` array for metadata but does not cover `--verbose` or `--trace` at all. **Effect:** renaming the option in production code today would not break any existing test — new tests must be added to cover `--tracelevel` parsing (valid value, invalid value, missing value, case variations).

**No `createLoopConfig()` fixture helper exists.** Each test builds its config inline. `createMockResult()` at `loop.command.spec.ts:55-63` is a `LoopResult` factory, not a config one. Every call site must be updated individually — there is no central helper signature to amend.

**Other spec files that construct a `LoopConfig`** (these do NOT pass verbose/trace, so they need no behavioral change — just need to keep working if the `LoopConfig` shape changes):

- `packages/tm-core/src/modules/loop/types.spec.ts:38-150` — four construction sites, all omit verbose/trace.
- `packages/tm-core/src/modules/loop/loop-domain.spec.ts:97-106` and 46-89 — multiple `buildConfig({})` calls and one full config, all omit verbose/trace.
- `packages/tm-core/tests/integration/loop/loop-core-exports.test.ts:61-81` — two construction sites, both omit.
- `apps/cli/tests/integration/commands/loop.command.test.ts` — does not build a `LoopConfig` directly; tests only help text and iteration validation.

### Research Area 7 — External consumers

Exhaustive search across the monorepo returned **no other consumers**:

- **`apps/mcp/src/`** — zero matches for `verbose`/`trace`/`LoopConfig` across all files (`autopilot/`, `tasks/`). No loop MCP tool exists.
- **`apps/extension/src/`** — zero matches; the only "trace" string is "stack trace" in a comment at `errorHandler.ts:145`.
- **Scripts** — `scripts/modules/config-manager.js:441` has `verbose: z.boolean().optional()` in a Zod schema, but this is unrelated to the loop module (it's general config). No loop scripts exist.
- **No package consumes `@tm/core`'s loop API beyond `@tm/cli`.**

The only external-facing migration is to `LoopConfig`'s public type shape and to the CLI's option name. No other code needs to change.

**Documentation that must be updated:**

- `apps/docs/capabilities/loop.mdx:80-110` — the canonical options table (line 91 `-v, --verbose`, line 92 `--trace`) and the "Verbosity Levels" section (lines 94-109). The `loop.mdx` file already groups them as "two levels of visibility" — rewriting it as three levels (`none`, `verbose`, `trace`) is a natural fit.
- `docs/claude-code-integration.md:166` — passing mention of `--verbose`.
- `docs/configuration.md:582-595` — documents a `verbose` config-file boolean. Verify whether this is loop-related or unrelated general config (the locator agent listed it but did not distinguish; likely unrelated to loop, since loop's verbose is CLI-flag-only and not config-file-driven).
- `CHANGELOG.md:95-100` — historical PR #1605 reference to the original `--verbose` flag (do not edit; historical record).

**Changeset files** that reference the old flags (these are existing changesets describing past work — do not edit; instead add a new changeset for the rename):
- `.changeset/loop-trace-level.md`
- `.changeset/loop-trace-token-usage.md`
- `.changeset/loop-timestamps.md`

### Research Area 8 — Progress-file trace persistence

The trace-block writes added in commit `e3b7ae12` are spread across `loop.service.ts` and `executeVerboseIteration`/`handleStreamEvent`. Eight gates total, all gated on the `trace` boolean (or on `traceLines` which itself is allocated only when `trace && progressFile`):

| # | Location | Gate | Action |
|---|---|---|---|
| 1 | `loop.service.ts:651-653` | `trace && progressFile` | Allocate `traceLines` buffer |
| 2 | `loop.service.ts:654-659` | `if (traceLines)` | Write `## Iteration N` header + LLM input block |
| 3 | `loop.service.ts:987-991` (inside `handleStreamEvent`) | `if (trace)` outer + `block.input !== undefined` | Write tool-input JSON block into buffer |
| 4 | `loop.service.ts:1000-1010` (inside `handleStreamEvent`) | `if (trace && event.type === 'user')` | Write tool-result JSON block into buffer |
| 5 | `loop.service.ts:818-839` | `if (traceLines && progressFile)` | Flush buffer to progress file with summary block + `---` separator |
| 6 | `loop.service.ts:708-714` | `if (trace)` | Capture token-usage snapshot from `result` event |
| 7 | `loop.service.ts:203-205` | `if (config.trace)` | Fire `onPromptSent` callback in `run()` |
| 8 | `loop.service.ts:806-815` | `if (trace && callbacks?.onIterationSummary)` | Fire iteration-summary callback |

All eight collapse to `level === 'trace'` (the highest level). Per the question's clarification, nothing at the verbose level should land in the progress file — the current baseline (writes only at trace) is preserved.

## Edge Cases Addressed

- **`--tracelevel` with no value / empty value** — Commander's behavior on `--tracelevel <required-value>` with a missing arg is a parse-time error (`error: option '--tracelevel <level>' argument missing`). This is automatic; no custom code needed.

- **Invalid value (`--tracelevel foo`)** — depends on chosen validation pattern (see Research Area 1). If `.choices(['none','verbose','trace'])` is used, Commander 12 emits a parse-time error like `error: option '--tracelevel <level>' argument 'foo' is invalid. Allowed choices are none, verbose, trace.` and exits non-zero. If the codebase's prevailing manual `includes()` pattern is used, the error is printed by `chalk.red(...)` and the action handler calls `process.exit(1)`. Both produce a hard error.

- **Case variations (`--tracelevel TRACE`, `--tracelevel Verbose`)** — every existing enum pattern in the codebase is case-preserving and exact-match (`.includes(value)` on a lowercase-only array). Commander's `.choices()` is also exact-match case-sensitive by default. So uppercase/mixed-case input will produce a hard error under any of the existing patterns. There is no codebase precedent for accepting case variations.

- **`--tracelevel verbose --sandbox` and `--tracelevel trace --sandbox`** — both must trigger the same "not compatible with sandbox" error today's `--verbose --sandbox` / `--trace --sandbox` produce. The single gate at `loop.service.ts:164-170` is the only site; restated as `if (config.traceLevel !== 'none' && config.sandbox) { … }`. The error message text mentions the flag name — switching to `--tracelevel` will cascade to the two `.toContain('--trace')` / `.toContain('--verbose')` test assertions at `loop.service.spec.ts:648` and `:663`.

- **Default behavior with no flag** — today `verbose ?? false` and `trace ?? false` both default to `false`, which means `streaming === false`, `executeIteration` (not `executeVerboseIteration`) runs, no trace blocks are written, no loop-timestamp callbacks attached. The equivalent default `traceLevel === 'none'` (or `traceLevel === undefined`) must produce identical behavior.

- **Level-ordering predicate** — define once. Suggested form: a numeric weight table `{ none: 0, verbose: 1, trace: 2 }` plus a helper `atLeast(level, threshold)` that compares weights. Future levels slot in by adding to the table; gates that say `atLeast(level, 'verbose')` and `atLeast(level, 'trace')` don't change.

- **LoopConfig consumers outside the CLI** — none exist (Research Area 7 confirmed). Only internal tests pass `verbose`/`trace`; every such site is enumerated above.

- **Tests that pin the existence of `--verbose` or `--trace` as registered Commander options** — none. The `option parsing` describe block at `loop.command.spec.ts:136-173` does not enumerate either flag. This is a gap that should be filled with positive tests for `--tracelevel`'s registration as part of the refactor (asserting the option exists, accepts the three valid values, rejects unknown values).

## Code References

**CLI:**
- `apps/cli/src/commands/loop.command.ts:21-31` — `LoopCommandOptions` interface (the typed shape of parsed options)
- `apps/cli/src/commands/loop.command.ts:61-65` — Commander `.option(...)` declarations for `--verbose` and `--trace`
- `apps/cli/src/commands/loop.command.ts:129-146` — option defaulting + `effectiveVerbose` derivation + `Partial<LoopConfig>` construction
- `apps/cli/src/commands/loop.command.ts:192-330` — `createOutputCallbacks(verbose, trace)` with verbose-gated and trace-gated blocks

**tm-core types:**
- `packages/tm-core/src/modules/loop/types.ts:107-166` — `LoopConfig` interface (booleans at lines 139, 152)
- `packages/tm-core/src/modules/loop/types.ts:51-58` — `LoopOutputCallbacks` JSDoc documenting mode hierarchy
- `packages/tm-core/src/modules/loop/index.ts:14-20` — loop-module barrel re-exporting types
- `packages/tm-core/src/index.ts:154-161` — package-level barrel re-exporting `LoopConfig` + friends

**tm-core domain:**
- `packages/tm-core/src/modules/loop/loop-domain.ts:60` — `run(config: Partial<LoopConfig>): Promise<LoopResult>` public method
- `packages/tm-core/src/modules/loop/loop-domain.ts:184-200` — `buildConfig()` that defaults `verbose ?? false, trace ?? false`

**tm-core service (every `verbose`/`trace` reference):**
- `packages/tm-core/src/modules/loop/services/loop.service.ts:162` — `streaming` derivation
- `packages/tm-core/src/modules/loop/services/loop.service.ts:164-170` — sandbox incompatibility gate + error message template
- `packages/tm-core/src/modules/loop/services/loop.service.ts:203-206` — `onPromptSent` gate
- `packages/tm-core/src/modules/loop/services/loop.service.ts:208-216` — `executeIteration` call site
- `packages/tm-core/src/modules/loop/services/loop.service.ts:552-616` — `executeIteration` (verbose param at 557, branch at 565)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:635-851` — `executeVerboseIteration` (trace param at 641, eight gate sites enumerated above)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:906-921` — `buildCommandArgs(prompt, sandbox, verbose)` (the Claude-CLI subprocess `--verbose` is unrelated)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:954-1012` — `handleStreamEvent` (trace param at 969, gates at 981 and 1000)

**Tests:**
- `apps/cli/src/commands/loop.command.spec.ts:314-726` — 11 verbose/trace-touching tests (enumerated above)
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:366-996` — 9 verbose/trace-touching tests (enumerated above)
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:648, 663` — the two `.toContain('--trace')` / `.toContain('--verbose')` assertions that hard-pin flag names
- `packages/tm-core/src/modules/loop/types.spec.ts`, `loop-domain.spec.ts`, `tests/integration/loop/loop-core-exports.test.ts` — construct `LoopConfig` instances without verbose/trace (no behavioral change needed, but type-shape change will touch them)

**Documentation:**
- `apps/docs/capabilities/loop.mdx:80-110` — options table and "Verbosity Levels" section

**Pattern references for `--tracelevel` validation:**
- `apps/cli/src/commands/set-status.command.ts:22-30, 139-146` — manual `VALID_*` array + `includes()` (post-parse)
- `apps/cli/src/commands/list.command.ts:107-111, 263-301` — `validateOptions()` method pattern (post-parse, returns boolean)
- `apps/cli/src/commands/cluster-start.command.ts:13, 61-76` — `argParser` + `InvalidArgumentError` (parse-time, Commander-formatted)
- `apps/cli/src/commands/start.command.ts:176-184` — inline `includes()` in `validateOptions()`

## Architecture Documentation

**Layering** (per `CLAUDE.md`): all business logic lives in `@tm/core`; CLI is a thin presentation layer. The "trace implies verbose" rule today is partly in CLI (`effectiveVerbose = verbose || trace` at `loop.command.ts:132`) and partly in tm-core (the `streaming = verbose || trace` derivation at `loop.service.ts:162`). After the refactor, the rule should live entirely in tm-core — the CLI should pass `traceLevel` verbatim and tm-core should derive everything (streaming, sandbox conflict, callback gates) from a single level value.

**Public API contract:** `LoopConfig` is re-exported from `packages/tm-core/src/index.ts:154-161`. Any external consumer who imports `LoopConfig` would see the boolean fields disappear and `traceLevel` appear. There are no such external consumers in this monorepo, but the package version implies a public API.

**Streaming pipeline:** `executeIteration` (synchronous, `spawnSync`) is the default path; `executeVerboseIteration` (streaming, `spawn` + `child.stdout.on('data', ...)`) is the verbose-or-trace path. The branch is at `loop.service.ts:565` — `if (verbose) return this.executeVerboseIteration(...)`. The local `verbose` parameter there is the streaming flag, not the user's verbose level.

**Trace-file buffering:** `traceLines: string[] | undefined` is the per-iteration buffer allocated at `loop.service.ts:651-653` only when `trace && progressFile`. All subsequent `traceLines?.push(...)` calls become no-ops when the buffer is undefined. This pattern is clean — moving to `level === 'trace'` is a single-line change at the allocation site.

**Output-callback hierarchy** (already encoded as JSDoc at `types.ts:51-58`):

```
none      → onLoopStart, onLoopEnd, onIterationStart, onIterationEnd, onError, onStderr, onOutput
verbose   → above + onText, onToolUse, onLoopStart/onLoopEnd timestamps in CLI
trace     → above + onPromptSent, onToolInput, onToolResult, onIterationSummary
```

This is the natural three-level hierarchy that `--tracelevel` will surface. The current JSDoc already groups them as "VERBOSE or TRACE" / "TRACE only" — the rewrite is a documentation-pattern alignment.

## Historical Context (from thoughts/shared/)

The trace work is recent — landed on this branch (commit `e3b7ae12`, with archived design and research docs already moved to `ARCHIVE/`):

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — original research on the trace callbacks + progress-file persistence (ticket `tag-38a2bd`, the predecessor to this work).
- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — implementation plan for the trace-block file writes.
- `thoughts/shared/claude-code-design/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — design notes for the trace callbacks.

These describe how `--trace` came to imply `--verbose` and why the two flags ended up coexisting as separate booleans (the design intentionally separated the streaming-display concern from the trace-detail concern, but both gated on the same stream-json pipeline). The `--tracelevel` refactor is a natural follow-up that makes the implicit hierarchy explicit at the CLI surface without changing any of the underlying behavior.

Recent git history on this branch:
- `0c412d77` — Adding archived thoughts.
- `e3b7ae12` — `feat(loop): write --trace details to progress file and humanize total duration` (the trace-file persistence commit; introduces the eight gates enumerated in Research Area 8).
- `a63f7239` — `Updating learnings to be more optional.`

## Related Research

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — prior research for the trace work that introduced the `trace` boolean.
- `thoughts/shared/questions/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — the refined question file driving this research.

## Open Questions

- **`docs/configuration.md:582-595` `verbose` field** — the locator agent surfaced this as a documentation hit. Whether it's related to loop (and should be migrated) or a separate unrelated config knob is unverified. Worth a 30-second check during implementation.
- **Validation pattern choice** — three viable patterns exist in this codebase (Commander `.choices()` is a fourth, but unused locally). The decision belongs in the design stage, not in research; this document only enumerates the options and their error formats.
- **Whether `LoopConfig.traceLevel` should be `'none' | 'verbose' | 'trace'` (omitting it means default) or `'none' | 'verbose' | 'trace' | undefined` (undefined === 'none')** — both are workable; the type shape affects whether external consumers must spell out `traceLevel: 'none'` or can omit the field. This is a design decision left to the next stage.
