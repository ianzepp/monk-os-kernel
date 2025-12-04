/**
 * ModelRecord - Change tracking wrapper for entity mutations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ModelRecord wraps an entity record with change tracking capabilities.
 * It maintains both the original values (from the database) and pending
 * changes (from user input), enabling observers to:
 *
 * - Access original values for comparison
 * - Access new values for validation
 * - Detect which fields are being changed
 * - Generate change diffs for audit logging
 *
 * The record flows through the observer pipeline, where observers may
 * read, modify, or reject changes. After all observers complete, the
 * final state is persisted to the database.
 *
 * USAGE
 * =====
 * ```typescript
 * // For CREATE: original is empty, all input becomes changes
 * const createRecord = new ModelRecord({}, { name: 'Alice', email: 'alice@example.com' });
 *
 * // For UPDATE: original has existing data, input has changes
 * const existing = { id: '123', name: 'Alice', email: 'old@example.com' };
 * const updateRecord = new ModelRecord(existing, { email: 'new@example.com' });
 *
 * // Observer can check what's changing
 * if (updateRecord.has('email')) {
 *     const oldEmail = updateRecord.old('email'); // 'old@example.com'
 *     const newEmail = updateRecord.new('email'); // 'new@example.com'
 * }
 *
 * // Get merged record for INSERT/UPDATE
 * const data = updateRecord.toRecord(); // { id: '123', name: 'Alice', email: 'new@example.com' }
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Original data is never modified after construction
 * INV-2: Changes are tracked as a separate Map
 * INV-3: get() returns new value if changed, else original value
 * INV-4: has() returns true only if field has a pending change
 *
 * CONCURRENCY MODEL
 * =================
 * ModelRecord is mutable during observer pipeline execution. Observers
 * run sequentially within a ring, so no concurrent mutation. However,
 * observers should not hold references to ModelRecord across await points.
 *
 * @module model/model-record
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Generic record type for entity data.
 *
 * WHY unknown: Entity records have dynamic fields based on model definition.
 */
export type RecordData = Record<string, unknown>;

/**
 * Change diff entry for a single field.
 */
export interface FieldDiff {
    /** Value before the change */
    old: unknown;

    /** Value after the change */
    new: unknown;
}

/**
 * Complete diff of all changed fields.
 *
 * WHY separate type: Used for audit logging in tracked table.
 */
export type RecordDiff = Record<string, FieldDiff>;

// =============================================================================
// MODEL RECORD CLASS
// =============================================================================

/**
 * Change tracking wrapper for entity records.
 *
 * TESTABILITY: Pure TypeScript class with no external dependencies.
 * Can be constructed and tested without database or HAL.
 */
export class ModelRecord {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Original data from database.
     *
     * WHY readonly copy: Prevents accidental mutation of original values.
     * INVARIANT: Never modified after construction.
     */
    private readonly original: RecordData;

    /**
     * Pending changes.
     *
     * WHY Map: O(1) lookup and explicit tracking of which fields changed.
     * A field in this Map means it has a pending change, even if value is same.
     */
    private readonly changes: Map<string, unknown>;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a ModelRecord with optional original and input data.
     *
     * ALGORITHM:
     * 1. Copy original data (shallow clone)
     * 2. Initialize empty changes Map
     * 3. Apply input data as changes
     *
     * @param originalData - Existing record from database (empty for CREATE)
     * @param inputData - New/changed values from user input
     */
    constructor(
        originalData: RecordData = {},
        inputData: RecordData = {}
    ) {
        // WHY shallow clone: Prevents external mutation of original.
        // Deep clone not needed - field values should be primitives.
        this.original = { ...originalData };
        this.changes = new Map();

        // Apply input as changes
        for (const [key, value] of Object.entries(inputData)) {
            this.set(key, value);
        }
    }

    // =========================================================================
    // RECORD STATUS
    // =========================================================================

    /**
     * Is this a new record (no original data)?
     *
     * WHY check id specifically: A record with no id or empty original is new.
     * This distinguishes CREATE from UPDATE operations.
     */
    isNew(): boolean {
        return Object.keys(this.original).length === 0 || !this.original.id;
    }

    /**
     * Has any field been changed?
     *
     * WHY: Observers can skip processing if nothing changed.
     */
    hasChanges(): boolean {
        return this.changes.size > 0;
    }

    /**
     * Get count of changed fields.
     */
    get changeCount(): number {
        return this.changes.size;
    }

    // =========================================================================
    // VALUE ACCESS
    // =========================================================================

    /**
     * Get original value (from database).
     *
     * @param field - Field name
     * @returns Original value or undefined if field didn't exist
     */
    old(field: string): unknown {
        return this.original[field];
    }

    /**
     * Get new value (from input).
     *
     * WHY separate from get(): Observers may need to compare old vs new.
     *
     * @param field - Field name
     * @returns New value or undefined if field not changed
     */
    new(field: string): unknown {
        return this.changes.get(field);
    }

    /**
     * Get merged value (new if changed, else original).
     *
     * WHY: Most observers just need the current/intended value.
     *
     * @param field - Field name
     * @returns Merged value
     */
    get(field: string): unknown {
        if (this.changes.has(field)) {
            return this.changes.get(field);
        }
        return this.original[field];
    }

    /**
     * Check if field is being changed.
     *
     * WHY: Observers may only care about specific field changes.
     *
     * @param field - Field name
     * @returns True if field has a pending change
     */
    has(field: string): boolean {
        return this.changes.has(field);
    }

    /**
     * Check if field exists (in original or changes).
     *
     * @param field - Field name
     * @returns True if field exists anywhere
     */
    exists(field: string): boolean {
        return field in this.original || this.changes.has(field);
    }

    // =========================================================================
    // VALUE MUTATION
    // =========================================================================

    /**
     * Set a new value.
     *
     * WHY: Observers may transform or populate fields.
     *
     * @param field - Field name
     * @param value - New value
     */
    set(field: string, value: unknown): void {
        this.changes.set(field, value);
    }

    /**
     * Remove a change (revert to original).
     *
     * WHY: Observers may reject changes to specific fields.
     *
     * @param field - Field name
     */
    unset(field: string): void {
        this.changes.delete(field);
    }

    /**
     * Clear all changes.
     *
     * WHY: Useful for reverting all pending changes.
     */
    clearChanges(): void {
        this.changes.clear();
    }

    // =========================================================================
    // BULK ACCESS
    // =========================================================================

    /**
     * Get all changed field names.
     *
     * @returns Array of field names with pending changes
     */
    getChangedFields(): string[] {
        return Array.from(this.changes.keys());
    }

    /**
     * Get all field names (original + changes).
     *
     * @returns Array of all field names
     */
    getAllFields(): string[] {
        const fields = new Set<string>(Object.keys(this.original));
        for (const key of this.changes.keys()) {
            fields.add(key);
        }
        return Array.from(fields);
    }

    /**
     * Get merged record for database insert/update.
     *
     * WHY: Produces final record state after all changes applied.
     *
     * @returns Merged record data
     */
    toRecord(): RecordData {
        const result = { ...this.original };
        for (const [key, value] of this.changes) {
            result[key] = value;
        }
        return result;
    }

    /**
     * Get only the changes (for UPDATE statements).
     *
     * WHY: UPDATE only needs changed columns, not full record.
     *
     * @returns Record of only changed fields
     */
    toChanges(): RecordData {
        const result: RecordData = {};
        for (const [key, value] of this.changes) {
            result[key] = value;
        }
        return result;
    }

    /**
     * Get change diff for audit logging.
     *
     * WHY: Tracked table records old/new values for audited fields.
     *
     * ALGORITHM:
     * 1. Iterate all changes
     * 2. Compare with original value
     * 3. Include in diff only if values differ
     *
     * @returns Diff of changed fields with old/new values
     */
    getDiff(): RecordDiff {
        const diff: RecordDiff = {};
        for (const [key, newValue] of this.changes) {
            const oldValue = this.original[key];
            // WHY strict inequality: Treat null/undefined differences as changes
            if (oldValue !== newValue) {
                diff[key] = { old: oldValue, new: newValue };
            }
        }
        return diff;
    }

    /**
     * Get diff for specific fields only.
     *
     * WHY: Tracked table only logs fields with tracked=1.
     *
     * @param fields - Set of field names to include
     * @returns Filtered diff
     */
    getDiffForFields(fields: Set<string>): RecordDiff {
        const diff: RecordDiff = {};
        for (const [key, newValue] of this.changes) {
            if (!fields.has(key)) continue;
            const oldValue = this.original[key];
            if (oldValue !== newValue) {
                diff[key] = { old: oldValue, new: newValue };
            }
        }
        return diff;
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get the original data (read-only copy).
     *
     * TESTING: Allows verification of original state.
     */
    getOriginal(): Readonly<RecordData> {
        return this.original;
    }

    /**
     * Check if original has a field.
     *
     * TESTING: Verify original state.
     */
    hasOriginal(field: string): boolean {
        return field in this.original;
    }
}
