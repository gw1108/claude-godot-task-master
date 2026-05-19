---
"task-master-ai": minor
---

`task-master loop` now reports total elapsed time in the final "Loop Complete" summary so you can see how long a full run took without scrolling for timestamps. When `--verbose` is enabled, the loop also prints ISO timestamps at the start and end of the run for precise wall-clock tracking. The total duration is also recorded in the progress file footer.
