/**
 * Syscall Transport Layer
 *
 * Core communication layer between userland processes and the kernel.
 * Handles postMessage, UUID correlation, stream iteration, backpressure,
 * and signal handling.
 *
 * @module rom/lib/process/syscall
 */

import type {
    Response,
    SyscallRequest,
    SyscallResponse,
    SignalMessage,
    KernelMessage,
} from './types.js';
import { fromCode, SIGTERM } from './types.js';

// =============================================================================
// WORKER GLOBALS
// =============================================================================

/**
 * Worker global scope. Declared here for TypeScript in Worker context.
 */
declare const self: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown) => void;
};

/**
 * Process ID injected by kernel at Worker creation.
 * Used in all syscall requests for routing.
 */
declare const __MONK_PID__: string;

// =============================================================================
// STATE
// =============================================================================

/**
 * Pending request tracking for async correlation.
 */
interface PendingRequest {
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
    stream?: {
        queue: Response[];
        waiting: ((value: IteratorResult<Response>) => void) | null;
        done: boolean;
        processed: number;
        pingTimer?: ReturnType<typeof setInterval>;
    };
}

const pending = new Map<string, PendingRequest>();

/**
 * Signal handlers registered via onSignal().
 */
const signalHandlers = new Map<number, () => void | Promise<void>>();

/**
 * Default SIGTERM handler - exit with code 0.
 */
let defaultTermHandler: (() => void) | null = null;

// =============================================================================
// MESSAGE HANDLER
// =============================================================================

/**
 * Install the global message handler.
 * Called once when this module loads.
 */
function installMessageHandler(): void {
    // WHY: self.onmessage in Worker context
    self.onmessage = async (event: MessageEvent<KernelMessage>) => {
        const msg = event.data;

        switch (msg.type) {
            case 'response':
                handleResponse(msg as SyscallResponse);
                break;

            case 'signal':
                await handleSignal(msg as SignalMessage);
                break;

            // Port messages handled separately via port:recv syscall
        }
    };
}

/**
 * Handle a syscall response from the kernel.
 */
function handleResponse(msg: SyscallResponse): void {
    const req = pending.get(msg.id);

    if (!req) {
        return;
    }

    const response = msg.result;

    if (!response) {
        req.reject(new Error('No result in response'));
        pending.delete(msg.id);

        return;
    }

    // Non-streaming: single response
    if (!req.stream) {
        req.resolve(response);
        pending.delete(msg.id);

        return;
    }

    // Streaming: queue response for async iteration
    const stream = req.stream;

    stream.queue.push(response);

    // Terminal ops end the stream
    if (response.op === 'ok' || response.op === 'error' ||
        response.op === 'done' || response.op === 'redirect') {
        stream.done = true;

        if (stream.pingTimer) {
            clearInterval(stream.pingTimer);
        }
    }

    // Wake up waiting iterator
    if (stream.waiting) {
        const next = stream.queue.shift();

        if (next) {
            const waiting = stream.waiting;

            stream.waiting = null;
            stream.processed++;
            waiting({ value: next, done: false });
        }
    }
}

/**
 * Handle a signal from the kernel.
 */
async function handleSignal(msg: SignalMessage): Promise<void> {
    const handler = signalHandlers.get(msg.signal);

    if (handler) {
        await handler();
    }
    else if (msg.signal === SIGTERM && defaultTermHandler) {
        // SIGTERM with no custom handler - use default
        defaultTermHandler();
    }
}

// =============================================================================
// SYSCALL PRIMITIVES
// =============================================================================

/**
 * Generate a unique request ID.
 */
function uuid(): string {
    return crypto.randomUUID();
}

/**
 * Make a syscall and return a streaming response.
 *
 * This is the core primitive. All syscalls go through here.
 * Returns an AsyncIterable that yields Response messages until
 * a terminal op (ok, error, done, redirect) is received.
 */
export function syscall(name: string, ...args: unknown[]): AsyncIterable<Response> {
    const id = uuid();

    const request: SyscallRequest = {
        type: 'syscall',
        id,
        pid: __MONK_PID__,
        name,
        args,
    };

    // Set up stream tracking
    const stream = {
        queue: [] as Response[],
        waiting: null as ((value: IteratorResult<Response>) => void) | null,
        done: false,
        processed: 0,
        pingTimer: undefined as ReturnType<typeof setInterval> | undefined,
    };

    pending.set(id, {
        resolve: () => {},
        reject: () => {},
        stream,
    });

    // Start ping timer for backpressure
    stream.pingTimer = setInterval(() => {
        if (stream.processed > 0) {
            self.postMessage({
                type: 'stream_ping',
                id,
                processed: stream.processed,
            });
        }
    }, 100); // STREAM_PING_INTERVAL

    // Send request to kernel
    self.postMessage(request);

    // Return async iterator
    return {
        [Symbol.asyncIterator](): AsyncIterator<Response> {
            return {
                async next(): Promise<IteratorResult<Response>> {
                    // Check queue first
                    const queued = stream.queue.shift();

                    if (queued) {
                        stream.processed++;

                        // Check if this was terminal
                        if (queued.op === 'ok' || queued.op === 'error' ||
                            queued.op === 'done' || queued.op === 'redirect') {
                            pending.delete(id);

                            if (stream.pingTimer) {
                                clearInterval(stream.pingTimer);
                            }

                            return { value: queued, done: false };
                        }

                        return { value: queued, done: false };
                    }

                    // Stream complete
                    if (stream.done) {
                        pending.delete(id);

                        if (stream.pingTimer) {
                            clearInterval(stream.pingTimer);
                        }

                        return { value: undefined as unknown as Response, done: true };
                    }

                    // Wait for next response
                    return new Promise((resolve) => {
                        stream.waiting = resolve;
                    });
                },

                async return(): Promise<IteratorResult<Response>> {
                    // Cancel the stream
                    self.postMessage({
                        type: 'stream_cancel',
                        id,
                    });

                    pending.delete(id);

                    if (stream.pingTimer) {
                        clearInterval(stream.pingTimer);
                    }

                    return { value: undefined as unknown as Response, done: true };
                },
            };
        },
    };
}

/**
 * Make a syscall and return a single value.
 * Throws on error response.
 */
export async function call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'ok') {
            return response.data as T;
        }

        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };

            throw Object.assign(new Error(err.message), { code: err.code });
        }

        if (response.op === 'done') {
            return undefined as T;
        }
    }

    throw new Error('No response received');
}

/**
 * Make a syscall and collect all items into an array.
 * Throws on error response.
 */
export async function collect<T = unknown>(name: string, ...args: unknown[]): Promise<T[]> {
    const items: T[] = [];

    for await (const response of syscall(name, ...args)) {
        if (response.op === 'item') {
            items.push(response.data as T);
        }
        else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };

            throw Object.assign(new Error(err.message), { code: err.code });
        }
        else if (response.op === 'done' || response.op === 'ok') {
            break;
        }
    }

    return items;
}

// =============================================================================
// SIGNAL HANDLING
// =============================================================================

/**
 * Register a signal handler.
 *
 * Supports two signatures:
 * - onSignal(handler) - register handler for SIGTERM (default)
 * - onSignal(signal, handler) - register handler for specific signal
 *
 * @param signalOrHandler - Signal number or handler function
 * @param handler - Handler function (if first arg is signal)
 */
export function onSignal(
    signalOrHandler: number | (() => void | Promise<void>),
    handler?: () => void | Promise<void>,
): void {
    if (typeof signalOrHandler === 'function') {
        // onSignal(handler) - default to SIGTERM
        signalHandlers.set(SIGTERM, signalOrHandler);
    }
    else {
        // onSignal(signal, handler)
        if (handler) {
            signalHandlers.set(signalOrHandler, handler);
        }
    }
}

/**
 * Set the default SIGTERM handler.
 * Used internally by exit() to enable graceful shutdown.
 */
export function setDefaultTermHandler(handler: () => void): void {
    defaultTermHandler = handler;
}

// =============================================================================
// ERROR UTILITIES
// =============================================================================

/**
 * Convert an error Response to a typed SyscallError.
 */
export function toError(response: Response): Error {
    if (response.op !== 'error') {
        return new Error('Not an error response');
    }

    const data = response.data as { code: string; message: string };

    return fromCode(data.code, data.message);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

// Install message handler on module load
installMessageHandler();
