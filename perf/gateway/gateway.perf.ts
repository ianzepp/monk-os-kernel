/**
 * Gateway Performance Tests
 *
 * Measures performance of the Unix socket gateway for external syscall access.
 *
 * Test categories:
 * - Connection latency (connect/disconnect cycles)
 * - Single syscall latency (round-trip time)
 * - Streaming syscall throughput
 * - Concurrent request handling
 * - EMS operations through gateway (primary use case)
 *
 * Run with: bun test ./perf/gateway/gateway.perf.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { pack, unpack } from 'msgpackr';
import { TestOS } from '../../spec/helpers/test-os.js';
import { BunNetworkDevice } from '@src/hal/index.js';
import type { Socket } from '@src/hal/network.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TIMEOUT_MEDIUM = 60_000;
const TIMEOUT_LONG = 120_000;

// =============================================================================
// TYPES
// =============================================================================

interface BenchResult {
    name: string;
    ops: number;
    totalMs: number;
    avgMs: number;
    opsPerSec: number;
}

interface GatewayResponse {
    id: string;
    op: string;
    data?: unknown;
    code?: string;
    message?: string;
    bytes?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatRate(count: number, ms: number): string {
    const perSec = (count / ms) * 1000;
    return `${perSec.toFixed(0)} ops/sec`;
}

function formatTime(ms: number): string {
    if (ms < 0.001) return `${(ms * 1_000_000).toFixed(0)}ns`;
    if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function printResults(title: string, results: BenchResult[]): void {
    console.log(`\n${title}`);
    console.log('+-----------------------+----------+------------+----------+------------+');
    console.log('| Test                  | Ops      | Total      | Avg/Op   | Throughput |');
    console.log('+-----------------------+----------+------------+----------+------------+');
    for (const r of results) {
        const name = r.name.padEnd(21);
        const ops = r.ops.toString().padStart(8);
        const total = formatTime(r.totalMs).padStart(10);
        const avg = formatTime(r.avgMs).padStart(8);
        const throughput = formatRate(r.ops, r.totalMs).padStart(10);
        console.log(`| ${name} | ${ops} | ${total} | ${avg} | ${throughput} |`);
    }
    console.log('+-----------------------+----------+------------+----------+------------+\n');
}

/**
 * Generate unique socket path for each test run.
 */
function getTestSocketPath(): string {
    return join(tmpdir(), `monk-gw-perf-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
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
 * Create a gateway client that sends/receives msgpack messages.
 * Uses length-prefixed framing: [4-byte big-endian length][msgpack payload]
 */
class GatewayClient {
    private socket?: Socket;
    private network = new BunNetworkDevice();
    private buffer = new Uint8Array(0);
    private nextId = 1;

    async connect(socketPath: string): Promise<void> {
        this.socket = await this.network.connect(socketPath, 0);
    }

    async close(): Promise<void> {
        if (this.socket) {
            await this.socket.close();
            this.socket = undefined;
        }
    }

    /**
     * Send a syscall and collect all responses until terminal op.
     */
    async call(syscall: string, args: unknown[] = []): Promise<GatewayResponse[]> {
        if (!this.socket) throw new Error('Not connected');

        const id = `req-${this.nextId++}`;

        // Send length-prefixed msgpack frame
        await this.socket.write(encodeFrame({ id, call: syscall, args }));

        const responses: GatewayResponse[] = [];

        while (true) {
            const response = await this.readResponse(id);

            if (!response) break;

            responses.push(response);

            // Terminal ops end stream
            if (response.op === 'ok' || response.op === 'error' ||
                response.op === 'done' || response.op === 'redirect') {
                break;
            }
        }

        return responses;
    }

    /**
     * Read next response for given request ID.
     * Parses length-prefixed msgpack frames.
     */
    private async readResponse(expectedId: string): Promise<GatewayResponse | null> {
        while (true) {
            // Check buffer for complete message (4-byte length prefix + payload)
            if (this.buffer.length >= 4) {
                const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
                const msgLength = view.getUint32(0);

                if (this.buffer.length >= 4 + msgLength) {
                    // Extract and decode message
                    const payload = this.buffer.slice(4, 4 + msgLength);

                    this.buffer = this.buffer.slice(4 + msgLength);

                    const response = unpack(payload) as GatewayResponse;

                    if (response.id === expectedId) {
                        return response;
                    }
                    // Different ID - continue reading (shouldn't happen in sequential mode)
                }
            }

            // Need more data
            if (!this.socket) return null;

            const chunk = await this.socket.read({ timeout: 30000 });

            if (chunk.length === 0) return null;

            // Append chunk to buffer
            const newBuffer = new Uint8Array(this.buffer.length + chunk.length);

            newBuffer.set(this.buffer);
            newBuffer.set(chunk, this.buffer.length);
            this.buffer = newBuffer;
        }
    }
}

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Gateway Performance', () => {
    let os: TestOS;
    let socketPath: string;

    beforeAll(async () => {
        // Use unique socket path to avoid conflicts
        socketPath = getTestSocketPath();

        // Boot OS with in-memory storage and custom socket path
        // OS automatically creates and starts Gateway during boot
        os = new TestOS({
            storage: { type: 'memory' },
            env: { MONK_SOCKET: socketPath },
        });
        await os.boot();
    });

    afterAll(async () => {
        await os?.shutdown();

        if (existsSync(socketPath)) {
            rmSync(socketPath);
        }
    });

    // =========================================================================
    // CONNECTION LATENCY
    // =========================================================================

    describe('Connection Latency', () => {
        it('connect/disconnect cycle (100 iterations)', async () => {
            const iterations = 100;
            const network = new BunNetworkDevice();

            const start = performance.now();

            for (let i = 0; i < iterations; i++) {
                const socket = await network.connect(socketPath, 0);
                await socket.close();
            }

            const elapsed = performance.now() - start;

            printResults('Connection Latency', [{
                name: 'Connect/Disconnect',
                ops: iterations,
                totalMs: elapsed,
                avgMs: elapsed / iterations,
                opsPerSec: (iterations / elapsed) * 1000,
            }]);

            expect(elapsed / iterations).toBeLessThan(10); // <10ms per cycle
        }, { timeout: TIMEOUT_MEDIUM });

        it('concurrent connections (50 clients)', async () => {
            const clients = 50;
            const network = new BunNetworkDevice();

            const start = performance.now();

            // Connect all clients
            const sockets = await Promise.all(
                Array.from({ length: clients }, () => network.connect(socketPath, 0))
            );

            const connectTime = performance.now() - start;

            // Close all clients
            const closeStart = performance.now();
            await Promise.all(sockets.map(s => s.close()));
            const closeTime = performance.now() - closeStart;

            printResults('Concurrent Connections', [
                {
                    name: 'Parallel Connect',
                    ops: clients,
                    totalMs: connectTime,
                    avgMs: connectTime / clients,
                    opsPerSec: (clients / connectTime) * 1000,
                },
                {
                    name: 'Parallel Close',
                    ops: clients,
                    totalMs: closeTime,
                    avgMs: closeTime / clients,
                    opsPerSec: (clients / closeTime) * 1000,
                },
            ]);

            expect(connectTime).toBeLessThan(5000);
        }, { timeout: TIMEOUT_MEDIUM });
    });

    // =========================================================================
    // SINGLE SYSCALL LATENCY
    // =========================================================================

    describe('Syscall Latency', () => {
        it('proc:getcwd latency (500 calls)', async () => {
            const iterations = 500;
            const client = new GatewayClient();
            await client.connect(socketPath);

            try {
                const start = performance.now();

                for (let i = 0; i < iterations; i++) {
                    const responses = await client.call('proc:getcwd');
                    expect(responses[0]?.op).toBe('ok');
                }

                const elapsed = performance.now() - start;

                printResults('Syscall Latency: proc:getcwd', [{
                    name: 'Round-trip',
                    ops: iterations,
                    totalMs: elapsed,
                    avgMs: elapsed / iterations,
                    opsPerSec: (iterations / elapsed) * 1000,
                }]);

                expect(elapsed / iterations).toBeLessThan(5); // <5ms per call
            }
            finally {
                await client.close();
            }
        }, { timeout: TIMEOUT_MEDIUM });

        it('proc:getpid latency (500 calls)', async () => {
            const iterations = 500;
            const client = new GatewayClient();
            await client.connect(socketPath);

            try {
                const start = performance.now();

                for (let i = 0; i < iterations; i++) {
                    const responses = await client.call('proc:getpid');
                    expect(responses[0]?.op).toBe('ok');
                }

                const elapsed = performance.now() - start;

                printResults('Syscall Latency: proc:getpid', [{
                    name: 'Round-trip',
                    ops: iterations,
                    totalMs: elapsed,
                    avgMs: elapsed / iterations,
                    opsPerSec: (iterations / elapsed) * 1000,
                }]);
            }
            finally {
                await client.close();
            }
        }, { timeout: TIMEOUT_MEDIUM });

        it('file:stat latency (500 calls)', async () => {
            const iterations = 500;
            const client = new GatewayClient();
            await client.connect(socketPath);

            try {
                const start = performance.now();

                for (let i = 0; i < iterations; i++) {
                    const responses = await client.call('file:stat', ['/']);
                    expect(responses[0]?.op).toBe('ok');
                }

                const elapsed = performance.now() - start;

                printResults('Syscall Latency: file:stat', [{
                    name: 'Round-trip',
                    ops: iterations,
                    totalMs: elapsed,
                    avgMs: elapsed / iterations,
                    opsPerSec: (iterations / elapsed) * 1000,
                }]);
            }
            finally {
                await client.close();
            }
        }, { timeout: TIMEOUT_MEDIUM });
    });

    // =========================================================================
    // STREAMING SYSCALL THROUGHPUT
    // =========================================================================

    describe('Streaming Throughput', () => {
        it('file:readdir with 100 entries', async () => {
            const iterations = 50;
            const client = new GatewayClient();
            await client.connect(socketPath);

            // Create test files
            for (let i = 0; i < 100; i++) {
                await client.call('file:write', [`/tmp/stream-test-${i}.txt`, 'test content']);
            }

            try {
                const start = performance.now();
                let totalItems = 0;

                for (let iter = 0; iter < iterations; iter++) {
                    const responses = await client.call('file:readdir', ['/tmp']);

                    for (const r of responses) {
                        if (r.op === 'item') totalItems++;
                    }
                }

                const elapsed = performance.now() - start;

                printResults('Streaming: file:readdir (100 entries)', [{
                    name: 'Directory listing',
                    ops: iterations,
                    totalMs: elapsed,
                    avgMs: elapsed / iterations,
                    opsPerSec: (iterations / elapsed) * 1000,
                }, {
                    name: 'Items received',
                    ops: totalItems,
                    totalMs: elapsed,
                    avgMs: elapsed / totalItems,
                    opsPerSec: (totalItems / elapsed) * 1000,
                }]);
            }
            finally {
                // Cleanup
                for (let i = 0; i < 100; i++) {
                    await client.call('file:unlink', [`/tmp/stream-test-${i}.txt`]).catch(() => {});
                }

                await client.close();
            }
        }, { timeout: TIMEOUT_MEDIUM });
    });

    // =========================================================================
    // EMS OPERATIONS THROUGH GATEWAY
    // =========================================================================

    describe('EMS Through Gateway', () => {
        it('ems:create single entity (200 ops)', async () => {
            const iterations = 200;
            const client = new GatewayClient();
            await client.connect(socketPath);

            try {
                const start = performance.now();

                for (let i = 0; i < iterations; i++) {
                    const responses = await client.call('ems:create', [
                        'file',
                        { pathname: `gw-perf-${i}.txt`, owner: 'perf-test', parent: null },
                    ]);
                    // ems:create returns 'ok' with the created entity
                    expect(responses[0]?.op).toBe('ok');
                }

                const elapsed = performance.now() - start;

                printResults('EMS: Create Single Entity', [{
                    name: 'ems:create',
                    ops: iterations,
                    totalMs: elapsed,
                    avgMs: elapsed / iterations,
                    opsPerSec: (iterations / elapsed) * 1000,
                }]);
            }
            finally {
                await client.close();
            }
        }, { timeout: TIMEOUT_LONG });

        it('ems:select by owner (50 queries)', async () => {
            const iterations = 50;
            const client = new GatewayClient();
            await client.connect(socketPath);

            // Pre-create entities
            const owner = `select-test-${Date.now()}`;

            for (let i = 0; i < 30; i++) {
                await client.call('ems:create', [
                    'file',
                    { pathname: `select-${i}.txt`, owner, parent: null },
                ]);
            }

            try {
                const start = performance.now();

                for (let i = 0; i < iterations; i++) {
                    const responses = await client.call('ems:select', ['file', { where: { owner } }]);

                    // Should get items + done
                    expect(responses.some(r => r.op === 'done' || r.op === 'ok')).toBe(true);
                }

                const elapsed = performance.now() - start;

                printResults('EMS: Select by Owner', [{
                    name: 'ems:select',
                    ops: iterations,
                    totalMs: elapsed,
                    avgMs: elapsed / iterations,
                    opsPerSec: (iterations / elapsed) * 1000,
                }]);
            }
            finally {
                await client.close();
            }
        }, { timeout: TIMEOUT_LONG });

        it('EMS CRUD cycle (100 cycles)', async () => {
            const cycles = 100;
            const client = new GatewayClient();
            await client.connect(socketPath);

            try {
                const start = performance.now();

                for (let i = 0; i < cycles; i++) {
                    // Create
                    const createResp = await client.call('ems:create', [
                        'file',
                        { pathname: `crud-${i}.txt`, owner: 'crud-test', parent: null },
                    ]);
                    const id = (createResp[0]?.data as { id?: string })?.id;
                    expect(id).toBeDefined();

                    // Read
                    await client.call('ems:select', ['file', { where: { id } }]);

                    // Update
                    await client.call('ems:update', ['file', id, { pathname: `crud-updated-${i}.txt` }]);

                    // Delete
                    await client.call('ems:delete', ['file', id]);
                }

                const elapsed = performance.now() - start;
                const totalOps = cycles * 4;

                printResults('EMS: CRUD Cycle', [{
                    name: 'Full CRUD',
                    ops: cycles,
                    totalMs: elapsed,
                    avgMs: elapsed / cycles,
                    opsPerSec: (cycles / elapsed) * 1000,
                }, {
                    name: 'Individual Ops',
                    ops: totalOps,
                    totalMs: elapsed,
                    avgMs: elapsed / totalOps,
                    opsPerSec: (totalOps / elapsed) * 1000,
                }]);
            }
            finally {
                await client.close();
            }
        }, { timeout: TIMEOUT_LONG });
    });

    // =========================================================================
    // CONCURRENT REQUESTS
    // =========================================================================

    describe('Concurrent Requests', () => {
        it('sequential syscalls on single connection (500 calls)', async () => {
            // NOTE: True parallel requests on a single connection require a
            // multiplexing client that can demux interleaved responses by ID.
            // This test measures sequential throughput on a persistent connection.
            const iterations = 500;
            const client = new GatewayClient();
            await client.connect(socketPath);

            try {
                const start = performance.now();

                for (let i = 0; i < iterations; i++) {
                    const responses = await client.call('proc:getcwd');
                    expect(responses[0]?.op).toBe('ok');
                }

                const elapsed = performance.now() - start;

                printResults('Sequential: Single Connection', [{
                    name: 'Sequential Syscalls',
                    ops: iterations,
                    totalMs: elapsed,
                    avgMs: elapsed / iterations,
                    opsPerSec: (iterations / elapsed) * 1000,
                }]);
            }
            finally {
                await client.close();
            }
        }, { timeout: TIMEOUT_MEDIUM });

        it('parallel clients with syscalls (20 clients x 50 calls)', async () => {
            const clientCount = 20;
            const callsPerClient = 50;

            const start = performance.now();

            // Create and run clients in parallel
            const clientWork = async () => {
                const client = new GatewayClient();
                await client.connect(socketPath);

                try {
                    for (let i = 0; i < callsPerClient; i++) {
                        const responses = await client.call('proc:getcwd');
                        expect(responses[0]?.op).toBe('ok');
                    }
                }
                finally {
                    await client.close();
                }
            };

            await Promise.all(
                Array.from({ length: clientCount }, () => clientWork())
            );

            const elapsed = performance.now() - start;
            const totalOps = clientCount * callsPerClient;

            printResults('Concurrent: Multiple Clients', [{
                name: 'Multi-client ops',
                ops: totalOps,
                totalMs: elapsed,
                avgMs: elapsed / totalOps,
                opsPerSec: (totalOps / elapsed) * 1000,
            }]);
        }, { timeout: TIMEOUT_LONG });
    });
});
