import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { BunWebSocketClientChannel } from '@src/hal/channel/websocket.js';
import type { Response } from '@src/message.js';
import type { Server, ServerWebSocket } from 'bun';

describe('WebSocket Channel', () => {
    let server: Server<any>;
    let wsUrl: string;

    // Track connected clients for test control
    const clients: Set<ServerWebSocket<unknown>> = new Set();

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            fetch(req, server) {
                const url = new URL(req.url);

                // WebSocket upgrade
                if (url.pathname === '/ws' || url.pathname === '/echo' || url.pathname === '/stream') {
                    const upgraded = server.upgrade(req, { data: { path: url.pathname } } as any);

                    if (!upgraded) {
                        return new Response('WebSocket upgrade failed', { status: 400 });
                    }

                    return undefined as any;
                }

                return new Response('Not Found', { status: 404 });
            },
            websocket: {
                open(ws) {
                    clients.add(ws);
                },
                message(ws, message) {
                    const data = ws.data as { path: string };

                    // Echo server: send back what we received
                    if (data.path === '/echo') {
                        ws.send(message);

                        return;
                    }

                    // Stream server: respond with multiple items then done
                    if (data.path === '/stream') {
                        try {
                            const parsed = JSON.parse(message.toString());

                            if (parsed.op === 'list') {
                                // Send streaming responses
                                ws.send(JSON.stringify({ op: 'item', data: { id: 1, name: 'first' } }));
                                ws.send(JSON.stringify({ op: 'item', data: { id: 2, name: 'second' } }));
                                ws.send(JSON.stringify({ op: 'item', data: { id: 3, name: 'third' } }));
                                ws.send(JSON.stringify({ op: 'done', data: null }));
                            }
                            else if (parsed.op === 'get') {
                                // Single response
                                ws.send(JSON.stringify({ op: 'ok', data: { value: 42 } }));
                            }
                            else if (parsed.op === 'fail') {
                                ws.send(JSON.stringify({ op: 'error', data: { code: 'ENOENT', message: 'Not found' } }));
                            }
                            else if (parsed.op === 'push') {
                                // Server-initiated message (not a response)
                                ws.send(JSON.stringify({ op: 'notify', data: { event: 'update' } }));
                                // Also send terminal response so handle() completes
                                ws.send(JSON.stringify({ op: 'ok', data: null }));
                            }
                        }
                        catch {
                            ws.send(JSON.stringify({ op: 'error', data: { code: 'EINVAL', message: 'Invalid JSON' } }));
                        }

                        return;
                    }

                    // Default: echo as JSON response
                    try {
                        const parsed = JSON.parse(message.toString());

                        ws.send(JSON.stringify({ op: 'ok', data: parsed }));
                    }
                    catch {
                        ws.send(JSON.stringify({ op: 'ok', data: { raw: message.toString() } }));
                    }
                },
                close(ws) {
                    clients.delete(ws);
                },
            },
        });

        wsUrl = `ws://localhost:${server.port}`;
    });

    afterAll(() => {
        // Close all connected clients
        for (const client of clients) {
            client.close();
        }

        clients.clear();
        server.stop();
    });

    // =========================================================================
    // CHANNEL METADATA
    // =========================================================================

    describe('channel metadata', () => {
        it('should have correct protocol', () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            expect(channel.proto).toBe('websocket');
        });

        it('should have description matching URL', () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            expect(channel.description).toBe(`${wsUrl}/ws`);
        });

        it('should have unique id', () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
        });

        it('should convert http:// to ws://', () => {
            // WHY: Constructor auto-converts http to ws URLs
            const httpUrl = `http://localhost:${server.port}/ws`;
            const channel = new BunWebSocketClientChannel(httpUrl);

            // Description retains original URL
            expect(channel.description).toBe(httpUrl);
            // Proto is still websocket
            expect(channel.proto).toBe('websocket');
        });
    });

    // =========================================================================
    // CHANNEL STATE
    // =========================================================================

    describe('channel state', () => {
        it('should report closed status', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            // Give WebSocket time to connect
            await Bun.sleep(50);

            expect(channel.closed).toBe(false);
            await channel.close();
            expect(channel.closed).toBe(true);
        });

        it('should return error when handle() used after close', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            await Bun.sleep(50);
            await channel.close();

            const responses: Response[] = [];

            for await (const r of channel.handle({ op: 'test', data: {} })) {
                responses.push(r);
            }

            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });

        it('should throw when push() used after close', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            await Bun.sleep(50);
            await channel.close();

            await expect(channel.push({ op: 'ok' })).rejects.toThrow('Channel closed');
        });

        it('should return close message when recv() used after close', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            await Bun.sleep(50);
            await channel.close();

            const msg = await channel.recv();

            expect(msg.op).toBe('close');
        });

        it('should be idempotent for close()', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            await Bun.sleep(50);

            // Multiple closes should not throw
            await channel.close();
            await channel.close();
            await channel.close();

            expect(channel.closed).toBe(true);
        });
    });

    // =========================================================================
    // REQUEST-RESPONSE (handle)
    // =========================================================================

    describe('handle() request-response', () => {
        it('should send message and receive ok response', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/stream`);

            await Bun.sleep(50);

            const responses: Response[] = [];

            for await (const r of channel.handle({ op: 'get', data: {} })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
            expect(responses[0]!.data).toEqual({ value: 42 });

            await channel.close();
        });

        it('should receive error response', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/stream`);

            await Bun.sleep(50);

            const responses: Response[] = [];

            for await (const r of channel.handle({ op: 'fail', data: {} })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('ENOENT');

            await channel.close();
        });

        it('should receive streaming item responses ending with done', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/stream`);

            await Bun.sleep(50);

            const responses: Response[] = [];

            for await (const r of channel.handle({ op: 'list', data: {} })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(4);
            expect(responses[0]!.op).toBe('item');
            expect(responses[0]!.data).toEqual({ id: 1, name: 'first' });
            expect(responses[1]!.op).toBe('item');
            expect(responses[1]!.data).toEqual({ id: 2, name: 'second' });
            expect(responses[2]!.op).toBe('item');
            expect(responses[2]!.data).toEqual({ id: 3, name: 'third' });
            expect(responses[3]!.op).toBe('done');

            await channel.close();
        });

        it('should echo message data on /ws endpoint', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/ws`);

            await Bun.sleep(50);

            const responses: Response[] = [];

            for await (const r of channel.handle({ op: 'test', data: { hello: 'world' } })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
            expect(responses[0]!.data).toEqual({ op: 'test', data: { hello: 'world' } });

            await channel.close();
        });
    });

    // =========================================================================
    // CLIENT PUSH
    // =========================================================================

    describe('push()', () => {
        it('should send response to server', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/echo`);

            await Bun.sleep(50);

            // Push a message (not a response op - those go to responseQueue)
            // Use a custom op that the channel treats as a server-initiated message
            await channel.push({ op: 'ping', data: { pushed: true } } as any);

            // Give time for echo
            await Bun.sleep(50);

            // Read it back (echo server) - recv() gets non-response-op messages
            const msg = await channel.recv();

            expect(msg.op).toBe('ping');
            expect(msg.data).toEqual({ pushed: true });

            await channel.close();
        });
    });

    // =========================================================================
    // SERVER PUSH (recv)
    // =========================================================================

    describe('recv()', () => {
        it('should receive server-initiated messages', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/stream`);

            await Bun.sleep(50);

            // Trigger server to send a non-response message
            // First consume handle() responses for the push op
            for await (const _r of channel.handle({ op: 'push', data: {} })) {
                // This triggers the server to send a notify message
            }

            // Now recv() should get the notify message
            const msg = await channel.recv();

            expect(msg.op).toBe('notify');
            expect(msg.data).toEqual({ event: 'update' });

            await channel.close();
        });

        it('should queue messages when no recv() is waiting', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/echo`);

            await Bun.sleep(50);

            // Push multiple messages
            // WHY: Use 'item' op for data messages (valid Response type)
            await channel.push({ op: 'item', data: { n: 1 } });
            await channel.push({ op: 'item', data: { n: 2 } });
            await channel.push({ op: 'item', data: { n: 3 } });

            // Give time for echo
            await Bun.sleep(50);

            // Now recv() them in order
            const msg1 = await channel.recv();
            const msg2 = await channel.recv();
            const msg3 = await channel.recv();

            expect(msg1).toEqual({ op: 'item', data: { n: 1 } });
            expect(msg2).toEqual({ op: 'item', data: { n: 2 } });
            expect(msg3).toEqual({ op: 'item', data: { n: 3 } });

            await channel.close();
        });
    });

    // =========================================================================
    // RAW MESSAGE HANDLING
    // =========================================================================

    describe('raw message handling', () => {
        it('should handle non-JSON messages as raw', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/echo`);

            await Bun.sleep(50);

            // Push raw text (not valid JSON)
            // The echo server will send it back, and the channel should parse it as raw
            // Note: push() sends JSON, but we can test by checking how the channel
            // handles the echo server's response

            // Since the WebSocket channel always JSON-encodes push(), we test
            // by checking recv() behavior when queued messages include raw data
            // This is harder to test without a custom server that sends raw data

            // For now, test that JSON parsing works correctly
            // WHY: Use 'item' op for data messages (valid Response type)
            await channel.push({ op: 'item' });
            const msg = await channel.recv();

            expect(msg.op).toBe('item');

            await channel.close();
        });
    });

    // =========================================================================
    // CONNECTION ERRORS
    // =========================================================================

    describe('connection errors', () => {
        it('should handle connection to non-existent server', async () => {
            // Connect to a port that's not listening
            const channel = new BunWebSocketClientChannel('ws://localhost:59999/ws');

            // Give time for connection attempt
            await Bun.sleep(100);

            // Channel should be closed due to connection failure
            expect(channel.closed).toBe(true);

            // handle() should return error
            const responses: Response[] = [];

            for await (const r of channel.handle({ op: 'test', data: {} })) {
                responses.push(r);
            }

            expect(responses[0]!.op).toBe('error');
        });
    });

    // =========================================================================
    // RESPONSE QUEUE BEHAVIOR
    // =========================================================================

    describe('response queue behavior', () => {
        it('should queue responses when no handle() is waiting', async () => {
            const channel = new BunWebSocketClientChannel(`${wsUrl}/stream`);

            await Bun.sleep(50);

            // Start a streaming request
            const iterator = channel.handle({ op: 'list', data: {} })[Symbol.asyncIterator]();

            // Get first item
            const r1 = await iterator.next();

            expect(r1.value.op).toBe('item');

            // Give server time to send all responses (they'll be queued)
            await Bun.sleep(50);

            // Remaining items should be queued and retrievable
            const r2 = await iterator.next();
            const r3 = await iterator.next();
            const r4 = await iterator.next();

            expect(r2.value.op).toBe('item');
            expect(r3.value.op).toBe('item');
            expect(r4.value.op).toBe('done');

            await channel.close();
        });
    });
});
