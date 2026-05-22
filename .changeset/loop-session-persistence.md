---
"task-master-ai": minor
---

`task-master loop` now accepts a `--session-persistence <true|false>` flag. The default is `false`, which appends `--no-session-persistence` to every claude invocation so loop iterations do not pollute `claude --resume` history. Pass `--session-persistence true` to opt back in to session persistence. Invalid values (anything other than the literal strings `"true"` or `"false"`) are rejected at parse time. A new MCP `loop` tool exposes the same full parameter surface (prompt, iterations, sleepSeconds, sandbox, traceLevel, includeOutput, sessionPersistence, progressFile, tag) for programmatic control over loop execution. Requires a recent version of `claude` CLI that supports `--no-session-persistence` (available in claude with `--print` support).
