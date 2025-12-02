/**
 * API Server
 *
 * JSONL-over-TCP/WebSocket server for the Monk OS API framework.
 * Uses the Message/Response protocol from @src/message.
 */

import type { Message, Response } from '@src/message';
import type { ApiServer, Connection, ListenOptions, Middleware, OpContext, OpRoute, User } from './types';
import { OpRouter, notFoundHandler } from './router';

/**
 * Generate a unique connection ID.
 */
function generateId(): string {
    return crypto.randomUUID();
}

/**
 * Parse a JSONL line into a Message.
 */
function parseMessage(line: string): Message | null {
    try {
        const parsed = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.op === 'string') {
            return parsed as Message;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Serialize a Response to JSONL.
 */
function serializeResponse(response: Response): string {
    return JSON.stringify(response) + '\n';
}

/**
 * Create an API server instance.
 */
export function createApi(): ApiServer {
    const router = new OpRouter();
    let tcpServer: ReturnType<typeof Bun.listen> | null = null;
    let wsServer: ReturnType<typeof Bun.serve> | null = null;

    /**
     * Handle a single message from a connection.
     */
    async function handleMessage(conn: Connection, msg: Message): Promise<void> {
        // Resolve handler
        const resolved = await router.resolve(msg.op);
        const handler = resolved?.handler ?? notFoundHandler;
        const params = resolved?.params ?? {};

        // Build context
        const ctx: OpContext = {
            conn,
            msg,
            params,
        };

        // Execute handler and stream responses
        try {
            for await (const response of handler(ctx)) {
                await conn.send(response);
            }
        } catch (err) {
            // Send error response
            const errorResponse: Response = {
                op: 'error',
                data: {
                    code: 'INTERNAL_ERROR',
                    message: err instanceof Error ? err.message : String(err),
                },
            };
            await conn.send(errorResponse);
        }
    }

    /**
     * Handle a TCP socket connection.
     */
    function handleTcpSocket(socket: ReturnType<typeof Bun.listen> extends { socket: infer S } ? S : never): void {
        const connId = generateId();
        let buffer = '';

        const conn: Connection = {
            id: connId,
            meta: {},

            async send(response: Response): Promise<void> {
                const data = serializeResponse(response);
                socket.write(data);
            },

            async close(): Promise<void> {
                socket.end();
            },
        };

        socket.data = { conn };

        // Note: actual socket handling is done in the Bun.listen callbacks
    }

    /**
     * Scan a directory for op handlers.
     */
    async function scanDirectory(dir: string): Promise<void> {
        const { readdir } = await import('@rom/lib/process');

        async function walk(currentDir: string, prefix: string): Promise<void> {
            const entries = await readdir(currentDir);

            for (const entry of entries) {
                const fullPath = `${currentDir}/${entry}`;

                // Check if directory (simple heuristic: no extension)
                if (!entry.includes('.')) {
                    await walk(fullPath, prefix ? `${prefix}:${entry}` : entry);
                } else if (entry.endsWith('.ts')) {
                    const opName = entry.replace(/\.ts$/, '');
                    const op = prefix ? `${prefix}:${opName}` : opName;
                    router.op(op).pipe(fullPath);
                }
            }
        }

        await walk(dir, '');
    }

    const server: ApiServer = {
        async scan(dir: string): Promise<void> {
            await scanDirectory(dir);
        },

        use(pattern: string, ...middleware: Middleware[]): void {
            router.use(pattern, ...middleware);
        },

        op(pattern: string): OpRoute {
            return router.op(pattern);
        },

        async listen(opts: ListenOptions): Promise<void> {
            const host = opts.host ?? '0.0.0.0';

            // TCP server
            if (opts.tcp) {
                tcpServer = Bun.listen({
                    hostname: host,
                    port: opts.tcp,

                    socket: {
                        data(socket, data) {
                            const conn = (socket.data as { conn: Connection }).conn;
                            const text = new TextDecoder().decode(data);

                            // Append to buffer and process complete lines
                            let buffer = (socket.data as { buffer?: string }).buffer ?? '';
                            buffer += text;

                            const lines = buffer.split('\n');
                            // Keep incomplete line in buffer
                            (socket.data as { buffer: string }).buffer = lines.pop() ?? '';

                            for (const line of lines) {
                                if (line.trim()) {
                                    const msg = parseMessage(line);
                                    if (msg) {
                                        handleMessage(conn, msg).catch((err) => {
                                            console.error('Handler error:', err);
                                        });
                                    } else {
                                        conn.send({
                                            op: 'error',
                                            data: { code: 'PARSE_ERROR', message: 'Invalid JSON message' },
                                        }).catch(() => {});
                                    }
                                }
                            }
                        },

                        open(socket) {
                            const connId = generateId();
                            const conn: Connection = {
                                id: connId,
                                meta: {},

                                async send(response: Response): Promise<void> {
                                    socket.write(serializeResponse(response));
                                },

                                async close(): Promise<void> {
                                    socket.end();
                                },
                            };

                            socket.data = { conn, buffer: '' };
                            console.info(`[jsond] TCP connection opened: ${connId}`);
                        },

                        close(socket) {
                            const conn = (socket.data as { conn: Connection })?.conn;
                            if (conn) {
                                console.info(`[jsond] TCP connection closed: ${conn.id}`);
                            }
                        },

                        error(socket, error) {
                            console.error('[jsond] TCP socket error:', error);
                        },
                    },
                });

                console.info(`[jsond] Listening on TCP ${host}:${opts.tcp}`);
            }

            // WebSocket server
            if (opts.ws) {
                wsServer = Bun.serve({
                    hostname: host,
                    port: opts.ws,

                    fetch(req, server) {
                        // Upgrade to WebSocket
                        if (server.upgrade(req)) {
                            return;
                        }
                        return new Response('WebSocket upgrade required', { status: 426 });
                    },

                    websocket: {
                        message(ws, message) {
                            const conn = (ws.data as { conn: Connection }).conn;
                            const text = typeof message === 'string' ? message : new TextDecoder().decode(message);

                            // WebSocket messages are already framed, process each line
                            for (const line of text.split('\n')) {
                                if (line.trim()) {
                                    const msg = parseMessage(line);
                                    if (msg) {
                                        handleMessage(conn, msg).catch((err) => {
                                            console.error('Handler error:', err);
                                        });
                                    } else {
                                        conn.send({
                                            op: 'error',
                                            data: { code: 'PARSE_ERROR', message: 'Invalid JSON message' },
                                        }).catch(() => {});
                                    }
                                }
                            }
                        },

                        open(ws) {
                            const connId = generateId();
                            const conn: Connection = {
                                id: connId,
                                meta: {},

                                async send(response: Response): Promise<void> {
                                    ws.send(serializeResponse(response));
                                },

                                async close(): Promise<void> {
                                    ws.close();
                                },
                            };

                            ws.data = { conn };
                            console.info(`[jsond] WebSocket connection opened: ${connId}`);
                        },

                        close(ws) {
                            const conn = (ws.data as { conn: Connection })?.conn;
                            if (conn) {
                                console.info(`[jsond] WebSocket connection closed: ${conn.id}`);
                            }
                        },
                    },
                });

                console.info(`[jsond] Listening on WebSocket ${host}:${opts.ws}`);
            }
        },

        async close(): Promise<void> {
            if (tcpServer) {
                tcpServer.stop();
                tcpServer = null;
            }
            if (wsServer) {
                wsServer.stop();
                wsServer = null;
            }
        },
    };

    return server;
}

// Re-export types
export type { ApiServer, Connection, OpContext, OpHandler, Middleware, OpRoute, User } from './types';
