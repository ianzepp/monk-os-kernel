/**
 * DDL Update Observer (SQLite) - Ring 6 PostDatabase
 *
 * Handles model updates in ring 6. Model updates only affect metadata,
 * not table structure. This is essentially a no-op.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';

export default class ModelDdlUpdateSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['update'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly models = ['models'] as const;
    readonly priority = 10;

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { model_name, external } = record;

        // Skip DDL operations for external models (managed elsewhere)
        if (external === true) {
            console.info(`Skipping DDL operation for external model: ${model_name}`);
            return;
        }

        // Model updates don't require DDL changes
        // Table structure changes happen via field operations
        console.info(`Model update (no DDL needed): ${model_name}`);
    }
}
