/**
 * Database Type Mappings
 *
 * Maps between user-facing types, PostgreSQL types, and SQLite types.
 * Used by DDL observers and type mapper/unmapper observers.
 */

import type { DatabaseType } from './adapter.js';

/**
 * User-facing type to PostgreSQL type mapping
 */
export const USER_TO_POSTGRESQL: Record<string, string> = {
    // Scalar types
    'text': 'TEXT',
    'integer': 'INTEGER',
    'decimal': 'NUMERIC',
    'boolean': 'BOOLEAN',
    'timestamp': 'TIMESTAMP',
    'date': 'DATE',
    'uuid': 'UUID',
    'jsonb': 'JSONB',
    'binary': 'BYTEA',

    // Array types
    'text[]': 'TEXT[]',
    'integer[]': 'INTEGER[]',
    'decimal[]': 'NUMERIC[]',
    'uuid[]': 'UUID[]',
};

/**
 * User-facing type to SQLite type mapping
 *
 * SQLite has limited types - everything maps to TEXT, INTEGER, REAL, or BLOB.
 * Arrays and complex types are stored as JSON text.
 */
export const USER_TO_SQLITE: Record<string, string> = {
    // Scalar types
    'text': 'TEXT',
    'integer': 'INTEGER',
    'decimal': 'REAL',
    'boolean': 'INTEGER',      // 0 or 1
    'timestamp': 'TEXT',       // ISO 8601 string
    'date': 'TEXT',            // YYYY-MM-DD string
    'uuid': 'TEXT',            // 36-char UUID string
    'jsonb': 'TEXT',           // JSON string
    'binary': 'BLOB',          // Binary data

    // Array types (all stored as JSON text)
    'text[]': 'TEXT',
    'integer[]': 'TEXT',
    'decimal[]': 'TEXT',
    'uuid[]': 'TEXT',
};

/**
 * PostgreSQL type to user-facing type mapping (reverse mapping)
 */
export const POSTGRESQL_TO_USER: Record<string, string> = {
    'text': 'text',
    'integer': 'integer',
    'numeric': 'decimal',
    'boolean': 'boolean',
    'timestamp': 'timestamp',
    'date': 'date',
    'uuid': 'uuid',
    'jsonb': 'jsonb',
    'bytea': 'binary',
    'text[]': 'text[]',
    'integer[]': 'integer[]',
    'numeric[]': 'decimal[]',
    'uuid[]': 'uuid[]',
};

/**
 * Get the database-specific type for a user-facing type
 */
export function getDbType(userType: string, dbType: DatabaseType): string {
    const mapping = dbType === 'sqlite' ? USER_TO_SQLITE : USER_TO_POSTGRESQL;
    return mapping[userType] || 'TEXT';
}

/**
 * Get the user-facing type from a PostgreSQL type
 */
export function getUserType(pgType: string): string {
    return POSTGRESQL_TO_USER[pgType.toLowerCase()] || pgType;
}

/**
 * SQLite system table schema
 *
 * SQLite uses TEXT for UUIDs and JSON for arrays.
 * No gen_random_uuid() - IDs are generated in application layer.
 */
export const SQLITE_SYSTEM_COLUMNS = `
    "id" TEXT PRIMARY KEY,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT
`;

/**
 * PostgreSQL system table schema
 */
export const POSTGRESQL_SYSTEM_COLUMNS = `
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "access_read" UUID[] DEFAULT '{}'::UUID[],
    "access_edit" UUID[] DEFAULT '{}'::UUID[],
    "access_full" UUID[] DEFAULT '{}'::UUID[],
    "access_deny" UUID[] DEFAULT '{}'::UUID[],
    "created_at" TIMESTAMP DEFAULT now() NOT NULL,
    "updated_at" TIMESTAMP DEFAULT now() NOT NULL,
    "trashed_at" TIMESTAMP,
    "deleted_at" TIMESTAMP
`;
