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
import * as fsPromises from 'node:fs/promises';

// Mock child_process and fs/promises
vi.mock('node:child_process');
vi.mock('node:fs/promises');

describe('LoopService', () => {
	const defaultOptions: LoopServiceOptions = {
		projectRoot: '/test/project'
	};

	let mockSpawnSync: MockInstance;

	beforeEach(() => {
		vi.resetAllMocks();
		// Default fs mocks
		vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
		vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
		vi.mocked(fsPromises.appendFile).mockResolvedValue(undefined);

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

	describe('checkTaskMasterAvailable()', () => {
		it('should return available=true when task-master --version succeeds', () => {
			mockSpawnSync.mockReturnValue({
				stdout: '0.27.3',
				stderr: '',
				status: 0,
				signal: null,
				pid: 123,
				output: []
			});

			const service = new LoopService(defaultOptions);
			const result = service.checkTaskMasterAvailable();

			expect(result.available).toBe(true);
			expect(mockSpawnSync).toHaveBeenCalledWith(
				'task-master',
				['--version'],
				expect.objectContaining({
					cwd: '/test/project'
				})
			);
		});

		it('should return available=false with install hint on ENOENT', () => {
			const enoent = Object.assign(new Error('not found'), {
				code: 'ENOENT'
			}) as NodeJS.ErrnoException;
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: '',
				status: null,
				signal: null,
				pid: 0,
				output: [],
				error: enoent
			});

			const service = new LoopService(defaultOptions);
			const result = service.checkTaskMasterAvailable();

			expect(result.available).toBe(false);
			expect(result.error).toContain('npm i -g task-master-ai');
		});

		it('should return available=false when exit code is non-zero', () => {
			mockSpawnSync.mockReturnValue({
				stdout: '',
				stderr: 'broken install',
				status: 1,
				signal: null,
				pid: 123,
				output: []
			});

			const service = new LoopService(defaultOptions);
			const result = service.checkTaskMasterAvailable();

			expect(result.available).toBe(false);
			expect(result.error).toMatch(/exit(ed)? with code 1/i);
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
					verbose: true,
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
				// 1 task-master --version precondition + 3 claude iterations
				expect(mockSpawnSync).toHaveBeenCalledTimes(4);
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

		describe('task-master precondition', () => {
			it('should fail fast for default preset when task-master is missing', async () => {
				const enoent = Object.assign(new Error('not found'), {
					code: 'ENOENT'
				}) as NodeJS.ErrnoException;
				mockSpawnSync.mockReturnValue({
					stdout: '',
					stderr: '',
					status: null,
					signal: null,
					pid: 0,
					output: [],
					error: enoent
				});

				const result = await service.run({
					prompt: 'default',
					iterations: 5,
					sleepSeconds: 0,
					progressFile: '/test/progress.txt'
				});

				expect(result.finalStatus).toBe('error');
				expect(result.totalIterations).toBe(0);
				expect(result.errorMessage).toContain('npm i -g task-master-ai');
				// Only the precondition spawn ran - no iterations spawned
				expect(mockSpawnSync).toHaveBeenCalledTimes(1);
				expect(mockSpawnSync).toHaveBeenCalledWith(
					'task-master',
					['--version'],
					expect.any(Object)
				);
			});

			it('should skip precondition for non-default presets', async () => {
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

				// No precondition call - only the single claude iteration
				expect(mockSpawnSync).toHaveBeenCalledTimes(1);
				expect(mockSpawnSync).not.toHaveBeenCalledWith(
					'task-master',
					expect.any(Array),
					expect.any(Object)
				);
			});

			it('should skip precondition in sandbox mode', async () => {
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
				// First call is the task-master precondition (must succeed),
				// subsequent calls are the iteration (the error we're testing).
				mockSpawnSync
					.mockReturnValueOnce({
						stdout: '0.27.3',
						stderr: '',
						status: 0,
						signal: null,
						pid: 123,
						output: []
					})
					.mockReturnValue({
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
				mockSpawnSync
					.mockReturnValueOnce({
						stdout: '0.27.3',
						stderr: '',
						status: 0,
						signal: null,
						pid: 123,
						output: []
					})
					.mockReturnValue({
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
					trace: true
				});

				expect(result.finalStatus).toBe('error');
				expect(result.errorMessage).toContain('--trace');
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
					verbose: true
				});

				expect(result.finalStatus).toBe('error');
				expect(result.errorMessage).toContain('--verbose');
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
							trace?: boolean,
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
					true,
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
					true,
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
							trace?: boolean,
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
					false
				);

				handleStreamEvent(
					{
						type: 'user',
						message: {
							content: [{ type: 'tool_result', content: 'output' }]
						}
					},
					{ onText, onToolUse, onToolInput, onToolResult },
					false
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
