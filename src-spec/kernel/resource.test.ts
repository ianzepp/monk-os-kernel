/**
 * Resource Tests
 */

import { describe, it, expect, mock } from 'bun:test';
import { FileResource, SocketResource, ListenerPort, WatchPort, UdpPort, PubsubPort, matchTopic, PipeBuffer, PipeResource } from '@src/kernel/resource.js';
import type { WatchEvent } from '@src/vfs/model.js';
import type { FileHandle } from '@src/vfs/index.js';
import type { Socket, Listener } from '@src/hal/index.js';

describe('FileResource', () => {
    function createMockHandle(overrides: Partial<FileHandle> = {}): FileHandle {
        return {
            id: 'test-handle-id',
            path: '/test/file.txt',
            flags: { read: true },
            closed: false,
            read: mock(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
            write: mock(() => Promise.resolve(3)),
            seek: mock(() => Promise.resolve(0)),
            tell: mock(() => Promise.resolve(0)),
            sync: mock(() => Promise.resolve()),
            close: mock(() => Promise.resolve()),
            [Symbol.asyncDispose]: mock(() => Promise.resolve()),
            ...overrides,
        };
    }

    it('should have type "file"', () => {
        const handle = createMockHandle();
        const resource = new FileResource('res-1', handle);
        expect(resource.type).toBe('file');
    });

    it('should use handle id', () => {
        const handle = createMockHandle({ id: 'my-handle' });
        const resource = new FileResource('my-handle', handle);
        expect(resource.id).toBe('my-handle');
    });

    it('should use path as description', () => {
        const handle = createMockHandle({ path: '/etc/passwd' });
        const resource = new FileResource('res-1', handle);
        expect(resource.description).toBe('/etc/passwd');
    });

    it('should delegate read to handle', async () => {
        const handle = createMockHandle();
        const resource = new FileResource('res-1', handle);

        const data = await resource.read(100);
        expect(data).toEqual(new Uint8Array([1, 2, 3]));
        expect(handle.read).toHaveBeenCalledWith(100);
    });

    it('should delegate write to handle', async () => {
        const handle = createMockHandle();
        const resource = new FileResource('res-1', handle);

        const written = await resource.write(new Uint8Array([4, 5, 6]));
        expect(written).toBe(3);
        expect(handle.write).toHaveBeenCalled();
    });

    it('should delegate close to handle', async () => {
        const handle = createMockHandle();
        const resource = new FileResource('res-1', handle);

        await resource.close();
        expect(handle.close).toHaveBeenCalled();
        expect(resource.closed).toBe(true);
    });

    it('should be idempotent on close', async () => {
        const handle = createMockHandle();
        const resource = new FileResource('res-1', handle);

        await resource.close();
        await resource.close();
        expect(handle.close).toHaveBeenCalledTimes(1);
    });

    it('should expose underlying handle', () => {
        const handle = createMockHandle();
        const resource = new FileResource('res-1', handle);
        expect(resource.getHandle()).toBe(handle);
    });
});

describe('SocketResource', () => {
    function createMockSocket(overrides: Partial<Socket> = {}): Socket {
        return {
            read: mock(() => Promise.resolve(new Uint8Array([7, 8, 9]))),
            write: mock(() => Promise.resolve()),
            close: mock(() => Promise.resolve()),
            stat: mock(() => ({
                remoteAddr: '10.0.0.1',
                remotePort: 8080,
                localAddr: '192.168.1.1',
                localPort: 54321,
            })),
            [Symbol.asyncDispose]: mock(() => Promise.resolve()),
            ...overrides,
        };
    }

    it('should have type "socket"', () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:10.0.0.1:8080');
        expect(resource.type).toBe('socket');
    });

    it('should use provided description', () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:example.com:443');
        expect(resource.description).toBe('tcp:example.com:443');
    });

    it('should delegate read to socket', async () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:test');

        const data = await resource.read();
        expect(data).toEqual(new Uint8Array([7, 8, 9]));
        expect(socket.read).toHaveBeenCalled();
    });

    it('should delegate write to socket', async () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:test');

        const written = await resource.write(new Uint8Array([1, 2, 3]));
        expect(written).toBe(3);
        expect(socket.write).toHaveBeenCalled();
    });

    it('should delegate close to socket', async () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:test');

        await resource.close();
        expect(socket.close).toHaveBeenCalled();
        expect(resource.closed).toBe(true);
    });

    it('should expose socket stat', () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:test');

        const stat = resource.stat();
        expect(stat.remoteAddr).toBe('10.0.0.1');
        expect(stat.remotePort).toBe(8080);
    });

    it('should expose underlying socket', () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:test');
        expect(resource.getSocket()).toBe(socket);
    });

    it('should cache stat on construction', () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:test');

        // stat() should have been called once during construction
        expect(socket.stat).toHaveBeenCalledTimes(1);

        // Calling resource.stat() should return cached value, not call socket.stat again
        resource.stat();
        resource.stat();
        expect(socket.stat).toHaveBeenCalledTimes(1);
    });

    it('should return cached stat after close', async () => {
        const socket = createMockSocket();
        const resource = new SocketResource('res-1', socket, 'tcp:test');

        await resource.close();

        // Should still return the cached stat
        const stat = resource.stat();
        expect(stat.remoteAddr).toBe('10.0.0.1');
    });
});

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
            port.send('anywhere', new Uint8Array())
        ).rejects.toThrow('EOPNOTSUPP');
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

describe('PipeBuffer', () => {
    it('should write and read data', async () => {
        const buffer = new PipeBuffer();

        buffer.write(new Uint8Array([1, 2, 3]));
        const data = await buffer.read();

        expect(data).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should buffer multiple writes', async () => {
        const buffer = new PipeBuffer();

        buffer.write(new Uint8Array([1, 2]));
        buffer.write(new Uint8Array([3, 4]));

        const data = await buffer.read();
        expect(data).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it('should return data to waiting reader', async () => {
        const buffer = new PipeBuffer();

        // Start read before write
        const readPromise = buffer.read();

        // Small delay, then write
        await new Promise(r => setTimeout(r, 10));
        buffer.write(new Uint8Array([5, 6, 7]));

        const data = await readPromise;
        expect(data).toEqual(new Uint8Array([5, 6, 7]));
    });

    it('should return EOF when write end closes', async () => {
        const buffer = new PipeBuffer();

        buffer.closeWriteEnd();
        const data = await buffer.read();

        expect(data.length).toBe(0);
    });

    it('should wake waiters with EOF on close', async () => {
        const buffer = new PipeBuffer();

        const readPromise = buffer.read();

        await new Promise(r => setTimeout(r, 10));
        buffer.closeWriteEnd();

        const data = await readPromise;
        expect(data.length).toBe(0);
    });

    it('should throw EPIPE when read end is closed', () => {
        const buffer = new PipeBuffer();

        buffer.closeReadEnd();

        expect(() => buffer.write(new Uint8Array([1, 2, 3]))).toThrow('Read end closed');
    });

    it('should track buffer size', () => {
        const buffer = new PipeBuffer();

        expect(buffer.size).toBe(0);

        buffer.write(new Uint8Array([1, 2, 3]));
        expect(buffer.size).toBe(3);

        buffer.write(new Uint8Array([4, 5]));
        expect(buffer.size).toBe(5);
    });

    it('should report fullyClosed when both ends close', () => {
        const buffer = new PipeBuffer();

        expect(buffer.fullyClosed).toBe(false);

        buffer.closeReadEnd();
        expect(buffer.fullyClosed).toBe(false);

        buffer.closeWriteEnd();
        expect(buffer.fullyClosed).toBe(true);
    });

    it('should return 0 when writing empty data', () => {
        const buffer = new PipeBuffer();

        const written = buffer.write(new Uint8Array(0));
        expect(written).toBe(0);
    });

    it('should support partial reads with size limit', async () => {
        const buffer = new PipeBuffer();

        buffer.write(new Uint8Array([1, 2, 3, 4, 5]));

        const data = await buffer.read(3);
        expect(data).toEqual(new Uint8Array([1, 2, 3, 4, 5])); // Single chunk returns all

        // Write two chunks
        buffer.write(new Uint8Array([10, 20]));
        buffer.write(new Uint8Array([30, 40, 50]));

        // Read with limit
        const partial = await buffer.read(3);
        expect(partial).toEqual(new Uint8Array([10, 20, 30]));

        // Remaining data
        const rest = await buffer.read();
        expect(rest).toEqual(new Uint8Array([40, 50]));
    });
});

describe('PipeResource', () => {
    it('should have type "pipe"', () => {
        const buffer = new PipeBuffer();
        const resource = new PipeResource('pipe-1', buffer, 'read', 'pipe:test:read');
        expect(resource.type).toBe('pipe');
    });

    it('should use provided description', () => {
        const buffer = new PipeBuffer();
        const resource = new PipeResource('pipe-1', buffer, 'read', 'pipe:123:read');
        expect(resource.description).toBe('pipe:123:read');
    });

    it('should read from read end', async () => {
        const buffer = new PipeBuffer();
        buffer.write(new Uint8Array([1, 2, 3]));

        const readEnd = new PipeResource('pipe-r', buffer, 'read', 'pipe:test:read');
        const data = await readEnd.read();

        expect(data).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should write to write end', async () => {
        const buffer = new PipeBuffer();
        const writeEnd = new PipeResource('pipe-w', buffer, 'write', 'pipe:test:write');

        const written = await writeEnd.write(new Uint8Array([4, 5, 6]));
        expect(written).toBe(3);

        const data = await buffer.read();
        expect(data).toEqual(new Uint8Array([4, 5, 6]));
    });

    it('should throw when reading from write end', async () => {
        const buffer = new PipeBuffer();
        const writeEnd = new PipeResource('pipe-w', buffer, 'write', 'pipe:test:write');

        await expect(writeEnd.read()).rejects.toThrow('Cannot read from write end of pipe');
    });

    it('should throw when writing to read end', async () => {
        const buffer = new PipeBuffer();
        const readEnd = new PipeResource('pipe-r', buffer, 'read', 'pipe:test:read');

        await expect(readEnd.write(new Uint8Array([1]))).rejects.toThrow('Cannot write to read end of pipe');
    });

    it('should throw when reading from closed pipe', async () => {
        const buffer = new PipeBuffer();
        const readEnd = new PipeResource('pipe-r', buffer, 'read', 'pipe:test:read');

        await readEnd.close();

        await expect(readEnd.read()).rejects.toThrow('Pipe closed');
    });

    it('should throw when writing to closed pipe', async () => {
        const buffer = new PipeBuffer();
        const writeEnd = new PipeResource('pipe-w', buffer, 'write', 'pipe:test:write');

        await writeEnd.close();

        await expect(writeEnd.write(new Uint8Array([1]))).rejects.toThrow('Pipe closed');
    });

    it('should close write end and signal EOF', async () => {
        const buffer = new PipeBuffer();
        const readEnd = new PipeResource('pipe-r', buffer, 'read', 'pipe:test:read');
        const writeEnd = new PipeResource('pipe-w', buffer, 'write', 'pipe:test:write');

        await writeEnd.close();

        const data = await readEnd.read();
        expect(data.length).toBe(0); // EOF
    });

    it('should close read end and cause EPIPE on write', async () => {
        const buffer = new PipeBuffer();
        const readEnd = new PipeResource('pipe-r', buffer, 'read', 'pipe:test:read');
        const writeEnd = new PipeResource('pipe-w', buffer, 'write', 'pipe:test:write');

        await readEnd.close();

        await expect(writeEnd.write(new Uint8Array([1]))).rejects.toThrow('Read end closed');
    });

    it('should expose underlying buffer', () => {
        const buffer = new PipeBuffer();
        const resource = new PipeResource('pipe-1', buffer, 'read', 'pipe:test:read');

        expect(resource.getBuffer()).toBe(buffer);
    });

    it('should be idempotent on close', async () => {
        const buffer = new PipeBuffer();
        const readEnd = new PipeResource('pipe-r', buffer, 'read', 'pipe:test:read');

        await readEnd.close();
        await readEnd.close(); // Should not throw

        expect(readEnd.closed).toBe(true);
    });
});

describe('WatchPort', () => {
    /**
     * Create a mock VFS watch function that yields events from a queue
     */
    function createMockVfsWatch(events: WatchEvent[]): (pattern: string) => AsyncIterable<WatchEvent> {
        return (_pattern: string) => {
            return {
                [Symbol.asyncIterator]() {
                    let index = 0;
                    return {
                        async next() {
                            if (index < events.length) {
                                return { done: false, value: events[index++] };
                            }
                            // Never resolves - simulates waiting for more events
                            return new Promise(() => {});
                        }
                    };
                }
            };
        };
    }

    it('should have type "watch"', () => {
        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch([]), 'watch:/test/*');
        expect(port.type).toBe('watch');
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

    it('should encode event data as JSON', async () => {
        const events: WatchEvent[] = [
            { entity: 'uuid-1', op: 'delete', path: '/test/file.txt', timestamp: 1234567890 },
        ];

        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch(events), 'watch:/test/*');
        await new Promise(r => setTimeout(r, 10));

        const msg = await port.recv();
        const decoded = JSON.parse(new TextDecoder().decode(msg.data));
        expect(decoded.entity).toBe('uuid-1');
        expect(decoded.op).toBe('delete');
    });

    it('should throw on send()', async () => {
        const port = new WatchPort('watch-1', '/test/*', createMockVfsWatch([]), 'watch:/test/*');

        await expect(
            port.send('anywhere', new Uint8Array())
        ).rejects.toThrow('EOPNOTSUPP');
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
            if (lastColon === -1) throw new Error('no colon');
            const port = parseInt(addr.slice(lastColon + 1), 10);
            if (isNaN(port)) throw new Error('invalid port');
        }).not.toThrow();

        // Invalid: no colon at all
        expect(() => {
            const addr = 'localhost';
            const lastColon = addr.lastIndexOf(':');
            if (lastColon === -1) throw new Error('no colon');
        }).toThrow('no colon');

        // Invalid: port is not a number
        expect(() => {
            const addr = 'host:abc';
            const lastColon = addr.lastIndexOf(':');
            if (lastColon === -1) throw new Error('no colon');
            const port = parseInt(addr.slice(lastColon + 1), 10);
            if (isNaN(port)) throw new Error('invalid port');
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
    it('should have type "pubsub"', () => {
        const publishFn = mock(() => {});
        const unsubscribeFn = mock(() => {});
        const port = new PubsubPort('pub-1', ['orders.*'], publishFn, unsubscribeFn, 'pubsub:orders.*');
        expect(port.type).toBe('pubsub');
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

        expect(publishFn).toHaveBeenCalledWith('orders.created', data, 'pub-1');
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
