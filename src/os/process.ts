/**
 * Process API
 *
 * Provides process spawning and execution for the OS public API.
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { SpawnOpts, RunOpts, ProcessHandle, RunResult } from './types.js';

/**
 * Interface for OS methods needed by ProcessAPI.
 * Avoids circular dependency with OS class.
 */
export interface ProcessAPIHost {
    getKernel(): Kernel;
    resolvePath(path: string): string;
}

/**
 * Process API for OS
 *
 * Provides process spawning and execution with automatic alias resolution.
 */
export class ProcessAPI {
    // Host reference for when methods are implemented
    // @ts-expect-error Unused until implementation
    private host: ProcessAPIHost;

    constructor(host: ProcessAPIHost) {
        this.host = host;
    }

    /**
     * Spawn a process and return a handle for interaction.
     *
     * Use this for long-running processes where you need to interact
     * with stdin/stdout or wait for completion manually.
     *
     * @param cmd - Path to executable (aliases resolved)
     * @param opts - Spawn options
     * @returns Handle to the running process
     *
     * @example
     * ```typescript
     * const proc = await os.process.spawn('@app/worker.ts', {
     *   args: ['--port', '9000'],
     *   stdout: 'pipe',
     * });
     * // Read output
     * const reader = proc.stdout?.getReader();
     * // Later...
     * await proc.kill();
     * ```
     */
    async spawn(_cmd: string, _opts?: SpawnOpts): Promise<ProcessHandle> {
        // TODO: Implement process spawning via kernel
        // const resolvedCmd = this.host.resolvePath(cmd);
        // const kernel = this.host.getKernel();
        // - Resolve cmd path through VFS
        // - Create Worker for the process
        // - Set up stdin/stdout/stderr pipes if requested
        // - Return ProcessHandle

        throw new Error('os.process.spawn() not implemented');
    }

    /**
     * Run a command to completion and return buffered output.
     *
     * Use this for short-lived commands where you just need the result.
     * Stdout and stderr are buffered and returned in the result.
     *
     * @param cmd - Command to run (path or shell command)
     * @param opts - Run options
     * @returns Buffered output and exit code
     *
     * @example
     * ```typescript
     * // Run a script
     * const result = await os.process.run('@app/build.ts');
     * console.log(result.stdout);
     * console.log('Exit code:', result.exitCode);
     *
     * // Run with timeout
     * const result = await os.process.run('@app/slow-task.ts', {
     *   timeout: 30000,
     * });
     * ```
     */
    async run(_cmd: string, _opts?: RunOpts): Promise<RunResult> {
        // TODO: Implement run-to-completion
        // const resolvedCmd = this.host.resolvePath(cmd);
        // const kernel = this.host.getKernel();
        // - Spawn process with stdout/stderr piped
        // - Buffer output up to maxBuffer
        // - Wait for completion or timeout
        // - Return buffered result

        throw new Error('os.process.run() not implemented');
    }

    /**
     * Run a shell command and return the result.
     *
     * Convenience wrapper that runs the command through /bin/sh.
     *
     * @param command - Shell command string
     * @param opts - Run options
     * @returns Buffered output and exit code
     *
     * @example
     * ```typescript
     * const result = await os.process.shell('ls -la @app');
     * console.log(result.stdout);
     * ```
     */
    async shell(_command: string, _opts?: RunOpts): Promise<RunResult> {
        // Shell commands need alias expansion in the command string itself
        // For now, just delegate to run() with /bin/sh

        // TODO: Implement shell execution
        // - Expand aliases in command string
        // - Run through /bin/sh -c "command"

        throw new Error('os.process.shell() not implemented');
    }
}
