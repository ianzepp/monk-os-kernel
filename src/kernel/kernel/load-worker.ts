/**
 * Worker Load Syscall
 *
 * WHY: Loads a script into a leased worker, preparing it for execution. The
 * worker remains in the pool but is loaded with user code. Scripts are loaded
 * via VFS paths, allowing dynamic code loading from the filesystem.
 *
 * SECURITY: Worker must be leased by calling process (validated by getLeasedWorker).
 * Path resolution happens in VFS context with caller's permissions.
 *
 * @module kernel/kernel/load-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { getLeasedWorker } from './get-leased-worker.js';

/**
 * Load a script into a leased worker.
 *
 * ALGORITHM:
 * 1. Validate worker ownership (via getLeasedWorker)
 * 2. Delegate to LeasedWorker.load() for actual loading
 *
 * WHY: This is a thin wrapper around LeasedWorker.load(). The real work happens
 * in the worker pool layer (pool.ts), including VFS module loading, transpilation,
 * and worker initialization. We keep syscall handlers simple.
 *
 * @param self - Kernel instance
 * @param proc - Process loading the script
 * @param workerId - Worker ID (must be leased by proc)
 * @param path - VFS path to script (e.g., '/bin/worker.ts', '/lib/compute.js')
 * @throws EBADF if worker not leased by calling process
 * @throws ENOENT if script path doesn't exist (from VFS)
 */
export async function workerLoad(
    self: Kernel,
    proc: Process,
    workerId: string,
    path: string
): Promise<void> {
    // Step 1: Validate ownership and get worker
    const worker = getLeasedWorker(self, proc, workerId);

    // Step 2: Load script (VFS resolution, transpilation, worker init)
    // WHY: LeasedWorker.load() handles all complexity of module loading
    await worker.load(path);
}
