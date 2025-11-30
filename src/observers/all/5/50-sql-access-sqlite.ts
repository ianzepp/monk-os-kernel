/**
 * SQL Access Observer (SQLite) - Ring 5 Database Transport Layer
 *
 * Handles ACCESS operations for SQLite - updating ACL fields.
 * ACLs are stored as JSON arrays in SQLite (not PostgreSQL uuid[]).
 *
 * Note: ACL-based queries ($any, $all, etc.) are not supported on SQLite.
 * SQLite tenants operate in "root mode" where ACLs are stored but not enforced.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class SqlAccessSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['access'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly priority = 50;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        // Convert ModelRecord to plain object for SQL operations
        const plainRecord = record.toObject();

        if (!plainRecord.id) {
            throw new SystemError('Access record must have id field');
        }

        // Extract ID and access fields
        const { id, access_read, access_edit, access_full, access_deny } = plainRecord;

        // Build UPDATE SET clause only for provided access fields
        const updateFields: Record<string, any> = {};
        if (access_read !== undefined) updateFields.access_read = JSON.stringify(access_read);
        if (access_edit !== undefined) updateFields.access_edit = JSON.stringify(access_edit);
        if (access_full !== undefined) updateFields.access_full = JSON.stringify(access_full);
        if (access_deny !== undefined) updateFields.access_deny = JSON.stringify(access_deny);

        const fields = Object.keys(updateFields);
        const values = Object.values(updateFields);

        if (fields.length === 0) {
            return;
        }

        // Always update updated_at timestamp
        const timestamp = new Date().toISOString();
        fields.push('updated_at');
        values.push(timestamp);

        const setClause = fields.map((field, i) => `"${field}" = $${i + 1}`).join(', ');
        const whereParamIndex = fields.length + 1;

        const updateQuery = `UPDATE "${model.model_name}" SET ${setClause} WHERE "id" = $${whereParamIndex}`;
        const allParams = [...values, id];

        const result = await system.adapter!.query(updateQuery, allParams);

        if (result.rowCount === 0) {
            throw new SystemError(`Access update failed - record not found: ${id}`);
        }

        // Update ModelRecord with new ACL state (no SELECT needed)
        record.setCurrent({
            ...plainRecord,
            updated_at: timestamp,
        });
    }
}
