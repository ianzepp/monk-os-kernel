import type { FilterData } from '@src/lib/filter-types.js';
import type { SystemContext } from '@src/lib/system-context-types.js';
import { Field, type FieldRow } from '@src/lib/field.js';

export type ModelName = string;

/**
 * Special models that are fundamental to the platform and cannot be modified
 */
export const SYSTEM_MODELS = new Set([
    'models',
    'fields',
]);

/**
 * Predefined fields that exist on every model
 */
export const SYSTEM_FIELDS = new Set([
     'id',
     'created_at',
     'updated_at',
     'deleted_at',
     'trashed_at',
     'access_deny',
     'access_edit',
     'access_full',
     'access_read',
 ]);

/**
 * Merged validation configuration for a single field
 * Pre-calculated once per model to avoid redundant loops during validation
 * @deprecated Use model.fields and Field class directly
 */
export interface FieldValidationConfig {
    fieldName: string;
    required: boolean;
    type?: { type: string; is_array: boolean };
    constraints?: { minimum?: number; maximum?: number; pattern?: RegExp };
    enum?: string[];
}

/**
 * Model wrapper class providing database operation proxies and validation
 *
 * Holds core metadata and categorized Field maps for O(1) lookups.
 * Part of the namespace cache refactor (Phase 3).
 */
export class Model {
    // Core metadata (from models table)
    public readonly modelName: ModelName;
    public readonly status: string;
    public readonly sudo?: boolean;
    public readonly frozen?: boolean;
    public readonly external?: boolean;
    public readonly passthrough?: boolean;

    // All fields for this model - primary collection
    public readonly fields: Map<string, Field>;      // key: field_name

    // Categorized views (same Field objects, filtered by attribute)
    public readonly immutables: Map<string, Field>;  // field.immutable === true
    public readonly sudos: Map<string, Field>;       // field.sudo === true
    public readonly requireds: Map<string, Field>;   // field.required === true
    public readonly trackeds: Map<string, Field>;    // field.tracked === true
    public readonly typeds: Map<string, Field>;      // field.type is set
    public readonly enums: Map<string, Field>;       // field.enumValues has values
    public readonly transforms: Map<string, Field>;  // field.transform is set
    public readonly constraints: Map<string, Field>; // field has min/max/pattern

    // ============================================================
    // BACKWARD COMPATIBILITY - Legacy properties (deprecated)
    // These will be removed in a future version
    // ============================================================

    /** @deprecated Use model.immutables.has(fieldName) instead */
    public readonly immutableFields: Set<string>;
    /** @deprecated Use model.sudos.has(fieldName) instead */
    public readonly sudoFields: Set<string>;
    /** @deprecated Use model.trackeds.has(fieldName) instead */
    public readonly trackedFields: Set<string>;
    /** @deprecated Use model.requireds.has(fieldName) instead */
    public readonly requiredFields: Set<string>;
    /** @deprecated Use model.typeds and Field.type/isArray instead */
    public readonly typedFields: Map<string, { type: string; is_array: boolean }>;
    /** @deprecated Use model.constraints and Field.minimum/maximum/pattern instead */
    public readonly rangeFields: Map<string, { minimum?: number; maximum?: number; pattern?: RegExp }>;
    /** @deprecated Use model.enums and Field.enumValues instead */
    public readonly enumFields: Map<string, string[]>;
    /** @deprecated Use model.transforms and Field.transform instead */
    public readonly transformFields: Map<string, string>;
    /** @deprecated Use model.fields and iterate with Field class methods */
    public readonly validationFields: FieldValidationConfig[];

    constructor(
        private system: SystemContext,
        modelName: ModelName,
        modelRecord: any
    ) {
        this.modelName = modelName;
        this.status = modelRecord.status || 'active';
        this.sudo = modelRecord.sudo;
        this.frozen = modelRecord.frozen;
        this.external = modelRecord.external;
        this.passthrough = modelRecord.passthrough;

        // Initialize all maps
        this.fields = new Map();
        this.immutables = new Map();
        this.sudos = new Map();
        this.requireds = new Map();
        this.trackeds = new Map();
        this.typeds = new Map();
        this.enums = new Map();
        this.transforms = new Map();
        this.constraints = new Map();

        // Legacy compatibility
        this.immutableFields = new Set();
        this.sudoFields = new Set();
        this.trackedFields = new Set();
        this.requiredFields = new Set();
        this.typedFields = new Map();
        this.rangeFields = new Map();
        this.enumFields = new Map();
        this.transformFields = new Map();

        // Process fields from modelRecord._fields
        if (modelRecord._fields && Array.isArray(modelRecord._fields)) {
            for (const fieldRow of modelRecord._fields) {
                const field = new Field(fieldRow as FieldRow);
                const fieldName = field.fieldName;

                // Store in primary collection
                this.fields.set(fieldName, field);

                // Categorized views
                if (field.immutable) {
                    this.immutables.set(fieldName, field);
                    this.immutableFields.add(fieldName); // Legacy
                }
                if (field.sudo) {
                    this.sudos.set(fieldName, field);
                    this.sudoFields.add(fieldName); // Legacy
                }
                if (field.required) {
                    this.requireds.set(fieldName, field);
                    this.requiredFields.add(fieldName); // Legacy
                }
                if (field.tracked) {
                    this.trackeds.set(fieldName, field);
                    this.trackedFields.add(fieldName); // Legacy
                }
                if (field.type) {
                    this.typeds.set(fieldName, field);
                    // Legacy format
                    this.typedFields.set(fieldName, {
                        type: field.type,
                        is_array: field.isArray,
                    });
                }
                if (field.hasEnum()) {
                    this.enums.set(fieldName, field);
                    this.enumFields.set(fieldName, field.enumValues!); // Legacy
                }
                if (field.hasTransform()) {
                    this.transforms.set(fieldName, field);
                    this.transformFields.set(fieldName, field.transform!); // Legacy
                }
                if (field.hasConstraints()) {
                    this.constraints.set(fieldName, field);
                    // Legacy format
                    this.rangeFields.set(fieldName, {
                        minimum: field.minimum,
                        maximum: field.maximum,
                        pattern: field.pattern,
                    });
                }
            }
        }

        // Build legacy validation fields
        this.validationFields = this.buildValidationFields();

        console.info('Model initialized with metadata', {
            modelName: this.modelName,
            frozen: this.frozen,
            fields: this.fields.size,
            immutables: this.immutables.size,
            sudos: this.sudos.size,
            requireds: this.requireds.size,
            trackeds: this.trackeds.size,
            typeds: this.typeds.size,
            enums: this.enums.size,
            transforms: this.transforms.size,
            constraints: this.constraints.size,
        });
    }

    /**
     * Build merged validation field configurations
     * @deprecated Use model.fields with Field class methods
     */
    private buildValidationFields(): FieldValidationConfig[] {
        const configs: FieldValidationConfig[] = [];

        // Collect all unique field names that have any validation metadata
        const allFieldNames = new Set<string>([
            ...this.requireds.keys(),
            ...this.typeds.keys(),
            ...this.constraints.keys(),
            ...this.enums.keys(),
        ]);

        // Build config for each field (excluding system fields)
        for (const fieldName of allFieldNames) {
            if (SYSTEM_FIELDS.has(fieldName)) {
                continue;
            }

            const field = this.fields.get(fieldName);
            if (!field) continue;

            const config: FieldValidationConfig = {
                fieldName,
                required: field.required,
            };

            if (field.type) {
                config.type = { type: field.type, is_array: field.isArray };
            }

            if (field.hasConstraints()) {
                config.constraints = {
                    minimum: field.minimum,
                    maximum: field.maximum,
                    pattern: field.pattern,
                };
            }

            if (field.hasEnum()) {
                config.enum = field.enumValues;
            }

            configs.push(config);
        }

        return configs;
    }

    // ============================================================
    // NEW API - Use these in new code
    // ============================================================

    /**
     * Check if a field exists in this model
     * Returns true if the field is either a system field or defined in fields table
     */
    hasField(fieldName: string): boolean {
        if (SYSTEM_FIELDS.has(fieldName)) {
            return true;
        }
        return this.fields.has(fieldName);
    }

    /**
     * Get a field by name
     */
    getField(fieldName: string): Field | undefined {
        return this.fields.get(fieldName);
    }

    /**
     * Check if this model is a protected system model
     */
    isSystemModel(): boolean {
        return this.status === 'system';
    }

    /**
     * Check if this model is frozen (no data changes allowed)
     */
    isFrozen(): boolean {
        return this.frozen === true;
    }

    /**
     * Check if this model uses passthrough inserts
     *
     * Passthrough models bypass the observer pipeline for inserts:
     * - Rings 0-4 (validation, defaults, transforms) are skipped
     * - Ring 5 (database) executes the INSERT
     * - Rings 6-9 (post-insert triggers, audit) are skipped
     *
     * Use for high-throughput data like sensor readings, logs, telemetry.
     */
    isPassthrough(): boolean {
        return this.passthrough === true;
    }

    // ============================================================
    // LEGACY API - Kept for backward compatibility
    // These will be removed in a future version
    // ============================================================

    /**
     * @deprecated Use model.immutables.has(fieldName) instead
     */
    isFieldImmutable(fieldName: string): boolean {
        return this.immutables.has(fieldName);
    }

    /**
     * @deprecated Use model.immutables instead
     */
    getImmutableFields(): Set<string> {
        return this.immutableFields;
    }

    /**
     * @deprecated Use model.sudos.has(fieldName) instead
     */
    isFieldSudo(fieldName: string): boolean {
        return this.sudos.has(fieldName);
    }

    /**
     * @deprecated Use model.sudos instead
     */
    getSudoFields(): Set<string> {
        return this.sudoFields;
    }

    /**
     * @deprecated Use model.requireds instead
     */
    getRequiredFields(): Set<string> {
        return this.requiredFields;
    }

    /**
     * @deprecated Use model.typeds instead
     */
    getTypedFields(): Map<string, { type: string; is_array: boolean }> {
        return this.typedFields;
    }

    /**
     * @deprecated Use model.constraints instead
     */
    getRangeFields(): Map<string, { minimum?: number; maximum?: number; pattern?: RegExp }> {
        return this.rangeFields;
    }

    /**
     * @deprecated Use model.enums instead
     */
    getEnumFields(): Map<string, string[]> {
        return this.enumFields;
    }

    /**
     * @deprecated Use model.transforms instead
     */
    getTransformFields(): Map<string, string> {
        return this.transformFields;
    }

    /**
     * @deprecated Use model.fields with Field class methods
     */
    getValidationFields(): FieldValidationConfig[] {
        return this.validationFields;
    }

    get model_name(): ModelName {
        return this.modelName;
    }

    //
    // Database operation proxies - delegate to Database service
    //

    async count(filterData?: FilterData): Promise<number> {
        return this.system.database.count(this.modelName, filterData);
    }

    async selectAny(filterData: FilterData = {}): Promise<any[]> {
        return this.system.database.selectAny(this.modelName, filterData);
    }

    async selectOne(filterData: FilterData): Promise<any | null> {
        return this.system.database.selectOne(this.modelName, filterData);
    }

    async select404(filterData: FilterData, message?: string): Promise<any> {
        return this.system.database.select404(this.modelName, filterData, message);
    }

    // ID-based operations - always work with arrays
    async selectIds(ids: string[]): Promise<any[]> {
        return this.system.database.selectIds(this.modelName, ids);
    }

    async updateIds(ids: string[], changes: Record<string, any>): Promise<any[]> {
        return this.system.database.updateIds(this.modelName, ids, changes);
    }

    async deleteIds(ids: string[]): Promise<any[]> {
        return this.system.database.deleteIds(this.modelName, ids);
    }

    async selectMax(filter: FilterData = {}): Promise<any[]> {
        // Set limit to 'max' in filter and delegate
        filter.limit = 10000;
        return this.system.database.selectAny(this.modelName, filter);
    }

    // Transaction-based operations (require tx context)
    async createOne(record: Record<string, any>): Promise<any> {
        return this.system.database.createOne(this.modelName, record);
    }

    async createAll(collection: Record<string, any>[]): Promise<any[]> {
        return this.system.database.createAll(this.modelName, collection);
    }

    async updateOne(recordId: string, updates: Record<string, any>): Promise<any> {
        return this.system.database.updateOne(this.modelName, recordId, updates);
    }

    async updateAll(updates: Array<{ id: string; data: Record<string, any> }>): Promise<any[]> {
        return this.system.database.updateAll(this.modelName, updates);
    }

    async deleteOne(recordId: string): Promise<any> {
        return this.system.database.deleteOne(this.modelName, recordId);
    }

    async deleteAll(recordIds: string[]): Promise<any[]> {
        return this.system.database.deleteIds(this.modelName, recordIds);
    }

    // Upsert operations (simplified - create or update based on ID presence)
    async upsertOne(record: Record<string, any>): Promise<any> {
        if (record.id) {
            // Try to update, create if not found
            try {
                return await this.updateOne(record.id, record);
            } catch (error) {
                if (error instanceof Error && error.message.includes('not found')) {
                    return await this.createOne(record);
                }
                throw error;
            }
        } else {
            // No ID provided, create new record
            return await this.createOne(record);
        }
    }

    async upsertAll(collection: Record<string, any>[]): Promise<any[]> {
        const results: any[] = [];
        for (const record of collection) {
            results.push(await this.upsertOne(record));
        }
        return results;
    }

    // Advanced filter-based operations
    async updateAny(filterData: FilterData, changes: Record<string, any>): Promise<any[]> {
        return this.system.database.updateAny(this.modelName, filterData, changes);
    }

    async deleteAny(filterData: FilterData): Promise<any[]> {
        return this.system.database.deleteAny(this.modelName, filterData);
    }

    // Access control operations - separate from regular data updates
    async accessOne(recordId: string, accessChanges: Record<string, any>): Promise<any> {
        return this.system.database.accessOne(this.modelName, recordId, accessChanges);
    }

    async accessAll(updates: Array<{ id: string; access: Record<string, any> }>): Promise<any[]> {
        return this.system.database.accessAll(this.modelName, updates);
    }

    async accessAny(filter: FilterData, accessChanges: Record<string, any>): Promise<any[]> {
        return this.system.database.accessAny(this.modelName, filter, accessChanges);
    }

    // 404 operations - throw error if record not found
    async update404(filter: FilterData, changes: Record<string, any>, message?: string): Promise<any> {
        return this.system.database.update404(this.modelName, filter, changes, message);
    }

    async delete404(filter: FilterData, message?: string): Promise<any> {
        return this.system.database.delete404(this.modelName, filter, message);
    }

    async access404(filter: FilterData, accessChanges: Record<string, any>, message?: string): Promise<any> {
        return this.system.database.access404(this.modelName, filter, accessChanges, message);
    }

    // Utility methods
    toJSON() {
        return {
            model_name: this.modelName,
            status: this.status,
        };
    }
}
