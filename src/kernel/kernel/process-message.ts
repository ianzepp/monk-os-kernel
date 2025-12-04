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
 * RACE CONDITION: Process may be in zombie state but still have messages in
 * flight. We check process state before dispatching to avoid processing
 * syscalls from dead processes.
 *
 * @module kernel/kernel/process-message
 */

import type { Kernel } from '../kernel.js';
import type { Process, KernelMessage, SyscallRequest } from '../types.js';
import { handleSyscall } from './dispatch-syscall.js';
import { handleStreamPing } from './on-stream-ping.js';
import { handleStreamCancel } from './on-stream-cancel.js';

/**
 * Handle message from process worker.
 *
 * ALGORITHM:
 * 1. Check if process is zombie (ignore messages from dead processes)
 * 2. Switch on message type and dispatch to appropriate handler
 * 3. Handlers are responsible for error handling and responses
 *
 * RACE CONDITION: Process may transition to zombie between receiving message
 * and handling it. We check state early to avoid unnecessary work, but handlers
 * must also be defensive (e.g., sendResponse catches postMessage errors).
 *
 * WHY: Early zombie check prevents processing syscalls from terminated processes.
 * Zombie processes may still have messages in the worker's message queue due to
 * async message delivery. We ignore these to avoid resurrecting dead state.
 *
 * @param self - Kernel instance
 * @param proc - Source process (may be zombie)
 * @param msg - Message from process worker
 */
export async function handleMessage(
    self: Kernel,
    proc: Process,
    msg: KernelMessage
): Promise<void> {
    // RACE FIX: Check process state before handling
    // WHY: A zombie process may still have messages in flight from before
    // termination. Ignore these to avoid operating on dead process state.
    if (proc.state === 'zombie') {
        return;
    }

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
