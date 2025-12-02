/**
 * Monk OS JSON Daemon (jsond)
 *
 * JSONL-over-TCP/WebSocket API server.
 * Scans /usr/api/ops for handlers and serves the API.
 *
 * Configuration via environment:
 *   JSOND_TCP_PORT - TCP port (default: 9000)
 *   JSOND_WS_PORT  - WebSocket port (default: 9001)
 *   JSOND_HOST     - Bind host (default: 0.0.0.0)
 *   JSOND_OPS_DIR  - Ops directory (default: /usr/api/ops)
 */

import { createApi } from '@usr/lib/api';
import { getenv, exit } from '@rom/lib/process';

async function main(): Promise<void> {
    // Read configuration from environment
    const tcpPort = parseInt(await getenv('JSOND_TCP_PORT') ?? '9000', 10);
    const wsPort = parseInt(await getenv('JSOND_WS_PORT') ?? '9001', 10);
    const host = await getenv('JSOND_HOST') ?? '0.0.0.0';
    const opsDir = await getenv('JSOND_OPS_DIR') ?? '/usr/api/ops';

    console.info('[jsond] Starting JSON daemon...');
    console.info(`[jsond] Configuration:`);
    console.info(`[jsond]   TCP port: ${tcpPort}`);
    console.info(`[jsond]   WS port:  ${wsPort}`);
    console.info(`[jsond]   Host:     ${host}`);
    console.info(`[jsond]   Ops dir:  ${opsDir}`);

    // Create API server
    const api = createApi();

    // Scan for handlers
    try {
        await api.scan(opsDir);
        console.info(`[jsond] Scanned ${opsDir} for handlers`);
    } catch (err) {
        console.warn(`[jsond] Could not scan ${opsDir}:`, err);
        // Continue anyway - handlers can be added explicitly
    }

    // TODO: Add middleware configuration
    // api.use('*', requestLogger);
    // api.use('data:*', requireAuth, withTenant);

    // Built-in health check
    api.op('health').handler(async function* () {
        yield { op: 'ok', data: { status: 'up', timestamp: Date.now() } };
    });

    // Built-in ping
    api.op('ping').handler(async function* () {
        yield { op: 'ok', data: { pong: true } };
    });

    // Start listening
    await api.listen({
        tcp: tcpPort,
        ws: wsPort,
        host,
    });

    console.info('[jsond] Server started successfully');

    // Keep running (server runs in background)
    // In a real daemon, we'd handle signals here
}

// Run
main().catch(async (err) => {
    console.error('[jsond] Fatal error:', err);
    await exit(1);
});
