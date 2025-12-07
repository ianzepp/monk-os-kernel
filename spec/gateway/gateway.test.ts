/**
 * Gateway Tests
 *
 * Tests for the Unix socket gateway that provides external syscall access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Gateway } from '@src/gateway/gateway.js';
import { BunNetworkDevice, BunEntropyDevice } from '@src/hal/index.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { HAL } from '@src/hal/index.js';
import type { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import type { Process, Response } from '@src/syscall/types.js';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Generate unique socket path for each test.
 */
function getTestSocketPath(): string {
    return join(tmpdir(), `monk-gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

/**
 * Create a mock process for testing.
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        user: 'test',
        worker: {} as Worker,
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
    const initProcess = init ?? createMockProcess({ cmd: '/svc/init.ts' });
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
 * Send a JSON message to gateway and read response.
 */
async function sendMessage(
    socketPath: string,
    message: { id: string; call: string; args?: unknown[] },
): Promise<{ id: string; op: string; [key: string]: unknown }[]> {
    const network = new BunNetworkDevice();
    const socket = await network.connect(socketPath, 0);

    try {
        // Send request
        const request = JSON.stringify(message) + '\n';

        await socket.write(new TextEncoder().encode(request));

        // Read responses until terminal op
        const responses: { id: string; op: string; [key: string]: unknown }[] = [];
        let buffer = '';

        while (true) {
            const chunk = await socket.read({ timeout: 1000 });

            if (chunk.length === 0) break;

            buffer += new TextDecoder().decode(chunk);

            // Process complete lines
            let newlineIdx: number;

            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx);

                buffer = buffer.slice(newlineIdx + 1);

                if (line.trim()) {
                    const response = JSON.parse(line);

                    responses.push(response);

                    // Terminal ops end stream
                    if (response.op === 'ok' || response.op === 'error' ||
                        response.op === 'done' || response.op === 'redirect') {
                        return responses;
                    }
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
    let socketPath: string;
    let gateway: Gateway;
    let hal: HAL;

    beforeEach(() => {
        socketPath = getTestSocketPath();
        hal = createMockHAL();
    });

    afterEach(async () => {
        // Clean up gateway
        if (gateway) {
            await gateway.shutdown();
        }

        // Clean up socket file
        if (existsSync(socketPath)) {
            rmSync(socketPath);
        }
    });

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    describe('lifecycle', () => {
        it('should create Unix socket on listen', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            expect(existsSync(socketPath)).toBe(true);
        });

        it('should remove stale socket file before listen', async () => {
            // Create a stale socket file
            await Bun.write(socketPath, 'stale');
            expect(existsSync(socketPath)).toBe(true);

            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Socket should be recreated (file still exists but is now a socket)
            expect(existsSync(socketPath)).toBe(true);
        });

        it('should close listener on shutdown', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);
            await gateway.shutdown();

            // Connection should fail after shutdown
            const network = new BunNetworkDevice();

            await expect(network.connect(socketPath, 0)).rejects.toThrow();
        });

        it('should be idempotent on shutdown', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

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
            await gateway.listen(socketPath);

            // Connect client
            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            expect(socket).toBeDefined();

            await socket.close();
        });

        it('should handle multiple concurrent clients', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Connect multiple clients
            const network = new BunNetworkDevice();
            const client1 = await network.connect(socketPath, 0);
            const client2 = await network.connect(socketPath, 0);
            const client3 = await network.connect(socketPath, 0);

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
            await gateway.listen(socketPath);

            // Connect client
            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

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
            await gateway.listen(socketPath);

            const responses = await sendMessage(socketPath, {
                id: 'test-1',
                call: 'proc:getcwd',
                args: [],
            });

            expect(receivedName).toBe('proc:getcwd');
            expect(receivedArgs).toEqual([]);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
        });

        it('should return error for invalid JSON', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Send invalid JSON directly
            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            await socket.write(new TextEncoder().encode('not valid json\n'));

            const chunk = await socket.read({ timeout: 1000 });
            const response = JSON.parse(new TextDecoder().decode(chunk).trim());

            expect(response.op).toBe('error');
            expect(response.code).toBe('EINVAL');

            await socket.close();
        });

        it('should return error for missing call field', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Send JSON without call field
            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            await socket.write(new TextEncoder().encode('{"id":"test"}\n'));

            const chunk = await socket.read({ timeout: 1000 });
            const response = JSON.parse(new TextDecoder().decode(chunk).trim());

            expect(response.op).toBe('error');
            expect(response.code).toBe('EINVAL');
            expect(response.message).toContain('call');

            await socket.close();
        });

        it('should echo request id in response', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const responses = await sendMessage(socketPath, {
                id: 'unique-request-id-123',
                call: 'proc:getcwd',
            });

            expect(responses[0]!.id).toBe('unique-request-id-123');
        });

        it('should use "unknown" id when not provided', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Send JSON without id field
            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            await socket.write(new TextEncoder().encode('{"call":"proc:getcwd"}\n'));

            const chunk = await socket.read({ timeout: 1000 });
            const response = JSON.parse(new TextDecoder().decode(chunk).trim());

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
            await gateway.listen(socketPath);

            await sendMessage(socketPath, {
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
            await gateway.listen(socketPath);

            const responses = await sendMessage(socketPath, {
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
            await gateway.listen(socketPath);

            const responses = await sendMessage(socketPath, {
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
            await gateway.listen(socketPath);

            const responses = await sendMessage(socketPath, {
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
        it('should encode binary data as base64', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                yield { op: 'data', bytes: new Uint8Array([72, 101, 108, 108, 111]) } as Response;
                yield { op: 'done' };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const responses = await sendMessage(socketPath, {
                id: 'test-1',
                call: 'file:read',
                args: [3],
            });

            expect(responses).toHaveLength(2);
            expect(responses[0]!.op).toBe('data');
            expect(responses[0]!.bytes).toBe('SGVsbG8='); // "Hello" in base64
        });

        it('should flatten error data to top level', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                yield { op: 'error', data: { code: 'EACCES', message: 'Permission denied' } };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const responses = await sendMessage(socketPath, {
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
            await gateway.listen(socketPath);

            // Send both requests on same connection
            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            await socket.write(new TextEncoder().encode(
                '{"id":"slow","call":"test"}\n' +
                '{"id":"fast","call":"test"}\n',
            ));

            // Collect responses
            const responses: unknown[] = [];
            let buffer = '';

            while (responses.length < 2) {
                const chunk = await socket.read({ timeout: 1000 });

                if (chunk.length === 0) break;

                buffer += new TextDecoder().decode(chunk);

                let newlineIdx: number;

                while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIdx);

                    buffer = buffer.slice(newlineIdx + 1);

                    if (line.trim()) {
                        responses.push(JSON.parse(line));
                    }
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
            await gateway.listen(socketPath);

            // Connect and immediately disconnect
            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            await socket.write(new TextEncoder().encode('{"id":"1","call":"test"}\n'));
            await socket.close();

            // Give gateway time to handle disconnect
            await Bun.sleep(50);

            // Gateway should still be functional
            const responses = await sendMessage(socketPath, {
                id: 'test-2',
                call: 'proc:getcwd',
            });

            expect(responses[0]!.op).toBe('ok');
        });

        it('should disconnect all clients on shutdown', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Connect multiple clients
            const network = new BunNetworkDevice();
            const sockets = await Promise.all([
                network.connect(socketPath, 0),
                network.connect(socketPath, 0),
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
    // BUFFER OVERFLOW PROTECTION
    // =========================================================================

    describe('buffer overflow protection', () => {
        it('should disconnect on buffer overflow', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

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
