/**
 * SQL Update Observer - Ring 5 Database Transport Layer
 *
 * Handles UPDATE operations - direct SQL execution for updating existing records.
 * Operates on pre-merged data from UpdateMerger observer (Ring 0).
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { FilterWhere } from '@src/lib/filter-where.js';

export default class SqlUpdateObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['update'] as const;
    readonly adapters = ['postgresql'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        // Convert ModelRecord to plain object for SQL operations
        const plainRecord = record.toObject();

        if (!plainRecord.id) {
            throw new SystemError('Update record must have id field');
        }

        const { id, ...updateFields } = plainRecord;

        // Process UUID arrays for PostgreSQL compatibility
        let processedFields = SqlUtils.processUuidArrays(updateFields);

        // Process JSONB fields (objects/arrays) for PostgreSQL serialization
        processedFields = SqlUtils.processJsonbFields(processedFields, model);

        const fields = Object.keys(processedFields);
        const values = Object.values(processedFields);

        if (fields.length === 0) {
            // No fields to update after processing - skip this record
            return;
        }

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
            throw new SystemError(`Update failed - record not found: ${id}`);
        }

        // Update the ModelRecord with final database state (preserves change tracking)
        const dbResult = SqlUtils.convertPostgreSQLTypes(result.rows[0], model);
        record.setCurrent(dbResult);
    }
}
