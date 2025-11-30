import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * UUID regex for distinguishing UUIDs from names
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/find/:model/:target - Execute a saved filter by ID or name
 *
 * The :target parameter can be:
 * - A UUID: looks up the saved filter by ID
 * - A string: looks up the saved filter by name (must be unique within model)
 *
 * The saved filter's model_name must match the :model parameter.
 *
 * @see docs/routes/FIND_API.md
 */
export default withTransaction(async ({ system, params }) => {
    const { model, target } = params;

    if (!target) {
        throw HttpErrors.badRequest('Target (ID or name) is required', 'MISSING_TARGET');
    }

    // Determine if target is UUID or name
    const isUuid = UUID_REGEX.test(target);

    // Look up the saved filter from the filters table
    const filterQuery = isUuid
        ? { where: { id: target, model_name: model } }
        : { where: { name: target, model_name: model } };

    const filters = await system.database.selectAny('filters', filterQuery, { context: 'system' });

    if (filters.length === 0) {
        throw HttpErrors.notFound(
            `Saved filter '${target}' not found for model '${model}'`,
            'FILTER_NOT_FOUND'
        );
    }

    const savedFilter = filters[0];

    // Build the query body from the saved filter fields
    const body: Record<string, any> = {};

    if (savedFilter.select) body.select = savedFilter.select;
    if (savedFilter.where) body.where = savedFilter.where;
    if (savedFilter.order) body.order = savedFilter.order;
    if (savedFilter.limit !== null && savedFilter.limit !== undefined) body.limit = savedFilter.limit;
    if (savedFilter.offset !== null && savedFilter.offset !== undefined) body.offset = savedFilter.offset;

    // Execute the query against the target model
    const result = await system.database.selectAny(model!, body);

    return result;
});
