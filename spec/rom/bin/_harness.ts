/**
 * Shell Command Test Harness
 *
 * PURPOSE
 * =======
 * Provides utilities for testing shell commands in `rom/bin/`. Based on the
 * patterns used in `perf/kernel/process-spawn.perf.ts` for pipe chain testing.
 *
 * ARCHITECTURE
 * ============
 * Each test gets a fresh kernel via beforeEach/afterEach. Commands run through
 * `/bin/shell.ts -c` which supports pipes, redirects, and chaining.
 *
 * Output is captured via file redirects: `cmd > /tmp/out 2> /tmp/err`
 *
 * @module spec/rom/bin/_harness
 */

import { createOsStack, type OsStack } from '@src/os/stack.js';
import type { Kernel } from '@src/kernel/kernel.js';
import { poll } from '@src/kernel/poll.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of running a shell command.
 */
export interface RunResult {
    /** Exit code from the process */
    exitCode: number;

    /** Captured stdout */
    stdout: string;

    /** Captured stderr */
    stderr: string;
}

/**
 * Test context holding the OS stack.
 *
 * USAGE: Create fresh context per test via beforeEach/afterEach.
 */
export interface TestContext {
    /** The OS stack */
    stack: OsStack;

    /** The kernel */
    kernel: Kernel;

    /**
     * Run a shell command with output capture.
     *
     * Command is run through `/bin/shell.ts -c` with redirects.
     * Supports pipes: `echo hello | cat | cat`
     * Supports chaining: `true && echo yes`
     */
    run(command: string, opts?: RunOptions): Promise<RunResult>;

    /** Shutdown the OS - call in afterEach */
    shutdown(): Promise<void>;
}

/**
 * Options for running a command.
 */
export interface RunOptions {
    /** Environment variables */
    env?: Record<string, string>;

    /** Timeout in milliseconds (default: 5000) */
    timeout?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default timeout for command execution (5 seconds) */
const DEFAULT_TIMEOUT = 5000;

/** Temp file path for output capture */
const STDOUT_FILE = '/tmp/_test_stdout';

// NOTE: Shell doesn't support 2> stderr redirect, so we only capture stdout

// =============================================================================
// HARNESS IMPLEMENTATION
// =============================================================================

/**
 * Create a test context with a fresh OS stack.
 *
 * WHY fresh per test: kernel.boot() can only be called once, so each test
 * needs its own kernel instance.
 *
 * @returns TestContext ready for running commands
 *
 * @example
 * ```typescript
 * describe('echo', () => {
 *     let ctx: TestContext;
 *
 *     beforeEach(async () => {
 *         ctx = await createTestContext();
 *     });
 *
 *     afterEach(async () => {
 *         await ctx.shutdown();
 *     });
 *
 *     it('should output text', async () => {
 *         const result = await ctx.run('echo hello');
 *         expect(result.stdout).toBe('hello\n');
 *         expect(result.exitCode).toBe(0);
 *     });
 *
 *     it('should support pipes', async () => {
 *         const result = await ctx.run('echo hello | cat | cat');
 *         expect(result.stdout).toBe('hello\n');
 *     });
 * });
 * ```
 */
export async function createTestContext(): Promise<TestContext> {
    const stack = await createOsStack({ kernel: true });
    const kernel = stack.kernel!;

    // Ensure /tmp exists for output capture
    await stack.vfs!.mkdir('/tmp', 'kernel').catch(() => {});

    return {
        stack,
        kernel,

        async run(command: string, opts?: RunOptions): Promise<RunResult> {
            return runShellCommand(kernel, stack.vfs!, command, opts);
        },

        async shutdown(): Promise<void> {
            await stack.shutdown();
        },
    };
}

/**
 * Wait for the init process to exit (become zombie).
 */
async function waitForInitExit(kernel: Kernel, timeout = 5000): Promise<boolean> {
    return await poll(() => {
        const init = kernel.getProcessTable().getInit();
        return !init || init.state === 'zombie';
    }, { timeout });
}

/**
 * Run a shell command with output capture via file redirect.
 *
 * NOTE: Only stdout is captured via `> file` redirect.
 * stderr goes to console (shell doesn't support 2> redirect).
 */
async function runShellCommand(
    kernel: Kernel,
    vfs: import('@src/vfs/vfs.js').VFS,
    command: string,
    opts?: RunOptions
): Promise<RunResult> {
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

    // Build command with stdout redirect only
    const redirectedCmd = `${command} > ${STDOUT_FILE}`;

    await kernel.boot({
        initPath: '/bin/shell.ts',
        initArgs: ['shell', '-c', redirectedCmd],
        env: opts?.env ?? {},
    });

    const exited = await waitForInitExit(kernel, timeout);
    if (!exited) {
        throw new Error(`Shell command '${command}' timed out after ${timeout}ms`);
    }

    const init = kernel.getProcessTable().getInit();
    const exitCode = init?.exitCode ?? -1;

    // Read captured stdout
    let stdout = '';

    try {
        const stdoutData = await vfs.readFile(STDOUT_FILE, 'kernel');
        stdout = new TextDecoder().decode(stdoutData);
    }
    catch {
        // File may not exist if command produced no output
    }

    return {
        exitCode,
        stdout,
        stderr: '', // stderr capture not supported
    };
}

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

/**
 * Standard exit codes for reference in tests.
 */
export const EXIT = {
    /** Successful execution */
    SUCCESS: 0,

    /** General error */
    FAILURE: 1,

    /** Usage/syntax error */
    USAGE: 2,
} as const;
