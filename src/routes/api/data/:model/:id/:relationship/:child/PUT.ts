import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * PUT /api/data/:model/:id/:relationship/:child - Update specific related record
 * Updates a single child record, verifying both parent accessibility and child ownership
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model, id, relationship, child } = params;

    // Verify parent record data is readable
    await system.database.select404(model!, { where: { id: id! } });

    // Get relationship metadata (cached)
    const rel = await system.database.getRelationship(model!, relationship!);

    // Ensure body is an object (not array)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be a single object for nested resource update', 'INVALID_BODY_FORMAT');
    }

    // Prepare update data, ensuring the foreign key is preserved
    const updateData = {
        ...body,
        [rel.fieldName]: id // Ensure foreign key remains linked to parent
    };

    // Update the child record, verifying it exists and belongs to this parent
    const result = await system.database.update404(rel.childModel, {
        where: {
            id: child!,
            [rel.fieldName]: id // Ensure child belongs to this parent
        }
    }, updateData);

    return result;
});
