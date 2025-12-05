/**
 * date Command Tests
 *
 * Tests for the `date` command which displays date and time.
 *
 * GNU BEHAVIOR
 * ============
 * - Prints current date/time in default format
 * - -u flag displays UTC time
 * - -I flag displays ISO 8601 format
 * - +FORMAT allows custom formatting with % codes
 * - Supports various format specifiers: %Y, %m, %d, %H, %M, %S, etc.
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

describe('date', () => {
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
        it('should output current date', async () => {
            const result = await run('date');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
            expect(result.stdout).toContain('2025');
        });

        it('should output UTC date with -u flag', async () => {
            const result = await run('date -u');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
            expect(result.stdout).toContain('GMT');
        });

        it('should output ISO 8601 format with -I flag', async () => {
            const result = await run('date -I');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        });
    });

    // -------------------------------------------------------------------------
    // Format Specifiers
    // -------------------------------------------------------------------------

    describe('format specifiers', () => {
        it('should format with %Y for 4-digit year', async () => {
            const result = await run('date +%Y');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^2025\n$/);
        });

        it('should format with %Y-%m-%d for ISO date', async () => {
            const result = await run('date "+%Y-%m-%d"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2}\n$/);
        });

        it('should format with %H:%M:%S for time', async () => {
            const result = await run('date "+%H:%M:%S"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
        });

        it('should format with multiple specifiers', async () => {
            const result = await run('date "+%Y-%m-%d %H:%M:%S"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n$/);
        });
    });

    // -------------------------------------------------------------------------
    // Special Format Codes
    // -------------------------------------------------------------------------

    describe('special format codes', () => {
        it('should handle %a for short weekday', async () => {
            const result = await run('date +%a');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\n$/);
        });

        it('should handle %b for short month', async () => {
            const result = await run('date +%b');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\n$/);
        });

        it('should handle %% for literal percent', async () => {
            const result = await run('date "+%%"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('%\n');
        });

        it('should handle %n for newline', async () => {
            const result = await run('date "+%Y%n%m"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/^2025\n\d{2}\n$/);
        });
    });
});
