/**
 * Monk OS JSON Daemon (Kernel Process)
 *
 * A NDJSON-over-TCP API server that runs as a kernel process using syscalls.
 * Provides VFS operations (stat, list, read) as JSON message ops.
 *
 * Protocol:
 *   - Client sends NDJSON messages: { "op": "...", "data": { ... } }
 *   - Server responds with NDJSON: { "op": "ok|error|item|done", "data": ... }
 *
 * Configuration via environment:
 *   PORT        - Listen port (default: 9000)
 *   JSOND_ROOT  - VFS root for data ops (default: /data)
 *
 * @module packages/jsond/sbin/jsond
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
    readdir,
    getenv,
    println,
    exit,
    onSignal,
    SIGTERM,
} from '@rom/lib/process';

// =============================================================================
// TYPES
// =============================================================================

interface Message {
    op: string;
    data?: unknown;
}

interface Response {
    op: 'ok' | 'error' | 'item' | 'done';
    data?: unknown;
}

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

function respond(response: Response): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(response) + '\n');
}

function ok(data?: unknown): Uint8Array {
    return respond({ op: 'ok', data });
}

function error(code: string, message: string): Uint8Array {
    return respond({ op: 'error', data: { code, message } });
}

function item(data: unknown): Uint8Array {
    return respond({ op: 'item', data });
}

function done(): Uint8Array {
    return respond({ op: 'done' });
}

// =============================================================================
// MESSAGE PARSING
// =============================================================================

function parseMessage(line: string): Message | null {
    try {
        const msg = JSON.parse(line);
        if (typeof msg !== 'object' || !msg || typeof msg.op !== 'string') {
            return null;
        }
        return msg as Message;
    } catch {
        return null;
    }
}

// =============================================================================
// OP HANDLERS
// =============================================================================

type OpData = Record<string, unknown>;

async function handleOp(op: string, data: OpData, root: string, fd: number): Promise<void> {
    switch (op) {
        case 'ping':
            await write(fd, ok({ pong: Date.now() }));
            break;

        case 'stat':
            await handleStat(data, root, fd);
            break;

        case 'list':
            await handleList(data, root, fd);
            break;

        case 'read':
            await handleRead(data, root, fd);
            break;

        default:
            await write(fd, error('UNKNOWN_OP', `Unknown operation: ${op}`));
    }
}

async function handleStat(data: OpData, root: string, fd: number): Promise<void> {
    const path = data.path;
    if (typeof path !== 'string') {
        await write(fd, error('INVALID_PATH', 'path must be a string'));
        return;
    }

    // Prevent path traversal
    if (path.includes('..')) {
        await write(fd, error('FORBIDDEN', 'Path traversal not allowed'));
        return;
    }

    const vfsPath = root + (path.startsWith('/') ? path : '/' + path);

    try {
        const result = await stat(vfsPath);
        await write(fd, ok({
            name: result.name,
            model: result.model,
            size: result.size,
            mtime: result.mtime,
            ctime: result.ctime,
        }));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await write(fd, error('NOT_FOUND', msg));
    }
}

async function handleList(data: OpData, root: string, fd: number): Promise<void> {
    const path = data.path;
    if (typeof path !== 'string') {
        await write(fd, error('INVALID_PATH', 'path must be a string'));
        return;
    }

    // Prevent path traversal
    if (path.includes('..')) {
        await write(fd, error('FORBIDDEN', 'Path traversal not allowed'));
        return;
    }

    const vfsPath = root + (path.startsWith('/') ? path : '/' + path);

    try {
        for await (const entry of readdir(vfsPath)) {
            await write(fd, item({
                name: entry.name,
                model: entry.model,
                size: entry.size,
            }));
        }
        await write(fd, done());
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await write(fd, error('NOT_FOUND', msg));
    }
}

async function handleRead(data: OpData, root: string, fd: number): Promise<void> {
    const path = data.path;
    if (typeof path !== 'string') {
        await write(fd, error('INVALID_PATH', 'path must be a string'));
        return;
    }

    // Prevent path traversal
    if (path.includes('..')) {
        await write(fd, error('FORBIDDEN', 'Path traversal not allowed'));
        return;
    }

    const vfsPath = root + (path.startsWith('/') ? path : '/' + path);

    try {
        const fileFd = await open(vfsPath, { read: true });
        try {
            const chunks: Uint8Array[] = [];
            for await (const chunk of read(fileFd)) {
                chunks.push(chunk);
            }
            const content = concatUint8Arrays(chunks);
            const text = new TextDecoder().decode(content);

            // Try to parse as JSON, otherwise return as string
            try {
                const parsed = JSON.parse(text);
                await write(fd, ok(parsed));
            } catch {
                // Return as trimmed string (field values have trailing newline)
                await write(fd, ok(text.trim()));
            }
        } finally {
            await close(fileFd);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await write(fd, error('NOT_FOUND', msg));
    }
}

// =============================================================================
// CONNECTION HANDLER
// =============================================================================

async function handleConnection(fd: number, root: string): Promise<void> {
    let buffer = '';

    try {
        for await (const chunk of read(fd)) {
            buffer += new TextDecoder().decode(chunk);

            // Process complete lines
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);

                if (!line) continue;

                const msg = parseMessage(line);
                if (!msg) {
                    await write(fd, error('PARSE_ERROR', 'Invalid JSON message'));
                    continue;
                }

                await handleOp(msg.op, (msg.data as OpData) ?? {}, root, fd);
            }

            // Limit buffer size
            if (buffer.length > 65536) {
                await write(fd, error('OVERFLOW', 'Message too large'));
                break;
            }
        }
    } catch (err) {
        // Connection closed or error
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('closed') && !msg.includes('reset')) {
            println(`jsond: connection error: ${msg}`).catch(() => {});
        }
    } finally {
        await close(fd);
    }
}

// =============================================================================
// HELPERS
// =============================================================================

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
    const portStr = await getenv('PORT') ?? '9000';
    const port = parseInt(portStr, 10);
    const root = await getenv('JSOND_ROOT') ?? '/data';

    // Create TCP listener
    portHandle = await listen({ port });
    await println(`jsond: listening on port ${port} (root: ${root})`);

    // Accept loop
    while (running) {
        try {
            const msg = await portRecv(portHandle);

            if (msg.fd !== undefined) {
                // Handle connection (don't await - handle concurrently)
                handleConnection(msg.fd, root).catch((err) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    println(`jsond: connection error: ${errMsg}`).catch(() => {});
                });
            }
        } catch (err) {
            if (!running) break;
            const msg = err instanceof Error ? err.message : String(err);
            await println(`jsond: accept error: ${msg}`);
        }
    }

    // Cleanup
    if (portHandle !== null) {
        await pclose(portHandle);
    }
    await println('jsond: stopped');
    await exit(0);
}

// Run
main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    await println(`jsond: fatal: ${msg}`);
    await exit(1);
});
