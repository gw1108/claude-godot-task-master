/**
 * parse-systems.js
 * Entry point for parse-systems: reads a systems.md and generates
 * one task per ### section, each with thin-slice subtasks.
 * Delegates entirely to parsePRDCore via parameterized PrdParseConfig.
 */

import { PrdParseConfig } from '../parse-prd/parse-prd-config.js';
import { parsePRDCore } from '../parse-prd/parse-prd.js';
import { handleNonStreamingService } from '../parse-prd/parse-prd-non-streaming.js';
import { parseSystemsResponseSchema } from './parse-systems-config.js';

/**
 * Parse a systems design document into tasks with subtasks.
 * Mirrors parsePRD's signature but omits numTasks (always 0; one task per section).
 *
 * @param {string} systemsPath - Absolute path to the systems.md file
 * @param {string} tasksPath   - Absolute path to tasks.json output
 * @param {Object} options     - Same options as parsePRD minus numTasks
 * @returns {Promise<Object>}  - { success, tasksPath, telemetryData, tagInfo }
 */
async function parseSystems(systemsPath, tasksPath, options = {}) {
	const config = new PrdParseConfig(systemsPath, tasksPath, 0, {
		...options,
		promptId: 'parse-systems',
		responseSchema: parseSystemsResponseSchema,
		commandName: 'parse-systems'
	});
	// Always non-streaming (ENABLE_STREAMING = false in PrdParseConfig)
	return parsePRDCore(config, handleNonStreamingService, false);
}

export default parseSystems;
