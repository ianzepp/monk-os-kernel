/**
 * Frozen Observer - Ring 1 Validation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Frozen is the first Ring 1 observer (priority 10). It blocks all data
 * changes (create, update, delete) to models marked as frozen.
 *
 * Frozen models are typically system tables or finalized data that should
 * never change after initial setup. Examples:
 * - Audit logs
 * - Historical snapshots
 * - System configuration after bootstrap
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll/updateAll/deleteAll
 *     │
 * Ring 0: Data preparation
 *     │
 * Ring 1 (this): ──► Is model.isFrozen? ──► YES ──► throw EOBSFROZEN
 *     │                                      │
 *     │                                      NO
 *     ▼                                      │
 * Ring 1 (continue): Other validation ◄─────┘
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Frozen check happens before any other validation
 * INV-2: All operations (create, update, delete) are blocked equally
 * INV-3: Error message includes model name for debugging
 *
 * @module model/ring/1/frozen
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSFROZEN } from '../../observers/errors.js';

// =============================================================================
// FROZEN OBSERVER
// =============================================================================

/**
 * Blocks all changes to frozen models.
 *
 * WHY priority 10: Should run first in Ring 1 to fail fast before
 * wasting cycles on detailed validation of data that will be rejected anyway.
 */
export class Frozen extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'Frozen';

    /**
     * Ring 1 = Input validation.
     */
    readonly ring = ObserverRing.InputValidation;

    /**
     * Priority 10 = first in ring.
     *
     * WHY 10: Frozen check is the cheapest validation (single boolean).
     * Run it first to fail fast.
     */
    readonly priority = 10;

    /**
     * Blocks all mutation operations.
     */
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Check if model is frozen and reject if so.
     *
     * ALGORITHM:
     * 1. Check model.isFrozen
     * 2. If true, throw EOBSFROZEN
     * 3. Otherwise, return (allow pipeline to continue)
     *
     * @param context - Observer context with model metadata
     * @throws EOBSFROZEN if model is frozen
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model } = context;

        if (model.isFrozen) {
            throw new EOBSFROZEN(
                `Model '${model.modelName}' is frozen and cannot be modified`
            );
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default Frozen;
