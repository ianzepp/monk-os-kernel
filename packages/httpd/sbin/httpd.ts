/**
 * Monk OS HTTP Server (Kernel Process)
 *
 * A simple HTTP server that runs as a kernel process using syscalls.
 * Serves static files from a configurable VFS root directory.
 *
 * Configuration via environment:
 *   PORT        - Listen port (default: 8080)
 *   HTTPD_ROOT  - VFS root directory to serve (default: /var/www)
 *
 * @module packages/httpd/sbin/httpd
 */

import {
    listen,
    portRecv,
    pclose,
    open,
    read,
    write,
    close,
    stat,
    getenv,
    println,
    exit,
    onSignal,
    SIGTERM,
} from '@rom/lib/process';

// =============================================================================
// CONSTANTS
// =============================================================================

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ts': 'text/typescript; charset=utf-8',
};

// =============================================================================
// HTTP HELPERS
// =============================================================================

function getContentType(path: string): string {
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function formatResponse(status: number, statusText: string, headers: Record<string, string>, body?: Uint8Array): Uint8Array {
    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const head = `HTTP/1.1 ${status} ${statusText}\r\n${headerLines}\r\n\r\n`;
    const headBytes = new TextEncoder().encode(head);

    if (!body) {
        return headBytes;
    }

    const result = new Uint8Array(headBytes.length + body.length);
    result.set(headBytes, 0);
    result.set(body, headBytes.length);
    return result;
}

function jsonResponse(status: number, statusText: string, data: unknown): Uint8Array {
    const body = new TextEncoder().encode(JSON.stringify(data));
    return formatResponse(status, statusText, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
        'Connection': 'close',
    }, body);
}

function textResponse(status: number, statusText: string, text: string): Uint8Array {
    const body = new TextEncoder().encode(text);
    return formatResponse(status, statusText, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(body.length),
        'Connection': 'close',
    }, body);
}

function fileResponse(contentType: string, body: Uint8Array): Uint8Array {
    return formatResponse(200, 'OK', {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        'Connection': 'close',
    }, body);
}

// =============================================================================
// REQUEST PARSING
// =============================================================================

interface HttpRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
}

function parseRequest(data: Uint8Array): HttpRequest | null {
    const text = new TextDecoder().decode(data);
    const lines = text.split('\r\n');
    const requestLine = lines[0];

    if (!requestLine) return null;

    const [method, path] = requestLine.split(' ');
    if (!method || !path) return null;

    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line === '') break;
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const key = line.substring(0, colonIdx).trim().toLowerCase();
            const value = line.substring(colonIdx + 1).trim();
            headers[key] = value;
        }
    }

    return { method, path, headers };
}

// =============================================================================
// REQUEST HANDLER
// =============================================================================

async function handleRequest(fd: number, root: string): Promise<void> {
    try {
        // Read request (simple: just read first chunk)
        const chunks: Uint8Array[] = [];
        for await (const chunk of read(fd)) {
            chunks.push(chunk);
            // HTTP request ends with \r\n\r\n, check if we have it
            const combined = concatUint8Arrays(chunks);
            if (new TextDecoder().decode(combined).includes('\r\n\r\n')) {
                break;
            }
            // Limit request size
            if (combined.length > 8192) break;
        }

        const requestData = concatUint8Arrays(chunks);
        const req = parseRequest(requestData);

        if (!req) {
            await write(fd, textResponse(400, 'Bad Request', 'Invalid HTTP request'));
            return;
        }

        // Only handle GET
        if (req.method !== 'GET') {
            await write(fd, textResponse(405, 'Method Not Allowed', 'Only GET is supported'));
            return;
        }

        // Parse path (remove query string)
        let pathname = req.path.split('?')[0] ?? '/';

        // Health check endpoint
        if (pathname === '/health') {
            await write(fd, jsonResponse(200, 'OK', { status: 'ok', timestamp: Date.now() }));
            return;
        }

        // Prevent path traversal
        if (pathname.includes('..')) {
            await write(fd, textResponse(403, 'Forbidden', 'Path traversal not allowed'));
            return;
        }

        // Default to index.html for directories
        if (pathname.endsWith('/')) {
            pathname += 'index.html';
        }

        // Build VFS path
        const vfsPath = root + pathname;

        // Try to serve file
        try {
            const fileStat = await stat(vfsPath);

            // If directory, try index.html
            if (fileStat.model === 'folder') {
                const indexPath = vfsPath + '/index.html';
                await serveFile(fd, indexPath);
                return;
            }

            await serveFile(fd, vfsPath);
        } catch {
            await write(fd, textResponse(404, 'Not Found', `File not found: ${pathname}`));
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            await write(fd, textResponse(500, 'Internal Server Error', msg));
        } catch {
            // Connection may be closed
        }
    } finally {
        await close(fd);
    }
}

async function serveFile(fd: number, path: string): Promise<void> {
    const fileFd = await open(path, { read: true });
    try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of read(fileFd)) {
            chunks.push(chunk);
        }
        const content = concatUint8Arrays(chunks);
        const contentType = getContentType(path);
        await write(fd, fileResponse(contentType, content));
    } finally {
        await close(fileFd);
    }
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

// =============================================================================
// MAIN
// =============================================================================

let running = true;
let portHandle: number | null = null;

onSignal((signal) => {
    if (signal === SIGTERM) {
        running = false;
        if (portHandle !== null) {
            pclose(portHandle).catch(() => {});
        }
    }
});

async function main(): Promise<void> {
    // Get configuration from environment
    const portStr = await getenv('PORT') ?? '8080';
    const port = parseInt(portStr, 10);
    const root = await getenv('HTTPD_ROOT') ?? '/var/www';

    // Create TCP listener
    portHandle = await listen({ port });
    await println(`httpd: listening on port ${port} (root: ${root})`);

    // Accept loop
    while (running) {
        try {
            const msg = await portRecv(portHandle);

            if (msg.fd !== undefined) {
                // Handle request (don't await - handle concurrently)
                handleRequest(msg.fd, root).catch((err) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    println(`httpd: request error: ${errMsg}`).catch(() => {});
                });
            }
        } catch (err) {
            if (!running) break;
            const msg = err instanceof Error ? err.message : String(err);
            await println(`httpd: accept error: ${msg}`);
        }
    }

    // Cleanup
    if (portHandle !== null) {
        await pclose(portHandle);
    }
    await println('httpd: stopped');
    await exit(0);
}

// Run
main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    await println(`httpd: fatal: ${msg}`);
    await exit(1);
});
