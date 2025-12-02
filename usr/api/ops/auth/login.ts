/**
 * auth:login - Authenticate a connection
 *
 * Request:
 *   { op: "auth:login", data: { tenant: string, username: string, password?: string } }
 *
 * Response:
 *   { op: "ok", data: { token: string, user: { id, tenant } } }
 *   { op: "error", data: { code: "AUTH_FAILED", message: "..." } }
 */

import { respond } from '@usr/lib/api';
import type { OpContext } from '@usr/lib/api';

interface LoginRequest {
    tenant: string;
    username: string;
    password?: string;
}

export default async function* ({ conn, msg }: OpContext) {
    const { tenant, username, password } = (msg.data ?? {}) as LoginRequest;

    // Validate required fields
    if (!tenant) {
        yield respond.error('AUTH_TENANT_MISSING', 'Tenant is required');
        return;
    }

    if (!username) {
        yield respond.error('AUTH_USERNAME_MISSING', 'Username is required');
        return;
    }

    // TODO: Actual authentication
    // For now, accept any login for demonstration
    const user = {
        id: crypto.randomUUID(),
        tenant,
        username,
    };

    // Set user on connection (authenticates the connection)
    conn.user = user;

    // Generate token (placeholder)
    const token = `tok_${crypto.randomUUID().replace(/-/g, '')}`;

    yield respond.ok({
        token,
        user: {
            id: user.id,
            tenant: user.tenant,
        },
    });
}
