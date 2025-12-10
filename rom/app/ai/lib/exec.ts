/**
 * Prior Exec - Shell command execution for the Prior AI process
 *
 * PURPOSE
 * =======
 * Provides shell command execution capabilities for Prior. Commands are
 * routed through /bin/shell.ts for full shell support including pipes,
 * redirects, chaining, globs, and variable expansion.
 *
 * DESIGN
 * ======
 * All commands go through the shell rather than direct process spawning.
 * This ensures consistent behavior and supports complex command syntax.
 *
 * @module rom/lib/prior/exec
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    stat,
    spawn,
    wait,
    pipe,
    close,
    recv,
    getcwd,
} from '@rom/lib/process/index.js';

import type { ExecResult } from './types.js';

// =============================================================================
// COMMAND FINDING
// =============================================================================

/**
 * Find a command in the /bin directory.
 *
 * @param command - Command name or absolute path
 * @returns Full path to command, or null if not found
 */
export async function findCommand(command: string): Promise<string | null> {
    // Absolute path - check directly
    if (command.startsWith('/')) {
        try {
            await stat(command);

            return command;
        }
        catch {
            return null;
        }
    }

    // Search in /bin
    const binPath = `/bin/${command}.ts`;

    try {
        await stat(binPath);

        return binPath;
    }
    catch {
        return null;
    }
}

// =============================================================================
// SHELL EXECUTION
// =============================================================================

/**
 * Execute a shell command and capture output.
 *
 * Routes command through /bin/shell.ts for full shell support:
 * - Pipes (|)
 * - Redirects (>, >>)
 * - Chaining (&&, ||, ;)
 * - Globs (*, ?)
 * - Variable expansion ($VAR)
 *
 * @param shellCmd - Shell command string (passed directly to shell -c)
 * @returns Execution result with stdout, stderr, and exit code
 */
export async function exec(shellCmd: string): Promise<ExecResult> {
    if (!shellCmd.trim()) {
        return { stdout: '', stderr: '', code: 0 };
    }

    const cwd = await getcwd();

    // Create pipe to capture output
    const [outputReadFd, outputWriteFd] = await pipe();

    try {
        // Spawn shell with -c to execute command
        // WHY stdin: -1: Commands that read stdin (head, cat) would hang forever
        // waiting for input that will never come. Better to fail fast.
        const pid = await spawn('/bin/shell.ts', {
            args: ['shell', '-c', shellCmd],
            cwd,
            stdin: -1,
            stdout: outputWriteFd,
        });

        // Close write end in parent so we see EOF when shell exits
        await close(outputWriteFd);

        // Read output
        const outputChunks: string[] = [];

        for await (const response of recv(outputReadFd)) {
            if (response.op === 'item' && response.data) {
                const data = response.data as { text?: string };

                if (data.text) {
                    outputChunks.push(data.text);
                }
            }
            else if (response.op === 'done' || response.op === 'error') {
                break;
            }
        }

        // Wait for shell to complete
        const status = await wait(pid);

        // Close read end
        await close(outputReadFd).catch(() => {});

        return {
            stdout: outputChunks.join(''),
            stderr: '',
            code: status.code,
        };
    }
    catch (err) {
        await close(outputReadFd).catch(() => {});
        await close(outputWriteFd).catch(() => {});

        const message = err instanceof Error ? err.message : String(err);

        return { stdout: '', stderr: message, code: 1 };
    }
}

/**
 * Execute a syscall and format the result for LLM consumption.
 *
 * @param name - Syscall name (e.g., "fs:stat")
 * @param args - Arguments to pass to the syscall
 * @returns Formatted result string
 */
export async function executeCall(name: string, args: unknown[]): Promise<string> {
    // Import call dynamically to avoid circular deps
    const { call } = await import('@rom/lib/process/index.js');

    try {
        const result = await call<unknown>(name, ...args);

        // Format result for LLM consumption
        if (result === undefined || result === null) {
            return '(no result)';
        }

        if (typeof result === 'string') {
            return result;
        }

        return JSON.stringify(result, null, 2);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        return `Error: ${message}`;
    }
}
