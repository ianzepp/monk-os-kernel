/**
 * chmod Command Tests
 *
 * Tests for the `chmod` command which is NOT SUPPORTED in Monk OS.
 *
 * MONK OS DESIGN
 * ==============
 * Monk OS uses grant-based ACLs instead of UNIX permission bits.
 * The chmod command exists for compatibility but always returns an error
 * and directs users to use the `grant` command instead.
 *
 * @see rom/bin/chmod.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('chmod', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should display help with --help', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'chmod --help'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    it('should display help with -h', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'chmod -h'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    it('should return error when attempting to change permissions', async () => {
        await os.fs.write('/tmp/test.txt', 'content');

        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'chmod 755 /tmp/test.txt'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should suggest using grant command', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'chmod 644 /tmp/file'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should return error with no arguments', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'chmod'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
