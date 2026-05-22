---
researcher: George
original_question: "Prepend a log level to any log in progress.txt if the created log was from a level greater than or equal to verbose. For example, if 'Total Duration: 500ms' is only logged because we are at a trace level of verbose prepend the verbose trace to that log. Work back and forth with me on different options of what that prepend would look like."
ticket: tag-ecef09
---

# Research Question: Prepend trace-level tag to gated lines in `progress.txt`

## Refined Question

For every line the loop service writes to the progress file (configured via `LoopConfig.progressFile`) whose emission is gated by `traceLevel >= verbose` (i.e. would NOT appear at `traceLevel='none'`), prepend a bracketed level tag indicating the **minimum** trace level that would cause that line to be emitted — `[VERBOSE]` or `[TRACE]`.

Concretely:

- Tagging surface is **per-line**, not per-block. Every individual emitted line that is level-gated gets its own bracket prefix.
- The tag is the **minimum gating level**, not the level the loop was actually invoked at. Example: `## Iteration 1` is written whenever `traceLevel >= verbose`, so it is tagged `[VERBOSE]` even when the loop is run with `--tracelevel trace`. `### LLM input` is only written at `traceLevel === trace`, so it is tagged `[TRACE]` regardless.
- For markdown header lines (`##`, `###`, `####`), the bracket goes inside the header text, after the `#…` marker, so markdown rendering of the heading is preserved:
  - `## [VERBOSE] Iteration 1`
  - `### [TRACE] LLM input`
  - `### [VERBOSE] Iteration 1 summary`
- For non-header body lines (list items, plain text, etc.), the bracket goes at the start of the line:
  - `[VERBOSE] - Tool calls:`
  - `[VERBOSE]   - Bash: 3`
- Lines inside fenced code blocks (```` ```text … ```` / ```` ```json … ````) stay **unprefixed**, so code blocks remain valid and renderable.
- Lines that are always written regardless of trace level get **no tag**. This includes:
  - The loop banner emitted by `initProgressFile` (`# Taskmaster Loop Progress`, `# Started: …`, `# Brief: …`, `# Preset: …`, `# Max Iterations: …`, `# Tag: …`).
  - The final summary emitted by `appendFinalSummary` (`# Loop Complete: …`, `- Total iterations`, `- Tasks completed`, `- Final status`, `- Total duration`).
  - Section separators (`---`) and other always-written delimiters.
- The behaviour at `traceLevel='none'` with `progressFile` set is unchanged — no per-iteration content is written today, so there is nothing to tag.

## Research Areas

1. **Exhaustive enumeration of level-gated write sites** — identify every place in `packages/tm-core/src/modules/loop/services/loop.service.ts` that pushes into `iterationFileLines` or calls `appendFile(progressFile, …)`, and classify each line emitted (header markers, list items, code fences, separators, etc.) by minimum gating level (`verbose` vs `trace`).
2. **Always-on vs gated boundary** — confirm which `appendFile` calls / lines are unconditional (banner, final summary, `---` separators) so they can be left untouched, and confirm there are no hybrid lines that are partly gated.
3. **Header-line tag placement** — for markdown headers built like `` `## Iteration ${iterationNum}` `` or `` `### LLM input` ``, design the helper that injects `[VERBOSE]` / `[TRACE]` after the `#…` marker so the resulting heading still parses as a markdown header and the existing tests (`loop.service.spec.ts`) keep passing or are updated in lockstep.
4. **Body-line tag placement** — for non-header lines (list items like `- Tool calls:`, indented `  - Bash: 3`, plain text lines inside `buildIterationSummaryBlock`), design the prepend so indentation is preserved (bracket at column 0, space, then the original line including leading whitespace) and existing markdown structure (nested lists, etc.) still renders.
5. **Code-fence body skip rule** — design the emit logic so that lines between an opening ```` ``` ```` fence and its closing ```` ``` ```` fence are passed through untagged. Cover the existing fenced blocks: the `### LLM input` ```` ```text ```` block, the `### Tool: <name> input` ```` ```json ```` block produced by `formatJsonBlockForFile`, the `### Tool: <name> result` ```` ```json ```` block, and the `- Final result:` ```` ```text ```` block inside `buildIterationSummaryBlock`. Note that `formatJsonBlockForFile` already injects multi-line content including `\n` — splitting on `\n` to apply per-line tagging will encounter the fence lines themselves.
6. **Centralised vs distributed application** — decide whether to introduce one helper (e.g. `tagLines(lines: string[], level: 'verbose' | 'trace'): string[]`) used at the two write sites that flush level-gated content (the per-iteration `appendFile` at the end of `executeVerboseIteration` and any other level-gated push points), or to tag at each `iterationFileLines.push(...)` site individually. Centralised is preferred for maintainability if it can cleanly distinguish header vs body vs fenced-body lines.
7. **Tag spelling & casing** — confirm the exact literal token: `[VERBOSE]` and `[TRACE]` (uppercase, square-bracketed, single token, no colon), matching the picked Option B style. Document the choice so future emit sites don't drift to `[verbose]`, `(verbose)`, etc.
8. **Test coverage** — locate the existing progress-file assertions in `packages/tm-core/src/modules/loop/services/loop.service.spec.ts` (and integration tests in `packages/tm-core/tests/integration/loop/`) that check exact strings written to the progress file, and enumerate which tests will need updates. Identify whether new tests should be added that specifically pin the tagging behaviour (header tag, body tag, code-fence skip, untagged banner/summary).

## Clarifications Gathered

- **Q:** Which format should the prepend take — parenthetical suffix, bracketed token inside the header, per-line bracket prefix, HTML comment sidecar, or short glyph code?
  **A:** Option B — bracketed uppercase token inside the header text (`## [VERBOSE] Iteration 1`, `### [TRACE] LLM input`). For non-header body lines, apply the same bracketed format at the start of the line.

- **Q:** Tagging surface — only the markdown header for each block, or every emitted line including list items and code-fence bodies?
  **A:** Per-line. Every gated line gets its own bracket prefix.

- **Q:** The banner (`# Taskmaster Loop Progress`, `# Started: …`, `# Preset: …`) and final summary (`# Loop Complete: …`, `- Total duration: …`) are always written regardless of trace level. How should they be handled — leave untagged, give them an explicit `[ALWAYS]` tag, or reclassify them as verbose-gated?
  **A:** (a) Leave them untagged. Only verbose-/trace-gated lines get a tag.

- **Q:** Should the level on a line reflect the **minimum** level that gates its emission, or the **actual** `traceLevel` the loop was invoked at?
  **A:** Minimum gating level. `## Iteration 1` is always tagged `[VERBOSE]` (because it appears at verbose+). When the loop is invoked at `--tracelevel trace`, the line is still tagged `[VERBOSE]`, not `[TRACE]`. Inner trace-only lines stay `[TRACE]`.

- **Q:** Lines inside fenced code blocks (```` ```text … ```` / ```` ```json … ````) — should each inner line get a per-line tag too?
  **A:** Unprefixed. Lines between a ```` ``` ```` opener and ```` ``` ```` closer pass through untagged so the fenced block stays valid.

- **Q:** What about the `---` separators between iterations and other always-emitted delimiters?
  **A:** Skip — any line that is logged regardless of trace level (including `---` separators and the always-on `none`-level lines) gets no tag.

- **Q:** With `progressFile` set but `traceLevel='none'`, nothing is written to the progress file today. The tagging scheme has no effect there — is that expected?
  **A:** Yes, expected. The tagging scheme is purely additive on top of the existing verbose/trace write paths.

## Edge Cases to Address

- Fenced-code-block detection must track an opening fence line and a closing fence line so per-line tagging is suppressed for the *body* of the block but the fence markers themselves still receive the tag like any other line (since `` ```text `` and `` ``` `` lines are themselves part of the gated emission). Confirm whether the fence-marker lines should be tagged or left untagged for consistency.
- Multi-line content injected by helpers like `formatJsonBlockForFile` and the `### Iteration N summary` block (built by `buildIterationSummaryBlock`) currently arrives at `appendFile` as a single string containing `\n`s. Tagging requires either splitting these on `\n` before flush, or having each helper return an array of lines instead of a single string. Decide which is cleaner.
- The `### LLM input` header is always followed by a ```` ```text ```` fenced block; the iteration summary's `- Final result:` list item is also followed by a ```` ```text ```` fenced block. The tagging rule must not double-tag the fence opener after a tagged header.
- The `## Iteration N` line is currently pushed unconditionally inside `executeVerboseIteration` whenever a `progressFile` is configured (regardless of whether the iteration produces trace-level content), so it correctly gates at `[VERBOSE]`.
- Token-usage list inside the iteration summary uses two levels of indentation (`  - input: 12,345`). The body-line tagging must preserve the two-space indent so the nested list still renders.
- Empty lines emitted as separators between blocks (`'\n' + iterationFileLines.join('\n\n') + '\n'`) — confirm blank lines stay untagged so the rendered output isn't polluted with `[VERBOSE] ` prefixes on otherwise-empty lines.
- If a future change moves `Total duration` (or any other currently-always-on line) behind a `verbose+` gate, the line should automatically pick up `[VERBOSE]` via the centralised helper rather than requiring a manual edit at the call site.

## Files Provided by User

- _(none — the question references the runtime artifact `progress.txt` produced by the loop service, not a file in the repo)_
