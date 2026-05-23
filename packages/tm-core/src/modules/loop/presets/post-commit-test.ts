import type { LoopPresetDef, PresetCtx } from '../types.js';

export function makePostCommitTestPreset(sha: string): LoopPresetDef {
	return {
		initial: (_ctx: PresetCtx): string =>
			`You are running a post-commit test pass for commit ${sha}.

1. Run \`git show ${sha}\` to inspect the diff that was just committed.
2. Write tests for every new or modified behaviour in that diff.
   - If there is no behavioural surface to test (e.g. the commit was pure formatting, dependency bumps, or config only), emit:
     <loop-complete>NOTHING_TO_TEST</loop-complete>
     and stop. Do not create files or run any commands.
3. Run the tests. If they pass, emit:
     <loop-summary>brief one-line description of what tests were added</loop-summary>
     <loop-complete>TESTS_ADDED</loop-complete>
4. If a test fails because of a real bug in the implementation (not a test-setup issue):
   - Fix the bug in the implementation. Do NOT weaken or delete the test.
   - Re-run the tests until they pass, then emit the markers from step 3.
5. If you cannot determine how to run the tests for this project, emit:
     <loop-blocked>UNKNOWN_TEST_SETUP</loop-blocked>
   and stop.
6. Do not commit anything. The runner will stage and commit your changes.`,
		continuation: (_ctx: PresetCtx): string =>
			`Continue the post-commit test pass for commit ${sha}. Complete any remaining test writing or bug fixes, then emit the appropriate <loop-complete> or <loop-blocked> marker.`
	};
}
