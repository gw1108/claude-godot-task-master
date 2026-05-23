import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config';

/**
 * MCP package Vitest configuration
 * Extends root config with MCP-specific settings
 *
 * Integration tests spawn the CLI and MCP inspector, which are slow on
 * Windows (~9s per node spawn). Bump the timeouts on win32 to keep CI
 * behavior tight on Unix.
 */
const isWindows = process.platform === 'win32';

export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			// MCP-specific test patterns
			include: [
				'tests/**/*.test.ts',
				'tests/**/*.spec.ts',
				'src/**/*.test.ts',
				'src/**/*.spec.ts'
			],
			...(isWindows ? { testTimeout: 120000, hookTimeout: 60000 } : {})
		}
	})
);
