import type { Context } from 'hono';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { login } from '@src/lib/auth.js';

/**
 * POST /auth/login - Authenticate user with tenant, username, and password
 *
 * Error codes:
 * - AUTH_TENANT_MISSING: Missing tenant field (400)
 * - AUTH_USERNAME_MISSING: Missing username field (400)
 * - AUTH_PASSWORD_REQUIRED: User has password but none provided (400)
 * - AUTH_LOGIN_FAILED: Invalid credentials or tenant not found (401)
 *
 * @see docs/routes/AUTH_API.md
 */
export default async function (context: Context) {
    const body = await context.req.json();

    // Body type validation
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an object', 'BODY_NOT_OBJECT');
    }

    const { tenant, username, password, format } = body;

    console.info('/auth/login', { tenant, username, format });

    // Input validation
    if (!tenant) {
        throw HttpErrors.badRequest('Tenant is required', 'AUTH_TENANT_MISSING');
    }

    if (!username) {
        throw HttpErrors.badRequest('Username is required', 'AUTH_USERNAME_MISSING');
    }

    // Authenticate using core auth module
    const result = await login({ tenant, username, password });

    if (!result.success) {
        // Handle password required as 400, others as 401
        if (result.errorCode === 'AUTH_PASSWORD_REQUIRED') {
            throw HttpErrors.badRequest(result.error, result.errorCode);
        }

        return context.json(
            {
                success: false,
                error: result.error,
                error_code: result.errorCode,
            },
            401
        );
    }

    // Return response directly (no system context middleware)
    // Note: context.json() is transparently overridden by responseFormatterMiddleware
    // to support ?format=toon|yaml|etc - routes work with JSON, formatters handle encoding
    return context.json({
        success: true,
        data: {
            token: result.token,
            user: {
                id: result.user.id,
                username: result.user.username,
                tenant: result.user.tenant,
                access: result.user.access,
                ...(format && ['json', 'toon', 'yaml'].includes(format) && { format }),
            },
        },
    });
}
