import type { LoopPresetDef, PresetCtx } from '../types.js';

export const DEFAULT_PRESET: LoopPresetDef = {
	initial: (ctx: PresetCtx): string => {
		const taskBlock = ctx.nextTask
			? `NEXT TASK (pre-fetched):\n${JSON.stringify(ctx.nextTask, null, 2)}`
			: `(No pre-fetched task — call mcp__task-master-ai__next_task with { "projectRoot": "${ctx.projectRoot}" } to get the next task, then mcp__task-master-ai__get_task for full details.)`;

		return `TASK: Implement ONE task/subtask from the Taskmaster backlog.

${taskBlock}

PROCESS:
1. Implement following codebase patterns.
2. Write tests alongside implementation.
3. Run type check.
4. Run tests.
5. Call mcp__task-master-ai__set_task_status with { "id": "<task id>", "status": "done", "projectRoot": "${ctx.projectRoot}" } to mark complete.
6. Emit <loop-summary>task <ID>: <one-line description of work done></loop-summary>
7. Append super-concise notes to progress file: task ID, what was done. If there were any mistakes or false assumptions, append them as learnings.

IMPORTANT:
- Complete ONLY ONE task per iteration.
- Keep changes small and focused.
- Do NOT start another task after completing one.
- If all tasks are done, output <loop-complete>ALL_DONE</loop-complete>.
- If blocked, output <loop-blocked>REASON</loop-blocked>.
`;
	},

	continuation: (ctx: PresetCtx): string => {
		const taskBlock = ctx.nextTask
			? `Your next task (pre-fetched):\n${JSON.stringify(ctx.nextTask, null, 2)}`
			: `(No pre-fetched task — call mcp__task-master-ai__next_task with {"projectRoot":"${ctx.projectRoot}"} to get your next task.)`;

		return `Continue working. ${taskBlock}\n\nProceed exactly as before. Emit <loop-summary>task <ID>: <one-line description of work done></loop-summary> when done and <loop-complete>ALL_DONE</loop-complete> when all tasks are finished. If blocked, emit <loop-blocked>REASON</loop-blocked>.`;
	}
};
