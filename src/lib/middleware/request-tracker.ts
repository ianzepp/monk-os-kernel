/**
 * Request Tracking Middleware
 *
 * Records all API requests to the database for analytics, monitoring,
 * and connection health verification. Runs early in middleware chain.
 *
 * In SQLite mode, request tracking is skipped since the requests table
 * has been removed from the simplified infrastructure schema.
 */

import type { Context, Next } from 'hono';
import { DatabaseConnection } from '@src/lib/database-connection.js';
import { parseInfraConfig } from '@src/lib/infrastructure.js';

/**
 * Request tracking middleware - logs all requests to database
 *
 * Serves dual purpose:
 * 1. Records request information for analytics and error context
 * 2. Verifies PostgreSQL connectivity early in request lifecycle
 *
 * Should be applied early in middleware chain, before authentication.
 *
 * Note: Request tracking is disabled in SQLite mode and when the
 * requests table doesn't exist (simplified infrastructure schema).
 */
export async function requestTrackerMiddleware(context: Context, next: Next) {
    // Skip request tracking in SQLite mode (no requests table)
    const config = parseInfraConfig();
    if (config.dbType === 'sqlite') {
        return await next();
    }

    // Extract request information
    const method = context.req.method;
    const url = context.req.url;
    const path = context.req.path;
    const api = extractApiFromPath(path);

    // Extract client information from headers (PostgreSQL INET type requires valid IP)
    const ipAddress =
        context.req.header('x-forwarded-for') ||
        context.req.header('x-real-ip') ||
        context.req.header('cf-connecting-ip') || // Cloudflare
        '127.0.0.1'; // Default to localhost for INET compatibility
    const userAgent = context.req.header('user-agent') || '';

    try {
        // Insert request record (connection health check + request logging)
        const pool = DatabaseConnection.getMainPool();
        const result = await pool.query(
            `
            INSERT INTO requests (method, url, path, api, ip_address, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `,
            [method, url, path, api, ipAddress, userAgent]
        );

        // Store request ID for potential response updates (future enhancement)
        if (result.rows?.[0]?.id) {
            context.set('requestId', result.rows[0].id);
        }

        // Database connection verified - continue with request
        return await next();
    } catch (error) {
        // Check if error is because requests table doesn't exist
        const errorMessage = String(error);
        if (errorMessage.includes('relation "requests" does not exist')) {
            // Table doesn't exist - skip tracking silently
            console.info('Request tracking disabled (requests table not found)');
            return await next();
        }

        // Database connection failed - this is a critical system issue
        console.error('Database connection failed during request tracking:', error);

        // Return service unavailable (don't proceed if database is down)
        return context.json(
            {
                success: false,
                error: 'Service temporarily unavailable',
                error_code: 'DATABASE_UNAVAILABLE',
            },
            503
        );
    }
}

/**
 * Extract API category from request path
 * Used for request analytics and routing insights
 */
function extractApiFromPath(path: string): string | null {
    if (path.startsWith('/auth/')) return 'auth';
    if (path.startsWith('/api/data/')) return 'data';
    if (path.startsWith('/api/describe/')) return 'describe';
    if (path.startsWith('/api/file/')) return 'file';
    if (path.startsWith('/api/bulk')) return 'bulk';
    if (path.startsWith('/api/find/')) return 'find';
    if (path.startsWith('/docs/')) return 'docs';
    if (path.startsWith('/root/')) return 'root';
    if (path === '/') return 'root';
    if (path === '/README.md') return 'docs';
    return null;
}
