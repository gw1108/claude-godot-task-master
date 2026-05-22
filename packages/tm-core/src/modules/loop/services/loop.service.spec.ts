/**
 * @fileoverview Unit tests for simplified LoopService
 * Tests the synchronous spawnSync-based implementation
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
	type MockInstance
} from 'vitest';
import { LoopService, type LoopServiceOptions } from './loop.service.js';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';

// Mock child_process, node:fs, and fs/promises
vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:fs/promises');

describe('LoopService', () => {
	const defaultOptions: LoopServiceOptions = {
		projectRoot: '/test/project'
	};

	let mockSpawnSync: MockInstance;

	beforeEach(() => {
		vi.resetAllMocks();
		// Default fs/promises mocks
		vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
		vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
		vi.mocked(fsPromises.appendFile).mockResolvedValue(undefined);

		// Default node:fs mocks — MCP config is present and contains task-master-ai
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ mcpServers: { 'task-master-ai': { command: 'npx' } } })
		);

		// Default spawnSync mock
		mockSpawnSync = vi.mocked(childProcess.spawnSync);

		// Suppress console output in tests
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('constructor', () => {
		it('should create a LoopService instance with required options', () => {
			const service = new LoopService(defaultOptions);
			expect(service).toBeInstanceOf(LoopService);
		});

		it('should store projectRoot from options', () => {
			const service = new LoopService(defaultOptions);
			expect(service.getProjectRoot()).toBe('/test/project');
		});

		it('should initialize isRunning to false', () => {
			const service = new LoopService(defaultOptions);
			expect(service.isRunning).toBe(false);
		});
	});

	describe('service instantiation with different project roots', () => {
		it('should work with absolute path', () => {
			const service = new LoopService({
				projectRoot: '/absolute/path/to/project'
			});
			expect(service.getProjectRoot()).toBe('/absolute/path/to/project');
		});

		it('should work with Windows-style path', () => {
			const service = new LoopService({
				projectRoot: 'C:\\Users\\test\\project'
			});
			expect(service.getProjectRoot()).toBe('C:\\Users\\test\\project');
		});

		it('should work with empty projectRoot', () => {
			const service = new LoopService({ projectRoot: '' });
			expect(service.getProjectRoot()).toBe('');
		});
	});

	describe('service instance isolation', () => {
		it('should create independent instances', () => {
			const service1 = new LoopService(defaultOptions);
			const service2 = new LoopService(defaultOptions);
			expect(service1).not.toBe(service2);
		});

		it('should maintain independent state between instances', () => {
			const service1 = new LoopService({ projectRoot: '/project1' });
			const service2 = new LoopService({ projectRoot: '/project2' });

			expect(service1.getProjectRoot()).toBe('/project1');
			expect(service2.getProjectRoot()).toBe('/project2');
		});
	});

	describe('stop()', () => {
		it('should set isRunning to false', () => {
			const service = new LoopService(defaultOptions);
			// Access private field via any cast for testing
			(service as unknown as { _isRunning: boolean })._isRunning = true;
			expect(service.isRunning).toBe(true);

			service.stop();

			expect(service.isRunning).toBe(false);
		});

		it('should be safe to call multiple times', () => {
			const service = new LoopService(defaultOptions);
			service.stop();
			service.stop();
			service.stop();

			expect(service.isRunning).toBe(false);
		});
	});

	describe('checkSandboxAuth()', () => {
		it('should return ready=true when output contains ok', () => {
			mockSpawnSync.mockReturnValue({
				stdout: 'OK',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			const service = new LoopService(defaultOptions);
			const result = service.checkSandboxAuth();

			expect(result.ready).toBe(true);
			expect(mockSpawnSync).toHaveBeenCalledWith(
				'docker',
				['sandbox', 'run', 'claude', '-p', 'Say OK'],
				expect.objectContaining({
					cwd: '/test/project',
					timeout: 30000
				})
			);
		});

		it('should return ready=false when output does not contain ok', () => {
			mockSpawnSync.mockReturnValue({
				stdout: 'Error: not authenticated',
				stderr: '',
				status: 1,
				signal: null,
				pid: 123,
				output: []
			});

			const service = new LoopService(defaultOptions);
			const result = service.checkSandboxAuth();

			expect(result.ready).toBe(false);
		});

		it('should check stderr as well as stdout', () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: 'OK response',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			const service = new LoopService(defaultOptions);
			const result = service.checkSandboxAuth();

			expect(result.ready).toBe(true);
		});
	});

	describe('checkMcpServerAvailable()', () => {
		it('returns available=true when .mcp.json contains the server alias', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({ mcpServers: { 'task-master-ai': { command: 'npx' } } })
			);
			const service = new LoopService(defaultOptions);
			const result = service.checkMcpServerAvailable('task-master-ai');
			expect(result.available).toBe(true);
		});

		it('returns available=false when .mcp.json does not exist', () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const service = new LoopService(defaultOptions);
			const result = service.checkMcpServerAvailable('task-master-ai');
			expect(result.available).toBe(false);
			expect(result.error).toContain('.mcp.json');
		});

		it('returns available=false when server alias is missing from mcpServers', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({ mcpServers: { 'other-server': {} } })
			);
			const service = new LoopService(defaultOptions);
			const result = service.checkMcpServerAvailable('task-master-ai');
			expect(result.available).toBe(false);
			expect(result.error).toContain('"task-master-ai"');
		});

		it('returns available=false when .mcp.json is invalid JSON', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue('not-json');
			const service = new LoopService(defaultOptions);
			const result = service.checkMcpServerAvailable('task-master-ai');
			expect(result.available).toBe(false);
			expect(result.error).toMatch(/Failed to read/);
		});
	});

	describe('runInteractiveAuth()', () => {
		it('should spawn interactive docker session', () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			const service = new LoopService(defaultOptions);
			service.runInteractiveAuth();

			expect(mockSpawnSync).toHaveBeenCalledWith(
				'docker',
				expect.arrayContaining(['sandbox', 'run', 'claude']),
				expect.objectContaining({
					cwd: '/test/project',
					stdio: 'inherit'
				})
			);
		});
	});

	describe('run()', () => {
		let service: LoopService;

		beforeEach(() => {
			service = new LoopService(defaultOptions);
		});

		describe('successful iteration run', () => {
			it('should run a single iteration successfully', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: 'Task completed',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				const result = await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.totalIterations).toBe(1);
				expect(result.tasksCompleted).toBe(1);
				expect(result.finalStatus).toBe('max_iterations');
			});

			it('should record startedAt, finishedAt, and totalDuration', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: 'Task completed',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				const before = Date.now();
				const result = await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});
				const after = Date.now();

				expect(typeof result.startedAt).toBe('string');
				expect(typeof result.finishedAt).toBe('string');
				expect(typeof result.totalDuration).toBe('number');

				// Timestamps should be valid ISO strings within the test window
				const startedMs = Date.parse(result.startedAt!);
				const finishedMs = Date.parse(result.finishedAt!);
				expect(startedMs).toBeGreaterThanOrEqual(before);
				expect(finishedMs).toBeLessThanOrEqual(after);
				expect(result.totalDuration!).toBeGreaterThanOrEqual(0);
				expect(result.totalDuration!).toBe(finishedMs - startedMs);
			});

			it('should emit onLoopStart and onLoopEnd callbacks', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: 'Task completed',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				const onLoopStart = vi.fn();
				const onLoopEnd = vi.fn();

				await service.run({
					prompt: 'default',
					iterations: 2,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					callbacks: { onLoopStart, onLoopEnd }
				});

				expect(onLoopStart).toHaveBeenCalledTimes(1);
				expect(onLoopStart).toHaveBeenCalledWith(expect.any(Date), 2);

				expect(onLoopEnd).toHaveBeenCalledTimes(1);
				const [finishedAt, totalDuration] = onLoopEnd.mock.calls[0];
				expect(finishedAt).toBeInstanceOf(Date);
				expect(typeof totalDuration).toBe('number');
				expect(totalDuration).toBeGreaterThanOrEqual(0);
			});
		});

		describe('pre-flight error timing', () => {
			it('should still record duration and call onLoopEnd when verbose+sandbox conflict aborts the run', async () => {
				const onLoopStart = vi.fn();
				const onLoopEnd = vi.fn();

				const result = await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'verbose',
					sandbox: true,
					callbacks: { onLoopStart, onLoopEnd }
				});

				expect(result.finalStatus).toBe('error');
				expect(typeof result.totalDuration).toBe('number');
				expect(typeof result.startedAt).toBe('string');
				expect(typeof result.finishedAt).toBe('string');
				// onLoopStart is gated behind iteration startup, so pre-flight failures skip it
				expect(onLoopStart).not.toHaveBeenCalled();
				// onLoopEnd should still fire so presentation layers can stamp completion
				expect(onLoopEnd).toHaveBeenCalledTimes(1);
			});
		});

		describe('successful iteration run (additional)', () => {
			it('should run multiple iterations', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: 'Done',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				const result = await service.run({
					prompt: 'default',
					iterations: 3,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.totalIterations).toBe(3);
				expect(result.tasksCompleted).toBe(3);
				// 3 claude iterations (MCP check uses node:fs, no spawnSync call)
				expect(mockSpawnSync).toHaveBeenCalledTimes(3);
			});

			it('should call spawnSync with claude -p by default (non-sandbox)', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: 'Done',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(mockSpawnSync).toHaveBeenCalledWith(
					'claude',
					expect.arrayContaining(['-p', expect.any(String)]),
					expect.objectContaining({
						cwd: '/test/project'
					})
				);
			});
		});

		describe('mcp precondition', () => {
			it('should fail fast for default preset when .mcp.json is missing', async () => {
				vi.mocked(fs.existsSync).mockReturnValue(false);

				const result = await service.run({
					prompt: 'default',
					iterations: 5,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.finalStatus).toBe('error');
				expect(result.totalIterations).toBe(0);
				expect(result.errorMessage).toContain('.mcp.json');
				// No iterations spawned when precondition fails
				expect(mockSpawnSync).not.toHaveBeenCalledWith(
					'claude',
					expect.any(Array),
					expect.any(Object)
				);
			});

			it('should fail fast for default preset when task-master-ai is not in mcpServers', async () => {
				vi.mocked(fs.existsSync).mockReturnValue(true);
				vi.mocked(fs.readFileSync).mockReturnValue(
					JSON.stringify({ mcpServers: { 'other-server': {} } })
				);

				const result = await service.run({
					prompt: 'default',
					iterations: 5,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.finalStatus).toBe('error');
				expect(result.totalIterations).toBe(0);
				expect(result.errorMessage).toContain('"task-master-ai"');
			});

			it('should skip precondition for non-default presets', async () => {
				// Override to unavailable — proves precondition is not checked for non-default presets
				vi.mocked(fs.existsSync).mockReturnValue(false);
				mockSpawnSync.mockReturnValue({
					stdout: 'Done',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				// Only the single claude iteration — no task-master or MCP spawnSync calls
				expect(mockSpawnSync).toHaveBeenCalledTimes(1);
				expect(mockSpawnSync).not.toHaveBeenCalledWith(
					'task-master',
					expect.any(Array),
					expect.any(Object)
				);
			});

			it('should skip precondition in sandbox mode', async () => {
				// Override to unavailable — proves precondition is not checked in sandbox mode
				vi.mocked(fs.existsSync).mockReturnValue(false);
				mockSpawnSync.mockReturnValue({
					stdout: 'Done',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					sandbox: true
				});

				expect(mockSpawnSync).not.toHaveBeenCalledWith(
					'task-master',
					expect.any(Array),
					expect.any(Object)
				);
			});
		});

		describe('completion marker detection', () => {
			it('should detect loop-complete marker and exit early', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: '<loop-complete>ALL_DONE</loop-complete>',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				const result = await service.run({
					prompt: 'default',
					iterations: 5,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.totalIterations).toBe(1);
				expect(result.finalStatus).toBe('all_complete');
			});

			it('should detect loop-blocked marker and exit early', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: '<loop-blocked>Missing API key</loop-blocked>',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				const result = await service.run({
					prompt: 'default',
					iterations: 5,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.totalIterations).toBe(1);
				expect(result.finalStatus).toBe('blocked');
			});
		});

		describe('error handling', () => {
			it('should handle non-zero exit code', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: '',
					stderr: 'Error occurred',
					status: 1,
					signal: null,
					pid: 123,
					output: []
				});

				const result = await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.iterations[0].status).toBe('error');
				expect(result.tasksCompleted).toBe(0);
			});

			it('should handle null status as error', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: '',
					stderr: '',
					status: null,
					signal: 'SIGTERM',
					pid: 123,
					output: []
				});

				const result = await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.iterations[0].status).toBe('error');
			});
		});

		describe('trace mode', () => {
			it('should reject trace + sandbox combination with --trace-specific message', async () => {
				const result = await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					sandbox: true,
					traceLevel: 'trace'
				});

				expect(result.finalStatus).toBe('error');
				expect(result.errorMessage).toContain('--tracelevel trace');
				// No child process should be spawned when validation fails
				expect(mockSpawnSync).not.toHaveBeenCalled();
			});

			it('should reject verbose + sandbox combination with --verbose-specific message', async () => {
				const result = await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					sandbox: true,
					traceLevel: 'verbose'
				});

				expect(result.finalStatus).toBe('error');
				expect(result.errorMessage).toContain('--tracelevel verbose');
				expect(mockSpawnSync).not.toHaveBeenCalled();
			});

			it('should forward trace-only callbacks through stream event handler', () => {
				const onText = vi.fn();
				const onToolUse = vi.fn();
				const onToolInput = vi.fn();
				const onToolResult = vi.fn();

				const toolCallCounts = new Map<string, number>();
				const handleStreamEvent = (
					service as unknown as {
						handleStreamEvent: (
							event: unknown,
							callbacks: unknown,
							level?: 'none' | 'verbose' | 'trace',
							counts?: Map<string, number>
						) => void;
					}
				).handleStreamEvent.bind(service);

				// Assistant message: text + tool_use with input
				handleStreamEvent(
					{
						type: 'assistant',
						message: {
							content: [
								{ type: 'text', text: 'analysing...' },
								{
									type: 'tool_use',
									name: 'Bash',
									input: { command: 'ls' }
								}
							]
						}
					},
					{ onText, onToolUse, onToolInput, onToolResult },
					'trace',
					toolCallCounts
				);

				// User message: tool_result block
				handleStreamEvent(
					{
						type: 'user',
						message: {
							content: [{ type: 'tool_result', content: 'output' }]
						}
					},
					{ onText, onToolUse, onToolInput, onToolResult },
					'trace',
					toolCallCounts
				);

				expect(onText).toHaveBeenCalledWith('analysing...');
				expect(onToolUse).toHaveBeenCalledWith('Bash');
				expect(onToolInput).toHaveBeenCalledWith('Bash', { command: 'ls' });
				expect(onToolResult).toHaveBeenCalledWith(undefined, 'output');
				expect(toolCallCounts.get('Bash')).toBe(1);
			});

			it('should NOT emit trace-only callbacks when trace=false', () => {
				const onText = vi.fn();
				const onToolUse = vi.fn();
				const onToolInput = vi.fn();
				const onToolResult = vi.fn();

				const handleStreamEvent = (
					service as unknown as {
						handleStreamEvent: (
							event: unknown,
							callbacks: unknown,
							level?: 'none' | 'verbose' | 'trace',
							counts?: Map<string, number>
						) => void;
					}
				).handleStreamEvent.bind(service);

				handleStreamEvent(
					{
						type: 'assistant',
						message: {
							content: [
								{
									type: 'tool_use',
									name: 'Bash',
									input: { command: 'ls' }
								}
							]
						}
					},
					{ onText, onToolUse, onToolInput, onToolResult },
					'none'
				);

				handleStreamEvent(
					{
						type: 'user',
						message: {
							content: [{ type: 'tool_result', content: 'output' }]
						}
					},
					{ onText, onToolUse, onToolInput, onToolResult },
					'none'
				);

				expect(onToolUse).toHaveBeenCalledWith('Bash');
				expect(onToolInput).not.toHaveBeenCalled();
				expect(onToolResult).not.toHaveBeenCalled();
			});
		});

		describe('progress file operations', () => {
			it('should initialize progress file at start', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: '',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: 'default',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(fsPromises.mkdir).toHaveBeenCalledWith('/test', {
					recursive: true
				});
				// Uses appendFile instead of writeFile to preserve existing progress
				expect(fsPromises.appendFile).toHaveBeenCalledWith(
					'/test/progress.txt',
					expect.stringContaining('# Taskmaster Loop Progress'),
					'utf-8'
				);
			});

			it('should append final summary at end', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: '',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: 'default',
					iterations: 2,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(fsPromises.appendFile).toHaveBeenCalledWith(
					'/test/progress.txt',
					expect.stringContaining('# Loop Complete'),
					'utf-8'
				);
			});
		});

		describe('trace file persistence', () => {
			function makeMockSpawnChild(
				stdoutLines: string[] = [],
				exitCode: number | null = 0
			) {
				const child = new EventEmitter();
				const stdout = new EventEmitter();
				const stderr = new EventEmitter();

				Object.assign(child, {
					stdout,
					stderr,
					killed: false,
					kill: vi.fn(),
					pid: 99999
				});

				setImmediate(() => {
					for (const line of stdoutLines) {
						stdout.emit('data', Buffer.from(line + '\n', 'utf-8'));
					}
					stdout.emit('end');
					child.emit('close', exitCode);
				});

				return child;
			}

			it('test 1 — sibling iter file contains prompt text without ANSI escape sequences', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'trace'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.iter-')
				);
				expect(iterCall).toBeDefined();
				expect(iterCall![1] as string).toContain('## [VERBOSE] Iteration');
				expect(iterCall![1] as string).not.toMatch(/\x1b\[[0-9;]*m/);
			});

			it('test 2 — tool input JSON in sibling iter file is pretty-printed and capped at 10 KB', async () => {
				const bigInput = { data: 'x'.repeat(15_000) };
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({
							type: 'assistant',
							message: {
								content: [
									{
										type: 'tool_use',
										name: 'Bash',
										input: bigInput
									}
								]
							}
						}),
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'trace'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p, c]) =>
						typeof p === 'string' &&
						(p as string).includes('.iter-') &&
						typeof c === 'string' &&
						(c as string).includes('```json')
				);
				expect(iterCall).toBeDefined();
				expect(iterCall![1] as string).toContain('… [truncated,');
			});

			it('test 3 — token-usage rows in sibling iter file use specified markdown', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({
							type: 'result',
							result: 'done',
							usage: { input_tokens: 1234, output_tokens: 567 }
						})
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'trace'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p, c]) =>
						typeof p === 'string' &&
						(p as string).includes('.iter-') &&
						typeof c === 'string' &&
						(c as string).includes('summary')
				);
				expect(iterCall).toBeDefined();
				expect(iterCall![1] as string).toContain('input: 1,234');
				expect(iterCall![1] as string).toContain('output: 567');
				expect(iterCall![1] as string).toContain('total: 1,801');
			});

			it('test 4 — multiple tool_use blocks produce exactly one sibling iter file with ## Iteration marker', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({
							type: 'assistant',
							message: {
								content: [
									{
										type: 'tool_use',
										name: 'Bash',
										input: { command: 'ls' }
									}
								]
							}
						}),
						JSON.stringify({
							type: 'assistant',
							message: {
								content: [
									{
										type: 'tool_use',
										name: 'Read',
										input: { file: 'foo.txt' }
									}
								]
							}
						}),
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'trace'
				});

				const iterCalls = vi
					.mocked(fsPromises.writeFile)
					.mock.calls.filter(
						([p]) => typeof p === 'string' && (p as string).includes('.iter-')
					);
				expect(iterCalls).toHaveLength(1);
				expect(iterCalls[0][1] as string).toContain('## [VERBOSE] Iteration 1');
			});

			it('test 5 — truncation marker appears when payload exceeds 10 KB', () => {
				const svc = service as unknown as {
					truncateForFile: (s: string, n?: number) => string;
				};
				const longStr = 'a'.repeat(10_001);
				const result = svc.truncateForFile(longStr);
				expect(result).toContain('… [truncated, 1 more chars]');
				expect(result.startsWith('a'.repeat(10_000))).toBe(true);
			});

			it('tags verbose-minimum lines with [VERBOSE] in the sibling iter file', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'verbose'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.iter-')
				);
				expect(iterCall).toBeDefined();
				const content = iterCall![1] as string;
				expect(content).toContain('## [VERBOSE] Iteration 1');
				expect(content).toContain('### [VERBOSE] Iteration 1 summary');
				// Separator passes through untagged
				expect(content).toContain('---');
				expect(content).not.toContain('[VERBOSE] ---');
			});

			it('tags trace-minimum lines with [TRACE] and verbose-minimum with [VERBOSE]', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({
							type: 'assistant',
							message: {
								content: [
									{
										type: 'tool_use',
										id: 'tu1',
										name: 'bash',
										input: { cmd: 'ls' }
									}
								]
							}
						}),
						JSON.stringify({
							type: 'user',
							message: {
								content: [
									{
										type: 'tool_result',
										tool_use_id: 'tu1',
										content: 'file.txt'
									}
								]
							}
						}),
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'trace'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.iter-')
				);
				expect(iterCall).toBeDefined();
				const content = iterCall![1] as string;

				// Verbose-minimum headers
				expect(content).toContain('## [VERBOSE] Iteration 1');
				expect(content).toContain('### [VERBOSE] Iteration 1 summary');

				// Trace-minimum headers
				expect(content).toContain('### [TRACE] LLM input');
				expect(content).toContain('### [TRACE] Tool: bash input');
				// tool_result blocks don't carry a name field in Claude's API → label is 'unknown'
				expect(content).toContain('### [TRACE] Tool: unknown result');

				// Fence markers pass through untagged
				expect(content).not.toContain('[TRACE] ```');
				expect(content).not.toContain('[VERBOSE] ```');
			});

			it('prefixes body lines in iteration summary block with [VERBOSE]', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({
							type: 'result',
							result: 'done',
							usage: { input_tokens: 100, output_tokens: 50 }
						})
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'verbose'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.iter-')
				);
				expect(iterCall).toBeDefined();
				const content = iterCall![1] as string;
				// Body bullet lines should be prefixed
				expect(content).toMatch(/\[VERBOSE\] - Tokens:/);
				expect(content).toMatch(/\[VERBOSE\]   - input:/);
				expect(content).toMatch(/\[VERBOSE\]   - output:/);
			});
		});

		describe('per-iteration file routing', () => {
			function makeMockSpawnChild(
				stdoutLines: string[] = [],
				exitCode: number | null = 0
			) {
				const child = new EventEmitter();
				const stdout = new EventEmitter();
				const stderr = new EventEmitter();

				Object.assign(child, {
					stdout,
					stderr,
					killed: false,
					kill: vi.fn(),
					pid: 99999
				});

				setImmediate(() => {
					for (const line of stdoutLines) {
						stdout.emit('data', Buffer.from(line + '\n', 'utf-8'));
					}
					stdout.emit('end');
					child.emit('close', exitCode);
				});

				return child;
			}

			it('classifies task-master, write, and non-write tool calls correctly', () => {
				const svc = service as unknown as {
					classifyToolCalls: (counts: Map<string, number>) => {
						totalToolCalls: number;
						taskMasterToolCalls: number;
						writeToolCalls: number;
						nonWriteToolCalls: number;
					};
				};
				const counts = new Map([
					['mcp__task-master-ai__next_task', 5],
					['Edit', 2],
					['Write', 1],
					['Bash', 3]
				]);
				const result = svc.classifyToolCalls(counts);
				expect(result.totalToolCalls).toBe(11);
				expect(result.taskMasterToolCalls).toBe(5);
				expect(result.writeToolCalls).toBe(3); // Edit(2) + Write(1)
				expect(result.nonWriteToolCalls).toBe(8); // 11 - 3
			});

			it('pads iteration numbers to width of totalIterations', () => {
				const svc = service as unknown as {
					iterationFilePath: (f: string, n: number, total: number) => string;
				};
				const norm = (p: string) => p.replace(/\\/g, '/');
				// 10 iterations → width 2 → iter-01 through iter-10
				expect(norm(svc.iterationFilePath('/p/progress.txt', 1, 10))).toBe(
					'/p/progress.iter-01.txt'
				);
				expect(norm(svc.iterationFilePath('/p/progress.txt', 10, 10))).toBe(
					'/p/progress.iter-10.txt'
				);
				// 100 iterations → width 3 → iter-001 etc.
				expect(norm(svc.iterationFilePath('/p/progress.txt', 1, 100))).toBe(
					'/p/progress.iter-001.txt'
				);
				// Single iteration → no padding
				expect(norm(svc.iterationFilePath('/p/progress.txt', 1, 1))).toBe(
					'/p/progress.iter-1.txt'
				);
			});

			it('derives totals path correctly from progressFile', () => {
				const svc = service as unknown as {
					totalsFilePath: (f: string) => string;
				};
				const norm = (p: string) => p.replace(/\\/g, '/');
				expect(norm(svc.totalsFilePath('/p/progress.txt'))).toBe(
					'/p/progress.totals.txt'
				);
				expect(norm(svc.totalsFilePath('/foo/loop-progress.txt'))).toBe(
					'/foo/loop-progress.totals.txt'
				);
			});

			it('appends only a compact line to progress.txt after each verbose iteration', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'verbose'
				});

				// appendFile calls to the progress file should NOT contain '## Iteration' blocks
				const appendCalls = vi
					.mocked(fsPromises.appendFile)
					.mock.calls.filter(([p]) => p === '/test/progress.txt');
				for (const [, c] of appendCalls) {
					expect(c as string).not.toContain('## Iteration');
					expect(c as string).not.toContain('## [VERBOSE] Iteration');
				}
				// Compact line should be present
				const compactCall = appendCalls.find(
					([, c]) =>
						typeof c === 'string' && (c as string).includes('- Iter 1:')
				);
				expect(compactCall).toBeDefined();
				expect(compactCall![1] as string).toContain('tools:');
			});

			it('writes full verbose block to iter sibling file via writeFile', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'verbose'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.iter-')
				);
				expect(iterCall).toBeDefined();
				expect(iterCall![0] as string).toContain('progress.iter-1.txt');
				expect(iterCall![1] as string).toContain('## [VERBOSE] Iteration 1');
			});

			it('writes totals file at finalize with per-iteration markdown table', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'verbose'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const totalsCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.totals.')
				);
				expect(totalsCall).toBeDefined();
				expect(totalsCall![0] as string).toContain('progress.totals.txt');
				expect(totalsCall![1] as string).toContain('# Loop Totals');
				expect(totalsCall![1] as string).toContain('| Iter |');
			});

			it('includes classification counts in onIterationSummary at trace level', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({
							type: 'assistant',
							message: {
								content: [
									{
										type: 'tool_use',
										name: 'mcp__task-master-ai__next_task',
										input: {}
									},
									{ type: 'tool_use', name: 'Edit', input: {} }
								]
							}
						}),
						JSON.stringify({ type: 'result', result: 'done' })
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				const onIterationSummary = vi.fn();
				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'trace',
					callbacks: { onIterationSummary }
				});

				expect(onIterationSummary).toHaveBeenCalledTimes(1);
				const [, summary] = onIterationSummary.mock.calls[0];
				expect(summary.totalToolCalls).toBe(2);
				expect(summary.taskMasterToolCalls).toBe(1);
				expect(summary.writeToolCalls).toBe(1);
				expect(summary.nonWriteToolCalls).toBe(1);
				expect(typeof summary.estimatedContext).toBe('number');
			});

			it('includes percentOf1M when system event reports an opus model id', async () => {
				vi.mocked(childProcess.spawn).mockReturnValue(
					makeMockSpawnChild([
						JSON.stringify({
							type: 'system',
							model: 'claude-opus-4-7-20251101'
						}),
						JSON.stringify({
							type: 'result',
							result: 'done',
							usage: { input_tokens: 100_000, output_tokens: 5_000 }
						})
					]) as unknown as ReturnType<typeof childProcess.spawn>
				);

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt',
					traceLevel: 'verbose'
				});

				const appendCalls = vi.mocked(fsPromises.appendFile).mock.calls;
				const compactCall = appendCalls.find(
					([, c]) =>
						typeof c === 'string' && (c as string).includes('- Iter 1:')
				);
				expect(compactCall).toBeDefined();
				expect(compactCall![1] as string).toContain('% of 1M');
			});

			it('does not write sibling or totals files in none traceLevel mode', async () => {
				vi.mocked(childProcess.spawnSync).mockReturnValue({
					stdout: 'done',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: 'linting',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
					// traceLevel defaults to 'none'
				});

				const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
				const iterCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.iter-')
				);
				const totalsCall = writeCalls.find(
					([p]) => typeof p === 'string' && (p as string).includes('.totals.')
				);
				expect(iterCall).toBeUndefined();
				expect(totalsCall).toBeUndefined();
			});
		});

		describe('preset resolution', () => {
			it('should resolve built-in preset names', async () => {
				mockSpawnSync.mockReturnValue({
					stdout: '',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: 'test-coverage',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				// Verify spawn was called with prompt containing iteration info
				const spawnCall = mockSpawnSync.mock.calls[0];
				// Args are ['-p', prompt, '--dangerously-skip-permissions'] for non-sandbox
				const promptArg = spawnCall[1][1];
				expect(promptArg).toContain('iteration 1 of 1');
			});

			it('should load custom prompt from file', async () => {
				vi.mocked(fsPromises.readFile).mockResolvedValue(
					'Custom prompt content'
				);
				mockSpawnSync.mockReturnValue({
					stdout: '',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				});

				await service.run({
					prompt: '/custom/prompt.md',
					iterations: 1,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(fsPromises.readFile).toHaveBeenCalledWith(
					'/custom/prompt.md',
					'utf-8'
				);
			});

			it('should throw on empty custom prompt file', async () => {
				vi.mocked(fsPromises.readFile).mockResolvedValue('   ');

				await expect(
					service.run({
						prompt: '/custom/empty.md',
						iterations: 1,
						sleepSeconds: 0,
						progressFile: '/test/progress.txt'
					})
				).rejects.toThrow('empty');
			});
		});
	});

	describe('parseCompletion (inlined)', () => {
		let service: LoopService;
		let parseCompletion: (
			output: string,
			exitCode: number
		) => { status: string; message?: string };

		beforeEach(() => {
			service = new LoopService(defaultOptions);
			// Access private method
			parseCompletion = (
				service as unknown as {
					parseCompletion: typeof parseCompletion;
				}
			).parseCompletion.bind(service);
		});

		it('should detect complete marker', () => {
			const result = parseCompletion(
				'<loop-complete>ALL DONE</loop-complete>',
				0
			);
			expect(result.status).toBe('complete');
			expect(result.message).toBe('ALL DONE');
		});

		it('should detect blocked marker', () => {
			const result = parseCompletion('<loop-blocked>STUCK</loop-blocked>', 0);
			expect(result.status).toBe('blocked');
			expect(result.message).toBe('STUCK');
		});

		it('should return error on non-zero exit code', () => {
			const result = parseCompletion('Some output', 1);
			expect(result.status).toBe('error');
			expect(result.message).toBe('Exit code 1');
		});

		it('should return success on zero exit code without markers', () => {
			const result = parseCompletion('Regular output', 0);
			expect(result.status).toBe('success');
		});

		it('should be case-insensitive for markers', () => {
			const result = parseCompletion('<LOOP-COMPLETE>DONE</LOOP-COMPLETE>', 0);
			expect(result.status).toBe('complete');
		});

		it('should trim whitespace from reason', () => {
			const result = parseCompletion(
				'<loop-complete>  trimmed  </loop-complete>',
				0
			);
			expect(result.message).toBe('trimmed');
		});
	});

	describe('extractTokenUsage (inlined)', () => {
		let service: LoopService;
		let extractTokenUsage: (event: {
			usage?: Record<string, unknown>;
		}) => unknown;

		beforeEach(() => {
			service = new LoopService(defaultOptions);
			extractTokenUsage = (
				service as unknown as {
					extractTokenUsage: typeof extractTokenUsage;
				}
			).extractTokenUsage.bind(service);
		});

		it('should return undefined when usage is missing', () => {
			expect(extractTokenUsage({})).toBeUndefined();
		});

		it('should return undefined when usage is not an object', () => {
			expect(
				extractTokenUsage({
					usage: 'oops' as unknown as Record<string, unknown>
				})
			).toBeUndefined();
		});

		it('should return undefined when all fields are zero/missing', () => {
			expect(
				extractTokenUsage({ usage: { input_tokens: 0, output_tokens: 0 } })
			).toBeUndefined();
		});

		it('should map snake_case fields and compute totalTokens', () => {
			const result = extractTokenUsage({
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 200,
					cache_read_input_tokens: 1000
				}
			}) as {
				inputTokens: number;
				outputTokens: number;
				cacheCreationInputTokens?: number;
				cacheReadInputTokens?: number;
				totalTokens: number;
			};

			expect(result).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationInputTokens: 200,
				cacheReadInputTokens: 1000,
				totalTokens: 1350
			});
		});

		it('should omit cache fields when not reported', () => {
			const result = extractTokenUsage({
				usage: { input_tokens: 10, output_tokens: 5 }
			}) as {
				inputTokens: number;
				outputTokens: number;
				cacheCreationInputTokens?: number;
				cacheReadInputTokens?: number;
				totalTokens: number;
			};

			expect(result).toEqual({
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15
			});
			expect(result.cacheCreationInputTokens).toBeUndefined();
			expect(result.cacheReadInputTokens).toBeUndefined();
		});

		it('should ignore non-numeric fields', () => {
			const result = extractTokenUsage({
				usage: {
					input_tokens: 7,
					output_tokens: 'oops',
					cache_read_input_tokens: Number.NaN
				}
			}) as {
				inputTokens: number;
				outputTokens: number;
				cacheReadInputTokens?: number;
				totalTokens: number;
			};

			expect(result.inputTokens).toBe(7);
			expect(result.outputTokens).toBe(0);
			expect(result.cacheReadInputTokens).toBeUndefined();
			expect(result.totalTokens).toBe(7);
		});
	});

	describe('isPreset (inlined)', () => {
		let service: LoopService;
		let isPreset: (name: string) => boolean;

		beforeEach(() => {
			service = new LoopService(defaultOptions);
			isPreset = (
				service as unknown as { isPreset: (n: string) => boolean }
			).isPreset.bind(service);
		});

		it('should return true for default preset', () => {
			expect(isPreset('default')).toBe(true);
		});

		it('should return true for test-coverage preset', () => {
			expect(isPreset('test-coverage')).toBe(true);
		});

		it('should return true for linting preset', () => {
			expect(isPreset('linting')).toBe(true);
		});

		it('should return true for duplication preset', () => {
			expect(isPreset('duplication')).toBe(true);
		});

		it('should return true for entropy preset', () => {
			expect(isPreset('entropy')).toBe(true);
		});

		it('should return false for unknown preset', () => {
			expect(isPreset('unknown')).toBe(false);
		});

		it('should return false for file paths', () => {
			expect(isPreset('/path/to/file.md')).toBe(false);
		});
	});

	describe('buildContextHeader (inlined)', () => {
		let service: LoopService;
		let buildContextHeader: (
			config: { iterations: number; progressFile: string; tag?: string },
			iteration: number
		) => string;

		beforeEach(() => {
			service = new LoopService(defaultOptions);
			buildContextHeader = (
				service as unknown as {
					buildContextHeader: typeof buildContextHeader;
				}
			).buildContextHeader.bind(service);
		});

		it('should include iteration info', () => {
			const header = buildContextHeader(
				{ iterations: 5, progressFile: '/test/progress.txt' },
				2
			);
			expect(header).toContain('iteration 2 of 5');
		});

		it('should include progress file reference', () => {
			const header = buildContextHeader(
				{ iterations: 1, progressFile: '/test/progress.txt' },
				1
			);
			expect(header).toContain('@/test/progress.txt');
		});

		it('should NOT include tasks file reference (preset controls task source)', () => {
			const header = buildContextHeader(
				{ iterations: 1, progressFile: '/test/progress.txt' },
				1
			);
			// tasks.json intentionally excluded - let preset control task source to avoid confusion
			expect(header).not.toContain('tasks.json');
		});

		it('should include tag filter when provided', () => {
			const header = buildContextHeader(
				{ iterations: 1, progressFile: '/test/progress.txt', tag: 'feature-x' },
				1
			);
			expect(header).toContain('tag: feature-x');
		});

		it('should not include tag when not provided', () => {
			const header = buildContextHeader(
				{ iterations: 1, progressFile: '/test/progress.txt' },
				1
			);
			expect(header).not.toContain('tag:');
		});
	});

	describe('sessionPersistence in buildCommandArgs', () => {
		let service: LoopService;
		const minimalConfig = {
			prompt: 'linting',
			iterations: 1,
			sleepSeconds: 0,
			progressFile: '/test/progress.txt'
		};

		beforeEach(() => {
			service = new LoopService(defaultOptions);
		});

		it('appends --no-session-persistence when sessionPersistence is false (non-sandbox)', async () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			await service.run({
				...minimalConfig,
				sandbox: false,
				sessionPersistence: false
			});

			const claudeCalls = mockSpawnSync.mock.calls.filter(
				([cmd]) => cmd === 'claude'
			);
			expect(claudeCalls.length).toBeGreaterThan(0);
			expect(claudeCalls[0][1]).toContain('--no-session-persistence');
		});

		it('does NOT append --no-session-persistence when sessionPersistence is true (non-sandbox)', async () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			await service.run({
				...minimalConfig,
				sandbox: false,
				sessionPersistence: true
			});

			const claudeCalls = mockSpawnSync.mock.calls.filter(
				([cmd]) => cmd === 'claude'
			);
			expect(claudeCalls.length).toBeGreaterThan(0);
			expect(claudeCalls[0][1]).not.toContain('--no-session-persistence');
		});

		it('appends --no-session-persistence when sessionPersistence is false (sandbox)', async () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			await service.run({
				...minimalConfig,
				sandbox: true,
				sessionPersistence: false
			});

			const dockerCalls = mockSpawnSync.mock.calls.filter(
				([cmd]) => cmd === 'docker'
			);
			expect(dockerCalls.length).toBeGreaterThan(0);
			expect(dockerCalls[0][1]).toContain('--no-session-persistence');
		});

		it('does NOT append --no-session-persistence when sessionPersistence is true (sandbox)', async () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			await service.run({
				...minimalConfig,
				sandbox: true,
				sessionPersistence: true
			});

			const dockerCalls = mockSpawnSync.mock.calls.filter(
				([cmd]) => cmd === 'docker'
			);
			expect(dockerCalls.length).toBeGreaterThan(0);
			expect(dockerCalls[0][1]).not.toContain('--no-session-persistence');
		});
	});

	describe('integration: stop during run', () => {
		let service: LoopService;

		beforeEach(() => {
			service = new LoopService(defaultOptions);
		});

		it('should set isRunning to true during run', async () => {
			let capturedIsRunning = false;
			mockSpawnSync.mockImplementation(() => {
				capturedIsRunning = service.isRunning;
				return {
					stdout: '',
					stderr: '',
					status: 0,
					signal: null,
					pid: 123,
					output: []
				};
			});

			await service.run({
				prompt: 'default',
				iterations: 1,
				sleepSeconds: 0,
				progressFile: '/test/progress.txt'
			});

			expect(capturedIsRunning).toBe(true);
		});

		it('should set isRunning to false on completion', async () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			await service.run({
				prompt: 'default',
				iterations: 1,
				sleepSeconds: 0,
				progressFile: '/test/progress.txt'
			});

			expect(service.isRunning).toBe(false);
		});
	});
});
