import type { Context } from 'hono';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { DatabaseConnection } from '@src/lib/database-connection.js';

/**
 * GET /auth/tenants - List available tenants with users (personal mode only)
 *
 * Returns a list of all tenant names, descriptions, and available usernames from
 * each tenant database. This endpoint is only available when the server is running
 * in personal mode (TENANT_NAMING_MODE=personal). It's useful for discovery in
 * personal PaaS deployments where users may manage multiple tenants.
 *
 * In enterprise mode, this endpoint returns a 403 error for security reasons
 * (tenant discovery should not be exposed in multi-tenant SaaS environments).
 *
 * Error codes:
 * - AUTH_TENANT_LIST_NOT_AVAILABLE: Endpoint called on enterprise mode server (403)
 *
 * @returns Array of tenant objects with name, description, and users array
 * @see docs/routes/AUTH_API.md
 */
export default async function (context: Context) {
    // Check server mode - only allow in personal mode
    const serverMode = (process.env.TENANT_NAMING_MODE || 'enterprise') as 'enterprise' | 'personal';

    if (serverMode !== 'personal') {
        throw HttpErrors.forbidden(
            'Tenant listing is only available in personal mode',
            'AUTH_TENANT_LIST_NOT_AVAILABLE'
        );
    }

    // Get main database connection
    const mainPool = DatabaseConnection.getMainPool();

    // Query all active tenants (excluding templates and trashed)
    const result = await mainPool.query(
        `
        SELECT name, database, schema, description
        FROM tenants
        WHERE is_active = true
          AND trashed_at IS NULL
          AND deleted_at IS NULL
        ORDER BY name ASC
        `
    );

    // For each tenant, fetch available usernames from their namespace
    const tenantsWithUsers = await Promise.all(
        result.rows.map(async (row) => {
            try {
                // Query active users (non-deleted), limit to 10, oldest first
                const usersResult = await DatabaseConnection.queryInNamespace(
                    row.database,
                    row.schema,
                    `
                    SELECT auth
                    FROM users
                    WHERE deleted_at IS NULL
                      AND trashed_at IS NULL
                    ORDER BY created_at ASC
                    LIMIT 10
                    `
                );

                // Extract usernames
                const users = usersResult.rows.map((userRow) => userRow.auth);

                return {
                    name: row.name,
                    description: row.description || null,
                    users: users,
                };
            } catch (error) {
                // If tenant namespace is unreachable, return empty users array
                return {
                    name: row.name,
                    description: row.description || null,
                    users: [],
                };
            }
        })
    );

    return context.json({
        success: true,
        data: tenantsWithUsers,
    });
}
