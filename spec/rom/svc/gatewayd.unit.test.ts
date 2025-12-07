/**
 * gatewayd Unit Tests
 *
 * Tests gatewayd logic in isolation using mocked dependencies.
 * This isolates gatewayd from the kernel to identify where failures occur.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { GatewayDeps } from '@rom/svc/gatewayd.js';
import { _test } from '@rom/svc/gatewayd.js';
import type { Response } from '@rom/lib/process/types.js';

// =============================================================================
// MOCK HELPERS
// =============================================================================

/**
 * Create a mock ClientState with injected deps.
 */
function createMockState(deps: GatewayDeps, overrides: Partial<{
    socketFd: number;
    clientId: string;
    readBuffer: string;
    disconnecting: boolean;
}> = {}) {
    return {
        socketFd: overrides.socketFd ?? 10,
        readBuffer: overrides.readBuffer ?? '',
        clientId: overrides.clientId ?? 'test-client',
        activeStreams: new Set<string>(),
        disconnecting: overrides.disconnecting ?? false,
        deps,
    };
}

/**
 * Create mock deps with all functions stubbed.
 */
function createMockDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
    return {
        listen: mock(() => Promise.resolve(5)),
        recv: mock(() => Promise.resolve({ fd: 10 })),
        read: mock(function* () { /* empty */ }),
        write: mock(() => Promise.resolve()),
        close: mock(() => Promise.resolve()),
        unlink: mock(() => Promise.resolve()),
        println: mock(() => Promise.resolve()),
        eprintln: mock(() => Promise.resolve()),
        syscallStream: mock(function* () { /* empty */ }),
        cancelStream: mock(() => {}),
        getSocketPath: () => '/tmp/test.sock',
        ...overrides,
    } as GatewayDeps;
}

/**
 * Capture what was written to the socket.
 */
function captureWrites(): { writes: Uint8Array[]; writeFn: GatewayDeps['write'] } {
    const writes: Uint8Array[] = [];
    const writeFn = mock((fd: number, data: Uint8Array) => {
        writes.push(data);

        return Promise.resolve();
    });

    return { writes, writeFn: writeFn as unknown as GatewayDeps['write'] };
}

/**
 * Parse captured writes as JSON lines.
 */
function parseWrites(writes: Uint8Array[]): unknown[] {
    const decoder = new TextDecoder();

    return writes.map(w => {
        const text = decoder.decode(w).trim();

        return JSON.parse(text);
    });
}

// =============================================================================
// TESTS: encodeBase64
// =============================================================================

describe('gatewayd unit tests', () => {
    beforeEach(() => {
        _test.resetNextClientId();
        _test.clients.clear();
    });

    describe('encodeBase64', () => {
        it('should encode empty array', () => {
            const result = _test.encodeBase64(new Uint8Array([]));

            expect(result).toBe('');
        });

        it('should encode "hello"', () => {
            const bytes = new TextEncoder().encode('hello');
            const result = _test.encodeBase64(bytes);

            expect(result).toBe('aGVsbG8=');
        });

        it('should encode binary data', () => {
            const bytes = new Uint8Array([0, 255, 128, 64]);
            const result = _test.encodeBase64(bytes);

            expect(result).toBe('AP+AQA==');
        });
    });

    // =========================================================================
    // TESTS: prepareResponseForWire
    // =========================================================================

    describe('prepareResponseForWire', () => {
        it('should pass through response without bytes', () => {
            const response: Response = { op: 'ok', data: 42 };
            const result = _test.prepareResponseForWire(response);

            expect(result).toEqual({ op: 'ok', data: 42 });
        });

        it('should encode bytes as base64', () => {
            const response = {
                op: 'data' as const,
                bytes: new Uint8Array([104, 101, 108, 108, 111]),
            };
            const result = _test.prepareResponseForWire(response);

            expect(result).toEqual({
                op: 'data',
                bytes: 'aGVsbG8=',
            });
        });
    });

    // =========================================================================
    // TESTS: safeWrite
    // =========================================================================

    describe('safeWrite', () => {
        it('should return false if disconnecting', async () => {
            const deps = createMockDeps();
            const state = createMockState(deps, { disconnecting: true });

            const result = await _test.safeWrite(state, new Uint8Array([1, 2, 3]));

            expect(result).toBe(false);
            expect(deps.write).not.toHaveBeenCalled();
        });

        it('should call write and return true on success', async () => {
            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({ write: writeFn });
            const state = createMockState(deps);
            const data = new Uint8Array([1, 2, 3]);

            const result = await _test.safeWrite(state, data);

            expect(result).toBe(true);
            expect(writes.length).toBe(1);
            expect(writes[0]).toEqual(data);
        });

        it('should mark disconnecting and return false on write error', async () => {
            const deps = createMockDeps({
                write: mock(() => Promise.reject(new Error('socket closed'))) as unknown as GatewayDeps['write'],
            });
            const state = createMockState(deps);

            const result = await _test.safeWrite(state, new Uint8Array([1, 2, 3]));

            expect(result).toBe(false);
            expect(state.disconnecting).toBe(true);
        });
    });

    // =========================================================================
    // TESTS: sendResponse
    // =========================================================================

    describe('sendResponse', () => {
        it('should send JSON-formatted response', async () => {
            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({ write: writeFn });
            const state = createMockState(deps);
            const response: Response = { op: 'ok', data: 123 };

            const result = await _test.sendResponse(state, 'req-001', response);

            expect(result).toBe(true);

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(1);
            expect(parsed[0]).toEqual({
                type: 'response',
                id: 'req-001',
                result: { op: 'ok', data: 123 },
            });
        });
    });

    // =========================================================================
    // TESTS: sendError
    // =========================================================================

    describe('sendError', () => {
        it('should send JSON-formatted error', async () => {
            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({ write: writeFn });
            const state = createMockState(deps);

            const result = await _test.sendError(state, 'req-002', 'ENOENT', 'Not found');

            expect(result).toBe(true);

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(1);
            expect(parsed[0]).toEqual({
                type: 'response',
                id: 'req-002',
                error: { code: 'ENOENT', message: 'Not found' },
            });
        });
    });

    // =========================================================================
    // TESTS: processMessage
    // =========================================================================

    describe('processMessage', () => {
        it('should send error for invalid JSON', async () => {
            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({ write: writeFn });
            const state = createMockState(deps);

            await _test.processMessage(state, 'not valid json');

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(1);
            expect(parsed[0]).toEqual({
                type: 'response',
                id: 'parse',
                error: { code: 'EINVAL', message: 'Invalid JSON' },
            });
        });

        it('should send error for unknown message type', async () => {
            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({ write: writeFn });
            const state = createMockState(deps);

            await _test.processMessage(state, '{"type":"unknown","id":"x"}');

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(1);
            expect(parsed[0]).toEqual({
                type: 'response',
                id: 'x',
                error: { code: 'EINVAL', message: 'Unknown message type: unknown' },
            });
        });

        it('should not dispatch if disconnecting', async () => {
            const deps = createMockDeps();
            const state = createMockState(deps, { disconnecting: true });

            await _test.processMessage(state, '{"type":"syscall","id":"x","name":"test","args":[]}');

            // syscallStream should not be called
            expect(deps.syscallStream).not.toHaveBeenCalled();
        });

        it('should dispatch syscall for valid request', async () => {
            // Create a mock syscallStream that yields one response
            async function* mockSyscallStream(_name: string, ..._args: unknown[]): AsyncIterable<Response> {
                yield { op: 'ok', data: 42 };
            }

            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({
                write: writeFn,
                syscallStream: mockSyscallStream as unknown as GatewayDeps['syscallStream'],
            });
            const state = createMockState(deps);

            await _test.processMessage(state, '{"type":"syscall","id":"req-1","name":"test:call","args":[1,2,3]}');

            // Wait for fire-and-forget dispatch to complete
            await Bun.sleep(10);

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(1);
            expect(parsed[0]).toEqual({
                type: 'response',
                id: 'req-1',
                result: { op: 'ok', data: 42 },
            });
        });
    });

    // =========================================================================
    // TESTS: dispatchSyscall
    // =========================================================================

    describe('dispatchSyscall', () => {
        it('should forward all responses until terminal op', async () => {
            async function* mockSyscallStream(): AsyncIterable<Response> {
                yield { op: 'item', data: 'first' };
                yield { op: 'item', data: 'second' };
                yield { op: 'done' };
            }

            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({
                write: writeFn,
                syscallStream: mockSyscallStream as unknown as GatewayDeps['syscallStream'],
            });
            const state = createMockState(deps);

            await _test.dispatchSyscall(state, 'stream-1', 'test:list', []);

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(3);
            expect(parsed[0]).toEqual({
                type: 'response',
                id: 'stream-1',
                result: { op: 'item', data: 'first' },
            });
            expect(parsed[1]).toEqual({
                type: 'response',
                id: 'stream-1',
                result: { op: 'item', data: 'second' },
            });
            expect(parsed[2]).toEqual({
                type: 'response',
                id: 'stream-1',
                result: { op: 'done' },
            });
        });

        it('should cancel stream and stop on disconnect', async () => {
            let yieldCount = 0;

            async function* mockSyscallStream(): AsyncIterable<Response> {
                while (true) {
                    yieldCount++;
                    yield { op: 'item', data: yieldCount };
                }
            }

            const cancelStreamMock = mock(() => {});
            const { writeFn } = captureWrites();
            const deps = createMockDeps({
                write: writeFn,
                syscallStream: mockSyscallStream as unknown as GatewayDeps['syscallStream'],
                cancelStream: cancelStreamMock,
            });
            const state = createMockState(deps);

            // Disconnect after receiving one item
            const originalWrite = deps.write;

            deps.write = (async (fd: number, data: Uint8Array) => {
                await originalWrite(fd, data);
                state.disconnecting = true;
            }) as typeof deps.write;

            await _test.dispatchSyscall(state, 'stream-2', 'test:infinite', []);

            expect(cancelStreamMock).toHaveBeenCalledWith('stream-2');
            // Should have stopped after disconnect
            expect(yieldCount).toBeLessThan(10);
        });

        it('should track and cleanup activeStreams', async () => {
            async function* mockSyscallStream(): AsyncIterable<Response> {
                yield { op: 'ok', data: 'done' };
            }

            const deps = createMockDeps({
                syscallStream: mockSyscallStream as unknown as GatewayDeps['syscallStream'],
            });
            const state = createMockState(deps);

            expect(state.activeStreams.size).toBe(0);

            const promise = _test.dispatchSyscall(state, 'stream-3', 'test', []);

            // Stream should be registered during execution
            // (it completes too fast to check mid-execution, but we can verify cleanup)

            await promise;

            expect(state.activeStreams.size).toBe(0);
        });

        it('should send error response when syscallStream throws', async () => {
            async function* mockSyscallStream(): AsyncIterable<Response> {
                throw Object.assign(new Error('Kernel panic'), { code: 'EIO' });
            }

            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({
                write: writeFn,
                syscallStream: mockSyscallStream as unknown as GatewayDeps['syscallStream'],
            });
            const state = createMockState(deps);

            await _test.dispatchSyscall(state, 'err-1', 'test:fail', []);

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(1);
            expect(parsed[0]).toEqual({
                type: 'response',
                id: 'err-1',
                error: { code: 'EIO', message: 'Kernel panic' },
            });
        });
    });

    // =========================================================================
    // TESTS: handleClient (simplified - tests message processing loop)
    // =========================================================================

    describe('handleClient', () => {
        it('should process multiple messages from read stream', async () => {
            // Mock read that yields two messages then closes
            async function* mockRead(): AsyncIterable<Uint8Array> {
                const msg1 = '{"type":"syscall","id":"a","name":"test1","args":[]}\n';
                const msg2 = '{"type":"syscall","id":"b","name":"test2","args":[]}\n';

                yield new TextEncoder().encode(msg1 + msg2);
            }

            async function* mockSyscallStream(name: string): AsyncIterable<Response> {
                yield { op: 'ok', data: name };
            }

            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({
                read: mockRead as unknown as GatewayDeps['read'],
                write: writeFn,
                syscallStream: mockSyscallStream as unknown as GatewayDeps['syscallStream'],
            });
            const state = createMockState(deps);

            await _test.handleClient(state);

            // Wait for fire-and-forget dispatches
            await Bun.sleep(20);

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(2);
            expect((parsed[0] as { result: { data: string } }).result.data).toBe('test1');
            expect((parsed[1] as { result: { data: string } }).result.data).toBe('test2');
        });

        it('should handle partial messages across chunks', async () => {
            async function* mockRead(): AsyncIterable<Uint8Array> {
                // Split a message across two chunks
                yield new TextEncoder().encode('{"type":"syscall","id":"x",');
                yield new TextEncoder().encode('"name":"test","args":[]}\n');
            }

            async function* mockSyscallStream(): AsyncIterable<Response> {
                yield { op: 'ok', data: 'split-success' };
            }

            const { writes, writeFn } = captureWrites();
            const deps = createMockDeps({
                read: mockRead as unknown as GatewayDeps['read'],
                write: writeFn,
                syscallStream: mockSyscallStream as unknown as GatewayDeps['syscallStream'],
            });
            const state = createMockState(deps);

            await _test.handleClient(state);
            await Bun.sleep(10);

            const parsed = parseWrites(writes);

            expect(parsed.length).toBe(1);
            expect((parsed[0] as { result: { data: string } }).result.data).toBe('split-success');
        });

        it('should mark disconnecting and cleanup on exit', async () => {
            async function* mockRead(): AsyncIterable<Uint8Array> {
                // Empty - immediate close
            }

            const closeMock = mock(() => Promise.resolve());
            const deps = createMockDeps({
                read: mockRead as unknown as GatewayDeps['read'],
                close: closeMock as unknown as GatewayDeps['close'],
            });
            const state = createMockState(deps);

            await _test.handleClient(state);

            expect(state.disconnecting).toBe(true);
            expect(closeMock).toHaveBeenCalledWith(state.socketFd);
        });
    });

    // =========================================================================
    // TESTS: cleanupClient
    // =========================================================================

    describe('cleanupClient', () => {
        it('should cancel all active streams', async () => {
            const cancelMock = mock(() => {});
            const deps = createMockDeps({
                cancelStream: cancelMock,
            });
            const state = createMockState(deps);

            state.activeStreams.add('stream-a');
            state.activeStreams.add('stream-b');

            await _test.cleanupClient(state);

            expect(cancelMock).toHaveBeenCalledTimes(2);
            expect(cancelMock).toHaveBeenCalledWith('stream-a');
            expect(cancelMock).toHaveBeenCalledWith('stream-b');
            expect(state.activeStreams.size).toBe(0);
        });

        it('should close socket and ignore errors', async () => {
            const closeMock = mock(() => Promise.reject(new Error('already closed')));
            const deps = createMockDeps({
                close: closeMock as unknown as GatewayDeps['close'],
            });
            const state = createMockState(deps);

            // Should not throw
            await _test.cleanupClient(state);

            expect(closeMock).toHaveBeenCalledWith(state.socketFd);
        });
    });
});
