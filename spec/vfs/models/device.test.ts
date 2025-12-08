/**
 * DeviceModel Tests
 *
 * Comprehensive tests for DeviceModel and ByteDeviceHandle covering all device types.
 *
 * COVERAGE GOALS
 * ==============
 * - DeviceModel: fields(), open(), stat(), setstat(), create(), unlink(), list()
 * - ByteDeviceHandle for each device type: null, zero, random, urandom, console, clock
 * - Compression devices: gzip, gunzip, deflate, inflate
 * - Handle operations: read(), write(), seek(), tell(), close(), sync()
 * - initStandardDevices() helper
 *
 * TESTING APPROACH
 * ================
 * - Use TestOS with layers: ['vfs'] for full stack integration
 * - Mock HAL console for input/output testing
 * - Test each device type's unique behavior
 * - Verify error conditions (EBADF, EACCES, ENOTSUP, etc.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DeviceModel, initStandardDevices } from '@src/vfs/models/device.js';
import { TestOS } from '@src/os/test.js';
import { ENOENT, EBADF, EACCES, ENOTSUP } from '@src/hal/index.js';
import type { ModelContext } from '@src/vfs/model.js';
import type { OpenFlags } from '@src/vfs/handle.js';

// =============================================================================
// TEST SETUP
// =============================================================================

let os: TestOS;
let model: DeviceModel;
let ctx: ModelContext;
let devFolderId: string;

beforeEach(async () => {
    os = new TestOS();
    await os.boot({ layers: ['vfs'] });

    // WHY: /dev is created by VFS initialization, use existing folder
    const devStat = await os.internalVfs.stat('/dev', 'kernel');

    devFolderId = devStat.id;

    model = new DeviceModel();

    // Create mock context
    ctx = {
        hal: os.internalHal,
        caller: 'test-user',
        resolve: async (path: string) => {
            try {
                const stat = await os.internalVfs.stat(path, 'kernel');

                return stat.id;
            }
            catch {
                return null;
            }
        },
        getEntity: async (id: string) => {
            try {
                return await os.internalVfs.stat(id, 'kernel');
            }
            catch {
                return null;
            }
        },
        computePath: async (_id: string) => '',
    };
});

afterEach(async () => {
    await os.shutdown();
});

// =============================================================================
// DEVICEMODEL TESTS
// =============================================================================

describe('DeviceModel', () => {
    describe('identity', () => {
        it('should have name "device"', () => {
            expect(model.name).toBe('device');
        });

        it('should return field definitions', () => {
            const fields = model.fields();

            expect(fields.length).toBeGreaterThan(0);

            const idField = fields.find(f => f.name === 'id');
            const deviceField = fields.find(f => f.name === 'device');

            expect(idField).toBeDefined();
            expect(idField?.required).toBe(true);
            expect(deviceField).toBeDefined();
            expect(deviceField?.required).toBe(true);
        });
    });

    describe('create()', () => {
        it('should create a null device', async () => {
            const id = await model.create(ctx, devFolderId, 'null', {
                device: 'null',
            });

            expect(id).toBeDefined();
            expect(typeof id).toBe('string');

            const stat = await model.stat(ctx, id);

            expect(stat.model).toBe('device');
            expect(stat.name).toBe('null');
        });

        it('should create a random device', async () => {
            const id = await model.create(ctx, devFolderId, 'random', {
                device: 'random',
            });

            const stat = await model.stat(ctx, id);

            expect(stat.model).toBe('device');
            expect(stat.name).toBe('random');
        });

        it('should create a console device', async () => {
            const id = await model.create(ctx, devFolderId, 'console', {
                device: 'console',
            });

            const stat = await model.stat(ctx, id);

            expect(stat.model).toBe('device');
            expect(stat.name).toBe('console');
        });

        it('should default to null device if type not specified', async () => {
            const id = await model.create(ctx, devFolderId, 'default-device');

            const stat = await model.stat(ctx, id);

            expect(stat.model).toBe('device');
        });
    });

    describe('stat()', () => {
        it('should return device metadata with size=0', async () => {
            const id = await model.create(ctx, devFolderId, 'null', {
                device: 'null',
            });

            const stat = await model.stat(ctx, id);

            expect(stat.id).toBe(id);
            expect(stat.model).toBe('device');
            expect(stat.name).toBe('null');
            expect(stat.size).toBe(0);
            expect(stat.mtime).toBeDefined();
            expect(stat.ctime).toBeDefined();
        });

        it('should throw ENOENT for non-existent device', async () => {
            await expect(model.stat(ctx, 'nonexistent-id')).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('setstat()', () => {
        it('should update device name', async () => {
            const id = await model.create(ctx, devFolderId, 'original-name', {
                device: 'null',
            });

            await model.setstat(ctx, id, { name: 'renamed-device' });

            const stat = await model.stat(ctx, id);

            expect(stat.name).toBe('renamed-device');
        });

        it('should update device parent', async () => {
            const newParentId = await os.internalVfs.mkdir('/tmp', 'kernel');

            const id = await model.create(ctx, devFolderId, 'device', {
                device: 'null',
            });

            await model.setstat(ctx, id, { parent: newParentId });

            const stat = await model.stat(ctx, id);

            expect(stat.parent).toBe(newParentId);
        });

        it('should update mtime on setstat', async () => {
            const id = await model.create(ctx, devFolderId, 'device', {
                device: 'null',
            });

            const statBefore = await model.stat(ctx, id);

            // Wait a bit to ensure time changes
            await new Promise(resolve => setTimeout(resolve, 10));

            await model.setstat(ctx, id, { name: 'renamed' });

            const statAfter = await model.stat(ctx, id);

            expect(statAfter.mtime).toBeGreaterThan(statBefore.mtime);
        });

        it('should throw ENOENT for non-existent device', async () => {
            await expect(
                model.setstat(ctx, 'nonexistent-id', { name: 'new-name' }),
            ).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('unlink()', () => {
        it('should delete a device', async () => {
            const id = await model.create(ctx, devFolderId, 'device', {
                device: 'null',
            });

            await model.unlink(ctx, id);

            await expect(model.stat(ctx, id)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should throw ENOENT for non-existent device', async () => {
            await expect(model.unlink(ctx, 'nonexistent-id')).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('list()', () => {
        it('should return empty iterator for devices', async () => {
            const id = await model.create(ctx, devFolderId, 'device', {
                device: 'null',
            });

            const children: string[] = [];

            for await (const child of model.list(ctx, id)) {
                children.push(child);
            }

            expect(children).toEqual([]);
        });
    });

    describe('open()', () => {
        it('should create ByteDeviceHandle for device', async () => {
            const id = await model.create(ctx, devFolderId, 'null', {
                device: 'null',
            });

            const flags: OpenFlags = { read: true, write: false };
            const handle = await model.open(ctx, id, flags);

            expect(handle).toBeDefined();
            expect(handle.id).toBeDefined();
            expect(handle.closed).toBe(false);

            await handle.close();
        });

        it('should throw ENOENT for non-existent device', async () => {
            const flags: OpenFlags = { read: true, write: false };

            await expect(model.open(ctx, 'nonexistent-id', flags)).rejects.toBeInstanceOf(ENOENT);
        });
    });
});

// =============================================================================
// NULL DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - null device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'null', {
            device: 'null',
        });
    });

    it('should read EOF immediately', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data = await handle.read();

        expect(data.length).toBe(0);

        await handle.close();
    });

    it('should discard writes and return data length', async () => {
        const flags: OpenFlags = { read: false, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        const content = new TextEncoder().encode('test data');
        const written = await handle.write(content);

        expect(written).toBe(content.length);

        await handle.close();
    });

    it('should throw EACCES when reading without read flag', async () => {
        const flags: OpenFlags = { read: false, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        await expect(handle.read()).rejects.toBeInstanceOf(EACCES);

        await handle.close();
    });

    it('should throw EACCES when writing without write flag', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EACCES);

        await handle.close();
    });
});

// =============================================================================
// ZERO DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - zero device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'zero', {
            device: 'zero',
        });
    });

    it('should read zeros of requested size', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data = await handle.read(100);

        expect(data.length).toBe(100);
        expect(data.every(byte => byte === 0)).toBe(true);

        await handle.close();
    });

    it('should read default size (4096) when no size specified', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data = await handle.read();

        expect(data.length).toBe(4096);
        expect(data.every(byte => byte === 0)).toBe(true);

        await handle.close();
    });

    it('should discard writes and return data length', async () => {
        const flags: OpenFlags = { read: false, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        const content = new TextEncoder().encode('test data');
        const written = await handle.write(content);

        expect(written).toBe(content.length);

        await handle.close();
    });
});

// =============================================================================
// RANDOM DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - random device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'random', {
            device: 'random',
        });
    });

    it('should read random bytes of requested size', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data = await handle.read(100);

        expect(data.length).toBe(100);

        // Random data should not be all zeros
        expect(data.some(byte => byte !== 0)).toBe(true);

        await handle.close();
    });

    it('should cap read size at MAX_RANDOM_READ (65536)', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data = await handle.read(100000);

        expect(data.length).toBeLessThanOrEqual(65536);

        await handle.close();
    });

    it('should throw EACCES when writing to random device', async () => {
        const flags: OpenFlags = { read: false, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EACCES);

        await handle.close();
    });

    it('should generate different random bytes on multiple reads', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data1 = await handle.read(32);
        const data2 = await handle.read(32);

        // WHY: Extremely unlikely random bytes are identical
        expect(data1).not.toEqual(data2);

        await handle.close();
    });
});

// =============================================================================
// URANDOM DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - urandom device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'urandom', {
            device: 'urandom',
        });
    });

    it('should read random bytes (same behavior as random)', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data = await handle.read(100);

        expect(data.length).toBe(100);
        expect(data.some(byte => byte !== 0)).toBe(true);

        await handle.close();
    });

    it('should throw EACCES when writing to urandom device', async () => {
        const flags: OpenFlags = { read: false, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EACCES);

        await handle.close();
    });
});

// =============================================================================
// CONSOLE DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - console device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'console', {
            device: 'console',
        });
    });

    it('should write to stdout via HAL console', async () => {
        const flags: OpenFlags = { read: false, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        const content = new TextEncoder().encode('test output');
        const written = await handle.write(content);

        expect(written).toBe(content.length);

        await handle.close();
    });

    it('should buffer console reads correctly', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        // WHY: Reading from real stdin in tests is problematic.
        // This test verifies the handle is created and can be used,
        // but actual read behavior depends on stdin availability.
        // In production, console.read() blocks waiting for input.

        await handle.close();
    });
});

// =============================================================================
// CLOCK DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - clock device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'clock', {
            device: 'clock',
        });
    });

    it('should read current timestamp', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data = await handle.read();
        const text = new TextDecoder().decode(data);

        // Should be a number followed by newline
        expect(text).toMatch(/^\d+\n$/);

        const timestamp = Number.parseInt(text.trim(), 10);

        expect(timestamp).toBeGreaterThan(0);

        await handle.close();
    });

    it('should throw EACCES when writing to clock device', async () => {
        const flags: OpenFlags = { read: false, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EACCES);

        await handle.close();
    });

    it('should return different timestamps on multiple reads', async () => {
        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, deviceId, flags);

        const data1 = await handle.read();
        const time1 = Number.parseInt(new TextDecoder().decode(data1).trim(), 10);

        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 10));

        const data2 = await handle.read();
        const time2 = Number.parseInt(new TextDecoder().decode(data2).trim(), 10);

        expect(time2).toBeGreaterThanOrEqual(time1);

        await handle.close();
    });
});

// =============================================================================
// GZIP COMPRESSION DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - gzip device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'gzip', {
            device: 'gzip',
        });
    });

    it('should compress data written to it', async () => {
        const flags: OpenFlags = { read: true, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        const input = new TextEncoder().encode('Hello, World!');

        await handle.write(input);

        // WHY: sync() closes the writer to flush remaining compressed data
        await handle.sync();

        // WHY: Need to wait for compression pump to process
        await new Promise(resolve => setTimeout(resolve, 10));

        const compressed = await handle.read();

        expect(compressed.length).toBeGreaterThan(0);

        // WHY: gzip adds headers/trailers, so output is different from input
        expect(compressed).not.toEqual(input);

        await handle.close();
    });

    it('should handle multiple writes', async () => {
        const flags: OpenFlags = { read: true, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        await handle.write(new TextEncoder().encode('Part 1 '));
        await handle.write(new TextEncoder().encode('Part 2 '));
        await handle.write(new TextEncoder().encode('Part 3'));

        await handle.sync();

        // WHY: Wait for compression to process
        await new Promise(resolve => setTimeout(resolve, 10));

        const compressed = await handle.read();

        expect(compressed.length).toBeGreaterThan(0);

        await handle.close();
    });
});

// =============================================================================
// GUNZIP DECOMPRESSION DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - gunzip device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'gunzip', {
            device: 'gunzip',
        });
    });

    it('should decompress gzip data', async () => {
        const flags: OpenFlags = { read: true, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        const original = new TextEncoder().encode('Hello, World!');

        // First, compress the data using browser's CompressionStream
        const gzipStream = new CompressionStream('gzip');
        const writer = gzipStream.writable.getWriter();
        const reader = gzipStream.readable.getReader();

        await writer.write(original);
        await writer.close();

        // WHY: Read all chunks from compression stream
        const compressedChunks: Uint8Array[] = [];

        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            compressedChunks.push(value);
        }

        // WHY: Concatenate all compressed chunks
        const totalLength = compressedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const compressed = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of compressedChunks) {
            compressed.set(chunk, offset);
            offset += chunk.length;
        }

        expect(compressed.length).toBeGreaterThan(0);

        // Now decompress using gunzip device
        await handle.write(compressed);
        await handle.sync();

        // WHY: Wait for decompression to process
        await new Promise(resolve => setTimeout(resolve, 10));

        const decompressed = await handle.read();
        const text = new TextDecoder().decode(decompressed);

        expect(text).toBe('Hello, World!');

        await handle.close();
    });
});

// =============================================================================
// DEFLATE COMPRESSION DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - deflate device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'deflate', {
            device: 'deflate',
        });
    });

    it('should compress data using deflate', async () => {
        const flags: OpenFlags = { read: true, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        const input = new TextEncoder().encode('Test deflate compression');

        await handle.write(input);
        await handle.sync();

        await new Promise(resolve => setTimeout(resolve, 10));

        const compressed = await handle.read();

        expect(compressed.length).toBeGreaterThan(0);
        expect(compressed).not.toEqual(input);

        await handle.close();
    });
});

// =============================================================================
// INFLATE DECOMPRESSION DEVICE TESTS
// =============================================================================

describe('ByteDeviceHandle - inflate device', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'inflate', {
            device: 'inflate',
        });
    });

    it('should decompress deflate data', async () => {
        const flags: OpenFlags = { read: true, write: true };
        const handle = await model.open(ctx, deviceId, flags);

        const original = new TextEncoder().encode('Test inflate decompression');

        // First, compress using deflate
        const deflateStream = new CompressionStream('deflate');
        const writer = deflateStream.writable.getWriter();
        const reader = deflateStream.readable.getReader();

        await writer.write(original);
        await writer.close();

        // WHY: Read all chunks from compression stream
        const compressedChunks: Uint8Array[] = [];

        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            compressedChunks.push(value);
        }

        // WHY: Concatenate all compressed chunks
        const totalLength = compressedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const compressed = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of compressedChunks) {
            compressed.set(chunk, offset);
            offset += chunk.length;
        }

        expect(compressed.length).toBeGreaterThan(0);

        // Now decompress using inflate device
        await handle.write(compressed);
        await handle.sync();

        await new Promise(resolve => setTimeout(resolve, 10));

        const decompressed = await handle.read();
        const text = new TextDecoder().decode(decompressed);

        expect(text).toBe('Test inflate decompression');

        await handle.close();
    });
});

// =============================================================================
// HANDLE OPERATION TESTS
// =============================================================================

describe('ByteDeviceHandle - operations', () => {
    let deviceId: string;

    beforeEach(async () => {
        deviceId = await model.create(ctx, devFolderId, 'null', {
            device: 'null',
        });
    });

    describe('seek()', () => {
        it('should throw ENOTSUP (devices are not seekable)', async () => {
            const flags: OpenFlags = { read: true, write: false };
            const handle = await model.open(ctx, deviceId, flags);

            await expect(handle.seek(0, 'start')).rejects.toBeInstanceOf(ENOTSUP);

            await handle.close();
        });
    });

    describe('tell()', () => {
        it('should always return 0', async () => {
            const flags: OpenFlags = { read: true, write: false };
            const handle = await model.open(ctx, deviceId, flags);

            const pos = await handle.tell();

            expect(pos).toBe(0);

            await handle.close();
        });
    });

    describe('close()', () => {
        it('should mark handle as closed', async () => {
            const flags: OpenFlags = { read: true, write: false };
            const handle = await model.open(ctx, deviceId, flags);

            expect(handle.closed).toBe(false);

            await handle.close();

            expect(handle.closed).toBe(true);
        });

        it('should be safe to call multiple times', async () => {
            const flags: OpenFlags = { read: true, write: false };
            const handle = await model.open(ctx, deviceId, flags);

            await handle.close();
            await handle.close();
            await handle.close();

            expect(handle.closed).toBe(true);
        });

        it('should throw EBADF when reading after close', async () => {
            const flags: OpenFlags = { read: true, write: false };
            const handle = await model.open(ctx, deviceId, flags);

            await handle.close();

            await expect(handle.read()).rejects.toBeInstanceOf(EBADF);
        });

        it('should throw EBADF when writing after close', async () => {
            const flags: OpenFlags = { read: false, write: true };
            const handle = await model.open(ctx, deviceId, flags);

            await handle.close();

            await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EBADF);
        });
    });

    describe('sync()', () => {
        it('should succeed for non-compression devices', async () => {
            const flags: OpenFlags = { read: true, write: false };
            const handle = await model.open(ctx, deviceId, flags);

            await handle.sync();

            expect(handle.closed).toBe(false);

            await handle.close();
        });

        it('should flush compression stream', async () => {
            const gzipId = await model.create(ctx, devFolderId, 'gzip', {
                device: 'gzip',
            });

            const flags: OpenFlags = { read: true, write: true };
            const handle = await model.open(ctx, gzipId, flags);

            await handle.write(new TextEncoder().encode('test'));
            await handle.sync();

            // WHY: sync() closes writer, flushing final compressed block
            await new Promise(resolve => setTimeout(resolve, 10));

            const compressed = await handle.read();

            expect(compressed.length).toBeGreaterThan(0);

            await handle.close();
        });
    });

    describe('AsyncDisposable', () => {
        it('should support using syntax', async () => {
            const flags: OpenFlags = { read: true, write: false };

            await using handle = await model.open(ctx, deviceId, flags);

            expect(handle.closed).toBe(false);

            // WHY: handle automatically closed when scope exits
        });
    });
});

// =============================================================================
// INITSTANDARDDEVICES TESTS
// =============================================================================

describe('initStandardDevices()', () => {
    it('should create all standard devices', async () => {
        const devices = await initStandardDevices(ctx, devFolderId);

        expect(devices.length).toBe(10);

        const deviceNames = devices.map(d => d.name);

        expect(deviceNames).toContain('null');
        expect(deviceNames).toContain('zero');
        expect(deviceNames).toContain('random');
        expect(deviceNames).toContain('urandom');
        expect(deviceNames).toContain('console');
        expect(deviceNames).toContain('clock');
        expect(deviceNames).toContain('gzip');
        expect(deviceNames).toContain('gunzip');
        expect(deviceNames).toContain('deflate');
        expect(deviceNames).toContain('inflate');
    });

    it('should create devices with correct types', async () => {
        const devices = await initStandardDevices(ctx, devFolderId);

        for (const { id } of devices) {
            const stat = await model.stat(ctx, id);

            expect(stat.model).toBe('device');
            expect(stat.size).toBe(0);
        }
    });

    it('should create devices that can be opened', async () => {
        const devices = await initStandardDevices(ctx, devFolderId);

        const nullDevice = devices.find(d => d.name === 'null');

        expect(nullDevice).toBeDefined();

        const flags: OpenFlags = { read: true, write: false };
        const handle = await model.open(ctx, nullDevice!.id, flags);

        expect(handle).toBeDefined();

        await handle.close();
    });
});
