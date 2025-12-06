/**
 * Syscall Transport - Worker-to-kernel communication layer
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements the transport layer for syscalls between userland
 * processes (running in Web Workers) and the kernel (running in the main thread).
 * It uses postMessage/onmessage with UUID correlation for request-response matching.
 *
 * The architecture mirrors traditional OS syscall mechanisms:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │                     User Process (Worker)                       │
 *   │  ┌─────────────────────────────────────────────────────────┐   │
 *   │  │  syscall('open', '/foo')  →  Promise<number>            │   │
 *   │  └─────────────────────────────────────────────────────────┘   │
 *   │                          │                                      │
 *   │                          ▼                                      │
 *   │  ┌─────────────────────────────────────────────────────────┐   │
 *   │  │              Syscall Transport (this module)             │   │
 *   │  │  - Serializes request with UUID                          │   │
 *   │  │  - Posts to main thread                                  │   │
 *   │  │  - Correlates response by UUID                           │   │
 *   │  │  - Resolves/rejects Promise                              │   │
 *   │  └─────────────────────────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────────────────────────┘
 *                          │ postMessage
 *                          ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │                     Kernel (Main Thread)                        │
 *   │  - Receives syscall request                                     │
 *   │  - Dispatches to syscall handler                                │
 *   │  - Sends response with matching UUID                            │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * TWO REQUEST MODES
 * =================
 * 1. Single-response (syscall): Request returns one response, then completes
 * 2. Streaming (syscallStream): Request yields multiple responses until terminal
 *
 * STATE MACHINE (Single Request)
 * ==============================
 *
 *   syscall() ──────> PENDING ──────> RESOLVED/REJECTED
 *                        │                   │
 *                        │ (kernel response) │
 *                        │ (or timeout)      │
 *                        └───────────────────┘
 *
 * STATE MACHINE (Streaming Request)
 * =================================
 *
 *   syscallStream() ──────> STREAMING ──────> ENDED
 *                              │   ▲           │
 *                              │   │           │ (done/error/ok/redirect)
 *                              │   │           │ (or cancellation)
 *                              ▼   │           │
 *                           yield response ────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every request UUID is unique (crypto.randomUUID)
 *        VIOLATED BY: UUID collision (astronomically unlikely)
 * INV-2: Every pending request is resolved or rejected exactly once
 *        VIOLATED BY: Missing cleanup, double response from kernel
 * INV-3: Streaming requests end on 'ok', 'done', 'error', or 'redirect' response
 *        VIOLATED BY: Kernel yielding after terminal op
 * INV-4: Signal handler is optional; default behavior is exit on SIGTERM
 *        VIOLATED BY: N/A (by design)
 * INV-5: Transport auto-initializes on first syscall
 *        VIOLATED BY: Calling onSignal before any syscall (harmless)
 * INV-6: Cancelled streams wake blocked consumers with error
 *        VIOLATED BY: cancelStream not setting error/calling wakeup
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript event loop serializes message handling. Multiple concurrent
 * syscalls are safe - each has a unique UUID and independent Promise.
 * Streaming requests yield to the event loop between items, allowing
 * other messages to be processed.
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * Worker thread memory is isolated from main thread. Communication only via
 * postMessage (structured clone) crossing thread boundaries.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: UUID correlation prevents response mismatch
 * RC-2: pending/pendingStreams maps are modified atomically (single-threaded)
 * RC-3: Stream cleanup in finally block ensures map cleanup even on exception
 * RC-4: Timeout ensures single-response syscalls don't hang forever
 * RC-5: cancelStream sets error state and wakes consumer before deleting
 * RC-6: initTransport is idempotent (safe to call multiple times)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Pending requests are removed from map on response/rejection/timeout
 * - Streaming requests are removed from map when iteration completes
 * - Timeout handles are cleared on response to prevent leaks
 * - Signal handler reference is module-level (persists for process lifetime)
 *
 * TIMEOUT BEHAVIOR
 * ================
 * Single-response syscalls have a configurable timeout (default 30s).
 * If kernel doesn't respond within timeout:
 * - Request is removed from pending map
 * - Promise is rejected with ETIMEDOUT
 * - Late responses are ignored (logged as warning)
 *
 * Streaming syscalls don't have an overall timeout, but the kernel implements
 * stall detection (STREAM_STALL_TIMEOUT = 5s) if consumer stops pinging.
 *
 * @module process/syscall
 */

/// <reference lib="webworker" />

import type {
    SyscallRequest,
    SyscallResponse,
    SignalMessage,
    StreamPingMessage,
    StreamCancelMessage,
    Response,
} from './types.js';
import { fromCode } from '../errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default timeout for single-response syscalls (30 seconds).
 *
 * WHY 30s: Long enough for slow operations (large file reads, network),
 * short enough to detect hung kernels. Can be overridden per-call.
 *
 * COMPARISON: Linux has no syscall timeout (can block forever), but we're
 * in userspace where hangs are more problematic for debugging.
 */
const DEFAULT_SYSCALL_TIMEOUT = 30_000;

/**
 * Backpressure ping interval.
 *
 * WHY 100: Balances between responsiveness and overhead. Too small causes
 * excessive message traffic; too large may cause kernel to buffer too much.
 *
 * MUST MATCH: Kernel's expectation in dispatch-syscall.ts backpressure logic.
 */
const PING_INTERVAL = 100;

/**
 * SIGTERM signal number.
 *
 * WHY 15: Standard Unix signal number for termination request.
 * POSIX: SIGTERM is the default signal sent by kill(1).
 */
const SIGTERM = 15;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Worker global context type.
 *
 * WHY declare: TypeScript needs to know about the Worker global scope.
 * We're running in a Web Worker, not the main thread.
 */
declare const self: DedicatedWorkerGlobalScope;

/**
 * Pending syscall request (single response mode).
 *
 * Holds the Promise resolve/reject functions and timeout handle for cleanup.
 *
 * LIFECYCLE:
 * 1. Created when syscall() is called
 * 2. Stored in pending Map by UUID
 * 3. Resolved/rejected when response arrives OR timeout fires
 * 4. Removed from Map on completion
 */
interface PendingRequest {
    /**
     * Resolve function for successful response.
     *
     * WHY unknown: Syscalls return various types; caller casts via generic.
     */
    resolve: (result: unknown) => void;

    /**
     * Reject function for error response or timeout.
     */
    reject: (error: Error) => void;

    /**
     * Timeout handle for cleanup on response.
     *
     * WHY track: Must clear timeout when response arrives to prevent
     * rejecting an already-resolved Promise.
     */
    timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * Pending stream request (multiple response mode).
 *
 * Maintains queue and synchronization state for streaming responses.
 *
 * LIFECYCLE:
 * 1. Created when syscallStream() is called
 * 2. Responses queued as they arrive from kernel
 * 3. Consumer drains queue via for-await iteration
 * 4. Ended on terminal op or cancellation
 * 5. Removed from Map in finally block
 */
interface PendingStream {
    /**
     * Queue of responses waiting to be consumed.
     *
     * WHY queue: Responses may arrive faster than consumer processes them.
     * Queue provides buffering between kernel producer and userland consumer.
     *
     * MEMORY: Unbounded in theory, but kernel backpressure limits growth.
     */
    queue: Response[];

    /**
     * Resolve function to wake up waiting consumer.
     *
     * WHY nullable: Only set when consumer is blocked waiting for data.
     * Set to null after waking to prevent double-wake.
     *
     * INVARIANT: Non-null only when consumer is blocked in await.
     */
    wakeup: (() => void) | null;

    /**
     * Whether stream has received terminal response.
     *
     * INVARIANT: Once true, no more responses will be queued.
     * Terminal ops: 'ok', 'done', 'error', 'redirect'
     */
    ended: boolean;

    /**
     * Terminal error if stream failed or was cancelled.
     *
     * WHY separate from ended: Distinguishes clean end from error end.
     * Set by: kernel error response, transport error, or cancelStream().
     */
    error: Error | null;
}

/**
 * Signal handler function type.
 *
 * Called when the kernel delivers a signal to this process.
 * Signals are async notifications, not syscall responses.
 */
export type SignalHandler = (signal: number) => void;

/**
 * Options for syscall timeout behavior.
 */
export interface SyscallOptions {
    /**
     * Timeout in milliseconds. Set to 0 to disable timeout.
     * Default: DEFAULT_SYSCALL_TIMEOUT (30s)
     */
    timeout?: number;
}

// =============================================================================
// STATE
// =============================================================================

/**
 * Pending single-response requests.
 *
 * WHY Map: O(1) lookup by UUID for response correlation.
 *
 * INVARIANT: Entries are removed when response is received OR timeout fires.
 * MEMORY: Bounded by timeout - stale entries are cleaned up.
 */
const pending = new Map<string, PendingRequest>();

/**
 * Pending streaming requests.
 *
 * WHY separate from pending: Different handling (queue vs single resolve).
 *
 * INVARIANT: Entries are removed when stream iteration completes.
 * MEMORY: Bounded by kernel backpressure and stall timeout.
 */
const pendingStreams = new Map<string, PendingStream>();

/**
 * User-registered signal handler.
 *
 * WHY nullable: Signal handling is optional; default behavior applies if null.
 * DEFAULT: Exit with code 128 + signal on SIGTERM.
 */
let signalHandler: SignalHandler | null = null;

/**
 * Transport initialization flag.
 *
 * WHY: Prevents duplicate onmessage handler registration.
 * INVARIANT: Once true, onmessage is set and will not be overwritten.
 */
let initialized = false;

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the syscall transport.
 *
 * Sets up the message handler for kernel responses. Called automatically
 * on first syscall, but can be called explicitly for early initialization.
 *
 * ALGORITHM:
 * 1. Check if already initialized (idempotent)
 * 2. Register onmessage handler
 * 3. Set initialized flag
 *
 * WHY auto-initialize: Simplifies userland code - no explicit init needed.
 * WHY idempotent: Safe to call multiple times (RC-6 mitigation).
 *
 * RACE CONDITION: Two concurrent syscalls before init both call this.
 * SAFE: Function is synchronous and sets initialized before returning.
 */
export function initTransport(): void {
    if (initialized) {
        return;
    }

    self.onmessage = (event: MessageEvent) => {
        const msg = event.data;

        if (msg.type === 'response') {
            handleResponse(msg as SyscallResponse);
        }
        else if (msg.type === 'signal') {
            handleSignal(msg as SignalMessage);
        }
        // WHY no else: Unknown message types are ignored. Could be future
        // protocol extensions. Logging would be noisy.
    };

    initialized = true;
}

// =============================================================================
// RESPONSE HANDLERS
// =============================================================================

/**
 * Handle syscall response from kernel.
 *
 * ALGORITHM:
 * 1. Check if response is for a streaming request
 * 2. If streaming, delegate to handleStreamResponse
 * 3. Otherwise, look up pending request by UUID
 * 4. If not found, log warning (late response after timeout/cancel)
 * 5. Clear timeout to prevent double-rejection
 * 6. Resolve or reject based on response content
 * 7. Remove from pending map
 *
 * @param msg - Response message from kernel
 */
function handleResponse(msg: SyscallResponse): void {
    // -------------------------------------------------------------------------
    // Check for streaming request first
    // -------------------------------------------------------------------------
    const stream = pendingStreams.get(msg.id);

    if (stream) {
        handleStreamResponse(stream, msg);

        return;
    }

    // -------------------------------------------------------------------------
    // Single-response request
    // -------------------------------------------------------------------------
    const req = pending.get(msg.id);

    if (!req) {
        // Response for unknown request
        // WHY warn: Could be late response after timeout, or kernel bug.
        // Logging helps debug but isn't fatal.
        console.warn(`syscall: response for unknown request ${msg.id}`);

        return;
    }

    // INVARIANT: Remove from map before resolving to prevent double-handling
    pending.delete(msg.id);

    // Clear timeout to prevent rejecting after resolve
    // WHY: If response arrives, timeout shouldn't fire
    if (req.timeoutId !== null) {
        clearTimeout(req.timeoutId);
    }

    // -------------------------------------------------------------------------
    // Handle response content
    // -------------------------------------------------------------------------
    if (msg.error) {
        // Transport-level error (kernel couldn't dispatch)
        req.reject(fromCode(msg.error.code, msg.error.message));
    }
    else {
        // Unwrap the Response to extract the actual value
        const response = msg.result as Response;

        if (response.op === 'ok') {
            // Success - resolve with unwrapped data
            req.resolve(response.data);
        }
        else if (response.op === 'error') {
            // Syscall-level error (handler returned error)
            const err = response.data as { code: string; message: string };

            req.reject(fromCode(err.code, err.message));
        }
        else {
            // Unexpected op for single-response syscall
            // WHY reject: Caller expects single value, not stream
            req.reject(new Error(`Unexpected response op for single syscall: ${response.op}`));
        }
    }
}

/**
 * Handle streaming response from kernel.
 *
 * ALGORITHM:
 * 1. If kernel-level error, set stream error state and mark ended
 * 2. Otherwise, queue the response
 * 3. Check for terminal ops (ok, done, error, redirect) to mark ended
 * 4. Wake up consumer if waiting
 *
 * TERMINAL OPS:
 * - 'ok': Success with optional final value
 * - 'done': Clean completion (after yielding items)
 * - 'error': Operation failed
 * - 'redirect': Follow redirect (symlinks, mounts)
 *
 * @param stream - Stream state object
 * @param msg - Response message from kernel
 */
function handleStreamResponse(stream: PendingStream, msg: SyscallResponse): void {
    // Already ended - ignore late responses
    // WHY: Kernel may send responses after we've cancelled
    if (stream.ended) {
        return;
    }

    if (msg.error) {
        // Kernel-level error (transport failure, not application error)
        stream.error = fromCode(msg.error.code, msg.error.message);
        stream.ended = true;
    }
    else {
        // Queue the response for consumer
        const response = msg.result as Response;

        stream.queue.push(response);

        // Check for terminal ops that end the stream
        // MUST MATCH: Kernel's terminal op list in dispatch-syscall.ts
        if (response.op === 'ok' || response.op === 'done' ||
            response.op === 'error' || response.op === 'redirect') {
            stream.ended = true;
        }
    }

    // Wake up consumer if blocked waiting for data
    if (stream.wakeup) {
        stream.wakeup();
        stream.wakeup = null;
    }
}

/**
 * Handle signal from kernel.
 *
 * ALGORITHM:
 * 1. If user handler registered, call it
 * 2. Otherwise, apply default behavior (exit on SIGTERM)
 *
 * WHY default exit on SIGTERM: Matches Unix behavior. Allows graceful
 * shutdown without requiring explicit signal handling.
 *
 * NOTE: SIGKILL is never delivered - kernel terminates worker immediately.
 *
 * @param msg - Signal message from kernel
 */
function handleSignal(msg: SignalMessage): void {
    if (signalHandler) {
        signalHandler(msg.signal);
    }
    else {
        // Default behavior: exit on SIGTERM
        if (msg.signal === SIGTERM) {
            // WHY direct postMessage: Can't import exit() without circular dep.
            // Exit code 128 + signal is Unix convention for signal termination.
            self.postMessage({
                type: 'syscall',
                id: crypto.randomUUID(),
                name: 'exit',
                args: [128 + msg.signal],
            });
        }
    }
}

// =============================================================================
// PUBLIC API - SIGNALS
// =============================================================================

/**
 * Register a signal handler.
 *
 * Replaces default signal handling with custom handler. Only one handler
 * can be registered at a time (last registration wins).
 *
 * WHY single handler: Matches Unix signal disposition model. Multiple
 * handlers would require dispatch logic that doesn't exist in POSIX.
 *
 * @param handler - Function to call when signal received
 *
 * @example
 * onSignal((signal) => {
 *     if (signal === SIGTERM) {
 *         cleanup();
 *         exit(0);
 *     }
 * });
 */
export function onSignal(handler: SignalHandler): void {
    signalHandler = handler;
}

// =============================================================================
// PUBLIC API - SINGLE-RESPONSE SYSCALLS
// =============================================================================

/**
 * Make a syscall to the kernel (single response).
 *
 * ALGORITHM:
 * 1. Auto-initialize transport if needed
 * 2. Generate unique UUID for request
 * 3. Create Promise with resolve/reject and optional timeout
 * 4. Store in pending map
 * 5. Post request message to kernel
 * 6. Return Promise (resolved when kernel responds or timeout fires)
 *
 * TIMEOUT BEHAVIOR:
 * - Default timeout is 30 seconds
 * - On timeout, Promise rejects with ETIMEDOUT
 * - Request is removed from pending map
 * - Late responses are logged and ignored
 * - Set timeout to 0 to disable (not recommended)
 *
 * WHY Promise: Matches modern async JavaScript patterns. Syscalls are
 * inherently async (cross-thread communication).
 *
 * @param name - Syscall name (e.g., 'open', 'read', 'write')
 * @param args - Syscall arguments (varies by syscall)
 * @returns Promise resolving to syscall result
 * @throws ETIMEDOUT if kernel doesn't respond within timeout
 *
 * @example
 * const fd = await syscall<number>('open', '/etc/passwd', { read: true });
 */
export function syscall<T>(name: string, ...args: unknown[]): Promise<T> {
    return syscallWithOptions<T>(name, args, {});
}

/**
 * Make a syscall with custom options (timeout, etc.).
 *
 * @param name - Syscall name
 * @param args - Syscall arguments as array
 * @param options - Syscall options (timeout)
 * @returns Promise resolving to syscall result
 */
export function syscallWithOptions<T>(
    name: string,
    args: unknown[],
    options: SyscallOptions,
): Promise<T> {
    // Auto-initialize on first syscall
    if (!initialized) {
        initTransport();
    }

    const id = crypto.randomUUID();
    const timeout = options.timeout ?? DEFAULT_SYSCALL_TIMEOUT;

    return new Promise((resolve, reject) => {
        // -------------------------------------------------------------------------
        // Setup timeout (RC-4 mitigation)
        // -------------------------------------------------------------------------
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        if (timeout > 0) {
            timeoutId = setTimeout(() => {
                // Check if still pending (response may have arrived)
                const req = pending.get(id);

                if (req) {
                    pending.delete(id);
                    reject(fromCode('ETIMEDOUT', `Syscall '${name}' timed out after ${timeout}ms`));
                }
            }, timeout);
        }

        // -------------------------------------------------------------------------
        // Register pending request
        // -------------------------------------------------------------------------
        const entry: PendingRequest = {
            resolve: resolve as (v: unknown) => void,
            reject,
            timeoutId,
        };

        pending.set(id, entry);

        // -------------------------------------------------------------------------
        // Send request to kernel
        // -------------------------------------------------------------------------
        const request: SyscallRequest = {
            type: 'syscall',
            id,
            name,
            args,
        };

        self.postMessage(request);
    });
}

// =============================================================================
// PUBLIC API - STREAMING SYSCALLS
// =============================================================================

/**
 * Make a streaming syscall to the kernel.
 *
 * Returns an async iterable that yields responses as they arrive from the
 * kernel. Handles backpressure by periodically pinging the kernel with
 * progress updates.
 *
 * ALGORITHM:
 * 1. Auto-initialize transport if needed
 * 2. Generate unique UUID for request
 * 3. Create stream state object
 * 4. Post request message to kernel
 * 5. Loop: wait for responses, yield them, until terminal op or error
 * 6. Cleanup stream state in finally block
 *
 * BACKPRESSURE:
 * Every PING_INTERVAL items (100), sends a ping to kernel with count processed.
 * This allows kernel to throttle if consumer is slow. Kernel pauses at
 * HIGH_WATER (1000 items) and resumes at LOW_WATER (100 items).
 *
 * TERMINAL OPS:
 * - 'ok': Success response (single value, stream ends)
 * - 'done': Stream complete (after yielding items)
 * - 'error': Operation failed
 * - 'redirect': Follow redirect (symlinks, mounts)
 *
 * CANCELLATION:
 * Call cancelStream(id) to abort. Consumer will receive an error on next
 * iteration attempt.
 *
 * @param name - Syscall name
 * @param args - Syscall arguments
 * @yields Response objects from kernel
 *
 * @example
 * for await (const response of syscallStream('readdir', '/home')) {
 *     if (response.op === 'item') {
 *         console.log(response.data);
 *     }
 * }
 */
export async function* syscallStream(name: string, ...args: unknown[]): AsyncIterable<Response> {
    // Auto-initialize on first syscall
    if (!initialized) {
        initTransport();
    }

    const id = crypto.randomUUID();

    // -------------------------------------------------------------------------
    // Create stream state
    // -------------------------------------------------------------------------
    const stream: PendingStream = {
        queue: [],
        wakeup: null,
        ended: false,
        error: null,
    };

    pendingStreams.set(id, stream);

    // -------------------------------------------------------------------------
    // Send the syscall request
    // -------------------------------------------------------------------------
    const request: SyscallRequest = {
        type: 'syscall',
        id,
        name,
        args,
    };

    self.postMessage(request);

    // -------------------------------------------------------------------------
    // Consume responses
    // -------------------------------------------------------------------------
    let itemsProcessed = 0;

    try {
        while (true) {
            // Wait for responses if queue is empty and not ended
            while (stream.queue.length === 0 && !stream.ended && !stream.error) {
                await new Promise<void>(resolve => {
                    stream.wakeup = resolve;
                });
            }

            // Check for error (set by kernel error, transport error, or cancel)
            if (stream.error) {
                throw stream.error;
            }

            // Drain the queue
            while (stream.queue.length > 0) {
                const response = stream.queue.shift()!;

                itemsProcessed++;

                // Ping kernel periodically for backpressure feedback
                // WHY modulo: Reduces message overhead while keeping kernel informed
                if (itemsProcessed % PING_INTERVAL === 0) {
                    const ping: StreamPingMessage = {
                        type: 'stream_ping',
                        id,
                        processed: itemsProcessed,
                    };

                    self.postMessage(ping);
                }

                yield response;

                // Terminal ops end iteration
                // MUST MATCH: Kernel's terminal op list
                if (response.op === 'ok' || response.op === 'done' ||
                    response.op === 'error' || response.op === 'redirect') {
                    return;
                }
            }

            // If ended and queue is empty, we're done
            if (stream.ended) {
                return;
            }
        }
    }
    finally {
        // -------------------------------------------------------------------------
        // Cleanup (always runs, even on error/cancel/break)
        // -------------------------------------------------------------------------

        // Remove from map AFTER sending final ping
        // WHY order: Kernel may send responses between delete and ping,
        // but that's harmless (handleStreamResponse checks ended flag)

        // Send final ping so kernel knows we're done consuming
        // WHY: Kernel uses ping count for backpressure calculation
        try {
            const ping: StreamPingMessage = {
                type: 'stream_ping',
                id,
                processed: itemsProcessed,
            };

            self.postMessage(ping);
        }
        catch {
            // Worker may be terminating - ignore postMessage errors
        }

        pendingStreams.delete(id);
    }
}

/**
 * Cancel a streaming syscall.
 *
 * Sends cancellation message to kernel and wakes blocked consumer with error.
 * Kernel will stop sending responses for this request.
 *
 * ALGORITHM:
 * 1. Look up stream state
 * 2. If not found, just send cancel to kernel (may be racing with completion)
 * 3. If found, set error state to wake consumer
 * 4. Wake consumer if blocked
 * 5. Send cancel message to kernel
 * 6. Remove from pending map
 *
 * RACE CONDITION (RC-5 mitigation):
 * Consumer may be blocked in await when cancel is called.
 * We set error and call wakeup BEFORE deleting from map.
 * Consumer will wake, see error, and throw.
 *
 * @param id - Request UUID to cancel
 */
export function cancelStream(id: string): void {
    const stream = pendingStreams.get(id);

    if (stream) {
        // Set error state so consumer knows it was cancelled
        // WHY ECANCELED: POSIX error code for operation cancelled
        stream.error = fromCode('ECANCELED', 'Stream cancelled');
        stream.ended = true;

        // Wake consumer if blocked waiting for data
        // CRITICAL: Must wake BEFORE deleting from map
        if (stream.wakeup) {
            stream.wakeup();
            stream.wakeup = null;
        }
    }

    // Send cancel message to kernel
    // WHY always send: Stream may have completed but kernel might still be yielding
    const cancel: StreamCancelMessage = {
        type: 'stream_cancel',
        id,
    };

    self.postMessage(cancel);

    // Remove from map (safe even if not present)
    pendingStreams.delete(id);
}

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Get count of pending single-response syscalls.
 *
 * TESTING: Allows tests to verify no leaked requests.
 *
 * @returns Number of pending requests
 */
export function getPendingCount(): number {
    return pending.size;
}

/**
 * Get count of pending streaming syscalls.
 *
 * TESTING: Allows tests to verify no leaked streams.
 *
 * @returns Number of pending streams
 */
export function getPendingStreamCount(): number {
    return pendingStreams.size;
}

/**
 * Reset transport state for testing.
 *
 * TESTING: Clears all pending requests and streams.
 * WARNING: Only use in tests - will orphan any in-flight syscalls.
 */
export function resetTransportForTesting(): void {
    // Clear timeouts for pending requests
    for (const req of pending.values()) {
        if (req.timeoutId !== null) {
            clearTimeout(req.timeoutId);
        }
    }

    pending.clear();
    pendingStreams.clear();
    signalHandler = null;
    // Note: Don't reset initialized - onmessage handler persists
}
