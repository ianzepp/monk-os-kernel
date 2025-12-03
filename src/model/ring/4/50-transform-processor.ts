/**
 * TransformProcessor Observer - Ring 4 Enrichment
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * TransformProcessor is the data enrichment observer in Ring 4, responsible for
 * applying automatic transformations to field values before database persistence.
 * It runs after validation (Ring 1) but before SQL execution (Ring 5).
 *
 * Ring 4 runs AFTER validation to ensure:
 * - Invalid data is rejected before transformation
 * - Transforms operate on validated, well-formed input
 * - SQL in Ring 5 receives fully prepared data
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll('user', [{ email: '  John@Example.COM  ' }])
 *     │
 * Ring 1: Validate email format (passes)
 *     │
 * Ring 4 (this): ──► Apply transform='normalize_email'
 *     │              Record now has { email: 'john@example.com' }
 *     │
 * Ring 5: INSERT INTO user (email) VALUES ('john@example.com')
 * ```
 *
 * SUPPORTED TRANSFORMS
 * ====================
 * - lowercase: Convert to lowercase
 * - uppercase: Convert to uppercase
 * - trim: Remove leading/trailing whitespace
 * - normalize_email: Lowercase + trim (email standard normalization)
 * - normalize_phone: Extract digits, preserve leading + (E.164 prep)
 *
 * WHY RING 4
 * ==========
 * Transforms must run AFTER validation because:
 * - Ring 1 validates the raw input is acceptable
 * - Transforms may change values in ways that would confuse validation
 * - Example: normalize_phone strips non-digits, breaking pattern validation
 *
 * Transforms must run BEFORE database because:
 * - Ring 5 persists the final, transformed value
 * - Ring 7 (audit) should see the transformed value
 * - Queries should match transformed data
 *
 * INVARIANTS
 * ==========
 * INV-1: Only transforms fields that have changes in the record
 * INV-2: Only transforms non-null string values
 * INV-3: Unknown transforms log a warning but don't throw
 * INV-4: Transforms are idempotent (applying twice gives same result)
 *
 * CONCURRENCY MODEL
 * =================
 * Observer is synchronous - all transforms are pure string operations.
 * No await points means no interleaving within this observer.
 *
 * MEMORY MANAGEMENT
 * =================
 * Observer is stateless. Only creates temporary strings during transformation.
 * Uses record.set() to store results in the existing ModelRecord.
 *
 * @module model/ring/4/transform-processor
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

// =============================================================================
// TRANSFORM PROCESSOR OBSERVER
// =============================================================================

/**
 * Applies automatic transformations to field values.
 *
 * WHY priority 50: Middle of Ring 4. Leaves room for computed fields or
 * other enrichment observers before or after transforms.
 *
 * WHY create and update: Both operations set field values that may need
 * transformation. Delete doesn't modify field values.
 */
export class TransformProcessor extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'TransformProcessor';

    /**
     * Ring 4 = Enrichment.
     *
     * WHY: After validation (Ring 1) ensures we transform valid data.
     * Before database (Ring 5) ensures we persist transformed data.
     */
    readonly ring = ObserverRing.Enrichment;

    /**
     * Priority 50 = middle of ring.
     *
     * WHY 50: Standard transforms have no dependencies on other enrichment.
     * Computed fields (if added later) might run at different priorities.
     */
    readonly priority = 50;

    /**
     * Runs for create and update operations.
     *
     * WHY not delete: Delete doesn't modify field values, only sets trashed_at.
     */
    readonly operations: readonly OperationType[] = ['create', 'update'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Apply transforms to changed fields.
     *
     * ALGORITHM:
     * 1. Get transform map from model (field_name -> transform_type)
     * 2. Early return if no transforms defined
     * 3. For each changed field with a transform:
     *    a. Get the new value
     *    b. Skip if null/undefined or not a string
     *    c. Apply the transform function
     *    d. Set the transformed value back on the record
     *
     * WHY check has(): Only transform fields that are being set in this operation.
     * Existing values (from update) are already transformed from prior operations.
     *
     * @param context - Observer context with record to transform
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model, record } = context;

        // STEP 1: Get transform definitions
        // WHY from model: Cached in Model instance, no database query
        const transforms = model.getTransformFields();

        // STEP 2: Early return if no transforms
        // WHY check size: Most models don't have transforms
        if (transforms.size === 0) {
            return;
        }

        // STEP 3: Apply transforms to changed fields
        for (const [fieldName, transformType] of transforms) {
            // WHY has(): Only transform fields being set in this operation
            if (!record.has(fieldName)) {
                continue;
            }

            // Get the value to transform
            const value = record.get(fieldName);

            // DEFENSIVE: Only transform non-null strings
            // WHY check type: Transforms are string operations
            if (value === null || value === undefined) {
                continue;
            }
            if (typeof value !== 'string') {
                continue;
            }

            // Apply the transform
            const transformed = this.applyTransform(value, transformType);

            // Set the transformed value
            // WHY always set: Even if value unchanged, keeps code simple
            record.set(fieldName, transformed);
        }
    }

    // =========================================================================
    // TRANSFORM FUNCTIONS
    // =========================================================================

    /**
     * Apply a single transform to a string value.
     *
     * WHY switch: Clear mapping from transform name to operation.
     * Each case is a pure function with no side effects.
     *
     * @param value - The string value to transform
     * @param transform - The transform type name
     * @returns Transformed string value
     */
    private applyTransform(value: string, transform: string): string {
        switch (transform) {
            // Basic case transforms
            case 'lowercase':
                return value.toLowerCase();

            case 'uppercase':
                return value.toUpperCase();

            // Whitespace normalization
            case 'trim':
                return value.trim();

            // Email normalization: lowercase + trim
            // WHY: Email local-part is technically case-sensitive (RFC 5321)
            // but virtually all providers treat it as case-insensitive
            case 'normalize_email':
                return value.toLowerCase().trim();

            // Phone normalization: extract digits, preserve + prefix
            // WHY: Prepares for E.164 format (+CountryCode + National Number)
            // Example: '+1 (555) 123-4567' -> '+15551234567'
            case 'normalize_phone': {
                // Check for + prefix before stripping non-digits
                const hasPlus = value.trimStart().startsWith('+');
                // Remove all non-digit characters
                const digits = value.replace(/\D/g, '');
                // Reconstruct with + if originally present
                return (hasPlus ? '+' : '') + digits;
            }

            // Unknown transform: warn but don't fail
            // WHY: Graceful degradation for misconfigured fields
            default:
                console.warn(`[TransformProcessor] Unknown transform: ${transform}`);
                return value;
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default TransformProcessor;
