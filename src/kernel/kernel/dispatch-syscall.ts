/**
 * Syscall Dispatcher - Streaming response with backpressure control
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements the kernel's syscall streaming protocol with consumer-driven
 * backpressure. When a process makes a syscall, the kernel executes the handler and
 * yields Response objects. Each Response is sent to the process via postMessage.
 *
 * The consumer (process library) acknowledges consumption by sending stream_ping
 * messages with the count of items processed. The kernel tracks the gap between
 * items sent vs acknowledged and pauses yielding when the gap exceeds HIGH_WATER.
 * This prevents unbounded memory growth if the consumer is slow.
 *
 * The dispatcher also detects stalled consumers (no ping for STALL_TIMEOUT) and
 * aborts the stream to prevent resource leaks.
 *
 * STATE MACHINE
 * =============
 * IDLE -> STREAMING -> [PAUSED] -> STREAMING -> TERMINATED
 *
 * IDLE: No active syscall stream
 * STREAMING: Yielding Response objects to consumer
 * PAUSED: Hit high-water mark, waiting for consumer to catch up
 * TERMINATED: Stream ended via terminal op (ok/error/done/redirect) or cancellation
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: StreamState exists in proc.activeStreams only while stream is active
 *        VIOLATED BY: Forgetting cleanup in finally block
 * INV-2: itemsSent >= itemsAcked (kernel never acknowledges unsent items)
 *        VIOLATED BY: Ping handler updating itemsAcked beyond itemsSent
 * INV-3: ping handler exists in proc.streamPingHandlers only while stream is active
 *        VIOLATED BY: Forgetting cleanup in finally block
 * INV-4: resumeResolve is null when not paused, non-null when paused
 *        VIOLATED BY: Multiple concurrent backpressure waits
 * INV-5: Terminal Response ops (ok/error/done/redirect) always end the stream
 *        VIOLATED BY: Continuing iteration after terminal op
 *
 * CONCURRENCY MODEL
 * =================
 * - Kernel runs in main thread, processes run in worker threads
 * - postMessage crosses thread boundary (async operation)
 * - Multiple syscalls from same process can run concurrently (async interleaving)
 * - StreamState is per-request, isolated across concurrent syscalls
 * - Ping handler modifies StreamState while iterator yields - synchronization via callbacks
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * postMessage crosses thread boundaries. The kernel runs in the main thread
 * while each process runs in its own worker thread.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Process killed while stream active
 *       MITIGATION: Check proc.state after every await point
 * RC-2: Stream cancelled while waiting for backpressure
 *       MITIGATION: Check abort.signal.aborted in loop before each iteration
 * RC-3: Consumer stalls (dead/hung) while kernel waits for ping
 *       MITIGATION: Safety timeout in backpressure wait, plus explicit stall detection
 * RC-4: Ping arrives while paused, then gap recalculated and resolved
 *       MITIGATION: Ping handler checks gap and resolves if <= LOW_WATER atomically
 * RC-5: Terminal op sent, but stream continues yielding
 *       MITIGATION: Explicit return after sending terminal op
 *
 * MEMORY MANAGEMENT
 * =================
 * - StreamState allocated per request, cleaned up in finally block
 * - Ping handler captured in closure, removed on cleanup
 * - AbortController registered in proc.activeStreams, removed on cleanup
 * - No cleanup on timeout/error = LEAK (ping handler persists forever)
 *
 * TESTABILITY
 * ===========
 * - Deps injection allows mocking now() and setTimeout
 * - StreamState exposed as interface for testing
 * - Constants (HIGH_WATER, LOW_WATER, STALL_TIMEOUT) imported from types
 *
 * @module kernel/kernel/dispatch-syscall
 */

import type { Kernel } from '../kernel.js';
import type { Process, SyscallRequest } from '../types.js';
import { STREAM_HIGH_WATER, STREAM_LOW_WATER, STREAM_STALL_TIMEOUT } from '../types.js';
import { sendResponse } from './send-response.js';
import { printk } from './printk.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Backpressure state for a single streaming syscall.
 *
 * LIFECYCLE: Created on syscall start, destroyed on completion/error/cancel
 *
 * INVARIANT: itemsSent >= itemsAcked (kernel never acknowledges unsent items)
 * INVARIANT: resumeResolve is null when not paused, non-null when paused
 */
interface StreamState {
    /** Items sent to consumer (incremented after each non-terminal Response) */
    itemsSent: number;

    /** Items acknowledged by consumer via stream_ping */
    itemsAcked: number;

    /** Timestamp of last ping from consumer (for stall detection) */
    lastPingTime: number;

    /**
     * Resolve function for backpressure pause (null when not paused)
     *
     * WHY: Allows ping handler to resume iteration when gap <= LOW_WATER
     */
    resumeResolve: (() => void) | null;

    /**
     * AbortController for stream cancellation
     *
     * WHY: Allows process to cancel stream via stream_cancel syscall
     */
    abort: AbortController;
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Handle syscall request with streaming response and backpressure.
 *
 * ALGORITHM:
 * 1. Initialize StreamState and register ping handler
 * 2. Call syscall handler to get AsyncIterable<Response>
 * 3. For each Response:
 *    a. Check for cancellation and process state
 *    b. Check for stalled consumer (no ping for STALL_TIMEOUT)
 *    c. Send Response via postMessage
 *    d. If terminal op (ok/error/done/redirect), end stream
 *    e. Track non-terminal items for backpressure
 *    f. If gap >= HIGH_WATER, pause until ping brings gap <= LOW_WATER
 * 4. On completion/error/cancel, cleanup ping handler and StreamState
 *
 * RACE CONDITION: Process killed while stream active
 * MITIGATION: Check proc.state !== 'running' after every await point
 *
 * RACE CONDITION: Consumer stalls (dead/hung) while kernel waits
 * MITIGATION: Safety timeout in backpressure wait (STALL_TIMEOUT)
 *            Plus explicit stall check before/after backpressure pause
 *
 * @param self - Kernel instance
 * @param proc - Process making syscall
 * @param request - Syscall request with name/args/id
 */
export async function handleSyscall(
    self: Kernel,
    proc: Process,
    request: SyscallRequest,
): Promise<void> {
    printk(self, 'syscall', `${proc.cmd}: ${request.name}`);

    // -------------------------------------------------------------------------
    // Initialize stream state
    // -------------------------------------------------------------------------

    const state: StreamState = {
        itemsSent: 0,
        itemsAcked: 0,
        lastPingTime: self.deps.now(),
        resumeResolve: null,
        abort: new AbortController(),
    };

    // Register for cancellation via stream_cancel syscall
    proc.activeStreams.set(request.id, state.abort);

    // Register ping handler (consumer sends stream_ping with items processed)
    // WHY: Ping handler runs when consumer acknowledges items, allowing
    //      backpressure resolution when gap <= LOW_WATER
    proc.streamPingHandlers.set(request.id, (processed: number) => {
        state.itemsAcked = processed;
        state.lastPingTime = self.deps.now();

        // RACE FIX: Resume paused iterator if gap is now acceptable
        // This runs concurrently with the iterator below - synchronization
        // via callback ensures gap check and resume are atomic
        if (state.resumeResolve && (state.itemsSent - state.itemsAcked) <= STREAM_LOW_WATER) {
            state.resumeResolve();
            state.resumeResolve = null;
        }
    });

    try {
        // -------------------------------------------------------------------------
        // Execute syscall handler
        // -------------------------------------------------------------------------

        const iterable = self.syscalls.dispatch(proc, request.name, request.args);

        // -------------------------------------------------------------------------
        // Stream responses with backpressure
        // -------------------------------------------------------------------------

        for await (const response of iterable) {
            // RACE FIX: Check cancellation before processing response
            if (state.abort.signal.aborted) {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> cancelled`);
                break;
            }

            // RACE FIX: Check process state after every await
            // Process may have been killed while handler was yielding
            if (proc.state !== 'running') {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> process no longer running`);
                break;
            }

            // -------------------------------------------------------------------------
            // Stall detection (consumer unresponsive)
            // -------------------------------------------------------------------------

            // WHY: Only check after first item - consumer can't ping for items
            //      it hasn't received yet. First item initializes lastPingTime.
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

            // -------------------------------------------------------------------------
            // Send response to process
            // -------------------------------------------------------------------------

            sendResponse(self, proc, request.id, response);

            // -------------------------------------------------------------------------
            // Terminal ops end stream
            // -------------------------------------------------------------------------

            // WHY: Terminal ops (ok/error/done/redirect) signal completion.
            //      Must return immediately to prevent further iteration.
            if (response.op === 'ok' || response.op === 'done' || response.op === 'error' || response.op === 'redirect') {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> ${response.op}`);

                return;
            }

            // -------------------------------------------------------------------------
            // Track non-terminal items for backpressure
            // -------------------------------------------------------------------------

            state.itemsSent++;

            // WHY: Reset ping timer on first item - consumer starts sending pings
            //      after receiving first item, not before
            if (state.itemsSent === 1) {
                state.lastPingTime = self.deps.now();
            }

            // -------------------------------------------------------------------------
            // Backpressure control
            // -------------------------------------------------------------------------

            const gap = state.itemsSent - state.itemsAcked;

            if (gap >= STREAM_HIGH_WATER) {
                printk(self, 'syscall', `${proc.cmd}: ${request.name} -> backpressure (gap=${gap})`);

                // Pause iteration until consumer catches up (gap <= LOW_WATER)
                await new Promise<void>(resolve => {
                    state.resumeResolve = resolve;

                    // Safety timeout to prevent permanent block if consumer dies
                    // WHY: If consumer crashes, ping handler will never run.
                    //      Safety timeout ensures we resume and detect stall.
                    self.deps.setTimeout(() => {
                        if (state.resumeResolve === resolve) {
                            resolve();
                            state.resumeResolve = null;
                        }
                    }, STREAM_STALL_TIMEOUT);
                });

                // RACE FIX: Re-check stall after resume
                // Consumer may have died during backpressure pause
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
    }
    catch (error) {
        // -------------------------------------------------------------------------
        // Error handling (uncaught exceptions from syscall handler)
        // -------------------------------------------------------------------------

        // WHY: Syscall handlers may throw errors (ENOENT, EBADF, etc.)
        //      Convert to error Response for consumer
        const err = error as Error & { code?: string };

        sendResponse(self, proc, request.id, {
            op: 'error',
            data: { code: err.code ?? 'EIO', message: err.message },
        });
        printk(self, 'syscall', `${proc.cmd}: ${request.name} -> error: ${err.code ?? 'EIO'}`);
    }
    finally {
        // -------------------------------------------------------------------------
        // Cleanup (always runs, even on error/cancel)
        // -------------------------------------------------------------------------

        // WHY: Must remove ping handler and StreamState to prevent memory leaks
        //      If not removed, handlers persist forever in Map
        proc.activeStreams.delete(request.id);
        proc.streamPingHandlers.delete(request.id);
    }
}
