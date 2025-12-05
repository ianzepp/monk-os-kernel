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

describe('OS.fs', () => {
    let os: OS;

    afterEach(async () => {
        if (os?.isBooted()) {
            await os.shutdown();
        }
    });

    describe('write() and read()', () => {
        it('should write and read a file', async () => {
            os = new OS();
            await os.boot();

            await os.fs.write('/test.txt', 'Hello, World!');
            const data = await os.fs.read('/test.txt');

            expect(new TextDecoder().decode(data)).toBe('Hello, World!');
        });

        it('should write and read binary data', async () => {
            os = new OS();
            await os.boot();

            const binary = new Uint8Array([1, 2, 3, 4, 5]);

            await os.fs.write('/binary.bin', binary);
            const data = await os.fs.read('/binary.bin');

            expect(data).toEqual(binary);
        });

        it('should support readText() helper', async () => {
            os = new OS();
            await os.boot();

            await os.fs.write('/text.txt', 'Some text content');
            const text = await os.fs.readText('/text.txt');

            expect(text).toBe('Some text content');
        });

        it('should resolve aliases in paths', async () => {
            os = new OS({ aliases: { '@data': '/vol/data' } });
            await os.boot();

            await os.fs.mkdir('/vol/data', { recursive: true });
            await os.fs.write('@data/file.txt', 'aliased!');
            const text = await os.fs.readText('@data/file.txt');

            expect(text).toBe('aliased!');
        });
    });

    describe('stat()', () => {
        it('should return file stat', async () => {
            os = new OS();
            await os.boot();

            await os.fs.write('/myfile.txt', 'content');
            const stat = await os.fs.stat('/myfile.txt');

            expect(stat.type).toBe('file');
            expect(stat.name).toBe('myfile.txt');
            expect(stat.size).toBeGreaterThan(0);
        });

        it('should return folder stat', async () => {
            os = new OS();
            await os.boot();

            await os.fs.mkdir('/myfolder');
            const stat = await os.fs.stat('/myfolder');

            expect(stat.type).toBe('folder');
            expect(stat.name).toBe('myfolder');
        });

        it('should throw for non-existent path', async () => {
            os = new OS();
            await os.boot();

            await expect(os.fs.stat('/nonexistent')).rejects.toThrow();
        });
    });

    describe('exists()', () => {
        it('should return true for existing file', async () => {
            os = new OS();
            await os.boot();

            await os.fs.write('/exists.txt', 'yes');
            expect(await os.fs.exists('/exists.txt')).toBe(true);
        });

        it('should return false for non-existent path', async () => {
            os = new OS();
            await os.boot();

            expect(await os.fs.exists('/nope')).toBe(false);
        });
    });

    describe('mkdir()', () => {
        it('should create a directory', async () => {
            os = new OS();
            await os.boot();

            await os.fs.mkdir('/newdir');
            const stat = await os.fs.stat('/newdir');

            expect(stat.type).toBe('folder');
        });

        it('should create nested directories with recursive option', async () => {
            os = new OS();
            await os.boot();

            await os.fs.mkdir('/a/b/c', { recursive: true });
            const stat = await os.fs.stat('/a/b/c');

            expect(stat.type).toBe('folder');
        });
    });

    describe('readdir()', () => {
        it('should list directory contents', async () => {
            os = new OS();
            await os.boot();

            await os.fs.mkdir('/dir');
            await os.fs.write('/dir/a.txt', 'a');
            await os.fs.write('/dir/b.txt', 'b');
            await os.fs.mkdir('/dir/subdir');

            const entries = await os.fs.readdir('/dir');

            expect(entries).toContain('a.txt');
            expect(entries).toContain('b.txt');
            expect(entries).toContain('subdir');
        });

        it('should return stat info with readdirStat()', async () => {
            os = new OS();
            await os.boot();

            await os.fs.mkdir('/statdir');
            await os.fs.write('/statdir/file.txt', 'content');
            await os.fs.mkdir('/statdir/folder');

            const entries = await os.fs.readdirStat('/statdir');

            expect(entries.length).toBe(2);
            const file = entries.find(e => e.name === 'file.txt');
            const folder = entries.find(e => e.name === 'folder');

            expect(file?.type).toBe('file');
            expect(folder?.type).toBe('folder');
        });
    });

    describe('unlink()', () => {
        it('should delete a file', async () => {
            os = new OS();
            await os.boot();

            await os.fs.write('/todelete.txt', 'bye');
            expect(await os.fs.exists('/todelete.txt')).toBe(true);

            await os.fs.unlink('/todelete.txt');
            expect(await os.fs.exists('/todelete.txt')).toBe(false);
        });

        it('should delete an empty directory', async () => {
            os = new OS();
            await os.boot();

            await os.fs.mkdir('/emptydir');
            await os.fs.unlink('/emptydir');

            expect(await os.fs.exists('/emptydir')).toBe(false);
        });
    });

    describe('mount() and unmount()', () => {
        it('should mount a host directory', async () => {
            os = new OS();
            await os.boot();

            // Mount the current test directory
            os.fs.mount('./spec', '/mounted');

            // Should be able to read files from host
            const exists = await os.fs.exists('/mounted/os.test.ts');

            expect(exists).toBe(true);
        });

        it('should unmount a host directory', async () => {
            os = new OS();
            await os.boot();

            os.fs.mount('./spec', '/mounted');
            expect(await os.fs.exists('/mounted/os.test.ts')).toBe(true);

            os.fs.unmount('/mounted');
            // After unmount, path should not resolve to host
            expect(await os.fs.exists('/mounted/os.test.ts')).toBe(false);
        });

        it('should resolve aliases in mount paths', async () => {
            os = new OS({ aliases: { '@tests': '/vol/tests' } });
            await os.boot();

            os.fs.mount('./spec', '@tests');
            const exists = await os.fs.exists('@tests/os.test.ts');

            expect(exists).toBe(true);
        });
    });
});
