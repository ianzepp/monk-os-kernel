/**
 * Authentication Service
 *
 * Core authentication logic extracted from route handlers.
 * Can be used by HTTP routes, TTY servers, and other internal services.
 */

import { Infrastructure, parseInfraConfig } from '@src/lib/infrastructure.js';
import { DatabaseConnection } from '@src/lib/database-connection.js';
import { createAdapterFrom } from '@src/lib/database/index.js';
import { verifyPassword } from '@src/lib/credentials/index.js';
import { JWTGenerator, type JWTPayload } from '@src/lib/jwt-generator.js';
import { systemInitFromJWT, type SystemInit } from '@src/lib/system.js';

/**
 * Login request parameters
 */
export interface LoginRequest {
    tenant: string;
    username: string;
    password?: string;
}

/**
 * Authenticated user data
 */
export interface AuthenticatedUser {
    id: string;
    username: string;
    tenant: string;
    access: string;
    accessRead: string[];
    accessEdit: string[];
    accessFull: string[];
}

/**
 * Login result on success
 */
export interface LoginResult {
    success: true;
    user: AuthenticatedUser;
    token: string;
    payload: JWTPayload;
    systemInit: SystemInit;
}

/**
 * Login failure result
 */
export interface LoginFailure {
    success: false;
    error: string;
    errorCode: string;
}

/**
 * Authenticate a user with tenant, username, and optional password.
 *
 * @param request - Login credentials
 * @returns Login result or failure
 */
export async function login(request: LoginRequest): Promise<LoginResult | LoginFailure> {
    const { tenant, username, password } = request;

    // Normalize tenant name to match how createTenant stores it
    const normalizedTenant = tenant.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    // Look up tenant record from infrastructure database
    const tenantRecord = await Infrastructure.getTenant(normalizedTenant);

    if (!tenantRecord) {
        return {
            success: false,
            error: 'Authentication failed',
            errorCode: 'AUTH_LOGIN_FAILED',
        };
    }

    const { name, db_type: dbType, database: dbName, schema: nsName } = tenantRecord;

    // Look up user in the tenant's namespace
    let userResult: { rows: any[] };

    if (dbType === 'sqlite') {
        const adapter = createAdapterFrom('sqlite', dbName, nsName);
        await adapter.connect();
        try {
            userResult = await adapter.query(
                'SELECT id, name, auth, access, access_read, access_edit, access_full, access_deny FROM users WHERE auth = $1 AND trashed_at IS NULL AND deleted_at IS NULL',
                [username]
            );
        } finally {
            await adapter.disconnect();
        }
    } else {
        userResult = await DatabaseConnection.queryInNamespace(
            dbName,
            nsName,
            'SELECT id, name, auth, access, access_read, access_edit, access_full, access_deny FROM users WHERE auth = $1 AND trashed_at IS NULL AND deleted_at IS NULL',
            [username]
        );
    }

    if (!userResult.rows || userResult.rows.length === 0) {
        return {
            success: false,
            error: 'Authentication failed',
            errorCode: 'AUTH_LOGIN_FAILED',
        };
    }

    const user = userResult.rows[0];

    // Check for password credential
    let credentialResult: { rows: any[] };

    if (dbType === 'sqlite') {
        const adapter = createAdapterFrom('sqlite', dbName, nsName);
        await adapter.connect();
        try {
            credentialResult = await adapter.query(
                `SELECT secret FROM credentials
                 WHERE user_id = $1 AND type = 'password' AND deleted_at IS NULL
                 ORDER BY created_at DESC LIMIT 1`,
                [user.id]
            );
        } finally {
            await adapter.disconnect();
        }
    } else {
        credentialResult = await DatabaseConnection.queryInNamespace(
            dbName,
            nsName,
            `SELECT secret FROM credentials
             WHERE user_id = $1 AND type = 'password' AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
            [user.id]
        );
    }

    // If user has a password credential, verify it
    if (credentialResult.rows && credentialResult.rows.length > 0) {
        const storedHash = credentialResult.rows[0].secret;

        // Password is required if user has one set
        if (!password) {
            return {
                success: false,
                error: 'Password is required',
                errorCode: 'AUTH_PASSWORD_REQUIRED',
            };
        }

        // Verify password
        const isValid = await verifyPassword(password, storedHash);
        if (!isValid) {
            return {
                success: false,
                error: 'Authentication failed',
                errorCode: 'AUTH_LOGIN_FAILED',
            };
        }
    }

    // Build JWT payload
    const payload: JWTPayload = {
        sub: user.id,
        user_id: user.id,
        username: user.auth,
        tenant: name,
        db_type: dbType || 'postgresql',
        db: dbName,
        ns: nsName,
        access: user.access,
        access_read: user.access_read || [],
        access_edit: user.access_edit || [],
        access_full: user.access_full || [],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        is_sudo: user.access === 'root',
    };

    // Generate token
    const token = await JWTGenerator.fromUserAndTenant(user, {
        name,
        db_type: dbType || 'postgresql',
        database: dbName,
        schema: nsName,
    });

    // Create SystemInit for transaction usage
    const systemInit = systemInitFromJWT(payload);

    return {
        success: true,
        user: {
            id: user.id,
            username: user.auth,
            tenant: name,
            access: user.access,
            accessRead: user.access_read || [],
            accessEdit: user.access_edit || [],
            accessFull: user.access_full || [],
        },
        token,
        payload,
        systemInit,
    };
}

/**
 * Registration request parameters
 */
export interface RegisterRequest {
    tenant: string;
    username?: string;
    password?: string;
}

/**
 * Registration result on success
 */
export interface RegisterResult {
    success: true;
    tenant: string;
    username: string;
    token: string;
}

/**
 * Registration failure result
 */
export interface RegisterFailure {
    success: false;
    error: string;
    errorCode: string;
}

/**
 * Register a new tenant with an initial user.
 *
 * @param request - Registration parameters
 * @returns Registration result or failure
 */
export async function register(
    request: RegisterRequest
): Promise<RegisterResult | RegisterFailure> {
    const { tenant, username = 'root', password } = request;

    // Validate tenant name
    if (!tenant || tenant.trim().length === 0) {
        return {
            success: false,
            error: 'Tenant name is required',
            errorCode: 'AUTH_TENANT_MISSING',
        };
    }

    // Validate tenant name format (lowercase alphanumeric and underscores only)
    // This matches what Infrastructure.createTenant will store
    if (!/^[a-z][a-z0-9_]*$/.test(tenant)) {
        return {
            success: false,
            error: 'Tenant name must be lowercase, start with a letter, and contain only letters, numbers, and underscores',
            errorCode: 'AUTH_TENANT_INVALID',
        };
    }

    // Create tenant with full provisioning
    let result;
    try {
        result = await Infrastructure.createTenant({
            name: tenant,
            owner_username: username,
        });
    } catch (error: any) {
        // Check for duplicate tenant error
        if (error.message?.includes('already exists')) {
            return {
                success: false,
                error: `Tenant '${tenant}' already exists`,
                errorCode: 'DATABASE_TENANT_EXISTS',
            };
        }
        return {
            success: false,
            error: error.message || 'Registration failed',
            errorCode: 'REGISTRATION_FAILED',
        };
    }

    // If password provided, set it for the user
    if (password) {
        try {
            const { hashPassword } = await import('@src/lib/credentials/index.js');
            const hashedPassword = await hashPassword(password);

            const { db_type: dbType, database: dbName, schema: nsName } = result.tenant;

            if (dbType === 'sqlite') {
                const adapter = createAdapterFrom('sqlite', dbName, nsName);
                await adapter.connect();
                try {
                    await adapter.query(
                        `INSERT INTO credentials (id, user_id, type, secret, created_at, updated_at)
                         VALUES ($1, $2, 'password', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [crypto.randomUUID(), result.user.id, hashedPassword]
                    );
                } finally {
                    await adapter.disconnect();
                }
            } else {
                await DatabaseConnection.queryInNamespace(
                    dbName,
                    nsName,
                    `INSERT INTO credentials (id, user_id, type, secret, created_at, updated_at)
                     VALUES ($1, $2, 'password', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [crypto.randomUUID(), result.user.id, hashedPassword]
                );
            }
        } catch (error: any) {
            // Password setting failed, but tenant was created - log warning
            console.warn('Failed to set password during registration:', error.message);
        }
    }

    // Generate JWT token for the new user
    const token = await JWTGenerator.fromUserAndTenant(result.user, result.tenant);

    return {
        success: true,
        tenant: result.tenant.name,
        username: result.user.auth,
        token,
    };
}
