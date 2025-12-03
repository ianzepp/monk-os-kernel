/**
 * ConsoleHandleAdapter Tests
 *
 * Tests the bridge between message-based process I/O and byte-based console device.
 * This is a critical path for shell pipelines: process send() -> console write().
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ConsoleHandleAdapter } from '@src/kernel/handle/console.js';
import { BufferConsoleDevice } from '@src/hal/index.js';
import { respond, type Response } from '@src/message.js';

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

describe('ConsoleHandleAdapter', () => {
    describe('constructor and properties', () => {
        it('should create with id and mode', () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('test-id', console, 'stdout');

            expect(adapter.id).toBe('test-id');
            expect(adapter.type).toBe('file');
            expect(adapter.description).toBe('/dev/console (stdout)');
            expect(adapter.closed).toBe(false);
        });

        it('should report correct description for each mode', () => {
            const console = new BufferConsoleDevice();

            const stdin = new ConsoleHandleAdapter('id', console, 'stdin');
            const stdout = new ConsoleHandleAdapter('id', console, 'stdout');
            const stderr = new ConsoleHandleAdapter('id', console, 'stderr');

            expect(stdin.description).toBe('/dev/console (stdin)');
            expect(stdout.description).toBe('/dev/console (stdout)');
            expect(stderr.description).toBe('/dev/console (stderr)');
        });
    });

    describe('send operation (stdout)', () => {
        let console: BufferConsoleDevice;
        let adapter: ConsoleHandleAdapter;

        beforeEach(() => {
            console = new BufferConsoleDevice();
            adapter = new ConsoleHandleAdapter('stdout-adapter', console, 'stdout');
        });

        it('should write text from item message', async () => {
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ text: 'hello\n' }) })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(console.getOutput()).toBe('hello\n');
        });

        it('should write multiple item messages', async () => {
            await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ text: 'first\n' }) })
            );
            await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ text: 'second\n' }) })
            );

            expect(console.getOutput()).toBe('first\nsecond\n');
        });

        it('should handle item with empty text', async () => {
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ text: '' }) })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(console.getOutput()).toBe('');
        });

        it('should handle item with no text property', async () => {
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ other: 'data' }) })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(console.getOutput()).toBe('');
        });

        it('should write binary data from data message', async () => {
            const bytes = new TextEncoder().encode('binary content');
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.data(bytes) })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(console.getOutput()).toBe('binary content');
        });

        it('should format error messages', async () => {
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.error('ENOENT', 'File not found') })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(console.getOutput()).toBe('Error: ENOENT: File not found\n');
        });

        it('should handle done message (no output)', async () => {
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.done() })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(console.getOutput()).toBe('');
        });

        it('should handle ok message (no output)', async () => {
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.ok() })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('ok');
            expect(console.getOutput()).toBe('');
        });

        it('should return error for invalid message', async () => {
            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: null as unknown as Response })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EINVAL');
        });

        it('should yield exactly one response per send', async () => {
            // This is critical for the CAT_LOOP bug - send must not loop
            let responseCount = 0;
            for await (const response of adapter.exec({ op: 'send', data: respond.item({ text: 'test' }) })) {
                responseCount++;
                expect(response.op).toBe('ok');
            }
            expect(responseCount).toBe(1);
        });
    });

    describe('send operation (stderr)', () => {
        let console: BufferConsoleDevice;
        let adapter: ConsoleHandleAdapter;

        beforeEach(() => {
            console = new BufferConsoleDevice();
            adapter = new ConsoleHandleAdapter('stderr-adapter', console, 'stderr');
        });

        it('should write to stderr buffer', async () => {
            await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ text: 'error message\n' }) })
            );

            expect(console.getOutput()).toBe('');
            expect(console.getErrors()).toBe('error message\n');
        });
    });

    describe('send operation (stdin - should fail)', () => {
        it('should return error when writing to stdin', async () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('stdin-adapter', console, 'stdin');

            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ text: 'test' }) })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });
    });

    describe('recv operation (stdin)', () => {
        let console: BufferConsoleDevice;
        let adapter: ConsoleHandleAdapter;

        beforeEach(() => {
            console = new BufferConsoleDevice();
            adapter = new ConsoleHandleAdapter('stdin-adapter', console, 'stdin');
        });

        it('should read single line from console', async () => {
            console.setInput('hello world\n');

            const responses = await collectResponses(adapter.exec({ op: 'recv' }));

            expect(responses.length).toBe(2);
            expect(responses[0]!.op).toBe('item');
            expect((responses[0]!.data as { text: string }).text).toBe('hello world\n');
            expect(responses[1]!.op).toBe('done');
        });

        it('should read multiple lines', async () => {
            console.setInput('line1\nline2\nline3\n');

            const responses = await collectResponses(adapter.exec({ op: 'recv' }));

            expect(responses.length).toBe(4);
            expect(responses[0]!.op).toBe('item');
            expect((responses[0]!.data as { text: string }).text).toBe('line1\n');
            expect(responses[1]!.op).toBe('item');
            expect((responses[1]!.data as { text: string }).text).toBe('line2\n');
            expect(responses[2]!.op).toBe('item');
            expect((responses[2]!.data as { text: string }).text).toBe('line3\n');
            expect(responses[3]!.op).toBe('done');
        });

        it('should handle EOF immediately', async () => {
            console.setInput('');

            const responses = await collectResponses(adapter.exec({ op: 'recv' }));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('done');
        });

        it('should handle line without trailing newline', async () => {
            console.setInput('no newline');

            const responses = await collectResponses(adapter.exec({ op: 'recv' }));

            expect(responses.length).toBe(2);
            expect(responses[0]!.op).toBe('item');
            expect((responses[0]!.data as { text: string }).text).toBe('no newline\n');
            expect(responses[1]!.op).toBe('done');
        });
    });

    describe('recv operation (stdout/stderr - should fail)', () => {
        it('should return error when reading from stdout', async () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('stdout-adapter', console, 'stdout');

            const responses = await collectResponses(adapter.exec({ op: 'recv' }));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });

        it('should return error when reading from stderr', async () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('stderr-adapter', console, 'stderr');

            const responses = await collectResponses(adapter.exec({ op: 'recv' }));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });
    });

    describe('unknown operation', () => {
        it('should return error for unknown op', async () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('test', console, 'stdout');

            const responses = await collectResponses(adapter.exec({ op: 'unknown' }));

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EINVAL');
        });
    });

    describe('close', () => {
        it('should mark adapter as closed', async () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('test', console, 'stdout');

            expect(adapter.closed).toBe(false);
            await adapter.close();
            expect(adapter.closed).toBe(true);
        });

        it('should return error on operations after close', async () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('test', console, 'stdout');

            await adapter.close();

            const responses = await collectResponses(
                adapter.exec({ op: 'send', data: respond.item({ text: 'test' }) })
            );

            expect(responses.length).toBe(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0]!.data as { code: string }).code).toBe('EBADF');
        });

        it('should be idempotent', async () => {
            const console = new BufferConsoleDevice();
            const adapter = new ConsoleHandleAdapter('test', console, 'stdout');

            await adapter.close();
            await adapter.close(); // Should not throw

            expect(adapter.closed).toBe(true);
        });
    });

    describe('pipe simulation (cat-like behavior)', () => {
        it('should handle recv-then-send pattern without looping', async () => {
            // Simulate what cat does: recv from stdin, send to stdout
            const consoleDevice = new BufferConsoleDevice();
            const stdin = new ConsoleHandleAdapter('stdin', consoleDevice, 'stdin');
            const stdout = new ConsoleHandleAdapter('stdout', consoleDevice, 'stdout');

            consoleDevice.setInput('hello from pipe\n');

            // Receive all input
            const recvResponses: Response[] = [];
            for await (const r of stdin.exec({ op: 'recv' })) {
                recvResponses.push(r);
            }

            // Forward each item to stdout
            for (const r of recvResponses) {
                if (r.op === 'item') {
                    const sendResponses = await collectResponses(
                        stdout.exec({ op: 'send', data: r })
                    );
                    // Critical: should yield exactly one 'ok'
                    expect(sendResponses.length).toBe(1);
                    expect(sendResponses[0]!.op).toBe('ok');
                }
            }

            expect(consoleDevice.getOutput()).toBe('hello from pipe\n');
        });

        it('should handle multiple messages without accumulating responses', async () => {
            const consoleDevice = new BufferConsoleDevice();
            const stdout = new ConsoleHandleAdapter('stdout', consoleDevice, 'stdout');

            // Send 100 messages - should complete quickly without issues
            for (let i = 0; i < 100; i++) {
                const responses = await collectResponses(
                    stdout.exec({ op: 'send', data: respond.item({ text: `msg${i}\n` }) })
                );
                expect(responses.length).toBe(1);
                expect(responses[0]!.op).toBe('ok');
            }

            const output = consoleDevice.getOutput();
            expect(output.split('\n').filter(l => l).length).toBe(100);
        });
    });
});
