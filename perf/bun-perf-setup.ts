/**
 * Bun Performance Test Setup
 *
 * Utilities for high-volume and stress testing.
 */

import { respond, type Response } from '@src/message.js';
import type { MessagePipe } from '@src/kernel/resource/message-pipe.js';

/** Fixture directory for pre-generated test data */
export const FIXTURE_DIR = '.perf';

/**
 * Generate N test messages with incrementing IDs
 */
export function* generateMessages(count: number): Generator<Response> {
    for (let i = 0; i < count; i++) {
        yield respond.item({ id: i, data: `message-${i}` });
    }
}

/**
 * Generate a large binary payload of specified byte size
 * Returns a Response with bytes on the response object
 */
export function generateLargePayload(sizeBytes: number): Response {
    const bytes = new Uint8Array(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) {
        bytes[i] = i % 256;
    }
    return respond.data(bytes);
}

/**
 * Extract bytes from a data response
 */
export function extractBytes(r: Response): Uint8Array {
    return r.bytes!;
}

/**
 * Generate text payload of specified character count
 */
export function generateTextPayload(charCount: number): Response {
    const line = 'The quick brown fox jumps over the lazy dog.\n';
    const repeats = Math.ceil(charCount / line.length);
    const text = line.repeat(repeats).slice(0, charCount);
    return respond.item({ text });
}

/**
 * Drain all messages from a pipe's recv end
 * Returns array of received messages
 */
export async function drainPipe(recvEnd: MessagePipe): Promise<Response[]> {
    const received: Response[] = [];
    for await (const r of recvEnd.exec({ op: 'recv' })) {
        if (r.op === 'done') break;
        if (r.op === 'error') throw new Error(`Pipe error: ${(r.data as { message?: string })?.message}`);
        received.push(r);
    }
    return received;
}

/**
 * Send all messages from an iterable to a pipe's send end
 * Returns count of messages sent
 */
export async function sendAll(sendEnd: MessagePipe, messages: Iterable<Response>): Promise<number> {
    let count = 0;
    for (const msg of messages) {
        for await (const r of sendEnd.exec({ op: 'send', data: msg })) {
            if (r.op === 'error') {
                throw new Error(`Send error: ${(r.data as { message?: string })?.message}`);
            }
        }
        count++;
    }
    return count;
}

/**
 * Verify message integrity - checks all messages arrived in order
 */
export function verifyIntegrity(sent: Response[], received: Response[]): { ok: boolean; error?: string } {
    if (sent.length !== received.length) {
        return { ok: false, error: `Count mismatch: sent ${sent.length}, received ${received.length}` };
    }

    for (let i = 0; i < sent.length; i++) {
        const s = sent[i]!;
        const r = received[i]!;

        if (s.op !== r.op) {
            return { ok: false, error: `Op mismatch at ${i}: sent ${s.op}, received ${r.op}` };
        }

        const sData = JSON.stringify(s.data);
        const rData = JSON.stringify(r.data);
        if (sData !== rData) {
            return { ok: false, error: `Data mismatch at ${i}` };
        }
    }

    return { ok: true };
}

/**
 * Read fixture file if it exists
 */
export async function readFixture(name: string): Promise<Uint8Array | null> {
    const path = `${FIXTURE_DIR}/${name}`;
    const file = Bun.file(path);
    if (await file.exists()) {
        return new Uint8Array(await file.arrayBuffer());
    }
    return null;
}

/**
 * Write fixture file
 */
export async function writeFixture(name: string, data: Uint8Array): Promise<void> {
    const path = `${FIXTURE_DIR}/${name}`;
    await Bun.write(path, data);
}
