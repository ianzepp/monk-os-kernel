/**
 * SQL Delete Observer (SQLite) - Ring 5 Database Transport Layer
 *
 * Handles DELETE operations for SQLite - soft delete (set trashed_at).
 * Record already has data loaded; we update timestamps and set current.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class SqlDeleteSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['delete'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly priority = 50;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const id = record.get('id');
        if (!id) {
            throw new SystemError('Delete record must have id field');
        }

        const timestamp = new Date().toISOString();

        // Soft delete: set trashed_at and updated_at
        const updateQuery = `UPDATE "${model.model_name}" SET trashed_at = $1, updated_at = $2 WHERE "id" = $3`;
        const result = await system.adapter!.query(updateQuery, [timestamp, timestamp, id]);

        if (result.rowCount === 0) {
            throw new SystemError(`Delete operation failed - record not found: ${id}`);
        }

        // Update ModelRecord with trashed state (no SELECT needed)
        const currentState = record.toObject();
        record.setCurrent({
            ...currentState,
            trashed_at: timestamp,
            updated_at: timestamp,
        });
    }
}
