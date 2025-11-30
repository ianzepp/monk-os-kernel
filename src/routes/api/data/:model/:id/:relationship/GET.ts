import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/data/:model/:id/:relationship - Get related records for a parent
 * Returns array of child records that have an owned relationship to the parent record
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params }) => {
    const { model, id, relationship } = params;

    // Verify parent record data is readable
    await system.database.select404(model!, { where: { id: id! } });

    // Get relationship metadata (cached)
    const rel = await system.database.getRelationship(model!, relationship!);

    // Query child records that reference this parent
    const result = await system.database.selectAny(rel.childModel, {
        where: { [rel.fieldName]: id }
    });

    return result;
});
