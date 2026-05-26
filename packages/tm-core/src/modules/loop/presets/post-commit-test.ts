import type { LoopPresetDef, PresetCtx } from '../types.js';

export function makePostCommitTestPreset(rangeDesc: string): LoopPresetDef {
	const initial = (_ctx: PresetCtx): string =>
		`You are running inside \`task-master loop\`'s finalize phase. Your job is to maintain the project's single canonical golden-path test.

First, inspect the full set of implementation commits from this loop run:
  git log ${rangeDesc} --oneline
  git diff ${rangeDesc}

Then:
1. Find the project's golden-path test. Search for files named *golden*, *golden_path*, or *happy_path* in the project's test directories. If none exist, identify the project's primary test entry point (the test file that exercises the main execution flow).
2. If the golden-path test does not exist, create one at the most appropriate location for this project. It should exercise the primary flow end-to-end.
3. If the golden-path test exists, extend it so it also exercises the primary flow through the features introduced in the commits above.
4. Add unit tests (separate files) only for genuine edge cases that cannot be covered by the golden path.
5. Do NOT include any manual testing steps.
6. Do NOT commit — the harness will commit your changes.

When done, emit exactly one of these markers on its own line:
  <loop-complete>NOTHING_TO_TEST</loop-complete>  — if the diff contains no testable behaviour
  <loop-complete>TESTS_ADDED</loop-complete>       — if you created or updated test files
  <loop-blocked>UNKNOWN_TEST_SETUP</loop-blocked>  — if you cannot determine where tests live in this project`;

	const continuation = (_ctx: PresetCtx): string =>
		`Continue writing or updating the golden-path test for range ${rangeDesc}. When complete, emit <loop-complete>NOTHING_TO_TEST</loop-complete>, <loop-complete>TESTS_ADDED</loop-complete>, or <loop-blocked>UNKNOWN_TEST_SETUP</loop-blocked>.`;

	return { initial, continuation };
}
