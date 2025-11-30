import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * PUT /api/acls/:model/:id - Replace ACL lists entirely
 *
 * Completely replaces the access control lists with new values.
 * Request body should contain the complete new access lists:
 * {
 *   "access_read": ["user1", "user2"],
 *   "access_edit": ["user3"],
 *   "access_full": ["admin1"],
 *   "access_deny": ["blocked1"]
 * }
 *
 * Note: Any access list not provided will be set to empty array
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model, id } = params;

    // Validate and prepare updates for all ACL fields
    const validFields = ['access_read', 'access_edit', 'access_full', 'access_deny'];
    const updates: any = {};

    for (const field of validFields) {
        if (field in body) {
            if (!Array.isArray(body[field])) {
                throw HttpErrors.badRequest(`${field} must be an array`, 'INVALID_ACL_FORMAT');
            }

            // Validate all entries are strings (user IDs)
            if (!body[field].every((userId: any) => typeof userId === 'string')) {
                throw HttpErrors.badRequest(`${field} must contain only string user IDs`, 'INVALID_USER_ID_FORMAT');
            }

            // Remove duplicates
            updates[field] = [...new Set(body[field])];
        } else {
            // Field not provided - set to empty array (complete replacement)
            updates[field] = [];
        }
    }

    // Verify record exists before updating (select404 automatically throws 404 if not found)
    await system.database.select404(model!, {
        where: { id: id! },
        select: ['id']
    });

    // Replace all ACL lists (returns the updated record)
    const updatedRecord = await system.database.updateOne(model!, id!, updates);

    // Return ACL data (middleware will wrap in success response)
    return {
        record_id: id,
        access_lists: {
            access_read: updatedRecord.access_read || [],
            access_edit: updatedRecord.access_edit || [],
            access_full: updatedRecord.access_full || [],
            access_deny: updatedRecord.access_deny || []
        }
    };
});
