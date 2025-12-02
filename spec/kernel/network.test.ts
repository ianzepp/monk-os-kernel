/**
 * Network Syscalls Tests
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SyscallDispatcher, createNetworkSyscalls } from '@src/kernel/syscalls.js';
import type { Process } from '@src/kernel/types.js';
import type { HAL } from '@src/hal/index.js';
import type { Port } from '@src/kernel/resource.js';
import { unwrapStream } from '@src/message.js';

/**
 * Create a mock process for testing
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        worker: {} as Worker,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/home/test',
        env: {},
        args: [],
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
 * Create mock HAL with network device
 */
function createMockHAL(): HAL {
    const mockSocket = {
        read: mock(() => Promise.resolve(new Uint8Array())),
        write: mock(() => Promise.resolve()),
        close: mock(() => Promise.resolve()),
        stat: mock(() => ({
            remoteAddr: '10.0.0.1',
            remotePort: 8080,
            localAddr: '127.0.0.1',
            localPort: 54321,
        })),
        [Symbol.asyncDispose]: mock(() => Promise.resolve()),
    };

    return {
        network: {
            connect: mock(() => Promise.resolve(mockSocket)),
            listen: mock(() => Promise.reject(new Error('not implemented'))),
            serve: mock(() => Promise.reject(new Error('not implemented'))),
        },
        entropy: {
            uuid: mock(() => 'mock-uuid-12345'),
            bytes: mock(() => new Uint8Array(16)),
            random: mock(() => 0.5),
            randomInt: mock(() => 42),
        },
    } as unknown as HAL;
}

describe('Network Syscalls', () => {
    let dispatcher: SyscallDispatcher;
    let hal: HAL;
    let allocatedFds: Map<string, number>;
    let allocatedPorts: Map<string, number>;
    let ports: Map<number, Port>;

    beforeEach(() => {
        dispatcher = new SyscallDispatcher();
        hal = createMockHAL();
        allocatedFds = new Map();
        allocatedPorts = new Map();
        ports = new Map();

        const connectTcp = mock(async (proc: Process, host: string, port: number) => {
            // Simulate kernel's connectTcp - allocate handle
            const h = proc.nextHandle++;
            allocatedFds.set(`${host}:${port}`, h);
            return h;
        });

        const createPort = mock(async (proc: Process, type: string, _opts: unknown) => {
            // Simulate kernel's createPort - allocate handle
            const h = proc.nextHandle++;
            allocatedPorts.set(type, h);
            return h;
        });

        const getPort = mock((_proc: Process, h: number): Port | undefined => {
            return ports.get(h);
        });

        const recvPort = mock(async (_proc: Process, _h: number) => {
            return { from: 'test', data: new Uint8Array() };
        });

        const closeHandle = mock(async (_proc: Process, h: number) => {
            ports.delete(h);
        });

        dispatcher.registerAll(createNetworkSyscalls(hal, connectTcp, createPort, getPort, recvPort, closeHandle));
    });

    describe('connect', () => {
        it('should connect to TCP server and return fd', async () => {
            const proc = createMockProcess();
            const fd = await unwrapStream<number>(dispatcher.dispatch(proc, 'connect', ['tcp', 'example.com', 80]));

            expect(typeof fd).toBe('number');
            expect(fd).toBe(3); // First fd after 0,1,2
        });

        it('should increment fd for each connection', async () => {
            const proc = createMockProcess();

            const fd1 = await unwrapStream<number>(dispatcher.dispatch(proc, 'connect', ['tcp', 'host1.com', 80]));
            const fd2 = await unwrapStream<number>(dispatcher.dispatch(proc, 'connect', ['tcp', 'host2.com', 80]));

            expect(fd1).toBe(3);
            expect(fd2).toBe(4);
        });

        it('should connect to Unix socket and return fd', async () => {
            const proc = createMockProcess();
            const fd = await unwrapStream<number>(dispatcher.dispatch(proc, 'connect', ['unix', '/var/run/app.sock', 0]));

            expect(typeof fd).toBe('number');
            expect(fd).toBe(3);
        });

        it('should connect to Unix socket without port argument', async () => {
            const proc = createMockProcess();
            // Unix sockets ignore port, kernel passes 0
            const fd = await unwrapStream<number>(dispatcher.dispatch(proc, 'connect', ['unix', '/tmp/test.sock', undefined]));

            expect(typeof fd).toBe('number');
            expect(fd).toBe(3);
        });

        it('should reject unsupported protocol', async () => {
            const proc = createMockProcess();

            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'connect', ['udp', 'example.com', 53]))
            ).rejects.toThrow('unsupported protocol');
        });

        it('should throw EINVAL when proto is not string', async () => {
            const proc = createMockProcess();

            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'connect', [123, 'example.com', 80]))
            ).rejects.toThrow('proto must be a string');
        });

        it('should throw EINVAL when host is not string', async () => {
            const proc = createMockProcess();

            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'connect', ['tcp', 123, 80]))
            ).rejects.toThrow('host must be a string');
        });

        it('should throw EINVAL when port is not number', async () => {
            const proc = createMockProcess();

            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'connect', ['tcp', 'example.com', '80']))
            ).rejects.toThrow('port must be a number');
        });
    });

    describe('port', () => {
        it('should create port and return handle', async () => {
            const proc = createMockProcess();
            const h = await unwrapStream<number>(dispatcher.dispatch(proc, 'port', ['tcp:listen', { port: 8080 }]));

            expect(typeof h).toBe('number');
            expect(h).toBe(3); // First user handle (after stdio 0,1,2)
        });

        it('should throw EINVAL when type is not string', async () => {
            const proc = createMockProcess();

            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'port', [123, {}]))
            ).rejects.toThrow('type must be a string');
        });
    });

    describe('port:close', () => {
        it('should throw EINVAL when portId is not number', async () => {
            const proc = createMockProcess();

            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'port:close', ['not-a-number']))
            ).rejects.toThrow('portId must be a number');
        });
    });
});
