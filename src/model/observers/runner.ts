/**
 * Observer Pipeline - Runner
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The ObserverRunner is the execution engine for the observer pipeline. It:
 * - Maintains a registry of observers organized by ring
 * - Executes observers in ring order (0 → 9)
 * - Respects priority ordering within each ring
 * - Handles Ring 1's special error accumulation behavior
 * - Tracks execution results for debugging/metrics
 *
 * EXECUTION MODEL
 * ===============
 * ```
 * run(context)
 *   for ring in 0..9:
 *     for observer in sorted_by_priority(ring):
 *       if observer.matches(operation, model):
 *         observer.execute(context)
 *         if error:
 *           if ring == 1: accumulate
 *           else: throw immediately
 *     if ring == 1 and errors: throw AggregateError
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Rings execute in ascending order (0 → 9)
 * INV-2: Within a ring, observers execute by priority (lower first)
 * INV-3: Ring 1 errors accumulate; other ring errors fail-fast
 * INV-4: Observer list is sorted on registration, not on each run
 * INV-5: Empty rings are skipped (no error)
 *
 * CONCURRENCY MODEL
 * =================
 * ObserverRunner is designed for concurrent use:
 * - Observer registration is typically done once at startup
 * - run() creates no shared mutable state
 * - Each run() gets its own results array
 * - Context is per-request, not shared
 *
 * Multiple concurrent run() calls are safe if:
 * - Observers are stateless (they should be)
 * - Context is not shared between requests
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Observer list mutation during iteration
 *       FIX: Copy observer list when iterating (or freeze on first run)
 *
 * @module model/observers/runner
 */

import type { Observer, ObserverContext } from './interfaces.js';
import { ObserverRing, type ObserverResult } from './types.js';
import { EOBSINVALID } from './errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Number of rings in the pipeline.
 *
 * WHY 10: Matches ObserverRing enum (0-9). Provides clear separation between
 * conceptual phases while allowing future expansion.
 */
const RING_COUNT = 10;

/**
 * Ring 1 (InputValidation) has special error handling.
 *
 * WHY special: Validation errors should accumulate so users see all problems
 * at once, not one at a time. Other rings fail-fast because partial execution
 * of security/database/audit rings is dangerous.
 */
const VALIDATION_RING = ObserverRing.InputValidation;

// =============================================================================
// OBSERVER RUNNER
// =============================================================================

/**
 * Executes observers in ring order with priority-based ordering.
 *
 * TESTABILITY:
 * - Observers can be registered individually for unit tests
 * - run() returns results array for verification
 * - getObserverCount() exposes internal state for assertions
 */
export class ObserverRunner {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Observers organized by ring.
     *
     * WHY Map<ring, Observer[]>: Fast lookup by ring. Array per ring maintains
     * insertion order after sorting.
     *
     * INVARIANT: Each ring's array is sorted by priority (ascending).
     */
    private readonly observers: Map<ObserverRing, Observer[]> = new Map();

    // =========================================================================
    // REGISTRATION
    // =========================================================================

    /**
     * Register an observer.
     *
     * ALGORITHM:
     * 1. Get or create array for observer's ring
     * 2. Add observer to array
     * 3. Sort array by priority (lower first)
     *
     * WHY sort on register: Avoids sorting on every run(). Registration
     * happens once at startup; run() happens on every request.
     *
     * @param observer - Observer to register
     */
    register(observer: Observer): void {
        const ring = observer.ring;

        if (!this.observers.has(ring)) {
            this.observers.set(ring, []);
        }

        const ringObservers = this.observers.get(ring)!;
        ringObservers.push(observer);

        // Sort by priority (lower = first)
        ringObservers.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Register multiple observers.
     *
     * WHY: Convenience for bulk registration at startup.
     *
     * @param observers - Observers to register
     */
    registerAll(observers: Observer[]): void {
        for (const observer of observers) {
            this.register(observer);
        }
    }

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Execute all applicable observers for a context.
     *
     * ALGORITHM:
     * 1. For each ring 0-9:
     *    a. Get observers for this ring
     *    b. For each observer (already sorted by priority):
     *       i.  Skip if observer doesn't handle this operation
     *       ii. Skip if observer doesn't handle this model
     *       iii. Execute observer, track timing
     *       iv. On error: accumulate (Ring 1) or throw (other rings)
     *    c. If Ring 1 and errors accumulated: throw AggregateError
     * 2. Return results array
     *
     * RING 1 SPECIAL BEHAVIOR:
     * Validation errors are pushed to context.errors rather than thrown.
     * After all Ring 1 observers complete, if errors exist, throw AggregateError.
     * This allows users to see all validation problems at once.
     *
     * @param context - Execution context with model, record, operation
     * @returns Array of ObserverResult for debugging/metrics
     * @throws AggregateError if validation fails (Ring 1)
     * @throws ObserverError if any other ring fails
     */
    async run(context: ObserverContext): Promise<ObserverResult[]> {
        const results: ObserverResult[] = [];

        // Execute rings 0-9 in order
        for (let ring = 0; ring < RING_COUNT; ring++) {
            const ringObservers = this.observers.get(ring as ObserverRing) || [];

            for (const observer of ringObservers) {
                // Skip if observer doesn't handle this operation
                if (!observer.operations.includes(context.operation)) {
                    continue;
                }

                // Skip if observer is model-specific and doesn't match
                if (
                    observer.models?.length &&
                    !observer.models.includes(context.model.model_name)
                ) {
                    continue;
                }

                // Execute and track timing
                const start = Date.now();

                try {
                    await observer.execute(context);

                    results.push({
                        observer: observer.name,
                        ring: observer.ring,
                        duration: Date.now() - start,
                    });
                } catch (error) {
                    const result: ObserverResult = {
                        observer: observer.name,
                        ring: observer.ring,
                        duration: Date.now() - start,
                        error: error as Error,
                    };
                    results.push(result);

                    // Ring 1 (validation) accumulates errors
                    if (ring === VALIDATION_RING) {
                        if (error instanceof EOBSINVALID) {
                            context.errors.push(error);
                        } else {
                            // Non-validation error in validation ring - wrap it
                            context.errors.push(
                                new EOBSINVALID((error as Error).message)
                            );
                        }
                    } else {
                        // Other rings fail-fast
                        throw error;
                    }
                }
            }

            // After Ring 1, check for accumulated validation errors
            if (ring === VALIDATION_RING && context.errors.length > 0) {
                throw new AggregateError(
                    context.errors,
                    `Validation failed with ${context.errors.length} error(s)`
                );
            }
        }

        return results;
    }

    // =========================================================================
    // TESTING/DEBUGGING
    // =========================================================================

    /**
     * Get total number of registered observers.
     *
     * TESTABILITY: Allows tests to verify registration worked.
     *
     * @returns Total observer count across all rings
     */
    getObserverCount(): number {
        let count = 0;
        for (const observers of this.observers.values()) {
            count += observers.length;
        }
        return count;
    }

    /**
     * Get number of observers in a specific ring.
     *
     * TESTABILITY: Allows tests to verify ring assignment.
     *
     * @param ring - Ring to check
     * @returns Observer count for that ring
     */
    getObserverCountForRing(ring: ObserverRing): number {
        return this.observers.get(ring)?.length || 0;
    }

    /**
     * Get observer names in a ring (for debugging).
     *
     * TESTABILITY: Allows tests to verify priority ordering.
     *
     * @param ring - Ring to list
     * @returns Observer names in execution order
     */
    getObserverNamesForRing(ring: ObserverRing): string[] {
        return (this.observers.get(ring) || []).map((o) => o.name);
    }
}
