import { z } from 'zod';

// Schema that matches the inline AiTaskDataSchema from add-task.js
export const AddTaskResponseSchema = z
	.object({
		title: z.string().describe('Clear, concise title for the task'),
		description: z
			.string()
			.describe('A one or two sentence description of the task'),
		details: z
			.string()
			.describe(
				'In-depth implementation details, considerations, and guidance'
			),
		dependencies: z
			.array(z.number())
			.nullable()
			.describe(
				'Array of task IDs that this task depends on (must be completed before this task can start)'
			)
	})
	.strict();
