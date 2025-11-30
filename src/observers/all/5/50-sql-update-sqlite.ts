/**
 * SQL Update Observer (SQLite) - Ring 5 Database Transport Layer
 *
 * Handles UPDATE operations for SQLite - UPDATE without RETURNING.
 * Record already has original data loaded; we merge updates and set current.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class SqlUpdateSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['update'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly priority = 50;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        // Convert ModelRecord to plain object for SQL operations
        const plainRecord = record.toObject();

        if (!plainRecord.id) {
            throw new SystemError('Update record must have id field');
        }

        const { id, ...updateFields } = plainRecord;

        // Process for SQLite storage
        const processedFields = this.processForSqlite(updateFields);

        const fields = Object.keys(processedFields);
        const values = Object.values(processedFields);

        if (fields.length === 0) {
            return;
        }

        const setClause = fields.map((field, i) => `"${field}" = $${i + 1}`).join(', ');
        const whereParamIndex = fields.length + 1;

        const updateQuery = `UPDATE "${model.model_name}" SET ${setClause} WHERE "id" = $${whereParamIndex}`;
        const allParams = [...values, id];

        const result = await system.adapter!.query(updateQuery, allParams);

        if (result.rowCount === 0) {
            throw new SystemError(`Update failed - record not found: ${id}`);
        }

        // Update ModelRecord with merged state (no SELECT needed)
        // Original data + updates = final state
        record.setCurrent(plainRecord);
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
