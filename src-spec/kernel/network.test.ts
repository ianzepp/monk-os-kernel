/**
 * Network Syscalls Tests
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SyscallDispatcher, createNetworkSyscalls } from '@src/kernel/syscalls.js';
import type { Process } from '@src/kernel/types.js';
import type { HAL } from '@src/hal/index.js';
import type { Port } from '@src/kernel/resource.js';
import { EINVAL } from '@src/kernel/errors.js';

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
        fds: new Map(),
        ports: new Map(),
        nextFd: 3,
        nextPort: 0,
        children: new Map(),
        nextPid: 1,
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
            // Simulate kernel's connectTcp
            const fd = proc.nextFd++;
            allocatedFds.set(`${host}:${port}`, fd);
            return fd;
        });

        const createPort = mock(async (proc: Process, type: string, opts: unknown) => {
            const portId = proc.nextPort++;
            allocatedPorts.set(type, portId);
            return portId;
        });

        const getPort = mock((proc: Process, portId: number): Port | undefined => {
            return ports.get(portId);
        });

        const recvPort = mock(async (proc: Process, portId: number) => {
            return { from: 'test', data: new Uint8Array() };
        });

        const closePort = mock(async (proc: Process, portId: number) => {
            ports.delete(portId);
        });

        dispatcher.registerAll(createNetworkSyscalls(hal, connectTcp, createPort, getPort, recvPort, closePort));
    });

    describe('connect', () => {
        it('should connect to TCP server and return fd', async () => {
            const proc = createMockProcess();
            const fd = await dispatcher.dispatch(proc, 'connect', ['tcp', 'example.com', 80]);

            expect(typeof fd).toBe('number');
            expect(fd).toBe(3); // First fd after 0,1,2
        });

        it('should increment fd for each connection', async () => {
            const proc = createMockProcess();

            const fd1 = await dispatcher.dispatch(proc, 'connect', ['tcp', 'host1.com', 80]);
            const fd2 = await dispatcher.dispatch(proc, 'connect', ['tcp', 'host2.com', 80]);

            expect(fd1).toBe(3);
            expect(fd2).toBe(4);
        });

        it('should connect to Unix socket and return fd', async () => {
            const proc = createMockProcess();
            const fd = await dispatcher.dispatch(proc, 'connect', ['unix', '/var/run/app.sock', 0]);

            expect(typeof fd).toBe('number');
            expect(fd).toBe(3);
        });

        it('should connect to Unix socket without port argument', async () => {
            const proc = createMockProcess();
            // Unix sockets ignore port, kernel passes 0
            const fd = await dispatcher.dispatch(proc, 'connect', ['unix', '/tmp/test.sock', undefined]);

            expect(typeof fd).toBe('number');
            expect(fd).toBe(3);
        });

        it('should reject unsupported protocol', async () => {
            const proc = createMockProcess();

            await expect(
                dispatcher.dispatch(proc, 'connect', ['udp', 'example.com', 53])
            ).rejects.toThrow('unsupported protocol');
        });

        it('should throw EINVAL when proto is not string', async () => {
            const proc = createMockProcess();

            await expect(
                dispatcher.dispatch(proc, 'connect', [123, 'example.com', 80])
            ).rejects.toBeInstanceOf(EINVAL);
        });

        it('should throw EINVAL when host is not string', async () => {
            const proc = createMockProcess();

            await expect(
                dispatcher.dispatch(proc, 'connect', ['tcp', 123, 80])
            ).rejects.toBeInstanceOf(EINVAL);
        });

        it('should throw EINVAL when port is not number', async () => {
            const proc = createMockProcess();

            await expect(
                dispatcher.dispatch(proc, 'connect', ['tcp', 'example.com', '80'])
            ).rejects.toBeInstanceOf(EINVAL);
        });
    });

    describe('port', () => {
        it('should create port and return port id', async () => {
            const proc = createMockProcess();
            const portId = await dispatcher.dispatch(proc, 'port', ['tcp:listen', { port: 8080 }]);

            expect(typeof portId).toBe('number');
            expect(portId).toBe(0); // First port
        });

        it('should throw EINVAL when type is not string', async () => {
            const proc = createMockProcess();

            await expect(
                dispatcher.dispatch(proc, 'port', [123, {}])
            ).rejects.toBeInstanceOf(EINVAL);
        });
    });

    describe('pclose', () => {
        it('should throw EINVAL when portId is not number', async () => {
            const proc = createMockProcess();

            await expect(
                dispatcher.dispatch(proc, 'pclose', ['not-a-number'])
            ).rejects.toBeInstanceOf(EINVAL);
        });
    });
});
