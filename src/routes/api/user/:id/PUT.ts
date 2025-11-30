import { withTransaction, withSelfServiceSudo } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * PUT /api/user/:id - Update user profile
 *
 * Updates user profile for the specified user.
 * The :id parameter can be a UUID or "me" for the current user.
 *
 * Permissions:
 * - "me" or own user ID: Can update name and auth only
 * - Other user IDs: Requires sudo access, can update all fields
 *
 * Self-service fields (name, auth):
 * - name: 2-100 characters
 * - auth: 2-255 characters, must be unique across tenant
 *
 * Admin-only fields:
 * - access: deny|read|edit|full|root
 * - access_read, access_edit, access_full: UUID arrays
 */
export default withTransaction(async ({ system, params, body }) => {
    // Body type validation
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an object', 'BODY_NOT_OBJECT');
    }

    const targetId = params.id === 'me' ? system.userId : params.id;
    const isSelf = targetId === system.userId;
    const hasSudo = system.isSudo();

    // Non-self access requires sudo
    if (!isSelf && !hasSudo) {
        throw HttpErrors.forbidden(
            'Updating other users requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    // Self-service: restrict to allowed fields
    const selfServiceFields = ['name', 'auth'];
    const adminFields = ['access', 'access_read', 'access_edit', 'access_full'];

    if (isSelf && !hasSudo) {
        // Check for disallowed fields
        const disallowedFields = Object.keys(body).filter(key => adminFields.includes(key));
        if (disallowedFields.length > 0) {
            throw HttpErrors.badRequest(
                `Cannot update fields: ${disallowedFields.join(', ')}. Requires sudo access.`,
                'VALIDATION_ERROR',
                { disallowed_fields: disallowedFields }
            );
        }

        // Filter to only allowed fields
        const updates: Record<string, any> = {};

        // Validate name if provided
        if (body.name !== undefined) {
            if (typeof body.name !== 'string' || body.name.length < 2 || body.name.length > 100) {
                throw HttpErrors.badRequest(
                    'Name must be between 2 and 100 characters',
                    'VALIDATION_ERROR',
                    { field: 'name' }
                );
            }
            updates.name = body.name;
        }

        // Validate auth if provided
        if (body.auth !== undefined) {
            if (typeof body.auth !== 'string' || body.auth.length < 2 || body.auth.length > 255) {
                throw HttpErrors.badRequest(
                    'Auth identifier must be between 2 and 255 characters',
                    'VALIDATION_ERROR',
                    { field: 'auth' }
                );
            }

            // Check for duplicate auth identifier
            const existing = await system.database.selectOne('users', {
                where: {
                    auth: body.auth,
                    id: { $ne: targetId }
                }
            });

            if (existing) {
                throw HttpErrors.conflict(
                    'Auth identifier already exists',
                    'AUTH_CONFLICT',
                    { field: 'auth' }
                );
            }

            updates.auth = body.auth;
        }

        // If no updates provided, return current profile
        if (Object.keys(updates).length === 0) {
            return await system.database.select404('users', { where: { id: targetId } });
        }

        // Self-service update with temporary sudo elevation
        return await withSelfServiceSudo(system, async () => {
            return await system.database.updateOne('users', targetId, updates);
        });
    }

    // Admin update: all fields allowed
    return await system.database.updateOne('users', targetId, body);
});
