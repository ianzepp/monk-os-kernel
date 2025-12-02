/**
 * Channel Syscall Tests
 *
 * Tests for channel:open, channel:call, channel:stream, channel:close syscalls.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SyscallDispatcher, createChannelSyscalls } from '@src/kernel/syscalls.js';
import type { Process } from '@src/kernel/types.js';
import type { HAL, Channel, ChannelOpts } from '@src/hal/index.js';
import type { Message, Response } from '@src/message.js';
import { respond, unwrapStream, collectItems } from '@src/message.js';

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
 * Create a mock channel that returns predefined responses
 */
function createMockChannel(responses: Response[]): Channel {
    let closed = false;
    return {
        id: crypto.randomUUID(),
        proto: 'mock',
        description: 'mock://test',
        async *handle(_msg: Message): AsyncIterable<Response> {
            for (const r of responses) {
                yield r;
            }
        },
        async push(_response: Response): Promise<void> {
            throw new Error('push not supported');
        },
        async recv(): Promise<Message> {
            throw new Error('recv not supported');
        },
        async close(): Promise<void> {
            closed = true;
        },
        get closed(): boolean {
            return closed;
        },
    };
}

/**
 * Create a streaming mock channel that yields items then done
 */
function createStreamingChannel(items: unknown[]): Channel {
    let closed = false;
    return {
        id: crypto.randomUUID(),
        proto: 'mock',
        description: 'mock://stream',
        async *handle(_msg: Message): AsyncIterable<Response> {
            for (const item of items) {
                yield respond.item(item);
            }
            yield respond.done();
        },
        async push(_response: Response): Promise<void> {
            throw new Error('push not supported');
        },
        async recv(): Promise<Message> {
            throw new Error('recv not supported');
        },
        async close(): Promise<void> {
            closed = true;
        },
        get closed(): boolean {
            return closed;
        },
    };
}

describe('Channel Syscalls', () => {
    let dispatcher: SyscallDispatcher;
    let channels: Map<number, Channel>;
    let nextChannelId: number;

    beforeEach(() => {
        channels = new Map();
        nextChannelId = 10;

        const mockHal = {} as HAL;

        const openChannel = async (_proc: Process, _proto: string, _url: string, _opts?: ChannelOpts): Promise<number> => {
            const id = nextChannelId++;
            channels.set(id, createMockChannel([respond.ok({ connected: true })]));
            return id;
        };

        const getChannel = (_proc: Process, ch: number): Channel | undefined => {
            return channels.get(ch);
        };

        const closeHandle = async (_proc: Process, ch: number): Promise<void> => {
            const channel = channels.get(ch);
            if (channel) {
                await channel.close();
                channels.delete(ch);
            }
        };

        dispatcher = new SyscallDispatcher();
        dispatcher.registerAll(createChannelSyscalls(mockHal, openChannel, getChannel, closeHandle));
    });

    describe('channel:open', () => {
        it('should open a channel and return handle', async () => {
            const proc = createMockProcess();
            const ch = await unwrapStream<number>(
                dispatcher.dispatch(proc, 'channel:open', ['http', 'https://api.example.com'])
            );
            expect(ch).toBe(10);
            expect(channels.has(10)).toBe(true);
        });

        it('should pass options to channel', async () => {
            const proc = createMockProcess();
            const ch = await unwrapStream<number>(
                dispatcher.dispatch(proc, 'channel:open', ['http', 'https://api.example.com', { timeout: 5000 }])
            );
            expect(ch).toBeNumber();
        });

        it('should reject non-string proto', async () => {
            const proc = createMockProcess();
            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:open', [123, 'url']))
            ).rejects.toThrow('proto must be a string');
        });

        it('should reject non-string url', async () => {
            const proc = createMockProcess();
            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:open', ['http', 123]))
            ).rejects.toThrow('url must be a string');
        });
    });

    describe('channel:call', () => {
        it('should send message and return response', async () => {
            const proc = createMockProcess();

            // Set up channel with custom response
            channels.set(5, createMockChannel([respond.ok({ data: 'test' })]));

            const response = await unwrapStream<{ data: string }>(
                dispatcher.dispatch(proc, 'channel:call', [5, { op: 'request', data: {} }])
            );
            expect(response).toEqual({ data: 'test' });
        });

        it('should return first terminal response (ok)', async () => {
            const proc = createMockProcess();

            // Channel that yields progress then ok
            channels.set(5, createMockChannel([
                respond.progress(50),
                respond.ok({ result: 'done' }),
            ]));

            const response = await unwrapStream<{ result: string }>(
                dispatcher.dispatch(proc, 'channel:call', [5, { op: 'request', data: {} }])
            );
            expect(response).toEqual({ result: 'done' });
        });

        it('should return error response', async () => {
            const proc = createMockProcess();

            channels.set(5, createMockChannel([respond.error('ENOENT', 'Not found')]));

            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:call', [5, { op: 'request', data: {} }]))
            ).rejects.toThrow('Not found');
        });

        it('should reject invalid channel handle', async () => {
            const proc = createMockProcess();
            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:call', [999, { op: 'request', data: {} }]))
            ).rejects.toThrow('Bad channel: 999');
        });

        it('should reject non-number channel', async () => {
            const proc = createMockProcess();
            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:call', ['not-a-number', {}]))
            ).rejects.toThrow('ch must be a number');
        });
    });

    describe('channel:stream', () => {
        it('should yield all responses from channel', async () => {
            const proc = createMockProcess();

            channels.set(5, createStreamingChannel([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
                { id: 3, name: 'Carol' },
            ]));

            const items = await collectItems<{ id: number; name: string }>(
                dispatcher.dispatch(proc, 'channel:stream', [5, { op: 'query', data: {} }])
            );

            expect(items).toHaveLength(3);
            expect(items[0]).toEqual({ id: 1, name: 'Alice' });
            expect(items[1]).toEqual({ id: 2, name: 'Bob' });
            expect(items[2]).toEqual({ id: 3, name: 'Carol' });
        });

        it('should yield items until done', async () => {
            const proc = createMockProcess();

            channels.set(5, createStreamingChannel(['a', 'b', 'c']));

            const responses: Response[] = [];
            for await (const r of dispatcher.dispatch(proc, 'channel:stream', [5, { op: 'query', data: {} }])) {
                responses.push(r);
            }

            expect(responses).toHaveLength(4); // 3 items + done
            expect(responses[0].op).toBe('item');
            expect(responses[1].op).toBe('item');
            expect(responses[2].op).toBe('item');
            expect(responses[3].op).toBe('done');
        });

        it('should propagate errors', async () => {
            const proc = createMockProcess();

            // Channel that yields item then error
            let closed = false;
            channels.set(5, {
                id: crypto.randomUUID(),
                proto: 'mock',
                description: 'mock://error',
                async *handle(_msg: Message): AsyncIterable<Response> {
                    yield respond.item({ partial: true });
                    yield respond.error('EIO', 'Connection lost');
                },
                async push(): Promise<void> { throw new Error('not supported'); },
                async recv(): Promise<Message> { throw new Error('not supported'); },
                async close(): Promise<void> { closed = true; },
                get closed(): boolean { return closed; },
            });

            const responses: Response[] = [];
            for await (const r of dispatcher.dispatch(proc, 'channel:stream', [5, { op: 'query', data: {} }])) {
                responses.push(r);
            }

            expect(responses).toHaveLength(2);
            expect(responses[0].op).toBe('item');
            expect(responses[1].op).toBe('error');
        });

        it('should reject invalid channel handle', async () => {
            const proc = createMockProcess();

            const responses: Response[] = [];
            for await (const r of dispatcher.dispatch(proc, 'channel:stream', [999, { op: 'query', data: {} }])) {
                responses.push(r);
            }

            expect(responses).toHaveLength(1);
            expect(responses[0].op).toBe('error');
            expect((responses[0].data as { code: string }).code).toBe('EBADF');
        });
    });

    describe('channel:close', () => {
        it('should close the channel', async () => {
            const proc = createMockProcess();

            const mockChannel = createMockChannel([respond.ok()]);
            channels.set(5, mockChannel);

            await unwrapStream(dispatcher.dispatch(proc, 'channel:close', [5]));

            expect(mockChannel.closed).toBe(true);
            expect(channels.has(5)).toBe(false);
        });

        it('should reject non-number channel', async () => {
            const proc = createMockProcess();
            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:close', ['not-a-number']))
            ).rejects.toThrow('ch must be a number');
        });
    });

    describe('channel:push', () => {
        it('should push response to channel', async () => {
            const proc = createMockProcess();

            let pushedResponse: Response | null = null;
            let closed = false;
            channels.set(5, {
                id: crypto.randomUUID(),
                proto: 'mock',
                description: 'mock://push',
                async *handle(_msg: Message): AsyncIterable<Response> {
                    yield respond.ok();
                },
                async push(response: Response): Promise<void> {
                    pushedResponse = response;
                },
                async recv(): Promise<Message> { throw new Error('not supported'); },
                async close(): Promise<void> { closed = true; },
                get closed(): boolean { return closed; },
            });

            await unwrapStream(
                dispatcher.dispatch(proc, 'channel:push', [5, { op: 'event', data: { type: 'test' } }])
            );

            expect(pushedResponse).toEqual({ op: 'event', data: { type: 'test' } });
        });

        it('should reject invalid channel', async () => {
            const proc = createMockProcess();
            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:push', [999, { op: 'ok' }]))
            ).rejects.toThrow('Bad channel: 999');
        });
    });

    describe('channel:recv', () => {
        it('should receive message from channel', async () => {
            const proc = createMockProcess();

            let closed = false;
            channels.set(5, {
                id: crypto.randomUUID(),
                proto: 'mock',
                description: 'mock://recv',
                async *handle(_msg: Message): AsyncIterable<Response> {
                    yield respond.ok();
                },
                async push(_response: Response): Promise<void> { throw new Error('not supported'); },
                async recv(): Promise<Message> {
                    return { op: 'message', data: { text: 'hello' } };
                },
                async close(): Promise<void> { closed = true; },
                get closed(): boolean { return closed; },
            });

            const msg = await unwrapStream<Message>(
                dispatcher.dispatch(proc, 'channel:recv', [5])
            );

            expect(msg).toEqual({ op: 'message', data: { text: 'hello' } });
        });

        it('should reject invalid channel', async () => {
            const proc = createMockProcess();
            await expect(
                unwrapStream(dispatcher.dispatch(proc, 'channel:recv', [999]))
            ).rejects.toThrow('Bad channel: 999');
        });
    });
});
