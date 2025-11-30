/**
 * Field Type Utilities
 *
 * Centralized type definitions and conversion utilities for Monk field types.
 * Handles bidirectional conversion between PostgreSQL wire format and JavaScript/Monk types.
 */


/**
 * PostgreSQL field types (as stored in database)
 */
export const PG_TYPES = {
    TEXT: 'text',
    INTEGER: 'integer',
    BIGSERIAL: 'bigserial',
    NUMERIC: 'numeric',
    BOOLEAN: 'boolean',
    JSONB: 'jsonb',
    UUID: 'uuid',
    TIMESTAMP: 'timestamp',
    DATE: 'date',
    BYTEA: 'bytea',
    TEXT_ARRAY: 'text[]',
    INTEGER_ARRAY: 'integer[]',
    NUMERIC_ARRAY: 'numeric[]',
    UUID_ARRAY: 'uuid[]',
} as const;

/**
 * User-facing type names (used in Describe API)
 */
export const USER_TYPES = {
    TEXT: 'text',
    INTEGER: 'integer',
    DECIMAL: 'decimal',        // Maps to numeric in PostgreSQL
    BOOLEAN: 'boolean',
    TIMESTAMP: 'timestamp',
    DATE: 'date',
    UUID: 'uuid',
    JSONB: 'jsonb',
    BINARY: 'binary',          // Binary data (maps to bytea in PostgreSQL)
    TEXT_ARRAY: 'text[]',
    INTEGER_ARRAY: 'integer[]',
    DECIMAL_ARRAY: 'decimal[]', // Maps to numeric[] in PostgreSQL
    UUID_ARRAY: 'uuid[]',
} as const;

/**
 * Map user-facing type names to PostgreSQL types
 */
export const USER_TO_PG_TYPE_MAP: Record<string, string> = {
    'text': PG_TYPES.TEXT,
    'integer': PG_TYPES.INTEGER,
    'bigserial': PG_TYPES.BIGSERIAL,  // Accept bigserial (maps to itself)
    'decimal': PG_TYPES.NUMERIC,
    'numeric': PG_TYPES.NUMERIC,  // Accept numeric (already PostgreSQL form)
    'boolean': PG_TYPES.BOOLEAN,
    'timestamp': PG_TYPES.TIMESTAMP,
    'date': PG_TYPES.DATE,
    'uuid': PG_TYPES.UUID,
    'jsonb': PG_TYPES.JSONB,
    'binary': PG_TYPES.BYTEA,
    'text[]': PG_TYPES.TEXT_ARRAY,
    'integer[]': PG_TYPES.INTEGER_ARRAY,
    'decimal[]': PG_TYPES.NUMERIC_ARRAY,
    'numeric[]': PG_TYPES.NUMERIC_ARRAY,  // Accept numeric[] (already PostgreSQL form)
    'uuid[]': PG_TYPES.UUID_ARRAY,
} as const;

/**
 * Map PostgreSQL types back to user-facing type names
 */
export const PG_TO_USER_TYPE_MAP: Record<string, string> = {
    'text': USER_TYPES.TEXT,
    'integer': USER_TYPES.INTEGER,
    'bigserial': USER_TYPES.INTEGER,  // bigserial is presented as integer to users
    'numeric': USER_TYPES.DECIMAL,
    'boolean': USER_TYPES.BOOLEAN,
    'timestamp': USER_TYPES.TIMESTAMP,
    'date': USER_TYPES.DATE,
    'uuid': USER_TYPES.UUID,
    'jsonb': USER_TYPES.JSONB,
    'bytea': USER_TYPES.BINARY,
    'text[]': USER_TYPES.TEXT_ARRAY,
    'integer[]': USER_TYPES.INTEGER_ARRAY,
    'numeric[]': USER_TYPES.DECIMAL_ARRAY,
    'uuid[]': USER_TYPES.UUID_ARRAY,
} as const;

/**
 * All valid user-facing type names
 */
export const VALID_USER_TYPES = Object.keys(USER_TO_PG_TYPE_MAP);

/**
 * All valid PostgreSQL field types
 */
export const VALID_PG_TYPES = Object.values(PG_TYPES);

/**
 * Convert PostgreSQL wire format value to JavaScript/Monk type
 *
 * PostgreSQL returns many values as strings. This converts them to proper
 * JavaScript types based on the field type.
 *
 * @param value - The value from PostgreSQL
 * @param fieldType - The PostgreSQL field type (text, integer, numeric, boolean, jsonb, etc.)
 * @returns Converted value in proper JavaScript type
 */
export function convertFieldPgToMonk(value: any, fieldType: string): any {
    // Null/undefined passes through unchanged
    if (value === null || value === undefined) {
        return value;
    }

    switch (fieldType) {
        case PG_TYPES.INTEGER:
        case PG_TYPES.BIGSERIAL:
        case PG_TYPES.NUMERIC:
            // Convert string numbers to JavaScript numbers
            if (typeof value === 'string') {
                return Number(value);
            }
            return value;

        case PG_TYPES.BOOLEAN:
            // Convert string booleans to JavaScript booleans
            if (typeof value === 'string') {
                return value === 'true';
            }
            return value;

        case PG_TYPES.JSONB:
            // JSONB fields: PostgreSQL usually returns these already parsed
            // but in some cases they might come back as strings
            if (typeof value === 'string') {
                try {
                    return JSON.parse(value);
                } catch (error) {
                    console.warn('Failed to parse JSONB field', {
                        value,
                        fieldType,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return value; // Return as-is if parsing fails
                }
            }
            return value;

        // Other types remain as-is (text, uuid, timestamp, date, arrays)
        default:
            return value;
    }
}

/**
 * Convert JavaScript/Monk value to PostgreSQL wire format
 *
 * Prepares JavaScript values for insertion/update in PostgreSQL.
 * Primarily handles JSONB serialization.
 *
 * @param value - The JavaScript value to convert
 * @param fieldType - The PostgreSQL field type (text, integer, numeric, boolean, jsonb, etc.)
 * @returns Value formatted for PostgreSQL
 * @throws Error if JSONB serialization fails
 */
export function convertFieldMonkToPg(value: any, fieldType: string): any {
    // Null/undefined passes through unchanged
    if (value === null || value === undefined) {
        return value;
    }

    switch (fieldType) {
        case PG_TYPES.JSONB:
            // JSONB fields need to be JSON strings (unless already a string)
            if (typeof value !== 'string') {
                try {
                    return JSON.stringify(value);
                } catch (error) {
                    throw new Error(`Failed to serialize JSONB value: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            return value;

        // All other types can be passed through as-is
        // PostgreSQL will handle the conversion
        default:
            return value;
    }
}

/**
 * Convert a full record from PostgreSQL format to Monk format
 *
 * @param record - Record with PostgreSQL values
 * @param typedFields - Map of field names to their type info
 * @returns Record with converted values
 */
export function convertRecordPgToMonk(
    record: Record<string, any>,
    typedFields: Map<string, { type: string; is_array: boolean }>
): Record<string, any> {
    const converted: Record<string, any> = { ...record };

    for (const [fieldName, typeInfo] of typedFields.entries()) {
        if (fieldName in converted) {
            converted[fieldName] = convertFieldPgToMonk(converted[fieldName], typeInfo.type);
        }
    }

    return converted;
}

/**
 * Convert a full record from Monk format to PostgreSQL format
 *
 * @param record - Record with JavaScript values
 * @param typedFields - Map of field names to their type info
 * @returns Record with converted values
 */
export function convertRecordMonkToPg(
    record: Record<string, any>,
    typedFields: Map<string, { type: string; is_array: boolean }>
): Record<string, any> {
    const converted: Record<string, any> = { ...record };

    for (const [fieldName, typeInfo] of typedFields.entries()) {
        if (fieldName in converted) {
            converted[fieldName] = convertFieldMonkToPg(converted[fieldName], typeInfo.type);
        }
    }

    return converted;
}

/**
 * FieldTypeMapper - Converts field type names between user-facing and PostgreSQL formats
 *
 * This class provides static methods for bidirectional type name conversion:
 * - toPg(): Converts user-facing type names (e.g., "decimal") to PostgreSQL types (e.g., "numeric")
 * - toUser(): Converts PostgreSQL type names back to user-facing types
 *
 * Used by:
 * - Ring 4 type-mapper observer (before database writes)
 * - Ring 6 type-unmapper observer (after database reads)
 * - Database.selectAny() for fields model
 */
export class FieldTypeMapper {
    /**
     * Convert user-facing type name to PostgreSQL type
     *
     * @param userType - User-facing type (e.g., "decimal", "text", "uuid[]")
     * @returns PostgreSQL type (e.g., "numeric", "text", "uuid[]") or undefined if invalid
     */
    static toPg(userType: string): string | undefined {
        return USER_TO_PG_TYPE_MAP[userType];
    }

    /**
     * Convert PostgreSQL type name to user-facing type
     *
     * @param pgType - PostgreSQL type (e.g., "numeric", "text", "uuid[]")
     * @returns User-facing type (e.g., "decimal", "text", "uuid[]") or undefined if unknown
     */
    static toUser(pgType: string): string | undefined {
        return PG_TO_USER_TYPE_MAP[pgType];
    }

    /**
     * Check if a type name is a valid user-facing type
     */
    static isValidUserType(type: string): boolean {
        return type in USER_TO_PG_TYPE_MAP;
    }

    /**
     * Check if a type name is a valid PostgreSQL type
     */
    static isValidPgType(type: string): boolean {
        return type in PG_TO_USER_TYPE_MAP;
    }
}
