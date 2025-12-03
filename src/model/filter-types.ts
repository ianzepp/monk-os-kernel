/**
 * Filter Types - Query building types for DatabaseService
 *
 * Provides type definitions for the Filter system, enabling complex queries
 * with 20+ operators, logical combinations, and SQL generation.
 *
 * @module model/filter-types
 */

// =============================================================================
// FILTER OPERATORS
// =============================================================================

/**
 * Filter operators for query conditions.
 *
 * WHY enum: Provides autocomplete and type safety for operators.
 * WHY $ prefix: Distinguishes operators from field names in where clauses.
 */
export enum FilterOp {
    // -------------------------------------------------------------------------
    // Comparison Operators
    // -------------------------------------------------------------------------

    /** Equal (implicit default when value is not an object) */
    EQ = '$eq',

    /** Not equal */
    NE = '$ne',

    /** Greater than */
    GT = '$gt',

    /** Greater than or equal */
    GTE = '$gte',

    /** Less than */
    LT = '$lt',

    /** Less than or equal */
    LTE = '$lte',

    // -------------------------------------------------------------------------
    // Pattern Matching Operators
    // -------------------------------------------------------------------------

    /** SQL LIKE pattern match */
    LIKE = '$like',

    /** Case-insensitive LIKE (uses LOWER() in SQLite) */
    ILIKE = '$ilike',

    /** NOT LIKE */
    NLIKE = '$nlike',

    /** NOT case-insensitive LIKE */
    NILIKE = '$nilike',

    // -------------------------------------------------------------------------
    // Array Membership Operators
    // -------------------------------------------------------------------------

    /** Value in array: field IN (?, ?, ?) */
    IN = '$in',

    /** Value not in array: field NOT IN (?, ?, ?) */
    NIN = '$nin',

    // -------------------------------------------------------------------------
    // Logical Operators
    // -------------------------------------------------------------------------

    /** All conditions must match */
    AND = '$and',

    /** Any condition must match */
    OR = '$or',

    /** Negate condition */
    NOT = '$not',

    // -------------------------------------------------------------------------
    // Range Operators
    // -------------------------------------------------------------------------

    /** Value between two values: field BETWEEN ? AND ? */
    BETWEEN = '$between',

    // -------------------------------------------------------------------------
    // Null/Existence Operators
    // -------------------------------------------------------------------------

    /** Field is not null: field IS NOT NULL */
    EXISTS = '$exists',

    /** Field is null: field IS NULL */
    NULL = '$null',
}

// =============================================================================
// FILTER DATA TYPES
// =============================================================================

/**
 * Where condition value - can be a primitive or operator object.
 *
 * Examples:
 * - `'active'` → implicit $eq
 * - `{ $gte: 18 }` → explicit operator
 * - `{ $in: ['a', 'b'] }` → array membership
 */
export type WhereValue =
    | string
    | number
    | boolean
    | null
    | { [K in FilterOp]?: unknown };

/**
 * Where conditions - field to value/operator mapping.
 *
 * Examples:
 * - `{ status: 'active' }` → status = 'active'
 * - `{ age: { $gte: 18 } }` → age >= 18
 * - `{ $or: [{ a: 1 }, { b: 2 }] }` → (a = 1 OR b = 2)
 */
export interface WhereConditions {
    [field: string]: WhereValue | WhereConditions[] | undefined;
}

/**
 * Order specification for sorting results.
 */
export interface OrderSpec {
    /** Field to sort by */
    field: string;

    /** Sort direction */
    sort: 'asc' | 'desc';
}

/**
 * Complete filter data for queries.
 *
 * WHY separate interface: Provides clear contract for query building.
 * All fields are optional - empty FilterData returns all records.
 */
export interface FilterData {
    /** WHERE conditions */
    where?: WhereConditions;

    /** ORDER BY clauses */
    order?: OrderSpec | OrderSpec[] | string | string[];

    /** Maximum records to return */
    limit?: number;

    /** Records to skip */
    offset?: number;

    /** Fields to select (default: all) */
    select?: string[];
}

// =============================================================================
// SELECT OPTIONS
// =============================================================================

/**
 * Soft-delete filtering options.
 */
export type TrashedOption = 'exclude' | 'include' | 'only';

/**
 * Options for select operations.
 */
export interface SelectOptions {
    /** How to handle soft-deleted records (default: 'exclude') */
    trashed?: TrashedOption;
}

// =============================================================================
// INPUT TYPES
// =============================================================================

/**
 * Input for create operations - data without system fields.
 */
export type CreateInput<T> = Omit<
    T,
    'id' | 'created_at' | 'updated_at' | 'trashed_at' | 'expired_at'
> &
    Partial<Pick<T, 'id' extends keyof T ? 'id' : never>>;

/**
 * Input for update operations with explicit id and changes.
 */
export interface UpdateInput<T> {
    /** Record ID */
    id: string;

    /** Fields to update */
    changes: Partial<T>;
}

/**
 * Input for delete/revert operations - just the id.
 */
export interface DeleteInput {
    /** Record ID */
    id: string;
}

/**
 * Alias for delete input.
 */
export type RevertInput = DeleteInput;

// =============================================================================
// SQL GENERATION TYPES
// =============================================================================

/**
 * Generated SQL with parameters.
 */
export interface SqlResult {
    /** SQL query string with ? placeholders */
    sql: string;

    /** Parameter values in order */
    params: unknown[];
}

/**
 * Generated WHERE clause with parameters.
 */
export interface WhereResult {
    /** WHERE clause (without 'WHERE' keyword) */
    clause: string;

    /** Parameter values in order */
    params: unknown[];
}
