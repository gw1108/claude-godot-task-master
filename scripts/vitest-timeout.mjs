#!/usr/bin/env node
/**
 * Watchdog wrapper around `vitest run`.
 *
 * Why this exists: on Windows, the CLI integration tests
 * (apps/cli/tests/integration/**) use execSync to spawn real `node` CLI child
 * processes. When a spawned command (or a grandchild it launches) doesn't
 * cleanly close its inherited stdio, the vitest worker holding that pipe never
 * exits, so `vitest run` hangs forever. The launching shell stays blocked and
 * the node processes pile up.
 *
 * This wrapper spawns vitest, then force-kills the entire process tree if it
 * runs longer than TEST_TIMEOUT_MS (default 10 min). Cross-platform; on CI a
 * healthy run finishes well under the limit, so the watchdog only ever fires on
 * a genuine hang. Override with TEST_TIMEOUT_MS=<ms>.
 *
 * All args are forwarded to vitest, e.g.:
 *   npm run test -w @tm/cli -- path/to/file --reporter=verbose
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS) || 10 * 60 * 1000;
const isWin = process.platform === 'win32';
const args = ['run', ...process.argv.slice(2)];

// Prefer spawning node directly on vitest's JS entry (hoisted to the repo-root
// node_modules). This avoids the .cmd shim + `shell: true`, which on Windows
// triggers DEP0190 and makes tree-killing less reliable. detached on POSIX so
// we can signal the whole process group on timeout.
const here = path.dirname(fileURLToPath(import.meta.url));
const vitestJs = path.resolve(here, '../node_modules/vitest/vitest.mjs');

const child = existsSync(vitestJs)
	? spawn(process.execPath, [vitestJs, ...args], {
			stdio: 'inherit',
			detached: !isWin
		})
	: // Fallback: resolve `vitest` via the node_modules/.bin PATH npm provides.
		spawn('vitest', args, { stdio: 'inherit', shell: isWin, detached: !isWin });

let timedOut = false;
const timer = setTimeout(() => {
	timedOut = true;
	console.error(
		`\n[vitest-timeout] No completion after ${TIMEOUT_MS}ms — force-killing the test process tree (pid ${child.pid}).`
	);
	killTree(child.pid);
}, TIMEOUT_MS);
timer.unref();

function killTree(pid) {
	if (pid == null) return;
	try {
		if (isWin) {
			// /T kills the whole tree (cmd -> vitest -> spawned CLI grandchildren).
			execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
		} else {
			process.kill(-pid, 'SIGKILL');
		}
	} catch {
		/* already gone */
	}
}

child.on('error', (err) => {
	clearTimeout(timer);
	console.error(`[vitest-timeout] Failed to start vitest: ${err.message}`);
	process.exit(1);
});

child.on('exit', (code, signal) => {
	clearTimeout(timer);
	if (timedOut) {
		process.exit(124); // conventional "timed out" exit code
	}
	process.exit(code ?? (signal ? 1 : 0));
});
