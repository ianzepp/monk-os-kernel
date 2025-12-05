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
import { createTestContext, EXIT, type TestContext } from './_harness.js';

describe('false', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestContext();
    });

    afterEach(async () => {
        await ctx.shutdown();
    });

    it('should exit with code 1', async () => {
        const result = await ctx.run('false');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should produce no output', async () => {
        const result = await ctx.run('false');

        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
    });

    it('should ignore arguments', async () => {
        const result = await ctx.run('false ignored args --flag');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
