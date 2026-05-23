/**
 * Jest setup file
 *
 * This file is run before each test suite to set up the test environment.
 */

// Defuse a Node 24 + Jest 29 + signal-exit v3 interaction.
//
// signal-exit v3 (pulled in transitively by proper-lockfile / ink etc.)
// adds three own-properties to `process` over its lifecycle:
//   - `__signal_exit_emitter__` (at module-load)
//   - `emit` / `reallyExit` (when `load()` runs, shadowing the prototype methods)
// All three are added as enumerable own-properties, which leaks them into
// `Object.keys(process)`.
//
// Jest's `_importCoreModule` builds a SyntheticModule for the `process`
// core module from `Object.keys(required)` at construction time, then
// later calls `setExport(key, value)` for each `Object.entries(required)`
// at evaluation time.  If signal-exit ran between those two snapshots,
// the second one has extra keys the first did not — and Jest throws
// `Export 'X' is not defined in module`, cascading through anything that
// imports chalk.
//
// Pre-defining each of these as **non-enumerable** keeps them out of
// `Object.keys(process)` entirely.  `=` assignment preserves
// non-enumerable on existing properties, so signal-exit's later mutations
// stay invisible to Object.keys.
for (const key of ['__signal_exit_emitter__', 'emit', 'reallyExit']) {
	const existing = Object.getOwnPropertyDescriptor(process, key);
	// If the property already exists as own, mark it non-enumerable. If it
	// only lives on the prototype (e.g. emit/reallyExit before signal-exit
	// has run), create an own property mirror that is non-enumerable so
	// future signal-exit assignments keep that flag.
	if (existing) {
		if (existing.configurable && existing.enumerable) {
			Object.defineProperty(process, key, {
				...existing,
				enumerable: false
			});
		}
	} else {
		Object.defineProperty(process, key, {
			value: process[key],
			writable: true,
			enumerable: false,
			configurable: true
		});
	}
}

import path from 'path';
import { fileURLToPath } from 'url';

// Capture the actual original working directory before any changes
const originalWorkingDirectory = process.cwd();

// Store original working directory and project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Ensure we're always starting from the project root
if (process.cwd() !== projectRoot) {
	process.chdir(projectRoot);
}

// Mock environment variables
process.env.MODEL = 'sonar-pro';
process.env.MAX_TOKENS = '64000';
process.env.TEMPERATURE = '0.2';
process.env.DEBUG = 'false';
process.env.TASKMASTER_LOG_LEVEL = 'error'; // Set to error to reduce noise in tests
process.env.DEFAULT_SUBTASKS = '5';
process.env.DEFAULT_PRIORITY = 'medium';
process.env.PROJECT_NAME = 'Test Project';
process.env.PROJECT_VERSION = '1.0.0';
// Ensure tests don't make real API calls by setting mock API keys
process.env.ANTHROPIC_API_KEY = 'test-mock-api-key-for-tests';
process.env.PERPLEXITY_API_KEY = 'test-mock-perplexity-key-for-tests';

// Add global test helpers if needed
global.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Store original working directory for tests that need it
global.originalWorkingDirectory = originalWorkingDirectory;
global.projectRoot = projectRoot;

// If needed, silence console during tests
if (process.env.SILENCE_CONSOLE === 'true') {
	global.console = {
		...console,
		log: () => {},
		info: () => {},
		warn: () => {},
		error: () => {}
	};
}

// Clean up signal-exit listeners after all tests to prevent open handle warnings
// This is needed because packages like proper-lockfile register signal handlers
afterAll(async () => {
	// Give any pending async operations time to complete
	await new Promise((resolve) => setImmediate(resolve));

	// Clean up any registered signal handlers from signal-exit
	const listeners = ['SIGINT', 'SIGTERM', 'SIGHUP'];
	for (const signal of listeners) {
		process.removeAllListeners(signal);
	}
});
