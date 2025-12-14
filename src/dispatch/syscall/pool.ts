/**
 * Pool Syscalls - Worker pool management operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Pool syscalls provide the interface for leasing workers from kernel-managed
 * worker pools. Pools provide pre-warmed workers for compute tasks, avoiding
 * the overhead of creating new Worker threads for each task.
 *
 * Operations:
 * - pool:lease - Lease a worker from a pool
 * - pool:stats - Get pool statistics (no process context needed)
 * - worker:load - Load a script into a leased worker
 * - worker:send - Send a message to a leased worker
 * - worker:recv - Receive a message from a leased worker
 * - worker:release - Release a worker back to the pool
 *
 * DESIGN: pool:stats doesn't need proc
 * ====================================
 * The pool:stats syscall only queries kernel state and doesn't need any
 * process context. It's the exception to the "every syscall gets proc" rule.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Worker ID arguments must be validated as strings
 * INV-2: Every leased worker is tracked in kernel.leasedWorkers
 * INV-3: Released workers are removed from tracking
 * INV-4: Process exit auto-releases all leased workers
 *
 * @module syscall/pool
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { Process, Response } from '../types.js';
import { respond } from '../types.js';

// Kernel functions for pool operations
import { leaseWorker as kernelLeaseWorker } from '@src/kernel/kernel/lease-worker.js';
import { workerLoad as kernelWorkerLoad } from '@src/kernel/kernel/load-worker.js';
import { workerSend as kernelWorkerSend } from '@src/kernel/kernel/send-worker.js';
import { workerRecv as kernelWorkerRecv } from '@src/kernel/kernel/recv-worker.js';
import { workerRelease as kernelWorkerRelease } from '@src/kernel/kernel/release-worker.js';

// =============================================================================
// POOL OPERATIONS
// =============================================================================

/**
 * Lease a worker from a pool.
 *
 * @param proc - Calling process (owner of leased worker)
 * @param kernel - Kernel instance
 * @param pool - Pool name (optional, defaults to 'freelance')
 */
export async function* poolLease(
    proc: Process,
    kernel: Kernel,
    pool?: unknown,
): AsyncIterable<Response> {
    const poolName = typeof pool === 'string' ? pool : undefined;
    const workerId = await kernelLeaseWorker(kernel, proc, poolName);

    yield respond.ok(workerId);
}

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

// =============================================================================
// WORKER OPERATIONS
// =============================================================================

/**
 * Load a script into a leased worker.
 *
 * @param proc - Calling process (must own the worker)
 * @param kernel - Kernel instance
 * @param workerId - Worker ID from pool:lease
 * @param path - VFS path to script
 */
export async function* workerLoad(
    proc: Process,
    kernel: Kernel,
    workerId: unknown,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof workerId !== 'string') {
        yield respond.error('EINVAL', 'workerId must be a string');

        return;
    }

    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');

        return;
    }

    await kernelWorkerLoad(kernel, proc, workerId, path);
    yield respond.ok();
}

/**
 * Send a message to a leased worker.
 *
 * @param proc - Calling process (must own the worker)
 * @param kernel - Kernel instance
 * @param workerId - Worker ID from pool:lease
 * @param msg - Message to send
 */
export async function* workerSend(
    proc: Process,
    kernel: Kernel,
    workerId: unknown,
    msg: unknown,
): AsyncIterable<Response> {
    if (typeof workerId !== 'string') {
        yield respond.error('EINVAL', 'workerId must be a string');

        return;
    }

    await kernelWorkerSend(kernel, proc, workerId, msg);
    yield respond.ok();
}

/**
 * Receive a message from a leased worker.
 *
 * @param proc - Calling process (must own the worker)
 * @param kernel - Kernel instance
 * @param workerId - Worker ID from pool:lease
 */
export async function* workerRecv(
    proc: Process,
    kernel: Kernel,
    workerId: unknown,
): AsyncIterable<Response> {
    if (typeof workerId !== 'string') {
        yield respond.error('EINVAL', 'workerId must be a string');

        return;
    }

    const msg = await kernelWorkerRecv(kernel, proc, workerId);

    yield respond.ok(msg);
}

/**
 * Release a worker back to the pool.
 *
 * @param proc - Calling process (must own the worker)
 * @param kernel - Kernel instance
 * @param workerId - Worker ID from pool:lease
 */
export async function* workerRelease(
    proc: Process,
    kernel: Kernel,
    workerId: unknown,
): AsyncIterable<Response> {
    if (typeof workerId !== 'string') {
        yield respond.error('EINVAL', 'workerId must be a string');

        return;
    }

    await kernelWorkerRelease(kernel, proc, workerId);
    yield respond.ok();
}
