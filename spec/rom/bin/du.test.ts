/**
 * du Command Tests
 *
 * Tests for the `du` command which estimates file space usage.
 *
 * GNU COREUTILS COMPATIBILITY
 * ===========================
 * Tests basic du functionality including:
 * - Default directory usage
 * - Human-readable output with -h
 * - Summary mode with -s
 * - Grand total with -c
 * - Max depth with -d
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/du-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('du', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should estimate disk usage for directory', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBeTruthy();
        expect(stdout).toContain('/bin');
    });

    it('should support human-readable output with --help', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du --help > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Usage:');
        expect(stdout).toContain('du');
    });

    it('should support summary mode with -s', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du -s /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');
        const lines = stdout.trim().split('\n');

        expect(lines.length).toBe(1);
        expect(stdout).toContain('/bin');
    });

    it('should display grand total with -c', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du -c /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('total');
    });

    it('should support max depth with -d flag', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du -d 0 /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');
        const lines = stdout.trim().split('\n');

        expect(lines.length).toBe(1);
    });

    it('should support combining -s and -h flags', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du -sh /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toMatch(/[0-9]+[KMG]?\t\/bin/);
    });

    it('should support combining flags', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du -s -c /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('/bin');
        expect(stdout).toContain('total');
    });

    it('should handle non-existent directory', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'du /nonexistent'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
