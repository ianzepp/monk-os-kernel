/**
 * ping - Send requests to a target in a loop
 *
 * Usage:
 *   ping [options] <target>
 *
 * Targets:
 *   /health              - Ping the local API health endpoint
 *   /api/data/users      - Ping any local API path
 *   http://example.com   - Ping an external URL
 *
 * Options:
 *   -c <count>    Stop after <count> pings (default: infinite)
 *   -i <interval> Seconds between pings (default: 1)
 *
 * Examples:
 *   ping /health
 *   ping -c 5 /health
 *   ping -i 2 http://google.com
 *   ping /health > /var/log/ping.log &
 */

import type { CommandHandler } from './shared.js';
import { createHttpApp } from '@src/servers/http.js';
import type { Hono } from 'hono';

/**
 * Format bytes for display (like ping output)
 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ping: CommandHandler = async (session, _fs, args, io) => {
    // Parse arguments
    let count = 0; // 0 = infinite
    let interval = 1; // seconds
    let target = '';

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-c' && args[i + 1]) {
            count = parseInt(args[++i], 10);
            if (isNaN(count) || count < 1) {
                io.stderr.write('ping: invalid count\n');
                return 1;
            }
        } else if (arg === '-i' && args[i + 1]) {
            interval = parseFloat(args[++i]);
            if (isNaN(interval) || interval < 0.1) {
                io.stderr.write('ping: invalid interval (min 0.1s)\n');
                return 1;
            }
        } else if (!arg.startsWith('-')) {
            target = arg;
        }
    }

    if (!target) {
        io.stderr.write('Usage: ping [options] <target>\n');
        io.stderr.write('  ping /health           - Ping local API\n');
        io.stderr.write('  ping http://google.com - Ping external URL\n');
        io.stderr.write('Options:\n');
        io.stderr.write('  -c <count>    Stop after count pings\n');
        io.stderr.write('  -i <interval> Seconds between pings (default: 1)\n');
        return 1;
    }

    // Determine if local or external
    const isExternal = target.startsWith('http://') || target.startsWith('https://');
    const displayTarget = isExternal ? new URL(target).host : 'localhost';

    io.stdout.write(`PING ${displayTarget} (${target})\n`);

    // Stats tracking
    let transmitted = 0;
    let received = 0;
    let totalTime = 0;
    let minTime = Infinity;
    let maxTime = 0;

    // Get the Hono app for local requests
    let app: Hono | null = null;
    if (!isExternal) {
        app = createHttpApp();
    }

    // Ping loop
    let seq = 1;
    const maxPings = count || Infinity;

    while (seq <= maxPings) {
        // Check for abort signal (background process killed)
        if (io.signal?.aborted) {
            break;
        }

        transmitted++;
        const start = performance.now();

        try {
            let status: number;
            let bytes: number;

            if (isExternal) {
                // External HTTP request (HEAD for speed)
                const response = await fetch(target, {
                    method: 'HEAD',
                    signal: AbortSignal.timeout(10000),
                });
                status = response.status;
                // Use content-length header if available, otherwise 0
                bytes = parseInt(response.headers.get('content-length') || '0', 10);
            } else {
                // Local in-process request via Hono
                const url = `http://localhost${target}`;
                const headers: Record<string, string> = {
                    'Accept': 'application/json',
                };

                // Forward auth if available
                if (session.systemInit) {
                    // We don't have the JWT directly, but we can make unauthenticated requests
                    // For /health this is fine
                }

                const request = new Request(url, { method: 'GET', headers });
                const response = await app!.fetch(request);
                status = response.status;
                const body = await response.text();
                bytes = new TextEncoder().encode(body).length;
            }

            const elapsed = performance.now() - start;
            const timeMs = elapsed.toFixed(1);

            // Update stats
            received++;
            totalTime += elapsed;
            minTime = Math.min(minTime, elapsed);
            maxTime = Math.max(maxTime, elapsed);

            // Output like real ping
            const statusText = status === 200 ? '' : ` [${status}]`;
            io.stdout.write(
                `${formatBytes(bytes)} from ${displayTarget}: seq=${seq} time=${timeMs}ms${statusText}\n`
            );
        } catch (err) {
            const elapsed = performance.now() - start;
            const message = err instanceof Error ? err.message : String(err);

            // Timeout or network error
            if (message.includes('timeout') || message.includes('abort')) {
                io.stdout.write(`Request timeout for seq ${seq}\n`);
            } else {
                io.stdout.write(`From ${displayTarget}: seq=${seq} error: ${message}\n`);
            }
        }

        seq++;

        // Wait before next ping (unless we're done)
        if (seq <= maxPings && !io.signal?.aborted) {
            await sleep(interval * 1000);
        }
    }

    // Print statistics
    const loss = transmitted > 0
        ? (((transmitted - received) / transmitted) * 100).toFixed(1)
        : '0.0';

    io.stdout.write(`\n--- ${displayTarget} ping statistics ---\n`);
    io.stdout.write(
        `${transmitted} packets transmitted, ${received} received, ${loss}% packet loss\n`
    );

    if (received > 0) {
        const avg = (totalTime / received).toFixed(1);
        io.stdout.write(
            `rtt min/avg/max = ${minTime.toFixed(1)}/${avg}/${maxTime.toFixed(1)} ms\n`
        );
    }

    return received === transmitted ? 0 : 1;
};
