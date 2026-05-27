/**
 * tools/parse-systems.js
 * Tool to parse a systems design document and generate tasks with subtasks
 */

import {
	checkProgressCapability,
	createErrorResponse,
	handleApiResult,
	withNormalizedProjectRoot
} from '@tm/mcp';
import { z } from 'zod';
import { resolveTag } from '../../../scripts/modules/utils.js';
import {
	SYSTEMS_FILE,
	TASKMASTER_DOCS_DIR,
	TASKMASTER_TASKS_FILE
} from '../../../src/constants/paths.js';
import { parseSystemsDirect } from '../core/task-master-core.js';

/**
 * Register the parse_systems tool
 * @param {Object} server - FastMCP server instance
 */
export function registerParseSystemsTool(server) {
	server.addTool({
		name: 'parse_systems',
		description: `Parse a systems design document (systems.md) to generate tasks — one task per ### section, each with subtasks as thin vertical slices. Place systems.md in ${TASKMASTER_DOCS_DIR} before running. Does not reinitialize the project.`,

		parameters: z.object({
			input: z
				.string()
				.optional()
				.default(SYSTEMS_FILE)
				.describe(
					'Absolute path to the systems design document (.md, .txt, etc.)'
				),
			projectRoot: z
				.string()
				.describe('The directory of the project. Must be an absolute path.'),
			tag: z.string().optional().describe('Tag context to operate on'),
			output: z
				.string()
				.optional()
				.describe(
					`Output path for tasks.json file (default: ${TASKMASTER_TASKS_FILE})`
				),
			force: z
				.boolean()
				.optional()
				.default(false)
				.describe('Overwrite existing tasks without confirmation'),
			research: z
				.boolean()
				.optional()
				.describe('Use research AI role for enhanced analysis'),
			append: z
				.boolean()
				.optional()
				.describe('Append generated tasks to existing tasks.json'),
			tracelevel: z
				.enum(['none', 'verbose', 'trace'])
				.optional()
				.default('none')
				.describe('LLM debug verbosity')
		}),

		annotations: {
			title: 'Parse Systems Document',
			destructiveHint: true
		},

		execute: withNormalizedProjectRoot(
			async (args, { log, session, reportProgress }) => {
				const { projectRoot, tag } = args;
				const errorPrefix = 'Error parsing systems document';

				try {
					const resolvedTag = resolveTag({ projectRoot, tag });
					await checkProgressCapability(reportProgress, log);

					const result = await parseSystemsDirect(
						{ ...args, tag: resolvedTag },
						log,
						{ session, reportProgress }
					);

					return handleApiResult({
						result,
						log,
						errorPrefix,
						projectRoot,
						tag
					});
				} catch (error) {
					return createErrorResponse(
						`${errorPrefix}: ${error.message}`,
						projectRoot
					);
				}
			}
		)
	});
}
