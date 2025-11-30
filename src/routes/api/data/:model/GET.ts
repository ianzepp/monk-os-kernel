import { withSearchPath } from '@src/lib/api-helpers.js';

/**
 * GET /api/data/:model - List all records in model
 *
 * Supports streaming via Accept header:
 * - Accept: application/json (default) - Returns JSON envelope with data array
 * - Accept: application/x-ndjson - Streams records as newline-delimited JSON
 *
 * Uses withSearchPath (not withTransaction) because:
 * - This is a read-only operation (SELECT only)
 * - Streaming requires holding connection open during response
 * - No COMMIT needed for reads (transaction scopes SET LOCAL search_path only)
 *
 * For filtered queries, use POST /api/find/:model
 * For count operations, use POST /api/aggregate/:model
 *
 * @see docs/routes/DATA_API.md
 */
export default withSearchPath(async ({ system, params }) => {
    const { model } = params;

    // Return async generator - middleware handles streaming vs collection
    // based on client's Accept header
    return system.database.streamAny(model);
});
