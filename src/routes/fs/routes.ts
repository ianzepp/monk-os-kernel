/**
 * FS HTTP Routes
 *
 * Minimal HTTP interface to the Filesystem.
 * Uses only auth + context middleware (no body parsing, format detection, or response transformation).
 *
 * Routes:
 * - GET /fs/*    → read (file) or readdir (directory), with ?stat for metadata only
 * - PUT /fs/*    → write
 * - DELETE /fs/* → unlink
 */

import type { Context } from 'hono';
import type { SystemInit } from '@src/lib/system.js';
import { runTransaction } from '@src/lib/transaction.js';
import { FSError } from '@src/lib/fs/index.js';
import { fsErrorToHttp } from '@src/lib/errors/http-error.js';

/**
 * Extract FS path from request URL
 * /fs/api/data/users → /api/data/users
 */
function extractPath(c: Context): string {
    const url = new URL(c.req.url);
    const fullPath = url.pathname;
    // Remove /fs prefix
    return fullPath.replace(/^\/fs/, '') || '/';
}

/**
 * Convert FSError to HTTP response
 */
function errorResponse(c: Context, err: FSError) {
    const httpError = fsErrorToHttp(err);
    return c.json(
        { error: err.code, path: err.path, message: err.message },
        httpError.statusCode as any
    );
}

/** Result types for FS operations */
type FsResult =
    | { type: 'stat'; data: object }
    | { type: 'directory'; data: object }
    | { type: 'file'; content: string; contentType: string }
    | { type: 'binary'; content: Uint8Array }
    | { type: 'success'; path: string }
    | { type: 'error'; error: FSError };

/**
 * GET /fs/* - Read file or list directory
 *
 * Query params:
 * - ?stat=true - Return metadata only (like HEAD but as JSON)
 */
export async function FsGet(c: Context) {
    const systemInit = c.get('systemInit') as SystemInit;
    const path = extractPath(c);
    const statOnly = c.req.query('stat') === 'true';

    try {
        const result = await runTransaction(systemInit, async (system): Promise<FsResult> => {
            try {
                const entry = await system.fs.stat(path);

                // If stat-only mode, return metadata
                if (statOnly) {
                    return {
                        type: 'stat',
                        data: {
                            name: entry.name,
                            type: entry.type,
                            size: entry.size,
                            mode: entry.mode.toString(8),
                            mtime: entry.mtime?.toISOString(),
                            ctime: entry.ctime?.toISOString(),
                        },
                    };
                }

                if (entry.type === 'directory') {
                    // List directory
                    const entries = await system.fs.readdir(path);
                    return {
                        type: 'directory',
                        data: {
                            type: 'directory',
                            path,
                            entries: entries.map(e => ({
                                name: e.name,
                                type: e.type,
                                size: e.size,
                                mode: e.mode.toString(8),
                                mtime: e.mtime?.toISOString(),
                                ctime: e.ctime?.toISOString(),
                            })),
                        },
                    };
                }

                // Read file
                const content = await system.fs.read(path);

                if (typeof content === 'string') {
                    // Detect content type
                    let contentType = 'text/plain';
                    if (content.startsWith('{') || content.startsWith('[')) {
                        contentType = 'application/json';
                    } else if (content.includes(': ') || content.startsWith('---')) {
                        contentType = 'text/yaml';
                    }
                    return { type: 'file', content, contentType };
                }

                // Binary content
                return { type: 'binary', content: new Uint8Array(content) };

            } catch (err) {
                if (err instanceof FSError) {
                    return { type: 'error', error: err };
                }
                throw err;
            }
        });

        // Build response based on result type
        switch (result.type) {
            case 'stat':
            case 'directory':
                return c.json(result.data);
            case 'file':
                c.header('Content-Type', result.contentType);
                return c.body(result.content);
            case 'binary':
                c.header('Content-Type', 'application/octet-stream');
                return new Response(result.content, {
                    headers: { 'Content-Type': 'application/octet-stream' },
                });
            case 'error':
                return errorResponse(c, result.error);
        }
    } catch (err) {
        if (err instanceof FSError) {
            return errorResponse(c, err);
        }
        throw err;
    }
}

/**
 * PUT /fs/* - Write file
 */
export async function FsPut(c: Context) {
    const systemInit = c.get('systemInit') as SystemInit;
    const path = extractPath(c);
    const content = await c.req.text();

    try {
        const result = await runTransaction(systemInit, async (system): Promise<FsResult> => {
            try {
                await system.fs.write(path, content);
                return { type: 'success', path };
            } catch (err) {
                if (err instanceof FSError) {
                    return { type: 'error', error: err };
                }
                throw err;
            }
        });

        if (result.type === 'error') {
            return errorResponse(c, result.error);
        }

        return c.json({ success: true, path });
    } catch (err) {
        if (err instanceof FSError) {
            return errorResponse(c, err);
        }
        throw err;
    }
}

/**
 * DELETE /fs/* - Delete file or directory
 *
 * Automatically detects if target is a file (unlink) or directory (rmdir).
 */
export async function FsDelete(c: Context) {
    const systemInit = c.get('systemInit') as SystemInit;
    const path = extractPath(c);

    try {
        const result = await runTransaction(systemInit, async (system): Promise<FsResult> => {
            try {
                // Check if target is a directory or file
                const entry = await system.fs.stat(path);

                if (entry.type === 'directory') {
                    await system.fs.rmdir(path);
                } else {
                    await system.fs.unlink(path);
                }
                return { type: 'success', path };
            } catch (err) {
                if (err instanceof FSError) {
                    return { type: 'error', error: err };
                }
                throw err;
            }
        });

        if (result.type === 'error') {
            return errorResponse(c, result.error);
        }

        return c.json({ success: true, path });
    } catch (err) {
        if (err instanceof FSError) {
            return errorResponse(c, err);
        }
        throw err;
    }
}
