import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { BunHttpChannel } from '@src/hal/channel/http.js';
import { collectItems } from '@src/message.js';
import type { Response } from '@src/message.js';
import type { Server } from 'bun';

describe('HTTP Channel', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(() => {
        server = Bun.serve({
            port: 0, // Random available port
            fetch(req) {
                const url = new URL(req.url);

                // JSON endpoint
                if (url.pathname === '/users' && req.method === 'GET') {
                    return Response.json([
                        { id: 1, name: 'Alice' },
                        { id: 2, name: 'Bob' },
                    ]);
                }

                // Single user
                if (url.pathname === '/users/1' && req.method === 'GET') {
                    return Response.json({ id: 1, name: 'Alice' });
                }

                // POST endpoint
                if (url.pathname === '/users' && req.method === 'POST') {
                    return req.json().then((body) => {
                        return Response.json({ id: 3, ...body }, { status: 201 });
                    });
                }

                // Query params endpoint
                if (url.pathname === '/search') {
                    const q = url.searchParams.get('q');
                    const limit = url.searchParams.get('limit');
                    return Response.json({ query: q, limit: Number(limit) });
                }

                // Echo headers endpoint
                if (url.pathname === '/headers') {
                    const headers: Record<string, string> = {};
                    req.headers.forEach((value, key) => {
                        headers[key] = value;
                    });
                    return Response.json(headers);
                }

                // JSONL streaming endpoint
                if (url.pathname === '/events') {
                    const encoder = new TextEncoder();
                    const stream = new ReadableStream({
                        start(controller) {
                            controller.enqueue(encoder.encode('{"type":"start"}\n'));
                            controller.enqueue(encoder.encode('{"type":"data","value":1}\n'));
                            controller.enqueue(encoder.encode('{"type":"data","value":2}\n'));
                            controller.enqueue(encoder.encode('{"type":"end"}\n'));
                            controller.close();
                        },
                    });
                    return new Response(stream, {
                        headers: { 'content-type': 'application/jsonl' },
                    });
                }

                // SSE streaming endpoint
                if (url.pathname === '/sse') {
                    const encoder = new TextEncoder();
                    const stream = new ReadableStream({
                        start(controller) {
                            controller.enqueue(encoder.encode('event: message\n'));
                            controller.enqueue(encoder.encode('data: {"text":"hello"}\n\n'));
                            controller.enqueue(encoder.encode('event: update\n'));
                            controller.enqueue(encoder.encode('data: {"count":42}\n\n'));
                            controller.close();
                        },
                    });
                    return new Response(stream, {
                        headers: { 'content-type': 'text/event-stream' },
                    });
                }

                // Error endpoints
                if (url.pathname === '/not-found') {
                    return new Response('Not Found', { status: 404 });
                }

                if (url.pathname === '/server-error') {
                    return new Response('Internal Server Error', { status: 500 });
                }

                // Slow endpoint for timeout testing
                if (url.pathname === '/slow') {
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            resolve(Response.json({ delayed: true }));
                        }, 2000);
                    });
                }

                return new Response('Not Found', { status: 404 });
            },
        });

        baseUrl = `http://localhost:${server.port}`;
    });

    afterAll(() => {
        server.stop();
    });

    describe('JSON requests', () => {
        it('should GET JSON array', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/users' },
            })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0].op).toBe('ok');
            expect(responses[0].data).toEqual([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]);

            await channel.close();
        });

        it('should GET single JSON object', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/users/1' },
            })) {
                responses.push(r);
            }

            expect(responses[0].op).toBe('ok');
            expect(responses[0].data).toEqual({ id: 1, name: 'Alice' });

            await channel.close();
        });

        it('should POST with JSON body', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: {
                    method: 'POST',
                    path: '/users',
                    body: { name: 'Carol', email: 'carol@example.com' },
                },
            })) {
                responses.push(r);
            }

            expect(responses[0].op).toBe('ok');
            expect(responses[0].data).toEqual({
                id: 3,
                name: 'Carol',
                email: 'carol@example.com',
            });

            await channel.close();
        });
    });

    describe('query parameters', () => {
        it('should include query params in request', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: {
                    method: 'GET',
                    path: '/search',
                    query: { q: 'test', limit: 10 },
                },
            })) {
                responses.push(r);
            }

            expect(responses[0].op).toBe('ok');
            expect(responses[0].data).toEqual({ query: 'test', limit: 10 });

            await channel.close();
        });
    });

    describe('headers', () => {
        it('should send default headers from channel options', async () => {
            const channel = new BunHttpChannel(baseUrl, {
                headers: { 'x-api-key': 'secret123' },
            });

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/headers' },
            })) {
                responses.push(r);
            }

            expect(responses[0].op).toBe('ok');
            expect((responses[0].data as Record<string, string>)['x-api-key']).toBe('secret123');

            await channel.close();
        });

        it('should merge request headers with defaults', async () => {
            const channel = new BunHttpChannel(baseUrl, {
                headers: { 'x-default': 'default-value' },
            });

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: {
                    method: 'GET',
                    path: '/headers',
                    headers: { 'x-request': 'request-value' },
                },
            })) {
                responses.push(r);
            }

            const headers = responses[0].data as Record<string, string>;
            expect(headers['x-default']).toBe('default-value');
            expect(headers['x-request']).toBe('request-value');

            await channel.close();
        });
    });

    describe('JSONL streaming', () => {
        it('should stream JSONL as item responses', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const items = await collectItems(
                channel.handle({
                    op: 'request',
                    data: { method: 'GET', path: '/events', accept: 'application/jsonl' },
                })
            );

            expect(items).toHaveLength(4);
            expect(items[0]).toEqual({ type: 'start' });
            expect(items[1]).toEqual({ type: 'data', value: 1 });
            expect(items[2]).toEqual({ type: 'data', value: 2 });
            expect(items[3]).toEqual({ type: 'end' });

            await channel.close();
        });

        it('should detect JSONL from content-type header', async () => {
            const channel = new BunHttpChannel(baseUrl);

            // Don't set accept header, rely on content-type detection
            const items = await collectItems(
                channel.handle({
                    op: 'request',
                    data: { method: 'GET', path: '/events' },
                })
            );

            expect(items).toHaveLength(4);

            await channel.close();
        });
    });

    describe('SSE streaming', () => {
        it('should stream SSE as event responses', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/sse' },
            })) {
                responses.push(r);
            }

            // Filter out the done response
            const events = responses.filter((r) => r.op === 'event');
            expect(events).toHaveLength(2);
            // respond.event(type, data) spreads data: { type, ...data }
            expect(events[0].data).toEqual({ type: 'message', text: 'hello' });
            expect(events[1].data).toEqual({ type: 'update', count: 42 });

            // Should end with done
            expect(responses[responses.length - 1].op).toBe('done');

            await channel.close();
        });
    });

    describe('error handling', () => {
        it('should return error for 404', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/not-found' },
            })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0].op).toBe('error');
            expect((responses[0].data as { code: string }).code).toBe('HTTP_404');

            await channel.close();
        });

        it('should return error for 500', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/server-error' },
            })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0].op).toBe('error');
            expect((responses[0].data as { code: string }).code).toBe('HTTP_500');

            await channel.close();
        });

        it('should return error for unknown op', async () => {
            const channel = new BunHttpChannel(baseUrl);

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'unknown',
                data: {},
            })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0].op).toBe('error');
            expect((responses[0].data as { code: string }).code).toBe('EINVAL');

            await channel.close();
        });
    });

    describe('timeout', () => {
        it('should timeout slow requests', async () => {
            const channel = new BunHttpChannel(baseUrl, { timeout: 100 });

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/slow' },
            })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0].op).toBe('error');
            expect((responses[0].data as { code: string }).code).toBe('ETIMEDOUT');

            await channel.close();
        });
    });

    describe('channel state', () => {
        it('should report closed status', async () => {
            const channel = new BunHttpChannel(baseUrl);
            expect(channel.closed).toBe(false);
            await channel.close();
            expect(channel.closed).toBe(true);
        });

        it('should return error when used after close', async () => {
            const channel = new BunHttpChannel(baseUrl);
            await channel.close();

            const responses: Response[] = [];
            for await (const r of channel.handle({
                op: 'request',
                data: { method: 'GET', path: '/users' },
            })) {
                responses.push(r);
            }

            expect(responses[0].op).toBe('error');
            expect((responses[0].data as { code: string }).code).toBe('EBADF');
        });
    });

    describe('channel metadata', () => {
        it('should have correct protocol', () => {
            const channel = new BunHttpChannel(baseUrl);
            expect(channel.proto).toBe('http');
        });

        it('should have description matching URL', () => {
            const channel = new BunHttpChannel(baseUrl);
            expect(channel.description).toBe(baseUrl);
        });

        it('should have unique id', () => {
            const channel = new BunHttpChannel(baseUrl);
            expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
        });
    });

    describe('push/recv not supported', () => {
        it('should throw on push', async () => {
            const channel = new BunHttpChannel(baseUrl);
            await expect(channel.push({ op: 'ok' })).rejects.toThrow(
                'HTTP client channels do not support push'
            );
        });

        it('should throw on recv', async () => {
            const channel = new BunHttpChannel(baseUrl);
            await expect(channel.recv()).rejects.toThrow(
                'HTTP client channels do not support recv'
            );
        });
    });
});
