import type { LoopPresetDef, PresetCtx } from '../types.js';

/**
 * Linting preset for Taskmaster loop - fix lint and type errors
 */
const LINTING_PRESET_TEXT = `# Taskmaster Loop - Linting

Fix lint errors and type errors one by one. ONE fix per session.

## Process

1. Run lint command
2. Run type check
3. Pick ONE error to fix - prioritize:
   - Type errors (breaks builds)
   - Security-related lint errors
   - Errors in frequently-changed files
4. Fix the error with minimal changes - don't refactor surrounding code
5. Run lint/typecheck again to verify the fix doesn't introduce new errors
6. Emit <loop-summary><file>: <one-line description of lint/type error fixed></loop-summary>
7. Append to progress file: error fixed, remaining error count

## Important

- Complete ONLY ONE fix per session
- Keep changes minimal and focused
- Do NOT start another fix after completing one

## Completion Criteria

- If zero lint errors and zero type errors, output: <loop-complete>ZERO_ERRORS</loop-complete>
`;

export const LINTING_PRESET: LoopPresetDef = {
	initial: (_ctx: PresetCtx): string => LINTING_PRESET_TEXT,
	continuation: (_ctx: PresetCtx): string =>
		`Continue fixing lint/type errors. Run the lint and typecheck commands, pick ONE error, fix it minimally, verify no regressions, emit <loop-summary><file>: <one-line description of lint/type error fixed></loop-summary>, and emit <loop-complete>ZERO_ERRORS</loop-complete> when all errors are gone.`
};
