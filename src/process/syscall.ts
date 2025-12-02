/**
 * Syscall Transport
 *
 * Handles communication between process (Worker) and kernel (main thread).
 * Uses postMessage/onmessage with UUID correlation for request-response.
 *
 * This module runs inside Workers. It maintains a pending request map and
 * routes responses back to the correct Promise.
 */

/// <reference lib="webworker" />

import type { SyscallRequest, SyscallResponse, SignalMessage, StreamPingMessage, StreamCancelMessage } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';

// Worker global context
declare const self: DedicatedWorkerGlobalScope;

/**
 * Pending syscall request (single response)
 */
interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}

/**
 * Pending stream request (multiple responses)
 */
interface PendingStream {
    /** Queue of responses waiting to be consumed */
    queue: Response[];
    /** Resolve function to wake up waiting consumer */
    wakeup: (() => void) | null;
    /** Whether stream has ended (done/error) */
    ended: boolean;
    /** Terminal error if any */
    error: Error | null;
}

/**
 * Signal handler type
 */
export type SignalHandler = (signal: number) => void;

/**
 * Pending requests map (single response)
 */
const pending = new Map<string, PendingRequest>();

/**
 * Pending streams map (multiple responses)
 */
const pendingStreams = new Map<string, PendingStream>();

/**
 * Signal handler (user-registered)
 */
let signalHandler: SignalHandler | null = null;

/**
 * Whether the transport has been initialized
 */
let initialized = false;

/**
 * Initialize the syscall transport.
 *
 * Sets up the message handler for kernel responses.
 * Must be called before any syscalls.
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

/**
 * Handle syscall response from kernel.
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
        return;
    }

    pending.delete(msg.id);

    if (msg.error) {
        // Create error with code property for reconstruction
        const error = new Error(msg.error.message) as Error & { code: string };
        error.code = msg.error.code;
        req.reject(error);
    } else {
        req.resolve(msg.result);
    }
}

/**
 * Handle streaming response from kernel.
 */
function handleStreamResponse(stream: PendingStream, msg: SyscallResponse): void {
    if (msg.error) {
        // Kernel-level error (not op: 'error' response)
        const error = new Error(msg.error.message) as Error & { code: string };
        error.code = msg.error.code;
        stream.error = error;
        stream.ended = true;
    } else {
        // Queue the response
        const response = msg.result as Response;
        stream.queue.push(response);

        // Check for terminal ops
        if (response.op === 'ok' || response.op === 'done' || response.op === 'error') {
            stream.ended = true;
        }
    }

    // Wake up consumer if waiting
    if (stream.wakeup) {
        stream.wakeup();
        stream.wakeup = null;
    }
}

/**
 * Handle signal from kernel.
 */
function handleSignal(msg: SignalMessage): void {
    if (signalHandler) {
        signalHandler(msg.signal);
    } else {
        // Default behavior: exit on SIGTERM
        // SIGKILL is never delivered - kernel terminates immediately
        if (msg.signal === 15) { // SIGTERM
            // Can't call exit() here without circular dep, so just terminate
            self.postMessage({
                type: 'syscall',
                id: crypto.randomUUID(),
                name: 'exit',
                args: [128 + msg.signal],
            });
        }
    }
}

/**
 * Register a signal handler.
 *
 * @param handler - Function to call when signal received
 */
export function onSignal(handler: SignalHandler): void {
    signalHandler = handler;
}

/**
 * Make a syscall to the kernel.
 *
 * @param name - Syscall name
 * @param args - Syscall arguments
 * @returns Promise resolving to syscall result
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
 * Returns an async iterable that yields responses as they arrive.
 * Handles backpressure by pinging the kernel with progress.
 *
 * @param name - Syscall name
 * @param args - Syscall arguments
 * @returns AsyncIterable of Response objects
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

    // Ping interval for backpressure (every 100 items or so)
    const PING_INTERVAL = 100;
    let itemsProcessed = 0;

    try {
        while (true) {
            // Wait for responses if queue is empty
            while (stream.queue.length === 0 && !stream.ended && !stream.error) {
                await new Promise<void>(resolve => {
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

                // Ping kernel periodically for backpressure
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
        // Cleanup
        pendingStreams.delete(id);

        // Send final ping so kernel knows we're done
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
 * @param id - Request ID to cancel
 */
export function cancelStream(id: string): void {
    const cancel: StreamCancelMessage = {
        type: 'stream_cancel',
        id,
    };
    self.postMessage(cancel);
    pendingStreams.delete(id);
}

/**
 * Get count of pending syscalls (for debugging/testing).
 */
export function getPendingCount(): number {
    return pending.size;
}

/**
 * Get count of pending streams (for debugging/testing).
 */
export function getPendingStreamCount(): number {
    return pendingStreams.size;
}
