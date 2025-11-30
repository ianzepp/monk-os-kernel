import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * DELETE /api/acls/:model/:id - Clear all ACL lists
 *
 * Removes all access control entries and returns the record to default status.
 * This sets all four access arrays to empty arrays:
 * - access_read: []
 * - access_edit: []
 * - access_full: []
 * - access_deny: []
 *
 * After this operation, the record will use default role-based permissions.
 */
export default withTransaction(async ({ system, params }) => {
    const { model, id } = params;

    // Verify record exists before updating (select404 automatically throws 404 if not found)
    await system.database.select404(model!, {
        where: { id: id! },
        select: ['id']
    });

    // Clear all ACL lists by setting them to empty arrays
    const updates = {
        access_read: [],
        access_edit: [],
        access_full: [],
        access_deny: []
    };

    const result = await system.database.updateOne(model!, id!, updates);

    // Return ACL data (middleware will wrap in success response)
    return {
        record_id: id,
        model: model,
        status: 'default_permissions',
        access_lists: {
            access_read: [],
            access_edit: [],
            access_full: [],
            access_deny: []
        }
    };
});
