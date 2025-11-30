import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * POST /api/acls/:model/:id - Merge ACL entries
 *
 * Merges new user IDs into existing access control lists.
 * Request body should contain arrays of user IDs to add:
 * {
 *   "access_read": ["user1", "user2"],
 *   "access_edit": ["user3"],
 *   "access_full": ["admin1"],
 *   "access_deny": ["blocked1"]
 * }
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model, id } = params;

    // Validate request body structure
    const validFields = ['access_read', 'access_edit', 'access_full', 'access_deny'];
    const updates: any = {};
    let hasValidUpdates = false;

    for (const field of validFields) {
        if (field in body) {
            if (!Array.isArray(body[field])) {
                throw HttpErrors.badRequest(`${field} must be an array`, 'INVALID_ACL_FORMAT');
            }

            // Validate all entries are strings (user IDs)
            if (!body[field].every((userId: any) => typeof userId === 'string')) {
                throw HttpErrors.badRequest(`${field} must contain only string user IDs`, 'INVALID_USER_ID_FORMAT');
            }

            updates[field] = body[field];
            hasValidUpdates = true;
        }
    }

    if (!hasValidUpdates) {
        throw HttpErrors.badRequest('At least one access list must be provided', 'NO_ACL_UPDATES');
    }

    // Get current record to merge with existing ACLs (select404 automatically throws 404 if not found)
    const currentRecord = await system.database.select404(model!, {
        where: { id: id! },
        select: ['id', 'access_read', 'access_edit', 'access_full', 'access_deny']
    });

    // Merge new IDs with existing lists (avoid duplicates)
    const mergedUpdates: any = {};
    for (const field of validFields) {
        if (field in updates) {
            const existing = currentRecord[field] || [];
            const newIds = updates[field];
            // Merge and deduplicate
            mergedUpdates[field] = [...new Set([...existing, ...newIds])];
        }
    }

    // Update the record (returns the updated record)
    const updatedRecord = await system.database.updateOne(model!, id!, mergedUpdates);

    // Return ACL data (middleware will wrap in success response)
    return {
        record_id: id,
        updated_lists: Object.keys(mergedUpdates),
        access_lists: {
            access_read: updatedRecord.access_read || [],
            access_edit: updatedRecord.access_edit || [],
            access_full: updatedRecord.access_full || [],
            access_deny: updatedRecord.access_deny || []
        }
    };
});
