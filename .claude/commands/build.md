Install dependencies, build all workspaces from the repo root, and make sure the global `task-master` command points at this repo's build.

Run, in order:

1. `npm install`
2. `npm run turbo:build`
3. Verify the global `task-master` resolves to this repo, and `npm link` if it does not.

Run all steps as foreground Bash commands. Stream output so the user sees progress. If steps 1 or 2 fail, stop and report the failing command's output — do not attempt fixes unless the user asks.

### Step 3 — link check

After the build succeeds, compare the version reported by the global `task-master` against this repo's `package.json` version:

```bash
EXPECTED=$(node -p "require('./package.json').version")
ACTUAL=$(task-master --version 2>/dev/null | tail -n1 | tr -d '[:space:]')
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Global task-master is '$ACTUAL', expected '$EXPECTED' — running npm link"
  npm link
else
  echo "Global task-master already points at this repo ($ACTUAL)"
fi
```

If `npm link` runs and fails, stop and report its output. A successful link (or a confirmed match) is fine — proceed to the final message.

### Final message

When all steps succeed, report a one-line confirmation (e.g. "Build complete — dist/task-master.js and dist/mcp-server.js are up to date; global task-master linked to this repo") and stop.
