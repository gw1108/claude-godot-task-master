import type { LoopPresetDef, PresetCtx } from '../types.js';

/**
 * Duplication preset for Taskmaster loop - code deduplication
 */
const DUPLICATION_PRESET_TEXT = `# Taskmaster Loop - Duplication

Find duplicated code and refactor into shared utilities. ONE refactor per session.

## Process

1. Run duplication detection (\`npx jscpd .\`, or similar tool)
2. Review the report and pick ONE clone to refactor - prioritize:
   - Larger clones (more lines = more maintenance burden)
   - Clones in frequently-changed files
   - Clones with slight variations (consolidate logic)
3. Extract the duplicated code into a shared utility/function
4. Update all clone locations to use the shared utility
5. Run tests to ensure behavior is preserved
6. Emit <loop-summary><file>: <one-line description of duplication removed></loop-summary>
7. Append to progress file: what was refactored, new duplication %

## Important

- Complete ONLY ONE refactor per session
- Keep changes focused on the specific duplication
- Do NOT start another refactor after completing one

## Completion Criteria

- If duplication below threshold (e.g., <3%), output: <loop-complete>LOW_DUPLICATION</loop-complete>
`;

export const DUPLICATION_PRESET: LoopPresetDef = {
	initial: (_ctx: PresetCtx): string => DUPLICATION_PRESET_TEXT,
	continuation: (_ctx: PresetCtx): string =>
		`Continue reducing code duplication. Run the duplication detector, pick ONE clone, extract it into a shared utility, update all call sites, run tests, emit <loop-summary><file>: <one-line description of duplication removed></loop-summary>, and emit <loop-complete>LOW_DUPLICATION</loop-complete> when done.`
};
