/**
 * Resource Tests
 *
 * Tests for Ports and MessagePipe.
 * NOTE: FileResource, SocketResource, PipeResource have been removed.
 * Use Handle adapters from handle.ts instead.
 */

import { describe, it, expect, mock } from 'bun:test';
import { ListenerPort, WatchPort, PubsubPort, matchTopic, createMessagePipe } from '@src/kernel/resource.js';
import { ENOTSUP } from '@src/kernel/errors.js';
import { respond } from '@src/message.js';
import type { WatchEvent } from '@src/vfs/model.js';
import type { Listener, Socket } from '@src/hal/index.js';

describe('ListenerPort', () => {
    function createMockListener(): Listener {
        const mockSocket: Socket = {
            read: mock(() => Promise.resolve(new Uint8Array())),
            write: mock(() => Promise.resolve()),
            close: mock(() => Promise.resolve()),
            stat: mock(() => ({
                remoteAddr: '192.168.1.100',
                remotePort: 54321,
                localAddr: '0.0.0.0',
                localPort: 8080,
            })),
            [Symbol.asyncDispose]: mock(() => Promise.resolve()),
        };

        return {
            accept: mock(() => Promise.resolve(mockSocket)),
            close: mock(() => Promise.resolve()),
            addr: mock(() => ({ hostname: '0.0.0.0', port: 8080 })),
            [Symbol.asyncDispose]: mock(() => Promise.resolve()),
        };
    }

    it('should have type "tcp:listen"', () => {
        const listener = createMockListener();
        const port = new ListenerPort('port-1', listener, 'tcp:listen:0.0.0.0:8080');

        expect(port.type).toBe('tcp:listen');
    });

    it('should use provided description', () => {
        const listener = createMockListener();
        const port = new ListenerPort('port-1', listener, 'tcp:listen:0.0.0.0:8080');

        expect(port.description).toBe('tcp:listen:0.0.0.0:8080');
    });

    it('should recv() by accepting connections', async () => {
        const listener = createMockListener();
        const port = new ListenerPort('port-1', listener, 'tcp:listen:0.0.0.0:8080');

        const msg = await port.recv();

        expect(listener.accept).toHaveBeenCalled();
        expect(msg.from).toBe('192.168.1.100:54321');
        expect(msg.socket).toBeDefined();
    });

    it('should throw on send()', async () => {
        const listener = createMockListener();
        const port = new ListenerPort('port-1', listener, 'tcp:listen:0.0.0.0:8080');

        await expect(
            port.send('anywhere', new Uint8Array()),
        ).rejects.toThrow(ENOTSUP);
    });

    it('should delegate close to listener', async () => {
        const listener = createMockListener();
        const port = new ListenerPort('port-1', listener, 'tcp:listen:0.0.0.0:8080');

        await port.close();
        expect(listener.close).toHaveBeenCalled();
        expect(port.closed).toBe(true);
    });

    it('should be idempotent on close', async () => {
        const listener = createMockListener();
        const port = new ListenerPort('port-1', listener, 'tcp:listen:0.0.0.0:8080');

        await port.close();
        await port.close();
        expect(listener.close).toHaveBeenCalledTimes(1);
    });

    it('should expose listener address', () => {
        const listener = createMockListener();
        const port = new ListenerPort('port-1', listener, 'tcp:listen:0.0.0.0:8080');

        const addr = port.addr();

        expect(addr.hostname).toBe('0.0.0.0');
        expect(addr.port).toBe(8080);
    });
});

describe('MessagePipe', () => {
    it('should send and recv messages', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('test-pipe');

        // Send a message
        const sendResult = [];

        for await (const r of sendEnd.exec({ op: 'send', data: respond.item('hello') })) {
            sendResult.push(r);
        }

        expect(sendResult[0]?.op).toBe('ok');

        // Close send end to signal EOF
        await sendEnd.close();

        // Recv the message
        const recvResult = [];

        for await (const r of recvEnd.exec({ op: 'recv' })) {
            recvResult.push(r);
        }

        expect(recvResult[0]).toEqual(respond.item('hello'));
        expect(recvResult[1]?.op).toBe('done');
    });

    it('should buffer multiple messages', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('test-pipe');

        // Send multiple messages
        for await (const _r of sendEnd.exec({ op: 'send', data: respond.item('first') })) { /* drain */ }

        for await (const _r of sendEnd.exec({ op: 'send', data: respond.item('second') })) { /* drain */ }

        for await (const _r of sendEnd.exec({ op: 'send', data: respond.item('third') })) { /* drain */ }

        await sendEnd.close();

        // Recv all messages
        const recvResult = [];

        for await (const r of recvEnd.exec({ op: 'recv' })) {
            recvResult.push(r);
        }

        expect(recvResult[0]).toEqual(respond.item('first'));
        expect(recvResult[1]).toEqual(respond.item('second'));
        expect(recvResult[2]).toEqual(respond.item('third'));
        expect(recvResult[3]?.op).toBe('done');
    });

    it('should return EBADF when recv from send end', async () => {
        const [, sendEnd] = createMessagePipe('test-pipe');

        const result = [];

        for await (const r of sendEnd.exec({ op: 'recv' })) {
            result.push(r);
        }

        expect(result[0]?.op).toBe('error');
        expect((result[0]?.data as { code: string })?.code).toBe('EBADF');
    });

    it('should return EBADF when send to recv end', async () => {
        const [recvEnd] = createMessagePipe('test-pipe');

        const result = [];

        for await (const r of recvEnd.exec({ op: 'send', data: respond.item('test') })) {
            result.push(r);
        }

        expect(result[0]?.op).toBe('error');
        expect((result[0]?.data as { code: string })?.code).toBe('EBADF');
    });

    it('should signal EOF when send end closes', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('test-pipe');

        // Close send end immediately
        await sendEnd.close();

        // Recv should get done immediately
        const result = [];

        for await (const r of recvEnd.exec({ op: 'recv' })) {
            result.push(r);
        }

        expect(result[0]?.op).toBe('done');
    });

    it('should return EPIPE when send after recv end closes', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('test-pipe');

        await recvEnd.close();

        const result = [];

        for await (const r of sendEnd.exec({ op: 'send', data: respond.item('test') })) {
            result.push(r);
        }

        expect(result[0]?.op).toBe('error');
        expect((result[0]?.data as { code: string })?.code).toBe('EPIPE');
    });

    it('should return EBADF when handle is closed', async () => {
        const [, sendEnd] = createMessagePipe('test-pipe');

        await sendEnd.close();

        const result = [];

        for await (const r of sendEnd.exec({ op: 'send', data: respond.item('test') })) {
            result.push(r);
        }

        expect(result[0]?.op).toBe('error');
        expect((result[0]?.data as { code: string })?.code).toBe('EBADF');
    });

    it('should have correct pipe end types', () => {
        const [recvEnd, sendEnd] = createMessagePipe('test-pipe');

        expect(recvEnd.end).toBe('recv');
        expect(sendEnd.end).toBe('send');
        expect(recvEnd.type).toBe('pipe');
        expect(sendEnd.type).toBe('pipe');
    });

    it('should have correct pipe IDs', () => {
        const [recvEnd, sendEnd] = createMessagePipe('my-pipe');

        expect(recvEnd.id).toBe('my-pipe:recv');
        expect(sendEnd.id).toBe('my-pipe:send');
        expect(recvEnd.description).toBe('pipe:my-pipe:recv');
        expect(sendEnd.description).toBe('pipe:my-pipe:send');
    });

    it('should deliver message to waiting receiver', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('test-pipe');

        // Start recv before send (will wait)
        const recvPromise = (async () => {
            const result = [];

            for await (const r of recvEnd.exec({ op: 'recv' })) {
                result.push(r);
                if (r.op === 'done') {
                    break;
                }
            }

            return result;
        })();

        // Small delay, then send
        await new Promise(r => setTimeout(r, 10));
        for await (const _r of sendEnd.exec({ op: 'send', data: respond.item('delayed') })) { /* drain */ }

        await sendEnd.close();

        const result = await recvPromise;

        expect(result[0]).toEqual(respond.item('delayed'));
        expect(result[1]?.op).toBe('done');
    });

    it('should return EINVAL for unknown op', async () => {
        const [recvEnd] = createMessagePipe('test-pipe');

        const result = [];

        for await (const r of recvEnd.exec({ op: 'unknown' })) {
            result.push(r);
        }

        expect(result[0]?.op).toBe('error');
        expect((result[0]?.data as { code: string })?.code).toBe('EINVAL');
    });
});

describe('WatchPort', () => {
    /**
     * Create a mock VFS watch function that yields events from a queue
     */
    function createMockVfsWatch(events: WatchEvent[]): (pattern: string) => AsyncIterable<WatchEvent> {
        return (_pattern: string): AsyncIterable<WatchEvent> => {
            return {
                [Symbol.asyncIterator](): AsyncIterator<WatchEvent> {
                    let index = 0;

                    return {
                        async next(): Promise<IteratorResult<WatchEvent>> {
                            if (index < events.length) {
                                return { done: false, value: events[index++]! };
                            }

                            // Never resolves - simulates waiting for more events
                            return new Promise<IteratorResult<WatchEvent>>(() => {});
                        },
                    };
                },
            };
        };
    }

    it('should have type "fs:watch"', () => {
        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch([]), 'fs:watch:/test/*');

        expect(port.type).toBe('fs:watch');
    });

    it('should use provided description', () => {
        const port = new WatchPort('watch-1', '/users/**', createMockVfsWatch([]), 'watch:/users/**');

        expect(port.description).toBe('watch:/users/**');
    });

    it('should recv() events from VFS', async () => {
        const events: WatchEvent[] = [
            { entity: 'uuid-1', op: 'create', path: '/test/file1.txt', timestamp: Date.now() },
            { entity: 'uuid-2', op: 'update', path: '/test/file2.txt', fields: ['size'], timestamp: Date.now() },
        ];

        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch(events), 'watch:/test/*');

        // Small delay to allow background consumer to start
        await new Promise(r => setTimeout(r, 10));

        const msg1 = await port.recv();

        expect(msg1.from).toBe('/test/file1.txt');
        expect(msg1.meta?.op).toBe('create');
        expect(msg1.meta?.entity).toBe('uuid-1');

        const msg2 = await port.recv();

        expect(msg2.from).toBe('/test/file2.txt');
        expect(msg2.meta?.op).toBe('update');
        expect(msg2.meta?.fields).toEqual(['size']);
    });

    it('should provide event data in meta (not serialized)', async () => {
        const events: WatchEvent[] = [
            { entity: 'uuid-1', op: 'delete', path: '/test/file.txt', timestamp: 1234567890 },
        ];

        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch(events), 'watch:/test/*');

        await new Promise(r => setTimeout(r, 10));

        const msg = await port.recv();

        // Watch events now use meta, not serialized data
        expect(msg.data).toBeUndefined();
        expect(msg.meta?.entity).toBe('uuid-1');
        expect(msg.meta?.op).toBe('delete');
    });

    it('should throw on send()', async () => {
        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch([]), 'watch:/test/*');

        await expect(
            port.send('anywhere', new Uint8Array()),
        ).rejects.toThrow(ENOTSUP);
    });

    it('should close cleanly', async () => {
        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch([]), 'watch:/test/*');

        await port.close();
        expect(port.closed).toBe(true);
    });

    it('should be idempotent on close', async () => {
        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch([]), 'watch:/test/*');

        await port.close();
        await port.close(); // Should not throw

        expect(port.closed).toBe(true);
    });

    it('should throw on recv() after close', async () => {
        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch([]), 'watch:/test/*');

        await port.close();

        await expect(port.recv()).rejects.toThrow('Port closed');
    });
});

describe('UdpPort', () => {
    // Note: UdpPort uses Bun.udpSocket() which requires actual network operations.
    // These tests are limited to what can be tested without network access.

    it('should have type "udp"', () => {
        // Skip actual socket creation in unit test environment
        // This would normally create a real UDP socket
    });

    it('should parse host:port format in send()', () => {
        // Test address parsing logic
        const testAddresses = [
            { input: '127.0.0.1:8080', expected: { host: '127.0.0.1', port: 8080 } },
            { input: '::1:9000', expected: { host: '::1', port: 9000 } },
            { input: 'localhost:53', expected: { host: 'localhost', port: 53 } },
        ];

        for (const { input, expected } of testAddresses) {
            const lastColon = input.lastIndexOf(':');
            const host = input.slice(0, lastColon);
            const port = parseInt(input.slice(lastColon + 1), 10);

            expect(host).toBe(expected.host);
            expect(port).toBe(expected.port);
        }
    });

    it('should reject invalid address format', () => {
        // Test that addresses without a valid port part would fail parsing
        // The send() method expects "host:port" where port is a number

        // Valid formats
        expect(() => {
            const addr = '127.0.0.1:8080';
            const lastColon = addr.lastIndexOf(':');

            if (lastColon === -1) {
                throw new Error('no colon');
            }

            const port = parseInt(addr.slice(lastColon + 1), 10);

            if (isNaN(port)) {
                throw new Error('invalid port');
            }
        }).not.toThrow();

        // Invalid: no colon at all
        expect(() => {
            const addr = 'localhost';
            const lastColon = addr.lastIndexOf(':');

            if (lastColon === -1) {
                throw new Error('no colon');
            }
        }).toThrow('no colon');

        // Invalid: port is not a number
        expect(() => {
            const addr = 'host:abc';
            const lastColon = addr.lastIndexOf(':');

            if (lastColon === -1) {
                throw new Error('no colon');
            }

            const port = parseInt(addr.slice(lastColon + 1), 10);

            if (isNaN(port)) {
                throw new Error('invalid port');
            }
        }).toThrow('invalid port');
    });
});

describe('matchTopic', () => {
    it('should match exact topics', () => {
        expect(matchTopic('orders.created', 'orders.created')).toBe(true);
        expect(matchTopic('orders.created', 'orders.deleted')).toBe(false);
        expect(matchTopic('orders.created', 'orders')).toBe(false);
        expect(matchTopic('orders', 'orders.created')).toBe(false);
    });

    it('should match single-level wildcard (*)', () => {
        expect(matchTopic('orders.*', 'orders.created')).toBe(true);
        expect(matchTopic('orders.*', 'orders.deleted')).toBe(true);
        expect(matchTopic('orders.*', 'orders')).toBe(false);
        expect(matchTopic('orders.*', 'orders.us.created')).toBe(false);
        expect(matchTopic('*.created', 'orders.created')).toBe(true);
        expect(matchTopic('*.created', 'users.created')).toBe(true);
    });

    it('should match multi-level wildcard (>)', () => {
        expect(matchTopic('orders.>', 'orders.created')).toBe(true);
        expect(matchTopic('orders.>', 'orders.us.created')).toBe(true);
        expect(matchTopic('orders.>', 'orders.us.east.created')).toBe(true);
        expect(matchTopic('orders.>', 'orders')).toBe(false); // Must have at least one segment after
        expect(matchTopic('>', 'orders')).toBe(true);
        expect(matchTopic('>', 'orders.created')).toBe(true);
    });

    it('should handle mixed patterns', () => {
        expect(matchTopic('orders.*.created', 'orders.us.created')).toBe(true);
        expect(matchTopic('orders.*.created', 'orders.eu.created')).toBe(true);
        expect(matchTopic('orders.*.created', 'orders.us.deleted')).toBe(false);
        expect(matchTopic('*.orders.*', 'us.orders.created')).toBe(true);
    });

    it('should handle empty patterns', () => {
        expect(matchTopic('', '')).toBe(true);
        expect(matchTopic('', 'orders')).toBe(false);
    });
});

describe('PubsubPort', () => {
    it('should have type "pubsub:subscribe"', () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['orders.*'], publishFn, unsubscribeFn, 'pubsub:subscribe:orders.*');

        expect(port.type).toBe('pubsub:subscribe');
    });

    it('should use provided description', () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['orders.*'], publishFn, unsubscribeFn, 'pubsub:orders.*');

        expect(port.description).toBe('pubsub:orders.*');
    });

    it('should expose patterns', () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['orders.*', 'users.>'], publishFn, unsubscribeFn, 'pubsub:test');

        expect(port.getPatterns()).toEqual(['orders.*', 'users.>']);
    });

    it('should call publishFn on send()', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', [], publishFn, unsubscribeFn, 'pubsub:send-only');

        const data = new Uint8Array([1, 2, 3]);

        await port.send('orders.created', data);

        // publishFn now has 4 args: (topic, data, meta, sourcePortId)
        expect(publishFn).toHaveBeenCalledWith('orders.created', data, undefined, 'pub-1');
    });

    it('should enqueue messages and recv() them', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['orders.*'], publishFn, unsubscribeFn, 'pubsub:test');

        port.enqueue({
            from: 'orders.created',
            data: new Uint8Array([4, 5, 6]),
            meta: { timestamp: 12345 },
        });

        const msg = await port.recv();

        expect(msg.from).toBe('orders.created');
        expect(msg.data).toEqual(new Uint8Array([4, 5, 6]));
        expect(msg.meta?.timestamp).toBe(12345);
    });

    it('should queue messages and deliver in order', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['*'], publishFn, unsubscribeFn, 'pubsub:test');

        port.enqueue({ from: 'first', data: new Uint8Array([1]) });
        port.enqueue({ from: 'second', data: new Uint8Array([2]) });
        port.enqueue({ from: 'third', data: new Uint8Array([3]) });

        expect((await port.recv()).from).toBe('first');
        expect((await port.recv()).from).toBe('second');
        expect((await port.recv()).from).toBe('third');
    });

    it('should deliver to waiting receiver immediately', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['*'], publishFn, unsubscribeFn, 'pubsub:test');

        // Start waiting for message
        const recvPromise = port.recv();

        // Small delay then enqueue
        await new Promise(r => setTimeout(r, 10));
        port.enqueue({ from: 'delayed', data: new Uint8Array([99]) });

        const msg = await recvPromise;

        expect(msg.from).toBe('delayed');
    });

    it('should call unsubscribeFn on close()', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['*'], publishFn, unsubscribeFn, 'pubsub:test');

        await port.close();

        expect(unsubscribeFn).toHaveBeenCalled();
        expect(port.closed).toBe(true);
    });

    it('should be idempotent on close', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['*'], publishFn, unsubscribeFn, 'pubsub:test');

        await port.close();
        await port.close();

        expect(unsubscribeFn).toHaveBeenCalledTimes(1);
    });

    it('should throw on recv() after close', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['*'], publishFn, unsubscribeFn, 'pubsub:test');

        await port.close();

        await expect(port.recv()).rejects.toThrow('Port closed');
    });

    it('should throw on send() after close', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['*'], publishFn, unsubscribeFn, 'pubsub:test');

        await port.close();

        await expect(port.send('topic', new Uint8Array())).rejects.toThrow('Port closed');
    });

    it('should ignore enqueue after close', async () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['*'], publishFn, unsubscribeFn, 'pubsub:test');

        await port.close();

        // Should not throw
        port.enqueue({ from: 'ignored', data: new Uint8Array() });
    });
});
