/**
 * Tests for content-renderer.ts
 *
 * Regression coverage for: markdown rendering corruption when the `details`
 * field contains angle brackets (e.g. JSX/TSX) inside fenced code blocks.
 * The old detection regex `/<[^>]+>/` matched those brackets and incorrectly
 * routed the content through TurndownService.
 */

import { describe, expect, it } from 'vitest';
import { containsHtml, renderContent } from './content-renderer.js';

describe('containsHtml', () => {
	it('detects real HTML tags', () => {
		expect(containsHtml('<p>hello</p>')).toBe(true);
		expect(containsHtml('text with <strong>bold</strong>')).toBe(true);
		expect(containsHtml('<br/>')).toBe(true);
		expect(containsHtml('<a href="https://example.com">link</a>')).toBe(true);
	});

	it('does not flag plain text', () => {
		expect(containsHtml('just some text')).toBe(false);
		expect(containsHtml('')).toBe(false);
	});

	it('does not flag math-style angle brackets', () => {
		expect(containsHtml('if (a < b && b > c) {}')).toBe(false);
	});

	it('ignores angle brackets inside fenced code blocks (JSX/TSX)', () => {
		const content = [
			'Here is some routing code:',
			'```tsx',
			'<Navigate to="/" replace />',
			'```'
		].join('\n');
		expect(containsHtml(content)).toBe(false);
	});

	it('ignores angle brackets inside fenced code blocks without language tag', () => {
		const content = '```\n<div>nope</div>\n```';
		expect(containsHtml(content)).toBe(false);
	});

	it('ignores angle brackets inside tilde-fenced code blocks', () => {
		const content = '~~~\n<Component />\n~~~';
		expect(containsHtml(content)).toBe(false);
	});

	it('ignores angle brackets inside inline code spans', () => {
		expect(containsHtml('use the `<Navigate />` component')).toBe(false);
	});

	it('still detects HTML mixed with safe code blocks', () => {
		const content = [
			'<p>real html outside</p>',
			'```tsx',
			'<Navigate to="/" replace />',
			'```'
		].join('\n');
		expect(containsHtml(content)).toBe(true);
	});
});

describe('renderContent', () => {
	it('returns an empty string for falsy input', () => {
		expect(renderContent('')).toBe('');
	});

	it('preserves JSX inside fenced code blocks (regression for routing-corruption bug)', () => {
		const content = [
			'Use this route guard:',
			'```tsx',
			'<Navigate to="/" replace />',
			'```'
		].join('\n');

		const output = renderContent(content);

		// The JSX must survive verbatim - it must NOT have been stripped by Turndown.
		expect(output).toContain('Navigate');
		expect(output).toContain('to="/"');
		expect(output).toContain('replace');
	});

	it('preserves multi-line JSX inside a code block', () => {
		const content = [
			'```tsx',
			'<Router>',
			'  <Route path="/" element={<Home />} />',
			'</Router>',
			'```'
		].join('\n');

		const output = renderContent(content);

		expect(output).toContain('Router');
		expect(output).toContain('Route');
		expect(output).toContain('Home');
	});

	it('still converts real HTML content to markdown', () => {
		const output = renderContent('<p>hello <strong>world</strong></p>');
		// After turndown + marked terminal rendering, the words should still be present.
		expect(output).toContain('hello');
		expect(output).toContain('world');
	});

	it('handles plain markdown without invoking turndown', () => {
		const output = renderContent('# Heading\n\nSome **bold** text.');
		expect(output).toContain('Heading');
		expect(output).toContain('bold');
	});
});
