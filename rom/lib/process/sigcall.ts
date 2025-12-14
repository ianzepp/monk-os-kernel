/**
 * Sigcall Handler API
 *
 * Enables userspace processes to register as handlers for sigcall requests.
 * When a sigcall arrives from the kernel, the registered handler is invoked
 * and its responses are streamed back.
 *
 * @module rom/lib/process/sigcall
 */

import type { Response, SigcallRequest } from './types.js';
import { respond } from './respond.js';

// =============================================================================
// WORKER GLOBALS
// =============================================================================

/**
 * Worker global scope for postMessage.
 */
declare const self: {
    postMessage: (message: unknown) => void;
};

// =============================================================================
// TYPES
// =============================================================================

/**
 * Sigcall handler function type.
 *
 * Handlers receive arguments from the sigcall request and yield
 * Response objects back to the kernel.
 */
export type SigcallHandler = (...args: unknown[]) => AsyncIterable<Response>;

/**
 * Caller information passed to handlers.
 */
export interface SigcallCaller {
    /** Calling process ID */
    pid?: string;
    /** Gateway connection ID (for push responses) */
    connId?: string;
}

// =============================================================================
// STATE
// =============================================================================

/**
 * Registered sigcall handlers.
 * Maps sigcall name to handler function.
 */
const sigcallHandlers = new Map<string, SigcallHandler>();

// =============================================================================
// REGISTRATION API
// =============================================================================

/**
 * Register a sigcall handler.
 *
 * When the kernel sends a sigcall:request with the given name,
 * the handler will be invoked with the request arguments.
 * The handler yields Response objects which are sent back to the kernel.
 *
 * Note: You must also register the sigcall name with the kernel
 * via syscall('sigcall:register', name) to receive requests.
 *
 * @param name - Sigcall name to handle (e.g., 'window:create')
 * @param handler - Async generator yielding Response objects
 *
 * @example
 * onSigcall('window:delete', async function*(windowId: string) {
 *     yield* syscall('ems:delete', 'windows', windowId);
 *     yield respond.ok({ deleted: windowId });
 * });
 */
export function onSigcall(name: string, handler: SigcallHandler): void {
    sigcallHandlers.set(name, handler);
}

/**
 * Unregister a sigcall handler.
 *
 * @param name - Sigcall name to unregister
 */
export function offSigcall(name: string): void {
    sigcallHandlers.delete(name);
}

/**
 * Check if a handler is registered for a sigcall name.
 *
 * @param name - Sigcall name to check
 * @returns true if a handler is registered
 */
export function hasSigcallHandler(name: string): boolean {
    return sigcallHandlers.has(name);
}

// =============================================================================
// REQUEST HANDLING
// =============================================================================

/**
 * Handle a sigcall request from the kernel.
 *
 * Called by the message handler in syscall.ts when a sigcall:request arrives.
 * Invokes the registered handler and streams responses back to the kernel.
 *
 * @param msg - Sigcall request message
 */
export async function handleSigcallRequest(msg: SigcallRequest): Promise<void> {
    const handler = sigcallHandlers.get(msg.name);

    if (!handler) {
        // No handler registered - send error response
        self.postMessage({
            type: 'sigcall:response',
            id: msg.id,
            result: respond.error('ENOSYS', `No handler for ${msg.name}`),
        });

        return;
    }

    try {
        // Invoke handler and stream responses
        for await (const response of handler(...msg.args)) {
            self.postMessage({
                type: 'sigcall:response',
                id: msg.id,
                result: response,
            });

            // Stop after terminal response
            if (response.op === 'ok' || response.op === 'error' ||
                response.op === 'done' || response.op === 'redirect') {
                break;
            }
        }
    }
    catch (err) {
        // Handler threw - send error response
        const message = err instanceof Error ? err.message : String(err);

        self.postMessage({
            type: 'sigcall:response',
            id: msg.id,
            result: respond.error('EIO', message),
        });
    }
}
