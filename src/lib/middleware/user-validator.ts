/**
 * User Context Validation Middleware
 *
 * Uses JWT context values to validate user exists in tenant database.
 * Requires jwtValidatorMiddleware to run first to populate context.
 * Enriches systemInit with validated user data from database.
 */

import type { Context, Next } from 'hono';
import { DatabaseConnection } from '@src/lib/database-connection.js';
import { createAdapterFrom } from '@src/lib/database/index.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import type { JWTPayload } from '@src/lib/jwt-generator.js';
import type { SystemInit } from '@src/lib/system.js';

/**
 * User validation middleware - validates user exists in tenant database
 * 
 * Reads tenant/database/user_id from context (set by jwtValidatorMiddleware).
 * Validates user exists and is active, then enriches context with user data.
 */
export async function userValidatorMiddleware(context: Context, next: Next) {
    // Get JWT context values (set by jwtValidatorMiddleware)
    const tenant = context.get('tenant');
    const dbType = context.get('dbType') || 'postgresql';
    const dbName = context.get('dbName');
    const nsName = context.get('nsName');
    const jwtPayload = context.get('jwtPayload');
    const userId = jwtPayload?.user_id;

    if (!tenant || !dbName || !nsName || !userId) {
        throw HttpErrors.unauthorized('Invalid JWT context - missing required fields', 'TOKEN_CONTEXT_INVALID');
    }

    try {
        // Set up database and namespace connection for the tenant
        DatabaseConnection.setDatabaseAndNamespaceForRequest(context, dbName, nsName);

        // Look up user using adapter (supports both PostgreSQL and SQLite)
        const adapter = createAdapterFrom(dbType, dbName, nsName);
        await adapter.connect();

        let user;
        try {
            const userResult = await adapter.query<any>(
                'SELECT id, name, access, access_read, access_edit, access_full FROM users WHERE id = $1 AND trashed_at IS NULL',
                [userId]
            );

            if (userResult.rows.length === 0) {
                throw HttpErrors.unauthorized('User not found or inactive', 'USER_NOT_FOUND');
            }

            user = userResult.rows[0];
        } finally {
            await adapter.disconnect();
        }

        // Parse JSON arrays for SQLite (stored as JSON strings)
        const accessRead = typeof user.access_read === 'string' ? JSON.parse(user.access_read) : (user.access_read || []);
        const accessEdit = typeof user.access_edit === 'string' ? JSON.parse(user.access_edit) : (user.access_edit || []);
        const accessFull = typeof user.access_full === 'string' ? JSON.parse(user.access_full) : (user.access_full || []);

        // Enrich systemInit with validated user data from database
        // This ensures System has fresh access arrays, not stale JWT data
        const systemInit = context.get('systemInit') as SystemInit;
        if (systemInit) {
            systemInit.accessRead = accessRead;
            systemInit.accessEdit = accessEdit;
            systemInit.accessFull = accessFull;
        }

        // Enrich context with actual user data from database
        context.set('user', {
            id: user.id,
            name: user.name,
            access: user.access,
            tenant: tenant,
            dbName: dbName,
            nsName: nsName,
            access_read: accessRead,
            access_edit: accessEdit,
            access_full: accessFull
        });

        // Legacy context values for backwards compatibility
        context.set('userId', user.id);
        context.set('accessReadIds', accessRead);
        context.set('accessEditIds', accessEdit);
        context.set('accessFullIds', accessFull);

        return await next();

    } catch (error) {
        if (error instanceof Error && error.name === 'HttpError') {
            throw error; // Re-throw HttpErrors
        }

        console.error('User validation failed:', error);
        throw HttpErrors.unauthorized('User validation failed', 'USER_VALIDATION_ERROR');
    }
}