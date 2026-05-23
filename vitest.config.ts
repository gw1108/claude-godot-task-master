import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration for Task Master monorepo
 * Provides shared defaults for all packages
 * Individual packages can extend this config with package-specific settings
 */
export default defineConfig({
	test: {
		// Enable global test APIs (describe, it, expect, etc.)
		globals: true,

		// Default environment for all packages (Node.js)
		environment: 'node',

		// Common test file patterns
		include: [
			'tests/**/*.test.ts',
			'tests/**/*.spec.ts',
			'src/**/*.test.ts',
			'src/**/*.spec.ts'
		],

		// Common exclusions
		exclude: ['node_modules', 'dist', '.git', '.cache', '**/node_modules/**'],

		// Coverage configuration
		coverage: {
			provider: 'v8',
			enabled: true,
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: [
				'node_modules/',
				'dist/',
				'tests/',
				'**/*.test.ts',
				'**/*.spec.ts',
				'**/*.d.ts',
				'**/mocks/**',
				'**/fixtures/**',
				'**/types/**',
				'vitest.config.ts',
				'src/index.ts'
			],
			// Default thresholds (can be overridden per package)
			thresholds: {
				branches: 25,
				functions: 25,
				lines: 25,
				statements: 25
			}
		},

		// Test execution settings
		testTimeout: 10000,
		clearMocks: true,
		restoreMocks: true,
		mockReset: true,

		// Limit concurrency to prevent resource exhaustion
		maxWorkers: 4
	}
});
