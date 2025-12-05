/**
 * pwd Command Tests
 *
 * Tests for the `pwd` command which prints the current working directory.
 *
 * GNU BEHAVIOR
 * ============
 * - Prints absolute path of current working directory
 * - Always outputs to stdout with trailing newline
 * - Simple command with no flags or arguments
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

describe('pwd', () => {
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
        it('should print current working directory', async () => {
            const result = await run('pwd');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Output should be an absolute path
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });

        it('should print absolute path starting with /', async () => {
            const result = await run('pwd');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout.startsWith('/')).toBe(true);
        });

        it('should end with newline', async () => {
            const result = await run('pwd');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout.endsWith('\n')).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // Working with cd
    // -------------------------------------------------------------------------

    describe('working with cd', () => {
        // TODO: These tests require cd command to work properly
        it('should reflect directory changes', async () => {
            const result = await run('cd / && pwd');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/\n');
        });

        it('should show changed directory after cd', async () => {
            const result = await run('cd /usr && pwd');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/usr\n');
        });

        it('should handle nested directory changes', async () => {
            const result = await run('cd /usr/bin && pwd');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/usr/bin\n');
        });
    });

    // -------------------------------------------------------------------------
    // Pipeline Usage
    // -------------------------------------------------------------------------

    describe('pipeline usage', () => {
        it('should work as pipe source', async () => {
            const result = await run('pwd | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });

        it('should work through multiple pipes', async () => {
            const result = await run('pwd | cat | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });
    });

    // -------------------------------------------------------------------------
    // Edge Cases
    // -------------------------------------------------------------------------

    describe('edge cases', () => {
        it('should ignore extra arguments', async () => {
            // GNU pwd ignores arguments
            const result = await run('pwd foo bar baz');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });

        it('should ignore flags', async () => {
            // Simple pwd implementation may not have flags
            const result = await run('pwd -L');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });
    });
});
