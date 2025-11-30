/**
 * JWT System Init Middleware
 *
 * Verifies JWT signature and extracts payload without database validation.
 * Also supports API key authentication for programmatic access.
 *
 * Supported authentication methods:
 * - Authorization: Bearer <jwt_token>
 * - Authorization: Bearer <api_key> (requires X-Tenant header)
 * - X-API-Key: <api_key> (requires X-Tenant header)
 *
 * Creates SystemInit for use by System class.
 */

import type { Context, Next } from 'hono';
import { verify } from 'hono/jwt';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { systemInitFromJWT } from '@src/lib/system.js';
import type { JWTPayload } from '@src/lib/jwt-generator.js';
import { isValidApiKeyFormat, verifyApiKey } from '@src/lib/credentials/index.js';
import { Infrastructure } from '@src/lib/infrastructure.js';
import { createAdapterFrom } from '@src/lib/database/index.js';
import { DatabaseConnection } from '@src/lib/database-connection.js';

function getJwtSecret(): string {
    return process.env['JWT_SECRET']!;
}

/**
 * Authenticate using an API key
 * Returns a synthetic JWT payload if successful
 */
async function authenticateApiKey(apiKey: string, tenantName: string): Promise<JWTPayload> {
    // Look up tenant
    const tenantRecord = await Infrastructure.getTenant(tenantName);
    if (!tenantRecord) {
        throw HttpErrors.unauthorized('Invalid tenant', 'AUTH_INVALID_TENANT');
    }

    const { name, db_type: dbType, database: dbName, schema: nsName } = tenantRecord;

    // Look up API key credential by prefix (first 16 chars)
    const prefix = apiKey.substring(0, 16);
    let credentialResult: { rows: any[] };

    if (dbType === 'sqlite') {
        const adapter = createAdapterFrom('sqlite', dbName, nsName);
        await adapter.connect();
        try {
            credentialResult = await adapter.query(
                `SELECT c.id, c.user_id, c.secret, c.permissions, c.expires_at,
                        u.name as user_name, u.auth as username, u.access, u.access_read, u.access_edit, u.access_full, u.access_deny
                 FROM credentials c
                 JOIN users u ON u.id = c.user_id
                 WHERE c.identifier = $1 AND c.type = 'api_key' AND c.deleted_at IS NULL
                   AND u.trashed_at IS NULL AND u.deleted_at IS NULL`,
                [prefix]
            );
        } finally {
            await adapter.disconnect();
        }
    } else {
        credentialResult = await DatabaseConnection.queryInNamespace(
            dbName,
            nsName,
            `SELECT c.id, c.user_id, c.secret, c.permissions, c.expires_at,
                    u.name as user_name, u.auth as username, u.access, u.access_read, u.access_edit, u.access_full, u.access_deny
             FROM credentials c
             JOIN users u ON u.id = c.user_id
             WHERE c.identifier = $1 AND c.type = 'api_key' AND c.deleted_at IS NULL
               AND u.trashed_at IS NULL AND u.deleted_at IS NULL`,
            [prefix]
        );
    }

    if (!credentialResult.rows || credentialResult.rows.length === 0) {
        throw HttpErrors.unauthorized('Invalid API key', 'AUTH_INVALID_API_KEY');
    }

    const credential = credentialResult.rows[0];

    // Verify the full API key hash
    if (!verifyApiKey(apiKey, credential.secret)) {
        throw HttpErrors.unauthorized('Invalid API key', 'AUTH_INVALID_API_KEY');
    }

    // Check expiration
    if (credential.expires_at && new Date(credential.expires_at) < new Date()) {
        throw HttpErrors.unauthorized('API key has expired', 'AUTH_API_KEY_EXPIRED');
    }

    // Update last_used_at (fire and forget - don't block response)
    const updateLastUsed = async () => {
        try {
            if (dbType === 'sqlite') {
                const adapter = createAdapterFrom('sqlite', dbName, nsName);
                await adapter.connect();
                try {
                    await adapter.query(
                        `UPDATE credentials SET last_used_at = $1 WHERE id = $2`,
                        [new Date().toISOString(), credential.id]
                    );
                } finally {
                    await adapter.disconnect();
                }
            } else {
                await DatabaseConnection.queryInNamespace(
                    dbName,
                    nsName,
                    `UPDATE credentials SET last_used_at = $1 WHERE id = $2`,
                    [new Date().toISOString(), credential.id]
                );
            }
        } catch (e) {
            // Ignore errors - this is non-critical
            console.error('Failed to update API key last_used_at:', e);
        }
    };
    updateLastUsed(); // Don't await

    // Build synthetic JWT payload for the API key
    const payload: JWTPayload = {
        sub: credential.user_id,
        user_id: credential.user_id,
        username: credential.username,
        tenant: name,
        db_type: dbType || 'postgresql',
        db: dbName,
        ns: nsName,
        access: credential.access,
        access_read: credential.access_read || [],
        access_edit: credential.access_edit || [],
        access_full: credential.access_full || [],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour synthetic expiry
        is_sudo: credential.access === 'root',
        is_api_key: true, // Flag this as API key auth
        api_key_id: credential.id,
    };

    return payload;
}

/**
 * JWT validation middleware - verifies token signature and extracts payload
 * Also supports API key authentication.
 *
 * Only validates token integrity, does not check user/tenant existence.
 * Sets JWT context values for subsequent middleware to use.
 */
export async function jwtValidatorMiddleware(context: Context, next: Next) {
    try {
        // Check for API key header first
        const apiKeyHeader = context.req.header('X-API-Key');
        const authHeader = context.req.header('Authorization');
        const tenantHeader = context.req.header('X-Tenant') || context.req.header('X-Monk-Tenant');

        let token: string | null = null;
        let isApiKey = false;

        if (apiKeyHeader) {
            // X-API-Key header takes precedence
            token = apiKeyHeader;
            isApiKey = isValidApiKeyFormat(token);
        } else if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.substring(7);
            // Check if it's an API key format
            isApiKey = isValidApiKeyFormat(token);
        }

        if (!token) {
            throw HttpErrors.unauthorized('Authorization token required', 'AUTH_TOKEN_REQUIRED');
        }

        let payload: JWTPayload;

        if (isApiKey) {
            // API key authentication
            if (!tenantHeader) {
                throw HttpErrors.badRequest(
                    'X-Tenant header required when using API key authentication',
                    'AUTH_TENANT_HEADER_REQUIRED'
                );
            }
            payload = await authenticateApiKey(token, tenantHeader);
        } else {
            // JWT authentication
            payload = await verify(token, getJwtSecret()) as JWTPayload;
        }

        // Store JWT payload for middleware that needs raw payload access
        context.set('jwtPayload', payload);

        // Create SystemInit from JWT for System class initialization
        // This is the canonical source of auth context for the request
        const correlationId = context.req.header('x-request-id');
        const systemInit = systemInitFromJWT(payload, correlationId || undefined);
        context.set('systemInit', systemInit);

        // Legacy context values for backwards compatibility
        // TODO: Migrate middleware to use systemInit directly
        context.set('tenant', payload.tenant);
        context.set('dbType', systemInit.dbType);
        context.set('dbName', systemInit.dbName);
        context.set('nsName', systemInit.nsName);

        return await next();

    } catch (error: any) {
        // Convert JWT verification errors to proper HttpErrors with specific error codes

        // Token expired - can be refreshed
        if (error.name === 'JwtTokenExpired') {
            throw HttpErrors.unauthorized('Token has expired', 'AUTH_TOKEN_EXPIRED');
        }

        // Token invalid - malformed or bad signature
        if (error.name === 'JwtTokenInvalid' || error.message?.includes('jwt') || error.message === 'Unauthorized') {
            throw HttpErrors.unauthorized('Invalid token', 'AUTH_TOKEN_INVALID');
        }

        // Re-throw HttpErrors and other errors
        throw error;
    }
}