/**
 * Process Message Dispatcher
 *
 * WHY: Handles all messages from worker processes, routing them to appropriate
 * handlers based on message type. This is the kernel's main entry point for
 * process communication via worker.onmessage.
 *
 * MESSAGE TYPES:
 * - syscall: Process making a system call (handled by dispatch-syscall.ts)
 * - stream_ping: Backpressure acknowledgement (handled by on-stream-ping.ts)
 * - stream_cancel: Consumer abort request (handled by on-stream-cancel.ts)
 *
 * VIRTUAL PROCESS SUPPORT:
 * Syscall messages include a `pid` field identifying which process context
 * to use. The kernel looks up the process by pid and validates that
 * proc.worker === sourceWorker. This enables virtual processes where
 * multiple process contexts share a single Worker thread.
 *
 * RACE CONDITION: Process may be in zombie state but still have messages in
 * flight. We check process state before dispatching to avoid processing
 * syscalls from dead processes.
 *
 * @module kernel/kernel/process-message
 */

import type { Kernel } from '../kernel.js';
import type { KernelMessage, SyscallRequest } from '../types.js';
import { EPERM } from '@src/hal/errors.js';
import { handleSyscall } from './dispatch-syscall.js';
import { handleStreamPing } from './on-stream-ping.js';
import { handleStreamCancel } from './on-stream-cancel.js';
import { sendResponse } from './send-response.js';
import { printk } from './printk.js';

/**
 * Handle message from process worker.
 *
 * ALGORITHM:
 * 1. For syscall messages:
 *    a. Look up process by pid from message
 *    b. Validate proc.worker === sourceWorker
 *    c. Check if process is zombie
 *    d. Dispatch to syscall handler
 * 2. For stream messages (ping/cancel):
 *    a. Look up process by pid
 *    b. Validate worker and dispatch
 *
 * VIRTUAL PROCESS SUPPORT:
 * Syscalls include pid to identify which process context to use. This enables
 * gatewayd to create virtual processes and proxy syscalls on their behalf.
 * The kernel validates that the Worker making the syscall matches the process's
 * Worker (for regular processes) or the parent's Worker (for virtual processes).
 *
 * SECURITY:
 * A process cannot impersonate another process because the kernel validates
 * that the message came from the correct Worker. Virtual processes share their
 * creator's Worker, so the creator can act on their behalf.
 *
 * @param self - Kernel instance
 * @param sourceWorker - Worker that sent the message
 * @param msg - Message from process worker
 */
export async function handleMessage(
    self: Kernel,
    sourceWorker: Worker,
    msg: KernelMessage,
): Promise<void> {
    // -------------------------------------------------------------------------
    // Look up process by pid
    // -------------------------------------------------------------------------

    // For syscall messages, pid is in the message
    // For stream messages, we need to find the process that owns this stream
    let pid: string | undefined;

    if (msg.type === 'syscall') {
        pid = (msg as SyscallRequest).pid;
    }
    else if (msg.type === 'stream_ping' || msg.type === 'stream_cancel') {
        // Stream messages reference an existing syscall - find the process
        // that owns this stream by searching all processes
        // WHY SEARCH: Stream messages don't include pid (protocol compatibility)
        // This is O(n) but stream operations are infrequent
        for (const proc of self.processes.all()) {
            if (proc.activeStreams.has(msg.id)) {
                pid = proc.id;
                break;
            }
        }
    }

    if (!pid) {
        printk(self, 'warn', `Message without process ID: ${msg.type}`);

        return;
    }

    const proc = self.processes.get(pid);

    if (!proc) {
        printk(self, 'warn', `Message for unknown process: ${pid}`);

        return;
    }

    // -------------------------------------------------------------------------
    // Validate worker ownership
    // -------------------------------------------------------------------------

    // SECURITY: Verify the message came from the correct Worker
    // - For regular processes: proc.worker === sourceWorker
    // - For virtual processes: proc.worker === parent's worker === sourceWorker
    if (proc.worker !== sourceWorker) {
        printk(self, 'warn', `Worker mismatch for process ${pid}`);

        if (msg.type === 'syscall') {
            // Send error response for syscalls
            sendResponse(self, proc, (msg as SyscallRequest).id, {
                op: 'error',
                data: { code: 'EPERM', message: 'Worker mismatch' },
            });
        }

        return;
    }

    // -------------------------------------------------------------------------
    // Check process state
    // -------------------------------------------------------------------------

    // RACE FIX: Check process state before handling
    // WHY: A zombie process may still have messages in flight from before
    // termination. Ignore these to avoid operating on dead process state.
    if (proc.state === 'zombie') {
        return;
    }

    // -------------------------------------------------------------------------
    // Dispatch by message type
    // -------------------------------------------------------------------------

    switch (msg.type) {
        case 'syscall':
            // System call request (async, may yield multiple responses)
            await handleSyscall(self, proc, msg as SyscallRequest);
            break;

        case 'stream_ping':
            // Backpressure acknowledgement (sync, no response)
            handleStreamPing(self, proc, msg.id, msg.processed);
            break;

        case 'stream_cancel':
            // Consumer abort request (sync, no response)
            handleStreamCancel(self, proc, msg.id);
            break;

        // WHY: No default case - TypeScript exhaustiveness checking ensures
        // all KernelMessage types are handled. Adding a default would mask
        // missing cases when new message types are added.
    }
}
