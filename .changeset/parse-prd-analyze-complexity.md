---
"task-master-ai": minor
---

Add `--analyze-complexity` to `task-master parse-prd` (and `analyzeComplexity` to the `parse_prd` MCP tool). When set, complexity analysis runs automatically on the generated tasks. The CLI also renders a 1–10 score histogram plus a Low/Medium/High summary; the MCP tool returns the summary in the response. Use `--complexity-threshold <n>` (or `complexityThreshold`) to override the default expansion threshold of 5. In `--append` mode, only newly-added tasks are analyzed. Research mode is inherited from `-r/--research`; if the analysis step fails, parse-prd still succeeds and prints a warning.
