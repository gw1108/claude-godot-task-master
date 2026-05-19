---
"task-master-ai": minor
---

Extend `task-master loop --trace` with a per-iteration token-usage snapshot — input, output, prompt-cache write/read, and total — sourced from the stream-json `result` event's `usage` field. Helps you see exactly what each iteration cost when tuning loop prompts. Older Claude CLI versions or aborted runs (no usage payload) gracefully skip the snapshot.
