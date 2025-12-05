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
import { createTestContext, EXIT, type TestContext } from './_harness.js';

describe('true', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestContext();
    });

    afterEach(async () => {
        await ctx.shutdown();
    });

    it('should exit with code 0', async () => {
        const result = await ctx.run('true');
        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    it('should produce no output', async () => {
        const result = await ctx.run('true');
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
    });

    it('should ignore arguments', async () => {
        const result = await ctx.run('true ignored args --flag');
        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    // TODO: && chaining with redirects needs investigation
    // it('should work in && chain', async () => {
    //     const result = await ctx.run('true && echo yes');
    //     expect(result.exitCode).toBe(EXIT.SUCCESS);
    //     expect(result.stdout).toBe('yes\n');
    // });
});
