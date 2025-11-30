import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * GET /api/aggregate/:model - Shorthand aggregation queries
 *
 * Supports simple aggregations via query parameters:
 * - ?count - Count all records
 * - ?sum=field - Sum of field values
 * - ?avg=field - Average of field values
 * - ?min=field - Minimum field value
 * - ?max=field - Maximum field value
 *
 * Combine with ?where={json} for filtering.
 *
 * For complex aggregations (multiple functions, GROUP BY), use POST.
 *
 * @see docs/routes/AGGREGATE_API.md
 */
export default withTransaction(async ({ system, params, query }) => {
    const { model } = params;

    // Parse shorthand aggregation params
    const countParam = query.count;
    const sumParam = query.sum;
    const avgParam = query.avg;
    const minParam = query.min;
    const maxParam = query.max;

    // Build aggregate spec from query params
    const aggregate: Record<string, any> = {};

    // ?count (presence check - value doesn't matter)
    if (countParam !== undefined) {
        aggregate.count = { $count: '*' };
    }

    // ?sum=field
    if (sumParam) {
        aggregate.sum = { $sum: sumParam };
    }

    // ?avg=field
    if (avgParam) {
        aggregate.avg = { $avg: avgParam };
    }

    // ?min=field
    if (minParam) {
        aggregate.min = { $min: minParam };
    }

    // ?max=field
    if (maxParam) {
        aggregate.max = { $max: maxParam };
    }

    // Require at least one aggregation
    if (Object.keys(aggregate).length === 0) {
        throw HttpErrors.badRequest(
            'At least one aggregation parameter required: count, sum, avg, min, max',
            'MISSING_AGGREGATION'
        );
    }

    // Parse optional where filter
    const whereParam = query.where;
    const where = whereParam ? JSON.parse(whereParam) : undefined;

    // Build body for database.aggregate()
    const body = {
        aggregate,
        ...(where && { where })
    };

    const result = await system.database.aggregate(model!, body);

    return result;
});
