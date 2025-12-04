/**
 * Worker Pool Lease Syscall
 *
 * WHY: Allocates a worker from a named pool, tracking ownership so workers can
 * be automatically released when the owning process exits. Enables process-level
 * resource management without manual cleanup.
 *
 * RESOURCE LIFECYCLE:
 * 1. Process calls pool:lease → get worker from PoolManager
 * 2. Track worker in Kernel.leasedWorkers[proc.id]
 * 3. Process uses worker (load, send, recv)
 * 4. Process calls worker:release → return to pool, remove from tracking
 * 5. If process exits → auto-release all leased workers (cleanup-process.ts)
 *
 * INVARIANT: Every leased worker is tracked in Kernel.leasedWorkers
 * VIOLATED BY: Lease without tracking, or release without cleanup (worker leak)
 *
 * @module kernel/kernel/lease-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Lease a worker from a pool.
 *
 * ALGORITHM:
 * 1. Request worker from PoolManager (may block if pool exhausted)
 * 2. Get or create per-process worker tracking Map
 * 3. Add worker to tracking Map (enables auto-cleanup on process exit)
 * 4. Return worker ID to caller
 *
 * WHY: Per-process tracking allows automatic cleanup when process exits without
 * explicit release. This prevents worker leaks from crashed or killed processes.
 *
 * MEMORY: Kernel.leasedWorkers is a two-level Map structure:
 * - Outer Map: process ID → inner Map
 * - Inner Map: worker ID → LeasedWorker
 * When inner Map becomes empty, we delete the outer entry to avoid memory leak.
 *
 * @param self - Kernel instance
 * @param proc - Process requesting worker
 * @param pool - Pool name (optional, defaults to 'freelance')
 * @returns Worker ID (UUID)
 */
export async function leaseWorker(
    self: Kernel,
    proc: Process,
    pool?: string
): Promise<string> {
    // Step 1: Get worker from pool (may block if pool exhausted)
    // WHY: PoolManager handles auto-scaling, backpressure, and idle timeout
    const worker = await self.poolManager.lease(pool);

    // Step 2: Get or create per-process worker tracking Map
    let procWorkers = self.leasedWorkers.get(proc.id);
    if (!procWorkers) {
        procWorkers = new Map();
        self.leasedWorkers.set(proc.id, procWorkers);
    }

    // Step 3: Track worker ownership (enables auto-cleanup on process exit)
    procWorkers.set(worker.id, worker);

    // Step 4: Return worker ID to caller
    return worker.id;
}
