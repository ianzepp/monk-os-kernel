/**
 * Field - First-class domain object for field metadata
 *
 * Wraps raw field row data from the database with typed accessors.
 * This is a data-only class - validation logic lives in observers.
 *
 * Part of the namespace cache refactor (Phase 1).
 */

/**
 * Raw field row from database - matches fields table schema
 */
export interface FieldRow {
    // System fields
    id: string;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    deleted_at: string | null;

    // Field identity
    model_name: string;
    field_name: string;

    // Type information
    type: string;
    is_array: boolean;

    // Behavior flags
    required: boolean;
    immutable: boolean;
    sudo: boolean;
    tracked: boolean;
    unique: boolean;
    index: boolean;
    searchable: boolean;

    // Constraints
    minimum: number | null;
    maximum: number | null;
    pattern: string | null;
    enum_values: string[] | null;
    default_value: string | null;
    description: string | null;

    // Transform
    transform: string | null;

    // Relationship metadata
    relationship_type: string | null;
    related_model: string | null;
    related_field: string | null;
    relationship_name: string | null;
    cascade_delete: boolean;
    required_relationship: boolean;
}

/**
 * First-class Field domain object
 *
 * Provides typed accessors for field metadata with pre-compiled constraints.
 * Immutable after construction - all properties are readonly.
 */
export class Field {
    // Identity
    readonly id: string;
    readonly modelName: string;
    readonly fieldName: string;

    // Type information
    readonly type: string;
    readonly isArray: boolean;

    // Behavior flags
    readonly required: boolean;
    readonly immutable: boolean;
    readonly sudo: boolean;
    readonly tracked: boolean;
    readonly unique: boolean;
    readonly index: boolean;
    readonly searchable: boolean;

    // Constraints
    readonly minimum: number | undefined;
    readonly maximum: number | undefined;
    readonly pattern: RegExp | undefined;
    readonly enumValues: string[] | undefined;
    readonly defaultValue: string | undefined;
    readonly description: string | undefined;

    // Transform
    readonly transform: string | undefined;

    // Relationship metadata
    readonly relationshipType: string | undefined;
    readonly relatedModel: string | undefined;
    readonly relatedField: string | undefined;
    readonly relationshipName: string | undefined;
    readonly cascadeDelete: boolean;
    readonly requiredRelationship: boolean;

    constructor(row: FieldRow) {
        // Identity
        this.id = row.id;
        this.modelName = row.model_name;
        this.fieldName = row.field_name;

        // Type information
        this.type = row.type;
        this.isArray = row.is_array ?? false;

        // Behavior flags
        this.required = row.required ?? false;
        this.immutable = row.immutable ?? false;
        this.sudo = row.sudo ?? false;
        this.tracked = row.tracked ?? false;
        this.unique = row.unique ?? false;
        this.index = row.index ?? false;
        this.searchable = row.searchable ?? false;

        // Constraints - convert null to undefined for cleaner TypeScript
        this.minimum = row.minimum ?? undefined;
        this.maximum = row.maximum ?? undefined;
        this.enumValues = row.enum_values ?? undefined;
        this.defaultValue = row.default_value ?? undefined;
        this.description = row.description ?? undefined;

        // Pre-compile pattern to RegExp
        if (row.pattern) {
            try {
                this.pattern = new RegExp(row.pattern);
            } catch (error) {
                console.warn(`Invalid regex pattern for field ${this.modelName}.${this.fieldName}`, {
                    pattern: row.pattern,
                    error: error instanceof Error ? error.message : String(error),
                });
                this.pattern = undefined;
            }
        }

        // Transform
        this.transform = row.transform ?? undefined;

        // Relationship metadata
        this.relationshipType = row.relationship_type ?? undefined;
        this.relatedModel = row.related_model ?? undefined;
        this.relatedField = row.related_field ?? undefined;
        this.relationshipName = row.relationship_name ?? undefined;
        this.cascadeDelete = row.cascade_delete ?? false;
        this.requiredRelationship = row.required_relationship ?? false;
    }

    /**
     * Check if this field has any constraints (minimum, maximum, or pattern)
     */
    hasConstraints(): boolean {
        return this.minimum !== undefined ||
               this.maximum !== undefined ||
               this.pattern !== undefined;
    }

    /**
     * Check if this field defines a relationship
     */
    hasRelationship(): boolean {
        return this.relatedModel !== undefined &&
               this.relationshipName !== undefined;
    }

    /**
     * Check if this field has enum values defined
     */
    hasEnum(): boolean {
        return this.enumValues !== undefined && this.enumValues.length > 0;
    }

    /**
     * Check if this field has a transform defined
     */
    hasTransform(): boolean {
        return this.transform !== undefined;
    }

    /**
     * Get the full field key (model_name:field_name)
     */
    get key(): string {
        return `${this.modelName}:${this.fieldName}`;
    }

    /**
     * Get the relationship key (related_model:relationship_name)
     * Returns undefined if this is not a relationship field
     */
    get relationshipKey(): string | undefined {
        if (!this.hasRelationship()) {
            return undefined;
        }
        return `${this.relatedModel}:${this.relationshipName}`;
    }
}
