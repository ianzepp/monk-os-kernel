/**
 * SQL Expire Observer (SQLite) - Ring 5 Database Transport Layer
 *
 * Handles EXPIRE operations for SQLite - permanent delete (set deleted_at).
 * This is irreversible - records will no longer be visible via API.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class SqlExpireSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['expire'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly priority = 50;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const id = record.get('id');
        if (!id) {
            throw new SystemError('Expire record must have id field');
        }

        const timestamp = new Date().toISOString();

        // Permanent delete: set deleted_at and updated_at
        const updateQuery = `UPDATE "${model.model_name}" SET deleted_at = $1, updated_at = $2 WHERE "id" = $3`;
        const result = await system.adapter!.query(updateQuery, [timestamp, timestamp, id]);

        if (result.rowCount === 0) {
            throw new SystemError(`Expire operation failed - record not found: ${id}`);
        }

        // Update ModelRecord with expired state (no SELECT needed)
        const currentState = record.toObject();
        record.setCurrent({
            ...currentState,
            deleted_at: timestamp,
            updated_at: timestamp,
        });
    }
}
