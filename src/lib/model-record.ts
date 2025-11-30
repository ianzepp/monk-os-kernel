import type { Model } from '@src/lib/model.js';

/**
 * Proxy handler for ModelRecord that enables property accessor syntax
 * Intercepts property access and delegates to get()/set() methods
 * Validates that accessed properties are valid model fields
 */
const ModelRecordProxyHandler: ProxyHandler<ModelRecord> = {
    get(target, prop, receiver) {
        // If prop is a symbol or a known method/property, use default behavior
        if (typeof prop === 'symbol' || prop in target) {
            return Reflect.get(target, prop, receiver);
        }

        // Validate field exists in model
        if (!target.model.hasField(prop)) {
            const error = new Error(
                `Field '${prop}' not found on model '${target.model.model_name}'`
            );
            (error as any).code = 'FIELD_NOT_FOUND';
            (error as any).model = target.model.model_name;
            (error as any).field = prop;
            (error as any).availableFields = Array.from(target.model.getTypedFields().keys());
            throw error;
        }

        // Delegate to get() method
        return target.get(prop);
    },

    set(target, prop, value, receiver) {
        // If prop is a symbol or a known property, use default behavior
        if (typeof prop === 'symbol' || prop in target) {
            return Reflect.set(target, prop, value, receiver);
        }

        // Validate field exists in model
        if (!target.model.hasField(prop)) {
            const error = new Error(
                `Field '${prop}' not found on model '${target.model.model_name}'`
            );
            (error as any).code = 'FIELD_NOT_FOUND';
            (error as any).model = target.model.model_name;
            (error as any).field = prop;
            (error as any).availableFields = Array.from(target.model.getTypedFields().keys());
            throw error;
        }

        // Delegate to set() method
        target.set(prop, value);
        return true;
    }
};

/**
 * First-class record object that wraps data being created/updated
 * and tracks changes against original database state.
 *
 * Features:
 * - Holds both current (new/changed) and original (from DB) data
 * - Tracks field-level changes with shallow comparison
 * - Validates field writes against model
 * - Provides diff/rollback/clone capabilities
 * - Knows its model for validation and metadata access
 * - Supports property accessor syntax (record.field instead of record.get('field'))
 */
export class ModelRecord {
    readonly model: Model;
    private _current: Record<string, any>;
    private _original: Record<string, any> | null;

    // Index signature for dynamic field access via Proxy
    [field: string]: any;

    /**
     * Create a new ModelRecord wrapping input data
     * @param model The model this record belongs to
     * @param data The input data (for creates/updates)
     */
    constructor(model: Model, data: Record<string, any>) {
        this.model = model;
        this._current = { ...data };  // Shallow copy
        this._original = null;  // Will be set by RecordPreloader for updates

        // Return a Proxy that enables property accessor syntax
        return new Proxy(this, ModelRecordProxyHandler) as this;
    }

    /**
     * Load existing record data from the database
     * Called by RecordPreloader observer for update/delete/revert operations
     * @param existingData The record data loaded from database
     */
    load(existingData: Record<string, any>): void {
        if (this._original !== null) {
            console.warn('ModelRecord.load() called multiple times', {
                model: this.model.model_name,
                id: this._current.id
            });
        }
        this._original = Object.freeze({ ...existingData });
    }

    /**
     * Check if this is a new record (no original data loaded)
     * @returns true for CREATE operations, false for UPDATE/DELETE
     */
    isNew(): boolean {
        return this._original === null;
    }

    /**
     * Get the effective current value of a field (merged view)
     * For UPDATE operations, returns the new value if changed, otherwise the original value
     * For CREATE operations, returns the new value
     * @param field The field name
     * @returns The effective value (current overrides original)
     */
    get(field: string): any {
        // Return current value if set, otherwise fall back to original
        return this._current[field] ?? this._original?.[field];
    }

    /**
     * Get only the new/updated value of a field (current-only view)
     * Returns undefined if field is not being changed in this operation
     * Useful for transforms and processors that only operate on changed data
     * @param field The field name
     * @returns The new value being set, or undefined if not changing
     */
    new(field: string): any {
        return this._current[field];
    }

    /**
     * Get the original value of a field from the database (original-only view)
     * Alias for getOriginal() with shorter name for symmetry with new()
     * @param field The field name
     * @returns The original value from DB, or undefined if new record
     */
    old(field: string): any {
        return this._original?.[field];
    }

    /**
     * Set the current value of a field
     * Validates against model if field is not recognized
     * @param field The field name
     * @param value The value to set
     */
    set(field: string, value: any): void {
        // Validate field exists in model (cheap check)
        if (!this.model.hasField(field)) {
            console.warn('Setting unknown field on ModelRecord', {
                model: this.model.model_name,
                field,
                knownFields: Array.from(this.model.getTypedFields().keys())
            });
        }

        this._current[field] = value;
    }

    /**
     * Replace entire current state with new data (used by SQL observers after DB operations)
     * Updates _current with final database state (e.g., updated timestamps, generated IDs)
     * Preserves _original for change tracking
     * @param data The complete record data from database
     */
    setCurrent(data: Record<string, any>): void {
        this._current = { ...data };
    }

    /**
     * Check if a field exists in the current data
     * @param field The field name
     * @returns true if field exists (even if undefined)
     */
    has(field: string): boolean {
        return field in this._current;
    }

    /**
     * Check if a field has changed from its original value
     * Uses shallow comparison (reference equality)
     * @param field The field name
     * @returns true if field changed, or true for new records
     */
    changed(field: string): boolean {
        // New records: all fields are "changed"
        if (this._original === null) {
            return field in this._current;
        }

        // Shallow comparison
        return this._current[field] !== this._original[field];
    }

    /**
     * Get all field changes as old/new pairs
     * @returns Object mapping field names to {old, new} values
     */
    getChanges(): Record<string, { old: any; new: any }> {
        const changes: Record<string, { old: any; new: any }> = {};

        if (this._original === null) {
            // For creates, all current fields are "changes" from null
            for (const key of Object.keys(this._current)) {
                changes[key] = { old: null, new: this._current[key] };
            }
            return changes;
        }

        // For updates, compare all current fields
        for (const key of Object.keys(this._current)) {
            if (this._current[key] !== this._original[key]) {
                changes[key] = {
                    old: this._original[key],
                    new: this._current[key]
                };
            }
        }

        return changes;
    }

    /**
     * Get the original value of a field (before changes)
     * @param field The field name
     * @returns The original value, or undefined if new record or field didn't exist
     */
    getOriginal(field: string): any {
        return this._original?.[field];
    }

    /**
     * Check if any fields have changed
     * @returns true if any field is different from original
     */
    hasChanges(): boolean {
        if (this._original === null) {
            return Object.keys(this._current).length > 0;
        }

        for (const key of Object.keys(this._current)) {
            if (this._current[key] !== this._original[key]) {
                return true;
            }
        }

        return false;
    }

    /**
     * Alias for hasChanges()
     */
    isChanged(): boolean {
        return this.hasChanges();
    }

    /**
     * Get list of field names that have changed
     * @returns Array of field names
     */
    getChangedFields(): string[] {
        if (this._original === null) {
            return Object.keys(this._current);
        }

        const changedFields: string[] = [];
        for (const key of Object.keys(this._current)) {
            if (this._current[key] !== this._original[key]) {
                changedFields.push(key);
            }
        }

        return changedFields;
    }

    /**
     * Alias for getChangedFields()
     * Useful for SQL UPDATE statements that only update changed fields
     */
    diff(): string[] {
        return this.getChangedFields();
    }

    /**
     * Rollback changes to original values
     * @param field Optional field name to rollback; if omitted, rollback all fields
     */
    rollback(field?: string): void {
        if (this._original === null) {
            if (field) {
                delete this._current[field];
            } else {
                this._current = {};
            }
            return;
        }

        if (field) {
            // Rollback single field
            if (field in this._original) {
                this._current[field] = this._original[field];
            } else {
                delete this._current[field];
            }
        } else {
            // Rollback all fields
            this._current = { ...this._original };
        }
    }

    /**
     * Create a copy of this record
     * @returns New ModelRecord with same model and cloned data
     */
    clone(): ModelRecord {
        const cloned = new ModelRecord(this.model, this._current);
        if (this._original !== null) {
            cloned.load({ ...this._original });
        }
        return cloned;
    }

    /**
     * Convert to plain object for SQL operations
     * Merges original and current data (current overrides original)
     * @returns Merged plain object
     */
    toObject(): Record<string, any> {
        if (this._original === null) {
            return { ...this._current };
        }

        return { ...this._original, ...this._current };
    }

    /**
     * Convert to JSON for debugging/logging
     * @returns Debug representation showing model, state, and changes
     */
    toJSON(): object {
        return {
            model: this.model.model_name,
            isNew: this.isNew(),
            current: this._current,
            original: this._original,
            changes: this.getChanges(),
            changedFields: this.getChangedFields()
        };
    }
}
