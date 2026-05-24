/**
 * tools/parsePRD.js
 * Tool to parse PRD document and generate tasks
 */

import fs from 'fs';
import path from 'path';
import {
	checkProgressCapability,
	createErrorResponse,
	handleApiResult,
	withNormalizedProjectRoot
} from '@tm/mcp';
import { z } from 'zod';
import { resolveTag } from '../../../scripts/modules/utils.js';
import {
	PRD_FILE,
	TASKMASTER_DOCS_DIR,
	TASKMASTER_TASKS_FILE
} from '../../../src/constants/paths.js';
import { resolveComplexityReportOutputPath } from '../../../src/utils/path-utils.js';
import {
	analyzeTaskComplexityDirect,
	parsePRDDirect
} from '../core/task-master-core.js';

/**
 * Resolve the output tasks.json path the same way parsePRDDirect does, so we
 * can read the pre-existing task list before parse-prd runs (needed to scope
 * auto-analyze to newly-added tasks in append mode).
 */
function resolveTasksOutputPath(args) {
	if (args.output) {
		return path.isAbsolute(args.output)
			? args.output
			: path.resolve(args.projectRoot, args.output);
	}
	return path.resolve(args.projectRoot, TASKMASTER_TASKS_FILE);
}

function getMaxTaskIdForTag(tasksPath, tag) {
	if (!fs.existsSync(tasksPath)) return 0;
	try {
		const data = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
		const tasks = data?.[tag]?.tasks || [];
		let max = 0;
		for (const t of tasks) {
			if (typeof t.id === 'number' && t.id > max) max = t.id;
		}
		return max;
	} catch (_) {
		return 0;
	}
}

/**
 * Register the parse_prd tool
 * @param {Object} server - FastMCP server instance
 */
export function registerParsePRDTool(server) {
	server.addTool({
		name: 'parse_prd',
		description: `Parse a Product Requirements Document (PRD) text file to automatically generate initial tasks. Reinitializing the project is not necessary to run this tool. It is recommended to run parse-prd after initializing the project and creating/importing a prd.txt file in the project root's ${TASKMASTER_DOCS_DIR} directory.`,

		parameters: z.object({
			input: z
				.string()
				.optional()
				.default(PRD_FILE)
				.describe('Absolute path to the PRD document file (.txt, .md, etc.)'),
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
			numTasks: z
				.string()
				.optional()
				.describe(
					'Approximate number of top-level tasks to generate (default: 10). As the agent, if you have enough information, ensure to enter a number of tasks that would logically scale with project complexity. Setting to 0 will allow Taskmaster to determine the appropriate number of tasks based on the complexity of the PRD. Avoid entering numbers above 50 due to context window limitations.'
				),
			force: z
				.boolean()
				.optional()
				.default(false)
				.describe('Overwrite existing output file without prompting.'),
			research: z
				.boolean()
				.optional()
				.describe(
					'Enable Taskmaster to use the research role for potentially more informed task generation. Requires appropriate API key.'
				),
			append: z
				.boolean()
				.optional()
				.describe('Append generated tasks to existing file.'),
			analyzeComplexity: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'After generating tasks, run complexity analysis on them and include a summary in the response. Inherits research mode from parse-prd.'
				),
			complexityThreshold: z.coerce
				.number()
				.int()
				.min(1)
				.max(10)
				.optional()
				.default(5)
				.describe(
					'Complexity score threshold (1-10) to recommend expansion. Only used when analyzeComplexity is true.'
				),
			tracelevel: z
				.enum(['none', 'verbose', 'trace'])
				.optional()
				.default('none')
				.describe(
					'Trace verbosity: none | verbose (dump LLM response) | trace (also dump prompt)'
				)
		}),
		annotations: {
			title: 'Parse PRD',
			destructiveHint: true
		},
		execute: withNormalizedProjectRoot(
			async (args, { log, session, reportProgress }) => {
				try {
					const resolvedTag = resolveTag({
						projectRoot: args.projectRoot,
						tag: args.tag
					});
					const progressCapability = checkProgressCapability(
						reportProgress,
						log
					);

					// Capture the pre-existing max task ID so we can scope auto-analyze
					// to the newly-added tasks when running in append mode.
					let prevMaxId = 0;
					if (args.analyzeComplexity && args.append) {
						const tasksOutputPath = resolveTasksOutputPath({
							...args,
							projectRoot: args.projectRoot
						});
						prevMaxId = getMaxTaskIdForTag(tasksOutputPath, resolvedTag);
					}

					const result = await parsePRDDirect(
						{
							...args,
							tag: resolvedTag
						},
						log,
						{ session, reportProgress: progressCapability }
					);

					if (args.analyzeComplexity && result?.success) {
						try {
							const tasksJsonPath = result.data.outputPath;
							const reportOutputPath = resolveComplexityReportOutputPath(
								undefined,
								{ projectRoot: args.projectRoot, tag: resolvedTag },
								log
							);

							// Ensure the report directory exists.
							const reportDir = path.dirname(reportOutputPath);
							if (!fs.existsSync(reportDir)) {
								fs.mkdirSync(reportDir, { recursive: true });
							}

							const analyzeArgs = {
								tasksJsonPath,
								outputPath: reportOutputPath,
								threshold: args.complexityThreshold,
								research: args.research === true,
								projectRoot: args.projectRoot,
								tag: resolvedTag
							};
							if (args.append && prevMaxId > 0) {
								analyzeArgs.from = prevMaxId + 1;
							}

							const analyzeResult = await analyzeTaskComplexityDirect(
								analyzeArgs,
								log,
								{ session }
							);

							if (analyzeResult?.success) {
								result.data.complexityAnalysis = {
									reportPath: analyzeResult.data.reportPath,
									reportSummary: analyzeResult.data.reportSummary
								};
							} else {
								result.data.complexityAnalysisWarning = `Complexity analysis failed: ${analyzeResult?.error?.message || 'unknown error'}. Run analyze_project_complexity to retry.`;
								log.warn(result.data.complexityAnalysisWarning);
							}
						} catch (analyzeError) {
							result.data.complexityAnalysisWarning = `Complexity analysis failed: ${analyzeError.message}. Run analyze_project_complexity to retry.`;
							log.warn(result.data.complexityAnalysisWarning);
						}
					}

					return handleApiResult({
						result,
						log: log,
						errorPrefix: 'Error parsing PRD',
						projectRoot: args.projectRoot,
						tag: resolvedTag
					});
				} catch (error) {
					log.error(`Error in parse_prd: ${error.message}`);
					return createErrorResponse(`Failed to parse PRD: ${error.message}`);
				}
			}
		)
	});
}
