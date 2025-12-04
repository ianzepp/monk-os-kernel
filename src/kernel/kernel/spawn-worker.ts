/**
 * Spawn a worker for a process.
 *
 * DESIGN: All paths starting with / are VFS paths. The VFS loader:
 * 1. Resolves the path
 * 2. Transpiles TypeScript
 * 3. Bundles dependencies
 * 4. Creates a blob URL
 *
 * The blob URL is revoked after a delay to allow the worker to load.
 *
 * @module kernel/kernel/spawn-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process, KernelMessage } from '../types.js';
import { handleMessage } from './process-message.js';
import { forceExit } from './force-exit.js';

/**
 * Delay before revoking blob URLs for worker scripts.
 * Workers need time to load the script before we can safely revoke.
 * Too short = script fails to load. Too long = memory pressure.
 */
const BLOB_URL_REVOKE_DELAY_MS = 1000;

/**
 * Spawn a worker for a process.
 *
 * @param self - Kernel instance
 * @param proc - Process to create worker for
 * @param entry - Entry point path
 * @returns Worker instance
 */
export async function spawnWorker(
    self: Kernel,
    proc: Process,
    entry: string
): Promise<Worker> {
    // Bundle the entry point
    const bundle = await self.loader.assembleBundle(entry);
    const workerUrl = self.loader.createBlobURL(bundle);

    // Create worker
    const worker = new Worker(workerUrl, {
        type: 'module',
        env: proc.env,
    });

    // Revoke blob URL after worker loads
    // WHY DELAY: Worker needs time to fetch the blob before we revoke it
    self.deps.setTimeout(() => {
        self.loader.revokeBlobURL(workerUrl);
    }, BLOB_URL_REVOKE_DELAY_MS);

    // Wire up syscall handling
    worker.onmessage = (event: MessageEvent<KernelMessage>) => {
        handleMessage(self, proc, event.data);
    };

    // Handle worker errors
    worker.onerror = (error) => {
        const msg = `Process ${proc.cmd} error: ${error.message}\n`;
        self.hal.console.error(new TextEncoder().encode(msg));
        forceExit(self, proc, 1);
    };

    return worker;
}
