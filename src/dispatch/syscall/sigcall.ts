/**
 * Sigcall Syscalls - Registration and management of userspace sigcall handlers
 *
 * These syscalls allow userspace processes to register as handlers for
 * specific sigcall names, enabling kernel-to-userspace request routing.
 *
 * Syscalls:
 * - sigcall:register   - Register a sigcall handler
 * - sigcall:unregister - Unregister a sigcall handler
 * - sigcall:list       - List all registered sigcall handlers
 *
 * @module dispatch/syscall/sigcall
 */

import type { Process, Response } from '../types.js';
import { respond } from '../types.js';
import * as registry from '../sigcall/registry.js';

// =============================================================================
// SIGCALL:REGISTER
// =============================================================================

/**
 * Register a sigcall handler.
 *
 * The calling process becomes the handler for the specified sigcall name.
 * When any process invokes a syscall with this name, the dispatcher will
 * route it to this process as a sigcall.
 *
 * Rules:
 * - Exact pattern matching only (no globs)
 * - One handler per name (first registration wins)
 * - Re-registering same name from same process is idempotent
 * - Registration is automatically removed on process exit
 *
 * @param proc - Calling process
 * @param name - Sigcall name to handle (e.g., 'window:delete')
 * @yields ok on success, error on failure
 *
 * @example
 * // In displayd startup
 * yield* syscall('sigcall:register', 'window:create');
 * yield* syscall('sigcall:register', 'window:delete');
 */
export async function* sigcallRegister(
    proc: Process,
    name: string,
): AsyncIterable<Response> {
    // Validate name
    if (typeof name !== 'string' || name.length === 0) {
        yield respond.error('EINVAL', 'sigcall name must be non-empty string');
        return;
    }

    // Disallow registering syscall:* names (reserved for kernel)
    if (name.startsWith('syscall:')) {
        yield respond.error('EPERM', 'Cannot register syscall:* names');
        return;
    }

    const error = registry.register(name, proc.id);

    if (error) {
        const parts = error.split(': ', 2);
        yield respond.error(parts[0] ?? 'EINVAL', parts[1] ?? error);
        return;
    }

    yield respond.ok({ name, pid: proc.id });
}

// =============================================================================
// SIGCALL:UNREGISTER
// =============================================================================

/**
 * Unregister a sigcall handler.
 *
 * The calling process releases its handler registration for the specified
 * sigcall name. Only the process that registered the handler can unregister it.
 *
 * @param proc - Calling process
 * @param name - Sigcall name to unregister
 * @yields ok on success, error on failure
 */
export async function* sigcallUnregister(
    proc: Process,
    name: string,
): AsyncIterable<Response> {
    // Validate name
    if (typeof name !== 'string' || name.length === 0) {
        yield respond.error('EINVAL', 'sigcall name must be non-empty string');
        return;
    }

    const error = registry.unregister(name, proc.id);

    if (error) {
        const parts = error.split(': ', 2);
        yield respond.error(parts[0] ?? 'EINVAL', parts[1] ?? error);
        return;
    }

    yield respond.ok({ name });
}

// =============================================================================
// SIGCALL:LIST
// =============================================================================

/**
 * List all registered sigcall handlers.
 *
 * Returns all sigcall registrations for debugging and introspection.
 *
 * @param _proc - Calling process (unused)
 * @yields item for each registration, then done
 */
export async function* sigcallList(
    _proc: Process,
): AsyncIterable<Response> {
    const registrations = registry.list();

    for (const reg of registrations) {
        yield respond.item({
            name: reg.name,
            pid: reg.pid,
            registeredAt: reg.registeredAt,
        });
    }

    yield respond.done();
}
