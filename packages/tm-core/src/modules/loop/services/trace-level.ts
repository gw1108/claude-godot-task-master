import type { LoopTraceLevel } from '../types.js';

export const TRACE_LEVEL_WEIGHTS = {
	none: 0,
	verbose: 1,
	trace: 2
} as const satisfies Record<LoopTraceLevel, number>;

export function atLeast(
	level: LoopTraceLevel,
	threshold: LoopTraceLevel
): boolean {
	return TRACE_LEVEL_WEIGHTS[level] >= TRACE_LEVEL_WEIGHTS[threshold];
}
