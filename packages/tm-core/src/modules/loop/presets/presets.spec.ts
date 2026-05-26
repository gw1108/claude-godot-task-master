/**
 * @fileoverview Tests for preset exports and preset content structure
 */

import { describe, it, expect } from 'vitest';
import type { PresetCtx, PrefetchedTask } from '../types.js';
import {
	PRESETS,
	PRESET_NAMES,
	getPreset,
	isPreset,
	DEFAULT_PRESET,
	TEST_COVERAGE_PRESET,
	LINTING_PRESET,
	DUPLICATION_PRESET,
	ENTROPY_PRESET
} from './index.js';

const TEST_CTX: PresetCtx = { projectRoot: '/test/project' };

describe('Preset Exports', () => {
	describe('PRESET_NAMES', () => {
		it('contains all 5 preset names', () => {
			expect(PRESET_NAMES).toHaveLength(5);
		});

		it('includes default preset', () => {
			expect(PRESET_NAMES).toContain('default');
		});

		it('includes test-coverage preset', () => {
			expect(PRESET_NAMES).toContain('test-coverage');
		});

		it('includes linting preset', () => {
			expect(PRESET_NAMES).toContain('linting');
		});

		it('includes duplication preset', () => {
			expect(PRESET_NAMES).toContain('duplication');
		});

		it('includes entropy preset', () => {
			expect(PRESET_NAMES).toContain('entropy');
		});
	});

	describe('PRESETS record', () => {
		it('has entries for all preset names', () => {
			for (const name of PRESET_NAMES) {
				expect(PRESETS[name]).toBeDefined();
				expect(typeof PRESETS[name]).toBe('object');
				expect(typeof PRESETS[name].initial).toBe('function');
				expect(typeof PRESETS[name].continuation).toBe('function');
			}
		});

		it('has non-empty initial content for each preset', () => {
			for (const name of PRESET_NAMES) {
				expect(PRESETS[name].initial(TEST_CTX).length).toBeGreaterThan(0);
			}
		});
	});

	describe('getPreset', () => {
		it('returns initial content for default preset', () => {
			const content = getPreset('default').initial(TEST_CTX);
			expect(content).toBeTruthy();
			expect(typeof content).toBe('string');
			expect(content.length).toBeGreaterThan(0);
		});

		it('returns initial content for test-coverage preset', () => {
			const content = getPreset('test-coverage').initial(TEST_CTX);
			expect(content).toBeTruthy();
			expect(content.length).toBeGreaterThan(0);
		});

		it('returns initial content for linting preset', () => {
			const content = getPreset('linting').initial(TEST_CTX);
			expect(content).toBeTruthy();
			expect(content.length).toBeGreaterThan(0);
		});

		it('returns initial content for duplication preset', () => {
			const content = getPreset('duplication').initial(TEST_CTX);
			expect(content).toBeTruthy();
			expect(content.length).toBeGreaterThan(0);
		});

		it('returns initial content for entropy preset', () => {
			const content = getPreset('entropy').initial(TEST_CTX);
			expect(content).toBeTruthy();
			expect(content.length).toBeGreaterThan(0);
		});

		it('returns same object as PRESETS record', () => {
			for (const name of PRESET_NAMES) {
				expect(getPreset(name)).toBe(PRESETS[name]);
			}
		});
	});

	describe('isPreset', () => {
		it('returns true for valid preset names', () => {
			expect(isPreset('default')).toBe(true);
			expect(isPreset('test-coverage')).toBe(true);
			expect(isPreset('linting')).toBe(true);
			expect(isPreset('duplication')).toBe(true);
			expect(isPreset('entropy')).toBe(true);
		});

		it('returns false for invalid preset names', () => {
			expect(isPreset('invalid')).toBe(false);
			expect(isPreset('custom')).toBe(false);
			expect(isPreset('')).toBe(false);
		});

		it('returns false for file paths', () => {
			expect(isPreset('/path/to/preset.md')).toBe(false);
			expect(isPreset('./custom-preset.md')).toBe(false);
			expect(isPreset('presets/default.md')).toBe(false);
		});

		it('returns false for preset names with different casing', () => {
			expect(isPreset('Default')).toBe(false);
			expect(isPreset('DEFAULT')).toBe(false);
			expect(isPreset('Test-Coverage')).toBe(false);
		});
	});

	describe('Individual preset constants', () => {
		it('exports DEFAULT_PRESET', () => {
			expect(DEFAULT_PRESET).toBeDefined();
			expect(typeof DEFAULT_PRESET).toBe('object');
			expect(DEFAULT_PRESET.initial(TEST_CTX).length).toBeGreaterThan(0);
		});

		it('exports TEST_COVERAGE_PRESET', () => {
			expect(TEST_COVERAGE_PRESET).toBeDefined();
			expect(typeof TEST_COVERAGE_PRESET).toBe('object');
			expect(TEST_COVERAGE_PRESET.initial(TEST_CTX).length).toBeGreaterThan(0);
		});

		it('exports LINTING_PRESET', () => {
			expect(LINTING_PRESET).toBeDefined();
			expect(typeof LINTING_PRESET).toBe('object');
			expect(LINTING_PRESET.initial(TEST_CTX).length).toBeGreaterThan(0);
		});

		it('exports DUPLICATION_PRESET', () => {
			expect(DUPLICATION_PRESET).toBeDefined();
			expect(typeof DUPLICATION_PRESET).toBe('object');
			expect(DUPLICATION_PRESET.initial(TEST_CTX).length).toBeGreaterThan(0);
		});

		it('exports ENTROPY_PRESET', () => {
			expect(ENTROPY_PRESET).toBeDefined();
			expect(typeof ENTROPY_PRESET).toBe('object');
			expect(ENTROPY_PRESET.initial(TEST_CTX).length).toBeGreaterThan(0);
		});

		it('individual constants match PRESETS record', () => {
			expect(DEFAULT_PRESET).toBe(PRESETS['default']);
			expect(TEST_COVERAGE_PRESET).toBe(PRESETS['test-coverage']);
			expect(LINTING_PRESET).toBe(PRESETS['linting']);
			expect(DUPLICATION_PRESET).toBe(PRESETS['duplication']);
			expect(ENTROPY_PRESET).toBe(PRESETS['entropy']);
		});
	});
});

describe('Preset Snapshots', () => {
	it('default preset initial matches snapshot', () => {
		expect(DEFAULT_PRESET.initial(TEST_CTX)).toMatchSnapshot();
	});

	it('test-coverage preset initial matches snapshot', () => {
		expect(TEST_COVERAGE_PRESET.initial(TEST_CTX)).toMatchSnapshot();
	});

	it('linting preset initial matches snapshot', () => {
		expect(LINTING_PRESET.initial(TEST_CTX)).toMatchSnapshot();
	});

	it('duplication preset initial matches snapshot', () => {
		expect(DUPLICATION_PRESET.initial(TEST_CTX)).toMatchSnapshot();
	});

	it('entropy preset initial matches snapshot', () => {
		expect(ENTROPY_PRESET.initial(TEST_CTX)).toMatchSnapshot();
	});
});

describe('Preset Structure Validation', () => {
	describe('all presets contain required elements', () => {
		it.each(PRESET_NAMES)(
			'%s initial contains <loop-complete> marker',
			(preset) => {
				const content = getPreset(preset).initial(TEST_CTX);
				expect(content).toMatch(/<loop-complete>/);
			}
		);

		it.each(PRESET_NAMES)(
			'%s initial contains numbered process steps',
			(preset) => {
				const content = getPreset(preset).initial(TEST_CTX);
				// Check for numbered steps (e.g., "1. ", "2. ")
				expect(content).toMatch(/^\d+\./m);
			}
		);

		it.each(PRESET_NAMES)(
			'%s initial contains Important or Completion section',
			(preset) => {
				const content = getPreset(preset).initial(TEST_CTX);
				// Check for Important section (markdown or plain text) or Completion section
				expect(content).toMatch(/## Important|## Completion|^IMPORTANT:/im);
			}
		);

		it.each(PRESET_NAMES)(
			'%s initial contains <loop-summary> marker instruction',
			(name) => {
				const text = getPreset(name).initial(TEST_CTX);
				expect(text).toMatch(/<loop-summary>/i);
			}
		);

		it.each(PRESET_NAMES)(
			'%s initial does not contain "Commit with message"',
			(name) => {
				const text = getPreset(name).initial(TEST_CTX);
				expect(text).not.toMatch(/commit with message/i);
			}
		);
	});

	describe('default preset specific requirements', () => {
		it('initial contains <loop-blocked> marker', () => {
			expect(DEFAULT_PRESET.initial(TEST_CTX)).toMatch(/<loop-blocked>/);
		});

		it('initial contains both loop markers', () => {
			expect(DEFAULT_PRESET.initial(TEST_CTX)).toMatch(
				/<loop-complete>.*<\/loop-complete>/
			);
			expect(DEFAULT_PRESET.initial(TEST_CTX)).toMatch(
				/<loop-blocked>.*<\/loop-blocked>/
			);
		});
	});

	describe('default preset projectRoot injection', () => {
		it('initial embeds the provided projectRoot in the prompt', () => {
			const content = DEFAULT_PRESET.initial({ projectRoot: '/my/project' });
			expect(content).toContain('/my/project');
		});

		it('initial uses the projectRoot from TEST_CTX in all MCP tool calls', () => {
			const content = DEFAULT_PRESET.initial(TEST_CTX);
			expect(content).toContain(`"projectRoot": "${TEST_CTX.projectRoot}"`);
		});
	});
});

describe('Preset Content Consistency', () => {
	it.each(PRESET_NAMES)(
		'%s initial mentions single-task-per-iteration constraint',
		(preset) => {
			const content = getPreset(preset).initial(TEST_CTX);
			// Check for variations of the single-task constraint
			const hasConstraint =
				content.toLowerCase().includes('one task') ||
				content.toLowerCase().includes('one test') ||
				content.toLowerCase().includes('one fix') ||
				content.toLowerCase().includes('one refactor') ||
				content.toLowerCase().includes('one cleanup') ||
				content.toLowerCase().includes('only one');
			expect(hasConstraint).toBe(true);
		}
	);

	it('specialized presets initial have markdown headers', () => {
		// Default preset uses plain text sections (TASK:, PROCESS:, IMPORTANT:)
		// Other presets use markdown headers
		for (const preset of PRESET_NAMES.filter((p) => p !== 'default')) {
			const content = getPreset(preset).initial(TEST_CTX);
			// Check for at least one markdown header
			expect(content).toMatch(/^#+ /m);
		}
	});

	it('all presets initial have process section', () => {
		for (const preset of PRESET_NAMES) {
			const content = getPreset(preset).initial(TEST_CTX);
			// Check for Process header (markdown ## or plain text PROCESS:)
			expect(content).toMatch(/## Process|^PROCESS:/m);
		}
	});
});

describe('continuation prompts', () => {
	it.each(PRESET_NAMES)('%s has a non-empty continuation string', (name) => {
		const preset = getPreset(name);
		const result = preset.continuation({ projectRoot: '/proj' });
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);
	});

	it.each(PRESET_NAMES)(
		'%s continuation contains <loop-complete> marker',
		(name) => {
			const result = getPreset(name).continuation({ projectRoot: '/proj' });
			expect(result).toMatch(/<loop-complete>/);
		}
	);

	it('default continuation injects projectRoot', () => {
		const result = DEFAULT_PRESET.continuation({ projectRoot: '/my/proj' });
		expect(result).toContain('/my/proj');
	});
});

describe('default preset prefetch behavior', () => {
	const TASK: PrefetchedTask = {
		id: '3',
		title: 'Add login page',
		priority: 'high',
		dependencies: ['1', '2']
	};

	it('initial with nextTask injects pre-fetched task JSON block', () => {
		const content = DEFAULT_PRESET.initial({
			projectRoot: '/proj',
			nextTask: TASK
		});
		expect(content).toContain('NEXT TASK (pre-fetched):');
		expect(content).toContain('"id": "3"');
		expect(content).toContain('"title": "Add login page"');
		expect(content).not.toContain('next_task');
	});

	it('initial without nextTask shows fallback next_task instruction', () => {
		const content = DEFAULT_PRESET.initial({ projectRoot: '/proj' });
		expect(content).toContain('next_task');
		expect(content).not.toContain('NEXT TASK (pre-fetched):');
	});

	it('initial with nextTask: null shows fallback next_task instruction', () => {
		const content = DEFAULT_PRESET.initial({
			projectRoot: '/proj',
			nextTask: null
		});
		expect(content).toContain('next_task');
		expect(content).not.toContain('NEXT TASK (pre-fetched):');
	});

	it('continuation with nextTask injects pre-fetched task JSON block', () => {
		const content = DEFAULT_PRESET.continuation({
			projectRoot: '/proj',
			nextTask: TASK
		});
		expect(content).toContain('Your next task (pre-fetched):');
		expect(content).toContain('"id": "3"');
		expect(content).not.toContain('next_task');
	});

	it('continuation without nextTask shows fallback next_task instruction', () => {
		const content = DEFAULT_PRESET.continuation({ projectRoot: '/proj' });
		expect(content).toContain('next_task');
		expect(content).not.toContain('Your next task (pre-fetched):');
	});
});
