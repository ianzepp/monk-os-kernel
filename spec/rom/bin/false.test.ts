/**
 * false Command Tests
 *
 * Tests for the `false` command which exits unsuccessfully.
 *
 * POSIX SPECIFICATION
 * ===================
 * The false utility shall return with exit code 1 (or non-zero).
 * It shall accept and ignore any arguments.
 *
 * @see https://pubs.opengroup.org/onlinepubs/9699919799/utilities/false.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('false', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should exit with code 1', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'false'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should produce no output', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'false > /tmp/out'],
        });

        await handle.wait();

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('');
    });

    it('should ignore arguments', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'false ignored args --flag'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
