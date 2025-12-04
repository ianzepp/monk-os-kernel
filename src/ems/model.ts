/**
 * Model - Entity type metadata wrapper with field accessors
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Model class wraps a row from the `models` table along with its associated
 * field definitions from the `fields` table. It provides convenient accessors
 * for querying model behavior and field properties.
 *
 * This is the TypeScript representation of a model definition. The actual
 * entity data (file records, folder records, etc.) is stored in separate
 * entity tables and accessed via DatabaseService.
 *
 * USAGE
 * =====
 * ```typescript
 * // Models are loaded via ModelCache, not constructed directly
 * const model = await cache.get('file');
 *
 * if (model.isFrozen) {
 *     throw new EROFS('Cannot modify frozen model');
 * }
 *
 * const requiredFields = model.getRequiredFields();
 * for (const fieldName of requiredFields) {
 *     if (!data[fieldName]) {
 *         throw new EINVAL(`Missing required field: ${fieldName}`);
 *     }
 * }
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: model_name is unique and non-empty
 * INV-2: All fields belong to this model (field.model_name === this.model_name)
 * INV-3: Field lookup by name is O(1) via Map
 * INV-4: Categorization is computed lazily and cached
 *
 * CONCURRENCY MODEL
 * =================
 * Model instances are immutable after construction. Safe for concurrent read
 * access. The cache layer handles invalidation when model definitions change.
 *
 * @module model/model
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Row from the models table.
 *
 * WHY interface not type: Allows extension and implements checks.
 * WHY boolean as number: SQLite stores booleans as 0/1 integers.
 */
export interface ModelRow {
    /** UUID primary key */
    id: string;

    /** Unique model identifier (e.g., 'file', 'folder', 'invoice') */
    model_name: string;

    /** Model status: 'active', 'disabled', or 'system' */
    status: string;

    /** Human-readable description */
    description: string | null;

    /** Requires elevated access to modify entities */
    sudo: number;

    /** All entity changes prevented (read-only) */
    frozen: number;

    /** Entities can be created/deleted but not updated */
    immutable: number;

    /** Model is managed externally, reject local changes */
    external: number;

    /** Skip observer pipeline (dangerous) */
    passthrough: number;
}

/**
 * Row from the fields table.
 *
 * WHY comprehensive type: Field definitions drive validation, transformation,
 * and relationship handling throughout the observer pipeline.
 */
export interface FieldRow {
    /** UUID primary key */
    id: string;

    /** Parent model name (FK to models.model_name) */
    model_name: string;

    /** Field name within the model */
    field_name: string;

    /** Data type: text, integer, numeric, boolean, uuid, timestamp, date, jsonb */
    type: string;

    /** Whether field holds an array */
    is_array: number;

    /** Field is required on create */
    required: number;

    /** Default value if not provided */
    default_value: string | null;

    /** Minimum value for numeric types */
    minimum: number | null;

    /** Maximum value for numeric types */
    maximum: number | null;

    /** Regex pattern for text validation */
    pattern: string | null;

    /** Allowed values as JSON array */
    enum_values: string | null;

    /** Relationship type: 'owned' or 'referenced' */
    relationship_type: string | null;

    /** Target model for relationship */
    related_model: string | null;

    /** Target field for relationship (default: 'id') */
    related_field: string | null;

    /** Human-readable relationship name */
    relationship_name: string | null;

    /** Cascade delete to related records */
    cascade_delete: number;

    /** Related record must exist */
    required_relationship: number;

    /** Cannot change after creation */
    immutable: number;

    /** Requires sudo to modify */
    sudo: number;

    /** Unique constraint on values */
    unique_: number;

    /** Create database index */
    index_: number;

    /** Track changes in audit log */
    tracked: number;

    /** Include in full-text search */
    searchable: number;

    /** Auto-transform: lowercase, trim, uppercase */
    transform: string | null;

    /** Field description */
    description: string | null;
}

/**
 * Categorized field sets for efficient access.
 *
 * WHY lazy computation: Not all observers need all categories.
 * Computing on first access amortizes the cost.
 */
interface FieldCategories {
    /** Fields that must have a value on create */
    required: Set<string>;

    /** Fields that cannot change after creation */
    immutable: Set<string>;

    /** Fields that require elevated access */
    sudo: Set<string>;

    /** Fields that record changes in audit log */
    tracked: Set<string>;

    /** Fields with auto-transform (field_name -> transform type) */
    transforms: Map<string, string>;

    /** Fields that need validation (have constraints) */
    validation: FieldRow[];
}

// =============================================================================
// MODEL CLASS
// =============================================================================

/**
 * Model metadata wrapper with field accessors.
 *
 * TESTABILITY: Constructed from raw row data, enabling tests to create
 * models without database access.
 */
export class Model {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Field lookup map.
     *
     * WHY Map: O(1) lookup by field name.
     * INVARIANT: All keys are field_name values from fields table.
     */
    private readonly _fields: Map<string, FieldRow>;

    /**
     * Lazily computed field categories.
     *
     * WHY lazy: Avoid unnecessary computation for simple operations.
     * WHY cached: Observers may query categories multiple times.
     */
    private _categories: FieldCategories | null = null;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a Model from row data.
     *
     * WHY public constructor: ModelCache needs to construct instances.
     * In production, use ModelCache.get() instead of direct construction.
     *
     * @param row - Row from models table
     * @param fields - Rows from fields table for this model
     */
    constructor(
        public readonly row: ModelRow,
        fields: FieldRow[]
    ) {
        this._fields = new Map();
        for (const field of fields) {
            this._fields.set(field.field_name, field);
        }
    }

    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Get the unique model name.
     *
     * WHY getter: Consistent with other property accessors.
     */
    get modelName(): string {
        return this.row.model_name;
    }

    /**
     * Get the model status.
     */
    get status(): string {
        return this.row.status;
    }

    /**
     * Get the model description.
     */
    get description(): string | null {
        return this.row.description;
    }

    // =========================================================================
    // MODEL BEHAVIORAL FLAGS
    // =========================================================================

    /**
     * Is this a system model (file, folder, models, fields, etc.)?
     *
     * WHY: System models have special protection and cannot be deleted.
     */
    get isSystem(): boolean {
        return this.row.status === 'system';
    }

    /**
     * Is this model frozen (all changes prevented)?
     *
     * WHY: Frozen models are read-only. Used for archival or compliance.
     */
    get isFrozen(): boolean {
        return this.row.frozen === 1;
    }

    /**
     * Is this model immutable (no updates, only create/delete)?
     *
     * WHY: Immutable models support append-only patterns (logs, events).
     */
    get isImmutable(): boolean {
        return this.row.immutable === 1;
    }

    /**
     * Does this model require sudo for entity modifications?
     *
     * WHY: Sudo models require elevated kernel/root access.
     */
    get requiresSudo(): boolean {
        return this.row.sudo === 1;
    }

    /**
     * Is this model externally managed?
     *
     * WHY: External models reject local changes (sync from external source).
     */
    get isExternal(): boolean {
        return this.row.external === 1;
    }

    /**
     * Does this model bypass the observer pipeline?
     *
     * WHY: Passthrough is dangerous but sometimes necessary for performance.
     * Should only be used for system-level operations.
     */
    get isPassthrough(): boolean {
        return this.row.passthrough === 1;
    }

    // =========================================================================
    // FIELD ACCESS
    // =========================================================================

    /**
     * Get field by name.
     *
     * @param name - Field name
     * @returns Field row or undefined if not found
     */
    getField(name: string): FieldRow | undefined {
        return this._fields.get(name);
    }

    /**
     * Check if field exists.
     *
     * @param name - Field name
     * @returns True if field exists
     */
    hasField(name: string): boolean {
        return this._fields.has(name);
    }

    /**
     * Get all fields.
     *
     * WHY Array from values: Enables iteration and spread.
     *
     * @returns Array of all field rows
     */
    getFields(): FieldRow[] {
        return Array.from(this._fields.values());
    }

    /**
     * Get field names.
     *
     * @returns Array of field names
     */
    getFieldNames(): string[] {
        return Array.from(this._fields.keys());
    }

    /**
     * Get field count.
     */
    get fieldCount(): number {
        return this._fields.size;
    }

    // =========================================================================
    // CATEGORIZED FIELD ACCESS
    // =========================================================================

    /**
     * Get field names that are required.
     *
     * WHY Set: O(1) membership test in validation.
     */
    getRequiredFields(): Set<string> {
        return this.categorize().required;
    }

    /**
     * Get field names that are immutable.
     */
    getImmutableFields(): Set<string> {
        return this.categorize().immutable;
    }

    /**
     * Get field names that require sudo.
     */
    getSudoFields(): Set<string> {
        return this.categorize().sudo;
    }

    /**
     * Get field names that are tracked (audit log).
     */
    getTrackedFields(): Set<string> {
        return this.categorize().tracked;
    }

    /**
     * Get fields with transforms.
     *
     * @returns Map of field_name -> transform type (lowercase, trim, uppercase)
     */
    getTransformFields(): Map<string, string> {
        return this.categorize().transforms;
    }

    /**
     * Get fields that need validation.
     *
     * WHY FieldRow[]: Validation needs full field metadata, not just names.
     */
    getValidationFields(): FieldRow[] {
        return this.categorize().validation;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Lazily compute and cache field categories.
     *
     * ALGORITHM:
     * 1. Check if already computed
     * 2. If not, iterate all fields once
     * 3. Categorize each field by its flags
     * 4. Cache and return
     *
     * WHY single pass: More efficient than multiple filter() calls.
     */
    private categorize(): FieldCategories {
        if (this._categories !== null) {
            return this._categories;
        }

        const required = new Set<string>();
        const immutable = new Set<string>();
        const sudo = new Set<string>();
        const tracked = new Set<string>();
        const transforms = new Map<string, string>();
        const validation: FieldRow[] = [];

        for (const field of this._fields.values()) {
            if (field.required === 1) {
                required.add(field.field_name);
            }
            if (field.immutable === 1) {
                immutable.add(field.field_name);
            }
            if (field.sudo === 1) {
                sudo.add(field.field_name);
            }
            if (field.tracked === 1) {
                tracked.add(field.field_name);
            }
            if (field.transform) {
                transforms.set(field.field_name, field.transform);
            }

            // WHY validation check: Fields need validation if they have type
            // constraints, required flag, range limits, pattern, or enum.
            if (
                field.type !== 'text' ||
                field.required === 1 ||
                field.minimum !== null ||
                field.maximum !== null ||
                field.pattern !== null ||
                field.enum_values !== null
            ) {
                validation.push(field);
            }
        }

        this._categories = { required, immutable, sudo, tracked, transforms, validation };
        return this._categories;
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Check if categories have been computed.
     *
     * TESTING: Verify lazy computation behavior.
     */
    isCategorized(): boolean {
        return this._categories !== null;
    }
}
