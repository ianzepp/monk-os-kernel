import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/data/:model/:id/:relationship/:child - Get specific related record
 * Returns a single child record, verifying both parent and child accessibility
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params }) => {
    const { model, id, relationship, child } = params;

    // Verify parent record data is readable
    await system.database.select404(model!, { where: { id: id! } });

    // Get relationship metadata (cached)
    const rel = await system.database.getRelationship(model!, relationship!);

    // Get the specific child record, verifying it belongs to the parent
    return await system.database.select404(rel.childModel, {
        where: {
            id: child!,
            [rel.fieldName]: id // Ensure child belongs to this parent
        }
    });
});
