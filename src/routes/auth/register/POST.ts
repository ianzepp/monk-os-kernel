import type { Context } from 'hono';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Infrastructure, parseInfraConfig } from '@src/lib/infrastructure.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';
import type { DatabaseType } from '@src/lib/database/adapter.js';

/**
 * POST /auth/register - Tenant registration
 *
 * Creates a new tenant with core tables (models, fields, users, filters)
 * and a root user. Returns a JWT token for immediate access.
 *
 * Request body:
 * - tenant (required): User-facing tenant name
 * - username (optional): Username for the tenant admin (defaults to 'root')
 * - description (optional): Human-readable description of the tenant
 * - adapter (optional): Database adapter - 'postgresql' or 'sqlite' (inherits from infra config if not specified)
 *
 * Error codes:
 * - AUTH_TENANT_MISSING: Missing tenant field (400)
 * - INVALID_ADAPTER: Invalid adapter value (400)
 * - DATABASE_TENANT_EXISTS: Tenant name already registered (409)
 *
 * @see docs/routes/AUTH_API.md
 */
export default async function (context: Context) {
    const body = await context.req.json();

    // Body type validation
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an object', 'BODY_NOT_OBJECT');
    }

    const { tenant, username, password, description, adapter } = body;

    // Input validation
    if (!tenant) {
        throw HttpErrors.badRequest('Tenant is required', 'AUTH_TENANT_MISSING');
    }

    // Validate adapter if specified
    let dbType: DatabaseType | undefined;
    if (adapter) {
        if (adapter !== 'postgresql' && adapter !== 'sqlite') {
            throw HttpErrors.badRequest(
                "Invalid adapter. Must be 'postgresql' or 'sqlite'",
                'INVALID_ADAPTER'
            );
        }
        dbType = adapter;
    }

    // Create tenant with full provisioning
    let result;
    try {
        result = await Infrastructure.createTenant({
            name: tenant,
            db_type: dbType,
            owner_username: username || 'root',
            description: description,
        });
    } catch (error: any) {
        // Check for duplicate tenant error
        if (error.message?.includes('already exists')) {
            throw HttpErrors.conflict(
                `Tenant '${tenant}' already exists`,
                'DATABASE_TENANT_EXISTS'
            );
        }
        throw error;
    }

    // Generate JWT token for the new user
    const token = await JWTGenerator.fromUserAndTenant(result.user, result.tenant);

    return context.json({
        success: true,
        data: {
            tenant: result.tenant.name,
            username: result.user.auth,
            token: token,
            expires_in: 24 * 60 * 60,
        },
    });
}
