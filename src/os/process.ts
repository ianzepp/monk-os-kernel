/**
 * Process API
 *
 * Provides process spawning and execution for the OS public API.
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { ExternalProcessHandle } from '@src/kernel/types.js';
import type { SpawnOpts, RunOpts, ProcessHandle, RunResult } from './types.js';
import { ENOSYS } from '@src/hal/errors.js';

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
    private host: ProcessAPIHost;
    private nextPid = 1;
    private handles: Map<number, ExternalProcessHandle> = new Map();

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
     * });
     * // Wait for completion
     * const result = await proc.wait();
     * console.log('Exit code:', result.exitCode);
     * ```
     */
    async spawn(cmd: string, opts?: SpawnOpts): Promise<ProcessHandle> {
        const resolvedCmd = this.host.resolvePath(cmd);
        const kernel = this.host.getKernel();

        // Spawn via kernel
        const kernelHandle = await kernel.spawnExternal(resolvedCmd, {
            args: opts?.args,
            cwd: opts?.cwd,
            env: opts?.env,
        });

        // Assign a PID for this process
        const pid = this.nextPid++;
        this.handles.set(pid, kernelHandle);

        // Create OS-level handle
        const handle: ProcessHandle = {
            pid,
            cmd: resolvedCmd,

            kill: async (signal?: number) => {
                await kernelHandle.kill(signal);
            },

            wait: async () => {
                const result = await kernelHandle.wait();
                // Clean up our tracking
                this.handles.delete(pid);
                return {
                    exitCode: result.code,
                };
            },

            // Note: stdin/stdout/stderr piping not yet implemented
            // Would require kernel.spawnExternal to support pipe mode
        };

        return handle;
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
        // TODO: Implement run-to-completion with output buffering
        // This requires stdio piping support in kernel.spawnExternal
        // For now, throw ENOSYS

        throw new ENOSYS('os.process.run() not implemented - requires stdio piping');
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
        // TODO: Implement shell execution
        // - Expand aliases in command string
        // - Run through /bin/shell -c "command"

        throw new ENOSYS('os.process.shell() not implemented');
    }

    /**
     * Get a process handle by PID.
     * Used internally by service management.
     */
    getHandle(pid: number): ExternalProcessHandle | undefined {
        return this.handles.get(pid);
    }
}
