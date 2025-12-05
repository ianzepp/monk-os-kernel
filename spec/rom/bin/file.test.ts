/**
 * file Command Tests
 *
 * Tests for the `file` command which determines file type.
 *
 * GNU SPECIFICATION
 * =================
 * The file utility determines the type of a file by examining its contents and metadata.
 * Supports brief mode (-b) and MIME type output (-i).
 *
 * @see https://man7.org/linux/man-pages/man1/file.1.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('file', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should show help with --help', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'file --help > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Usage: file');
    });

    it('should detect directory type', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'mkdir /tmp/testdir && file /tmp/testdir > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('directory');
    });

    it('should detect JSON file by extension', async () => {
        // First create the file
        const writeHandle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "{}" > /tmp/test.json'],
        });
        await writeHandle.wait();

        // Then check its type
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'file /tmp/test.json > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('JSON');
    });

    it('should support brief mode with -b', async () => {
        // First create the file
        const writeHandle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "hello" > /tmp/test.txt'],
        });
        await writeHandle.wait();

        // Then check with brief mode
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'file -b /tmp/test.txt > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        // Brief mode should not include filename prefix
        expect(stdout).not.toContain('/tmp/test.txt:');
    });

    it('should support MIME type output with -i', async () => {
        // First create the file
        const writeHandle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'printf "hello" > /tmp/test.txt'],
        });
        await writeHandle.wait();

        // Then check with MIME mode
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'file -i /tmp/test.txt > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('text/');
    });

    it('should detect empty files', async () => {
        // First create empty file
        const touchHandle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'touch /tmp/empty'],
        });
        await touchHandle.wait();

        // Then check its type
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'file /tmp/empty > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('empty');
    });

    it('should handle missing file', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'file /tmp/nonexistent'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should handle missing operand', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'file'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
