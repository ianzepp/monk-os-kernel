import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * POST /api/user - Create new user in tenant
 *
 * Creates a new user within the authenticated user's tenant.
 * Requires sudo access.
 *
 * Request body:
 * {
 *   "name": "string",           // Display name
 *   "auth": "string",           // Username/email for authentication
 *   "access": "string",         // Access level: deny|read|edit|full|root
 *   "access_read": ["uuid"],    // Optional: Record-level read ACLs
 *   "access_edit": ["uuid"],    // Optional: Record-level edit ACLs
 *   "access_full": ["uuid"]     // Optional: Record-level full ACLs
 * }
 */
export default withTransaction(async ({ system, body }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Creating users requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const result = await system.database.createOne('users', body);
    return result;
});
