/**
 * @fileoverview loop MCP tool
 * Run the Task Master loop to autonomously work through tasks
 */

import type { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { ToolContext } from '../../shared/types.js';
import { handleApiResult, withToolContext } from '../../shared/utils.js';

const LoopSchema = z.object({
	projectRoot: z
		.string()
		.describe('Absolute path to the project root directory'),
	iterations: z
		.number()
		.optional()
		.describe('Maximum number of iterations (default: 10)'),
	prompt: z
		.string()
		.optional()
		.describe('Preset name or path to custom prompt file (default: "default")'),
	progressFile: z.string().optional().describe('Path to write progress output'),
	tag: z.string().optional().describe('Only work on tasks with this tag')
});

type LoopArgs = z.infer<typeof LoopSchema>;

/**
 * Register the loop tool with the MCP server
 */
export function registerLoopTool(server: FastMCP) {
	server.addTool({
		name: 'loop',
		description:
			'Run the Task Master loop to autonomously work through tasks, one task per iteration.',
		parameters: LoopSchema,
		execute: withToolContext(
			'loop',
			async (args: LoopArgs, { log, tmCore }: ToolContext) => {
				log.info(`Starting Task Master loop in ${args.projectRoot}`);

				try {
					const result = await tmCore.loop.run({
						iterations: args.iterations,
						prompt: args.prompt,
						progressFile: args.progressFile,
						tag: args.tag,
						callbacks: {
							onError: (message: string, severity?: 'warning' | 'error') => {
								if (severity === 'warning') {
									log.warn(message);
								} else {
									log.error(message);
								}
							},
							onIterationEnd: (iteration) => {
								log.info(
									`Iteration ${iteration.iteration} completed: ${iteration.status}`
								);
							}
						}
					});

					return handleApiResult({
						result: { success: true, data: result },
						log,
						projectRoot: args.projectRoot
					});
				} catch (error: any) {
					log.error(`Error in loop: ${error.message}`);
					return handleApiResult({
						result: {
							success: false,
							error: { message: `Failed to run loop: ${error.message}` }
						},
						log,
						projectRoot: args.projectRoot
					});
				}
			}
		)
	});
}
