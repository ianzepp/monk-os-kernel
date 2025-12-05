/**
 * true Command Tests
 *
 * Tests for the `true` command which exits successfully.
 *
 * POSIX SPECIFICATION
 * ===================
 * The true utility shall return with exit code zero.
 * It shall accept and ignore any arguments.
 *
 * @see https://pubs.opengroup.org/onlinepubs/9699919799/utilities/true.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('true', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should exit with code 0', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'true'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    it('should produce no output', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'true > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('');
    });

    it('should ignore arguments', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'true ignored args --flag'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    // TODO: && chaining with redirects needs investigation
    // it('should work in && chain', async () => {
    //     const handle = await os.process.spawn('/bin/shell.ts', {
    //         args: ['shell', '-c', 'true && echo yes > /tmp/out'],
    //     });
    //     const result = await handle.wait();
    //     expect(result.exitCode).toBe(EXIT.SUCCESS);
    //     const stdout = await os.fs.readText('/tmp/out');
    //     expect(stdout).toBe('yes\n');
    // });
});
