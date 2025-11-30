import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * PUT /api/data/:model - Bulk update records in model
 * PATCH /api/data/:model - Filter-based update operation
 *
 * PUT: Expects array of records with IDs [{id, ...changes}]
 * PATCH + ?where={json}: Filter-based update, body is the changes object
 *
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params, query, body, method }) => {
    const { model } = params;
    let result;

    // PATCH with ?where filter = filter-based update (updateAny)
    const whereParam = query.where;
    if (method === 'PATCH' && whereParam) {
        // Body must be an object (the changes to apply)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw HttpErrors.badRequest('Request body must be an object of changes for filter-based update', 'BODY_NOT_OBJECT');
        }

        const filterData = { where: JSON.parse(whereParam) };
        result = await system.database.updateAny(model, filterData, body);
    }

    // Normal PUT: bulk update by ID
    else {
        if (!Array.isArray(body)) {
            throw HttpErrors.badRequest('Request body must be an array of records', 'BODY_NOT_ARRAY');
        }
        result = await system.database.updateAll(model, body);
    }

    return result;
});
