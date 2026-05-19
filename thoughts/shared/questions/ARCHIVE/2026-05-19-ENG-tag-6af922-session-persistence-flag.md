---
original_question: "Whatever task-master command is used to invoke claude should have an optional --session-persistence setting. When this is set to false we invoke claude with --no-session-persistence. By default, task-master loop should have --session-persistence set to false."
ticket: tag-6af922
---

# Research Question: `--session-persistence` flag across task-master commands that invoke claude

## Refined Question

Add an optional `--session-persistence=<true|false>` flag to **every** task-master command that spawns the `claude` CLI. When the value is `false`, task-master appends `--no-session-persistence` to the claude argv. The default is `false` for **all** affected commands (`loop`, `start`, `clusters start`, and any other path that goes through `ClaudeExecutor`). Expose the same option as a parameter on the corresponding MCP tools.

Research must produce: (a) the complete list of code paths to change, (b) the exact plumbing pattern for both CLI and MCP, (c) verification that `claude --no-session-persistence` is the real CLI flag, and (d) the test/changeset surface needed.

## Research Areas

1. **Inventory of claude-invoking entry points** — Enumerate every code path that spawns `claude` (or `docker sandbox run claude`) from task-master. Confirmed candidates: `LoopService` (`packages/tm-core/src/modules/loop/services/loop.service.ts`), `ClaudeExecutor` (`packages/tm-core/src/modules/execution/executors/claude-executor.ts`), `StartCommand` (`apps/cli/src/commands/start.command.ts`), `ClusterStartCommand` (`apps/cli/src/commands/cluster-start.command.ts`). Confirm there are no other spawn sites and identify the consumers of each.

2. **Flag plumbing — CLI** — Document the pattern by which CLI flags flow into the service layer today (Commander option → `*CommandOptions` interface → core `*Config` → argv builder, e.g., `LoopService.buildCommandArgs`). Specify exactly where the new boolean lands in each command and how the argv builder appends `--no-session-persistence` when false.

3. **Flag plumbing — MCP** — Identify the MCP tool definitions that wrap each affected command and document where a `sessionPersistence` parameter must be added to schemas, validators, and the call into tm-core.

4. **Verification of `--no-session-persistence`** — Confirm via the claude CLI (`claude --help`) and/or upstream docs that `--no-session-persistence` is the actual flag name and that it behaves as expected (no resumable session record, no project-level session pollution). If the real flag has a different name or shape, surface that and propose the mapping.

5. **Default semantics and value parsing** — Specify the value-taking surface: `--session-persistence=<true|false>` (and/or `--session-persistence <true|false>`). Define the Commander option parser, accepted string forms (`true`/`false`, case sensitivity), and how the default (`false`) is wired so that omitting the flag is equivalent to `--session-persistence=false`. Confirm this idiom is consistent with other value-taking booleans in the codebase (e.g., the `--no-output` Commander negation in `loop.command.ts`).

6. **Sandbox interaction** — Define how the flag composes with `--sandbox` (Docker path in `LoopService.buildCommandArgs` builds `['sandbox', 'run', 'claude', '-p', prompt]`). The flag should apply uniformly: `docker sandbox run claude ... --no-session-persistence` when value is false. Verify the sandboxed claude binary accepts the flag.

7. **Verbose / trace interaction** — Confirm the flag is orthogonal to `--verbose` and `--trace`. Both currently mutate `buildCommandArgs`; the new flag must compose cleanly with both.

8. **Tests and changeset** — Locate existing unit tests for argv construction (`packages/tm-core/src/modules/loop/services/loop.service.spec.ts`, `apps/cli/src/commands/loop.command.spec.ts`, `apps/cli/src/commands/cluster-start.command.spec.ts`) and integration tests (`apps/cli/tests/integration/commands/loop.command.test.ts`) so new regression tests land alongside existing patterns. Per `CLAUDE.md`, a changeset entry is required.

## Clarifications Gathered

- **Q1: Scope — should the flag exist on all claude-invoking commands, or only `loop`?**
  **A:** All. (`loop`, `start`, `clusters start`, and any other path through `ClaudeExecutor`.)

- **Q2: For commands other than `loop`, what's the default?**
  **A:** Match loop — default `false` everywhere.

- **Q3: Commander `--no-foo` negation style, or a value-taking `--session-persistence=<bool>` flag?**
  **A:** Value-taking flag.

- **Q4: With `loop` defaulting to false, should help text/surface differ from other commands?**
  **A:** Researcher decides. Recommendation: keep the surface symmetric across commands (same flag name, same value-taking form, same default `false`). Help text reads: `--session-persistence <true|false>  Keep claude session history (default: false)`.

- **Q5: Confirm `claude --no-session-persistence` is the real flag?**
  **A:** Researcher decides. Recommendation: explicitly verify against the installed claude CLI before implementation; if the real flag differs (e.g., `--no-session` or a different mechanism), document it and adjust the argv mapping.

- **Q6: Should the flag also apply in `--sandbox` mode?**
  **A:** Researcher decides. Recommendation: yes — apply uniformly so the user's contract doesn't change based on sandbox mode. Verify the sandboxed claude binary accepts the flag.

- **Q7: Expose via MCP tools too?**
  **A:** Yes, expose.

- **Q8: Interaction with `--verbose` / `--trace`?**
  **A:** Researcher decides. Recommendation: treat as orthogonal — composes cleanly with both since each mutates `buildCommandArgs` independently.

## Edge Cases to Address

- Invalid value passed to `--session-persistence` (e.g., `--session-persistence=yes`, `--session-persistence=1`): must error clearly via Commander's `InvalidArgumentError`, not silently treat as truthy/falsy.
- `--session-persistence` with no value: define behavior (error vs. treat as `true`).
- Sandbox argv ordering: ensure `--no-session-persistence` is inserted in the right position relative to `sandbox run claude -p <prompt>`.
- MCP parameter type — boolean vs. string-or-boolean — must be consistent with how other booleans are declared in tm-core's MCP schemas.
- If the claude CLI does **not** support `--no-session-persistence`, the implementation plan must surface that and either propose an alternative flag or document the gap before code lands.
- Existing tests that assert exact argv (`expect(args).toEqual([...])`) will break if a new arg is appended unconditionally; the default-false case must always emit `--no-session-persistence` and existing tests need updating.

## Files Provided by User

- `.pipeline_state_tag-6af922.json` — pipeline state holding the original question for the tag-6af922 workflow.
