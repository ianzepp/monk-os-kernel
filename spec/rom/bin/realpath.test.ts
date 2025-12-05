/**
 * realpath Command Tests
 *
 * Tests for the `realpath` command which prints resolved absolute paths.
 *
 * GNU BEHAVIOR
 * ============
 * - Resolves relative paths to absolute paths
 * - Resolves . and .. components
 * - -e flag requires all path components to exist
 * - -m flag allows non-existent paths (default)
 * - -q flag suppresses error messages
 * - --relative-to=DIR prints path relative to directory
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

describe('realpath', () => {
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
        it('should resolve current directory', async () => {
            const result = await run('realpath .');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Output should be an absolute path
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });

        it('should resolve parent directory reference', async () => {
            const result = await run('realpath ..');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });

        it('should resolve nested parent references', async () => {
            const result = await run('realpath ../../../');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\/.*\n$/);
        });

        it('should resolve absolute path as-is', async () => {
            const result = await run('realpath /usr/bin');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/usr/bin\n');
        });
    });

    // -------------------------------------------------------------------------
    // Help Output
    // -------------------------------------------------------------------------

    describe('help', () => {
        it('should display help with --help', async () => {
            const result = await run('realpath --help');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('Usage:');
            expect(result.stdout).toContain('Options:');
        });

        it('should display help with -h', async () => {
            const result = await run('realpath -h');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('Usage:');
        });
    });

    // -------------------------------------------------------------------------
    // Existence Checking
    // -------------------------------------------------------------------------

    describe('existence checking', () => {
        // TODO: These tests require filesystem setup
        it('should succeed with -m for non-existent path (default)', async () => {
            const result = await run('realpath -m /nonexistent/path/file.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/nonexistent/path/file.txt\n');
        });

        it('should fail with -e for non-existent path', async () => {
            const result = await run('realpath -e /nonexistent/path/file.txt 2>&1');

            // TODO: This might not capture stderr correctly
            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });

    // -------------------------------------------------------------------------
    // Multiple Paths
    // -------------------------------------------------------------------------

    describe('multiple paths', () => {
        it('should process multiple paths', async () => {
            const result = await run('realpath . .. /usr');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Should have three lines of output
            const lines = result.stdout.trim().split('\n');
            expect(lines.length).toBe(3);
            expect(lines[0]).toMatch(/^\//);
            expect(lines[1]).toMatch(/^\//);
            expect(lines[2]).toBe('/usr');
        });

        it('should continue on error with multiple paths', async () => {
            const result = await run('realpath -e /nonexistent /usr 2>&1');

            // TODO: May not capture stderr correctly
            // Should fail overall but process all paths
            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });

    // -------------------------------------------------------------------------
    // Error Cases
    // -------------------------------------------------------------------------

    describe('error cases', () => {
        it('should error with no arguments', async () => {
            const result = await run('realpath 2>&1');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('missing operand');
        });

        it('should suppress errors with -q flag', async () => {
            const result = await run('realpath -q -e /nonexistent 2>&1');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            // Error message should not appear (quiet mode)
            expect(result.stdout).not.toContain('realpath:');
        });
    });
});
