import type { Context } from 'hono';
import { runTransaction } from '@src/lib/transaction.js';
import type { SystemInit } from '@src/lib/system.js';
import type { ImportStrategy } from '@src/lib/database/index.js';

/**
 * POST /api/bulk/import - Import tenant data from SQLite format
 *
 * Content-Type: multipart/form-data
 *   - file: SQLite database file
 *
 * Content-Type: application/octet-stream or application/x-sqlite3
 *   - Raw SQLite database in request body
 *
 * Query parameters:
 *   - strategy: upsert (default), replace, merge, skip
 *   - models: comma-separated list of models to import (optional)
 *   - include: comma-separated list of what to import (describe, data)
 *
 * Response: JSON with import statistics
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

    // Parse query parameters
    const query = context.req.query();
    const strategy = (query.strategy || 'upsert') as ImportStrategy;
    const models = query.models ? query.models.split(',').map(m => m.trim()) : undefined;
    const include: ('describe' | 'data')[] = query.include
        ? query.include.split(',').map(i => i.trim()).filter(i => i === 'describe' || i === 'data') as ('describe' | 'data')[]
        : ['describe', 'data'];

    // Validate strategy
    if (!['upsert', 'replace', 'merge', 'skip'].includes(strategy)) {
        return context.json({
            success: false,
            error: `Invalid strategy: ${strategy}. Must be one of: upsert, replace, merge, skip`,
            error_code: 'VALIDATION_ERROR',
        }, 400);
    }

    // Get SQLite buffer from request
    let buffer: Uint8Array;

    const contentType = context.req.header('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
        // Handle multipart file upload
        const formData = await context.req.formData();
        const file = formData.get('file');

        if (!file || !(file instanceof File)) {
            return context.json({
                success: false,
                error: 'Missing file in multipart form data',
                error_code: 'VALIDATION_ERROR',
            }, 400);
        }

        buffer = new Uint8Array(await file.arrayBuffer());
    } else if (
        contentType.includes('application/octet-stream') ||
        contentType.includes('application/x-sqlite3')
    ) {
        // Handle raw binary upload
        buffer = new Uint8Array(await context.req.arrayBuffer());
    } else {
        return context.json({
            success: false,
            error: 'Invalid content type. Use multipart/form-data or application/octet-stream',
            error_code: 'VALIDATION_ERROR',
        }, 400);
    }

    if (buffer.length === 0) {
        return context.json({
            success: false,
            error: 'Empty file provided',
            error_code: 'VALIDATION_ERROR',
        }, 400);
    }

    // Run import within transaction
    const result = await runTransaction(systemInit, async (system) => {
        return await system.database.importAll(buffer, {
            strategy,
            models,
            include,
        });
    });

    return context.json({
        success: true,
        data: result,
    });
}
