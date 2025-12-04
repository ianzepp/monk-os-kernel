/**
 * Force exit a process immediately.
 *
 * Unlike graceful exit(), this doesn't await cleanup. Used for:
 * - SIGKILL
 * - Grace period expiry after SIGTERM
 * - Shutdown
 *
 * RACE CONDITION: Multiple calls to forceExit are idempotent.
 * The state=zombie guard ensures cleanup runs only once.
 *
 * @module kernel/kernel/force-exit
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { unrefHandle } from './unref-handle.js';
import { releaseProcessWorkers } from './release-process-workers.js';
import { notifyWaiters } from './notify-waiters.js';
import { printk } from './printk.js';

/**
 * Force exit a process immediately.
 *
 * @param self - Kernel instance
 * @param proc - Process to force exit
 * @param code - Exit code
 */
export function forceExit(self: Kernel, proc: Process, code: number): void {
    // Idempotency guard
    if (proc.state === 'zombie') {
        return;
    }

    printk(self, 'exit', `Force exiting ${proc.cmd} with code ${code}`);

    proc.exitCode = code;
    proc.state = 'zombie';

    // Terminate worker immediately
    proc.worker.terminate();

    // Abort all active streams
    // WHY: Streams may be blocked on await; abort signals them to stop
    for (const abort of proc.activeStreams.values()) {
        abort.abort();
    }
    proc.activeStreams.clear();
    proc.streamPingHandlers.clear();

    // Clean up handles with refcounting
    // NOTE: Fire-and-forget is OK here because:
    // 1. unrefHandle is synchronous for the decrement
    // 2. Async close() is best-effort (we log failures)
    for (const handleId of proc.handles.values()) {
        unrefHandle(self, handleId);
    }
    proc.handles.clear();

    // Release any leased workers
    releaseProcessWorkers(self, proc);

    // Reparent children
    self.processes.reparentOrphans(proc.id);

    // Notify waiters
    notifyWaiters(self, proc);
}
