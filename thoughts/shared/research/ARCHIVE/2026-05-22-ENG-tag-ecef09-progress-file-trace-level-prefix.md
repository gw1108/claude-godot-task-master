---
topic: "Prepend trace-level tag to gated lines in `progress.txt`"
tags: [research, codebase, loop, trace, progress-file, tm-core]
status: complete
source_question: thoughts/shared/questions/2026-05-22-ENG-tag-ecef09-progress-file-trace-level-prefix.md
---

# Research: Prepend trace-level tag to gated lines in `progress.txt`

## Research Question

For every line the loop service writes to the progress file whose emission is gated by `traceLevel >= verbose` (i.e. would NOT appear at `traceLevel='none'`), prepend a bracketed level tag — `[VERBOSE]` or `[TRACE]` — indicating the **minimum** trace level that would cause that line to be emitted. Markdown header lines (`##`, `###`) take the tag inside the heading after the `#…` marker; non-header body lines take the tag at column 0; lines inside fenced code blocks pass through untagged; always-on banner / final-summary / `---` separator lines are not tagged. Find every level-gated write site in `LoopService`, confirm always-on boundary, and identify the structural surfaces (centralised helper, code-fence detection, multi-line helpers) that the implementation must work with.

## Summary

There are exactly two `appendFile(progressFile, …)` write paths inside `LoopService`: an always-on banner via `initProgressFile` (`loop.service.ts:338-360`), an always-on final summary via `appendFinalSummary` (`loop.service.ts:362-384`), and a single level-gated flush at the end of `executeVerboseIteration` (`loop.service.ts:850-856`) that joins a per-iteration `iterationFileLines: string[]` buffer with `'\n\n'` and writes it. All level-gated content flows through that one flush — there is no second gated write path.

The `iterationFileLines` buffer is populated at four push sites:

1. `loop.service.ts:671` — `## Iteration ${iterationNum}` (gated by being inside `executeVerboseIteration`, which is only reached at `atLeast(level, 'verbose')` — so this is the **minimum-verbose** boundary).
2. `loop.service.ts:673-675` — `### LLM input\n\`\`\`text\n${truncatedPrompt}\n\`\`\`` (gated by `atLeast(level, 'trace')`).
3. `loop.service.ts:1016-1019` — `### Tool: ${name} input\n${formatJsonBlockForFile(input)}` (gated by `atLeast(level, 'trace')` inside `handleStreamEvent`).
4. `loop.service.ts:1033-1036` — `### Tool: ${label} result\n${formatJsonBlockForFile(content)}` (gated by `atLeast(level, 'trace')` inside `handleStreamEvent`).
5. `loop.service.ts:841-848` — the iteration-summary block produced by `buildIterationSummaryBlock` (which is itself a multi-line string with markdown header + bullets + nested bullets + fenced `\`\`\`text` block) plus a literal `'---'` push.

Routes 2-4 each push a single string that already contains embedded `\n`. The fence-aware tagger must operate after that string is split on `\n` (or each helper must be refactored to return a `string[]`). The buffer is finally joined with `'\n\n'`, which inserts a blank line between every entry — those blank lines are emitted by the join, not by any explicit push, and must stay blank (not `[VERBOSE] `-prefixed).

`formatJsonBlockForFile` (`loop.service.ts:392-400`) emits exactly `\`\`\`json\n<truncated JSON>\n\`\`\`` — three lines (or more if the JSON itself contains `\n`s, which `JSON.stringify(value, null, 2)` does for any non-trivial object). `buildIterationSummaryBlock` (`loop.service.ts:402-451`) emits a markdown `### Iteration N summary` header, optional `- Tool calls:` list with `  - Name: count` nested rows, optional `- Tokens:` list with `  - input: 1,234` / `  - output: 567` / `  - cache write: N` / `  - cache read: N` / `  - total: N` nested rows, and an optional `- Final result:` row followed by a `\`\`\`text` … `\`\`\`` fenced block containing the truncated final result.

The always-on lines that the tagging rule must leave untouched are:

- The banner block in `initProgressFile`: `# Taskmaster Loop Progress`, `# Started: <iso>`, optional `# Brief: <brief>`, `# Preset: <prompt>`, `# Max Iterations: <N>`, optional `# Tag: <tag>`, the empty line after, the `---`, and the trailing empty line (`loop.service.ts:343-353`).
- The final-summary block in `appendFinalSummary`: leading `---`, `# Loop Complete: <iso>`, `- Total iterations: <N>`, `- Tasks completed: <N>`, `- Final status: <status>`, optional `- Total duration: <ms>ms` (`loop.service.ts:375-381`).
- The per-iteration trailing `'---'` pushed at `loop.service.ts:848` (a separator at the same logical layer as the banner/footer separators).
- The blank lines synthesised by the buffer join (`'\n' + iterationFileLines.join('\n\n') + '\n'` at line 852).

The two write paths use entirely separate writer code, so applying the helper at the single gated flush site automatically scopes tagging to "level-gated only" without any opt-out logic at the always-on sites.

`LoopTraceLevel` and the `atLeast` predicate live in `packages/tm-core/src/modules/loop/services/trace-level.ts` and are the only mechanism the service uses to decide gating. The minimum-gating-level rule maps cleanly onto these: lines pushed only when `atLeast(level, 'trace')` are tagged `[TRACE]`; lines pushed unconditionally inside `executeVerboseIteration` are tagged `[VERBOSE]`.

The progress-file unit tests in `loop.service.spec.ts` use the idiom `expect(fsPromises.appendFile).toHaveBeenCalledWith(path, expect.stringContaining(substring), 'utf-8')` and `mock.calls.find(([, c]) => …)`. Their substrings (`'## Iteration'`, `'## Iteration 1'`, `'\`\`\`json'`, `'Iteration'` + `'summary'`, `'input: 1,234'`) will fail under the proposed tagging scheme because the headers will become `'## [VERBOSE] Iteration'` and `'### [VERBOSE] Iteration 1 summary'`. Each existing assertion's expected substring must be updated in lockstep, or new tests must pin the tagging behaviour.

## Detailed Findings

### 1. Exhaustive enumeration of level-gated write sites

All level-gated content in the progress file flows through a single buffer (`iterationFileLines: string[]`) flushed once per iteration. The buffer is allocated only when `progressFile` is set (`loop.service.ts:666-668`), and `executeVerboseIteration` itself is only reached when `atLeast(level, 'verbose')` (`loop.service.ts:567-580`). Therefore *every* line in the buffer is at minimum `[VERBOSE]`.

Push sites and their gating, in source order:

| # | Site | Pushed string (line-by-line) | Min level | Code-fence body? |
|---|------|-------------------------------|-----------|------------------|
| 1 | `loop.service.ts:671` | `## Iteration ${iterationNum}` | VERBOSE | No |
| 2 | `loop.service.ts:673-675` | `### LLM input` \n ` ```text` \n `<truncated prompt — may contain its own \n>` \n ` ``` ` | TRACE | Header (line 1) + fence opener (line 2) + body (line 3+) + fence closer (last line) |
| 3 | `loop.service.ts:1016-1019` | `### Tool: ${block.name} input` \n `<formatJsonBlockForFile output>` | TRACE | Same shape as #2 with ` ```json` fence |
| 4 | `loop.service.ts:1033-1036` | `### Tool: ${label} result` \n `<formatJsonBlockForFile output>` | TRACE | Same as #3 |
| 5 | `loop.service.ts:841-847` | Output of `buildIterationSummaryBlock(...)` — multi-line string built from `lines.join('\n')` in the helper | VERBOSE for the header, list, token rows; VERBOSE for `- Final result:` row; embedded fenced block lines pass through untagged | Mixed — see Section 4 |
| 6 | `loop.service.ts:848` | Literal `'---'` | Always-on (separator) | No |

`formatJsonBlockForFile` (`loop.service.ts:392-400`) wraps content as:

```
```json
<JSON.stringify(value, null, 2), then truncated at 10_000 chars; may itself contain \n>
```
```

So after the gated push, *one entry in `iterationFileLines` corresponds to multiple file lines*. The buffer is flattened by `iterationFileLines.join('\n\n')` at `loop.service.ts:852`, but the *internal* `\n` separators in each entry are preserved. The fence-aware tagger therefore needs to walk lines after a final `\n`-split of the joined buffer, not after a `\n\n`-split.

### 2. Always-on vs gated boundary

**Always-on writes:**

- `initProgressFile` (`loop.service.ts:338-360`) — single `appendFile` of `'\n' + lines.join('\n') + '\n'`, where `lines` is:
  ```
  '# Taskmaster Loop Progress',
  `# Started: ${startedAt.toISOString()}`,
  ...(config.brief ? [`# Brief: ${config.brief}`] : []),
  `# Preset: ${config.prompt}`,
  `# Max Iterations: ${config.iterations}`,
  ...(config.tag ? [`# Tag: ${config.tag}`] : []),
  '',
  '---',
  ''
  ```
- `appendFinalSummary` (`loop.service.ts:362-384`) — single `appendFile` of a template literal containing:
  ```
  ---
  # Loop Complete: <finishedAt>
  - Total iterations: <N>
  - Tasks completed: <N>
  - Final status: <status>
  - Total duration: <ms>ms       (conditional on result.totalDuration being numeric)
  ```
- The per-iteration trailing `'---'` separator at `loop.service.ts:848`.
- Blank lines inserted by `iterationFileLines.join('\n\n')` at `loop.service.ts:852`.

**Hybrid lines** — none. Every push site that contributes to `iterationFileLines` is either inside `executeVerboseIteration` (which itself is verbose-gated) or inside `handleStreamEvent` under an `atLeast(level, 'trace')` guard. There is no push site that contributes "partly gated" content. The banner and final summary are written through entirely separate code paths (`initProgressFile`, `appendFinalSummary`) that never touch `iterationFileLines`.

This separation means that applying the tagging logic at the single flush site (line 850) automatically scopes tagging to level-gated content without any explicit opt-out at the always-on writers.

### 3. Header-line tag placement

Header markers produced by the service are all standard ATX-style markdown headers: `## ` (H2) for iteration markers and `### ` (H3) for sub-sections. None of the push sites emit a header without a trailing space-and-text. Header lines observed:

- `## Iteration ${iterationNum}` — minimum `[VERBOSE]`
- `### LLM input` — minimum `[TRACE]`
- `### Tool: ${block.name} input` — minimum `[TRACE]`
- `### Tool: ${label} result` — minimum `[TRACE]`
- `### Iteration ${iterationNum} summary` — minimum `[VERBOSE]` (inside `buildIterationSummaryBlock`, `loop.service.ts:416`)

A regex of the form `/^(#{1,6})\s+(.*)$/` partitions these into the prefix marker (`##` / `###`) and the visible heading text. Injecting the tag after the marker yields:

- `## [VERBOSE] Iteration 1`
- `### [TRACE] LLM input`
- `### [TRACE] Tool: Bash input`
- `### [TRACE] Tool: Read result`
- `### [VERBOSE] Iteration 1 summary`

Each result remains a valid ATX H2/H3 (a single space after the `#…` marker, no leading whitespace, no trailing `#`) and so still renders as a markdown heading. None of the heading texts in the codebase start with characters that would conflict with bracket-prefixing (no existing `[…]` inside heading text).

The five header texts above are the **complete** set produced by the service today.

### 4. Body-line tag placement

Non-header content lines emitted by the service include:

- Inside `buildIterationSummaryBlock` (`loop.service.ts:402-451`):
  - `'- Tool calls:'` (left-flush bullet)
  - `'  - ${tc.name}: ${tc.count}'` (2-space-indented nested bullet)
  - `'- Tokens:'` (left-flush bullet)
  - `'  - input: ${u.inputTokens.toLocaleString()}'`, `'  - output: …'`, `'  - cache write: …'`, `'  - cache read: …'`, `'  - total: …'` (2-space-indented nested bullets)
  - `'- Final result:'` (left-flush bullet)
- The per-iteration trailing separator `'---'` (`loop.service.ts:848`) — already classified as always-on.
- The blank lines between entries produced by the buffer's `.join('\n\n')` — synthesised by the join, not by any push.

Putting the bracket at column 0 followed by a single space, then the original line *including* its leading whitespace, preserves indentation:

- `[VERBOSE] - Tool calls:`
- `[VERBOSE]   - Bash: 3`
- `[VERBOSE] - Tokens:`
- `[VERBOSE]   - input: 12,345`
- `[VERBOSE] - Final result:`

Markdown nested-list rendering depends on the *visual* indentation of the bullet relative to the parent. Most renderers parse `[VERBOSE]   - input: …` as a continuation of the surrounding tagged block — i.e. nesting is determined by columns 10+ (after the tag + space), which still shows `  - ` as a 2-space-indented sub-bullet. Whether common renderers (GitHub, VS Code preview) treat the tag as part of the leading text of a list item rather than a list-item marker should be verified during implementation. (Confirmed safe for headings; lists are more renderer-sensitive.)

### 5. Code-fence body skip rule

The service emits exactly two fenced-block opener variants today:

- ` ```text ` (line 674 inside the gated `### LLM input` push; line 445 inside `buildIterationSummaryBlock` for `- Final result:`).
- ` ```json ` (line 399 inside `formatJsonBlockForFile`, used by both tool input and tool result pushes).

Closing fences are always a bare ` ``` `. After the buffer is joined with `'\n\n'` and then split on `'\n'`, fence detection on each line reduces to:

- Open: line trimmed equals ` ```text ` or ` ```json ` (or generally `/^```(\w*)$/`).
- Close: line trimmed equals ` ``` `.

The body lines *between* an opener and its closer pass through untagged. The fence-marker lines themselves are emitted as part of the gated push (e.g. ` ```text ` is on the same logical line as the `### LLM input` header in entry #2, but after `\n`-splitting they are distinct lines). The question file explicitly flags this as an edge case ("Confirm whether the fence-marker lines should be tagged or left untagged for consistency") — the codebase neither implies nor enforces a choice. Per the question's stated decision the fence-marker lines stay **inside the gated emission**, so they would normally be tagged like other body lines; the implementation must decide whether to tag them or leave them untagged.

Existing fenced blocks in the buffer, after `\n`-split:

| Entry | Lines |
|-------|-------|
| `### LLM input` push | `### LLM input` (header) → ` ```text ` (fence open) → `<prompt body, possibly multi-line>` → ` ``` ` (fence close) |
| `### Tool: X input` push | `### Tool: X input` (header) → ` ```json ` (fence open) → `<pretty JSON body, multi-line>` → ` ``` ` (fence close) |
| `### Tool: X result` push | Same shape as tool input |
| `buildIterationSummaryBlock` output | `### Iteration N summary` (header) → `- Tool calls:` → `  - …` → `- Tokens:` → `  - …` → `- Final result:` → ` ```text ` (fence open) → `<final result body>` → ` ``` ` (fence close) |

`JSON.stringify(value, null, 2)` is the only path that produces multi-line JSON bodies; for simple scalar inputs (`"x"`, `42`, `null`) the body is a single line. Either way the fence-aware walker needs an `inFence: boolean` flag toggled on every fence-marker line.

The `truncateForFile` helper (`loop.service.ts:386-390`) appends a sentinel `… [truncated, N more chars]` to the truncated payload; this sentinel ends up *inside* the fenced block (no trailing newline added), so it requires no special handling — it is a normal body line.

### 6. Centralised vs distributed application

There are exactly two places where a centralised helper could attach:

- **Per-push (distributed):** prepend the tag at each `iterationFileLines.push(…)` call. There are five push sites (1, 2, 3, 4, 5/6 from Section 1). This requires each call site to know its own gating level, to split its multi-line string, to track fence state across siblings (the trailing fence in entry 2 is in the same push as the header in entry 2), and to leave the trailing `'---'` push untagged. The push sites are already in three different functions (`executeVerboseIteration`, `handleStreamEvent` assistant branch, `handleStreamEvent` user branch, `buildIterationSummaryBlock`), so the gating-level decision would have to be threaded through each.

- **Centralised at flush (single point):** wrap the `'\n' + iterationFileLines.join('\n\n') + '\n'` payload at `loop.service.ts:852` with a function that walks the lines, classifies each as header / body / fence-open / fence-body / fence-close / blank / separator, and prepends the appropriate tag. This requires the helper to know *which* lines are `[VERBOSE]` vs `[TRACE]`. Two ways to convey that:
  - Tag the entries at push time with a sentinel (e.g. push `'__TRACE__### LLM input\n…'`) that the flush walker strips after using to choose between `[TRACE]` and `[VERBOSE]`.
  - Maintain two parallel buffers (`verboseLines: string[]`, `traceLines: string[]`) and interleave them at flush. Awkward because the push order matters (the tool input under iteration N must follow `## Iteration N`).
  - Make `iterationFileLines` a `Array<{level: 'verbose' | 'trace', content: string}>` and have the flush walker know each entry's gating.

The third sub-option (typed buffer entries) is the cleanest centralisation surface. It moves the gating-level decision to the push site (which already knows it — push #1 is verbose, pushes #2-4 are trace, push #5 is verbose with embedded fenced-block-body skip) but keeps the line-walking / fence-detection / header-vs-body classification in a single place. It also leaves the always-on writers (`initProgressFile`, `appendFinalSummary`) untouched.

The question file expresses a preference for centralisation if it can cleanly distinguish header / body / fenced-body lines. The typed-buffer-entry approach satisfies that.

### 7. Tag spelling & casing

The question file fixes the spelling: `[VERBOSE]` and `[TRACE]` — uppercase, square-bracketed, no colon, no trailing whitespace inside the brackets. No prior progress-file tagging convention exists in the codebase; the only nearby precedents for bracketed prefixes are:

- `'[Loop Start]'`, `'[Loop End]'` — historical CLI console output, not file content (mentioned in archived research).
- `'[Loop Warning]'`, `'[Loop Error]'` — historical CLI console output for `onError`.
- `'[Iteration N] '` — historical CLI `onStderr` prefix.
- The `LoopTraceLevel` string-literal type uses lowercase: `'none' | 'verbose' | 'trace'` (`types.ts:108`).

No existing file content uses `[VERBOSE]` / `[TRACE]` literals today. The chosen casing is intentionally different from the type literals (uppercase, bracketed) to make the tag visually distinct from inline references to the level value.

### 8. Test coverage

Progress-file assertions in `packages/tm-core/src/modules/loop/services/loop.service.spec.ts`:

- **`progress file operations`** group (lines 776-828):
  - `expect(fsPromises.appendFile).toHaveBeenCalledWith('/test/progress.txt', expect.stringContaining('# Taskmaster Loop Progress'), 'utf-8')` (line 798-802) — banner; **unaffected** by tagging (always-on).
  - `expect(fsPromises.appendFile).toHaveBeenCalledWith('/test/progress.txt', expect.stringContaining('# Loop Complete'), 'utf-8')` (line 822-826) — final summary; **unaffected**.
- **`trace file persistence`** group (lines 830-1007):
  - Test 1 (lines 858-880): finds `appendFile` call whose content includes `'## Iteration'` and asserts no ANSI. Under tagging the iteration header becomes `'## [VERBOSE] Iteration 1'`; the substring `'## Iteration'` still matches (no break). The ANSI assertion is unrelated.
  - Test 2 (lines 882-916): finds `appendFile` call whose content includes `'```json'` and asserts the body contains `'… [truncated,'`. Code-fence opener lines themselves stay untagged or are tagged at column 0 (per Section 5 the fence-marker line's classification is the open question); the substring `'```json'` still matches whether or not the fence line is prefixed by `[TRACE] `, because the substring is a *substring*, not an anchored match.
  - Test 3 (lines 918-948): finds call containing both `'Iteration'` and `'summary'` and asserts substrings `'input: 1,234'`, `'output: 567'`, `'total: 1,801'`. Token rows under tagging would be `'[VERBOSE]   - input: 1,234'` etc.; `'input: 1,234'` is still a substring of the new line. The `'Iteration'` + `'summary'` substring find still works.
  - Test 4 (lines 950-996): asserts exactly **one** `appendFile` call contains `'## Iteration 1'`. Under tagging the iteration header becomes `'## [VERBOSE] Iteration 1'`, which still contains `'## Iteration 1'` as a substring. Pass.
  - Test 5 (lines 998-1006): pure `truncateForFile` unit test, file-content-independent. **Unaffected.**

**Result:** all existing trace-file persistence assertions use **substring matching** that happens to remain satisfied under the proposed tagging because the tag is *inserted into* the matched substrings rather than *replacing* them. The existing test suite does not lock the absence of `[VERBOSE]` / `[TRACE]` prefixes — it only confirms presence of certain substrings, which the tagged versions still contain.

The integration tests under `packages/tm-core/tests/integration/loop/` do not write or read any progress file: `loop-domain.test.ts` covers preset resolution and lifecycle but does not exercise the loop's file write path; `loop-core-exports.test.ts` and `loop-preset-accessibility.test.ts` are static export checks; `loop-tmcore-access.test.ts` exercises the `.taskmaster/tasks/tasks.json` setup, not the progress file. No integration test currently asserts progress-file content.

**Pinning new behaviour** would require new test cases that anchor on the *exact* tagged text — e.g. `expect(content).toContain('## [VERBOSE] Iteration 1')`, `expect(content).toContain('### [TRACE] LLM input')`, `expect(content).toContain('[VERBOSE] - Tool calls:')`, and (the inverse) `expect(content).not.toContain('[VERBOSE] # Taskmaster Loop Progress')` to pin the always-on/gated boundary.

## Edge Cases Addressed

- **Fence-marker lines (` ```text `, ` ```json `, ` ``` `) — tagged or not?** The codebase does not impose an answer; fence-marker lines are pushed *as part of* the gated entry that also carries the header (in entries 2-4) or as part of the iteration-summary block (in entry 5). They are level-gated by construction. The implementation must pick a rule and apply it consistently in the centralised walker. Either rule keeps markdown rendering valid because the bracket prefix does not start with a backtick and so does not break fence parsing — but a tagged fence opener (`[VERBOSE] ```text`) is not a valid code-fence opener and would *prevent* the body from being rendered as a code block. **Practical consequence: fence-marker lines must be left untagged for code-fence rendering to survive.**
- **Multi-line strings injected by `formatJsonBlockForFile` and `buildIterationSummaryBlock`.** Each push appends a single string with embedded `\n` to `iterationFileLines`, then `.join('\n\n')` glues entries with double newlines and `appendFile` writes the final blob. The fence walker must split on `\n` (not `\n\n`) to see every individual line. Refactoring either helper to return `string[]` is feasible but not required if the centralised walker splits at flush time.
- **Double-tagging risk after a tagged header.** The `### LLM input\n\`\`\`text\n…\n\`\`\`` entry contains both a header line and a fence opener as separate lines after `\n`-split. The header line gets the tag inside the marker; the fence-opener line (per the previous bullet) stays untagged. There is no second header inside the fenced body, so no double-tag arises.
- **`## Iteration N` always pushed in `executeVerboseIteration`.** Verified at `loop.service.ts:670-671`: the push happens unconditionally inside the `if (iterationFileLines)` block, which is itself inside `executeVerboseIteration`, which is only reached at `atLeast(level, 'verbose')`. So `## Iteration N` is correctly classified as VERBOSE-minimum.
- **Two-space indentation on nested token rows.** `buildIterationSummaryBlock` (`loop.service.ts:428-440`) emits literal `  - input: …`, `  - output: …`, etc. with two leading spaces. Putting the `[VERBOSE] ` prefix at column 0 followed by the original line preserves the two-space indent as columns 11-12, which keeps the line a valid Markdown sub-list item *relative to the tag-prefix layout* — see Section 4 for the renderer caveat.
- **Blank lines from `join('\n\n')`.** The buffer's separator-newline pattern produces empty strings when the final string is split on `\n`. The walker must treat empty lines as "no tag" so the rendered file does not gain spurious `[VERBOSE] ` lines on blank rows.
- **Auto-pickup if a future change re-gates an always-on line.** Today `appendFinalSummary` writes `- Total duration: <N>ms` via a different code path that never touches `iterationFileLines`. Moving that line behind a verbose gate would require it to be pushed into the iteration buffer (or a new gated buffer that flows through the centralised walker). If the implementation lands the helper as `tagLines(lines, level)` rather than coupling it to the existing flush site, the new push site can opt in without further wiring.
- **`progressFile` set with `traceLevel='none'`.** `executeVerboseIteration` is not reached at this level (the silent `spawnSync` path is taken at `loop.service.ts:582-624`), `iterationFileLines` is not allocated, no gated content is written. The banner and final summary still write through their always-on paths and remain untagged. Tagging therefore has no observable effect at `none` — matching the question file's expectation.

## Code References

### Service-side write paths
- `packages/tm-core/src/modules/loop/services/loop.service.ts:6` — imports `appendFile, mkdir, readFile`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:193` — `await this.initProgressFile(...)` call
- `packages/tm-core/src/modules/loop/services/loop.service.ts:290` — `await this.appendFinalSummary(...)` call inside `finalize`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:338-360` — `initProgressFile` (always-on banner)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:362-384` — `appendFinalSummary` (always-on footer)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:386-390` — `truncateForFile` (10_000-char cap + sentinel)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:392-400` — `formatJsonBlockForFile` (emits ` ```json `...` ``` ` wrapper)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:402-451` — `buildIterationSummaryBlock` (multi-line markdown builder)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:567-580` — `executeVerboseIteration` route, gated by `atLeast(level, 'verbose')`

### Level-gated push sites
- `packages/tm-core/src/modules/loop/services/loop.service.ts:666-668` — `iterationFileLines` allocation (allocated only if `progressFile`; only reached on verbose+)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:670-677` — pushes for `## Iteration N` (VERBOSE) and `### LLM input` (TRACE)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:836-848` — flush block: pushes `buildIterationSummaryBlock(...)` output (VERBOSE) and `'---'` (always-on separator)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:850-856` — `appendFile(progressFile!, '\n' + iterationFileLines.join('\n\n') + '\n', 'utf-8')` (sole gated write)
- `packages/tm-core/src/modules/loop/services/loop.service.ts:1013-1021` — TRACE push for `### Tool: <name> input`
- `packages/tm-core/src/modules/loop/services/loop.service.ts:1028-1038` — TRACE push for `### Tool: <name> result`

### Trace-level types and predicate
- `packages/tm-core/src/modules/loop/services/trace-level.ts:1-15` — `TRACE_LEVEL_WEIGHTS` and `atLeast` predicate
- `packages/tm-core/src/modules/loop/types.ts:108` — `LoopTraceLevel = 'none' | 'verbose' | 'trace'`
- `packages/tm-core/src/modules/loop/types.ts:143` — `traceLevel?: LoopTraceLevel` on `LoopConfig`

### Tests
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:776-828` — banner / final-summary substring assertions (unaffected by tagging)
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:830-1007` — `trace file persistence` group; five tests using `mock.calls.find(([, c]) => c.includes(substring))` patterns — all pass under tagging because the proposed prefixes are inserted *into* matched substrings, not in front of them
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:858-880` — Test 1: `'## Iteration'` substring + ANSI absence
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:882-916` — Test 2: `'```json'` substring + `'… [truncated,'` substring
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:918-948` — Test 3: `'Iteration'` AND `'summary'` substrings + token-row substrings
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:950-996` — Test 4: exactly one `appendFile` call contains `'## Iteration 1'`
- `packages/tm-core/src/modules/loop/services/loop.service.spec.ts:998-1006` — Test 5: pure `truncateForFile` (file-content-independent)

### Domain & defaults
- `packages/tm-core/src/modules/loop/loop-domain.ts:184-200` — `buildConfig` defaulting; `traceLevel` defaults to `'none'`, `progressFile` defaults to `path.join(projectRoot, '.taskmaster', 'progress.txt')`

## Architecture Documentation

**Layering.** `apps/cli` (presentation) → `@tm/core` `LoopDomain` (facade) → `LoopService` (business logic + I/O). The progress-file write contract is entirely owned by `LoopService`; the CLI and MCP layers do not write to the progress file. This means the tagging change is fully confined to `packages/tm-core/src/modules/loop/services/`.

**Single buffer flush model.** Trace-level content is staged in an in-memory `string[]` buffer and flushed in one `appendFile` call per iteration. There is no per-event flush, no write queue, no JSONL append. This makes "tag at flush" structurally easy: the centralised helper runs at one site.

**No chalk in the service.** Every entry pushed into `iterationFileLines` is constructed from string literals, primitive `toString()`s, or `JSON.stringify(...)`. No ANSI escape codes can reach the buffer, so the line walker does not need to skip ANSI when classifying header vs body.

**Markdown idiom.** The progress file is informal markdown — `# H1` for banner / loop-complete, `##` for iteration markers, `###` for sub-sections, `-` bullets with `  - ` nested sub-bullets, ` ```text ` and ` ```json ` fenced blocks for verbatim payloads. The choice to put the bracket *inside* the header marker (rather than outside) preserves all of these idioms.

**Trace-level gating.** `LoopTraceLevel` and `atLeast` (`packages/tm-core/src/modules/loop/services/trace-level.ts`) are the only gating mechanism. Every level-gated push is reachable via an `atLeast(level, 'verbose')` or `atLeast(level, 'trace')` test; there are no other conditions. The proposed `tagLines(lines, level: 'verbose' | 'trace')` signature aligns naturally with this enum.

## Historical Context (from thoughts/shared/)

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — original research that introduced trace-mode file writes. Documents the "plain text by construction" reasoning (chalk lives only in the CLI; the service has zero chalk imports), enumerated the original trace callback emit sites, and proposed the single-flush per-iteration buffer pattern that became `iterationFileLines`. The current code descends directly from option (a) in that document.
- `thoughts/shared/plans/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` — implementation plan that landed the trace-only progress-file content. Established the `## Iteration N` / `### LLM input` / `### Tool: <name> input|result` / `### Iteration N summary` header taxonomy that the tagging change builds on.
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` — refactor that introduced the unified `--tracelevel <none|verbose|trace>` flag, `LoopTraceLevel` type, and `atLeast` predicate. The gating-level vocabulary used in this research (`[VERBOSE]`, `[TRACE]`, "minimum gating level") is grounded in that refactor.
- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md` — research behind the most recent change (Phase 1+) that broadened `iterationFileLines` allocation from trace-only to verbose-or-trace and split the iteration-start push so `## Iteration N` is verbose-minimum and `### LLM input` stays trace-minimum. This is the change that makes today's per-line minimum-gating split possible.
- `thoughts/shared/plans/ARCHIVE/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md` — implementation plan for the same change.

## Related Research

- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-38a2bd-trace-callbacks-progress-file.md` (origin of progress-file trace writes)
- `thoughts/shared/research/ARCHIVE/2026-05-19-ENG-tag-79bd39-loop-tracelevel-option-refactor.md` (`LoopTraceLevel` + `atLeast`)
- `thoughts/shared/research/ARCHIVE/2026-05-22-ENG-tag-ea3aac-trace-silence-console.md` (immediate predecessor — verbose-vs-trace push split)

## Open Questions

- **Fence-marker line tagging.** Should the line carrying ` ```text ` / ` ```json ` / ` ``` ` itself be tagged, or left untagged? Tagging it (`[VERBOSE] ```text`) breaks code-fence parsing and prevents the body from rendering as a code block; leaving it untagged keeps rendering valid but is inconsistent with the "every gated line gets a tag" rule. Implementation must pick one.
- **Helper signature surface.** Whether to refactor `formatJsonBlockForFile` / `buildIterationSummaryBlock` to return `string[]` (so the centralised walker receives pre-split entries), or to keep them returning a single `string` and let the walker `split('\n')` at flush time. Either works; the second is less invasive.
- **Buffer entry typing.** Whether to migrate `iterationFileLines: string[]` to `Array<{level: 'verbose' | 'trace', content: string}>` for compile-time gating clarity, or to use a textual sentinel (e.g. push `'__TRACE__'` + content) and strip it in the walker. The typed approach is cleaner but touches more call sites; the sentinel approach is a one-line patch at each push but couples the prefix to a magic string.
- **Markdown nested-list rendering of `[VERBOSE]   - input: …` under common renderers (GitHub, VS Code).** Whether the column-0 bracket prefix preserves nested-list rendering across the renderers the team cares about is a manual-verification step, not a code-derivable property.
