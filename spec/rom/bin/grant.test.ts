/**
 * grant Command Tests
 *
 * Tests for the `grant` command which manages file access control lists (ACLs).
 *
 * MONK OS SPECIFICATION
 * =====================
 * The grant utility manages fine-grained access control for files and directories.
 * It supports granting/revoking operations, deny lists, and listing ACLs.
 *
 * @module spec/rom/bin/grant
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('grant', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should display help with --help flag', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'grant --help > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Usage:');
        expect(stdout).toContain('grant +OP USER PATH');
    });

    it('should display help with -h flag', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'grant -h > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const stdout = await os.fs.readText('/tmp/out');

        expect(stdout).toContain('Examples:');
    });

    it('should fail gracefully when path does not exist', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'grant --list /nonexistent > /tmp/out'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should handle no arguments', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'grant > /tmp/out'],
        });

        const result = await handle.wait();

        // Should show help and exit 0
        expect(result.exitCode).toBe(EXIT.SUCCESS);

        const output = await os.fs.readText('/tmp/out');

        expect(output).toContain('Usage:');
    });
});
