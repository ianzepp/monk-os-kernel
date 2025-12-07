import { describe, it, expect } from 'bun:test';
import { BunSSEServerChannel } from '@src/hal/channel/sse.js';
import { respond } from '@src/message.js';
import type { Response } from '@src/message.js';
import type { Socket, SocketStat } from '@src/hal/network/types.js';

// =============================================================================
// MOCK SOCKET
// =============================================================================

/**
 * Mock socket that captures writes for testing SSE output.
 *
 * WHY: SSE channel writes to a raw socket. We need to capture those writes
 * to verify correct SSE formatting.
 */
class MockSocket implements Socket {
    // Captured writes
    readonly writes: Uint8Array[] = [];

    // State
    private _closed = false;

    // Metadata
    private readonly _stat: SocketStat = {
        remoteAddr: '127.0.0.1',
        remotePort: 12345,
        localAddr: '127.0.0.1',
        localPort: 8080,
    };

    get closed(): boolean {
        return this._closed;
    }

    async read(): Promise<Uint8Array> {
        // SSE server channels don't read from socket
        throw new Error('MockSocket read not implemented');
    }

    async write(data: Uint8Array): Promise<void> {
        if (this._closed) {
            throw new Error('Socket closed');
        }

        this.writes.push(data);
    }

    async close(): Promise<void> {
        this._closed = true;
    }

    stat(): SocketStat {
        return this._stat;
    }

    // AsyncDisposable
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    // Helper: Get all writes as a single string
    getOutput(): string {
        const decoder = new TextDecoder();

        return this.writes.map(w => decoder.decode(w)).join('');
    }

    // Helper: Clear writes for reuse
    clear(): void {
        this.writes.length = 0;
    }
}

// =============================================================================
// TESTS
// =============================================================================

describe('SSE Server Channel', () => {
    // =========================================================================
    // CHANNEL METADATA
    // =========================================================================

    describe('channel metadata', () => {
        it('should have correct protocol', () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            expect(channel.proto).toBe('sse');
        });

        it('should have description as sse:server', () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            expect(channel.description).toBe('sse:server');
        });

        it('should have unique id', () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
        });

        it('should have different ids for different channels', () => {
            const socket1 = new MockSocket();
            const socket2 = new MockSocket();
            const channel1 = new BunSSEServerChannel(socket1);
            const channel2 = new BunSSEServerChannel(socket2);

            expect(channel1.id).not.toBe(channel2.id);
        });
    });

    // =========================================================================
    // CHANNEL STATE
    // =========================================================================

    describe('channel state', () => {
        it('should report closed status', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            expect(channel.closed).toBe(false);
            await channel.close();
            expect(channel.closed).toBe(true);
        });

        it('should throw when push() used after close', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.close();

            await expect(channel.push({ op: 'ok' })).rejects.toThrow('Channel closed');
        });

        it('should be idempotent for close()', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            // Multiple closes should not throw
            await channel.close();
            await channel.close();
            await channel.close();

            expect(channel.closed).toBe(true);
        });

        it('should close underlying socket', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.close();

            expect(socket.closed).toBe(true);
        });
    });

    // =========================================================================
    // HTTP HEADERS
    // =========================================================================

    describe('HTTP headers', () => {
        it('should send HTTP headers on first push', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: { test: true } });

            const output = socket.getOutput();

            expect(output).toContain('HTTP/1.1 200 OK');
            expect(output).toContain('Content-Type: text/event-stream');
            expect(output).toContain('Cache-Control: no-cache');
            expect(output).toContain('Connection: keep-alive');

            await channel.close();
        });

        it('should send headers only once', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: { n: 1 } });
            await channel.push({ op: 'ok', data: { n: 2 } });
            await channel.push({ op: 'ok', data: { n: 3 } });

            const output = socket.getOutput();

            // Count occurrences of HTTP/1.1 200 OK
            const headerMatches = output.match(/HTTP\/1\.1 200 OK/g);

            expect(headerMatches).toHaveLength(1);

            await channel.close();
        });

        it('should use CRLF line endings for headers', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: {} });

            const output = socket.getOutput();

            // Check for CRLF between header lines
            expect(output).toContain('HTTP/1.1 200 OK\r\n');
            expect(output).toContain('Content-Type: text/event-stream\r\n');

            await channel.close();
        });
    });

    // =========================================================================
    // SSE EVENT FORMATTING
    // =========================================================================

    describe('SSE event formatting', () => {
        it('should format non-event responses as default data events', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: { message: 'hello' } });

            const output = socket.getOutput();

            // Should have data: line with JSON
            expect(output).toContain('data: {"message":"hello"}');
            // Should end with double newline
            expect(output).toContain('\n\n');

            await channel.close();
        });

        it('should format event responses with event type', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            // Use respond.event() style: { op: 'event', data: { type, ...rest } }
            await channel.push(respond.event('update', { count: 42 }));

            const output = socket.getOutput();

            // Should have event: line followed by data: line
            expect(output).toContain('event: update\n');
            expect(output).toContain('data:');
            expect(output).toContain('"type":"update"');
            expect(output).toContain('"count":42');

            await channel.close();
        });

        it('should format multiple events correctly', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push(respond.event('start', {}));
            await channel.push(respond.item({ id: 1 }));
            await channel.push(respond.item({ id: 2 }));
            await channel.push(respond.event('end', {}));

            const output = socket.getOutput();

            // Should have event types for event ops
            expect(output).toContain('event: start\n');
            expect(output).toContain('event: end\n');

            // Should have data lines for item ops (no event: line)
            // Each event ends with \n\n
            const events = output.split('\n\n').filter(e => e.trim());

            // First is headers, then 4 events
            expect(events.length).toBeGreaterThanOrEqual(4);

            await channel.close();
        });

        it('should JSON-serialize event data', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            const complexData = {
                array: [1, 2, 3],
                nested: { a: { b: { c: true } } },
                unicode: '日本語',
            };

            await channel.push({ op: 'ok', data: complexData });

            const output = socket.getOutput();

            // Extract the data line
            const dataLine = output.split('\n').find(l => l.startsWith('data:'));

            expect(dataLine).toBeDefined();

            // Parse the JSON from the data line
            const json = dataLine!.replace('data: ', '');
            const parsed = JSON.parse(json);

            expect(parsed.array).toEqual([1, 2, 3]);
            expect(parsed.nested.a.b.c).toBe(true);
            expect(parsed.unicode).toBe('日本語');

            await channel.close();
        });
    });

    // =========================================================================
    // HANDLE() NOT SUPPORTED
    // =========================================================================

    describe('handle() not supported', () => {
        it('should return error for handle()', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            const responses: Response[] = [];

            for await (const r of channel.handle({ op: 'test', data: {} })) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EINVAL');
            expect((responses[0]!.data as { message: string }).message).toContain('push()');

            await channel.close();
        });
    });

    // =========================================================================
    // RECV() NOT SUPPORTED
    // =========================================================================

    describe('recv() not supported', () => {
        it('should throw on recv()', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await expect(channel.recv()).rejects.toThrow('SSE server channels do not support recv');

            await channel.close();
        });
    });

    // =========================================================================
    // EDGE CASES
    // =========================================================================

    describe('edge cases', () => {
        it('should handle empty data', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: null });

            const output = socket.getOutput();

            expect(output).toContain('data: null');

            await channel.close();
        });

        it('should handle undefined data', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok' });

            const output = socket.getOutput();

            // undefined becomes undefined in JSON (or omitted)
            expect(output).toContain('data:');

            await channel.close();
        });

        it('should handle string data', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: 'hello world' });

            const output = socket.getOutput();

            expect(output).toContain('data: "hello world"');

            await channel.close();
        });

        it('should handle numeric data', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: 42 });

            const output = socket.getOutput();

            expect(output).toContain('data: 42');

            await channel.close();
        });

        it('should handle boolean data', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push({ op: 'ok', data: true });

            const output = socket.getOutput();

            expect(output).toContain('data: true');

            await channel.close();
        });
    });

    // =========================================================================
    // RESPONSE TYPES
    // =========================================================================

    describe('response types', () => {
        it('should handle ok responses', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push(respond.ok({ result: 'success' }));

            const output = socket.getOutput();

            expect(output).toContain('"result":"success"');

            await channel.close();
        });

        it('should handle item responses', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push(respond.item({ id: 1, name: 'test' }));

            const output = socket.getOutput();

            expect(output).toContain('"id":1');
            expect(output).toContain('"name":"test"');

            await channel.close();
        });

        it('should handle error responses', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push(respond.error('ENOENT', 'File not found'));

            const output = socket.getOutput();

            expect(output).toContain('"code":"ENOENT"');
            expect(output).toContain('"message":"File not found"');

            await channel.close();
        });

        it('should handle done responses', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            await channel.push(respond.done());

            const output = socket.getOutput();

            // Done response should be sent as data
            expect(output).toContain('data:');

            await channel.close();
        });

        it('should handle progress responses', async () => {
            const socket = new MockSocket();
            const channel = new BunSSEServerChannel(socket);

            // respond.progress(percent?, current?, total?)
            await channel.push(respond.progress(50, 100, 200));

            const output = socket.getOutput();

            expect(output).toContain('"percent":50');
            expect(output).toContain('"current":100');
            expect(output).toContain('"total":200');

            await channel.close();
        });
    });
});
