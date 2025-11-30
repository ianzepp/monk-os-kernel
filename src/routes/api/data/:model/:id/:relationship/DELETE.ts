import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * DELETE /api/data/:model/:id/:relationship - Delete all related records
 * Deletes all child records belonging to the parent relationship
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params }) => {
    const { model, id, relationship } = params;

    // Verify parent record data is readable
    await system.database.select404(model!, { where: { id: id! } });

    // Get relationship metadata (cached)
    const rel = await system.database.getRelationship(model!, relationship!);

    // Delete all child records belonging to this parent
    const result = await system.database.deleteAny(rel.childModel, {
        where: { [rel.fieldName]: id }
    });

    return result;
});
