/**
 * Syscall Dispatcher
 *
 * Routes syscall requests to appropriate handlers.
 */

import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import type { SyscallHandler, SyscallRegistry } from './types.js';

/**
 * Syscall dispatcher
 *
 * Routes syscall names to handler functions.
 * Handlers are registered by the kernel during initialization.
 */
export class SyscallDispatcher {
    private handlers: SyscallRegistry = {};

    /**
     * Register a syscall handler.
     */
    register(name: string, handler: SyscallHandler): void {
        this.handlers[name] = handler;
    }

    /**
     * Register multiple syscall handlers.
     */
    registerAll(handlers: SyscallRegistry): void {
        for (const [name, handler] of Object.entries(handlers)) {
            this.handlers[name] = handler;
        }
    }

    /**
     * Dispatch a syscall.
     *
     * @param proc - Calling process
     * @param name - Syscall name
     * @param args - Syscall arguments
     * @returns AsyncIterable of Response objects
     */
    dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
        const handler = this.handlers[name];
        if (!handler) {
            // Return a single-shot iterable yielding error
            return (async function* () {
                yield { op: 'error', data: { code: 'ENOSYS', message: `Function not implemented: ${name}` } } as Response;
            })();
        }

        return handler(proc, ...args);
    }

    /**
     * Check if a syscall is registered.
     */
    has(name: string): boolean {
        return name in this.handlers;
    }

    /**
     * Get list of registered syscalls.
     */
    list(): string[] {
        return Object.keys(this.handlers);
    }
}
