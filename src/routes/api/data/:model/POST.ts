import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * POST /api/data/:model - Create or upsert multiple records in model
 *
 * Default behavior: Create new records (all must be new)
 * With ?upsert=true: Insert new records OR update existing (by ID presence)
 *
 * Passthrough mode (model.passthrough=true):
 * - Bypasses observer pipeline (rings 0-4, 6-9)
 * - Only ring 5 (database INSERT) executes
 * - Use for high-throughput data (sensors, logs, telemetry)
 *
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params, query, body }) => {
    const { model: modelName } = params;

    // Always expect array input for POST /api/data/:model
    if (!Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an array of records', 'BODY_NOT_ARRAY');
    }

    const upsert = query.upsert === 'true';
    return upsert
        ? await system.database.upsertAll(modelName, body)
        : await system.database.createAll(modelName, body);
});
