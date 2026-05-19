---
topic: "Replace loop's --verbose/--trace booleans with a hierarchical --tracelevel enum"
tags: [design, codebase, loop, cli, tm-core, tag-79bd39]
status: complete
source_research: thoughts/shared/research/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md
---

# Design: Loop `--tracelevel` option refactor

## Problem Statement

The `task-master loop` CLI exposes two independent boolean flags — `--verbose` and `--trace` — whose interaction is governed by an implicit "trace implies verbose" rule reconstructed at the call site (`effectiveVerbose = verbose || trace`). The boolean shape is carried through into `LoopConfig` as two separate fields, and the service derives the same combined predicate (`streaming = verbose || trace`) and a trace-only predicate at ~10 gate sites. This design replaces the two booleans with a single ordered enum field `traceLevel: 'none' | 'verbose' | 'trace'` so the hierarchy is explicit at the CLI surface, in the public `LoopConfig` type, and at every gate site in the service. No runtime behavior changes; the rename is purely a surface refactor.

## Research Source

`thoughts/shared/research/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md`

## Design Decisions

### Axis 1 — Validation pattern for `--tracelevel`
**Choice:** Commander 12's built-in `.choices(['none', 'verbose', 'trace'])` helper, with a default value of `'none'` declared in the same `.option(...)` call.

**Rationale:** Although the codebase has zero existing uses of `.choices()`, it is the canonical Commander idiom for a fixed string enum, produces a clear parse-time error (`error: option '--tracelevel <level>' argument 'foo' is invalid. Allowed choices are none, verbose, trace.`) without bespoke validation code, and sets a clean precedent for future enum options. The existing manual `includes()` pattern (dominant in the codebase) requires duplicated array constants and `process.exit(1)` plumbing inside the action handler; the `argParser`/`InvalidArgumentError` pattern is heavier than needed for an exact-match string enum. Case-sensitivity behavior matches every other enum-style option already in the codebase (exact match, no lowercasing).

### Axis 2 — `LoopConfig.traceLevel` type shape
**Choice:** Optional field: `traceLevel?: LoopTraceLevel`, where `undefined` is treated as `'none'`.

**Rationale:** Mirrors today's shape (both `verbose?` and `trace?` are optional booleans defaulting to `false`), so the four test files that build `LoopConfig` instances without specifying verbose/trace continue to compile unchanged. `LoopDomain.buildConfig()` will normalize `input.traceLevel ?? 'none'` once at the entry point so the rest of the service can read a known-defined level. Required-field alternative would force every existing fixture to spell out `traceLevel: 'none'` with zero behavior payoff.

### Axis 3 — Boolean back-compat shim vs. hard removal
**Choice:** Hard removal. Delete `verbose` and `trace` from `LoopConfig`, delete `verbose?` and `trace?` from CLI `LoopCommandOptions`, and remove the `-v, --verbose` and `--trace` `.option(...)` declarations from `loop.command.ts`.

**Rationale:** Research Area 7 confirmed zero external consumers of the `LoopConfig` booleans across the monorepo (no MCP, no extension, no scripts). CLAUDE.md explicitly discourages backwards-compatibility shims when a clean change is possible. A back-compat alias layer would add conflict-detection logic (`--verbose --tracelevel trace` → error?) and bloat both production and test code for no concrete consumer. The CLI public-flag rename is documented in a changeset.

### Axis 4 — Level-ordering predicate
**Choice:** A numeric weight map plus an `atLeast(level, threshold)` helper, both colocated in a new internal file `packages/tm-core/src/modules/loop/services/trace-level.ts`.

**Rationale:** Gates at the ~10 call sites become `atLeast(level, 'verbose')` and `atLeast(level, 'trace')`, encoding the hierarchy by name rather than by enumeration. If a future level (e.g. `'debug'`) is inserted, only the weight table changes — gate sites remain correct. The inline-equality alternative spreads the level set across the codebase; the "derive two booleans up front" alternative re-creates the dual-boolean shape we are trying to leave behind.

```typescript
// packages/tm-core/src/modules/loop/services/trace-level.ts
export const TRACE_LEVEL_WEIGHTS = {
  none: 0,
  verbose: 1,
  trace: 2,
} as const satisfies Record<LoopTraceLevel, number>;

export function atLeast(level: LoopTraceLevel, threshold: LoopTraceLevel): boolean {
  return TRACE_LEVEL_WEIGHTS[level] >= TRACE_LEVEL_WEIGHTS[threshold];
}
```

### Axis 5 — Sandbox-incompatibility error message
**Choice:** Mention the specific level the user passed. Template:

> `"--tracelevel <level> is not supported with sandbox mode. Use --tracelevel <level> without --sandbox, or set --tracelevel none."`

Example with `--tracelevel verbose --sandbox`:

> `"--tracelevel verbose is not supported with sandbox mode. Use --tracelevel verbose without --sandbox, or set --tracelevel none."`

**Rationale:** Preserves the information density of today's per-flag-named message and the two `.toContain('--trace')` / `.toContain('--verbose')` test assertions can be rewritten to `.toContain('--tracelevel verbose')` / `.toContain('--tracelevel trace')` directly. The single gate at `loop.service.ts:164-170` becomes `if (atLeast(level, 'verbose') && config.sandbox)`.

### Axis 6 — Type name and helper export scope
**Choice:**
- Exported TS type: `LoopTraceLevel` (in `packages/tm-core/src/modules/loop/types.ts`, re-exported from both the loop-module barrel and the package root barrel).
- `atLeast()` and `TRACE_LEVEL_WEIGHTS` are **internal** to the loop module — not included in `loop/index.ts` barrel, not in `packages/tm-core/src/index.ts`.

**Rationale:** `LoopTraceLevel` matches the established `Loop*` naming convention (`LoopConfig`, `LoopPreset`, `LoopResult`, `LoopIteration`, `LoopOutputCallbacks`, `LoopDomain`). The helper has no current external consumer; per YAGNI it stays internal and can be promoted later if needed.

### Axis 7 — Where the "trace implies verbose" rule lives (implied by above choices)
**Choice:** Entirely inside `@tm/core`. The CLI passes `traceLevel` verbatim from Commander; tm-core derives streaming, sandbox-conflict, callback-gating, and trace-file allocation from the single level value.

**Rationale:** Per CLAUDE.md, the CLI is a thin presentation layer and `@tm/core` owns business logic. Today the rule is split between `effectiveVerbose` in `loop.command.ts` and `streaming` in `loop.service.ts`. With a single source of truth (`traceLevel`), the CLI no longer needs `effectiveVerbose` — it just passes `options.tracelevel as LoopTraceLevel` through to `Partial<LoopConfig>`. The `createOutputCallbacks` helper in the CLI is rewritten to accept `level: LoopTraceLevel` and apply the same `atLeast()` helper internally (or accept pre-derived booleans built from `atLeast()` — implementation detail for the plan stage).

## Concrete shape summary

**Public TS type (`packages/tm-core/src/modules/loop/types.ts`):**

```typescript
export type LoopTraceLevel = 'none' | 'verbose' | 'trace';

export interface LoopConfig {
  // ... existing fields ...
  traceLevel?: LoopTraceLevel;
  // verbose, trace REMOVED
}
```

**CLI option declaration (`apps/cli/src/commands/loop.command.ts`):**

```typescript
.option(
  '--tracelevel <level>',
  'Loop verbosity: none, verbose, or trace (trace includes verbose output and writes details to the progress file)',
  'none'
)
.choices(['none', 'verbose', 'trace'])
// -v, --verbose REMOVED
// --trace REMOVED
```

**CLI option type (`apps/cli/src/commands/loop.command.ts`):**

```typescript
export interface LoopCommandOptions {
  // ... existing fields ...
  tracelevel?: LoopTraceLevel;
  // verbose, trace REMOVED
}
```

**Service gate rewrites (`packages/tm-core/src/modules/loop/services/loop.service.ts`):**

| Today | After |
|---|---|
| `const streaming = !!(config.verbose \|\| config.trace);` | `const streaming = atLeast(level, 'verbose');` |
| `if (streaming && config.sandbox)` | `if (atLeast(level, 'verbose') && config.sandbox)` |
| `if (config.trace)` (onPromptSent) | `if (atLeast(level, 'trace'))` |
| `if (trace && callbacks?.onIterationSummary)` | `if (atLeast(level, 'trace') && callbacks?.onIterationSummary)` |
| `if (trace)` (token snapshot, stream event gates, etc.) | `if (atLeast(level, 'trace'))` |
| `trace && progressFile ? [] : undefined` | `atLeast(level, 'trace') && progressFile ? [] : undefined` |

Where `level` is `config.traceLevel ?? 'none'`, normalized once at the top of `run()`.

## Out of Scope

- **Runtime behavior changes.** The mapping `'none' → today's (false, false)`, `'verbose' → today's (true, false)`, `'trace' → today's (true, true) === (false, true)` is exhaustive and identical to current behavior. No iteration, callback, streaming, sandbox, or progress-file behavior changes.
- **`docs/configuration.md` `verbose` field.** Open question from research — likely an unrelated general config knob, not part of the loop's CLI surface. The implementation plan will verify in 30 seconds and skip if unrelated.
- **`scripts/modules/config-manager.js:441` `verbose: z.boolean()`.** General-purpose config schema unrelated to loop, per Research Area 7.
- **Claude CLI subprocess `--verbose` flag** (`loop.service.ts:917-918`). This is the spawned Claude CLI's own flag, not the loop's user-facing flag. It stays as `--verbose` regardless.
- **Historical changeset files** (`.changeset/loop-trace-level.md`, etc.). These describe past work and remain unchanged. A new changeset describes the rename.
- **MCP tooling for loop.** No MCP loop tool exists today, and this refactor does not introduce one.
- **Adding more trace levels (e.g. `'debug'`).** The `atLeast()` helper is designed to make this trivial in the future, but no additional levels are part of this refactor.
- **Case-insensitive option values.** Commander's `.choices()` is case-sensitive; no existing enum option in the codebase accepts case variations. `--tracelevel TRACE` will produce a hard error, matching every other enum option's behavior.

## Open Questions

None. All design axes are resolved.
