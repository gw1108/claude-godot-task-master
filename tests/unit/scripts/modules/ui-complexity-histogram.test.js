/**
 * Tests for renderComplexityHistogram in scripts/modules/ui.js.
 *
 * The renderer prints to stdout as a side effect; we silence console.log and
 * assert on its return value, which exposes the bucket math used to draw the
 * chart. The visual layout itself is intentionally not tested.
 */

import { jest } from '@jest/globals';
import { renderComplexityHistogram } from '../../../../scripts/modules/ui.js';

describe('renderComplexityHistogram', () => {
	let logSpy;

	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('handles an empty array without throwing and reports zero totals', () => {
		const result = renderComplexityHistogram([]);
		expect(result.total).toBe(0);
		expect(result.buckets).toEqual({ low: 0, medium: 0, high: 0 });
	});

	it('places scores in Low (<5), Medium (5-7), and High (>=8) buckets', () => {
		const result = renderComplexityHistogram([
			{ complexityScore: 1 },
			{ complexityScore: 4 },
			{ complexityScore: 5 },
			{ complexityScore: 7 },
			{ complexityScore: 8 },
			{ complexityScore: 10 }
		]);
		expect(result.total).toBe(6);
		expect(result.buckets).toEqual({ low: 2, medium: 2, high: 2 });
	});

	it('rounds and clamps out-of-range scores into 1..10 buckets', () => {
		const result = renderComplexityHistogram([
			{ complexityScore: 0 }, // clamped up to 1
			{ complexityScore: 11 }, // clamped down to 10
			{ complexityScore: 5.6 }, // rounds to 6 -> medium
			{ complexityScore: 7.4 } // rounds to 7 -> medium
		]);
		expect(result.counts[1]).toBe(1);
		expect(result.counts[10]).toBe(1);
		expect(result.counts[6]).toBe(1);
		expect(result.counts[7]).toBe(1);
		expect(result.buckets).toEqual({ low: 1, medium: 2, high: 1 });
	});

	it('skips entries with missing or non-numeric complexity scores', () => {
		const result = renderComplexityHistogram([
			{ complexityScore: 3 },
			{ complexityScore: null },
			{ complexityScore: undefined },
			{ complexityScore: 'oops' },
			{}
		]);
		expect(result.total).toBe(1);
		expect(result.buckets).toEqual({ low: 1, medium: 0, high: 0 });
	});

	it('tolerates non-array input', () => {
		const result = renderComplexityHistogram(null);
		expect(result.total).toBe(0);
		expect(result.buckets).toEqual({ low: 0, medium: 0, high: 0 });
	});
});
