---
"task-master-ai": minor
---

Add a `--trace` flag to `task-master loop` for deep visibility into each iteration. Trace mode keeps everything `--verbose` already shows (streamed text and tool-call names) and additionally prints the full prompt sent to the LLM, the input parameters and result content for each tool call, and a per-iteration tool-call summary (e.g. `Bash: 3, Edit: 1`). Use `--verbose` for routine monitoring and `--trace` when debugging why a loop iteration behaved a particular way. Not compatible with `--sandbox`.
