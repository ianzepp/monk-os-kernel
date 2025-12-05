/**
 * seq Command Tests
 *
 * Tests for the `seq` command which prints a sequence of numbers.
 *
 * GNU SPECIFICATION
 * =================
 * The seq utility prints a sequence of numbers from FIRST to LAST by INCREMENT.
 * Supports options for custom separators (-s) and equal width padding (-w).
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/seq-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('seq', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should generate sequence from 1 to N', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'seq 5 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('1\n2\n3\n4\n5\n');
    });

    it('should generate sequence from FIRST to LAST', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'seq 3 7 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('3\n4\n5\n6\n7\n');
    });

    it('should generate sequence with INCREMENT', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'seq 1 2 10 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('1\n3\n5\n7\n9\n');
    });

    it('should support custom separator with -s', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'seq -s, 3 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('1,2,3\n');
    });

    it('should support equal width with -w', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'seq -w 8 10 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('08\n09\n10\n');
    });

    it('should handle missing operand', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'seq'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should support combined separator and width flags', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'seq -s " " -w 1 3 > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('1 2 3\n');
    });
});
