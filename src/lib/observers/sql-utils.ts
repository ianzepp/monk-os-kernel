import crypto from 'crypto';

import { SystemError } from '@src/lib/observers/errors.js';
import { convertRecordPgToMonk, convertRecordMonkToPg } from '@src/lib/field-types.js';

/**
 * SQL Observer Utilities
 *
 * Shared utilities for SQL observers including PostgreSQL type conversion,
 * JSONB field processing, UUID array handling, and database context management.
 */

export class SqlUtils {
    /**
     * Convert PostgreSQL string results back to proper JSON types
     *
     * PostgreSQL returns all values as strings by default. This method converts
     * them back to the correct JSON types based on the model field metadata.
     */
    static convertPostgreSQLTypes(record: any, model: any): any {
        if (!model.typedFields || model.typedFields.size === 0) {
            return record;
        }

        return convertRecordPgToMonk(record, model.typedFields);
    }

    /**
     * Process UUID arrays for PostgreSQL compatibility
     *
     * Converts JavaScript arrays to PostgreSQL array literals for UUID fields.
     * Automatically detects UUID array fields by checking if the field name
     * is a known UUID array field and the value is an array.
     */
    static processUuidArrays(record: any): any {
        const processed = { ...record };

        // Check each potential UUID array field
        const uuidFields = ['access_read', 'access_edit', 'access_full', 'access_deny'];

        for (const fieldName of uuidFields) {
            if (Array.isArray(processed[fieldName])) {
                // Convert JavaScript array to PostgreSQL array literal
                processed[fieldName] = `{${processed[fieldName].join(',')}}`;
            }
        }

        return processed;
    }

    /**
     * Process JSONB fields for PostgreSQL compatibility
     *
     * Converts JavaScript objects and arrays to JSON strings for JSONB fields
     * based on model field type definitions.
     */
    static processJsonbFields(record: any, model: any): any {
        if (!model.typedFields || model.typedFields.size === 0) {
            return record;
        }

        try {
            return convertRecordMonkToPg(record, model.typedFields);
        } catch (error) {
            throw new SystemError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Get database adapter for query execution
     * @deprecated This method is deprecated. Use system.adapter.query() directly instead.
     */
    static getPool(system: any): any {
        if (!system.adapter) {
            throw new SystemError('Database adapter not available - ensure operation runs within runTransaction()');
        }
        return system.adapter;
    }

    /**
     * Generate UUID for new records
     */
    static generateId(): string {
        return crypto.randomUUID();
    }
}
