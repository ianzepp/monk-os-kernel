/**
 * File Syscalls Tests
 *
 * Tests for file operation syscalls including send/recv for message-based I/O.
 * These are critical for shell pipelines.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createFileSyscalls } from '@src/kernel/syscalls/file.js';
import type { Process, OpenFlags } from '@src/kernel/types.js';
import type { Handle, HandleType } from '@src/kernel/handle.js';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { ModelStat } from '@src/vfs/model.js';
import { ENOENT } from '@src/hal/errors.js';
import { SyscallDispatcher } from '@src/kernel/syscalls/dispatcher.js';

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
        env: { HOME: '/home/test', PATH: '/bin' },
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
 * Mock handle that records operations
 */
class MockHandle implements Handle {
    readonly id: string;
    readonly type: HandleType = 'file';
    readonly description: string;
    private _closed = false;

    // Recorded messages
    messages: Message[] = [];

    // Responses to return for each op
    private recvResponses: Response[] = [respond.done()];
    private sendResponses: Response[] = [respond.ok()];

    constructor(id: string, description = 'mock') {
        this.id = id;
        this.description = description;
    }

    get closed(): boolean {
        return this._closed;
    }

    setRecvResponses(responses: Response[]): void {
        this.recvResponses = responses;
    }

    setSendResponses(responses: Response[]): void {
        this.sendResponses = responses;
    }

    async *exec(msg: Message): AsyncIterable<Response> {
        this.messages.push(msg);
        if (msg.op === 'recv') {
            for (const r of this.recvResponses) {
                yield r;
            }
        } else if (msg.op === 'send') {
            for (const r of this.sendResponses) {
                yield r;
            }
        } else {
            yield respond.ok();
        }
    }

    async close(): Promise<void> {
        this._closed = true;
    }
}

/**
 * Collect all responses from an async iterable
 */
async function collectResponses(iterable: AsyncIterable<Response>): Promise<Response[]> {
    const results: Response[] = [];
    for await (const response of iterable) {
        results.push(response);
    }
    return results;
}

describe('File Syscalls: send/recv', () => {
    let dispatcher: SyscallDispatcher;
    let mockVfs: VFS;
    let handles: Map<number, Handle>;

    function getHandle(_proc: Process, fd: number): Handle | undefined {
        return handles.get(fd);
    }

    async function openFile(_proc: Process, _path: string, _flags: OpenFlags): Promise<number> {
        return 3; // Next available fd
    }

    async function closeHandle(_proc: Process, fd: number): Promise<void> {
        handles.delete(fd);
    }

    beforeEach(() => {
        handles = new Map();

        // Minimal mock VFS
        mockVfs = {
            stat: async (path: string, _caller: string): Promise<ModelStat> => {
                if (path === '/test.txt') {
                    return {
                        id: 'mock-id',
                        model: 'file',
                        name: 'test.txt',
                        parent: null,
                        owner: 'root',
                        size: 100,
                        mtime: Date.now(),
                        ctime: Date.now(),
                    };
                }
                throw new ENOENT(`No such file: ${path}`);
            },
        } as VFS;

        dispatcher = new SyscallDispatcher();
        dispatcher.registerAll(createFileSyscalls(mockVfs, {} as any, getHandle, openFile, closeHandle));
    });

    describe('file:recv syscall', () => {
        it('should forward recv to handle', async () => {
            const proc = createMockProcess();
            const handle = new MockHandle('stdin', 'stdin');
            handle.setRecvResponses([respond.item({ text: 'hello\n' }), respond.done()]);
            handles.set(0, handle);

            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:recv', [0]));

            expect(handle.messages.length).toBe(1);
            expect(handle.messages[0]!.op).toBe('recv');
            expect(responses.length).toBe(2);
            expect(responses[0]!.op).toBe('item');
            expect(responses[1]!.op).toBe('done');
        });

        it('should return EBADF for invalid fd', async () => {
            const proc = createMockProcess();
            // No handle at fd 99

            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:recv', [99]));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });

        it('should return EINVAL for non-number fd', async () => {
            const proc = createMockProcess();

            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:recv', ['not-a-number']));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EINVAL');
        });

        it('should yield all responses from handle', async () => {
            const proc = createMockProcess();
            const handle = new MockHandle('stdin', 'stdin');
            handle.setRecvResponses([
                respond.item({ text: 'line1\n' }),
                respond.item({ text: 'line2\n' }),
                respond.item({ text: 'line3\n' }),
                respond.done(),
            ]);
            handles.set(0, handle);

            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:recv', [0]));

            expect(responses.length).toBe(4);
            expect(responses[0]!.op).toBe('item');
            expect(responses[1]!.op).toBe('item');
            expect(responses[2]!.op).toBe('item');
            expect(responses[3]!.op).toBe('done');
        });
    });

    describe('file:send syscall', () => {
        it('should forward send to handle', async () => {
            const proc = createMockProcess();
            const handle = new MockHandle('stdout', 'stdout');
            handles.set(1, handle);

            const msg = respond.item({ text: 'hello\n' });
            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:send', [1, msg]));

            expect(handle.messages.length).toBe(1);
            expect(handle.messages[0]!.op).toBe('send');
            expect(handle.messages[0]!.data).toEqual(msg);
            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
        });

        it('should return EBADF for invalid fd', async () => {
            const proc = createMockProcess();
            const msg = respond.item({ text: 'test' });

            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:send', [99, msg]));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });

        it('should return EINVAL for non-number fd', async () => {
            const proc = createMockProcess();
            const msg = respond.item({ text: 'test' });

            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:send', ['not-a-number', msg]));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EINVAL');
        });

        it('should pass message data to handle', async () => {
            const proc = createMockProcess();
            const handle = new MockHandle('stdout', 'stdout');
            handles.set(1, handle);

            const msg = respond.data(new Uint8Array([1, 2, 3]));
            await collectResponses(dispatcher.dispatch(proc, 'file:send', [1, msg]));

            expect(handle.messages[0]!.data).toEqual(msg);
        });
    });

    describe('file:send/file:recv integration pattern', () => {
        it('should support cat-like recv-then-send pattern', async () => {
            const proc = createMockProcess();

            // Stdin handle with one message then EOF
            const stdin = new MockHandle('stdin', 'stdin');
            stdin.setRecvResponses([
                respond.item({ text: 'piped data\n' }),
                respond.done(),
            ]);
            handles.set(0, stdin);

            // Stdout handle
            const stdout = new MockHandle('stdout', 'stdout');
            handles.set(1, stdout);

            // Simulate cat: recv from stdin, send to stdout
            const recvResponses = await collectResponses(dispatcher.dispatch(proc, 'file:recv', [0]));

            for (const r of recvResponses) {
                if (r.op === 'item') {
                    const sendResponses = await collectResponses(dispatcher.dispatch(proc, 'file:send', [1, r]));
                    expect(sendResponses.length).toBe(1);
                    expect(sendResponses[0]!.op).toBe('ok');
                }
            }

            // Verify stdout received the message
            expect(stdout.messages.length).toBe(1);
            expect(stdout.messages[0]!.op).toBe('send');
            expect((stdout.messages[0]!.data as Response).op).toBe('item');
        });

        it('should handle multiple messages in recv-send loop', async () => {
            const proc = createMockProcess();

            const stdin = new MockHandle('stdin', 'stdin');
            stdin.setRecvResponses([
                respond.item({ text: 'msg1\n' }),
                respond.item({ text: 'msg2\n' }),
                respond.item({ text: 'msg3\n' }),
                respond.done(),
            ]);
            handles.set(0, stdin);

            const stdout = new MockHandle('stdout', 'stdout');
            handles.set(1, stdout);

            // Cat-like loop
            const recvResponses = await collectResponses(dispatcher.dispatch(proc, 'file:recv', [0]));
            let itemCount = 0;

            for (const r of recvResponses) {
                if (r.op === 'item') {
                    itemCount++;
                    await collectResponses(dispatcher.dispatch(proc, 'file:send', [1, r]));
                }
            }

            expect(itemCount).toBe(3);
            expect(stdout.messages.length).toBe(3);
        });
    });
});

describe('File Syscalls: read/write', () => {
    let dispatcher: SyscallDispatcher;
    let handles: Map<number, Handle>;

    function getHandle(_proc: Process, fd: number): Handle | undefined {
        return handles.get(fd);
    }

    beforeEach(() => {
        handles = new Map();

        const mockVfs = {} as VFS;
        dispatcher = new SyscallDispatcher();
        dispatcher.registerAll(createFileSyscalls(
            mockVfs,
            {} as any,
            getHandle,
            async () => 3,
            async () => {}
        ));
    });

    describe('file:read syscall', () => {
        it('should forward read to handle recv', async () => {
            const proc = createMockProcess();
            const handle = new MockHandle('file', '/test.txt');
            handle.setRecvResponses([respond.data(new Uint8Array([65, 66, 67])), respond.done()]);
            handles.set(3, handle);

            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:read', [3]));

            expect(handle.messages.length).toBe(1);
            expect(handle.messages[0]!.op).toBe('recv');
            expect(responses.length).toBe(2);
        });

        it('should pass chunkSize to handle', async () => {
            const proc = createMockProcess();
            const handle = new MockHandle('file', '/test.txt');
            handles.set(3, handle);

            await collectResponses(dispatcher.dispatch(proc, 'file:read', [3, 4096]));

            expect(handle.messages[0]!.data).toEqual({ chunkSize: 4096 });
        });
    });

    describe('file:write syscall', () => {
        it('should forward write to handle send', async () => {
            const proc = createMockProcess();
            const handle = new MockHandle('file', '/test.txt');
            handles.set(3, handle);

            const data = new Uint8Array([65, 66, 67]);
            const responses = await collectResponses(dispatcher.dispatch(proc, 'file:write', [3, data]));

            expect(handle.messages.length).toBe(1);
            expect(handle.messages[0]!.op).toBe('send');
            expect(handle.messages[0]!.data).toEqual({ data });
            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
        });
    });
});
