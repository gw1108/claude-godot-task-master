---
"task-master-ai": patch
---

Remove the per-iteration `SETUP: If task-master command not found...` line from the default loop preset and verify `task-master` is on PATH once before the loop starts. Saves tokens on every iteration and surfaces missing installs immediately with a clear install hint, instead of asking the LLM to install in mid-prompt.
