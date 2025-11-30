import type { Context } from 'hono';
import { runTransaction } from '@src/lib/transaction.js';
import type { SystemInit } from '@src/lib/system.js';

/**
 * POST /api/bulk/export - Export tenant data to SQLite format
 *
 * Request body:
 *   models?: string[]              - Specific models to export (null = all non-system)
 *   include?: ('describe'|'data')[] - What to include (default: ['describe', 'data'])
 *
 * Response: SQLite database file (application/x-sqlite3)
 */
export default async function handler(context: Context) {
    const systemInit = context.get('systemInit') as SystemInit;

    if (!systemInit) {
        return context.json({
            success: false,
            error: 'Authentication required',
            error_code: 'UNAUTHORIZED',
        }, 401);
    }

    const body = context.get('parsedBody') || {};

    // Run export within transaction for consistent snapshot
    const result = await runTransaction(systemInit, async (system) => {
        return await system.database.exportAll({
            models: body.models,
            include: body.include,
        });
    });

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `export-${systemInit.nsName}-${timestamp}.sqlite`;

    // Return as file download
    return new Response(result.buffer, {
        status: 200,
        headers: {
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': String(result.buffer.byteLength),
        },
    });
}
