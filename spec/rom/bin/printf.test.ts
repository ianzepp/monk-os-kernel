/**
 * printf Command Tests
 *
 * Tests for the `printf` command which formats and prints data.
 *
 * GNU SPECIFICATION
 * =================
 * The printf utility formats and prints data according to a format string.
 * Supports format specifiers (%s, %d, %f, etc.), width/precision, and escape sequences.
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/printf-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('printf', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should format string with %s', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "Hello %s" world > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('Hello world');
    });

    it('should format integer with %d', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "%d" 42 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('42');
    });

    it('should format multiple arguments', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "%d %d %d" 1 2 3 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('1 2 3');
    });

    it('should support width formatting', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "%5d" 42 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('   42');
    });

    it('should support left-align with %-', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "%-5s|" hi > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('hi   |');
    });

    it('should support floating point with %f', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "%.2f" 3.14159 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('3.14');
    });

    it('should handle missing format string', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should support literal percent with %%', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "100%%" > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('100%');
    });
});
