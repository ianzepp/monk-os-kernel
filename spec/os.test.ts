/**
 * OS Class Tests
 *
 * Tests for the public OS API as described in planning/OS_BOOT_EXEC.md.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { OS } from '@src/index.js';

describe('OS', () => {
    let os: OS | null = null;

    afterEach(async () => {
        if (os?.isBooted()) {
            await os.shutdown();
        }

        os = null;
    });

    describe('constructor', () => {
        it('should create an OS instance with default config', () => {
            os = new OS();
            expect(os).toBeInstanceOf(OS);
            expect(os.isBooted()).toBe(false);
        });

        it('should create an OS instance with custom aliases', () => {
            os = new OS({
                aliases: {
                    '@app': '/vol/app',
                    '@config': '/vol/config',
                },
            });
            expect(os).toBeInstanceOf(OS);
        });
    });

    describe('alias()', () => {
        it('should add a path alias', () => {
            os = new OS();
            const result = os.alias('@app', '/vol/app');

            expect(result).toBe(os); // fluent API
            expect(os.resolvePath('@app')).toBe('/vol/app');
        });

        it('should resolve alias with subpath', () => {
            os = new OS();
            os.alias('@app', '/vol/app');

            expect(os.resolvePath('@app/server.ts')).toBe('/vol/app/server.ts');
        });

        it('should return path unchanged if no alias matches', () => {
            os = new OS();
            expect(os.resolvePath('/some/path')).toBe('/some/path');
        });
    });

    describe('boot()', () => {
        it('should boot in headless mode (no init)', async () => {
            os = new OS();
            await os.boot();

            expect(os.isBooted()).toBe(true);
        });

        it('should initialize HAL', async () => {
            os = new OS();
            await os.boot();

            const hal = os.getHAL();

            expect(hal).toBeDefined();
            expect(hal.entropy).toBeDefined();
            expect(hal.storage).toBeDefined();
        });

        it('should initialize VFS', async () => {
            os = new OS();
            await os.boot();

            const vfs = os.getVFS();

            expect(vfs).toBeDefined();
        });

        it('should create /dev devices', async () => {
            os = new OS();
            await os.boot();

            const vfs = os.getVFS();

            // Check that standard devices exist
            const consoleStat = await vfs.stat('/dev/console', 'kernel');

            expect(consoleStat).toBeDefined();
            expect(consoleStat.model).toBe('device');

            const nullStat = await vfs.stat('/dev/null', 'kernel');

            expect(nullStat).toBeDefined();
            expect(nullStat.model).toBe('device');
        });

        it('should throw if already booted', async () => {
            os = new OS();
            await os.boot();

            await expect(os.boot()).rejects.toThrow('OS already booted');
        });

        it('should support memory storage (default)', async () => {
            os = new OS({ storage: { type: 'memory' } });
            await os.boot();

            expect(os.isBooted()).toBe(true);
        });
    });

    describe('shutdown()', () => {
        it('should shutdown cleanly', async () => {
            os = new OS();
            await os.boot();
            expect(os.isBooted()).toBe(true);

            await os.shutdown();
            expect(os.isBooted()).toBe(false);
        });

        it('should be idempotent', async () => {
            os = new OS();
            await os.boot();

            await os.shutdown();
            await os.shutdown(); // Should not throw
            expect(os.isBooted()).toBe(false);
        });

        it('should be safe to call before boot', async () => {
            os = new OS();
            await os.shutdown(); // Should not throw
            expect(os.isBooted()).toBe(false);
        });
    });

    describe('getHAL()', () => {
        it('should throw if not booted', () => {
            os = new OS();
            expect(() => os!.getHAL()).toThrow('OS not booted');
        });
    });

    describe('getVFS()', () => {
        it('should throw if not booted', () => {
            os = new OS();
            expect(() => os!.getVFS()).toThrow('OS not booted');
        });
    });

    describe('getKernel()', () => {
        it('should throw if not booted', () => {
            os = new OS();
            expect(() => os!.getKernel()).toThrow('OS not booted');
        });
    });
});

describe('OS with aliases', () => {
    let os: OS | null = null;

    afterEach(async () => {
        if (os?.isBooted()) {
            await os.shutdown();
        }

        os = null;
    });

    it('should support fluent alias configuration', async () => {
        os = new OS()
            .alias('@app', '/vol/app')
            .alias('@config', '/vol/config');

        expect(os.resolvePath('@app')).toBe('/vol/app');
        expect(os.resolvePath('@config')).toBe('/vol/config');
    });

    it('should preserve aliases from constructor', async () => {
        os = new OS({
            aliases: {
                '@src': '/vol/src',
            },
        });

        expect(os.resolvePath('@src/main.ts')).toBe('/vol/src/main.ts');
    });
});
