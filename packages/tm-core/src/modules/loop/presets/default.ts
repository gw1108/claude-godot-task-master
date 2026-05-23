import type { LoopPresetDef, PresetCtx } from '../types.js';

/**
 * Default preset for Taskmaster loop — general task completion.
 *
 * Dispatch strategy: every task-master call names the exact MCP tool
 * (mcp__task-master-ai__<tool>) and the full parameter object so the host
 * can route directly without a ToolSearch round-trip. The task-master-ai MCP
 * server presence is verified once before the loop starts via
 * LoopService.checkMcpServerAvailable (see loop.service.ts).
 */
export const DEFAULT_PRESET: LoopPresetDef = {
	initial: (ctx: PresetCtx): string =>
		`TASK: Implement ONE task/subtask from the Taskmaster backlog.

PROCESS:
1. Call mcp__task-master-ai__next_task with { "projectRoot": "${ctx.projectRoot}" } to get the next available task/subtask.
2. Call mcp__task-master-ai__get_task with { "id": "<task id>", "projectRoot": "${ctx.projectRoot}" } to read full task details.
3. Implement following codebase patterns.
4. Write tests alongside implementation.
5. Run type check (e.g., \`npm run typecheck\`, \`tsc --noEmit\`).
6. Run tests (e.g., \`npm test\`, \`npm run test\`).
7. Call mcp__task-master-ai__set_task_status with { "id": "<task id>", "status": "done", "projectRoot": "${ctx.projectRoot}" } to mark complete.
8. Emit <loop-summary>task <ID>: <one-line description of work done></loop-summary>
9. Append super-concise notes to progress file: task ID, what was done. If there were any mistakes or false assumptions, append them as learnings.

IMPORTANT:
- Complete ONLY ONE task per iteration.
- Keep changes small and focused.
- Do NOT start another task after completing one.
- If all tasks are done, output <loop-complete>ALL_DONE</loop-complete>.
- If blocked, output <loop-blocked>REASON</loop-blocked>.
`,
	continuation: (ctx: PresetCtx): string =>
		`Continue working. Use mcp__task-master-ai__next_task with {"projectRoot":"${ctx.projectRoot}"} to get your next task and proceed exactly as before. Emit <loop-summary>task <ID>: <one-line description of work done></loop-summary> when done and <loop-complete>ALL_DONE</loop-complete> when all tasks are finished. If blocked, emit <loop-blocked>REASON</loop-blocked>.`
};
