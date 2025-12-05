/**
 * Immutable Observer - Ring 1 Validation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Immutable is a Ring 1 observer (priority 30) that blocks changes to
 * fields marked as immutable after their initial value is set.
 *
 * Immutable fields are typically identifiers or references that should
 * never change after creation. Examples:
 * - Foreign keys (customer_id on an order)
 * - Record type discriminators
 * - External system identifiers
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * Ring 1 (Frozen passed)
 *     │
 * Ring 1 (this): ──► For each changed field:
 *     │                  Is field immutable?
 *     │                  Was old value non-null?
 *     │                  Is new value different?
 *     │                      │
 *     │                      YES to all ──► collect violation
 *     │                      │
 *     ▼                      NO
 * After loop: any violations? ──► YES ──► throw EOBSIMMUT
 *     │
 *     NO
 *     ▼
 * Ring 1 (continue): Other validation
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Only applies to 'update' operations (creates can set any value)
 * INV-2: First write is allowed (old value null/undefined)
 * INV-3: Error includes field name for debugging
 *
 * @module model/ring/1/immutable
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSIMMUT } from '../../observers/errors.js';

// =============================================================================
// IMMUTABLE OBSERVER
// =============================================================================

/**
 * Blocks changes to immutable fields.
 *
 * WHY priority 30: After Frozen (10) but before Constraints (40).
 * Immutable check is cheap (set lookup + value comparison).
 */
export class Immutable extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'Immutable';

    /**
     * Ring 1 = Input validation.
     */
    readonly ring = ObserverRing.InputValidation;

    /**
     * Priority 30 = middle of validation ring.
     */
    readonly priority = 30;

    /**
     * Only applies to updates - creates can set any initial value.
     */
    readonly operations: readonly OperationType[] = ['update'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Check for immutable field violations.
     *
     * ALGORITHM:
     * 1. Get set of immutable field names from model
     * 2. For each changed field in record:
     *    a. Skip if not immutable
     *    b. Skip if old value was null/undefined (first write allowed)
     *    c. Compare old vs new - if different, record violation
     * 3. If any violations, throw EOBSIMMUT with details
     *
     * WHY allow first write: Immutable means "cannot change after set",
     * not "cannot ever be set". A field might be optional on create
     * but once set, cannot change.
     *
     * @param context - Observer context with model and record
     * @throws EOBSIMMUT if immutable field is being changed
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model, record } = context;

        // Get immutable fields from model metadata
        const immutableFields = model.getImmutableFields();

        if (immutableFields.size === 0) {
            return;
        }

        // Collect violations
        const violations: { field: string; old: unknown; new: unknown }[] = [];

        for (const fieldName of record.getChangedFields()) {
            // Skip if field is not immutable
            if (!immutableFields.has(fieldName)) {
                continue;
            }

            const oldValue = record.old(fieldName);
            const newValue = record.get(fieldName);

            // Allow first write (old was null/undefined)
            if (oldValue === null || oldValue === undefined) {
                continue;
            }

            // Check if actually changing the value
            // Use JSON.stringify for deep comparison of objects/arrays
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                violations.push({ field: fieldName, old: oldValue, new: newValue });
            }
        }

        // Throw if any violations found
        if (violations.length > 0) {
            const details = violations
                .map(v => `${v.field} (was: ${JSON.stringify(v.old)})`)
                .join(', ');

            throw new EOBSIMMUT(
                `Cannot modify immutable field(s): ${details}`,
                violations[0]!.field,
            );
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default Immutable;
