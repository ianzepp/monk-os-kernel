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
 *   │  │  for await (const r of syscall('open', '/foo')) { ... } │   │
 *   │  └─────────────────────────────────────────────────────────┘   │
 *   │                          │                                      │
 *   │                          ▼                                      │
 *   │  ┌─────────────────────────────────────────────────────────┐   │
 *   │  │              Syscall Transport (this module)             │   │
 *   │  │  - Serializes request with UUID                          │   │
 *   │  │  - Posts to main thread                                  │   │
 *   │  │  - Correlates responses by UUID                          │   │
 *   │  │  - Yields Response objects to caller                     │   │
 *   │  └─────────────────────────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────────────────────────┘
 *                          │ postMessage
 *                          ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │                     Kernel (Main Thread)                        │
 *   │  - Receives syscall request                                     │
 *   │  - Dispatches to syscall handler                                │
 *   │  - Sends response(s) with matching UUID                         │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * STREAMING-FIRST DESIGN
 * ======================
 * All syscalls return AsyncIterable<Response>, matching the kernel's native
 * response type. This eliminates the bug class where callers use the wrong
 * transport function (Promise vs stream) for a given syscall.
 *
 * Wrapper functions in the process library decide how to consume the stream:
 * - Single-value syscalls: await first ok/error response
 * - Streaming syscalls: yield data/item responses until done
 *
 * STATE MACHINE
 * =============
 *
 *   syscall() ──────> STREAMING ──────> ENDED
 *                        │   ▲           │
 *                        │   │           │ (done/error/ok/redirect)
 *                        │   │           │ (or cancellation)
 *                        ▼   │           │
 *                     yield response ────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every request UUID is unique (crypto.randomUUID)
 *        VIOLATED BY: UUID collision (astronomically unlikely)
 * INV-2: Streams end on 'ok', 'done', 'error', or 'redirect' response
 *        VIOLATED BY: Kernel yielding after terminal op
 * INV-3: Signal handler is optional; default behavior is exit on SIGTERM
 *        VIOLATED BY: N/A (by design)
 * INV-4: Transport auto-initializes on first syscall
 *        VIOLATED BY: Calling onSignal before any syscall (harmless)
 * INV-5: Cancelled streams wake blocked consumers with error
 *        VIOLATED BY: cancelStream not setting error/calling wakeup
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript event loop serializes message handling. Multiple concurrent
 * syscalls are safe - each has a unique UUID and independent stream state.
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
 * RC-2: pendingStreams map is modified atomically (single-threaded)
 * RC-3: Stream cleanup in finally block ensures map cleanup even on exception
 * RC-4: cancelStream sets error state and wakes consumer before deleting
 * RC-5: initTransport is idempotent (safe to call multiple times)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Streaming requests are removed from map when iteration completes
 * - Signal handler reference is module-level (persists for process lifetime)
 *
 * TIMEOUT BEHAVIOR
 * ================
 * Syscalls don't have an overall timeout, but the kernel implements
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
 * Pending syscall request.
 *
 * Maintains queue and synchronization state for streaming responses.
 *
 * LIFECYCLE:
 * 1. Created when syscall() is called
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

// =============================================================================
// STATE
// =============================================================================

/**
 * Pending syscall requests.
 *
 * WHY Map: O(1) lookup by UUID for response correlation.
 *
 * INVARIANT: Entries are removed when stream iteration completes.
 * MEMORY: Bounded by kernel backpressure and stall timeout.
 */
const pending = new Map<string, PendingStream>();

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

/**
 * Current process ID (UUID).
 *
 * WHY: Every syscall must include the process ID so the kernel knows which
 * process context to use. This enables virtual processes where multiple
 * process contexts share a single Worker thread.
 *
 * Read from MONK_PID environment variable on first syscall.
 * Throws if MONK_PID is not set (indicates kernel bug).
 */
let processId: string | null = null;

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the syscall transport.
 *
 * Sets up the message handler for kernel responses and reads process ID.
 * Called automatically on first syscall, but can be called explicitly for
 * early initialization.
 *
 * ALGORITHM:
 * 1. Check if already initialized (idempotent)
 * 2. Read MONK_PID from environment
 * 3. Register onmessage handler
 * 4. Set initialized flag
 *
 * WHY auto-initialize: Simplifies userland code - no explicit init needed.
 * WHY idempotent: Safe to call multiple times (RC-6 mitigation).
 * WHY MONK_PID: Syscalls must include process ID for virtual process support.
 *
 * RACE CONDITION: Two concurrent syscalls before init both call this.
 * SAFE: Function is synchronous and sets initialized before returning.
 *
 * @throws Error if MONK_PID environment variable is not set (kernel bug)
 */
export function initTransport(): void {
    if (initialized) {
        return;
    }

    // Read process ID from environment
    // WHY: Every syscall must include pid so kernel knows which process context
    // to use. This is set by the kernel in create-process.ts.
    processId = process.env.MONK_PID ?? null;

    if (!processId) {
        throw new Error('MONK_PID environment variable not set (kernel bug)');
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
 * 1. Look up pending request by UUID
 * 2. If not found, log warning (late response after cancel)
 * 3. If kernel-level error, set stream error state and mark ended
 * 4. Otherwise, queue the response
 * 5. Check for terminal ops (ok, done, error, redirect) to mark ended
 * 6. Wake up consumer if waiting
 *
 * TERMINAL OPS:
 * - 'ok': Success with optional final value
 * - 'done': Clean completion (after yielding items)
 * - 'error': Operation failed
 * - 'redirect': Follow redirect (symlinks, mounts)
 *
 * @param msg - Response message from kernel
 */
function handleResponse(msg: SyscallResponse): void {
    const stream = pending.get(msg.id);

    if (!stream) {
        // Response for unknown request
        // WHY warn: Could be late response after cancel, or kernel bug.
        // Logging helps debug but isn't fatal.
        console.warn(`syscall: response for unknown request ${msg.id}`);

        return;
    }

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
// PUBLIC API - SYSCALLS
// =============================================================================

/**
 * Make a syscall to the kernel.
 *
 * Returns an async iterable that yields Response objects as they arrive from
 * the kernel. This matches the kernel's native response type and eliminates
 * the bug class where callers use the wrong transport function.
 *
 * Wrapper functions in the process library decide how to consume the stream:
 * - Single-value syscalls: await first ok/error response
 * - Streaming syscalls: yield data/item responses until done
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
 * @param name - Syscall name (e.g., 'file:open', 'file:read', 'file:write')
 * @param args - Syscall arguments (varies by syscall)
 * @yields Response objects from kernel
 *
 * @example
 * // Single-value syscall (wrapper consumes first response)
 * for await (const r of syscall('file:open', '/etc/passwd', { read: true })) {
 *     if (r.op === 'ok') return r.data as number;
 *     if (r.op === 'error') throw toError(r);
 * }
 *
 * // Streaming syscall (wrapper yields items)
 * for await (const r of syscall('file:readdir', '/home')) {
 *     if (r.op === 'item') yield r.data as string;
 *     if (r.op === 'done') return;
 *     if (r.op === 'error') throw toError(r);
 * }
 */
export async function* syscall(name: string, ...args: unknown[]): AsyncIterable<Response> {
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

    pending.set(id, stream);

    // -------------------------------------------------------------------------
    // Send the syscall request
    // -------------------------------------------------------------------------

    // INVARIANT: processId is set by initTransport() above
    // WHY assert: TypeScript doesn't know initTransport sets processId
    if (!processId) {
        throw new Error('Process ID not initialized');
    }

    const request: SyscallRequest = {
        type: 'syscall',
        id,
        pid: processId,
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

        pending.delete(id);
    }
}

/**
 * Cancel a syscall.
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
 * RACE CONDITION (RC-4 mitigation):
 * Consumer may be blocked in await when cancel is called.
 * We set error and call wakeup BEFORE deleting from map.
 * Consumer will wake, see error, and throw.
 *
 * @param id - Request UUID to cancel
 */
export function cancelSyscall(id: string): void {
    const stream = pending.get(id);

    if (stream) {
        // Set error state so consumer knows it was cancelled
        // WHY ECANCELED: POSIX error code for operation cancelled
        stream.error = fromCode('ECANCELED', 'Syscall cancelled');
        stream.ended = true;

        // Wake consumer if blocked waiting for data
        // CRITICAL: Must wake BEFORE deleting from map
        if (stream.wakeup) {
            stream.wakeup();
            stream.wakeup = null;
        }
    }

    // Send cancel message to kernel
    // WHY always send: Syscall may have completed but kernel might still be yielding
    const cancel: StreamCancelMessage = {
        type: 'stream_cancel',
        id,
    };

    self.postMessage(cancel);

    // Remove from map (safe even if not present)
    pending.delete(id);
}

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Get count of pending syscalls.
 *
 * TESTING: Allows tests to verify no leaked requests.
 *
 * @returns Number of pending requests
 */
export function getPendingCount(): number {
    return pending.size;
}

/**
 * Reset transport state for testing.
 *
 * TESTING: Clears all pending requests.
 * WARNING: Only use in tests - will orphan any in-flight syscalls.
 */
export function resetTransportForTesting(): void {
    pending.clear();
    signalHandler = null;
    // Note: Don't reset initialized - onmessage handler persists
}

/**
 * Alias for cancelSyscall for backward compatibility.
 *
 * @deprecated Use cancelSyscall instead
 */
export const cancelStream = cancelSyscall;

/**
 * Alias for syscall for backward compatibility.
 *
 * @deprecated Use syscall instead
 */
export const syscallStream = syscall;

// =============================================================================
// PROCESS IDENTITY
// =============================================================================

/**
 * Get the current process ID.
 *
 * WHY EXPORT: Allows userland code to get its own process ID without
 * making a syscall. Useful for logging, debugging, or implementing
 * virtual process proxying (like gatewayd).
 *
 * @returns Process UUID
 * @throws Error if transport not initialized (call any syscall first)
 */
export function getProcessId(): string {
    if (!processId) {
        // Auto-initialize if needed
        initTransport();
    }

    if (!processId) {
        throw new Error('Process ID not available');
    }

    return processId;
}

/**
 * Set the process ID for syscalls.
 *
 * WHY: Enables virtual process proxying. When gatewayd creates a virtual
 * process, it can set the process ID before making syscalls on behalf
 * of the virtual process.
 *
 * SECURITY: This is safe because the kernel validates that the Worker
 * making the syscall matches the process's Worker. A malicious process
 * cannot impersonate another process.
 *
 * @param pid - Process UUID to use for syscalls
 */
export function setProcessId(pid: string): void {
    processId = pid;
}
