/**
 * whoami Command Tests
 *
 * Tests for the `whoami` command which prints the current user name.
 *
 * GNU BEHAVIOR
 * ============
 * - Prints the effective user name
 * - Gets username from USER environment variable
 * - Defaults to 'unknown' if USER is not set
 * - No flags or options supported
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

describe('whoami', () => {
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
    // Basic Output
    // -------------------------------------------------------------------------

    describe('basic output', () => {
        it('should output current user name', async () => {
            const result = await run('whoami');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
            expect(result.stdout).toMatch(/\w+\n/);
        });

        it('should output user from USER env variable', async () => {
            // TODO: This test will likely need env variable setup support
            const result = await run('USER=testuser whoami');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('testuser\n');
        });

        it('should default to unknown if USER not set', async () => {
            // TODO: This test will likely need env variable manipulation support
            const result = await run('env -u USER whoami');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('unknown\n');
        });
    });

    // -------------------------------------------------------------------------
    // No Options
    // -------------------------------------------------------------------------

    describe('no options', () => {
        it('should ignore unknown flags and still output username', async () => {
            // GNU whoami ignores unknown flags
            const result = await run('whoami -v');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
        });

        it('should ignore extra arguments', async () => {
            // GNU whoami ignores extra arguments
            const result = await run('whoami extra args');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
        });
    });

    // -------------------------------------------------------------------------
    // Pipeline
    // -------------------------------------------------------------------------

    describe('pipeline', () => {
        it('should work as pipe source', async () => {
            const result = await run('whoami | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
            expect(result.stdout).toMatch(/\w+\n/);
        });

        it('should work through multiple pipes', async () => {
            const result = await run('whoami | cat | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
            expect(result.stdout).toMatch(/\w+\n/);
        });
    });
});
