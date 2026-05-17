Install dependencies and build all workspaces from the repo root.

Run, in order:

1. `npm install`
2. `npm run turbo:build`

Run both as foreground Bash commands. Stream output so the user sees progress. If either step fails, stop and report the failing command's output — do not attempt fixes unless the user asks.

When both succeed, report a one-line confirmation (e.g. "Build complete — dist/task-master.js and dist/mcp-server.js are up to date") and stop.
