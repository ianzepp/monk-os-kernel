/**
 * Monk OS HTTP Server
 *
 * A simple HTTP server that serves files from VFS.
 * This is a "host" service that runs directly on Bun.
 */

import type { Server } from 'bun';
import type { VFS } from '@src/vfs/vfs.js';

export interface HttpdConfig {
    port?: number;
    hostname?: string;
    root?: string;
    env?: Record<string, string>;
    vfs?: VFS;
    onRequest?: (req: Request) => Response | Promise<Response>;
}

export interface HttpdInstance {
    readonly port: number;
    readonly hostname: string;
    stop(): void;
}

/**
 * Content-type mapping by extension.
 */
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
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.ts': 'text/typescript; charset=utf-8',
    '.tsx': 'text/typescript; charset=utf-8',
};

/**
 * Get content type for a file path.
 */
function getContentType(path: string): string {
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Create the default handler (when no root is configured).
 */
function createDefaultHandler(): (req: Request) => Response {
    return (req: Request) => {
        const url = new URL(req.url);

        if (url.pathname === '/health') {
            return Response.json({ status: 'ok', timestamp: Date.now() });
        }

        if (url.pathname === '/') {
            return new Response(
                `Monk OS httpd\n\nEndpoints:\n  GET /health - Health check\n\nNo document root configured.\n`,
                { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
            );
        }

        return new Response('Not Found', { status: 404 });
    };
}

/**
 * Create a VFS file-serving handler.
 */
function createVfsHandler(vfs: VFS, root: string): (req: Request) => Promise<Response> {
    return async (req: Request) => {
        const url = new URL(req.url);
        let pathname = url.pathname;

        // Health check always available
        if (pathname === '/health') {
            return Response.json({ status: 'ok', timestamp: Date.now() });
        }

        // Normalize path
        if (pathname.endsWith('/')) {
            pathname += 'index.html';
        }

        // Prevent path traversal
        if (pathname.includes('..')) {
            return new Response('Forbidden', { status: 403 });
        }

        // Build VFS path
        const vfsPath = root + pathname;

        try {
            // Try to stat the path
            const stat = await vfs.stat(vfsPath, 'kernel');

            // If it's a directory, try index.html
            if (stat.type === 'folder') {
                const indexPath = vfsPath + '/index.html';
                try {
                    await vfs.stat(indexPath, 'kernel');
                    return await serveFile(vfs, indexPath);
                } catch {
                    // No index.html - could list directory or 404
                    return new Response('Forbidden', { status: 403 });
                }
            }

            // Serve the file
            return await serveFile(vfs, vfsPath);
        } catch (err) {
            const error = err as Error & { code?: string };
            if (error.code === 'ENOENT') {
                return new Response('Not Found', { status: 404 });
            }
            console.error(`httpd: error serving ${vfsPath}:`, error.message);
            return new Response('Internal Server Error', { status: 500 });
        }
    };
}

/**
 * Serve a file from VFS.
 */
async function serveFile(vfs: VFS, path: string): Promise<Response> {
    const handle = await vfs.open(path, { read: true }, 'kernel');
    try {
        const content = await handle.read();
        const contentType = getContentType(path);

        return new Response(content, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(content.length),
            },
        });
    } finally {
        await handle.close();
    }
}

/**
 * Start the HTTP server.
 *
 * Port resolution order:
 * 1. config.port (explicit)
 * 2. config.env.PORT (OS environment)
 * 3. Default 8080
 */
export function start(config: HttpdConfig = {}): HttpdInstance {
    const env = config.env ?? {};
    const port = config.port ?? parseInt(env.PORT ?? '8080', 10);
    const hostname = config.hostname ?? env.HTTPD_HOSTNAME ?? 'localhost';

    // Determine the request handler
    let handler: (req: Request) => Response | Promise<Response>;

    if (config.onRequest) {
        // Custom handler provided
        handler = config.onRequest;
    } else if (config.root && config.vfs) {
        // Serve files from VFS
        handler = createVfsHandler(config.vfs, config.root);
    } else {
        // Default handler
        handler = createDefaultHandler();
    }

    const server: Server = Bun.serve({
        port,
        hostname,
        fetch: handler,
    });

    const rootInfo = config.root ? ` (root: ${config.root})` : '';
    console.log(`httpd: listening on http://${hostname}:${port}${rootInfo}`);

    return {
        port: server.port,
        hostname: server.hostname,
        stop() {
            server.stop();
            console.log(`httpd: stopped`);
        },
    };
}
