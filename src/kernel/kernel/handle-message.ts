/**
 * Handle message from process.
 *
 * MESSAGE TYPES:
 * - syscall: Process making a syscall
 * - stream_ping: Progress report for backpressure
 * - stream_cancel: Request to cancel a streaming syscall
 *
 * @module kernel/kernel/handle-message
 */

import type { Kernel } from '../kernel.js';
import type { Process, KernelMessage, SyscallRequest } from '../types.js';
import { handleSyscall } from './handle-syscall.js';
import { handleStreamPing } from './handle-stream-ping.js';
import { handleStreamCancel } from './handle-stream-cancel.js';

/**
 * Handle message from process.
 *
 * @param self - Kernel instance
 * @param proc - Source process
 * @param msg - Message from process
 */
export async function handleMessage(
    self: Kernel,
    proc: Process,
    msg: KernelMessage
): Promise<void> {
    // RACE FIX: Check process state before handling
    // A zombie process may still have messages in flight
    if (proc.state === 'zombie') {
        return;
    }

    switch (msg.type) {
        case 'syscall':
            await handleSyscall(self, proc, msg as SyscallRequest);
            break;
        case 'stream_ping':
            handleStreamPing(self, proc, msg.id, msg.processed);
            break;
        case 'stream_cancel':
            handleStreamCancel(self, proc, msg.id);
            break;
    }
}
