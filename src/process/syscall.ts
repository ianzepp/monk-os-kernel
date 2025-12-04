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
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                     User Process (Worker)                   │
 *   │  ┌─────────────────────────────────────────────────────┐   │
 *   │  │  syscall('open', '/foo')  →  Promise<number>        │   │
 *   │  └─────────────────────────────────────────────────────┘   │
 *   │                          │                                  │
 *   │                          ▼                                  │
 *   │  ┌─────────────────────────────────────────────────────┐   │
 *   │  │              Syscall Transport (this module)         │   │
 *   │  │  - Serializes request with UUID                      │   │
 *   │  │  - Posts to main thread                              │   │
 *   │  │  - Correlates response by UUID                       │   │
 *   │  │  - Resolves/rejects Promise                          │   │
 *   │  └─────────────────────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────────────────────┘
 *                          │ postMessage
 *                          ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                     Kernel (Main Thread)                    │
 *   │  - Receives syscall request                                 │
 *   │  - Dispatches to syscall handler                            │
 *   │  - Sends response with matching UUID                        │
 *   └─────────────────────────────────────────────────────────────┘
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
 *                        └───────────────────┘
 *
 * STATE MACHINE (Streaming Request)
 * =================================
 *
 *   syscallStream() ──────> STREAMING ──────> ENDED
 *                              │   ▲           │
 *                              │   │           │ (done/error/ok)
 *                              │   │           │
 *                              ▼   │           │
 *                           yield response ────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every request UUID is unique (crypto.randomUUID)
 * INV-2: Every pending request is resolved or rejected exactly once
 * INV-3: Streaming requests end on 'ok', 'done', or 'error' response
 * INV-4: Signal handler is optional; default behavior is exit on SIGTERM
 * INV-5: Transport auto-initializes on first syscall
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript event loop serializes message handling. Multiple concurrent
 * syscalls are safe - each has a unique UUID and independent Promise.
 * Streaming requests yield to the event loop between items, allowing
 * other messages to be processed.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: UUID correlation prevents response mismatch
 * RC-2: pending/pendingStreams maps are modified atomically (single-threaded)
 * RC-3: Stream cleanup in finally block ensures map cleanup even on exception
 *
 * MEMORY MANAGEMENT
 * =================
 * - Pending requests are removed from map on response/rejection
 * - Streaming requests are removed from map when iteration completes
 * - Signal handler reference is weak (can be garbage collected if process drops it)
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
} from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { fromCode } from '@src/hal/errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Backpressure ping interval.
 *
 * WHY 100: Balances between responsiveness and overhead. Too small causes
 * excessive message traffic; too large may cause kernel to buffer too much.
 */
const PING_INTERVAL = 100;

/**
 * SIGTERM signal number.
 *
 * WHY 15: Standard Unix signal number for termination request.
 */
const SIGTERM = 15;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Worker global context type.
 *
 * WHY declare: TypeScript needs to know about the Worker global scope.
 */
declare const self: DedicatedWorkerGlobalScope;

/**
 * Pending syscall request (single response mode).
 *
 * Holds the Promise resolve/reject functions for a pending syscall.
 */
interface PendingRequest {
    /**
     * Resolve function for successful response.
     *
     * WHY unknown: Syscalls return various types; caller casts.
     */
    resolve: (result: unknown) => void;

    /**
     * Reject function for error response.
     */
    reject: (error: Error) => void;
}

/**
 * Pending stream request (multiple response mode).
 *
 * Maintains queue and synchronization state for streaming responses.
 */
interface PendingStream {
    /**
     * Queue of responses waiting to be consumed.
     *
     * WHY queue: Responses may arrive faster than consumer processes them.
     * Queue provides buffering between kernel producer and userland consumer.
     */
    queue: Response[];

    /**
     * Resolve function to wake up waiting consumer.
     *
     * WHY nullable: Only set when consumer is blocked waiting for data.
     * Set to null after waking to prevent double-wake.
     */
    wakeup: (() => void) | null;

    /**
     * Whether stream has received terminal response.
     *
     * INVARIANT: Once true, no more responses will be queued.
     */
    ended: boolean;

    /**
     * Terminal error if stream failed.
     *
     * WHY separate from ended: Distinguishes clean end from error end.
     */
    error: Error | null;
}

/**
 * Signal handler function type.
 *
 * Called when the kernel delivers a signal to this process.
 */
export type SignalHandler = (signal: number) => void;

// =============================================================================
// STATE
// =============================================================================

/**
 * Pending single-response requests.
 *
 * WHY Map: O(1) lookup by UUID for response correlation.
 *
 * INVARIANT: Entries are removed when response is received.
 */
const pending = new Map<string, PendingRequest>();

/**
 * Pending streaming requests.
 *
 * WHY separate from pending: Different handling (queue vs single resolve).
 *
 * INVARIANT: Entries are removed when stream iteration completes.
 */
const pendingStreams = new Map<string, PendingStream>();

/**
 * User-registered signal handler.
 *
 * WHY nullable: Signal handling is optional; default behavior applies if null.
 */
let signalHandler: SignalHandler | null = null;

/**
 * Transport initialization flag.
 *
 * WHY: Prevents duplicate onmessage handler registration.
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
 */
export function initTransport(): void {
    if (initialized) return;

    self.onmessage = (event: MessageEvent) => {
        const msg = event.data;

        if (msg.type === 'response') {
            handleResponse(msg as SyscallResponse);
        } else if (msg.type === 'signal') {
            handleSignal(msg as SignalMessage);
        }
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
 * 4. Resolve or reject based on error field
 * 5. Remove from pending map
 *
 * @param msg - Response message from kernel
 */
function handleResponse(msg: SyscallResponse): void {
    // Check for streaming request first
    const stream = pendingStreams.get(msg.id);
    if (stream) {
        handleStreamResponse(stream, msg);
        return;
    }

    // Single-response request
    const req = pending.get(msg.id);
    if (!req) {
        // Response for unknown request - ignore
        // WHY ignore: Could be late response for cancelled/timed-out request
        return;
    }

    pending.delete(msg.id);

    if (msg.error) {
        // Create typed HAL error from response error code
        req.reject(fromCode(msg.error.code, msg.error.message));
    } else {
        req.resolve(msg.result);
    }
}

/**
 * Handle streaming response from kernel.
 *
 * ALGORITHM:
 * 1. If kernel-level error, set stream error state
 * 2. Otherwise, queue the response
 * 3. Check for terminal ops (ok, done, error) to mark ended
 * 4. Wake up consumer if waiting
 *
 * @param stream - Stream state object
 * @param msg - Response message from kernel
 */
function handleStreamResponse(stream: PendingStream, msg: SyscallResponse): void {
    if (msg.error) {
        // Kernel-level error (transport failure, not application error)
        stream.error = fromCode(msg.error.code, msg.error.message);
        stream.ended = true;
    } else {
        // Queue the response for consumer
        const response = msg.result as Response;
        stream.queue.push(response);

        // Check for terminal ops that end the stream
        if (response.op === 'ok' || response.op === 'done' || response.op === 'error') {
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
    } else {
        // Default behavior: exit on SIGTERM
        if (msg.signal === SIGTERM) {
            // Can't call exit() here without circular dep, so post directly
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
// PUBLIC API
// =============================================================================

/**
 * Register a signal handler.
 *
 * Replaces default signal handling with custom handler. Only one handler
 * can be registered at a time (last registration wins).
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

/**
 * Make a syscall to the kernel.
 *
 * ALGORITHM:
 * 1. Auto-initialize transport if needed
 * 2. Generate unique UUID for request
 * 3. Create Promise and store resolve/reject in pending map
 * 4. Post request message to kernel
 * 5. Return Promise (resolved when kernel responds)
 *
 * WHY Promise: Matches modern async JavaScript patterns. Syscalls are
 * inherently async (cross-thread communication).
 *
 * @param name - Syscall name (e.g., 'open', 'read', 'write')
 * @param args - Syscall arguments (varies by syscall)
 * @returns Promise resolving to syscall result
 *
 * @example
 * const fd = await syscall<number>('open', '/etc/passwd', { read: true });
 */
export function syscall<T>(name: string, ...args: unknown[]): Promise<T> {
    // Auto-initialize on first syscall
    if (!initialized) {
        initTransport();
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });

        const request: SyscallRequest = {
            type: 'syscall',
            id,
            name,
            args,
        };

        self.postMessage(request);
    });
}

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
 * 5. Loop: wait for responses, yield them, until terminal op
 * 6. Cleanup stream state in finally block
 *
 * BACKPRESSURE:
 * Every PING_INTERVAL items, sends a ping to kernel with count processed.
 * This allows kernel to throttle if consumer is slow.
 *
 * TERMINAL OPS:
 * - 'ok': Success response (used when operation completes with data)
 * - 'done': Stream complete (used after yielding items)
 * - 'error': Operation failed
 *
 * @param name - Syscall name
 * @param args - Syscall arguments
 * @yields Response objects from kernel
 *
 * @example
 * for await (const response of syscallStream('channel_stream', ch, msg)) {
 *     if (response.op === 'item') {
 *         processItem(response.data);
 *     }
 * }
 */
export async function* syscallStream(name: string, ...args: unknown[]): AsyncIterable<Response> {
    // Auto-initialize on first syscall
    if (!initialized) {
        initTransport();
    }

    const id = crypto.randomUUID();

    // Create stream state
    const stream: PendingStream = {
        queue: [],
        wakeup: null,
        ended: false,
        error: null,
    };
    pendingStreams.set(id, stream);

    // Send the syscall request
    const request: SyscallRequest = {
        type: 'syscall',
        id,
        name,
        args,
    };
    self.postMessage(request);

    let itemsProcessed = 0;

    try {
        while (true) {
            // Wait for responses if queue is empty
            while (stream.queue.length === 0 && !stream.ended && !stream.error) {
                await new Promise<void>((resolve) => {
                    stream.wakeup = resolve;
                });
            }

            // Check for error
            if (stream.error) {
                throw stream.error;
            }

            // Drain the queue
            while (stream.queue.length > 0) {
                const response = stream.queue.shift()!;
                itemsProcessed++;

                // Ping kernel periodically for backpressure feedback
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
                if (response.op === 'ok' || response.op === 'done' || response.op === 'error') {
                    return;
                }
            }

            // If ended and queue is empty, we're done
            if (stream.ended) {
                return;
            }
        }
    } finally {
        // RC-3: Cleanup in finally ensures map cleanup even on exception
        pendingStreams.delete(id);

        // Send final ping so kernel knows we're done consuming
        const ping: StreamPingMessage = {
            type: 'stream_ping',
            id,
            processed: itemsProcessed,
        };
        self.postMessage(ping);
    }
}

/**
 * Cancel a streaming syscall.
 *
 * Sends cancellation message to kernel and removes stream from pending map.
 * Kernel will stop sending responses for this request.
 *
 * @param id - Request UUID to cancel
 */
export function cancelStream(id: string): void {
    const cancel: StreamCancelMessage = {
        type: 'stream_cancel',
        id,
    };
    self.postMessage(cancel);
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
