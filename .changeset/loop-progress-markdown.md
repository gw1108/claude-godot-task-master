---
"task-master-ai": minor
---

`task-master loop` now writes its progress files as Markdown. The default progress file is `.taskmaster/progress.md` (was `progress.txt`), and the per-iteration (`progress.iter-N.md`) and totals (`progress.totals.md`) siblings follow the same extension. The per-iteration files are also more human-readable: each gets a proper `# Iteration N` title with clean `## Prompt sent to Claude`, `### \`tool\` input/result`, and `## Summary` sections, and the noisy per-line `[VERBOSE]`/`[TRACE]` prefixes have been removed in favor of plain Markdown. The main progress file header and the "Loop Complete" footer now render as proper Markdown lists instead of stacked headings.

Pass `--progress-file <path>` to override the default; the git-exclude logic that keeps these generated files out of loop commits now derives from the file's actual extension, so custom extensions work too.
