/**
 * Regression test: warning glyphs must use emoji presentation.
 *
 * Bare U+26A0 (⚠) renders as text-presentation and is measured as 1 column
 * by terminal width calculators such as `string-width` / `boxen`. When it
 * appears in a boxen title or body, the box border misaligns because the
 * renderer actually paints it 2 columns wide.
 *
 * Forcing emoji presentation with the U+FE0F variation selector (⚠️) makes
 * width calculators return 2 columns, matching what terminals render.
 *
 * This test scans display-code source files and fails if any bare U+26A0 is
 * not immediately followed by U+FE0F.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const SOURCE_DIRS = [
	'scripts',
	'src',
	path.join('apps', 'cli', 'src'),
	path.join('apps', 'mcp', 'src'),
	path.join('apps', 'extension', 'src'),
	path.join('packages', 'tm-core', 'src'),
	path.join('packages', 'tm-bridge', 'src'),
	path.join('packages', 'tm-profiles', 'src'),
	path.join('packages', 'claude-code-plugin')
];

const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIR_NAMES = new Set([
	'node_modules',
	'dist',
	'build',
	'.next',
	'.turbo',
	'coverage',
	'__snapshots__'
]);

// U+26A0 NOT followed by U+FE0F (variation selector-16).
const BARE_WARN = /⚠(?!️)/;

function walk(dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		if (err.code === 'ENOENT') return;
		throw err;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue;
			walk(full, out);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name);
			if (!ALLOWED_EXTENSIONS.has(ext)) continue;
			out.push(full);
		}
	}
}

describe('warning emoji presentation', () => {
	test('no display-code source file contains a bare U+26A0 without U+FE0F', () => {
		const files = [];
		for (const rel of SOURCE_DIRS) {
			walk(path.join(repoRoot, rel), files);
		}

		const offenders = [];
		for (const file of files) {
			const text = fs.readFileSync(file, 'utf8');
			const lines = text.split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (BARE_WARN.test(lines[i])) {
					offenders.push(
						`${path.relative(repoRoot, file)}:${i + 1}: ${lines[i].trim()}`
					);
				}
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`Found bare U+26A0 (text-presentation) in display code. ` +
					`Replace each with U+26A0 followed by U+FE0F (⚠️) so ` +
					`width calculators measure 2 columns and boxen borders stay aligned.\n` +
					offenders.map((o) => `  - ${o}`).join('\n')
			);
		}
	});

	test('regex correctly distinguishes bare from emoji-presentation warnings', () => {
		expect(BARE_WARN.test('⚠ Warning')).toBe(true);
		expect(BARE_WARN.test('⚠️ Warning')).toBe(false);
		expect(BARE_WARN.test('no warning here')).toBe(false);
	});
});
