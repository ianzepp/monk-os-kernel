/**
 * Gateway Tests
 *
 * Tests for the TCP gateway that provides external syscall access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { pack, unpack } from 'msgpackr';
import { Gateway } from '@src/gateway/gateway.js';
import { BunNetworkDevice, BunEntropyDevice } from '@src/hal/index.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { HAL } from '@src/hal/index.js';
import type { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import type { Process, Response } from '@src/syscall/types.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock process for testing.
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        user: 'test',
        worker: {} as Worker,
        virtual: false,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/',
        env: { HOME: '/', USER: 'test' },
        args: [],
        pathDirs: new Map(),
        handles: new Map(),
        nextHandle: 3,
        children: new Map(),
        nextPid: 1,
        activeStreams: new Map(),
        streamPingHandlers: new Map(),
        ...overrides,
    };
}

/**
 * Create a mock HAL with real network and entropy devices.
 * WHY: Gateway needs actual Unix socket support and UUID generation.
 */
function createMockHAL(): HAL {
    return {
        network: new BunNetworkDevice(),
        entropy: new BunEntropyDevice(),
    } as unknown as HAL;
}

/**
 * Create a mock Kernel with minimal functionality.
 * WHY: Gateway calls createVirtualProcess which needs kernel.hal.entropy.
 */
function createMockKernel(init?: Process): Kernel {
    const initProcess = init ?? createMockProcess({ cmd: '/app/init.ts' });
    const processes = new Map<string, Process>([[initProcess.id, initProcess]]);

    return {
        hal: createMockHAL(),
        processes: {
            getInit: () => initProcess,
            get: (id: string) => processes.get(id),
            all: () => Array.from(processes.values()),
            register: (proc: Process) => {
                processes.set(proc.id, proc);
            },
            reparentOrphans: () => {},
        },
        // For forceExit
        leasedWorkers: new Map(),
        waiters: new Map(),
    } as unknown as Kernel;
}

/**
 * Create a mock SyscallDispatcher.
 */
function createMockDispatcher(
    handler?: (proc: Process, id: string, name: string, args: unknown[]) => AsyncIterable<Response>,
): SyscallDispatcher {
    const defaultHandler = async function* (): AsyncIterable<Response> {
        yield { op: 'ok', data: { success: true } };
    };

    return {
        execute: handler ?? defaultHandler,
    } as unknown as SyscallDispatcher;
}

/**
 * Encode a message as length-prefixed msgpack frame.
 */
function encodeFrame(message: unknown): Uint8Array {
    const payload = pack(message);
    const frame = new Uint8Array(4 + payload.length);
    const view = new DataView(frame.buffer);

    view.setUint32(0, payload.length);
    frame.set(payload, 4);

    return frame;
}

/**
 * Send a msgpack message to gateway and read response.
 */
async function sendMessage(
    port: number,
    message: { id: string; call: string; args?: unknown[] },
): Promise<{ id: string; op: string; [key: string]: unknown }[]> {
    const network = new BunNetworkDevice();
    const socket = await network.connect('localhost', port);

    try {
        // Send request as length-prefixed msgpack
        await socket.write(encodeFrame(message));

        // Read responses until terminal op
        const responses: { id: string; op: string; [key: string]: unknown }[] = [];
        let buffer = new Uint8Array(0);

        while (true) {
            const chunk = await socket.read({ timeout: 1000 });

            if (chunk.length === 0) {
                break;
            }

            // Append to buffer
            const newBuffer = new Uint8Array(buffer.length + chunk.length);

            newBuffer.set(buffer);
            newBuffer.set(chunk, buffer.length);
            buffer = newBuffer;

            // Process complete messages
            while (buffer.length >= 4) {
                const view = new DataView(buffer.buffer, buffer.byteOffset);
                const msgLength = view.getUint32(0);

                if (buffer.length < 4 + msgLength) {
                    break;
                }

                const payload = buffer.slice(4, 4 + msgLength);

                buffer = buffer.slice(4 + msgLength);

                const response = unpack(payload) as { id: string; op: string; [key: string]: unknown };

                responses.push(response);

                // Terminal ops end stream
                if (response.op === 'ok' || response.op === 'error' ||
                    response.op === 'done' || response.op === 'redirect') {
                    return responses;
                }
            }
        }

        return responses;
    }
    finally {
        await socket.close();
    }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Gateway', () => {
    let port: number;
    let gateway: Gateway;
    let hal: HAL;

    beforeEach(() => {
        hal = createMockHAL();
    });

    afterEach(async () => {
        // Clean up gateway
        if (gateway) {
            await gateway.shutdown();
        }
    });

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    describe('lifecycle', () => {
        it('should listen on TCP port', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            expect(port).toBeGreaterThan(0);
            expect(gateway.isListening()).toBe(true);
        });

        it('should return assigned port when using port 0', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            expect(gateway.getPort()).toBe(port);
        });

        it('should close listener on shutdown', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);
            await gateway.shutdown();

            // Connection should fail after shutdown
            const network = new BunNetworkDevice();

            await expect(network.connect('localhost', port)).rejects.toThrow();
        });

        it('should be idempotent on shutdown', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await gateway.shutdown();
            await gateway.shutdown(); // Should not throw
        });
    });

    // =========================================================================
    // CLIENT CONNECTIONS
    // =========================================================================

    describe('client connections', () => {
        it('should accept client connections', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Connect client
            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            expect(socket).toBeDefined();

            await socket.close();
        });

        it('should handle multiple concurrent clients', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Connect multiple clients
            const network = new BunNetworkDevice();
            const client1 = await network.connect('localhost', port);
            const client2 = await network.connect('localhost', port);
            const client3 = await network.connect('localhost', port);

            expect(client1).toBeDefined();
            expect(client2).toBeDefined();
            expect(client3).toBeDefined();

            await Promise.all([
                client1.close(),
                client2.close(),
                client3.close(),
            ]);
        });

        it('should reject connections when kernel not booted', async () => {
            // Create kernel with no init process
            const kernel = {
                hal: createMockHAL(),
                processes: {
                    getInit: () => null,
                    get: () => undefined,
                    all: () => [],
                    register: () => {},
                    reparentOrphans: () => {},
                },
                leasedWorkers: new Map(),
                waiters: new Map(),
            } as unknown as Kernel;
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Connect client
            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            // Should get disconnected (EOF)
            const data = await socket.read({ timeout: 100 });

            expect(data.length).toBe(0);

            await socket.close();
        });
    });

    // =========================================================================
    // MESSAGE PARSING
    // =========================================================================

    describe('message parsing', () => {
        it('should parse valid JSON messages', async () => {
            let receivedName = '';
            let receivedArgs: unknown[] = [];

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, name, args) {
                receivedName = name;
                receivedArgs = args;
                yield { op: 'ok', data: { parsed: true } };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const responses = await sendMessage(port, {
                id: 'test-1',
                call: 'proc:getcwd',
                args: [],
            });

            expect(receivedName).toBe('proc:getcwd');
            expect(receivedArgs).toEqual([]);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
        });

        it('should return error for invalid msgpack', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send invalid msgpack (garbage bytes with valid length prefix)
            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            const invalidFrame = new Uint8Array(8);
            const view = new DataView(invalidFrame.buffer);

            view.setUint32(0, 4); // length = 4
            invalidFrame.set([0xff, 0xff, 0xff, 0xff], 4); // invalid msgpack

            await socket.write(invalidFrame);

            const chunk = await socket.read({ timeout: 1000 });

            // Parse response (skip 4-byte length prefix)
            const responseView = new DataView(chunk.buffer, chunk.byteOffset);
            const responseLength = responseView.getUint32(0);
            const response = unpack(chunk.slice(4, 4 + responseLength)) as { op: string; code: string };

            expect(response.op).toBe('error');
            expect(response.code).toBe('EINVAL');

            await socket.close();
        });

        it('should return error for missing call field', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send msgpack without call field
            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            await socket.write(encodeFrame({ id: 'test' }));

            const chunk = await socket.read({ timeout: 1000 });

            // Parse response (skip 4-byte length prefix)
            const responseView = new DataView(chunk.buffer, chunk.byteOffset);
            const responseLength = responseView.getUint32(0);
            const response = unpack(chunk.slice(4, 4 + responseLength)) as { op: string; code: string; message: string };

            expect(response.op).toBe('error');
            expect(response.code).toBe('EINVAL');
            expect(response.message).toContain('call');

            await socket.close();
        });

        it('should echo request id in response', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const responses = await sendMessage(port, {
                id: 'unique-request-id-123',
                call: 'proc:getcwd',
            });

            expect(responses[0]!.id).toBe('unique-request-id-123');
        });

        it('should use "unknown" id when not provided', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send msgpack without id field
            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            await socket.write(encodeFrame({ call: 'proc:getcwd' }));

            const chunk = await socket.read({ timeout: 1000 });

            // Parse response (skip 4-byte length prefix)
            const responseView = new DataView(chunk.buffer, chunk.byteOffset);
            const responseLength = responseView.getUint32(0);
            const response = unpack(chunk.slice(4, 4 + responseLength)) as { id: string };

            expect(response.id).toBe('unknown');

            await socket.close();
        });
    });

    // =========================================================================
    // SYSCALL DISPATCH
    // =========================================================================

    describe('syscall dispatch', () => {
        it('should dispatch syscalls to handler', async () => {
            const calls: { name: string; args: unknown[] }[] = [];

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, name, args) {
                calls.push({ name, args });
                yield { op: 'ok', data: { handled: true } };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, {
                id: 'test-1',
                call: 'file:open',
                args: ['/etc/passwd', { read: true }],
            });

            expect(calls).toHaveLength(1);
            expect(calls[0]!.name).toBe('file:open');
            expect(calls[0]!.args).toEqual(['/etc/passwd', { read: true }]);
        });

        it('should handle streaming responses', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                yield { op: 'item', data: { value: 1 } };
                yield { op: 'item', data: { value: 2 } };
                yield { op: 'item', data: { value: 3 } };
                yield { op: 'done' };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const responses = await sendMessage(port, {
                id: 'test-1',
                call: 'ems:select',
                args: ['User', {}],
            });

            expect(responses).toHaveLength(4);
            expect(responses[0]!.op).toBe('item');
            expect(responses[1]!.op).toBe('item');
            expect(responses[2]!.op).toBe('item');
            expect(responses[3]!.op).toBe('done');
        });

        it('should handle error responses', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                yield { op: 'error', data: { code: 'ENOENT', message: 'File not found' } };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const responses = await sendMessage(port, {
                id: 'test-1',
                call: 'file:open',
                args: ['/nonexistent'],
            });

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect(responses[0]!.code).toBe('ENOENT');
            expect(responses[0]!.message).toBe('File not found');
        });

        it('should handle exceptions from dispatcher', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                throw Object.assign(new Error('Something went wrong'), { code: 'EIO' });
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const responses = await sendMessage(port, {
                id: 'test-1',
                call: 'file:read',
                args: [3],
            });

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect(responses[0]!.code).toBe('EIO');
        });
    });

    // =========================================================================
    // WIRE PROTOCOL
    // =========================================================================

    describe('wire protocol', () => {
        it('should pass binary data as Uint8Array', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                yield { op: 'data', bytes: new Uint8Array([72, 101, 108, 108, 111]) } as Response;
                yield { op: 'done' };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const responses = await sendMessage(port, {
                id: 'test-1',
                call: 'file:read',
                args: [3],
            });

            expect(responses).toHaveLength(2);
            expect(responses[0]!.op).toBe('data');
            // With msgpack, binary data comes as Uint8Array directly
            expect(responses[0]!.bytes).toBeInstanceOf(Uint8Array);
            expect(Array.from(responses[0]!.bytes as Uint8Array)).toEqual([72, 101, 108, 108, 111]);
        });

        it('should flatten error data to top level', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                yield { op: 'error', data: { code: 'EACCES', message: 'Permission denied' } };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const responses = await sendMessage(port, {
                id: 'test-1',
                call: 'file:write',
                args: [3, new Uint8Array()],
            });

            expect(responses[0]!.code).toBe('EACCES');
            expect(responses[0]!.message).toBe('Permission denied');
            // data should be removed (flattened)
            expect(responses[0]!.data).toBeUndefined();
        });

        it('should handle concurrent requests with interleaved responses', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, id) {
                // Simulate varying response times
                if (id === 'fast') {
                    yield { op: 'ok', data: { order: 'fast' } };
                }
                else {
                    await Bun.sleep(50);
                    yield { op: 'ok', data: { order: 'slow' } };
                }
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send both requests on same connection
            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            // Send two msgpack frames
            await socket.write(encodeFrame({ id: 'slow', call: 'test' }));
            await socket.write(encodeFrame({ id: 'fast', call: 'test' }));

            // Collect responses
            const responses: unknown[] = [];
            let buffer = new Uint8Array(0);

            while (responses.length < 2) {
                const chunk = await socket.read({ timeout: 1000 });

                if (chunk.length === 0) {
                    break;
                }

                // Append to buffer
                const newBuffer = new Uint8Array(buffer.length + chunk.length);

                newBuffer.set(buffer);
                newBuffer.set(chunk, buffer.length);
                buffer = newBuffer;

                // Process complete messages
                while (buffer.length >= 4) {
                    const view = new DataView(buffer.buffer, buffer.byteOffset);
                    const msgLength = view.getUint32(0);

                    if (buffer.length < 4 + msgLength) {
                        break;
                    }

                    const payload = buffer.slice(4, 4 + msgLength);

                    buffer = buffer.slice(4 + msgLength);
                    responses.push(unpack(payload));
                }
            }

            await socket.close();

            // Fast should complete before slow
            expect(responses).toHaveLength(2);

            const ids = responses.map(r => (r as { id: string }).id);

            expect(ids).toContain('fast');
            expect(ids).toContain('slow');
        });
    });

    // =========================================================================
    // CLIENT DISCONNECT
    // =========================================================================

    describe('client disconnect', () => {
        it('should handle client disconnect gracefully', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                // Slow response to allow client disconnect
                await Bun.sleep(100);
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Connect and immediately disconnect
            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            await socket.write(encodeFrame({ id: '1', call: 'test' }));
            await socket.close();

            // Give gateway time to handle disconnect
            await Bun.sleep(50);

            // Gateway should still be functional
            const responses = await sendMessage(port, {
                id: 'test-2',
                call: 'proc:getcwd',
            });

            expect(responses[0]!.op).toBe('ok');
        });

        it('should disconnect all clients on shutdown', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Connect multiple clients
            const network = new BunNetworkDevice();
            const sockets = await Promise.all([
                network.connect('localhost', port),
                network.connect('localhost', port),
            ]);

            // Shutdown gateway
            await gateway.shutdown();

            // All clients should get EOF
            for (const socket of sockets) {
                const data = await socket.read({ timeout: 100 }).catch(() => new Uint8Array(0));

                expect(data.length).toBe(0);
                await socket.close();
            }
        });
    });

    // =========================================================================
    // NATIVE BINARY DATA (MSGPACK)
    // =========================================================================

    describe('native binary data', () => {
        it('should preserve Uint8Array in arguments', async () => {
            let receivedArgs: unknown[] = [];

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // msgpack encodes Uint8Array natively
            await sendMessage(port, {
                id: 'test-1',
                call: 'file:write',
                args: [3, { data: new Uint8Array([72, 101, 108, 108, 111]) }],
            });

            expect(receivedArgs).toHaveLength(2);
            expect(receivedArgs[0]).toBe(3);

            const writeOpts = receivedArgs[1] as { data: unknown };

            expect(writeOpts.data).toBeInstanceOf(Uint8Array);
            expect(Array.from(writeOpts.data as Uint8Array)).toEqual([72, 101, 108, 108, 111]);
        });

        it('should preserve nested Uint8Array', async () => {
            let receivedArgs: unknown[] = [];

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, {
                id: 'test-1',
                call: 'test:nested',
                args: [{
                    level1: {
                        level2: {
                            binary: new Uint8Array([1, 2, 3]),
                        },
                    },
                }],
            });

            const nested = receivedArgs[0] as { level1: { level2: { binary: unknown } } };

            expect(nested.level1.level2.binary).toBeInstanceOf(Uint8Array);
            expect(Array.from(nested.level1.level2.binary as Uint8Array)).toEqual([1, 2, 3]);
        });

        it('should preserve Uint8Array in arrays', async () => {
            let receivedArgs: unknown[] = [];

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, {
                id: 'test-1',
                call: 'test:array',
                args: [[
                    new Uint8Array([1]),
                    new Uint8Array([2]),
                    new Uint8Array([3]),
                ]],
            });

            const items = receivedArgs[0] as unknown[];

            expect(items).toHaveLength(3);
            expect(items[0]).toBeInstanceOf(Uint8Array);
            expect(items[1]).toBeInstanceOf(Uint8Array);
            expect(items[2]).toBeInstanceOf(Uint8Array);
            expect(Array.from(items[0] as Uint8Array)).toEqual([1]);
            expect(Array.from(items[1] as Uint8Array)).toEqual([2]);
            expect(Array.from(items[2] as Uint8Array)).toEqual([3]);
        });

        it('should pass through primitives unchanged', async () => {
            let receivedArgs: unknown[] = [];

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, {
                id: 'test-1',
                call: 'test:primitives',
                args: ['string', 42, true, null],
            });

            expect(receivedArgs).toEqual(['string', 42, true, null]);
        });

        it('should handle empty Uint8Array', async () => {
            let receivedArgs: unknown[] = [];

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, {
                id: 'test-1',
                call: 'file:write',
                args: [3, { data: new Uint8Array(0) }],
            });

            const writeOpts = receivedArgs[1] as { data: unknown };

            expect(writeOpts.data).toBeInstanceOf(Uint8Array);
            expect((writeOpts.data as Uint8Array).length).toBe(0);
        });
    });

    // =========================================================================
    // BUFFER OVERFLOW PROTECTION
    // =========================================================================

    describe('buffer overflow protection', () => {
        it('should disconnect on buffer overflow', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            // Send data without newlines to overflow buffer
            // MAX_READ_BUFFER_SIZE is 1MB (1024 * 1024)
            const largeChunk = new Uint8Array(100 * 1024).fill(65); // 100KB of 'A'

            // Send 11 chunks (>1MB total without newlines)
            for (let i = 0; i < 11; i++) {
                try {
                    await socket.write(largeChunk);
                }
                catch {
                    // Connection may close during writes
                    break;
                }
            }

            // Connection should be closed
            await Bun.sleep(50);
            const data = await socket.read({ timeout: 100 }).catch(() => new Uint8Array(0));

            expect(data.length).toBe(0);

            await socket.close();
        });
    });
});
