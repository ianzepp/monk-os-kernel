/**
 * Process Syscalls - Process lifecycle and environment operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Process syscalls manage the lifecycle of processes (spawn, exit, kill, wait)
 * and process-local state (args, cwd, env). Each syscall is a standalone async
 * generator function that receives explicit dependencies.
 *
 * DESIGN: Some syscalls only need `proc`
 * =====================================
 * Several syscalls operate purely on process-local state and don't need access
 * to the kernel. These include:
 * - proc:getargs - Returns proc.args
 * - proc:getcwd - Returns proc.cwd
 * - proc:getenv - Returns proc.env[name]
 * - proc:setenv - Sets proc.env[name] = value
 * - activation:get - Returns proc.activationMessage
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: proc.cwd is always an absolute path starting with '/'
 * INV-2: proc.cwd always references an existing directory in the VFS
 * INV-3: proc.env keys and values are always strings
 * INV-4: PID arguments must be positive integers
 * INV-5: Exit code must be non-negative integer
 *
 * CONCURRENCY MODEL
 * =================
 * Process state (cwd, env, args) is owned by the process. Only the owning
 * process modifies its state via syscalls. Concurrent syscalls from the same
 * process are serialized by the message queue.
 *
 * Spawn and wait operations involve the kernel and can interleave with other
 * processes' operations.
 *
 * @module syscall/process
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { VFS } from '@src/vfs/index.js';
import type { Process, SpawnOpts, Response } from './types.js';
import { respond } from './types.js';

// Kernel functions for process management
import { spawn } from '@src/kernel/kernel/spawn.js';
import { createVirtualProcess } from '@src/kernel/kernel/create-virtual-process.js';
import { exit } from '@src/kernel/kernel/exit.js';
import { kill } from '@src/kernel/kernel/kill.js';
import { wait } from '@src/kernel/kernel/wait.js';
import { getpid } from '@src/kernel/kernel/get-pid.js';
import { getppid } from '@src/kernel/kernel/get-ppid.js';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Resolve a path relative to a base directory.
 *
 * @param cwd - Current working directory (absolute path)
 * @param path - Path to resolve (absolute or relative)
 * @returns Resolved absolute path
 */
function resolvePath(cwd: string, path: string): string {
    if (path.startsWith('/')) {
        return path;
    }

    const baseParts = cwd.split('/').filter(Boolean);
    const relativeParts = path.split('/');

    for (const part of relativeParts) {
        if (part === '.' || part === '') {
            continue;
        }
        else if (part === '..') {
            baseParts.pop();
        }
        else {
            baseParts.push(part);
        }
    }

    return '/' + baseParts.join('/');
}

// =============================================================================
// PROCESS LIFECYCLE
// =============================================================================

/**
 * Spawn a child process.
 *
 * @param proc - Calling process (parent)
 * @param kernel - Kernel instance
 * @param entry - Entry point path
 * @param opts - Spawn options
 */
export async function* procSpawn(
    proc: Process,
    kernel: Kernel,
    entry: unknown,
    opts?: unknown,
): AsyncIterable<Response> {
    if (typeof entry !== 'string') {
        yield respond.error('EINVAL', 'entry must be a string');

        return;
    }

    const pid = await spawn(kernel, proc, entry, opts as SpawnOpts);

    yield respond.ok(pid);
}

/**
 * Exit the calling process.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param code - Exit code (non-negative integer)
 */
export async function* procExit(
    proc: Process,
    kernel: Kernel,
    code: unknown,
): AsyncIterable<Response> {
    if (typeof code !== 'number' || code < 0) {
        yield respond.error('EINVAL', 'code must be a non-negative number');

        return;
    }

    await exit(kernel, proc, code);
    yield respond.ok();
}

/**
 * Send signal to a process.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param targetPid - Target process PID
 * @param signal - Signal number (optional, default SIGTERM)
 */
export async function* procKill(
    proc: Process,
    kernel: Kernel,
    targetPid: unknown,
    signal?: unknown,
): AsyncIterable<Response> {
    if (typeof targetPid !== 'number' || targetPid <= 0) {
        yield respond.error('EINVAL', 'pid must be a positive number');

        return;
    }

    const sig = typeof signal === 'number' ? signal : undefined;

    await kill(kernel, proc, targetPid, sig);
    yield respond.ok();
}

/**
 * Wait for a child process to exit.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param targetPid - Target process PID
 * @param timeout - Optional timeout in milliseconds
 */
export async function* procWait(
    proc: Process,
    kernel: Kernel,
    targetPid: unknown,
    timeout?: unknown,
): AsyncIterable<Response> {
    if (typeof targetPid !== 'number' || targetPid <= 0) {
        yield respond.error('EINVAL', 'pid must be a positive number');

        return;
    }

    const ms = typeof timeout === 'number' ? timeout : undefined;
    const status = await wait(kernel, proc, targetPid, ms);

    yield respond.ok(status);
}

/**
 * Get the PID of the calling process.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 */
export async function* procGetpid(
    proc: Process,
    kernel: Kernel,
): AsyncIterable<Response> {
    yield respond.ok(getpid(kernel, proc));
}

/**
 * Get the PID of the parent process.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 */
export async function* procGetppid(
    proc: Process,
    kernel: Kernel,
): AsyncIterable<Response> {
    yield respond.ok(getppid(kernel, proc));
}

/**
 * Create a virtual process.
 *
 * Virtual processes share the parent's Worker thread but have isolated
 * state (handles, cwd, env). This enables gatewayd to create isolated
 * contexts for external clients without spawning new Worker threads.
 *
 * @param proc - Calling process (creator)
 * @param kernel - Kernel instance
 * @param opts - Optional: { cwd, env }
 */
export async function* procCreate(
    proc: Process,
    kernel: Kernel,
    opts?: unknown,
): AsyncIterable<Response> {
    const result = await createVirtualProcess(
        kernel,
        proc,
        opts as { cwd?: string; env?: Record<string, string> } | undefined,
    );

    yield respond.ok(result);
}

// =============================================================================
// PROCESS ARGUMENTS
// =============================================================================

/**
 * Get process arguments.
 *
 * Only needs Process - no kernel access needed.
 *
 * @param proc - Calling process
 */
export async function* procGetargs(
    proc: Process,
): AsyncIterable<Response> {
    yield respond.ok(proc.args);
}

// =============================================================================
// WORKING DIRECTORY
// =============================================================================

/**
 * Get current working directory.
 *
 * Only needs Process - no kernel access needed.
 *
 * @param proc - Calling process
 */
export async function* procGetcwd(
    proc: Process,
): AsyncIterable<Response> {
    yield respond.ok(proc.cwd);
}

/**
 * Change working directory.
 *
 * Needs VFS to validate path, then mutates process state.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param path - Target directory path
 */
export async function* procChdir(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');

        return;
    }

    // Resolve relative path
    const resolved = resolvePath(proc.cwd, path);

    // Validate directory exists
    try {
        const stat = await vfs.stat(resolved, proc.user);

        if (stat.model !== 'folder') {
            yield respond.error('ENOTDIR', `Not a directory: ${path}`);

            return;
        }
    }
    catch (err) {
        const code = (err as { code?: string }).code ?? 'ENOENT';

        yield respond.error(code, (err as Error).message);

        return;
    }

    // Update process cwd
    proc.cwd = resolved;
    yield respond.ok();
}

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

/**
 * Get environment variable.
 *
 * Only needs Process - no kernel access needed.
 *
 * @param proc - Calling process
 * @param name - Variable name
 */
export async function* procGetenv(
    proc: Process,
    name: unknown,
): AsyncIterable<Response> {
    if (typeof name !== 'string') {
        yield respond.error('EINVAL', 'name must be a string');

        return;
    }

    yield respond.ok(proc.env[name]);
}

/**
 * Set environment variable.
 *
 * Only needs Process - no kernel access needed.
 *
 * @param proc - Calling process
 * @param name - Variable name
 * @param value - Variable value
 */
export async function* procSetenv(
    proc: Process,
    name: unknown,
    value: unknown,
): AsyncIterable<Response> {
    if (typeof name !== 'string') {
        yield respond.error('EINVAL', 'name must be a string');

        return;
    }

    if (typeof value !== 'string') {
        yield respond.error('EINVAL', 'value must be a string');

        return;
    }

    proc.env[name] = value;
    yield respond.ok();
}

// =============================================================================
// SERVICE ACTIVATION
// =============================================================================

/**
 * Get service activation message.
 *
 * Only needs Process - returns proc.activationMessage.
 *
 * @param proc - Calling process
 */
export async function* activationGet(
    proc: Process,
): AsyncIterable<Response> {
    yield respond.ok(proc.activationMessage ?? null);
}

// =============================================================================
// WORKER POOL (pool:stats doesn't need proc)
// =============================================================================

/**
 * Get pool statistics.
 *
 * Doesn't need proc at all - just queries kernel state.
 *
 * @param kernel - Kernel instance
 */
export async function* poolStats(
    kernel: Kernel,
): AsyncIterable<Response> {
    yield respond.ok(kernel.poolManager.stats());
}
