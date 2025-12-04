/**
 * Handle syscall request with streaming response and backpressure.
 *
 * STREAMING PROTOCOL:
 * 1. Kernel yields Response objects from syscall handler
 * 2. Each Response is sent via postMessage
 * 3. Consumer sends stream_ping every 100ms with items processed
 * 4. If gap (sent - acked) >= HIGH_WATER, pause yielding
 * 5. Resume when gap <= LOW_WATER
 * 6. If no ping for STALL_TIMEOUT, abort (consumer dead)
 *
 * TERMINAL OPS: ok, error, done, redirect
 * These signal end of stream.
 *
 * @module kernel/kernel/handle-syscall
 */

import type { Kernel } from '../kernel.js';
import type { Process, SyscallRequest } from '../types.js';
import { STREAM_HIGH_WATER, STREAM_LOW_WATER, STREAM_STALL_TIMEOUT } from '../types.js';
import { sendResponse } from './send-response.js';
import { printk } from './printk.js';

/**
 * State for tracking a streaming syscall's backpressure.
 */
interface StreamState {
    itemsSent: number;
    itemsAcked: number;
    lastPingTime: number;
    resumeResolve: (() => void) | null;
    abort: AbortController;
}

/**
 * Handle syscall request with streaming response and backpressure.
 *
 * @param self - Kernel instance
 * @param proc - Process making syscall
 * @param request - Syscall request
 */
export async function handleSyscall(
    self: Kernel,
    proc: Process,
    request: SyscallRequest
): Promise<void> {
    printk(self, 'syscall', `${proc.cmd}: ${request.name}`);

    // Initialize stream state
    const state: StreamState = {
        itemsSent: 0,
        itemsAcked: 0,
        lastPingTime: self.deps.now(),
        resumeResolve: null,
        abort: new AbortController(),
    };

    // Register stream for cancellation
    proc.activeStreams.set(request.id, state.abort);

    // Create ping handler
    proc.streamPingHandlers.set(request.id, (processed: number) => {
        state.itemsAcked = processed;
        state.lastPingTime = self.deps.now();

        // Resume if paused and gap is acceptable
        if (state.resumeResolve && (state.itemsSent - state.itemsAcked) <= STREAM_LOW_WATER) {
            state.resumeResolve();
            state.resumeResolve = null;
        }
    });

    try {
        const iterable = self.syscalls.dispatch(proc, request.name, request.args);

        for await (const response of iterable) {
            // Check cancellation
            if (state.abort.signal.aborted) {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> cancelled`);
                break;
            }

            // RACE FIX: Check process state after every await
            if (proc.state !== 'running') {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> process no longer running`);
                break;
            }

            // Check for stall (consumer unresponsive)
            // Only check after first item - consumer can't ping for items it hasn't received
            if (state.itemsSent > 0) {
                const stallTime = self.deps.now() - state.lastPingTime;
                if (stallTime >= STREAM_STALL_TIMEOUT) {
                    sendResponse(self, proc, request.id, {
                        op: 'error',
                        data: { code: 'ETIMEDOUT', message: 'Stream consumer unresponsive' },
                    });
                    printk(self, 'syscall', `${proc.cmd}: ${request.name} -> timeout (stall: ${stallTime}ms)`);
                    return;
                }
            }

            // Send response
            sendResponse(self, proc, request.id, response);

            // Terminal ops end the stream
            if (response.op === 'ok' || response.op === 'done' || response.op === 'error' || response.op === 'redirect') {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> ${response.op}`);
                return;
            }

            // Track non-terminal items for backpressure
            state.itemsSent++;

            // Reset ping timer on first item
            if (state.itemsSent === 1) {
                state.lastPingTime = self.deps.now();
            }

            // Backpressure check
            const gap = state.itemsSent - state.itemsAcked;
            if (gap >= STREAM_HIGH_WATER) {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> backpressure (gap=${gap})`);

                await new Promise<void>((resolve) => {
                    state.resumeResolve = resolve;

                    // Safety timeout to prevent permanent block
                    self.deps.setTimeout(() => {
                        if (state.resumeResolve === resolve) {
                            resolve();
                            state.resumeResolve = null;
                        }
                    }, STREAM_STALL_TIMEOUT);
                });

                // Re-check stall after resume
                const stallTime = self.deps.now() - state.lastPingTime;
                if (stallTime >= STREAM_STALL_TIMEOUT) {
                    sendResponse(self, proc, request.id, {
                        op: 'error',
                        data: { code: 'ETIMEDOUT', message: 'Stream consumer unresponsive' },
                    });
                    printk(self, 'syscall', `${proc.cmd}: ${request.name} -> timeout after backpressure`);
                    return;
                }
            }
        }
    } catch (error) {
        // Convert uncaught exceptions to error responses
        const err = error as Error & { code?: string };
        sendResponse(self, proc, request.id, {
            op: 'error',
            data: { code: err.code ?? 'EIO', message: err.message },
        });
        printk(self, 'syscall', `${proc.cmd}: ${request.name} -> error: ${err.code ?? 'EIO'}`);
    } finally {
        // Cleanup stream tracking
        proc.activeStreams.delete(request.id);
        proc.streamPingHandlers.delete(request.id);
    }
}
