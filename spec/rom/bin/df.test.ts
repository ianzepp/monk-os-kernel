/**
 * df Command Tests
 *
 * Tests for the `df` command which reports filesystem disk space usage.
 *
 * GNU COREUTILS COMPATIBILITY
 * ===========================
 * Tests basic df functionality including:
 * - Default filesystem listing
 * - Human-readable output with -h
 * - Filesystem type display with -T
 * - Grand total with --total
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/df-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('df', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should display filesystem information', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'df > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Filesystem');
        expect(stdout).toContain('1K-blocks');
        expect(stdout).toContain('Mounted on');
    });

    it('should support human-readable output with -h', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'df -h > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Filesystem');
        expect(stdout).toContain('Size');
        expect(stdout).toMatch(/[0-9]+[KMG]/);
    });

    it('should show filesystem type with -T', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'df -T > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Type');
        expect(stdout).toContain('vfs');
    });

    it('should display grand total with --total', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'df --total > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('total');
    });

    it('should support combining -h and -T flags', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'df -T -h > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Type');
        expect(stdout).toContain('Size');
    });

    it('should display help with --help', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'df --help > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Usage:');
        expect(stdout).toContain('df');
    });
});
