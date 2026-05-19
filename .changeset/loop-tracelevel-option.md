---
"task-master-ai": minor
---

`task-master loop` now uses a single `--tracelevel <none|verbose|trace>` option instead of the two separate `--verbose` and `--trace` flags. `--tracelevel verbose` matches the old `--verbose` behavior; `--tracelevel trace` matches the old `--trace` behavior (which also implied verbose streaming). The default is `--tracelevel none`. Invalid values are rejected at parse time with a helpful error listing the allowed choices.
