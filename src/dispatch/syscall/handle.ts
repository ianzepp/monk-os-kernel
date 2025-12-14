/**
 * Handle Syscalls - Handle manipulation and IPC primitives
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Handle syscalls provide low-level handle manipulation for I/O redirection
 * and inter-process communication. These are the building blocks for shell-style
 * I/O redirection (cmd > file) and process pipelines.
 *
 * Operations:
 * - handle:redirect - Point one fd to another's resource (like dup2)
 * - handle:restore - Restore a previously redirected fd
 * - handle:send - Send a message through any handle
 * - handle:close - Close a handle
 * - ipc:pipe - Create a bidirectional message pipe
 *
 * DESIGN: These syscalls only need kernel
 * =======================================
 * All handle operations work with the kernel's handle table. No VFS, EMS, or
 * HAL access is needed - handles abstract over all those subsystems.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Handle arguments must be validated as numbers
 * INV-2: Handle validity is checked before operations
 * INV-3: Redirect returns saved handle ID for later restore
 * INV-4: Pipe creation is atomic (both ends or neither)
 *
 * @module syscall/handle
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { Process, Response, Message } from '../types.js';
import { respond } from '../types.js';

// Kernel functions for handle operations
import { redirectHandle as kernelRedirectHandle } from '@src/kernel/kernel/redirect-handle.js';
import { restoreHandle as kernelRestoreHandle } from '@src/kernel/kernel/restore-handle.js';
import { getHandle } from '@src/kernel/kernel/get-handle.js';
import { closeHandle as kernelCloseHandle } from '@src/kernel/kernel/close-handle.js';
import { createPipe as kernelCreatePipe } from '@src/kernel/kernel/create-pipe.js';

// =============================================================================
// HANDLE REDIRECTION
// =============================================================================

/**
 * Redirect a handle to point to another handle's resource.
 *
 * Returns saved handle ID for later restoration.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param target - Target fd to redirect
 * @param source - Source fd to redirect to
 */
export async function* handleRedirect(
    proc: Process,
    kernel: Kernel,
    target: unknown,
    source: unknown,
): AsyncIterable<Response> {
    if (typeof target !== 'number') {
        yield respond.error('EINVAL', 'target must be a number');

        return;
    }

    if (typeof source !== 'number') {
        yield respond.error('EINVAL', 'source must be a number');

        return;
    }

    const saved = kernelRedirectHandle(kernel, proc, target, source);

    yield respond.ok(saved);
}

/**
 * Restore a previously redirected handle.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param target - Target fd to restore
 * @param saved - Saved handle ID from redirect
 */
export async function* handleRestore(
    proc: Process,
    kernel: Kernel,
    target: unknown,
    saved: unknown,
): AsyncIterable<Response> {
    if (typeof target !== 'number') {
        yield respond.error('EINVAL', 'target must be a number');

        return;
    }

    if (typeof saved !== 'string') {
        yield respond.error('EINVAL', 'saved must be a string');

        return;
    }

    kernelRestoreHandle(kernel, proc, target, saved);
    yield respond.ok();
}

// =============================================================================
// UNIFIED HANDLE I/O
// =============================================================================

/**
 * Send a message through a handle.
 *
 * Works on: pipes (send end), ports (UDP, pubsub), channels (HTTP, WS)
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Handle descriptor
 * @param msg - Message to send
 */
export async function* handleSend(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    msg: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'handle must be a number');

        return;
    }

    // Check process state
    if (proc.state !== 'running') {
        yield respond.error('ESRCH', 'Process is not running');

        return;
    }

    const handle = getHandle(kernel, proc, fd);

    if (!handle) {
        yield respond.error('EBADF', `Bad handle: ${fd}`);

        return;
    }

    yield* handle.exec(msg as Message);
}

/**
 * Close a handle.
 *
 * Uses reference counting; only closes underlying resource when last
 * reference is released.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Handle descriptor
 */
export async function* handleClose(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    await kernelCloseHandle(kernel, proc, fd);
    yield respond.ok();
}

// =============================================================================
// IPC PRIMITIVES
// =============================================================================

/**
 * Create a message pipe.
 *
 * Returns [recvFd, sendFd] - a pair of connected handles.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 */
export async function* ipcPipe(
    proc: Process,
    kernel: Kernel,
): AsyncIterable<Response> {
    const [recvFd, sendFd] = kernelCreatePipe(kernel, proc);

    yield respond.ok([recvFd, sendFd]);
}
