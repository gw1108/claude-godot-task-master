import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config';

/**
 * CLI package Vitest configuration
 * Extends root config with CLI-specific settings
 *
 * Integration tests (.test.ts) spawn CLI processes and need more time.
 * On Windows, node startup is ~9s per spawn (vs ~50ms on Linux) due to
 * Defender and CreateProcess overhead, so tests that exec multiple CLI
 * commands need a much larger budget. We bump the timeouts on win32 to
 * keep CI behavior tight on Unix.
 */
const isWindows = process.platform === 'win32';

export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			// CLI-specific test patterns
			include: [
				'tests/**/*.test.ts',
				'tests/**/*.spec.ts',
				'src/**/*.test.ts',
				'src/**/*.spec.ts'
			],
			testTimeout: isWindows ? 120000 : 30000,
			hookTimeout: isWindows ? 60000 : 15000,
			maxWorkers: 4
		}
	})
);
