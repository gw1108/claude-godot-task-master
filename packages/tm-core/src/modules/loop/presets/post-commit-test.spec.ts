import { describe, it, expect } from 'vitest';
import { makePostCommitTestPreset } from './post-commit-test.js';

describe('makePostCommitTestPreset', () => {
	it('interpolates the sha into the initial prompt', () => {
		const preset = makePostCommitTestPreset('abc1234');
		const prompt = preset.initial({ projectRoot: '/project' });
		expect(prompt).toContain('abc1234');
		expect(prompt).toContain('NOTHING_TO_TEST');
		expect(prompt).toContain('TESTS_ADDED');
		expect(prompt).toContain('UNKNOWN_TEST_SETUP');
	});

	it('interpolates the sha into the continuation prompt', () => {
		const preset = makePostCommitTestPreset('abc1234');
		const prompt = preset.continuation({ projectRoot: '/project' });
		expect(prompt).toContain('abc1234');
	});

	it('produces independent presets for different shas', () => {
		const p1 = makePostCommitTestPreset('aaa0001');
		const p2 = makePostCommitTestPreset('bbb0002');
		expect(p1.initial({ projectRoot: '/p' })).not.toBe(
			p2.initial({ projectRoot: '/p' })
		);
		expect(p1.initial({ projectRoot: '/p' })).toContain('aaa0001');
		expect(p2.initial({ projectRoot: '/p' })).toContain('bbb0002');
	});
});
