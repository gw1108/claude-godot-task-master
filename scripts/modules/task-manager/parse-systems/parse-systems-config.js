/**
 * Zod schemas for parse-systems AI response
 */
import { z } from 'zod';
import { TASK_PRIORITY_OPTIONS } from '../../../../src/constants/task-priority.js';

// Subtask schema — no priority, no testStrategy; deps are parent-local (1-based)
export const systemsSubtaskSchema = z.object({
	id: z.number(),
	title: z.string().min(1),
	description: z.string().min(1),
	details: z.string(),
	status: z.string(),
	dependencies: z.array(z.number())
});

// Top-level task schema — full task with priority and populated subtasks array
export const systemsSingleTaskSchema = z.object({
	id: z.number(),
	title: z.string().min(1),
	description: z.string().min(1),
	details: z.string(),
	priority: z.enum(TASK_PRIORITY_OPTIONS),
	dependencies: z.array(z.number()),
	status: z.string(),
	subtasks: z.array(systemsSubtaskSchema)
});

// Full AI response schema
export const parseSystemsResponseSchema = z.object({
	tasks: z.array(systemsSingleTaskSchema),
	// Use union for better structured outputs compatibility
	// Models understand "either return this object OR null" more reliably
	metadata: z
		.union([
			z.object({
				projectName: z.string(),
				totalTasks: z.number(),
				sourceFile: z.string(),
				generatedAt: z.string()
			}),
			z.null()
		])
		.default(null)
});
