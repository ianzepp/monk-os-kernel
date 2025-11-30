/**
 * SQL Access Observer - Ring 5 Database Transport Layer
 *
 * Handles ACCESS operations - direct SQL execution for updating access control lists.
 * Only modifies access_* fields (access_read, access_edit, access_full, access_deny).
 * Uses parameterized queries to prevent SQL injection vulnerabilities.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { FilterWhere } from '@src/lib/filter-where.js';

export default class SqlAccessObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['access'] as const;
    readonly adapters = ['postgresql'] as const;

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
        if (access_read !== undefined) updateFields.access_read = access_read;
        if (access_edit !== undefined) updateFields.access_edit = access_edit;
        if (access_full !== undefined) updateFields.access_full = access_full;
        if (access_deny !== undefined) updateFields.access_deny = access_deny;

        // Process UUID arrays for PostgreSQL compatibility
        const processedFields = SqlUtils.processUuidArrays(updateFields);

        const fields = Object.keys(processedFields);
        const values = Object.values(processedFields);

        if (fields.length === 0) {
            // No access fields to update - skip this record
            return;
        }

        // Always update updated_at timestamp
        fields.push('updated_at');
        values.push(new Date().toISOString());

        const setClause = fields.map((field, i) => `"${field}" = $${i + 1}`).join(', ');

        // Use FilterWhere for consistent WHERE clause generation
        const { whereClause, params: whereParams } = FilterWhere.generate(
            { id }, // WHERE conditions
            fields.length // Start WHERE parameters after SET parameters
        );

        const query = `UPDATE "${model.model_name}" SET ${setClause} WHERE ${whereClause} RETURNING *`;
        const allParams = [...values, ...whereParams];

        const result = await SqlUtils.getPool(system).query(query, allParams);
        if (result.rows.length === 0) {
            throw new SystemError(`Access update failed - record not found: ${id}`);
        }

        // Update the ModelRecord with final database state (preserves change tracking)
        const dbResult = SqlUtils.convertPostgreSQLTypes(result.rows[0], model);
        record.setCurrent(dbResult);
    }
}
