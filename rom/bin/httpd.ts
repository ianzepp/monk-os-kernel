/**
 * Monk OS HTTP Daemon
 *
 * Socket-activated HTTP service. Each connection spawns a new instance
 * with the socket as fd 0/1/2 (like inetd).
 *
 * This is a minimal implementation that:
 * - Reads the HTTP request
 * - Sends a simple response
 *
 * No routing, no file serving, just a basic "it works" response.
 */

import { write, exit, getenv, read } from '@rom/lib/process';
import { ByteReader } from '@rom/lib/io';

// Buffered reader for stdin
const reader = new ByteReader(read(0));

/**
 * Read HTTP request headers
 */
async function readRequest(): Promise<{ method: string; path: string; headers: Map<string, string> }> {
    // Read request line: "GET /path HTTP/1.1"
    const requestLine = await reader.readLine();
    const [method, path] = (requestLine ?? '').split(' ');

    // Read headers until empty line
    const headers = new Map<string, string>();
    while (true) {
        const line = await reader.readLine();
        if (line === null || line === '') break;

        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
            const name = line.slice(0, colonIndex).trim().toLowerCase();
            const value = line.slice(colonIndex + 1).trim();
            headers.set(name, value);
        }
    }

    return { method: method ?? 'GET', path: path ?? '/', headers };
}

/**
 * Send HTTP response
 */
async function sendResponse(status: number, statusText: string, body: string, contentType = 'text/html'): Promise<void> {
    const headers = [
        `HTTP/1.1 ${status} ${statusText}`,
        `Content-Type: ${contentType}`,
        `Content-Length: ${new TextEncoder().encode(body).length}`,
        'Connection: close',
        '',
        body,
    ].join('\r\n');

    await write(0, new TextEncoder().encode(headers));
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
    try {
        const request = await readRequest();
        const hostname = await getenv('HOSTNAME') ?? 'monk';

        // Simple routing
        if (request.path === '/health') {
            await sendResponse(200, 'OK', 'OK', 'text/plain');
        } else {
            const html = `<!DOCTYPE html>
<html>
<head>
    <title>Monk OS</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        pre { background: #f5f5f5; padding: 15px; border-radius: 5px; }
    </style>
</head>
<body>
    <h1>Welcome to ${hostname}</h1>
    <p>Monk OS HTTP Server is running.</p>
    <pre>
Method: ${request.method}
Path:   ${request.path}
    </pre>
</body>
</html>`;

            await sendResponse(200, 'OK', html);
        }

        await exit(0);
    } catch (err) {
        // Try to send error response
        try {
            await sendResponse(500, 'Internal Server Error', 'Internal Server Error', 'text/plain');
        } catch {
            // Connection likely closed
        }
        await exit(1);
    }
}

// Run
main().catch(async (err) => {
    try {
        const msg = err instanceof Error ? err.message : String(err);
        await write(2, new TextEncoder().encode(`httpd: ${msg}\r\n`));
    } catch {
        // Ignore write errors
    }
    await exit(1);
});
