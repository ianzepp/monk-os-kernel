/**
 * cd Command Tests
 *
 * Tests for the `cd` command which changes the current working directory.
 *
 * POSIX SPECIFICATION
 * ===================
 * The cd utility changes the working directory of the current shell execution environment.
 * It shall accept absolute and relative paths.
 *
 * @see https://pubs.opengroup.org/onlinepubs/9699919799/utilities/cd.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('cd', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should change to /tmp and verify with pwd', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'cd /tmp && pwd > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('/tmp\n');
    });

    it('should change to root directory when no argument', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'cd && pwd > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('/\n');
    });

    it('should fail when directory does not exist', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'cd /nonexistent > /tmp/out 2>&1'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should handle relative paths', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'cd /bin && cd .. && pwd > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toBe('/\n');
    });
});
