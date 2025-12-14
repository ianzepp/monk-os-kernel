/**
 * DatabaseDialect - Abstracts SQL syntax and type conversion differences
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DatabaseDialect provides a unified interface for generating SQL and converting
 * values between JavaScript and database-native formats. This enables Ring 5/6
 * observers to work with both SQLite and PostgreSQL without dialect-specific code.
 *
 * RESPONSIBILITIES:
 * - SQL syntax generation (placeholders, transactions, DDL)
 * - Type mapping (field types to SQL types)
 * - Value conversion (JS values to/from DB-native format)
 * - Array handling (native arrays vs JSON serialization)
 *
 * DIALECT DIFFERENCES
 * ===================
 * | Feature          | SQLite                    | PostgreSQL               |
 * |------------------|---------------------------|--------------------------|
 * | Placeholders     | ? (positional)            | $1, $2 (numbered)        |
 * | Begin TX         | BEGIN IMMEDIATE           | BEGIN                    |
 * | Boolean          | INTEGER (0/1)             | BOOLEAN                  |
 * | Timestamp        | TEXT (ISO 8601)           | TIMESTAMPTZ              |
 * | JSON             | TEXT (serialized)         | JSONB                    |
 * | Arrays           | TEXT (JSON serialized)    | Native arrays (TEXT[])   |
 * | UUID generation  | lower(hex(randomblob(16)))| gen_random_uuid()::text  |
 *
 * USAGE
 * =====
 * ```typescript
 * // Get dialect from database connection
 * const dialect = getDialect(db.dialect);
 *
 * // Generate placeholder SQL
 * const placeholders = dialect.placeholders(3); // "?, ?, ?" or "$1, $2, $3"
 *
 * // Convert value for INSERT
 * const dbValue = dialect.toDatabase(true, 'boolean'); // 1 or true
 *
 * // Convert value from SELECT
 * const jsValue = dialect.fromDatabase(1, 'boolean'); // true
 * ```
 *
 * @module ems/dialect
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Supported database dialects.
 */
export type DialectName = 'sqlite' | 'postgres';

/**
 * Abstract field types used in the EMS.
 *
 * These are the logical types stored in the `fields.type` column.
 * Each dialect maps these to appropriate SQL types.
 */
export type FieldType =
    | 'text'
    | 'integer'
    | 'numeric'
    | 'boolean'
    | 'timestamp'
    | 'date'
    | 'uuid'
    | 'jsonb'
    | 'binary'
    | 'text[]'
    | 'uuid[]'
    | 'integer[]'
    | 'boolean[]'
    | 'jsonb[]';

// =============================================================================
// DIALECT INTERFACE
// =============================================================================

/**
 * Database dialect abstraction.
 *
 * Provides methods for generating dialect-specific SQL and converting values
 * between JavaScript and database-native formats.
 */
export interface DatabaseDialect {
    /**
     * Dialect name.
     */
    readonly name: DialectName;

    // =========================================================================
    // SQL SYNTAX
    // =========================================================================

    /**
     * Generate placeholder for parameterized query.
     *
     * @param index - 1-based parameter index
     * @returns Placeholder string ("?" or "$N")
     */
    placeholder(index: number): string;

    /**
     * Generate placeholders for N parameters.
     *
     * @param count - Number of placeholders
     * @returns Comma-separated placeholders ("?, ?, ?" or "$1, $2, $3")
     */
    placeholders(count: number): string;

    /**
     * Transaction start statement.
     *
     * @returns SQL statement to begin transaction
     */
    beginTransaction(): string;

    /**
     * Convert model name to safe table name.
     *
     * Model names like 'llm.provider' become 'llm_provider' because
     * SQLite/PostgreSQL interpret 'db.table' as attached database syntax.
     *
     * @param modelName - Model name (may contain dots)
     * @returns Safe table name (dots replaced with underscores)
     */
    tableName(modelName: string): string;

    /**
     * Generate CREATE TABLE for a model with standard columns.
     *
     * Standard columns: id, created_at, updated_at, trashed_at, expired_at
     *
     * @param tableName - Table name (dots already converted to underscores)
     * @returns CREATE TABLE SQL statement
     */
    createTable(tableName: string): string;

    /**
     * Generate ALTER TABLE ADD COLUMN.
     *
     * @param tableName - Table name
     * @param columnName - Column name to add
     * @param fieldType - Abstract field type
     * @returns ALTER TABLE SQL statement
     */
    addColumn(tableName: string, columnName: string, fieldType: string): string;

    // =========================================================================
    // TYPE MAPPING
    // =========================================================================

    /**
     * Map abstract field type to SQL column type.
     *
     * @param fieldType - Abstract field type (e.g., 'boolean', 'text[]')
     * @returns SQL type string (e.g., 'INTEGER', 'BOOLEAN', 'TEXT[]')
     */
    sqlType(fieldType: string): string;

    /**
     * Check if field type is an array type.
     *
     * @param fieldType - Abstract field type
     * @returns True if array type (ends with [])
     */
    isArrayType(fieldType: string): boolean;

    /**
     * Get base type from array type.
     *
     * @param fieldType - Array field type (e.g., 'text[]')
     * @returns Base type (e.g., 'text')
     */
    baseType(fieldType: string): string;

    // =========================================================================
    // VALUE CONVERSION
    // =========================================================================

    /**
     * Convert JavaScript value to database-native format for INSERT/UPDATE.
     *
     * @param value - JavaScript value
     * @param fieldType - Abstract field type
     * @returns Database-native value
     */
    toDatabase(value: unknown, fieldType: string): unknown;

    /**
     * Convert database value to JavaScript format after SELECT.
     *
     * @param value - Database value
     * @param fieldType - Abstract field type
     * @returns JavaScript value
     */
    fromDatabase(value: unknown, fieldType: string): unknown;

    // =========================================================================
    // QUERY HELPERS
    // =========================================================================

    /**
     * Generate SQL for "value in array column" check.
     *
     * @param column - Array column name
     * @param placeholderIndex - 1-based placeholder index for the value
     * @returns SQL expression
     */
    arrayContains(column: string, placeholderIndex: number): string;
}

// =============================================================================
// SQLITE DIALECT
// =============================================================================

/**
 * SQLite dialect implementation.
 *
 * SQLite has flexible typing (type affinity) and stores:
 * - Booleans as INTEGER (0/1)
 * - Timestamps as TEXT (ISO 8601)
 * - JSON as TEXT (serialized)
 * - Arrays as TEXT (JSON serialized)
 */
export class SqliteDialect implements DatabaseDialect {
    readonly name = 'sqlite' as const;

    // =========================================================================
    // SQL SYNTAX
    // =========================================================================

    placeholder(_index: number): string {
        return '?';
    }

    placeholders(count: number): string {
        return Array(count).fill('?').join(', ');
    }

    beginTransaction(): string {
        return 'BEGIN IMMEDIATE';
    }

    tableName(modelName: string): string {
        return modelName.replace(/\./g, '_');
    }

    createTable(tableName: string): string {
        // WHY replace dots: SQLite interprets 'db.table' as attached database
        // Model names like 'llm.provider' become table 'llm_provider'
        const safeTableName = this.tableName(tableName);

        return `
            CREATE TABLE IF NOT EXISTS ${safeTableName} (
                id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now')),
                trashed_at  TEXT,
                expired_at  TEXT
            )
        `;
    }

    addColumn(tableName: string, columnName: string, fieldType: string): string {
        const safeTableName = this.tableName(tableName);

        return `ALTER TABLE ${safeTableName} ADD COLUMN ${columnName} ${this.sqlType(fieldType)}`;
    }

    // =========================================================================
    // TYPE MAPPING
    // =========================================================================

    sqlType(fieldType: string): string {
        // Arrays stored as JSON text
        if (this.isArrayType(fieldType)) {
            return 'TEXT';
        }

        switch (fieldType) {
            case 'integer':
            case 'boolean':
                return 'INTEGER';
            case 'numeric':
                return 'REAL';
            case 'binary':
                return 'BLOB';
            case 'text':
            case 'uuid':
            case 'timestamp':
            case 'date':
            case 'jsonb':
            default:
                return 'TEXT';
        }
    }

    isArrayType(fieldType: string): boolean {
        return fieldType.endsWith('[]');
    }

    baseType(fieldType: string): string {
        return fieldType.replace(/\[\]$/, '');
    }

    // =========================================================================
    // VALUE CONVERSION
    // =========================================================================

    toDatabase(value: unknown, fieldType: string): unknown {
        if (value === null || value === undefined) {
            return null;
        }

        // Arrays -> JSON string
        if (this.isArrayType(fieldType)) {
            if (!Array.isArray(value)) {
                return JSON.stringify([value]);
            }

            return JSON.stringify(value);
        }

        switch (fieldType) {
            case 'boolean':
                return value ? 1 : 0;

            case 'jsonb':
                return typeof value === 'string' ? value : JSON.stringify(value);

            case 'timestamp':
            case 'date':
                if (value instanceof Date) {
                    return value.toISOString();
                }

                return value;

            default:
                return value;
        }
    }

    fromDatabase(value: unknown, fieldType: string): unknown {
        if (value === null || value === undefined) {
            return null;
        }

        // JSON string -> Array
        if (this.isArrayType(fieldType)) {
            if (typeof value === 'string') {
                try {
                    const parsed = JSON.parse(value);

                    return Array.isArray(parsed) ? parsed : [parsed];
                }
                catch {
                    return [value];
                }
            }

            return Array.isArray(value) ? value : [value];
        }

        switch (fieldType) {
            case 'boolean':
                return value === 1 || value === '1' || value === true;

            case 'integer':
                return typeof value === 'string' ? parseInt(value, 10) : value;

            case 'numeric':
                return typeof value === 'string' ? parseFloat(value) : value;

            case 'jsonb':
                if (typeof value === 'string') {
                    try {
                        return JSON.parse(value);
                    }
                    catch {
                        return value;
                    }
                }

                return value;

            default:
                return value;
        }
    }

    // =========================================================================
    // QUERY HELPERS
    // =========================================================================

    arrayContains(column: string, _placeholderIndex: number): string {
        // SQLite: check if value exists in JSON array via json_each
        return `? IN (SELECT value FROM json_each(${column}))`;
    }
}

// =============================================================================
// POSTGRES DIALECT
// =============================================================================

/**
 * PostgreSQL dialect implementation.
 *
 * PostgreSQL has strict typing with native support for:
 * - BOOLEAN for true/false
 * - TIMESTAMPTZ for timezone-aware timestamps
 * - JSONB for binary JSON with indexing
 * - Native arrays (TEXT[], INTEGER[], etc.)
 */
export class PostgresDialect implements DatabaseDialect {
    readonly name = 'postgres' as const;

    // =========================================================================
    // SQL SYNTAX
    // =========================================================================

    placeholder(index: number): string {
        return `$${index}`;
    }

    placeholders(count: number): string {
        return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');
    }

    beginTransaction(): string {
        return 'BEGIN';
    }

    tableName(modelName: string): string {
        return modelName.replace(/\./g, '_');
    }

    createTable(tableName: string): string {
        // WHY replace dots: Model names like 'llm.provider' become table 'llm_provider'
        const safeTableName = this.tableName(tableName);

        return `
            CREATE TABLE IF NOT EXISTS ${safeTableName} (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                created_at  TIMESTAMPTZ DEFAULT now(),
                updated_at  TIMESTAMPTZ DEFAULT now(),
                trashed_at  TIMESTAMPTZ,
                expired_at  TIMESTAMPTZ
            )
        `;
    }

    addColumn(tableName: string, columnName: string, fieldType: string): string {
        const safeTableName = this.tableName(tableName);

        return `ALTER TABLE ${safeTableName} ADD COLUMN ${columnName} ${this.sqlType(fieldType)}`;
    }

    // =========================================================================
    // TYPE MAPPING
    // =========================================================================

    sqlType(fieldType: string): string {
        if (this.isArrayType(fieldType)) {
            const base = this.sqlType(this.baseType(fieldType));

            return `${base}[]`;
        }

        switch (fieldType) {
            case 'integer':
                return 'INTEGER';
            case 'numeric':
                return 'NUMERIC';
            case 'boolean':
                return 'BOOLEAN';
            case 'binary':
                return 'BYTEA';
            case 'timestamp':
                return 'TIMESTAMPTZ';
            case 'date':
                return 'DATE';
            case 'jsonb':
                return 'JSONB';
            case 'text':
            case 'uuid':
            default:
                return 'TEXT';
        }
    }

    isArrayType(fieldType: string): boolean {
        return fieldType.endsWith('[]');
    }

    baseType(fieldType: string): string {
        return fieldType.replace(/\[\]$/, '');
    }

    // =========================================================================
    // VALUE CONVERSION
    // =========================================================================

    toDatabase(value: unknown, fieldType: string): unknown {
        if (value === null || value === undefined) {
            return null;
        }

        // PostgreSQL drivers accept JS arrays directly for array columns
        if (this.isArrayType(fieldType)) {
            if (!Array.isArray(value)) {
                return [value];
            }

            return value;
        }

        // PostgreSQL drivers handle most conversions natively
        // JSONB accepts objects, booleans are native, timestamps work
        return value;
    }

    fromDatabase(value: unknown, fieldType: string): unknown {
        // PostgreSQL drivers return native JS types - minimal conversion needed
        if (value === null || value === undefined) {
            return null;
        }

        return value;
    }

    // =========================================================================
    // QUERY HELPERS
    // =========================================================================

    arrayContains(column: string, placeholderIndex: number): string {
        // PostgreSQL: use ANY operator for array membership
        return `$${placeholderIndex} = ANY(${column})`;
    }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Cached dialect instances.
 *
 * WHY: Dialects are stateless, reuse single instance per dialect.
 */
const dialects: Record<DialectName, DatabaseDialect> = {
    sqlite: new SqliteDialect(),
    postgres: new PostgresDialect(),
};

/**
 * Get dialect instance by name.
 *
 * @param name - Dialect name ('sqlite' or 'postgres')
 * @returns Dialect instance
 */
export function getDialect(name: DialectName): DatabaseDialect {
    return dialects[name];
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default { SqliteDialect, PostgresDialect, getDialect };
