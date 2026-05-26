/**
 * @fileoverview loop MCP tool
 * Run task-master loop iterations via MCP
 */

import type { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { ToolContext } from '../../shared/types.js';
import { handleApiResult, withToolContext } from '../../shared/utils.js';

const LoopSchema = z.object({
	prompt: z
		.string()
		.optional()
		.describe(
			'Loop prompt or preset name. Defaults to "default" (runs the built-in task-master preset).'
		),
	iterations: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Maximum number of loop iterations. Defaults to 10 (or pending task count for the default preset).'
		),
	sleepSeconds: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe('Seconds to wait between iterations. Defaults to 5.'),
	sandbox: z
		.boolean()
		.optional()
		.default(false)
		.describe('Run each iteration inside a docker sandbox. Default: false.'),
	traceLevel: z
		.enum(['none', 'verbose', 'trace'])
		.optional()
		.default('none')
		.describe(
			'Trace verbosity: "none" (default) | "verbose" (streaming output) | "trace" (full tool call detail).'
		),
	includeOutput: z
		.boolean()
		.optional()
		.default(false)
		.describe('Include claude stdout in the loop result. Default: false.'),
	sessionPersistence: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Persist the claude session for each iteration. Default: false (appends --no-session-persistence to each claude call, preventing session history pollution).'
		),
	progressFile: z
		.string()
		.optional()
		.describe(
			'Absolute path to the progress file. Defaults to <projectRoot>/.taskmaster/progress.md.'
		),
	tag: z
		.string()
		.optional()
		.describe(
			'Task tag to scope the loop to. Omit to use the currently active tag.'
		),
	commitWindowMinutes: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Minutes between batched git commits. Default: 20'),
	batchCommit: z
		.boolean()
		.optional()
		.describe(
			'Enable batched git commits. Default: true. Set false to disable.'
		),
	projectRoot: z
		.string()
		.describe('Absolute path to the project root directory.')
});

type LoopArgs = z.infer<typeof LoopSchema>;

/**
 * Register the loop MCP tool with the server
 */
export function registerLoopTool(server: FastMCP) {
	server.addTool({
		name: 'loop',
		description:
			'Run task-master loop: repeatedly invoke claude with a prompt (or the built-in default preset) for up to N iterations, sleeping between each. Use this to drive autonomous task completion without manual intervention.',
		parameters: LoopSchema,
		annotations: {
			title: 'Run Task Master Loop'
		},
		execute: withToolContext(
			'loop',
			async (args: LoopArgs, { log, tmCore }: ToolContext) => {
				const {
					prompt,
					iterations,
					sleepSeconds,
					sandbox,
					traceLevel,
					includeOutput,
					sessionPersistence,
					progressFile,
					tag,
					commitWindowMinutes,
					batchCommit,
					projectRoot
				} = args;

				try {
					log.info(`Starting loop in ${projectRoot}`);

					const result = await tmCore.loop.run({
						prompt,
						iterations,
						sleepSeconds,
						sandbox,
						traceLevel,
						includeOutput,
						sessionPersistence,
						progressFile,
						tag,
						commitWindowMinutes,
						batchCommit
					});

					log.info(
						`Loop finished: ${result.finalStatus}, ${result.tasksCompleted} tasks completed`
					);

					return handleApiResult({
						result: { success: true, data: result },
						log,
						projectRoot
					});
				} catch (error: any) {
					log.error(`Error in loop: ${error.message}`);
					if (error.stack) {
						log.debug(error.stack);
					}
					return handleApiResult({
						result: {
							success: false,
							error: { message: `Loop failed: ${error.message}` }
						},
						log,
						projectRoot
					});
				}
			}
		)
	});
}
