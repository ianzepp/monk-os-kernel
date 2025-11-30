import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * POST /api/data/:model/:id/:relationship - Create a new related record
 * Creates a child record with the parent relationship automatically set
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model, id, relationship } = params;

    // Verify parent record exists and is readable
    await system.database.select404(model!, { where: { id: id! } });

    // Get relationship metadata (cached)
    const rel = await system.database.getRelationship(model!, relationship!);

    // Ensure body is an object (not array)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be a single object for nested resource creation', 'INVALID_BODY_FORMAT');
    }

    // Create the child record with the parent relationship automatically set
    const recordData = {
        ...body,
        [rel.fieldName]: id // Set the foreign key to the parent record ID
    };

    const result = await system.database.createOne(rel.childModel, recordData);

    return result;
});
