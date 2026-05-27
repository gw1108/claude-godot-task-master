/**
 * parse-systems.js
 * Direct function implementation for parsing systems design documents
 */

import fs from 'fs';
import path from 'path';
import { parseSystems } from '../../../../scripts/modules/task-manager.js';
import {
	disableSilentMode,
	enableSilentMode,
	isSilentMode
} from '../../../../scripts/modules/utils.js';
import { TASKMASTER_TASKS_FILE } from '../../../../src/constants/paths.js';
import { createLogWrapper } from '../../tools/utils.js';
import { resolvePrdPath, resolveProjectPath } from '../utils/path-utils.js';

/**
 * Direct function wrapper for parsing systems design documents and generating tasks.
 *
 * @param {Object} args
 * @param {string} args.input - Absolute or relative path to the systems.md file
 * @param {string} args.output - Optional path to tasks.json output
 * @param {boolean} args.force
 * @param {boolean} args.append
 * @param {boolean} args.research
 * @param {string} args.projectRoot
 * @param {string} args.tag
 * @param {Object} log
 * @param {Object} context
 * @returns {Promise<Object>}
 */
export async function parseSystemsDirect(args, log, context = {}) {
	const { session, reportProgress } = context;
	const {
		input: inputArg,
		output: outputArg,
		force,
		append,
		research,
		projectRoot,
		tag,
		tracelevel
	} = args;

	const logWrapper = createLogWrapper(log);

	if (!projectRoot) {
		logWrapper.error('parseSystemsDirect requires a projectRoot argument.');
		return {
			success: false,
			error: { code: 'MISSING_ARGUMENT', message: 'projectRoot is required.' }
		};
	}

	// Resolve input path (reuses generic path resolver — not PRD-specific)
	let inputPath;
	if (inputArg) {
		try {
			inputPath = resolvePrdPath({ input: inputArg, projectRoot }, session);
		} catch (error) {
			logWrapper.error(`Error resolving systems path: ${error.message}`);
			return {
				success: false,
				error: { code: 'FILE_NOT_FOUND', message: error.message }
			};
		}
	} else {
		logWrapper.error('parseSystemsDirect called without input path');
		return {
			success: false,
			error: { code: 'MISSING_ARGUMENT', message: 'Input path is required' }
		};
	}

	// Resolve output path
	const outputPath = outputArg
		? path.isAbsolute(outputArg)
			? outputArg
			: path.resolve(projectRoot, outputArg)
		: resolveProjectPath(TASKMASTER_TASKS_FILE, args) ||
			path.resolve(projectRoot, TASKMASTER_TASKS_FILE);

	if (!fs.existsSync(inputPath)) {
		const errorMsg = `Systems file not found at resolved path: ${inputPath}`;
		logWrapper.error(errorMsg);
		return {
			success: false,
			error: { code: 'FILE_NOT_FOUND', message: errorMsg }
		};
	}

	const outputDir = path.dirname(outputPath);
	try {
		if (!fs.existsSync(outputDir)) {
			logWrapper.info(`Creating output directory: ${outputDir}`);
			fs.mkdirSync(outputDir, { recursive: true });
		}
	} catch (error) {
		return {
			success: false,
			error: {
				code: 'DIRECTORY_CREATE_FAILED',
				message: `Failed to create output directory ${outputDir}: ${error.message}`
			}
		};
	}

	logWrapper.info(
		`Parsing systems doc. Input: ${inputPath}, Output: ${outputPath}, Force: ${force}, Append: ${append}, Research: ${research}`
	);

	const wasSilent = isSilentMode();
	if (!wasSilent) enableSilentMode();

	try {
		const result = await parseSystems(inputPath, outputPath, {
			session,
			mcpLog: logWrapper,
			projectRoot,
			tag,
			force,
			append,
			research,
			reportProgress,
			traceLevel: tracelevel ?? 'none'
		});

		if (result && result.success) {
			const successMsg = `Successfully parsed systems document and generated tasks in ${result.tasksPath}`;
			logWrapper.success(successMsg);
			return {
				success: true,
				data: {
					message: successMsg,
					outputPath: result.tasksPath,
					telemetryData: result.telemetryData,
					tagInfo: result.tagInfo
				}
			};
		} else {
			logWrapper.error(
				'Core parseSystems function did not return a successful structure.'
			);
			return {
				success: false,
				error: {
					code: 'CORE_FUNCTION_ERROR',
					message:
						result?.message || 'Core function failed to parse systems document.'
				}
			};
		}
	} catch (error) {
		logWrapper.error(`Error executing core parseSystems: ${error.message}`);
		return {
			success: false,
			error: {
				code: 'PARSE_SYSTEMS_CORE_ERROR',
				message: error.message || 'Unknown error parsing systems document'
			}
		};
	} finally {
		if (!wasSilent && isSilentMode()) disableSilentMode();
	}
}
