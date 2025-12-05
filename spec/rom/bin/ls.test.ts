/**
 * ls Command Tests
 *
 * Tests for the `ls` command which lists directory contents.
 *
 * GNU COREUTILS COMPATIBILITY
 * ===========================
 * Tests basic ls functionality including:
 * - Default directory listing
 * - Long format (-l)
 * - Show hidden files (-a)
 * - One entry per line (-1)
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/ls-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('ls', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should list current directory contents', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'ls > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBeTruthy();
        expect(stdout.length).toBeGreaterThan(0);
    });

    it('should list specified directory', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'ls /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('ls.ts');
        expect(stdout).toContain('cat.ts');
    });

    it('should support long format with -l flag', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'ls -l /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('total');
        expect(stdout).toContain('ls.ts');
    });

    it('should show hidden files with -a flag', async () => {
        // Create a hidden file
        await os.fs.write('/tmp/.hidden', 'secret');

        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'ls -a /tmp > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('.hidden');
    });

    it('should list one entry per line with -1 flag', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'ls -1 /bin > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');
        const lines = stdout.trim().split('\n');

        expect(lines.length).toBeGreaterThan(1);
        expect(lines.every(line => line.trim().length > 0)).toBe(true);
    });

    it('should handle non-existent directory', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'ls /nonexistent'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
