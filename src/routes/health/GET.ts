import type { Context } from 'hono';

/**
 * GET /health - Health check endpoint
 *
 * Returns server health status for monitoring and load balancers.
 * Public endpoint, no authentication required.
 */
export default function (context: Context) {
    return context.json({
        success: true,
        data: {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        }
    });
}
