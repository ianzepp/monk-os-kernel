/**
 * SQL Create Observer (SQLite) - Ring 5 Database Transport Layer
 *
 * Handles CREATE operations for SQLite - INSERT without RETURNING.
 * Since all values (id, timestamps) are generated app-side, no SELECT needed.
 *
 * SQLite differences from PostgreSQL:
 * - No RETURNING clause
 * - UUID arrays stored as JSON strings (not PostgreSQL array literals)
 * - Booleans stored as INTEGER (0/1)
 * - Timestamps stored as TEXT (ISO 8601)
 */

import crypto from 'crypto';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class SqlCreateSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['create'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly priority = 50;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const timestamp = new Date().toISOString();

        // Convert ModelRecord to plain object for SQL operations
        const plainRecord = record.toObject();

        // Set up record with required system fields (generated app-side)
        const recordWithDefaults = {
            id: plainRecord.id || crypto.randomUUID(),
            created_at: plainRecord.created_at || timestamp,
            updated_at: plainRecord.updated_at || timestamp,
            ...plainRecord,
        };

        // Process for SQLite storage (arrays→JSON, booleans→0/1)
        const processedRecord = this.processForSqlite(recordWithDefaults);

        // Build parameterized INSERT query
        const fields = Object.keys(processedRecord);
        const values = Object.values(processedRecord);
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        const fieldList = fields.map(field => `"${field}"`).join(', ');

        const insertQuery = `INSERT INTO "${model.model_name}" (${fieldList}) VALUES (${placeholders})`;

        try {
            await system.adapter!.query(insertQuery, values);
        } catch (error) {
            throw new SystemError(
                `Failed to insert record into ${model.model_name}: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        // Update ModelRecord with the values we inserted (no SELECT needed)
        record.setCurrent(recordWithDefaults);
    }

    /**
     * Process record for SQLite storage
     */
    private processForSqlite(record: any): any {
        const processed = { ...record };

        for (const [key, value] of Object.entries(processed)) {
            if (Array.isArray(value)) {
                processed[key] = JSON.stringify(value);
            } else if (typeof value === 'boolean') {
                processed[key] = value ? 1 : 0;
            } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
                // Keep Buffer/Uint8Array as-is for BLOB columns
                processed[key] = value;
            } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
                processed[key] = JSON.stringify(value);
            }
        }

        return processed;
    }
}
