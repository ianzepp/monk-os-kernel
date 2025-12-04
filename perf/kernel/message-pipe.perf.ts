/**
 * MessagePipe Performance Tests
 *
 * Validates MessagePipe correctness under high-volume conditions.
 * Focus: message integrity, not timing.
 */

import { describe, it, expect } from 'bun:test';
import { createMessagePipe } from '@src/kernel/resource/message-pipe.js';
import { respond, type Response } from '@src/message.js';
import {
    generateMessages,
    generateLargePayload,
    generateTextPayload,
    drainPipe,
    sendAll,
    verifyIntegrity,
    readFixture,
    extractBytes,
} from '../bun-perf-setup.js';

const TIMEOUT_LONG = 60_000;

describe('MessagePipe: High Message Count', () => {
    it('should transfer 1,000 messages without loss', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-1k');
        const sent = [...generateMessages(1_000)];

        await sendAll(sendEnd, sent);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        const result = verifyIntegrity(sent, received);

        expect(result.ok).toBe(true);
        expect(received.length).toBe(1_000);
    });

    it('should transfer 10,000 messages without loss (concurrent)', async () => {
        // Use higher water mark to allow buffering
        const [recvEnd, sendEnd] = createMessagePipe('perf-10k', 15_000);
        const sent = [...generateMessages(10_000)];

        await sendAll(sendEnd, sent);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        const result = verifyIntegrity(sent, received);

        expect(result.ok).toBe(true);
        expect(received.length).toBe(10_000);
    }, { timeout: TIMEOUT_LONG });

    it('should transfer 100,000 messages without loss (streaming)', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-100k');
        const messageCount = 100_000;
        const sent: Response[] = [];

        // Start consumer immediately (runs concurrently)
        const consumerPromise = drainPipe(recvEnd);

        // Producer sends messages
        for (let i = 0; i < messageCount; i++) {
            const msg = respond.item({ id: i, data: `message-${i}` });
            sent.push(msg);
            for await (const r of sendEnd.exec({ op: 'send', data: msg })) {
                if (r.op === 'error') {
                    throw new Error(`Send error at ${i}: ${(r.data as { message?: string })?.message}`);
                }
            }
        }
        await sendEnd.close();

        const received = await consumerPromise;
        const result = verifyIntegrity(sent, received);

        expect(result.ok).toBe(true);
        expect(received.length).toBe(messageCount);
    }, { timeout: TIMEOUT_LONG });
});

describe('MessagePipe: Large Payloads', () => {
    it('should transfer 1KB payload intact', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-1kb');
        const payload = generateLargePayload(1024);

        await sendAll(sendEnd, [payload]);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        expect(received.length).toBe(1);

        const sent = extractBytes(payload);
        const recv = extractBytes(received[0]!);
        expect(recv.length).toBe(sent.length);
        expect(recv.every((b, i) => b === sent[i])).toBe(true);
    });

    it('should transfer 100KB payload intact', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-100kb');
        const payload = generateLargePayload(100 * 1024);

        await sendAll(sendEnd, [payload]);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        expect(received.length).toBe(1);

        const sent = extractBytes(payload);
        const recv = extractBytes(received[0]!);
        expect(recv.length).toBe(sent.length);
    });

    it('should transfer 1MB payload intact', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-1mb');
        const payload = generateLargePayload(1024 * 1024);

        await sendAll(sendEnd, [payload]);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        expect(received.length).toBe(1);

        const sent = extractBytes(payload);
        const recv = extractBytes(received[0]!);
        expect(recv.length).toBe(sent.length);
    });

    it('should transfer 10MB payload intact', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-10mb');
        const payload = generateLargePayload(10 * 1024 * 1024);

        await sendAll(sendEnd, [payload]);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        expect(received.length).toBe(1);

        const sent = extractBytes(payload);
        const recv = extractBytes(received[0]!);
        expect(recv.length).toBe(sent.length);
    }, { timeout: TIMEOUT_LONG });
});

describe('MessagePipe: Text Streaming', () => {
    it('should transfer 10KB text payload intact', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-text-10k');
        const payload = generateTextPayload(10_000);

        await sendAll(sendEnd, [payload]);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        expect(received.length).toBe(1);

        const sentText = (payload.data as { text: string }).text;
        const recvText = (received[0]!.data as { text: string }).text;
        expect(recvText.length).toBe(sentText.length);
        expect(recvText).toBe(sentText);
    });

    it('should transfer 100KB text payload intact', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-text-100k');
        const payload = generateTextPayload(100_000);

        await sendAll(sendEnd, [payload]);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        expect(received.length).toBe(1);

        const sentText = (payload.data as { text: string }).text;
        const recvText = (received[0]!.data as { text: string }).text;
        expect(recvText.length).toBe(sentText.length);
    });

    it('should transfer 1MB text payload intact', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-text-1m');
        const payload = generateTextPayload(1_000_000);

        await sendAll(sendEnd, [payload]);
        await sendEnd.close();

        const received = await drainPipe(recvEnd);
        expect(received.length).toBe(1);

        const sentText = (payload.data as { text: string }).text;
        const recvText = (received[0]!.data as { text: string }).text;
        expect(recvText.length).toBe(sentText.length);
    }, { timeout: TIMEOUT_LONG });
});

describe('MessagePipe: Chunked File Simulation', () => {
    const CHUNK_SIZE = 4096;

    async function streamAsChunks(
        sendEnd: ReturnType<typeof createMessagePipe>[1],
        data: Uint8Array,
        consumerStarted: Promise<void>
    ): Promise<number> {
        // Wait for consumer to start before sending
        await consumerStarted;

        let offset = 0;
        let count = 0;
        while (offset < data.length) {
            const chunk = data.slice(offset, offset + CHUNK_SIZE);
            for await (const r of sendEnd.exec({ op: 'send', data: respond.data(chunk) })) {
                if (r.op === 'error') {
                    throw new Error(`Send failed at chunk ${count}: ${(r.data as { message?: string })?.message}`);
                }
            }
            offset += CHUNK_SIZE;
            count++;
        }
        return count;
    }

    function reassembleChunks(received: Response[]): Uint8Array {
        const chunks = received.map(r => extractBytes(r));
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    it('should stream 100KB file as 4KB chunks (25 chunks)', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-chunked-100k');
        const original = new Uint8Array(100 * 1024);
        for (let i = 0; i < original.length; i++) original[i] = i % 256;

        // Signal when consumer is ready
        let resolveStarted: () => void;
        const consumerStarted = new Promise<void>(r => { resolveStarted = r; });

        // Start consumer first
        const consumerPromise = (async () => {
            resolveStarted!();
            return await drainPipe(recvEnd);
        })();

        const chunkCount = await streamAsChunks(sendEnd, original, consumerStarted);
        await sendEnd.close();

        const received = await consumerPromise;
        const reassembled = reassembleChunks(received);

        expect(chunkCount).toBe(25);
        expect(received.length).toBe(25);
        expect(reassembled.length).toBe(original.length);
        expect(reassembled.every((b, i) => b === original[i])).toBe(true);
    });

    it('should stream 1MB file as 4KB chunks (256 chunks)', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-chunked-1m');
        const original = new Uint8Array(1024 * 1024);
        for (let i = 0; i < original.length; i++) original[i] = i % 256;

        let resolveStarted: () => void;
        const consumerStarted = new Promise<void>(r => { resolveStarted = r; });

        const consumerPromise = (async () => {
            resolveStarted!();
            return await drainPipe(recvEnd);
        })();

        const chunkCount = await streamAsChunks(sendEnd, original, consumerStarted);
        await sendEnd.close();

        const received = await consumerPromise;
        const reassembled = reassembleChunks(received);

        expect(chunkCount).toBe(256);
        expect(received.length).toBe(256);
        expect(reassembled.length).toBe(original.length);
    }, { timeout: TIMEOUT_LONG });

    it('should stream 10MB file as 4KB chunks (2560 chunks)', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-chunked-10m');
        const original = new Uint8Array(10 * 1024 * 1024);
        for (let i = 0; i < original.length; i++) original[i] = i % 256;

        let resolveStarted: () => void;
        const consumerStarted = new Promise<void>(r => { resolveStarted = r; });

        const consumerPromise = (async () => {
            resolveStarted!();
            return await drainPipe(recvEnd);
        })();

        const chunkCount = await streamAsChunks(sendEnd, original, consumerStarted);
        await sendEnd.close();

        const received = await consumerPromise;
        const reassembled = reassembleChunks(received);

        expect(chunkCount).toBe(2560);
        expect(received.length).toBe(2560);
        expect(reassembled.length).toBe(original.length);
    }, { timeout: TIMEOUT_LONG });
});

describe('MessagePipe: Backpressure', () => {
    it('should return EAGAIN when buffer full (high water mark 100)', async () => {
        const HIGH_WATER = 100;
        const [recvEnd, sendEnd] = createMessagePipe('perf-backpressure', HIGH_WATER);

        // Fill to capacity
        for (let i = 0; i < HIGH_WATER; i++) {
            for await (const r of sendEnd.exec({ op: 'send', data: respond.item(i) })) {
                expect(r.op).toBe('ok');
            }
        }

        // Next send should fail with EAGAIN
        let gotEagain = false;
        for await (const r of sendEnd.exec({ op: 'send', data: respond.item('overflow') })) {
            if (r.op === 'error' && (r.data as { code: string }).code === 'EAGAIN') {
                gotEagain = true;
            }
        }

        expect(gotEagain).toBe(true);

        // Cleanup
        await sendEnd.close();
        await recvEnd.close();
    });

    it('should resume after consumer drains buffer', async () => {
        const HIGH_WATER = 50;
        const [recvEnd, sendEnd] = createMessagePipe('perf-drain-resume', HIGH_WATER);

        // Fill to capacity
        for (let i = 0; i < HIGH_WATER; i++) {
            await sendAll(sendEnd, [respond.item(i)]);
        }

        // Verify blocked
        let blocked = false;
        for await (const r of sendEnd.exec({ op: 'send', data: respond.item('test') })) {
            if (r.op === 'error') blocked = true;
        }
        expect(blocked).toBe(true);

        // Drain one message
        const iter = recvEnd.exec({ op: 'recv' })[Symbol.asyncIterator]();
        await iter.next(); // consume one

        // Should be able to send now
        let sendOk = false;
        for await (const r of sendEnd.exec({ op: 'send', data: respond.item('after-drain') })) {
            if (r.op === 'ok') sendOk = true;
        }
        expect(sendOk).toBe(true);

        // Cleanup
        await sendEnd.close();
        await recvEnd.close();
    });
});

describe('MessagePipe: Concurrent Operations', () => {
    it('should handle producer-consumer race (1000 messages)', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-race-1k');
        const messageCount = 1000;
        const sent: Response[] = [];

        // Start consumer first (will wait for messages)
        const consumerPromise = drainPipe(recvEnd);

        // Producer sends messages
        for (let i = 0; i < messageCount; i++) {
            const msg = respond.item({ id: i });
            sent.push(msg);
            await sendAll(sendEnd, [msg]);
        }
        await sendEnd.close();

        const received = await consumerPromise;
        const result = verifyIntegrity(sent, received);

        expect(result.ok).toBe(true);
        expect(received.length).toBe(messageCount);
    });

    it('should handle interleaved send-recv (500 messages)', async () => {
        const [recvEnd, sendEnd] = createMessagePipe('perf-interleave');
        const messageCount = 500;
        const received: Response[] = [];

        // Alternating send and recv
        for (let i = 0; i < messageCount; i++) {
            // Send
            const msg = respond.item({ id: i });
            await sendAll(sendEnd, [msg]);

            // Immediately try to recv (won't block since message was just sent)
            const iter = recvEnd.exec({ op: 'recv' })[Symbol.asyncIterator]();
            const result = await iter.next();
            if (!result.done && result.value.op !== 'done') {
                received.push(result.value);
            }
        }

        expect(received.length).toBe(messageCount);
        expect((received[0]!.data as { id: number }).id).toBe(0);
        expect((received[messageCount - 1]!.data as { id: number }).id).toBe(messageCount - 1);

        await sendEnd.close();
        await recvEnd.close();
    });
});

describe('MessagePipe: Chain (Multi-hop)', () => {
    it('should pass messages through 3-pipe chain intact', async () => {
        // Pipe A -> Pipe B -> Pipe C
        const [recvA, sendA] = createMessagePipe('chain-a');
        const [recvB, sendB] = createMessagePipe('chain-b');
        const [recvC, sendC] = createMessagePipe('chain-c');

        const original = [...generateMessages(100)];

        // Send to pipe A
        await sendAll(sendA, original);
        await sendA.close();

        // Forward A -> B
        const fromA = await drainPipe(recvA);
        await sendAll(sendB, fromA);
        await sendB.close();

        // Forward B -> C
        const fromB = await drainPipe(recvB);
        await sendAll(sendC, fromB);
        await sendC.close();

        // Receive from C
        const final = await drainPipe(recvC);

        const result = verifyIntegrity(original, final);
        expect(result.ok).toBe(true);
        expect(final.length).toBe(100);
    });

    it('should pass large payloads through 3-pipe chain intact', async () => {
        const [recvA, sendA] = createMessagePipe('chain-large-a');
        const [recvB, sendB] = createMessagePipe('chain-large-b');
        const [recvC, sendC] = createMessagePipe('chain-large-c');

        const payload = generateLargePayload(512 * 1024); // 512KB

        await sendAll(sendA, [payload]);
        await sendA.close();

        const fromA = await drainPipe(recvA);
        await sendAll(sendB, fromA);
        await sendB.close();

        const fromB = await drainPipe(recvB);
        await sendAll(sendC, fromB);
        await sendC.close();

        const final = await drainPipe(recvC);

        expect(final.length).toBe(1);
        const originalData = extractBytes(payload);
        const finalData = extractBytes(final[0]!);
        expect(finalData.length).toBe(originalData.length);
        expect(finalData.every((b, i) => b === originalData[i])).toBe(true);
    });
});

describe('MessagePipe: Fixture-based Tests', () => {
    it('should stream 1MB fixture file as chunks', async () => {
        const fixture = await readFixture('blob-1mb.bin');
        if (!fixture) {
            console.log(`  (skipped: run 'bun run perf:fixtures' first)`);
            return;
        }

        const [recvEnd, sendEnd] = createMessagePipe('perf-fixture-1mb');
        const CHUNK_SIZE = 4096;

        // Start consumer first
        const consumerPromise = drainPipe(recvEnd);

        // Stream fixture as chunks
        let offset = 0;
        while (offset < fixture.length) {
            const chunk = fixture.slice(offset, offset + CHUNK_SIZE);
            await sendAll(sendEnd, [respond.data(chunk)]);
            offset += CHUNK_SIZE;
        }
        await sendEnd.close();

        const received = await consumerPromise;

        // Reassemble and verify
        const chunks = received.map(r => extractBytes(r));
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        expect(totalLength).toBe(fixture.length);
    }, { timeout: TIMEOUT_LONG });

    it('should stream 10MB fixture file as chunks', async () => {
        const fixture = await readFixture('blob-10mb.bin');
        if (!fixture) {
            console.log(`  (skipped: run 'bun run perf:fixtures' first)`);
            return;
        }

        const [recvEnd, sendEnd] = createMessagePipe('perf-fixture-10mb');
        const CHUNK_SIZE = 8192;

        // Start consumer first
        const consumerPromise = drainPipe(recvEnd);

        let offset = 0;
        let chunkCount = 0;
        while (offset < fixture.length) {
            const chunk = fixture.slice(offset, offset + CHUNK_SIZE);
            await sendAll(sendEnd, [respond.data(chunk)]);
            offset += CHUNK_SIZE;
            chunkCount++;
        }
        await sendEnd.close();

        const received = await consumerPromise;
        expect(received.length).toBe(chunkCount);

        const totalLength = received.reduce((sum, r) => sum + extractBytes(r).length, 0);
        expect(totalLength).toBe(fixture.length);
    }, { timeout: TIMEOUT_LONG });
});
