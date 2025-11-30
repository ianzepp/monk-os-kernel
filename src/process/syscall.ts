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

import type { SyscallRequest, SyscallResponse, SignalMessage } from '@src/kernel/types.js';

// Worker global context
declare const self: DedicatedWorkerGlobalScope;

/**
 * Pending syscall request
 */
interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}

/**
 * Signal handler type
 */
export type SignalHandler = (signal: number) => void;

/**
 * Pending requests map
 */
const pending = new Map<string, PendingRequest>();

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
 * Get count of pending syscalls (for debugging/testing).
 */
export function getPendingCount(): number {
    return pending.size;
}
