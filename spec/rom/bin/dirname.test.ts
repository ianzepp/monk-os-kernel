/**
 * dirname Command Tests
 *
 * Tests for the `dirname` command which strips the last component from a filename.
 *
 * GNU BEHAVIOR
 * ============
 * - Returns parent directory of the given path
 * - Returns '.' if path has no directory component
 * - Returns '/' for root or paths that start with /
 * - Removes trailing slashes before processing
 * - Processes multiple paths one per line
 *
 * NOTE: These tests are currently skipped because shell external command
 * execution has issues. Enable when shell is fixed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('dirname', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    /**
     * Helper to run a shell command and capture output.
     */
    async function run(command: string): Promise<{ exitCode: number; stdout: string }> {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', `${command} > /tmp/out`],
        });

        const result = await handle.wait();
        const stdout = await os.fs.readText('/tmp/out');

        return { exitCode: result.exitCode, stdout };
    }

    // -------------------------------------------------------------------------
    // Basic Usage
    // -------------------------------------------------------------------------

    describe('basic usage', () => {
        it('should return parent directory of absolute path', async () => {
            const result = await run('dirname /usr/bin/cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/usr/bin\n');
        });

        it('should return parent directory of nested path', async () => {
            const result = await run('dirname /home/user/file.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/home/user\n');
        });

        it('should return dot for filename with no directory', async () => {
            const result = await run('dirname file.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('.\n');
        });

        it('should return slash for root directory', async () => {
            const result = await run('dirname /');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/\n');
        });

        it('should return slash for root-level path', async () => {
            const result = await run('dirname /usr');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/\n');
        });
    });

    // -------------------------------------------------------------------------
    // Trailing Slashes
    // -------------------------------------------------------------------------

    describe('trailing slashes', () => {
        it('should remove trailing slash before processing', async () => {
            const result = await run('dirname /home/user/');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/home\n');
        });

        it('should handle multiple trailing slashes', async () => {
            const result = await run('dirname /home/user///');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/home\n');
        });

        it('should handle root with trailing slashes', async () => {
            const result = await run('dirname ///');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/\n');
        });
    });

    // -------------------------------------------------------------------------
    // Multiple Paths
    // -------------------------------------------------------------------------

    describe('multiple paths', () => {
        it('should process multiple paths one per line', async () => {
            const result = await run('dirname /usr/bin /home/user /etc/config');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/usr\n/home\n/etc\n');
        });

        it('should process mix of absolute and relative paths', async () => {
            const result = await run('dirname /usr/bin file.txt /home/user/doc.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/usr\n.\n/home/user\n');
        });
    });

    // -------------------------------------------------------------------------
    // Error Cases
    // -------------------------------------------------------------------------

    describe('error cases', () => {
        // TODO: This test might fail - shell may exit differently on error
        it('should error with no arguments', async () => {
            const result = await run('dirname 2>&1');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });
});
