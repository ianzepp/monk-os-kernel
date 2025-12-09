/**
 * OS Class Tests
 *
 * Tests for the public OS API.
 *
 * NOTE: Production OS is tested here. For subsystem access in tests,
 * use TestOS with internal* getters instead.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { OS, TestOS, BaseOS } from '@src/index.js';

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

        it('should initialize subsystems (verify via syscall)', async () => {
            os = new OS();
            await os.boot();

            // Verify VFS is working via syscall
            const stat = await os.syscall<{ model: string }>('file:stat', '/');

            expect(stat.model).toBe('folder');
        });

        it('should create /dev devices', async () => {
            os = new OS();
            await os.boot();

            // Check that standard devices exist via syscalls
            const consoleStat = await os.syscall<{ model: string }>('file:stat', '/dev/console');

            expect(consoleStat).toBeDefined();
            expect(consoleStat.model).toBe('device');

            const nullStat = await os.syscall<{ model: string }>('file:stat', '/dev/null');

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

// =============================================================================
// Class Hierarchy Tests
// =============================================================================

describe('BaseOS hierarchy', () => {
    it('should have OS extending BaseOS', () => {
        const os = new OS();

        expect(os).toBeInstanceOf(BaseOS);
        expect(os).toBeInstanceOf(OS);
    });

    it('should have TestOS extending BaseOS', () => {
        const os = new TestOS();

        expect(os).toBeInstanceOf(BaseOS);
        expect(os).toBeInstanceOf(TestOS);
    });

    it('should share common functionality between OS and TestOS', () => {
        const prodOs = new OS();
        const testOs = new TestOS();

        // Both should have the same public methods
        expect(typeof prodOs.alias).toBe('function');
        expect(typeof testOs.alias).toBe('function');
        expect(typeof prodOs.resolvePath).toBe('function');
        expect(typeof testOs.resolvePath).toBe('function');
        expect(typeof prodOs.isBooted).toBe('function');
        expect(typeof testOs.isBooted).toBe('function');
        expect(typeof prodOs.shutdown).toBe('function');
        expect(typeof testOs.shutdown).toBe('function');
    });
});

describe('TestOS internal accessors', () => {
    let os: TestOS | null = null;

    afterEach(async () => {
        if (os?.isBooted()) {
            await os.shutdown();
        }

        os = null;
    });

    it('should provide internalHal after boot', async () => {
        os = new TestOS();
        await os.boot({ layers: ['hal'] });

        expect(os.internalHal).toBeDefined();
        expect(os.internalHal.entropy).toBeDefined();
    });

    it('should provide internalVfs after boot', async () => {
        os = new TestOS();
        await os.boot({ layers: ['vfs'] });

        expect(os.internalVfs).toBeDefined();
    });

    it('should provide internalEms after boot', async () => {
        os = new TestOS();
        await os.boot({ layers: ['ems'] });

        expect(os.internalEms).toBeDefined();
    });

    it('should provide internalAuth after boot', async () => {
        os = new TestOS();
        await os.boot({ layers: ['auth'] });

        expect(os.internalAuth).toBeDefined();
    });

    it('should provide internalKernel after boot', async () => {
        os = new TestOS();
        await os.boot({ layers: ['kernel'] });

        expect(os.internalKernel).toBeDefined();
    });

    it('should throw if accessing internal* before boot', () => {
        os = new TestOS();

        expect(() => os!.internalHal).toThrow('HAL not booted');
        expect(() => os!.internalVfs).toThrow('VFS not booted');
        expect(() => os!.internalEms).toThrow('EMS not booted');
    });
});
