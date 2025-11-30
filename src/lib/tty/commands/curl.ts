/**
 * curl - Transfer data from or to a server
 *
 * Usage:
 *   curl [options] <url>
 *
 * Options:
 *   -X <method>        HTTP method (GET, POST, PUT, DELETE, PATCH)
 *   -H <header>        Add header (repeatable)
 *   -d <data>          Request body (use @- for stdin)
 *   -o <file>          Write output to file
 *   -i                 Include response headers
 *   -s                 Silent mode (no progress/errors)
 *   -v                 Verbose (show request details)
 *   -L                 Follow redirects
 *
 * URL formats:
 *   /api/data/users              Internal API (uses session auth)
 *   https://example.com/api      External URL
 *
 * Examples:
 *   curl /api/data/users
 *   curl -X POST -d '{"name":"bob"}' /api/data/users
 *   curl https://api.example.com/data
 *   select id, name from users | curl -X POST https://webhook.com/import
 *   curl https://external.com/data | insert /api/data/records
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';
import type { SystemInit } from '@src/lib/system.js';

export const curl: CommandHandler = async (session, fs, args, io) => {
    // Parse options
    let method = 'GET';
    const headers: Record<string, string> = {};
    let data: string | null = null;
    let outputFile: string | null = null;
    let includeHeaders = false;
    let silent = false;
    let verbose = false;
    let followRedirects = false;
    let url: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '-X' && i + 1 < args.length) {
            method = args[++i].toUpperCase();
        } else if (arg === '-H' && i + 1 < args.length) {
            const header = args[++i];
            const colonIndex = header.indexOf(':');
            if (colonIndex > 0) {
                const name = header.slice(0, colonIndex).trim();
                const value = header.slice(colonIndex + 1).trim();
                headers[name] = value;
            }
        } else if (arg === '-d' && i + 1 < args.length) {
            data = args[++i];
        } else if (arg === '-o' && i + 1 < args.length) {
            outputFile = args[++i];
        } else if (arg === '-i') {
            includeHeaders = true;
        } else if (arg === '-s') {
            silent = true;
        } else if (arg === '-v') {
            verbose = true;
        } else if (arg === '-L') {
            followRedirects = true;
        } else if (!arg.startsWith('-')) {
            url = arg;
        }
    }

    if (!url) {
        io.stderr.write('curl: missing URL\n');
        io.stderr.write('Usage: curl [options] <url>\n');
        return 1;
    }

    // Read body from stdin if -d @- or if stdin has data and no -d
    if (data === '@-' || (data === null && !io.stdin.readableEnded)) {
        const chunks: string[] = [];
        // Only read if there's actually data (check if stdin is a pipe)
        if (data === '@-') {
            for await (const chunk of io.stdin) {
                chunks.push(chunk.toString());
            }
            data = chunks.join('');
        } else {
            // Check if stdin has data without blocking
            io.stdin.once('readable', () => {
                // There's data available
            });
            // Small timeout to see if data arrives
            await new Promise(resolve => setTimeout(resolve, 10));
            if (io.stdin.readableLength > 0) {
                for await (const chunk of io.stdin) {
                    chunks.push(chunk.toString());
                }
                data = chunks.join('');
            }
        }
    }

    // Determine if internal or external
    const isInternal = url.startsWith('/');
    const isExternal = url.startsWith('http://') || url.startsWith('https://');

    if (!isInternal && !isExternal) {
        io.stderr.write(`curl: unsupported URL format: ${url}\n`);
        io.stderr.write('Use /path for internal API or https://... for external\n');
        return 1;
    }

    try {
        let response: Response;

        if (isInternal) {
            response = await callInternal(session.systemInit!, method, url, headers, data, verbose, io);
        } else {
            response = await callExternal(method, url, headers, data, followRedirects, verbose, io);
        }

        // Handle response
        if (verbose) {
            io.stderr.write(`< HTTP/${response.status} ${response.statusText}\n`);
        }

        if (includeHeaders) {
            io.stdout.write(`HTTP/1.1 ${response.status} ${response.statusText}\n`);
            response.headers.forEach((value, name) => {
                io.stdout.write(`${name}: ${value}\n`);
            });
            io.stdout.write('\n');
        }

        const body = await response.text();

        if (outputFile) {
            if (!fs) {
                io.stderr.write('curl: filesystem not available for -o\n');
                return 1;
            }
            const resolved = resolvePath(session.cwd, outputFile);
            await fs.write(resolved, body);
            if (!silent) {
                io.stderr.write(`Saved to ${outputFile}\n`);
            }
        } else {
            io.stdout.write(body);
            // Add newline if body doesn't end with one
            if (body && !body.endsWith('\n')) {
                io.stdout.write('\n');
            }
        }

        if (!response.ok && !silent) {
            io.stderr.write(`curl: HTTP ${response.status}\n`);
            return 1;
        }

        return 0;
    } catch (err) {
        if (!silent) {
            if (err instanceof Error) {
                io.stderr.write(`curl: ${err.message}\n`);
            } else {
                io.stderr.write(`curl: ${String(err)}\n`);
            }
        }
        return 1;
    }
};

/**
 * Call internal API via Hono
 */
async function callInternal(
    systemInit: SystemInit,
    method: string,
    path: string,
    headers: Record<string, string>,
    data: string | null,
    verbose: boolean,
    io: any
): Promise<Response> {
    const app = getHonoApp();
    if (!app) {
        throw new Error('Internal API not available');
    }

    // Generate JWT from session's systemInit
    const token = await JWTGenerator.fromSystemInit(systemInit);

    const requestHeaders: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        ...headers,
    };

    if (data && !requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json';
    }

    if (verbose) {
        io.stderr.write(`> ${method} ${path}\n`);
        for (const [name, value] of Object.entries(requestHeaders)) {
            if (name.toLowerCase() !== 'authorization') {
                io.stderr.write(`> ${name}: ${value}\n`);
            } else {
                io.stderr.write(`> ${name}: Bearer [token]\n`);
            }
        }
        io.stderr.write('>\n');
    }

    const init: RequestInit = {
        method,
        headers: requestHeaders,
    };

    if (data && !['GET', 'HEAD'].includes(method)) {
        init.body = data;
    }

    const request = new Request(`http://localhost${path}`, init);
    return app.fetch(request);
}

/**
 * Call external URL via fetch
 */
async function callExternal(
    method: string,
    url: string,
    headers: Record<string, string>,
    data: string | null,
    followRedirects: boolean,
    verbose: boolean,
    io: any
): Promise<Response> {
    if (verbose) {
        const urlObj = new URL(url);
        io.stderr.write(`> ${method} ${urlObj.pathname}${urlObj.search}\n`);
        io.stderr.write(`> Host: ${urlObj.host}\n`);
        for (const [name, value] of Object.entries(headers)) {
            io.stderr.write(`> ${name}: ${value}\n`);
        }
        io.stderr.write('>\n');
    }

    const init: RequestInit = {
        method,
        headers,
        redirect: followRedirects ? 'follow' : 'manual',
    };

    if (data && !['GET', 'HEAD'].includes(method)) {
        init.body = data;
        if (!headers['Content-Type']) {
            (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
    }

    return fetch(url, init);
}
