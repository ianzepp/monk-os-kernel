/**
 * Syscall transport layer for VFS scripts.
 * Provides the core syscall mechanism and convenience wrappers.
 */

/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

import { Response, SignalHandler } from './types';
import { SyscallError } from './error';

// ============================================================================
// Transport State (Singleton)
// ============================================================================

interface StreamState {
    queue: Response[];
    resolve: (() => void) | null;
    done: boolean;
}

const streams = new Map<string, StreamState>();
let signalHandler: SignalHandler | null = null;
let initialized = false;

/** Time-based ping interval in milliseconds */
const PING_INTERVAL_MS = 100;

// ============================================================================
// Signal Constants
// ============================================================================

export const SIGTERM = 15;
export const SIGKILL = 9;

// ============================================================================
// Signal Handler
// ============================================================================

export function onSignal(handler: SignalHandler): void {
    signalHandler = handler;
}

// ============================================================================
// Transport Initialization
// ============================================================================

function initTransport(): void {
    if (initialized) return;

    self.onmessage = (event: MessageEvent) => {
        const msg = event.data;

        if (msg.type === 'response') {
            const stream = streams.get(msg.id);
            if (stream) {
                stream.queue.push(msg.result as Response);
                // Check for terminal ops
                const op = (msg.result as Response).op;
                if (op === 'ok' || op === 'done' || op === 'error' || op === 'redirect') {
                    stream.done = true;
                }
                stream.resolve?.();
                stream.resolve = null;
            }
        } else if (msg.type === 'signal') {
            if (signalHandler) {
                signalHandler(msg.signal);
            } else if (msg.signal === 15) {
                // Default: exit on SIGTERM
                self.postMessage({
                    type: 'syscall',
                    id: crypto.randomUUID(),
                    name: 'exit',
                    args: [128 + msg.signal],
                });
            }
        }
    };

    initialized = true;
}

// ============================================================================
// Core Syscall
// ============================================================================

/**
 * Core syscall function - yields Response objects.
 * Includes automatic time-based ping with progress count for backpressure.
 */
export async function* syscall(name: string, ...args: unknown[]): AsyncIterable<Response> {
    if (!initialized) {
        initTransport();
    }

    const id = crypto.randomUUID();
    const stream: StreamState = { queue: [], resolve: null, done: false };
    streams.set(id, stream);

    let processed = 0;
    let lastPingTime = Date.now();

    try {
        self.postMessage({ type: 'syscall', id, name, args });

        while (true) {
            // Wait for responses
            while (stream.queue.length === 0 && !stream.done) {
                await new Promise<void>(r => { stream.resolve = r; });
            }

            // Yield all queued responses
            while (stream.queue.length > 0) {
                const response = stream.queue.shift()!;
                yield response;
                processed++;

                // Time-based ping with progress count
                const now = Date.now();
                if (now - lastPingTime >= PING_INTERVAL_MS) {
                    self.postMessage({ type: 'stream_ping', id, processed });
                    lastPingTime = now;
                }

                // Terminal ops end the stream
                if (response.op === 'ok' || response.op === 'done' || response.op === 'error' || response.op === 'redirect') {
                    return;
                }
            }

            if (stream.done) return;
        }
    } finally {
        streams.delete(id);
        self.postMessage({ type: 'stream_cancel', id });
    }
}

// ============================================================================
// Convenience Wrappers
// ============================================================================

/**
 * Convenience: unwrap single ok value (most common case)
 */
export async function call<T>(name: string, ...args: unknown[]): Promise<T> {
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'ok') return response.data as T;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
    }
    throw new SyscallError('EIO', 'No response');
}

/**
 * Convenience: collect items to array
 */
export async function collect<T>(name: string, ...args: unknown[]): Promise<T[]> {
    const items: T[] = [];
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'item') items.push(response.data as T);
        if (response.op === 'done') return items;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
        if (response.op === 'ok') return [response.data as T]; // Single value as array
    }
    return items;
}

/**
 * Convenience: iterate items (hide Response wrapper)
 */
export async function* iterate<T>(name: string, ...args: unknown[]): AsyncIterable<T> {
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'item') yield response.data as T;
        if (response.op === 'ok') { yield response.data as T; return; }
        if (response.op === 'done') return;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
    }
}
