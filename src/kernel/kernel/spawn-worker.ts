/**
 * Worker Thread Creation - Create and initialize Bun Worker for process
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Creates a Bun Worker thread for a process by:
 * 1. Loading the entry point from VFS (transpiling TypeScript if needed)
 * 2. Bundling dependencies into a single module
 * 3. Creating a blob URL for the bundled code
 * 4. Creating a Worker with the blob URL
 * 5. Wiring up message handlers for syscalls and errors
 * 6. Scheduling blob URL cleanup after worker loads
 *
 * VFS paths (starting with /) are resolved through the VFS loader which
 * handles transpilation, bundling, and dependency resolution.
 *
 * INVARIANTS
 * ==========
 * INV-1: Worker must load script before blob URL is revoked
 *        VIOLATED BY: Revoking blob too quickly (< BLOB_URL_REVOKE_DELAY_MS)
 * INV-2: Worker message handler must be set before worker executes
 *        VIOLATED BY: Worker sending syscall before onmessage is set
 * INV-3: Worker error handler must be set to prevent unhandled errors
 *        VIOLATED BY: Not setting onerror handler
 * INV-4: Process must be in correct state before worker starts
 *        VIOLATED BY: Creating worker for zombie/stopped process
 *
 * CONCURRENCY MODEL
 * =================
 * Worker creation is asynchronous and involves cross-thread communication:
 *
 * 1. MAIN THREAD: Bundle script (VFS loader)
 * 2. MAIN THREAD: Create blob URL (synchronous)
 * 3. MAIN THREAD: new Worker() returns immediately (worker not yet started)
 * 4. WORKER THREAD: Loads script from blob URL (async, parallel)
 * 5. MAIN THREAD: Schedule blob cleanup after delay
 * 6. WORKER THREAD: Script executes, may start sending syscalls
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * Worker thread memory is isolated from main thread. Communication only via
 * postMessage (structured clone) crossing thread boundaries.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Blob URL revoked after delay, not immediately
 *       WHY: Worker needs time to fetch blob before revocation
 *       TIMING: 1000ms is conservative for script loading
 * RC-2: Message handlers set synchronously before worker can send
 *       WHY: Worker script may execute immediately after Worker()
 *       SAFE: onmessage/onerror set before any await points
 * RC-3: forceExit called on worker errors to prevent zombie
 *       WHY: Worker errors leave process in invalid state
 *       CLEANUP: Ensures handles are closed, waiters notified
 *
 * MEMORY MANAGEMENT
 * =================
 * Resources created and their cleanup:
 * - Bundle blob: Revoked after BLOB_URL_REVOKE_DELAY_MS
 * - Blob URL: Revoked automatically when blob is revoked
 * - Worker thread: Terminated in exit/forceExit
 * - Message handlers: Cleared when worker terminates
 * - Timeout: Fires once and clears automatically
 *
 * TESTABILITY
 * ===========
 * - deps.setTimeout injectable for testing blob cleanup timing
 * - VFS loader injectable for testing with mock scripts
 * - Message handlers call pure functions (handleMessage, forceExit)
 *
 * @module kernel/kernel/spawn-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process, KernelMessage } from '../types.js';
import { handleMessage } from './process-message.js';
import { forceExit } from './force-exit.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Delay before revoking blob URLs for worker scripts.
 *
 * WHY: Workers need time to load the script before we can safely revoke.
 * TOO SHORT: Script fails to load, worker crashes immediately.
 * TOO LONG: Memory pressure from accumulated unreleased blobs.
 * 1000ms: Conservative value that handles even slow script parsing.
 *
 * TESTABILITY: Can be overridden by injecting deps.setTimeout in tests.
 */
const BLOB_URL_REVOKE_DELAY_MS = 1000;

// =============================================================================
// WORKER CREATION
// =============================================================================

/**
 * Spawn a Bun Worker thread for a process.
 *
 * WHY ASYNC: VFS loader bundle creation is asynchronous.
 * WHY BLOB URL: Workers require a URL, can't load from memory directly.
 * WHY MESSAGE HANDLERS: Worker needs to communicate with kernel.
 * WHY ERROR HANDLER: Worker errors must trigger cleanup to prevent zombies.
 *
 * ALGORITHM:
 * 1. Load and bundle entry point via VFS loader
 * 2. Create blob URL from bundled code
 * 3. Create Worker with blob URL and process environment
 * 4. Schedule blob URL cleanup after delay
 * 5. Wire up syscall message handler
 * 6. Wire up error handler (calls forceExit on failure)
 * 7. Return ready worker
 *
 * RACE CONDITION:
 * Worker may start executing before this function returns. This is safe
 * because:
 * - Message handlers are set synchronously before any await
 * - Process is not yet registered (syscalls will fail gracefully)
 * - Worker thread has isolated memory (no shared state corruption)
 *
 * @param self - Kernel instance
 * @param proc - Process to create worker for
 * @param entry - Entry point path in VFS (e.g., '/bin/shell')
 * @returns Worker instance ready to receive messages
 *
 * @throws ENOENT - Entry point does not exist in VFS
 * @throws EACCES - Entry point is not accessible
 * @throws Error - Bundling failed or Worker creation failed
 */
export async function spawnWorker(
    self: Kernel,
    proc: Process,
    entry: string,
): Promise<Worker> {
    // =========================================================================
    // STEP 1: Bundle entry point from VFS
    // =========================================================================

    // WHY AWAIT: VFS loader may need to transpile TypeScript, resolve imports
    // THROWS: ENOENT if entry doesn't exist, bundling errors on invalid code
    const bundle = await self.loader.assembleBundle(entry);
    const workerUrl = self.loader.createBlobURL(bundle);

    // =========================================================================
    // STEP 2: Create Worker with blob URL
    // =========================================================================

    // WHY ENV: Process environment variables passed to worker context
    // WHY MODULE: Entry point is ES module (import/export syntax)
    const worker = new Worker(workerUrl, {
        type: 'module',
        env: proc.env,
    });

    // =========================================================================
    // STEP 3: Schedule blob URL cleanup
    // =========================================================================

    // WHY DELAY: Worker needs time to fetch the blob before we revoke it
    // MEMORY: Blob is released after worker loads, preventing accumulation
    self.deps.setTimeout(() => {
        self.loader.revokeBlobURL(workerUrl);
    }, BLOB_URL_REVOKE_DELAY_MS);

    // =========================================================================
    // STEP 4: Wire up syscall message handler
    // =========================================================================

    // WHY BEFORE AWAIT: Worker may start executing immediately
    // HANDLER: Routes syscalls to dispatcher, manages streaming responses
    // WHY PASS WORKER: handleMessage looks up process by pid from message,
    // then validates that proc.worker === this worker. This enables virtual
    // processes where multiple process contexts share a single Worker.
    worker.onmessage = (event: MessageEvent<KernelMessage>) => {
        handleMessage(self, worker, event.data);
    };

    // =========================================================================
    // STEP 5: Wire up error handler
    // =========================================================================

    // WHY FORCE EXIT: Worker errors indicate unrecoverable state
    // EXIT CODE 1: Standard failure exit code
    // CLEANUP: forceExit ensures handles closed, waiters notified, zombie reaped
    worker.onerror = error => {
        // Log error to kernel console (not process console)
        const msg = `Process ${proc.cmd} error: ${error.message}\n`;

        self.hal.console.error(new TextEncoder().encode(msg));

        // Force exit with failure code
        // WHY: Error handler means worker is in invalid state, cannot recover
        forceExit(self, proc, 1);
    };

    return worker;
}
