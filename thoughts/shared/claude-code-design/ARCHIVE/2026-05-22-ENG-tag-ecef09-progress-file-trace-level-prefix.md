# Design: Prepend trace-level tag to gated lines in `progress.txt`

## Problem Statement

Every line that `LoopService` writes to the progress file whose emission is gated by `traceLevel >= verbose` should be prefixed with a bracketed tag — `[VERBOSE]` or `[TRACE]` — naming the **minimum** trace level that would cause that line to be emitted. Markdown header lines (`##`, `###`) place the tag *inside* the heading marker (e.g. `## [VERBOSE] Iteration 1`); non-header body lines place the tag at column 0 followed by a single space, preserving the original line's leading whitespace; lines inside fenced code blocks (and their fence-marker lines) pass through untagged; always-on banner / final-summary / `---` separator lines are never tagged. The change must keep the always-on writers (`initProgressFile`, `appendFinalSummary`) untouched and remain contained to `packages/tm-core/src/modules/loop/services/`.

## Research Source

`thoughts/shared/research/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md`

## Design Decisions

### Fence-marker line tagging

**Choice:** Fence-marker lines (` ```text `, ` ```json `, ` ``` `) are left **untagged** along with the fenced body lines they enclose.

**Rationale:** This is a hard structural constraint, not a judgment call. A tagged fence opener such as `[VERBOSE] ```text` is not a valid Markdown code-fence opener and would prevent the body from being rendered as a code block. The research explicitly flagged this as the practical consequence of the rule. Treating the fence-marker line as part of the fenced region (toggle `inFence` on every line whose trim equals `/^```\w*$/`) keeps Markdown rendering valid and matches the question file's intent that "lines inside fenced code blocks pass through untagged."

### Buffer entry typing

**Choice:** Migrate `iterationFileLines: string[]` to `Array<{level: 'verbose' | 'trace', content: string}>`. Each push site supplies its gating level explicitly; the flush-time tagger reads `entry.level` to choose between `[VERBOSE]` and `[TRACE]`.

**Rationale:** The push sites already know their own gating level — push #1 (`## Iteration N`) is verbose-minimum, pushes #2–4 (LLM input, tool input, tool result) are trace-minimum, push #5 (`buildIterationSummaryBlock` output) is verbose-minimum. A typed buffer entry surfaces that knowledge at the type system rather than encoding it in a sentinel substring or splitting it across two parallel buffers. Parallel buffers were rejected because they require re-interleaving at flush to preserve source order (tool input under iteration N must follow `## Iteration N`), which is fragile. The sentinel-prefix alternative (`'__TRACE__' + content`) was rejected because it couples behavior to a magic string and can collide with content that legitimately begins with `__TRACE__`. The typed approach touches all five push sites but is a mechanical wrapping change at each — `push(content)` becomes `push({ level: 'verbose'|'trace', content })`.

### Line splitting and fence tracking

**Choice:** Helpers (`formatJsonBlockForFile`, `buildIterationSummaryBlock`) keep returning a single `string` with embedded `\n`s. The flush-time tagger walks each entry by `content.split('\n')`, classifies each line, and prepends the appropriate tag.

**Rationale:** Refactoring the helpers to return `string[]` would change their signatures and every caller, with no observable benefit — the walker still has to do the same classification, just on pre-split input. Splitting inside the walker keeps the helpers as they are today and concentrates the tagging logic at one site. The walker maintains an `inFence: boolean` flag toggled by fence-marker detection; outside fences it identifies headers via `/^(#{1,6})\s+(.*)$/` and body lines as everything else. Blank lines (from `iterationFileLines.join('\n\n')` after re-joining tagged contents) stay blank.

### Tagging algorithm placement

**Choice:** A new centralised helper — call it `tagEntry(entry: {level, content}): string` — lives next to or inside `loop.service.ts` and is invoked at the single gated flush site (`loop.service.ts:850-856`). The flush becomes: tag every entry, then `'\n' + tagged.join('\n\n') + '\n'`, then `appendFile`. The trailing `'---'` per-iteration separator (`loop.service.ts:848`) stays an always-on entry — represented as a separate entry the tagger short-circuits on, or as a non-tagged literal pushed after the tagger runs.

**Rationale:** The always-on banner (`initProgressFile`) and final summary (`appendFinalSummary`) use entirely separate write paths and never touch `iterationFileLines`. Applying the tagger at the single gated flush site therefore scopes tagging to level-gated content without any opt-out logic at the always-on writers. The `'---'` separator is the one always-on item that currently lives in the gated buffer; it must remain untagged, which the tagger handles by either type-tagging it as `{ level: 'separator', content: '---' }` (the cleanest extension of the typed-entry scheme) or by leaving it out of the buffer entirely and appending it post-tagger. Either is acceptable; the implementation can pick.

### Test strategy

**Choice:** Add positive pinning tests for the five tagged forms; do not add negative (not-tagged) assertions for the always-on writers.

**Rationale:** All existing `loop.service.spec.ts` substring assertions still pass under tagging — the tag is inserted *into* the matched substrings rather than in front of them. So existing coverage doesn't break. Adding positive assertions for the new tagged forms (`## [VERBOSE] Iteration 1`, `### [TRACE] LLM input`, `### [TRACE] Tool: <name> input`, `### [TRACE] Tool: <name> result`, `### [VERBOSE] Iteration N summary`, `[VERBOSE] - Tool calls:`, `[VERBOSE]   - input: 1,234`) pins the new contract so a future regression that drops the tag would fail a test. Negative assertions on the always-on writers (banner, final summary, `---` separators) were skipped because the structural separation between `initProgressFile` / `appendFinalSummary` and the gated `iterationFileLines` buffer makes accidental tagging of those lines impossible without a deliberate refactor — at which point the test would have to be updated anyway.

## Out of Scope

- Tagging anything emitted by `initProgressFile` or `appendFinalSummary` (always-on; banner and final summary stay untagged forever).
- Changing the spelling of the tags. The literals `[VERBOSE]` and `[TRACE]` are fixed by the question file — uppercase, square-bracketed, single space after the closing bracket, no colon.
- Changing the header-vs-body placement rule. The tag goes *inside* the `##` / `###` marker for headers and at column 0 for body lines; that is the question file's contract.
- Changes to the trace-level type system. `LoopTraceLevel`, `atLeast`, and `TRACE_LEVEL_WEIGHTS` are unchanged; the new tagger consumes them.
- Tag colouring or ANSI styling in the file. The progress file is plain text by construction; no chalk imports in the service.
- Tagging at any granularity finer than `verbose` / `trace`. There is no `[NONE]` (those lines aren't gated) and no per-event sub-level.
- Changing what counts as a fence marker. The only fence variants emitted today are ` ```text `, ` ```json `, and ` ``` `; the fence detector matches `/^```\w*$/` after trim and toggles `inFence` accordingly. Adding a new fence shape later is out of scope.
- Migrating the always-on `---` separator (`loop.service.ts:848`) out of the iteration buffer if it is currently easiest to keep it there; either keeping it in the buffer (with a sentinel level) or moving it post-tagger is acceptable.
- Manual visual verification of Markdown nested-list rendering on GitHub / VS Code preview. The research flagged renderer-specific rendering of `[VERBOSE]   - input: …` as a manual check, not a code-derivable property; doing that verification is a follow-up, not part of this change.

## Open Questions

None. All design axes are resolved; implementation can proceed.
