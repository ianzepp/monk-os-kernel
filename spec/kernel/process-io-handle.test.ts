/**
 * ProcessIOHandle Tests
 *
 * Tests for the process I/O handle that mediates stdin/stdout/stderr routing.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ProcessIOHandle, type Handle, type HandleType } from '@src/kernel/handle.js';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';

/**
 * Mock handle for testing - records messages sent to it
 */
class MockHandle implements Handle {
    readonly id: string;
    readonly type: HandleType = 'file';
    readonly description: string;
    private _closed = false;

    // Recorded messages
    messages: Message[] = [];

    // Responses to return
    private responses: Response[] = [respond.ok()];

    constructor(id: string, description = 'mock') {
        this.id = id;
        this.description = description;
    }

    get closed(): boolean {
        return this._closed;
    }

    setResponses(responses: Response[]): void {
        this.responses = responses;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        this.messages.push(msg);
        for (const response of this.responses) {
            yield response;
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

describe('ProcessIOHandle', () => {
    describe('constructor', () => {
        it('should create with id and description', () => {
            const handle = new ProcessIOHandle('test-id', 'test-description');

            expect(handle.id).toBe('test-id');
            expect(handle.description).toBe('test-description');
            expect(handle.type).toBe('process-io');
            expect(handle.closed).toBe(false);
        });

        it('should create with null target/source by default', () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            expect(handle.getTarget()).toBeNull();
            expect(handle.getSource()).toBeNull();
        });

        it('should accept target and source in options', () => {
            const target = new MockHandle('target');
            const source = new MockHandle('source');

            const handle = new ProcessIOHandle('test-id', 'test', {
                target,
                source,
            });

            expect(handle.getTarget()).toBe(target);
            expect(handle.getSource()).toBe(source);
        });
    });

    describe('target management', () => {
        it('should set and get target', () => {
            const handle = new ProcessIOHandle('test-id', 'test');
            const target = new MockHandle('target');

            handle.setTarget(target);

            expect(handle.getTarget()).toBe(target);
        });

        it('should allow setting target to null', () => {
            const target = new MockHandle('target');
            const handle = new ProcessIOHandle('test-id', 'test', { target });

            handle.setTarget(null);

            expect(handle.getTarget()).toBeNull();
        });
    });

    describe('source management', () => {
        it('should set and get source', () => {
            const handle = new ProcessIOHandle('test-id', 'test');
            const source = new MockHandle('source');

            handle.setSource(source);

            expect(handle.getSource()).toBe(source);
        });

        it('should allow setting source to null', () => {
            const source = new MockHandle('source');
            const handle = new ProcessIOHandle('test-id', 'test', { source });

            handle.setSource(null);

            expect(handle.getSource()).toBeNull();
        });
    });

    describe('tap management', () => {
        it('should start with empty taps', () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            expect(handle.getTaps().size).toBe(0);
        });

        it('should add taps', () => {
            const handle = new ProcessIOHandle('test-id', 'test');
            const tap1 = new MockHandle('tap1');
            const tap2 = new MockHandle('tap2');

            handle.addTap(tap1);
            handle.addTap(tap2);

            expect(handle.getTaps().size).toBe(2);
            expect(handle.getTaps().has(tap1)).toBe(true);
            expect(handle.getTaps().has(tap2)).toBe(true);
        });

        it('should remove taps', () => {
            const handle = new ProcessIOHandle('test-id', 'test');
            const tap1 = new MockHandle('tap1');
            const tap2 = new MockHandle('tap2');

            handle.addTap(tap1);
            handle.addTap(tap2);
            handle.removeTap(tap1);

            expect(handle.getTaps().size).toBe(1);
            expect(handle.getTaps().has(tap1)).toBe(false);
            expect(handle.getTaps().has(tap2)).toBe(true);
        });

        it('should not error when removing non-existent tap', () => {
            const handle = new ProcessIOHandle('test-id', 'test');
            const tap = new MockHandle('tap');

            handle.removeTap(tap); // Should not throw

            expect(handle.getTaps().size).toBe(0);
        });
    });

    describe('read operation', () => {
        it('should forward read to source', async () => {
            const source = new MockHandle('source');
            source.setResponses([respond.item(new Uint8Array([1, 2, 3])), respond.done()]);

            const handle = new ProcessIOHandle('test-id', 'test', { source });

            const responses = await collectResponses(
                handle.send({ op: 'read', data: { chunkSize: 1024 } })
            );

            expect(source.messages.length).toBe(1);
            expect(source.messages[0]!.op).toBe('read');
            expect(responses.length).toBe(2);
            expect(responses[0]!.op).toBe('item');
            expect(responses[1]!.op).toBe('done');
        });

        it('should error when no source configured', async () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            const responses = await collectResponses(handle.send({ op: 'read' }));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });
    });

    describe('write operation', () => {
        it('should forward write to target', async () => {
            const target = new MockHandle('target');
            target.setResponses([respond.ok(5)]);

            const handle = new ProcessIOHandle('test-id', 'test', { target });
            const data = new Uint8Array([1, 2, 3, 4, 5]);

            const responses = await collectResponses(
                handle.send({ op: 'write', data: { data } })
            );

            expect(target.messages.length).toBe(1);
            expect(target.messages[0]!.op).toBe('write');
            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(responses[0]!.data).toBe(5);
        });

        it('should error when no target configured', async () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            const responses = await collectResponses(
                handle.send({ op: 'write', data: { data: new Uint8Array([1]) } })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });

        it('should tee writes to all taps', async () => {
            const target = new MockHandle('target');
            const tap1 = new MockHandle('tap1');
            const tap2 = new MockHandle('tap2');

            const handle = new ProcessIOHandle('test-id', 'test', { target });
            handle.addTap(tap1);
            handle.addTap(tap2);

            const data = new Uint8Array([1, 2, 3]);
            await collectResponses(handle.send({ op: 'write', data: { data } }));

            // Target should receive the write
            expect(target.messages.length).toBe(1);
            expect(target.messages[0]!.op).toBe('write');

            // Give taps time to receive (fire and forget)
            await new Promise(resolve => setTimeout(resolve, 10));

            // Taps should also receive the write
            expect(tap1.messages.length).toBe(1);
            expect(tap1.messages[0]!.op).toBe('write');
            expect(tap2.messages.length).toBe(1);
            expect(tap2.messages[0]!.op).toBe('write');
        });

        it('should not block on tap errors', async () => {
            const target = new MockHandle('target');

            // Create a tap that throws
            const errorTap: Handle = {
                id: 'error-tap',
                type: 'file',
                description: 'error tap',
                closed: false,
                async *send(): AsyncIterable<Response> {
                    throw new Error('Tap error');
                },
                async close() {},
            };

            const handle = new ProcessIOHandle('test-id', 'test', { target });
            handle.addTap(errorTap);

            // Should not throw, target write should succeed
            const responses = await collectResponses(
                handle.send({ op: 'write', data: { data: new Uint8Array([1]) } })
            );

            expect(responses[0]!.op).toBe('ok');
        });
    });

    describe('stat operation', () => {
        it('should return handle info', async () => {
            const target = new MockHandle('target');
            const source = new MockHandle('source');
            const tap = new MockHandle('tap');

            const handle = new ProcessIOHandle('test-id', 'test-desc', { target, source });
            handle.addTap(tap);

            const responses = await collectResponses(handle.send({ op: 'stat' }));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');

            const stat = responses[0]!.data as Record<string, unknown>;
            expect(stat.type).toBe('process-io');
            expect(stat.description).toBe('test-desc');
            expect(stat.hasTarget).toBe(true);
            expect(stat.hasSource).toBe(true);
            expect(stat.tapCount).toBe(1);
        });

        it('should report false for missing target/source', async () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            const responses = await collectResponses(handle.send({ op: 'stat' }));

            const stat = responses[0]!.data as Record<string, unknown>;
            expect(stat.hasTarget).toBe(false);
            expect(stat.hasSource).toBe(false);
            expect(stat.tapCount).toBe(0);
        });
    });

    describe('unknown operation', () => {
        it('should return error for unknown op', async () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            const responses = await collectResponses(
                handle.send({ op: 'unknown-op' })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EINVAL');
        });
    });

    describe('tap queue behavior', () => {
        it('should not block target write when tap is slow', async () => {
            const target = new MockHandle('target');

            // Create a slow tap that delays 100ms
            let tapReceived = false;
            const slowTap: Handle = {
                id: 'slow-tap',
                type: 'file',
                description: 'slow tap',
                closed: false,
                async *send(msg: Message): AsyncIterable<Response> {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    tapReceived = true;
                    yield respond.ok();
                },
                async close() {},
            };

            const handle = new ProcessIOHandle('test-id', 'test', { target });
            handle.addTap(slowTap);

            // Write should complete quickly (not wait for slow tap)
            const start = Date.now();
            await collectResponses(
                handle.send({ op: 'write', data: { data: new Uint8Array([1]) } })
            );
            const elapsed = Date.now() - start;

            // Target should receive immediately
            expect(target.messages.length).toBe(1);
            // Should complete in less than 50ms (not waiting for 100ms tap)
            expect(elapsed).toBeLessThan(50);
            // Tap hasn't received yet
            expect(tapReceived).toBe(false);

            // Wait for slow tap to process
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(tapReceived).toBe(true);
        });

        it('should queue multiple writes for slow tap', async () => {
            const target = new MockHandle('target');

            // Create a tap that processes slowly
            const receivedMessages: Message[] = [];
            let processDelay = 50;
            const slowTap: Handle = {
                id: 'slow-tap',
                type: 'file',
                description: 'slow tap',
                closed: false,
                async *send(msg: Message): AsyncIterable<Response> {
                    await new Promise(resolve => setTimeout(resolve, processDelay));
                    receivedMessages.push(msg);
                    yield respond.ok();
                },
                async close() {},
            };

            const handle = new ProcessIOHandle('test-id', 'test', { target });
            handle.addTap(slowTap);

            // Send 3 writes quickly
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([1]) } }));
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([2]) } }));
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([3]) } }));

            // Target should have all 3 immediately
            expect(target.messages.length).toBe(3);

            // Tap is still processing - check queue depth
            expect(handle.getTapQueueDepth(slowTap)).toBeGreaterThanOrEqual(0);

            // Wait for tap to process all
            await new Promise(resolve => setTimeout(resolve, 200));

            // Tap should eventually receive all 3
            expect(receivedMessages.length).toBe(3);
        });

        it('should report queue depth for monitoring', async () => {
            const target = new MockHandle('target');

            // Create a tap that blocks only on the first message
            let firstCall = true;
            let releaseResolve: (() => void) | null = null;
            const blockingTap: Handle = {
                id: 'blocking-tap',
                type: 'file',
                description: 'blocking tap',
                closed: false,
                async *send(): AsyncIterable<Response> {
                    if (firstCall) {
                        firstCall = false;
                        await new Promise<void>(resolve => {
                            releaseResolve = resolve;
                        });
                    }
                    yield respond.ok();
                },
                async close() {},
            };

            const handle = new ProcessIOHandle('test-id', 'test', { target });
            handle.addTap(blockingTap);

            // Initially queue is empty
            expect(handle.getTapQueueDepth(blockingTap)).toBe(0);

            // Send a write - tap starts processing, queue still empty
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([1]) } }));

            // Give drain loop time to pick up the message
            await new Promise(resolve => setTimeout(resolve, 5));

            // Send more writes while tap is blocked
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([2]) } }));
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([3]) } }));

            // Queue should have pending messages
            expect(handle.getTapQueueDepth(blockingTap)).toBe(2);

            // Release the tap
            releaseResolve?.();

            // Wait for drain to process remaining messages
            await new Promise(resolve => setTimeout(resolve, 20));

            // Queue should be empty now
            expect(handle.getTapQueueDepth(blockingTap)).toBe(0);
        });

        it('should return 0 for unknown tap queue depth', () => {
            const handle = new ProcessIOHandle('test-id', 'test');
            const unknownTap = new MockHandle('unknown');

            expect(handle.getTapQueueDepth(unknownTap)).toBe(0);
        });

        it('should not add same tap twice', () => {
            const handle = new ProcessIOHandle('test-id', 'test');
            const tap = new MockHandle('tap');

            handle.addTap(tap);
            handle.addTap(tap); // Should be idempotent

            expect(handle.getTaps().size).toBe(1);
        });

        it('should stop drain loop when tap is removed', async () => {
            const target = new MockHandle('target');
            const tap = new MockHandle('tap');

            const handle = new ProcessIOHandle('test-id', 'test', { target });
            handle.addTap(tap);

            // Write once
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([1]) } }));
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(tap.messages.length).toBe(1);

            // Remove tap
            handle.removeTap(tap);

            // Write again
            await collectResponses(handle.send({ op: 'write', data: { data: new Uint8Array([2]) } }));
            await new Promise(resolve => setTimeout(resolve, 10));

            // Tap should not receive second write
            expect(tap.messages.length).toBe(1);
        });
    });

    describe('close', () => {
        it('should mark handle as closed', async () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            expect(handle.closed).toBe(false);
            await handle.close();
            expect(handle.closed).toBe(true);
        });

        it('should clear target, source, and taps', async () => {
            const target = new MockHandle('target');
            const source = new MockHandle('source');
            const tap = new MockHandle('tap');

            const handle = new ProcessIOHandle('test-id', 'test', { target, source });
            handle.addTap(tap);

            await handle.close();

            expect(handle.getTarget()).toBeNull();
            expect(handle.getSource()).toBeNull();
            expect(handle.getTaps().size).toBe(0);
        });

        it('should return error on operations after close', async () => {
            const target = new MockHandle('target');
            const source = new MockHandle('source');
            const handle = new ProcessIOHandle('test-id', 'test', { target, source });

            await handle.close();

            const readResponses = await collectResponses(handle.send({ op: 'read' }));
            expect(readResponses[0]!.op).toBe('error');
            expect((readResponses[0]!.data as { code: string }).code).toBe('EBADF');

            const writeResponses = await collectResponses(
                handle.send({ op: 'write', data: { data: new Uint8Array([1]) } })
            );
            expect(writeResponses[0]!.op).toBe('error');
            expect((writeResponses[0]!.data as { code: string }).code).toBe('EBADF');
        });

        it('should be idempotent', async () => {
            const handle = new ProcessIOHandle('test-id', 'test');

            await handle.close();
            await handle.close(); // Should not throw

            expect(handle.closed).toBe(true);
        });
    });
});
