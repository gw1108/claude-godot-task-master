/**
 * @fileoverview Loop Service - Orchestrates running Claude Code iterations (sandbox or CLI mode)
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getLogger } from '../../../common/logger/index.js';
import { GitAdapter } from '../../git/adapters/git-adapter.js';
import {
	PRESETS,
	getPreset,
	isPreset as checkIsPreset
} from '../presets/index.js';
import type {
	LoopConfig,
	LoopIteration,
	LoopOutputCallbacks,
	LoopPreset,
	LoopResult,
	LoopTokenUsage,
	LoopTraceLevel,
	TestPhaseResult,
	PrefetchedTask
} from '../types.js';
import { trimTask } from '../types.js';
import type { Task } from '../../../common/types/index.js';
import { makePostCommitTestPreset } from '../presets/post-commit-test.js';
import { atLeast } from './trace-level.js';

export interface LoopServiceOptions {
	projectRoot: string;
	/** Optional in-process next-task fetcher; enables per-iteration pre-fetch for 'default' preset. */
	getNext?: (tag?: string) => Promise<Task | null>;
}

const MODEL_CONTEXT_WINDOW: Array<{ pattern: RegExp; tokens: number }> = [
	{ pattern: /opus/i, tokens: 1_000_000 },
	{ pattern: /sonnet/i, tokens: 200_000 },
	{ pattern: /haiku/i, tokens: 200_000 }
];

export function contextWindowFor(modelId: string | undefined): number {
	if (!modelId) return 1_000_000;
	const match = MODEL_CONTEXT_WINDOW.find(({ pattern }) =>
		pattern.test(modelId)
	);
	return match?.tokens ?? 1_000_000;
}

type IterationTelemetry = {
	iterationNum: number;
	totalToolCalls: number;
	taskMasterToolCalls: number;
	writeToolCalls: number;
	nonWriteToolCalls: number;
	tokenUsage?: LoopTokenUsage;
	estimatedContext: number;
	contextPercent?: number;
	modelId?: string;
	status: LoopIteration['status'];
	duration?: number;
};

type TestPhaseTelemetry = {
	parentSha: string;
	duration?: number;
	status: TestPhaseResult['status'];
	testCommitSha?: string;
};

export class LoopService {
	private readonly projectRoot: string;
	private readonly getNext?: (tag?: string) => Promise<Task | null>;
	private readonly logger = getLogger('LoopService');
	private _isRunning = false;
	private _currentSessionId: string | undefined = undefined;
	private iterationTelemetry: IterationTelemetry[] = [];
	private pendingSummaries: { iterationNum: number; text: string }[] = [];
	private lastCommitAt = 0;
	private testPhases: TestPhaseResult[] = [];
	private testPhaseTelemetry: TestPhaseTelemetry[] = [];
	private loopStartRef: string | undefined;

	private static readonly WRITE_TOOLS = new Set([
		'Write',
		'Edit',
		'MultiEdit',
		'NotebookEdit'
	]);

	private static readonly PRESET_COMMIT_PREFIX: Record<string, string> = {
		default: 'feat',
		'test-coverage': 'test',
		linting: 'fix',
		duplication: 'refactor',
		entropy: 'refactor'
	};

	constructor(options: LoopServiceOptions) {
		this.projectRoot = options.projectRoot;
		this.getNext = options.getNext;
	}

	getProjectRoot(): string {
		return this.projectRoot;
	}

	get isRunning(): boolean {
		return this._isRunning;
	}

	/**
	 * Verify that the named MCP server is wired up in the project's .mcp.json.
	 *
	 * Config-only check (sync file read, no IPC) — fast enough to run on every
	 * loop start. A live tool ping was rejected as too heavy for a precondition.
	 */
	checkMcpServerAvailable(serverAlias: string): {
		available: boolean;
		error?: string;
	} {
		const mcpConfigPath = path.join(this.projectRoot, '.mcp.json');
		if (!existsSync(mcpConfigPath)) {
			return {
				available: false,
				error: `MCP config not found at ${mcpConfigPath}. Add a .mcp.json with a "${serverAlias}" mcpServers entry.`
			};
		}
		try {
			const raw = readFileSync(mcpConfigPath, 'utf-8');
			const config = JSON.parse(raw) as {
				mcpServers?: Record<string, unknown>;
			};
			if (!config.mcpServers || !(serverAlias in config.mcpServers)) {
				return {
					available: false,
					error: `MCP server "${serverAlias}" not found in ${mcpConfigPath}. Add it under mcpServers.`
				};
			}
			return { available: true };
		} catch (err) {
			return {
				available: false,
				error: `Failed to read ${mcpConfigPath}: ${(err as Error).message}`
			};
		}
	}

	/** Check if Docker sandbox auth is ready */
	checkSandboxAuth(): { ready: boolean; error?: string } {
		const result = spawnSync(
			'docker',
			['sandbox', 'run', 'claude', '-p', 'Say OK'],
			{
				cwd: this.projectRoot,
				timeout: 30000,
				encoding: 'utf-8',
				stdio: ['inherit', 'pipe', 'pipe']
			}
		);

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				return {
					ready: false,
					error:
						'Docker is not installed. Install Docker Desktop to use --sandbox mode.'
				};
			}
			return { ready: false, error: `Docker error: ${result.error.message}` };
		}

		const output = (result.stdout || '') + (result.stderr || '');
		return { ready: output.toLowerCase().includes('ok') };
	}

	/** Run interactive Docker sandbox session for user authentication */
	runInteractiveAuth(): { success: boolean; error?: string } {
		const result = spawnSync(
			'docker',
			[
				'sandbox',
				'run',
				'claude',
				"You're authenticated! Press Ctrl+C to continue."
			],
			{
				cwd: this.projectRoot,
				stdio: 'inherit'
			}
		);

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				return {
					success: false,
					error:
						'Docker is not installed. Install Docker Desktop to use --sandbox mode.'
				};
			}
			return { success: false, error: `Docker error: ${result.error.message}` };
		}

		if (result.status === null) {
			return {
				success: false,
				error: 'Docker terminated abnormally (no exit code)'
			};
		}

		if (result.status !== 0) {
			return {
				success: false,
				error: `Docker exited with code ${result.status}`
			};
		}

		return { success: true };
	}

	/** Run a loop with the given configuration */
	async run(config: LoopConfig): Promise<LoopResult> {
		// Track loop wall-clock from the moment we accept the config so even
		// pre-flight failures get a non-zero duration users can reason about.
		const loopStart = Date.now();

		const level = config.traceLevel ?? 'none';
		const streaming = atLeast(level, 'verbose');

		// Validate incompatible options early - fail once, not per iteration
		if (streaming && config.sandbox) {
			const errorMsg = `--tracelevel ${level} is not supported with sandbox mode. Use --tracelevel ${level} without --sandbox, or set --tracelevel none.`;
			this.reportError(config.callbacks, errorMsg);
			return this.buildErrorResult(loopStart, errorMsg, config.callbacks);
		}

		// The default preset routes all task-master calls through the MCP server.
		// Verify it is configured in .mcp.json once up front — fail fast rather than
		// discovering the gap during the first iteration.
		// Skip in sandbox mode: the host .mcp.json doesn't govern the container.
		if (config.prompt === 'default' && !config.sandbox) {
			const mcpCheck = this.checkMcpServerAvailable('task-master-ai');
			if (!mcpCheck.available) {
				const errorMsg =
					mcpCheck.error || 'task-master-ai MCP server not configured';
				this.reportError(config.callbacks, errorMsg);
				return this.buildErrorResult(loopStart, errorMsg, config.callbacks);
			}
		}

		this._isRunning = true;
		this.iterationTelemetry = [];
		this.testPhases = [];
		this.testPhaseTelemetry = [];
		const batchCommit = config.batchCommit ?? true;
		if (batchCommit) {
			this.pendingSummaries = [];
			this.lastCommitAt = loopStart;
		}
		const iterations: LoopIteration[] = [];
		let tasksCompleted = 0;
		const startedAt = new Date(loopStart);

		// Always generate a UUID before iteration 1; rotate on context overflow
		let currentSessionId: string = randomUUID();
		this._currentSessionId = currentSessionId;
		let isFirstInSession = true;

		await this.initProgressFile(config, startedAt);

		// Capture the HEAD SHA before any loop commits land
		{
			const gitAdapter = new GitAdapter(this.projectRoot);
			const startRefResult = await gitAdapter.getLastCommit();
			this.loopStartRef =
				typeof startRefResult?.hash === 'string'
					? startRefResult.hash.slice(0, 7)
					: undefined;
		}

		// Notify presentation layer the loop has begun. Layered above iteration
		// callbacks so verbose CLIs can stamp the start time once, not per-iteration.
		config.callbacks?.onLoopStart?.(startedAt, config.iterations);

		for (let i = 1; i <= config.iterations && this._isRunning; i++) {
			// Notify presentation layer of iteration start
			config.callbacks?.onIterationStart?.(i, config.iterations);

			// Pre-fetch next task for 'default' preset to eliminate MCP round-trips
			let prefetchedTask: PrefetchedTask | null | undefined;
			if (config.prompt === 'default' && this.getNext) {
				try {
					const next = await this.getNext(config.tag);
					if (next === null) {
						return this.finalize(
							config,
							iterations,
							tasksCompleted,
							'all_complete',
							loopStart,
							this._currentSessionId
						);
					}
					prefetchedTask = trimTask(next);
				} catch (err) {
					config.callbacks?.onError?.(
						`Pre-fetch next task failed: ${(err as Error).message ?? String(err)}`,
						'warning'
					);
					// prefetchedTask stays undefined; preset falls back to its own next_task call
				}
			}

			// Select initial vs continuation prompt based on session state
			const isResume = !isFirstInSession;
			let prompt: string;
			if (isResume) {
				if (this.isPreset(config.prompt)) {
					prompt = getPreset(config.prompt as LoopPreset).continuation({
						projectRoot: this.projectRoot,
						nextTask: prefetchedTask
					});
				} else {
					prompt = `Continue with your previous task. Pick up exactly where you left off, complete the next logical unit of work, and emit <loop-summary>...</loop-summary> when done.`;
				}
				// Wrap with context header for trace mode visibility
				prompt = `${this.buildContextHeader(config, i)}\n\n${prompt}`;
			} else {
				prompt = await this.buildPrompt(config, i, prefetchedTask);
			}

			// In trace mode, emit the full prompt sent to the LLM before invoking it.
			if (atLeast(level, 'trace')) {
				config.callbacks?.onPromptSent?.(i, prompt);
			}

			const iteration = await this.executeIteration(
				prompt,
				i,
				config.sandbox ?? false,
				config.includeOutput ?? false,
				level,
				config.callbacks,
				config.progressFile,
				config.iterations,
				currentSessionId,
				isResume
			);
			iterations.push(iteration);
			isFirstInSession = false;

			// Auto-rotate session UUID when context usage crosses 40%
			if (
				iteration.contextPercent !== undefined &&
				iteration.contextPercent >= 40
			) {
				currentSessionId = randomUUID();
				this._currentSessionId = currentSessionId;
				isFirstInSession = true;
			}

			// Notify presentation layer of iteration completion
			config.callbacks?.onIterationEnd?.(iteration);

			// Accumulate summary for batched commit; flush on timer
			if (batchCommit) {
				const summaryText = iteration.summary ?? `(iteration ${i}: no summary)`;
				this.pendingSummaries.push({ iterationNum: i, text: summaryText });

				const windowMs = (config.commitWindowMinutes ?? 20) * 60_000;
				if (
					Date.now() - this.lastCommitAt >= windowMs &&
					this.pendingSummaries.length > 0
				) {
					await this.commitBatch('timer', config);
					this.lastCommitAt = Date.now();
					this.pendingSummaries = [];
				}
			}

			// Check for early exit conditions
			if (iteration.status === 'complete') {
				return this.finalize(
					config,
					iterations,
					tasksCompleted + 1,
					'all_complete',
					loopStart,
					this._currentSessionId
				);
			}
			if (iteration.status === 'blocked') {
				return this.finalize(
					config,
					iterations,
					tasksCompleted,
					'blocked',
					loopStart,
					this._currentSessionId
				);
			}
			if (iteration.status === 'success') {
				tasksCompleted++;
			}

			// Sleep between iterations (except last)
			if (i < config.iterations && config.sleepSeconds > 0) {
				await new Promise((r) => setTimeout(r, config.sleepSeconds * 1000));
			}
		}

		return this.finalize(
			config,
			iterations,
			tasksCompleted,
			'max_iterations',
			loopStart,
			this._currentSessionId
		);
	}

	/** Stop the loop after current iteration completes */
	stop(): void {
		this._isRunning = false;
	}

	// ========== Private Helpers ==========

	private async finalize(
		config: LoopConfig,
		iterations: LoopIteration[],
		tasksCompleted: number,
		finalStatus: LoopResult['finalStatus'],
		loopStart: number,
		sessionId?: string
	): Promise<LoopResult> {
		this._isRunning = false;

		if (
			(config.batchCommit ?? true) &&
			(finalStatus === 'all_complete' || finalStatus === 'max_iterations') &&
			this.pendingSummaries.length > 0
		) {
			await this.commitBatch('finalize', config);
		}

		const finishedAtMs = Date.now();
		const finishedAt = new Date(finishedAtMs);
		const totalDuration = finishedAtMs - loopStart;
		const result: LoopResult = {
			iterations,
			totalIterations: iterations.length,
			tasksCompleted,
			finalStatus,
			startedAt: new Date(loopStart).toISOString(),
			finishedAt: finishedAt.toISOString(),
			totalDuration,
			...(sessionId !== undefined && { sessionId }),
			...(this.testPhases.length > 0 && { testPhases: [...this.testPhases] })
		};
		await this.appendFinalSummary(config.progressFile, result);
		if (this.iterationTelemetry.length > 0) {
			await this.writeTotalsFile(
				config.progressFile,
				result,
				this.iterationTelemetry,
				this.testPhaseTelemetry
			);
		}
		config.callbacks?.onLoopEnd?.(finishedAt, totalDuration);
		return result;
	}

	/**
	 * Build a synchronous error result for pre-flight failures, ensuring
	 * timing fields and the onLoopEnd callback stay consistent with finalize().
	 */
	private buildErrorResult(
		loopStart: number,
		errorMessage: string,
		callbacks?: LoopOutputCallbacks
	): LoopResult {
		const finishedAtMs = Date.now();
		const finishedAt = new Date(finishedAtMs);
		const totalDuration = finishedAtMs - loopStart;
		callbacks?.onLoopEnd?.(finishedAt, totalDuration);
		return {
			iterations: [],
			totalIterations: 0,
			tasksCompleted: 0,
			finalStatus: 'error',
			errorMessage,
			startedAt: new Date(loopStart).toISOString(),
			finishedAt: finishedAt.toISOString(),
			totalDuration
		};
	}

	/**
	 * Report an error via callback if provided, otherwise log to the logger.
	 * Ensures errors are never silently swallowed when callbacks aren't configured.
	 */
	private reportError(
		callbacks: LoopOutputCallbacks | undefined,
		message: string,
		severity: 'warning' | 'error' = 'error'
	): void {
		if (callbacks?.onError) {
			callbacks.onError(message, severity);
		} else if (severity === 'warning') {
			this.logger.warn(message);
		} else {
			this.logger.error(message);
		}
	}

	private async initProgressFile(
		config: LoopConfig,
		startedAt: Date
	): Promise<void> {
		await mkdir(path.dirname(config.progressFile), { recursive: true });
		const lines = [
			'# Taskmaster Loop Progress',
			'',
			`- **Started:** ${startedAt.toISOString()}`,
			...(config.brief ? [`- **Brief:** ${config.brief}`] : []),
			`- **Preset:** ${config.prompt}`,
			`- **Max iterations:** ${config.iterations}`,
			...(config.tag ? [`- **Tag:** ${config.tag}`] : []),
			'',
			'---',
			''
		];
		// Append to existing progress file instead of overwriting
		await appendFile(
			config.progressFile,
			'\n' + lines.join('\n') + '\n',
			'utf-8'
		);
	}

	private async appendFinalSummary(
		file: string,
		result: LoopResult
	): Promise<void> {
		// Prefer the result's recorded timestamp so the progress file aligns
		// exactly with what consumers (CLI summary, MCP response) report.
		const finishedAt = result.finishedAt ?? new Date().toISOString();
		const durationLine =
			typeof result.totalDuration === 'number'
				? `\n- **Total duration:** ${result.totalDuration}ms`
				: '';
		await appendFile(
			file,
			`
---

## Loop Complete

- **Finished:** ${finishedAt}
- **Total iterations:** ${result.totalIterations}
- **Tasks completed:** ${result.tasksCompleted}
- **Final status:** ${result.finalStatus}${durationLine}
`,
			'utf-8'
		);
	}

	private async writeTotalsFile(
		progressFile: string,
		result: LoopResult,
		telemetry: IterationTelemetry[],
		testPhaseTelemetry?: TestPhaseTelemetry[]
	): Promise<void> {
		if (telemetry.length === 0) return;

		let totalTools = 0,
			totalTM = 0,
			totalWrites = 0,
			totalNW = 0;
		let totalInput = 0,
			totalOutput = 0,
			totalCacheWrite = 0,
			totalCacheRead = 0,
			totalTokens = 0;
		let totalContext = 0;
		let totalContextWindow = 0;

		for (const t of telemetry) {
			totalTools += t.totalToolCalls;
			totalTM += t.taskMasterToolCalls;
			totalWrites += t.writeToolCalls;
			totalNW += t.nonWriteToolCalls;
			totalContext += t.estimatedContext;
			if (t.tokenUsage) {
				totalInput += t.tokenUsage.inputTokens;
				totalOutput += t.tokenUsage.outputTokens;
				totalCacheWrite += t.tokenUsage.cacheCreationInputTokens ?? 0;
				totalCacheRead += t.tokenUsage.cacheReadInputTokens ?? 0;
				totalTokens += t.tokenUsage.totalTokens;
				totalContextWindow += contextWindowFor(t.modelId);
			}
		}

		const fmt = (n: number) => n.toLocaleString('en-US');
		const durationLine =
			typeof result.totalDuration === 'number'
				? `- Total duration: ${fmt(result.totalDuration)}ms`
				: '';

		const tableHeader = `| Iter | Tool calls | TM | Writes | Non-writes | Total tokens | Est. context | % of ctx | Uncached tok | % of ctx uncached |`;
		const tableSep = `|------|------------|----|----|--------|---------|-------|----------|--------------|--------------------|`;
		const tableRows = telemetry
			.map((t) => {
				const pct =
					t.contextPercent !== undefined
						? `${t.contextPercent.toFixed(1)}%`
						: '—';
				const tok = t.tokenUsage ? fmt(t.tokenUsage.totalTokens) : '—';
				const uncachedTok = t.tokenUsage
					? fmt(t.tokenUsage.inputTokens + t.tokenUsage.outputTokens)
					: '—';
				const uncachedPct = t.tokenUsage
					? (
							((t.tokenUsage.inputTokens + t.tokenUsage.outputTokens) /
								contextWindowFor(t.modelId)) *
							100
						).toFixed(1) + '%'
					: '—';
				return `| ${t.iterationNum} | ${fmt(t.totalToolCalls)} | ${fmt(t.taskMasterToolCalls)} | ${fmt(t.writeToolCalls)} | ${fmt(t.nonWriteToolCalls)} | ${tok} | ${fmt(t.estimatedContext)} | ${pct} | ${uncachedTok} | ${uncachedPct} |`;
			})
			.join('\n');

		const content = [
			'# Loop Totals',
			`- Final status: ${result.finalStatus}`,
			`- Tasks completed: ${fmt(result.tasksCompleted)}`,
			`- Total iterations: ${fmt(result.totalIterations)}`,
			durationLine,
			'',
			'## Tool Call Totals',
			`- Total: ${fmt(totalTools)}`,
			`  - Task-master: ${fmt(totalTM)}`,
			`  - Writes: ${fmt(totalWrites)}`,
			`  - Non-writes: ${fmt(totalNW)}`,
			'',
			'## Token Totals',
			`- Input: ${fmt(totalInput)}`,
			`- Output: ${fmt(totalOutput)}`,
			`- Cache read: ${fmt(totalCacheRead)}`,
			`- Cache write: ${fmt(totalCacheWrite)}`,
			`- Total: ${fmt(totalTokens)}`,
			`- Estimated context: ${fmt(totalContext)} tokens`,
			`- Uncached: ${fmt(totalInput + totalOutput)}`,
			`- % of ctx uncached: ${totalContextWindow === 0 ? '—' : (((totalInput + totalOutput) / totalContextWindow) * 100).toFixed(1) + '%'}`,
			'',
			'## Per-Iteration Summary',
			tableHeader,
			tableSep,
			tableRows,
			'',
			...(testPhaseTelemetry && testPhaseTelemetry.length > 0
				? [
						'## Test Phases',
						`- Total test phases: ${testPhaseTelemetry.length}`,
						'',
						'| Parent SHA | Status | Duration | Test commit SHA |',
						'|------------|--------|----------|-----------------|',
						...testPhaseTelemetry.map(
							(t) =>
								`| ${t.parentSha} | ${t.status} | ${t.duration !== undefined ? `${t.duration}ms` : '—'} | ${t.testCommitSha ?? '—'} |`
						),
						''
					]
				: [])
		].join('\n');

		await writeFile(this.totalsFilePath(progressFile), content, 'utf-8');
	}

	private truncateForFile(text: string, maxChars = 10_000): string {
		if (text.length <= maxChars) return text;
		const remaining = text.length - maxChars;
		return `${text.slice(0, maxChars)}… [truncated, ${remaining} more chars]`;
	}

	/**
	 * Builds a commit body from accumulated summaries.
	 * Drops oldest entries first when bytes exceed maxBytes.
	 */
	private truncateForCommit(
		entries: { iterationNum: number; text: string }[],
		maxBytes = 10_240
	): string {
		let body = entries.map((e) => `- [${e.iterationNum}] ${e.text}`).join('\n');
		if (Buffer.byteLength(body, 'utf8') <= maxBytes) return body;

		let dropped = 0;
		let working = [...entries];
		while (working.length > 0 && Buffer.byteLength(body, 'utf8') > maxBytes) {
			working.shift();
			dropped++;
			body = working.map((e) => `- [${e.iterationNum}] ${e.text}`).join('\n');
		}
		return `[${dropped} earlier summaries truncated]\n${body}`;
	}

	private async commitBatch(
		trigger: 'timer' | 'finalize',
		config: LoopConfig
	): Promise<void> {
		if (!existsSync(path.join(this.projectRoot, '.git'))) return;
		try {
			const gitAdapter = new GitAdapter(this.projectRoot);
			const excludes = this.progressFileExcludes(config.progressFile);

			await gitAdapter.stageAllWithExcludes(excludes);

			if (!(await gitAdapter.hasStagedChanges())) return;

			const body = this.truncateForCommit(this.pendingSummaries);
			const preset =
				typeof config.prompt === 'string' ? config.prompt : 'default';
			const prefix = LoopService.PRESET_COMMIT_PREFIX[preset] ?? 'feat';
			const tag = config.tag ? ` [tag ${config.tag}]` : '';
			const subject = `${prefix}(loop): ${this.pendingSummaries.length} iterations${tag}`;
			const message = body ? `${subject}\n\n${body}` : subject;

			let sha: string | undefined;
			await gitAdapter.createCommit(message, {});
			const last = await gitAdapter.getLastCommit();
			sha = typeof last?.hash === 'string' ? last.hash.slice(0, 7) : undefined;

			if (sha && trigger === 'finalize') {
				await this.runTestPhase(sha, config, this.loopStartRef);
			}

			await config.callbacks?.onBatchCommit?.({
				sha,
				trigger,
				summaryCount: this.pendingSummaries.length,
				bodyBytes: Buffer.byteLength(body, 'utf8')
			});
		} catch (err) {
			this.logger.warn('commitBatch: git operation failed', err);
		}
	}

	private async runTestPhase(
		endSha: string,
		config: LoopConfig,
		startRef?: string
	): Promise<void> {
		const startTime = Date.now();
		config.callbacks?.onTestPhaseStart?.(endSha);

		const rangeDesc = startRef ? `${startRef}..${endSha}` : endSha;

		let result: TestPhaseResult;
		try {
			const sessionId: string = randomUUID();
			const level = config.traceLevel ?? 'none';

			const preset = makePostCommitTestPreset(rangeDesc);
			const prompt = preset.initial({ projectRoot: this.projectRoot });

			const iteration = await this.executeIteration(
				prompt,
				0, // sentinel — out-of-band, not counted in user budget
				config.sandbox ?? false,
				false,
				level,
				undefined, // no callbacks — test phase uses its own channel
				config.progressFile,
				1,
				sessionId,
				false // isResume = false — fresh session
			);

			// Map LoopIteration status → TestPhaseResult status
			let status: TestPhaseResult['status'];
			if (
				iteration.status === 'complete' &&
				iteration.message === 'NOTHING_TO_TEST'
			) {
				status = 'nothing_to_test';
			} else if (iteration.status === 'complete') {
				status = 'tests_added';
			} else if (iteration.status === 'blocked') {
				status = 'blocked';
			} else {
				status = 'error';
			}

			// Stage and commit test changes (direct, not recursive commitBatch)
			let testCommitSha: string | undefined;
			if (existsSync(path.join(this.projectRoot, '.git'))) {
				const testGitAdapter = new GitAdapter(this.projectRoot);
				const excludes = this.progressFileExcludes(config.progressFile);

				await testGitAdapter.stageAllWithExcludes(excludes);
				if (await testGitAdapter.hasStagedChanges()) {
					const summaryLine = iteration.summary ?? '';
					const commitBody = summaryLine
						? `test(loop): golden path for ${rangeDesc}\n\n${summaryLine}\n\nRange: ${rangeDesc}\nTrigger: post-commit-test-phase`
						: `test(loop): golden path for ${rangeDesc}\n\nRange: ${rangeDesc}\nTrigger: post-commit-test-phase`;
					await testGitAdapter.createCommit(commitBody, {});
					const testLast = await testGitAdapter.getLastCommit();
					testCommitSha =
						typeof testLast?.hash === 'string'
							? testLast.hash.slice(0, 7)
							: undefined;
				}
			}

			result = {
				parentSha: endSha,
				status,
				summary: iteration.summary,
				message: iteration.message,
				duration: Date.now() - startTime,
				testCommitSha
			};
		} catch (err) {
			this.logger.warn('runTestPhase: unexpected error', err);
			result = {
				parentSha: endSha,
				status: 'error',
				message: err instanceof Error ? err.message : String(err),
				duration: Date.now() - startTime
			};
		}

		this.testPhases.push(result);
		this.testPhaseTelemetry.push({
			parentSha: endSha,
			duration: result.duration,
			status: result.status,
			testCommitSha: result.testCommitSha
		});

		config.callbacks?.onTestPhaseEnd?.(result);
	}

	private formatJsonBlockForFile(value: unknown): string {
		let json: string;
		try {
			json = JSON.stringify(value, null, 2);
		} catch {
			json = String(value);
		}
		return '```json\n' + this.truncateForFile(json) + '\n```';
	}

	private buildIterationSummaryBlock(summary: {
		toolCalls: Array<{ name: string; count: number }>;
		finalResult?: string;
		tokenUsage?: {
			inputTokens: number;
			outputTokens: number;
			cacheCreationInputTokens?: number;
			cacheReadInputTokens?: number;
			totalTokens: number;
		};
		totalToolCalls?: number;
		taskMasterToolCalls?: number;
		writeToolCalls?: number;
		nonWriteToolCalls?: number;
		estimatedContext?: number;
		contextPercent?: number;
		modelId?: string;
	}): string {
		const fmt = (n: number) => n.toLocaleString('en-US');
		const lines: string[] = ['## Summary', ''];

		if (summary.totalToolCalls !== undefined) {
			lines.push(`- **Tool calls:** ${fmt(summary.totalToolCalls)} total`);
			if (summary.taskMasterToolCalls !== undefined)
				lines.push(`  - Task-master: ${fmt(summary.taskMasterToolCalls)}`);
			if (summary.writeToolCalls !== undefined)
				lines.push(`  - Writes: ${fmt(summary.writeToolCalls)}`);
			if (summary.nonWriteToolCalls !== undefined)
				lines.push(`  - Non-writes: ${fmt(summary.nonWriteToolCalls)}`);
		}

		if (summary.toolCalls.length > 0) {
			lines.push('- **Tool calls by name:**');
			for (const tc of summary.toolCalls) {
				lines.push(`  - \`${tc.name}\`: ${fmt(tc.count)}`);
			}
		}

		if (summary.tokenUsage) {
			const u = summary.tokenUsage;
			lines.push('- **Tokens:**');
			lines.push(`  - Input: ${fmt(u.inputTokens)}`);
			lines.push(`  - Output: ${fmt(u.outputTokens)}`);
			if (u.cacheCreationInputTokens !== undefined) {
				lines.push(`  - Cache write: ${fmt(u.cacheCreationInputTokens)}`);
			}
			if (u.cacheReadInputTokens !== undefined) {
				lines.push(`  - Cache read: ${fmt(u.cacheReadInputTokens)}`);
			}
			lines.push(`  - Total: ${fmt(u.totalTokens)}`);
		}

		if (summary.estimatedContext !== undefined) {
			const pct =
				summary.contextPercent !== undefined
					? ` (${summary.contextPercent.toFixed(1)}% of ctx)`
					: '';
			lines.push(
				`- **Context:** ${fmt(summary.estimatedContext)} tokens${pct}`
			);
		}

		if (summary.finalResult) {
			lines.push('- **Final result:**');
			lines.push('');
			lines.push('```text');
			lines.push(this.truncateForFile(summary.finalResult));
			lines.push('```');
		}

		return lines.join('\n');
	}

	private isPreset(name: string): name is LoopPreset {
		return checkIsPreset(name);
	}

	private async resolvePrompt(
		prompt: string,
		nextTask?: PrefetchedTask | null
	): Promise<string> {
		if (this.isPreset(prompt)) {
			return PRESETS[prompt].initial({
				projectRoot: this.projectRoot,
				nextTask
			});
		}
		const content = await readFile(prompt, 'utf-8');
		if (!content.trim()) {
			throw new Error(`Custom prompt file '${prompt}' is empty`);
		}
		return content;
	}

	private buildContextHeader(config: LoopConfig, iteration: number): string {
		const tagInfo = config.tag ? ` (tag: ${config.tag})` : '';
		// Note: explicit @progressFile / @CLAUDE.md references removed - let the prompt opt in to extra context when needed
		return `Loop iteration ${iteration} of ${config.iterations}${tagInfo}`;
	}

	private async buildPrompt(
		config: LoopConfig,
		iteration: number,
		nextTask?: PrefetchedTask | null
	): Promise<string> {
		const basePrompt = await this.resolvePrompt(config.prompt, nextTask);
		return `${this.buildContextHeader(config, iteration)}\n\n${basePrompt}`;
	}

	/**
	 * Pull a token-usage snapshot out of a stream-json `result` event.
	 *
	 * Returns undefined when the event has no usage payload or every token
	 * count is zero/missing - so callers can decide to suppress empty rows
	 * (e.g. older Claude CLI versions, aborted runs).
	 */
	private extractTokenUsage(event: {
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	}): LoopTokenUsage | undefined {
		const u = event.usage;
		if (!u || typeof u !== 'object') return undefined;

		const num = (v: unknown): number | undefined =>
			typeof v === 'number' && Number.isFinite(v) ? v : undefined;
		const inputTokens = num(u.input_tokens) ?? 0;
		const outputTokens = num(u.output_tokens) ?? 0;
		const cacheCreationInputTokens = num(u.cache_creation_input_tokens);
		const cacheReadInputTokens = num(u.cache_read_input_tokens);

		if (
			inputTokens === 0 &&
			outputTokens === 0 &&
			cacheCreationInputTokens === undefined &&
			cacheReadInputTokens === undefined
		) {
			return undefined;
		}

		const totalTokens =
			inputTokens +
			outputTokens +
			(cacheCreationInputTokens ?? 0) +
			(cacheReadInputTokens ?? 0);

		return {
			inputTokens,
			outputTokens,
			...(cacheCreationInputTokens !== undefined && {
				cacheCreationInputTokens
			}),
			...(cacheReadInputTokens !== undefined && { cacheReadInputTokens }),
			totalTokens
		};
	}

	private classifyToolCalls(counts: Map<string, number>): {
		totalToolCalls: number;
		taskMasterToolCalls: number;
		writeToolCalls: number;
		nonWriteToolCalls: number;
	} {
		let total = 0,
			tm = 0,
			writes = 0;
		for (const [name, count] of counts) {
			total += count;
			if (name.startsWith('mcp__task-master-ai__')) tm += count;
			if (LoopService.WRITE_TOOLS.has(name)) writes += count;
		}
		return {
			totalToolCalls: total,
			taskMasterToolCalls: tm,
			writeToolCalls: writes,
			nonWriteToolCalls: total - writes
		};
	}

	private iterationFilePath(
		progressFile: string,
		iterationNum: number,
		totalIterations: number
	): string {
		const padWidth = String(totalIterations).length;
		const padded = String(iterationNum).padStart(padWidth, '0');
		const p = path.parse(progressFile);
		return path.format({
			dir: p.dir,
			name: `${p.name}.iter-${padded}`,
			ext: p.ext
		});
	}

	private totalsFilePath(progressFile: string): string {
		const p = path.parse(progressFile);
		return path.format({ dir: p.dir, name: `${p.name}.totals`, ext: p.ext });
	}

	/**
	 * Build git-exclude patterns for the whole progress-file family
	 * (main file, per-iteration sibling files, totals file). Patterns are
	 * derived from the progress file's actual extension, so renaming the
	 * default from .txt to .md — or using any custom extension — keeps these
	 * generated files out of loop commits.
	 */
	private progressFileExcludes(progressFile: string): string[] {
		const p = path.parse(progressFile);
		return [
			progressFile,
			path.join(p.dir, `${p.name}.iter-*${p.ext}`),
			path.join(p.dir, `${p.name}.totals${p.ext}`)
		].map((f) => path.relative(this.projectRoot, f).replace(/\\/g, '/'));
	}

	private buildProgressLine(
		iterationNum: number,
		status: LoopIteration['status'],
		classification: {
			totalToolCalls: number;
			taskMasterToolCalls: number;
			writeToolCalls: number;
			nonWriteToolCalls: number;
		},
		sessionId: string,
		estimatedContext?: number,
		contextPercent?: number
	): string {
		const toolPart = `tools: ${classification.totalToolCalls.toLocaleString('en-US')} (TM:${classification.taskMasterToolCalls} W:${classification.writeToolCalls} NW:${classification.nonWriteToolCalls})`;
		const ctxPart =
			estimatedContext !== undefined
				? ` | ctx: ${estimatedContext.toLocaleString('en-US')} tokens${contextPercent !== undefined ? ` (${contextPercent.toFixed(1)}% of ctx)` : ''}`
				: '';
		const sessionPart = ` | session: ${sessionId.slice(0, 8)}`;
		return `- Iter ${iterationNum}: ${status} | ${toolPart}${ctxPart}${sessionPart}`;
	}

	private parseCompletion(
		output: string,
		exitCode: number
	): { status: LoopIteration['status']; message?: string; summary?: string } {
		const completeMatch = output.match(
			/<loop-complete>([^<]*)<\/loop-complete>/i
		);
		if (completeMatch)
			return { status: 'complete', message: completeMatch[1].trim() };

		const blockedMatch = output.match(/<loop-blocked>([^<]*)<\/loop-blocked>/i);
		if (blockedMatch)
			return { status: 'blocked', message: blockedMatch[1].trim() };

		// Extract optional summary; truncate to 200 chars
		let summary: string | undefined;
		const summaryMatch = output.match(/<loop-summary>([^<]*)<\/loop-summary>/i);
		if (summaryMatch) {
			const raw = summaryMatch[1].trim();
			summary = raw.length <= 200 ? raw : `${raw.slice(0, 200)}… [truncated]`;
		}

		if (exitCode !== 0)
			return { status: 'error', message: `Exit code ${exitCode}`, summary };
		return { status: 'success', summary };
	}

	private async executeIteration(
		prompt: string,
		iterationNum: number,
		sandbox: boolean,
		includeOutput = false,
		level: LoopTraceLevel = 'none',
		callbacks?: LoopOutputCallbacks,
		progressFile?: string,
		totalIterations = 1,
		sessionId: string = randomUUID(),
		isResume: boolean = false
	): Promise<LoopIteration> {
		const startTime = Date.now();
		const command = sandbox ? 'docker' : 'claude';

		if (atLeast(level, 'verbose')) {
			return this.executeVerboseIteration(
				prompt,
				iterationNum,
				command,
				sandbox,
				includeOutput,
				level,
				startTime,
				callbacks,
				progressFile,
				totalIterations,
				sessionId,
				isResume
			);
		}

		const args = this.buildCommandArgs(
			prompt,
			sandbox,
			false,
			sessionId,
			isResume
		);
		const result = spawnSync(command, args, {
			cwd: this.projectRoot,
			encoding: 'utf-8',
			maxBuffer: 50 * 1024 * 1024,
			stdio: ['inherit', 'pipe', 'pipe']
		});

		if (result.error) {
			const errorMessage = this.formatCommandError(
				result.error,
				command,
				sandbox
			);
			this.reportError(callbacks, errorMessage);
			return this.createErrorIteration(iterationNum, startTime, errorMessage);
		}

		const output = (result.stdout || '') + (result.stderr || '');
		if (output) {
			callbacks?.onOutput?.(output);
		}

		if (result.status === null) {
			const errorMsg = 'Command terminated abnormally (no exit code)';
			this.reportError(callbacks, errorMsg);
			return this.createErrorIteration(iterationNum, startTime, errorMsg);
		}

		const { status, message, summary } = this.parseCompletion(
			output,
			result.status
		);

		if (progressFile) {
			const siblingPath = this.iterationFilePath(
				progressFile,
				iterationNum,
				totalIterations
			);
			await writeFile(
				siblingPath,
				`# Iteration ${iterationNum}\n**Session:** ${sessionId}\n`,
				'utf-8'
			);
			const line = this.buildProgressLine(
				iterationNum,
				status,
				{
					totalToolCalls: 0,
					taskMasterToolCalls: 0,
					writeToolCalls: 0,
					nonWriteToolCalls: 0
				},
				sessionId
			);
			await appendFile(progressFile, `${line}\n`, 'utf-8');
		}

		return {
			iteration: iterationNum,
			status,
			duration: Date.now() - startTime,
			message,
			summary,
			...(includeOutput && { output })
		};
	}

	/**
	 * Execute an iteration with verbose output (shows Claude's work in real-time).
	 * Uses Claude's stream-json format to display assistant messages as they arrive.
	 *
	 * When `trace` is true, also forwards tool-input/result events and emits a
	 * per-iteration tool-call summary via the iteration summary callback.
	 *
	 * @param prompt - The prompt to send to Claude
	 * @param iterationNum - Current iteration number (1-indexed)
	 * @param command - The command to execute ('claude' or 'docker')
	 * @param sandbox - Whether running in Docker sandbox mode
	 * @param includeOutput - Whether to include full output in the result
	 * @param trace - Whether to emit trace-level events (tool inputs/results/summary)
	 * @param startTime - Timestamp when iteration started (for duration calculation)
	 * @param callbacks - Optional callbacks for presentation layer output
	 * @returns Promise resolving to the iteration result
	 */
	private executeVerboseIteration(
		prompt: string,
		iterationNum: number,
		command: string,
		sandbox: boolean,
		includeOutput: boolean,
		level: LoopTraceLevel,
		startTime: number,
		callbacks?: LoopOutputCallbacks,
		progressFile?: string,
		totalIterations = 1,
		sessionId: string = randomUUID(),
		isResume: boolean = false
	): Promise<LoopIteration> {
		const args = this.buildCommandArgs(
			prompt,
			sandbox,
			true,
			sessionId,
			isResume
		);
		// Track tool-call counts for the trace-mode iteration summary
		const toolCallCounts = new Map<string, number>();

		// Per-iteration file buffer (allocated when verbose or trace + progressFile;
		// reachable only from the verbose path, which itself requires at least 'verbose').
		const iterationFileLines: string[] | undefined = progressFile
			? []
			: undefined;

		if (iterationFileLines) {
			iterationFileLines.push(`# Iteration ${iterationNum}`);
			iterationFileLines.push(`**Session:** ${sessionId}`);
			if (atLeast(level, 'trace')) {
				iterationFileLines.push(
					`## Prompt sent to Claude\n\n\`\`\`text\n${this.truncateForFile(prompt)}\n\`\`\``
				);
			}
		}

		return new Promise((resolve, reject) => {
			let settled = false;
			const resolveOnce = (result: LoopIteration): void => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
			};
			const rejectOnce = (e: unknown): void => {
				if (!settled) {
					settled = true;
					reject(e);
				}
			};

			const child = spawn(command, args, {
				cwd: this.projectRoot,
				stdio: ['inherit', 'pipe', 'pipe']
			});

			// Track stdout completion to handle race between data and close events
			let stdoutEnded = false;
			let finalResult = '';
			let tokenUsage: LoopTokenUsage | undefined;
			let modelId: string | undefined;
			let buffer = '';

			const processLine = (line: string): void => {
				if (!line.startsWith('{')) return;

				try {
					const event = JSON.parse(line);

					// Validate event structure before accessing properties
					if (!this.isValidStreamEvent(event)) {
						return;
					}

					this.handleStreamEvent(
						event,
						callbacks,
						level,
						toolCallCounts,
						iterationFileLines
					);

					// Capture final result and token-usage snapshot from the result event.
					// Always extract usage so the iteration summary block in the progress
					// file can include token counts even in verbose-only mode.
					if (event.type === 'result') {
						finalResult = typeof event.result === 'string' ? event.result : '';
						const usage = this.extractTokenUsage(event);
						if (usage) {
							tokenUsage = usage;
						}
					}
					if (
						event.type === 'system' &&
						typeof (event as Record<string, unknown>).model === 'string'
					) {
						modelId = (event as Record<string, unknown>).model as string;
					}
				} catch (error) {
					// Log malformed JSON for debugging (non-JSON lines like system output are expected)
					if (line.trim().startsWith('{')) {
						const parseError = `Failed to parse JSON event: ${error instanceof Error ? error.message : 'Unknown error'}. Line: ${line.substring(0, 100)}...`;
						this.reportError(callbacks, parseError, 'warning');
					}
				}
			};

			// Handle null stdout (shouldn't happen with pipe, but be defensive)
			if (!child.stdout) {
				resolveOnce(
					this.createErrorIteration(
						iterationNum,
						startTime,
						'Failed to capture stdout from child process'
					)
				);
				return;
			}

			child.stdout.on('data', (data: Buffer) => {
				try {
					const lines = this.processBufferedLines(
						buffer,
						data.toString('utf-8')
					);
					buffer = lines.remaining;
					for (const line of lines.complete) {
						processLine(line);
					}
				} catch (error) {
					this.reportError(
						callbacks,
						`Failed to process stdout data: ${error instanceof Error ? error.message : 'Unknown error'}`,
						'warning'
					);
				}
			});

			child.stdout.on('end', () => {
				stdoutEnded = true;
				// Process any remaining buffer when stdout ends
				if (buffer) {
					processLine(buffer);
					buffer = '';
				}
			});

			child.stderr?.on('data', (data: Buffer) => {
				const stderrText = data.toString('utf-8');
				callbacks?.onStderr?.(iterationNum, stderrText);
			});

			child.on('error', (error: NodeJS.ErrnoException) => {
				const errorMessage = this.formatCommandError(error, command, sandbox);
				this.reportError(callbacks, errorMessage);

				// Cleanup: remove listeners and kill process if still running
				child.stdout?.removeAllListeners();
				child.stderr?.removeAllListeners();
				if (!child.killed) {
					try {
						child.kill('SIGTERM');
					} catch {
						// Process may have already exited
					}
				}

				resolveOnce(
					this.createErrorIteration(iterationNum, startTime, errorMessage)
				);
			});

			child.on('close', (exitCode: number | null) => {
				// Process remaining buffer only if stdout hasn't already ended
				if (!stdoutEnded && buffer) {
					processLine(buffer);
				}

				if (exitCode === null) {
					const errorMsg = 'Command terminated abnormally (no exit code)';
					this.reportError(callbacks, errorMsg);
					resolveOnce(
						this.createErrorIteration(iterationNum, startTime, errorMsg)
					);
					return;
				}

				// Compute classification data — shared by onIterationSummary and file routing
				const toolCalls = Array.from(toolCallCounts.entries())
					.map(([name, count]) => ({ name, count }))
					.sort((a, b) => b.count - a.count);
				const classification = this.classifyToolCalls(toolCallCounts);
				const estimatedContext =
					(tokenUsage?.inputTokens ?? 0) +
					(tokenUsage?.cacheCreationInputTokens ?? 0) +
					(tokenUsage?.cacheReadInputTokens ?? 0);
				const contextPercent =
					tokenUsage != null
						? (estimatedContext / contextWindowFor(modelId)) * 100
						: undefined;

				// Trace mode: emit aggregated tool-call summary, final result, and token usage
				if (atLeast(level, 'trace') && callbacks?.onIterationSummary) {
					callbacks.onIterationSummary(iterationNum, {
						toolCalls,
						finalResult: finalResult || undefined,
						...(tokenUsage && { tokenUsage }),
						totalToolCalls: classification.totalToolCalls,
						taskMasterToolCalls: classification.taskMasterToolCalls,
						writeToolCalls: classification.writeToolCalls,
						nonWriteToolCalls: classification.nonWriteToolCalls,
						estimatedContext,
						...(contextPercent !== undefined && { contextPercent }),
						...(modelId !== undefined && { modelId })
					});
				}

				// Route per-iteration verbose buffer to sibling file; write compact line to progress.md
				if (iterationFileLines) {
					const { status: iterStatus } = this.parseCompletion(
						finalResult,
						exitCode
					);

					iterationFileLines.push(
						this.buildIterationSummaryBlock({
							toolCalls,
							finalResult: finalResult || undefined,
							...(tokenUsage && { tokenUsage }),
							...classification,
							estimatedContext,
							...(contextPercent !== undefined && { contextPercent }),
							...(modelId !== undefined && { modelId })
						})
					);
					iterationFileLines.push('---');

					const siblingPath = this.iterationFilePath(
						progressFile!,
						iterationNum,
						totalIterations
					);
					writeFile(
						siblingPath,
						iterationFileLines.join('\n\n') + '\n',
						'utf-8'
					).catch((err: unknown) => {
						rejectOnce(err);
					});

					appendFile(
						progressFile!,
						this.buildProgressLine(
							iterationNum,
							iterStatus,
							classification,
							sessionId,
							estimatedContext,
							contextPercent
						) + '\n',
						'utf-8'
					).catch((err: unknown) => {
						rejectOnce(err);
					});

					this.iterationTelemetry.push({
						iterationNum,
						...classification,
						tokenUsage: tokenUsage ?? undefined,
						estimatedContext,
						...(contextPercent !== undefined && { contextPercent }),
						...(modelId !== undefined && { modelId }),
						status: iterStatus,
						duration: Date.now() - startTime
					});
				}

				const { status, message, summary } = this.parseCompletion(
					finalResult,
					exitCode
				);
				resolveOnce({
					iteration: iterationNum,
					status,
					duration: Date.now() - startTime,
					message,
					summary,
					...(includeOutput && { output: finalResult }),
					...(contextPercent !== undefined && { contextPercent })
				});
			});
		});
	}

	/**
	 * Validate that a parsed JSON object has the expected stream event structure.
	 *
	 * Content blocks may include:
	 *  - assistant text:        { type: 'text', text: string }
	 *  - assistant tool_use:    { type: 'tool_use', name: string, input?: unknown }
	 *  - user tool_result:      { type: 'tool_result', tool_use_id?: string, content?: unknown }
	 *
	 * Result events additionally carry a `usage` field with token counts.
	 */
	private isValidStreamEvent(event: unknown): event is {
		type: string;
		message?: {
			content?: Array<{
				type: string;
				text?: string;
				name?: string;
				input?: unknown;
				tool_use_id?: string;
				content?: unknown;
			}>;
		};
		result?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	} {
		if (!event || typeof event !== 'object') {
			return false;
		}

		const e = event as Record<string, unknown>;
		if (!('type' in e) || typeof e.type !== 'string') {
			return false;
		}

		// Validate message structure if present
		if ('message' in e && e.message !== undefined) {
			if (typeof e.message !== 'object' || e.message === null) {
				return false;
			}
			const msg = e.message as Record<string, unknown>;
			if ('content' in msg && !Array.isArray(msg.content)) {
				return false;
			}
		}

		return true;
	}

	private buildCommandArgs(
		prompt: string,
		sandbox: boolean,
		verbose: boolean,
		sessionId: string,
		isResume?: boolean
	): string[] {
		if (sandbox) {
			const args = ['sandbox', 'run', 'claude', '-p', prompt];
			args.push(isResume ? '--resume' : '--session-id', sessionId);
			return args;
		}

		const args = ['-p', prompt, '--dangerously-skip-permissions'];
		if (verbose) {
			// Use stream-json format to show Claude's work in real-time
			args.push('--output-format', 'stream-json', '--verbose');
		}
		args.push(isResume ? '--resume' : '--session-id', sessionId);
		return args;
	}

	private formatCommandError(
		error: NodeJS.ErrnoException,
		command: string,
		sandbox: boolean
	): string {
		if (error.code === 'ENOENT') {
			return sandbox
				? 'Docker is not installed. Install Docker Desktop to use --sandbox mode.'
				: 'Claude Code CLI is not installed. Install it from: https://docs.anthropic.com/en/docs/claude-code/getting-started';
		}

		if (error.code === 'EACCES') {
			return `Permission denied executing '${command}'`;
		}

		return `Failed to execute '${command}': ${error.message}`;
	}

	private createErrorIteration(
		iterationNum: number,
		startTime: number,
		message: string
	): LoopIteration {
		return {
			iteration: iterationNum,
			status: 'error',
			duration: Date.now() - startTime,
			message
		};
	}

	private handleStreamEvent(
		event: {
			type: string;
			message?: {
				content?: Array<{
					type: string;
					text?: string;
					name?: string;
					input?: unknown;
					tool_use_id?: string;
					content?: unknown;
				}>;
			};
		},
		callbacks?: LoopOutputCallbacks,
		level: LoopTraceLevel = 'none',
		toolCallCounts?: Map<string, number>,
		iterationFileLines?: string[]
	): void {
		if (!event.message?.content) return;

		if (event.type === 'assistant') {
			for (const block of event.message.content) {
				if (block.type === 'text' && block.text) {
					callbacks?.onText?.(block.text);
				} else if (block.type === 'tool_use' && block.name) {
					callbacks?.onToolUse?.(block.name);
					// Always tally tool-call counts so the per-iteration summary block
					// in the progress file is accurate for verbose-only runs too.
					toolCallCounts?.set(
						block.name,
						(toolCallCounts.get(block.name) ?? 0) + 1
					);
					if (atLeast(level, 'trace')) {
						if (block.input !== undefined) {
							callbacks?.onToolInput?.(block.name, block.input);
							iterationFileLines?.push(
								`### \`${block.name}\` input\n\n` +
									this.formatJsonBlockForFile(block.input)
							);
						}
					}
				}
			}
			return;
		}

		// In trace mode, tool_result blocks come back on `user` events.
		if (atLeast(level, 'trace') && event.type === 'user') {
			for (const block of event.message.content) {
				if (block.type === 'tool_result') {
					callbacks?.onToolResult?.(block.name, block.content);
					const label = block.name ?? 'unknown';
					iterationFileLines?.push(
						`### \`${label}\` result\n\n` +
							this.formatJsonBlockForFile(block.content)
					);
				}
			}
		}
	}

	private processBufferedLines(
		buffer: string,
		newData: string
	): { complete: string[]; remaining: string } {
		const combined = buffer + newData;
		const lines = combined.split('\n');
		return {
			complete: lines.slice(0, -1),
			remaining: lines[lines.length - 1]
		};
	}
}
