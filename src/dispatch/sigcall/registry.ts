/**
 * Sigcall Registry - Tracks userspace sigcall handlers
 *
 * Processes register to handle specific sigcall names. When a syscall
 * is invoked that matches a registered name, the dispatcher routes
 * to the registered process instead of a kernel handler.
 *
 * Rules:
 * - Exact pattern matching only (no globs)
 * - One handler per name (first registration wins)
 * - Implicit unregistration on process exit
 *
 * @module dispatch/sigcall/registry
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Registration entry for a sigcall handler.
 */
export interface SigcallRegistration {
    /** Sigcall name (e.g., 'window:delete') */
    name: string;
    /** Process ID of the handler */
    pid: string;
    /** Registration timestamp */
    registeredAt: number;
}

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Map of sigcall name → registration.
 *
 * WHY Map not object: Predictable iteration order, no prototype pollution.
 */
const registry = new Map<string, SigcallRegistration>();

/**
 * Register a sigcall handler.
 *
 * @param name - Sigcall name to handle
 * @param pid - Process ID registering the handler
 * @returns Error string if registration fails, undefined on success
 */
export function register(name: string, pid: string): string | undefined {
    const existing = registry.get(name);

    if (existing) {
        if (existing.pid === pid) {
            // Already registered by same process - idempotent success
            return undefined;
        }

        return `EEXIST: ${name} already registered by process ${existing.pid}`;
    }

    registry.set(name, {
        name,
        pid,
        registeredAt: Date.now(),
    });

    return undefined;
}

/**
 * Unregister a sigcall handler.
 *
 * @param name - Sigcall name to unregister
 * @param pid - Process ID attempting to unregister
 * @returns Error string if unregistration fails, undefined on success
 */
export function unregister(name: string, pid: string): string | undefined {
    const existing = registry.get(name);

    if (!existing) {
        // Not registered - idempotent success
        return undefined;
    }

    if (existing.pid !== pid) {
        return `EPERM: ${name} registered by process ${existing.pid}, not ${pid}`;
    }

    registry.delete(name);

    return undefined;
}

/**
 * Unregister all sigcalls for a process.
 *
 * Called on process exit for cleanup.
 *
 * @param pid - Process ID to clean up
 * @returns Number of registrations removed
 */
export function unregisterAll(pid: string): number {
    let count = 0;

    for (const [name, reg] of registry) {
        if (reg.pid === pid) {
            registry.delete(name);
            count++;
        }
    }

    return count;
}

/**
 * Look up a sigcall registration.
 *
 * @param name - Sigcall name to look up
 * @returns Registration if found, undefined otherwise
 */
export function lookup(name: string): SigcallRegistration | undefined {
    return registry.get(name);
}

/**
 * List all registered sigcalls.
 *
 * @returns Array of all registrations
 */
export function list(): SigcallRegistration[] {
    return Array.from(registry.values());
}

/**
 * Clear all registrations.
 *
 * Used for testing.
 */
export function clear(): void {
    registry.clear();
}

/**
 * Get registration count.
 *
 * Used for testing and diagnostics.
 */
export function size(): number {
    return registry.size;
}
