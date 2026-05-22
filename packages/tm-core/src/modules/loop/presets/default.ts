/**
 * Default preset for Taskmaster loop - general task completion
 * Matches the structure of scripts/loop.sh prompt
 *
 * Note: The task-master CLI availability is verified once before the loop
 * starts (see LoopService.checkTaskMasterAvailable). Setup instructions are
 * intentionally not embedded in the prompt to avoid spending tokens on a
 * precondition the LLM cannot act on mid-iteration.
 */
export const DEFAULT_PRESET = `TASK: Implement ONE task/subtask from the Taskmaster backlog.

PROCESS:
1. Get the next available task/subtask. PREFER the CLI:
     task-master next
   then
     task-master show <id>
   If you need MCP responses (structured output, scripted parsing), first load the
   core schemas with ONE batched ToolSearch call - not per-tool:
     ToolSearch select:mcp__task-master-ai__next_task,mcp__task-master-ai__get_task,mcp__task-master-ai__set_task_status,mcp__task-master-ai__get_tasks
   Then call mcp__task-master-ai__next_task / __get_task. Do NOT call MCP tools
   before this batched load - they are deferred and direct calls return
   InputValidationError.
   If the fetched task has subtasks (parent with children, or id like "1.2"),
   load subtask schemas with ONE additional batched ToolSearch BEFORE acting:
     ToolSearch select:mcp__task-master-ai__update_subtask,mcp__task-master-ai__expand_task,mcp__task-master-ai__add_subtask,mcp__task-master-ai__remove_subtask,mcp__task-master-ai__clear_subtasks
2. Read task details with task-master show <id>.
3. Implement following codebase patterns.
4. Write tests alongside implementation.
5. Run type check (e.g., \`npm run typecheck\`, \`tsc --noEmit\`).
6. Run tests (e.g., \`npm test\`, \`npm run test\`).
7. Mark complete: task-master set-status --id=<id> --status=done
8. Commit with message: feat(<scope>): <what was implemented>
9. Append super-concise notes to progress file: task ID, what was done. If there was any mistakes or false assumptions, append them into a learning.

IMPORTANT:
- Complete ONLY ONE task per iteration.
- Keep changes small and focused.
- Do NOT start another task after completing one.
- If all tasks are done, output <loop-complete>ALL_DONE</loop-complete>.
- If blocked, output <loop-blocked>REASON</loop-blocked>.
`;
