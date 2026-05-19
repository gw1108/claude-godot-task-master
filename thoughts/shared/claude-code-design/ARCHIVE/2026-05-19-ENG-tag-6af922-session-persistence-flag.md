---
topic: "--session-persistence flag for task-master loop (CLI + MCP)"
tags: [design, loop, claude-executor, mcp, session-persistence]
status: ready-for-plan
source_research: thoughts/shared/research/2026-05-19-ENG-tag-6af922-session-persistence-flag.md
---

# Design: `--session-persistence` flag for `task-master loop` (CLI + MCP)

## Problem Statement

`task-master loop` spawns `claude -p <prompt>` repeatedly, and by default every iteration writes a resumable session to disk. This pollutes `claude --resume` history and bloats local session storage. We want an opt-in/out flag that controls whether claude persists its session for each loop iteration, defaulting to NOT persisting (i.e., appending `--no-session-persistence` to the claude argv by default). The same control should be available when invoking the loop over MCP.

## Research Source

`thoughts/shared/research/2026-05-19-ENG-tag-6af922-session-persistence-flag.md`

## Design Decisions

### Scope of commands
**Choice:** `loop` only. Do NOT add the flag to `start`, `clusters start`, or `ClaudeExecutor` in this PR.
**Rationale:** Claude's `--no-session-persistence` flag is documented as "only works with `--print`". Only the loop path passes `-p` today; the other three paths use interactive stdio. Adding the flag to those paths would either be silently inert (confusing) or require flipping them to non-interactive mode (a substantial behavior change well outside a flag-addition PR). Limiting scope to `loop` keeps the change focused and reversible; the other paths can be revisited if/when a broader `--print` migration is in scope.

### CLI flag form
**Choice:** Value-taking flag `--session-persistence <true|false>` with a strict Commander parser that throws `InvalidArgumentError` on any value other than the literal strings `"true"` or `"false"`.
**Rationale:** Default is `false` (no persistence), but users need a way to explicitly opt INTO persistence (`--session-persistence true`) and to be explicit in scripts (`--session-persistence false`). A bare boolean (`--session-persistence` present = true) couldn't express explicit-false; a negation form (`--no-session-persistence`) would invert the documented default. The strict parser rejects ambiguous values like `yes`/`1`/`TRUE` per the research's stated edge case. This introduces a new pattern (no value-taking boolean precedent in the codebase) but it's the only form that matches the requested semantics.

### Default value
**Choice:** `false` (no session persistence). Equivalent to passing `--session-persistence false`.
**Rationale:** Loop iterations are scripted/automated work; littering resumable session history with one entry per iteration is rarely desirable. Users who specifically want to resume a loop iteration with `claude --resume` can pass `--session-persistence true` explicitly. The CLI normalizes via `options.sessionPersistence ?? false`; the `LoopDomain.buildConfig` layer applies the same `?? false` as a safety net (mirrors existing `sandbox ?? false`, `verbose ?? false` patterns).

### Argv plumbing
**Choice:** In `LoopService.buildCommandArgs(prompt, sandbox, verbose, sessionPersistence)`, append `'--no-session-persistence'` when `sessionPersistence === false` in BOTH the sandbox branch and the non-sandbox branch. Appended after the prompt (claude is position-insensitive for these flags).
**Rationale:** Single source of truth for argv composition; both branches need parity since `--sandbox` is orthogonal to session persistence. When `sessionPersistence === true`, nothing is appended (claude's natural default is to persist).

### Sandbox interaction
**Choice:** Append `--no-session-persistence` unconditionally in the sandbox branch when `sessionPersistence === false`. Document the minimum required claude version in the changeset and `--help` text.
**Rationale:** The sandboxed claude binary version is unverified, but a runtime probe adds preflight latency and complexity for a flag that should be present in any recent claude build. Silently skipping the flag inside sandbox mode would yield inconsistent semantics ("`task-master loop --sandbox` persisted my session even though I asked it not to?"). If a user pins an older sandboxed claude that lacks the flag, they'll get a clear runtime error from claude itself — acceptable in exchange for consistent behavior.

### Verbose / trace / tracelevel interaction
**Choice:** Orthogonal — `sessionPersistence` is appended independently of `verbose`/`trace`/`tracelevel`. No new conflict guards.
**Rationale:** Research confirms `--no-session-persistence` doesn't interact with `--output-format`, `--verbose`, or `--dangerously-skip-permissions`. The tag-79bd39 tracelevel refactor (running in parallel) touches the same `buildCommandArgs` signature; this design adds one more boolean parameter to that builder and the two refactors will be merge-coordinated by signature, not by behavior.

### MCP exposure
**Choice:** Create a new MCP `loop` tool as part of this PR (the tool does not exist today). Mirror the FULL CLI surface: `prompt`, `iterations`, `interval`, `sandbox`, `verbose`, `trace` (or `tracelevel` if tag-79bd39 lands first), `output`, `sessionPersistence`, and any other `LoopCommandOptions` field. Tool ID: `loop`. File: `apps/mcp/src/tools/loop/loop.tool.ts`.
**Rationale:** Mirroring the full CLI surface ensures MCP callers (other agents, IDE integrations) have feature parity with humans on the CLI. The Zod v3 boolean pattern from `apps/mcp/src/tools/autopilot/start.tool.ts` applies: `z.boolean().optional().default(false).describe(...)`. Routing goes through `withToolContext(server, tmCore, ...)` and calls `tmCore.loop.run(partial)` — the same domain entry the CLI uses — so no duplicated logic. Defaults are applied in `LoopDomain.buildConfig`, not the tool schema, to keep one source of truth.

### Test surface
**Choice:** Add (a) unit tests in `loop.service.spec.ts` covering both branches of `buildCommandArgs` × {true, false} × {sandbox, non-sandbox} × {verbose on/off}; (b) CLI parser tests in `loop.command.spec.ts` for default/explicit-true/explicit-false and invalid-value rejection; (c) integration test in `apps/cli/tests/integration/commands/loop.command.test.ts` for the invalid-value exit-code path; (d) MCP tool tests under `apps/mcp/tests/integration/tools/loop.tool.test.ts` mirroring existing tool test patterns.
**Rationale:** Research confirmed existing argv tests use `expect.arrayContaining([...])` and won't break from the additional element. The strict parser is the only new behavior that needs an integration-level test (exit code 1 + error message). The MCP tool is net-new and needs its own happy-path + parameter-pass-through tests.

### Changeset
**Choice:** `minor` bump for `task-master-ai` in `.changeset/`. Prose mentions: new `--session-persistence` flag on `loop`, default `false`, equivalent claude flag appended automatically, new MCP `loop` tool with full parameter surface, minimum claude version note for sandbox compatibility.
**Rationale:** Backward-compatible additive change (new flag, new MCP tool). Matches the `loop-trace-level.md` / `loop-timestamps.md` precedent.

## Out of Scope

- Adding `--session-persistence` to `task-master start`, `task-master clusters start`, or any code path through `ClaudeExecutor`. Those paths don't pass `--print` and the claude flag is a no-op without it.
- Migrating `start`/`clusters start`/`ClaudeExecutor` to non-interactive (`--print`) mode.
- Adding `--print`/`-p` to the `start` or `clusters start` argv.
- Runtime version probing of the sandboxed claude binary.
- Adding MCP wrappers for `start` or `clusters start`.
- Touching the `--no-output` Commander negation pattern.
- Any change to `--verbose`, `--trace`, or the parallel tag-79bd39 `--tracelevel` refactor.
- A UI/help-text deprecation banner warning users that previous loop runs lose `claude --resume` capability (deferred — not a behavior regression, the new default just establishes saner semantics going forward).

## Open Questions

None. All design axes resolved.
