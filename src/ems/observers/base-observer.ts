/**
 * Observer Pipeline - Base Observer Class
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * BaseObserver provides common infrastructure for observer implementations:
 * - Timeout handling (prevents runaway observers)
 * - Error wrapping with consistent context
 * - Logging/debugging support
 *
 * All concrete observers should extend this class rather than implementing
 * Observer directly. This ensures consistent behavior across the pipeline.
 *
 * INVARIANTS
 * ==========
 * INV-1: execute() completes within timeout (default 5000ms)
 * INV-2: Errors from execute() are always ObserverError or subclass
 * INV-3: Observer state is not modified during execute()
 *
 * CONCURRENCY MODEL
 * =================
 * BaseObserver is stateless - only configuration fields (name, ring, etc.)
 * are stored. Multiple concurrent executions are safe because each gets
 * its own ObserverContext.
 *
 * @module model/observers/base-observer
 */

import type { Observer, ObserverContext } from './interfaces.js';
import type { ObserverRing, OperationType } from './types.js';
import { ObserverError, EOBSTIMEOUT, EOBSERVER } from './errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default timeout for observer execution (ms).
 *
 * WHY 5000ms: Long enough for database operations and external calls,
 * short enough to detect stuck observers quickly. Can be overridden
 * per-observer for special cases.
 */
const DEFAULT_TIMEOUT_MS = 5000;

// =============================================================================
// BASE OBSERVER CLASS
// =============================================================================

/**
 * Abstract base class for observers.
 *
 * Provides:
 * - Timeout handling via executeWithTimeout()
 * - Error context wrapping
 * - Common configuration fields
 *
 * Subclasses must implement:
 * - name, ring, priority, operations (configuration)
 * - execute() (observer logic)
 *
 * Subclasses may override:
 * - timeout (default 5000ms)
 * - models (default: all models)
 */
export abstract class BaseObserver implements Observer {
    // =========================================================================
    // CONFIGURATION (subclass must define)
    // =========================================================================

    /** Observer name for debugging and metrics */
    abstract readonly name: string;

    /** Ring this observer executes in */
    abstract readonly ring: ObserverRing;

    /** Priority within ring (lower = runs first) */
    abstract readonly priority: number;

    /** Operations this observer handles */
    abstract readonly operations: readonly OperationType[];

    // =========================================================================
    // OPTIONAL CONFIGURATION (subclass may override)
    // =========================================================================

    /**
     * Models this observer handles.
     *
     * WHY optional: Most observers run for all models. Only model-specific
     * observers (DDL, special validation) need to filter.
     */
    readonly models?: readonly string[];

    /**
     * Database dialect this observer handles.
     *
     * WHY optional: Most observers are dialect-agnostic. DDL observers that
     * generate SQL need dialect-specific implementations.
     */
    readonly dialect?: 'sqlite' | 'postgres';

    /**
     * Timeout for execute() in milliseconds.
     *
     * WHY protected: Subclasses can override for observers that legitimately
     * need more time (e.g., external API calls).
     */
    protected readonly timeout: number = DEFAULT_TIMEOUT_MS;

    // =========================================================================
    // ABSTRACT METHOD (subclass must implement)
    // =========================================================================

    /**
     * Execute observer logic.
     *
     * Subclasses implement this method with their specific logic. The base
     * class handles timeout and error wrapping.
     *
     * INVARIANTS:
     * - Must not modify observer state
     * - Must not store references to context after returning
     * - Should be idempotent if possible
     *
     * @param context - Execution context
     * @throws ObserverError (or subclass) on failure
     */
    abstract execute(context: ObserverContext): Promise<void>;

    // =========================================================================
    // TIMEOUT HANDLING
    // =========================================================================

    /**
     * Execute with timeout protection.
     *
     * WHY: Prevents runaway observers from blocking the entire pipeline.
     * If an observer hangs (database deadlock, infinite loop), the pipeline
     * can fail fast rather than waiting indefinitely.
     *
     * ALGORITHM:
     * 1. Start execute() and timeout race
     * 2. If execute() wins, clear timeout and return normally
     * 3. If timeout wins, throw ObserverError
     *
     * RACE CONDITION NOTE:
     * If timeout fires but execute() completes immediately after, the
     * timeout error wins. This is acceptable - observer exceeded its
     * time budget even if it eventually completed.
     *
     * CLEANUP:
     * The timeout is always cleared in finally block to prevent:
     * - Memory leaks (closure holding references)
     * - Spurious rejections after successful completion
     *
     * @param context - Execution context
     * @throws ObserverError on timeout or execution failure
     */
    async executeWithTimeout(context: ObserverContext): Promise<void> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(
                    new EOBSTIMEOUT(
                        `Observer '${this.name}' timed out after ${this.timeout}ms`,
                    ),
                );
            }, this.timeout);
        });

        try {
            await Promise.race([this.execute(context), timeoutPromise]);
        }
        catch (err) {
            // Re-throw ObserverError as-is
            if (err instanceof ObserverError) {
                throw err;
            }

            // Wrap unknown errors with context
            const message =
                err instanceof Error ? err.message : String(err);

            throw new EOBSERVER(
                `Observer '${this.name}' failed: ${message}`,
            );
        }
        finally {
            // CLEANUP: Always clear timeout to prevent memory leaks and spurious rejections.
            // This runs whether execute() succeeds, fails, or times out.
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        }
    }
}
