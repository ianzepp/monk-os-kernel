import { withTransaction, withSelfServiceSudo } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { hashPassword, verifyPassword } from '@src/lib/credentials/index.js';
import { randomUUID } from 'crypto';

// TODO: SECURITY - The 'credentials' model is currently visible via /api/data/credentials
// This exposes password hashes and API key hashes to users with read access.
// Options to fix:
// 1. Add 'internal' flag to models table, check in database select/pipeline
// 2. Remove credentials from model seed data, rewrite routes to use raw SQL
// See discussion in auth implementation conversation.

/**
 * POST /api/user/:id/password - Set or change user password
 *
 * Sets a new password for the user. If the user already has a password,
 * the current password must be provided and verified.
 *
 * Body:
 * - current_password: Required if user has existing password
 * - new_password: Required, minimum 8 characters
 *
 * Permissions:
 * - "me" or own user ID: Can change own password (requires current_password if set)
 * - Other user IDs: Requires sudo access, can set without current_password
 *
 * Password requirements:
 * - Minimum 8 characters
 * - No maximum (bcrypt truncates at 72 bytes, argon2 has no limit)
 */
export default withTransaction(async ({ system, params, body }) => {
    const targetId = params.id === 'me' ? system.userId : params.id;
    const isSelf = targetId === system.userId;
    const hasSudo = system.isSudo();

    // Non-self access requires sudo
    if (!isSelf && !hasSudo) {
        throw HttpErrors.forbidden(
            'Setting password for other users requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    // Validate new_password
    const { current_password, new_password } = body;

    if (!new_password || typeof new_password !== 'string') {
        throw HttpErrors.badRequest(
            'New password is required',
            'VALIDATION_ERROR',
            { field: 'new_password' }
        );
    }

    if (new_password.length < 8) {
        throw HttpErrors.badRequest(
            'Password must be at least 8 characters',
            'VALIDATION_ERROR',
            { field: 'new_password' }
        );
    }

    // Verify target user exists
    const user = await system.database.selectOne('users', {
        where: { id: targetId }
    });

    if (!user) {
        throw HttpErrors.notFound('User not found', 'USER_NOT_FOUND');
    }

    // Check if user has existing password credential
    const existingCredential = await system.database.selectOne('credentials', {
        where: {
            user_id: targetId,
            type: 'password'
        },
        order: { created_at: 'desc' }
    });

    // If self-service and has existing password, verify current password
    if (isSelf && !hasSudo && existingCredential) {
        if (!current_password || typeof current_password !== 'string') {
            throw HttpErrors.badRequest(
                'Current password is required to change password',
                'VALIDATION_ERROR',
                { field: 'current_password' }
            );
        }

        const isValid = await verifyPassword(current_password, existingCredential.secret);
        if (!isValid) {
            throw HttpErrors.unauthorized(
                'Current password is incorrect',
                'INVALID_PASSWORD'
            );
        }
    }

    // Hash the new password
    const hashedPassword = await hashPassword(new_password);

    // Create new credential record (append-only pattern for password history)
    const credential = {
        id: randomUUID(),
        user_id: targetId,
        type: 'password',
        identifier: null,
        secret: hashedPassword,
        algorithm: 'argon2id',
        permissions: null,
        name: null,
        expires_at: null,
        last_used_at: null,
    };

    // Use self-service sudo for creating credential
    await withSelfServiceSudo(system, async () => {
        await system.database.createOne('credentials', credential);
    });

    return {
        success: true,
        message: existingCredential ? 'Password changed successfully' : 'Password set successfully',
    };
});
