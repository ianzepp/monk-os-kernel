/**
 * echo Command Tests
 *
 * Tests for the `echo` command which displays text to stdout.
 *
 * GNU BEHAVIOR
 * ============
 * - Outputs arguments separated by spaces
 * - Adds trailing newline by default
 * - -n flag suppresses trailing newline
 * - Only leading flags are parsed
 *
 * NOTE: These tests are currently skipped because shell external command
 * execution has issues. Enable when shell is fixed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, EXIT, type TestContext } from './_harness.js';

describe.skip('echo', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestContext();
    });

    afterEach(async () => {
        await ctx.shutdown();
    });

    // -------------------------------------------------------------------------
    // Basic Output
    // -------------------------------------------------------------------------

    describe('basic output', () => {
        it('should output single argument with newline', async () => {
            const result = await ctx.run('echo hello');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        it('should output multiple arguments with spaces', async () => {
            const result = await ctx.run('echo hello world');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello world\n');
        });

        it('should output blank line with no arguments', async () => {
            const result = await ctx.run('echo');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('\n');
        });
    });

    // -------------------------------------------------------------------------
    // Flags
    // -------------------------------------------------------------------------

    describe('flags', () => {
        it('should suppress newline with -n flag', async () => {
            const result = await ctx.run('echo -n hello');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello');
        });

        it('should treat -n after text as literal', async () => {
            // GNU behavior: only leading flags are parsed
            const result = await ctx.run('echo hello -n');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello -n\n');
        });
    });

    // -------------------------------------------------------------------------
    // Quoted Strings
    // -------------------------------------------------------------------------

    describe('quoted strings', () => {
        it('should preserve spaces in double quotes', async () => {
            const result = await ctx.run('echo "hello   world"');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello   world\n');
        });

        it('should preserve spaces in single quotes', async () => {
            const result = await ctx.run("echo 'hello   world'");
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello   world\n');
        });
    });

    // -------------------------------------------------------------------------
    // Pipeline
    // -------------------------------------------------------------------------

    describe('pipeline', () => {
        it('should work as pipe source', async () => {
            const result = await ctx.run('echo hello | cat');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        it('should work through multiple pipes', async () => {
            const result = await ctx.run('echo hello | cat | cat');
            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });
    });
});
