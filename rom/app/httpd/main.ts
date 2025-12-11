/**
 * httpd - Static File Server
 *
 * Serves static files from the userspace /cdn directory over HTTP.
 * The /cdn directory is dynamically mounted into the VFS by the OS
 * from a host directory.
 *
 * Configuration via environment:
 *   HTTPD_PORT - Port to listen on (default: 8080)
 *   HTTPD_ROOT - Root directory to serve (default: /cdn)
 *
 * Supported MIME types are inferred from file extensions.
 */

import {
    call,
    getpid,
    getenv,
    println,
    eprintln,
    onSignal,
    stat,
    readFileBytes,
} from '@rom/lib/process/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface HttpRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
}

// =============================================================================
// MIME TYPES
// =============================================================================

const MIME_TYPES: Record<string, string> = {
    // Text
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',

    // Images
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.avif': 'image/avif',

    // Fonts
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',

    // Audio/Video
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',

    // Documents
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.wasm': 'application/wasm',

    // Source maps
    '.map': 'application/json',
};

/**
 * Get MIME type for a file path based on extension.
 */
function getMimeType(path: string): string {
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();

    return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// =============================================================================
// REQUEST HANDLING
// =============================================================================

/**
 * Handle an HTTP request and return a response.
 */
async function handleRequest(
    root: string,
    request: HttpRequest,
): Promise<{ status: number; headers?: Record<string, string>; body?: unknown }> {
    // Only GET and HEAD are supported
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return {
            status: 405,
            headers: { 'Allow': 'GET, HEAD' },
            body: { error: 'Method Not Allowed' },
        };
    }

    // Normalize and validate path
    let filePath = request.path;

    // Prevent directory traversal
    if (filePath.includes('..') || filePath.includes('\0')) {
        return {
            status: 400,
            body: { error: 'Bad Request' },
        };
    }

    // Default to index.html for root
    if (filePath === '/') {
        filePath = '/index.html';
    }

    // Build full path
    const fullPath = root + filePath;

    // Check if file exists
    try {
        const info = await stat(fullPath);

        // Directories: try index.html, otherwise 404
        if (info.type === 'folder') {
            const indexPath = fullPath + '/index.html';

            try {
                await stat(indexPath);

                return handleRequest(root, { ...request, path: filePath + '/index.html' });
            }
            catch {
                return {
                    status: 404,
                    body: { error: 'Not Found' },
                };
            }
        }

        // Read file content (skip for HEAD)
        let body: Uint8Array | undefined;

        if (request.method === 'GET') {
            body = await readFileBytes(fullPath);
        }

        const mimeType = getMimeType(fullPath);

        return {
            status: 200,
            headers: {
                'Content-Type': mimeType,
                'Content-Length': String(info.size),
                'Cache-Control': 'public, max-age=3600',
            },
            body,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // File not found
        if (message.includes('ENOENT') || message.includes('not found')) {
            return {
                status: 404,
                body: { error: 'Not Found', path: filePath },
            };
        }

        // Permission denied
        if (message.includes('EACCES') || message.includes('permission')) {
            return {
                status: 403,
                body: { error: 'Forbidden' },
            };
        }

        // Other errors
        return {
            status: 500,
            body: { error: 'Internal Server Error', message },
        };
    }
}

// =============================================================================
// CONNECTION HANDLING
// =============================================================================

/**
 * Handle a single HTTP connection.
 */
async function handleConnection(root: string, socketFd: number): Promise<void> {
    let channelFd: number | undefined;

    try {
        // Wrap socket in HTTP server channel
        channelFd = await call<number>('channel:accept', socketFd, 'http-server');

        // Receive HTTP request
        const request = await call<HttpRequest>('channel:recv', channelFd);

        // Handle request
        const response = await handleRequest(root, request);

        // Send response
        await call<void>('channel:push', channelFd, { op: 'ok', data: response });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`httpd: connection error: ${message}`);
    }
    finally {
        // Close channel (which closes underlying socket)
        if (channelFd !== undefined) {
            try {
                await call<void>('channel:close', channelFd);
            }
            catch {
                // Ignore close errors
            }
        }
    }
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const pid = await getpid();

    // Configuration from environment
    const portStr = await getenv('HTTPD_PORT') ?? '8080';
    const port = parseInt(portStr, 10);
    const root = await getenv('HTTPD_ROOT') ?? '/cdn';

    await println(`httpd: starting (pid ${pid})`);
    await println(`httpd: serving ${root} on port ${port}`);

    // Handle shutdown
    let running = true;

    onSignal(() => {
        running = false;
        println('httpd: received shutdown signal');
    });

    // Create TCP listener
    let listenerFd: number;

    try {
        listenerFd = await call<number>('port:create', 'tcp:listen', { port });
        await println(`httpd: listening on port ${port}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`httpd: failed to listen on port ${port}: ${message}`);

        return;
    }

    // Accept connections
    while (running) {
        try {
            // Wait for connection (port:recv returns socket fd for tcp:listen)
            const msg = await call<{ fd: number }>('port:recv', listenerFd);
            const socketFd = msg.fd;

            // Handle connection in background (don't await)
            handleConnection(root, socketFd).catch(async err => {
                const message = err instanceof Error ? err.message : String(err);

                await eprintln(`httpd: unhandled error: ${message}`);
            });
        }
        catch (err) {
            if (!running) {
                break;
            }

            const message = err instanceof Error ? err.message : String(err);

            await eprintln(`httpd: accept error: ${message}`);
        }
    }

    // Cleanup
    try {
        await call<void>('port:close', listenerFd);
    }
    catch {
        // Ignore close errors
    }

    await println('httpd: shutdown complete');
}
