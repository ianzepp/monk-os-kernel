/**
 * Syscall Dispatcher - Routes syscall requests to registered handlers
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The SyscallDispatcher is the central routing mechanism for all system calls in
 * Monk OS. When a process invokes a syscall via the kernel boundary, the dispatcher
 * looks up the appropriate handler function and delegates execution. This design
 * provides a flexible plugin-style architecture where syscall implementations can
 * be registered dynamically at kernel initialization.
 *
 * The dispatcher maintains a simple name-to-handler registry. Each handler is an
 * async generator function that yields Response messages back to the caller. This
 * streaming model supports both immediate responses and long-running operations
 * that produce multiple results.
 *
 * Unknown syscalls are handled gracefully by returning an ENOSYS error rather than
 * throwing exceptions. This maintains stability when processes attempt to use
 * unimplemented or deprecated syscalls.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: handlers registry is never null or undefined
 * INV-2: All registered handlers are valid SyscallHandler functions
 * INV-3: Handler names are unique - later registration overwrites earlier
 * INV-4: dispatch() always returns an AsyncIterable, even for unknown syscalls
 * INV-5: Unknown syscalls yield exactly one ENOSYS error response
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. The dispatcher
 * itself is stateless during dispatch - it only reads from the handlers registry.
 * Multiple processes can invoke syscalls concurrently without conflict.
 *
 * Handler registration typically happens once at kernel boot before any processes
 * spawn. If handlers are registered dynamically at runtime, the caller must ensure
 * proper synchronization to avoid TOCTOU races where a handler is checked with has()
 * but removed before dispatch().
 *
 * Each dispatched syscall executes independently. Handlers are responsible for their
 * own concurrency control (e.g., locking shared kernel state).
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: dispatch() captures handler reference before invoking, preventing issues if
 *       handler is unregistered during execution
 * RC-2: Unknown syscalls return a synthetic generator rather than throwing, ensuring
 *       consistent AsyncIterable contract
 *
 * MEMORY MANAGEMENT
 * =================
 * The dispatcher holds references to all registered handlers for the lifetime of the
 * kernel. Handler functions should not close over large contexts that prevent GC.
 *
 * Each dispatched syscall creates a new generator object that is cleaned up when the
 * caller finishes iteration. Callers who abandon iteration early may leak resources
 * if handlers don't implement proper cleanup.
 *
 * @module kernel/syscalls/dispatcher
 */

import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import type { SyscallHandler, SyscallRegistry } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Registry mapping syscall names to handler functions.
 *
 * WHY: Simple object lookup provides O(1) dispatch performance.
 * TESTABILITY: Can be inspected via list() method.
 */
type HandlerMap = Record<string, SyscallHandler>;

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * SyscallDispatcher - Central routing mechanism for kernel syscalls.
 *
 * Maintains a registry of syscall handlers and dispatches incoming requests
 * to the appropriate implementation.
 */
export class SyscallDispatcher {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Map of syscall names to handler functions.
     *
     * WHY: Enables dynamic syscall registration and O(1) lookup.
     * INVARIANT: Never null, may be empty before handlers are registered.
     */
    private handlers: HandlerMap = {};

    // =========================================================================
    // REGISTRATION
    // =========================================================================

    /**
     * Register a single syscall handler.
     *
     * If a handler with the same name already exists, it will be replaced.
     * This allows kernel modules to override default implementations.
     *
     * WHY: Supports modular kernel design where subsystems can contribute syscalls.
     *
     * @param name - Syscall name (e.g., "open", "read", "fork")
     * @param handler - Handler function that processes the syscall
     */
    register(name: string, handler: SyscallHandler): void {
        this.handlers[name] = handler;
    }

    /**
     * Register multiple syscall handlers at once.
     *
     * Convenience method for bulk registration. Typically used at kernel boot
     * to register all syscalls from a subsystem.
     *
     * WHY: Reduces boilerplate when registering many related syscalls.
     * TESTABILITY: Allows tests to inject mock handler sets easily.
     *
     * @param handlers - Object mapping syscall names to handlers
     */
    registerAll(handlers: SyscallRegistry): void {
        for (const [name, handler] of Object.entries(handlers)) {
            this.handlers[name] = handler;
        }
    }

    // =========================================================================
    // DISPATCH
    // =========================================================================

    /**
     * Dispatch a syscall to its registered handler.
     *
     * ALGORITHM:
     * 1. Look up handler by name
     * 2. If not found, return error generator yielding ENOSYS
     * 3. If found, invoke handler with process and arguments
     * 4. Return handler's AsyncIterable response stream
     *
     * WHY return AsyncIterable instead of Promise:
     * Some syscalls need to stream multiple responses (e.g., watch, pipe read).
     * AsyncIterable provides a natural way to model ongoing operations while
     * still supporting single-response syscalls via immediate yield + return.
     *
     * @param proc - Calling process context
     * @param name - Syscall name to invoke
     * @param args - Arguments passed to the syscall
     * @returns AsyncIterable stream of Response objects
     */
    dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
        // RC-1: Capture handler reference to prevent TOCTOU if unregistered during execution
        const handler = this.handlers[name];

        if (!handler) {
            // Return synthetic error generator for unknown syscalls
            // WHY: Maintains AsyncIterable contract and prevents exceptions
            return (async function* () {
                yield {
                    op: 'error',
                    data: {
                        code: 'ENOSYS',
                        message: `Function not implemented: ${name}`
                    }
                } as Response;
            })();
        }

        // Invoke handler with process context and spread arguments
        return handler(proc, ...args);
    }

    // =========================================================================
    // INTROSPECTION
    // =========================================================================

    /**
     * Check if a syscall is registered.
     *
     * RACE CONDITION:
     * Between checking has() and calling dispatch(), handler could be unregistered
     * by another part of the kernel. Callers should handle ENOSYS gracefully.
     *
     * TESTABILITY: Allows tests to verify handler registration.
     *
     * @param name - Syscall name to check
     * @returns True if handler is registered
     */
    has(name: string): boolean {
        return name in this.handlers;
    }

    /**
     * Get list of all registered syscall names.
     *
     * WHY: Useful for debugging, introspection tools, and system information queries.
     * TESTABILITY: Allows tests to verify complete handler set.
     *
     * @returns Array of registered syscall names
     */
    list(): string[] {
        return Object.keys(this.handlers);
    }
}
