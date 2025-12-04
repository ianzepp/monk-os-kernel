/**
 * DeviceModel - Virtual device files providing HAL access
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DeviceModel implements the /dev filesystem, providing file-like interfaces to
 * system devices. This follows the Unix "everything is a file" philosophy, allowing
 * processes to interact with devices using standard read/write operations.
 *
 * Standard devices:
 * - /dev/null:    Data sink (writes discarded, reads return EOF)
 * - /dev/zero:    Infinite zeros (writes discarded, reads return zeros)
 * - /dev/random:  Random bytes (reads return random, writes forbidden)
 * - /dev/urandom: Non-blocking random (same behavior as random in JS)
 * - /dev/console: System console (read from stdin, write to stdout)
 * - /dev/clock:   System clock (reads return timestamp, writes forbidden)
 *
 * Compression devices (streaming transform):
 * - /dev/gzip:    Write raw data, read gzip compressed
 * - /dev/gunzip:  Write gzip data, read decompressed
 * - /dev/deflate: Write raw data, read deflate compressed
 * - /dev/inflate: Write deflate data, read decompressed
 *
 * Unlike regular files, devices have no persistent storage. They are backed by
 * HAL services (entropy, console, clock) or streaming transforms.
 *
 * STATE MACHINE (ByteDeviceHandle)
 * ================================
 *
 *   open() ──────────> OPEN ──────────> CLOSED
 *                       │                  ^
 *                       │                  │
 *   [compression]       v                  │
 *                  STREAMING ─────────────>│
 *                  (pump running)     close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Device type is immutable after entity creation
 * INV-2: Devices have no intrinsic size (size always 0)
 * INV-3: Devices don't have children
 * INV-4: null/zero: writes discarded, null reads EOF, zero reads zeros
 * INV-5: random/urandom: reads return random, writes forbidden
 * INV-6: console: reads from stdin, writes to stdout
 * INV-7: clock: reads return timestamp, writes forbidden
 * INV-8: Compression devices maintain independent stream state per handle
 * INV-9: Compression output is buffered until read
 *
 * CONCURRENCY MODEL
 * =================
 * Each handle has independent state. Multiple handles to the same device
 * are independent - no shared mutable state between handles.
 *
 * Compression devices use Web Streams API which handles backpressure
 * internally. The pump reader runs asynchronously, collecting output
 * into pendingChunks for consumption by read().
 *
 * Console device may block on read if stdin is empty. This is expected
 * behavior - it's how interactive input works.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle closure check before every operation
 * RC-2: Console buffer prevents partial reads from being lost
 * RC-3: Compression pump runs independently, output queued safely
 * RC-4: readerDone flag prevents double-cancel on close
 *
 * MEMORY MANAGEMENT
 * =================
 * - Standard devices: minimal state (only console has small buffer)
 * - Compression devices: output chunks accumulate until read
 * - Compression streams are closed on handle close (flushes remaining)
 * - Console buffer released on read, not held indefinitely
 *
 * @module vfs/models/device
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/vfs/handle.js';
import { ENOENT, EBADF, EACCES, EINVAL, ENOTSUP } from '@src/hal/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Storage key prefix for entity metadata.
 * WHY: Consistent with other models; enables namespace partitioning.
 */
const ENTITY_PREFIX = 'entity:';

/**
 * Default read size for devices that don't specify.
 * WHY: 4KB is a common page size and reasonable default for streaming.
 */
const DEFAULT_READ_SIZE = 4096;

/**
 * Maximum size for random device reads.
 * WHY: Prevents resource exhaustion from single large read requests.
 */
const MAX_RANDOM_READ = 65536;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for device entities.
 *
 * TESTABILITY: Exported constant allows tests to verify schema structure.
 *
 * Extended fields:
 * - device: Type of device (null, zero, random, etc.)
 */
const DEVICE_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'device', type: 'string', required: true },
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
];

/**
 * Device types and their behaviors.
 *
 * WHY union type:
 * Provides compile-time checking of device type strings.
 */
type DeviceType =
    | 'null'      // Data sink: reads EOF, writes discarded
    | 'zero'      // Zero source: reads zeros, writes discarded
    | 'random'    // Random source: reads random, writes forbidden
    | 'urandom'   // Non-blocking random (same as random in JS)
    | 'console'   // Console I/O: reads stdin, writes stdout
    | 'clock'     // Clock: reads timestamp, writes forbidden
    | 'gzip'      // Compression: raw -> gzip
    | 'gunzip'    // Decompression: gzip -> raw
    | 'deflate'   // Compression: raw -> deflate
    | 'inflate';  // Decompression: deflate -> raw

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Decode a Uint8Array to a JSON object.
 *
 * WHY: Centralizes JSON deserialization with proper typing.
 *
 * @param data - Raw bytes to decode
 * @returns Parsed JSON object
 */
function decodeEntity<T>(data: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Encode a JSON object to a Uint8Array.
 *
 * WHY: Centralizes JSON serialization for storage.
 *
 * @param entity - Object to encode
 * @returns Encoded bytes
 */
function encodeEntity(entity: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(entity));
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * DeviceModel - Virtual device file model.
 *
 * Implements file-like interface to HAL devices and streaming transforms.
 */
export class DeviceModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY: Used by VFS to dispatch operations to the correct model.
     * INVARIANT: Always 'device' for this model.
     */
    readonly name = 'device';

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for device entities.
     *
     * WHY: Enables schema validation and introspection.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[] {
        return DEVICE_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open a device for I/O operations.
     *
     * ALGORITHM:
     * 1. Load entity metadata to get device type
     * 2. Create ByteDeviceHandle with appropriate behavior
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param flags - Open flags
     * @param _opts - Open options (unused for devices)
     * @returns ByteDeviceHandle for I/O
     * @throws ENOENT - If device entity not found
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat & { device: DeviceType }>(data);
        return new ByteDeviceHandle(ctx, id, entity.device, flags);
    }

    /**
     * Get metadata for a device.
     *
     * WHY size is 0:
     * Devices have no fixed size. They're infinite sources/sinks
     * or streaming transforms with dynamic size.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata with size=0
     * @throws ENOENT - If device not found
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);
        return {
            ...entity,
            size: 0, // Devices have no fixed size
        };
    }

    /**
     * Update metadata fields on a device.
     *
     * WHY device type is NOT updatable:
     * Changing device type would fundamentally change behavior.
     * Create a new device instead.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update (only name/parent allowed)
     * @throws ENOENT - If device not found
     */
    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);

        // Only allow updating name/parent (for move/rename)
        // WHY: device type is fundamental to behavior, shouldn't change
        if (fields.name !== undefined) entity.name = fields.name;
        if (fields.parent !== undefined) entity.parent = fields.parent;

        entity.mtime = ctx.hal.clock.now();

        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));
    }

    /**
     * Create a new device.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param name - Device name
     * @param fields - Must include device type
     * @returns Created entity UUID
     */
    async create(
        ctx: ModelContext,
        parent: string,
        name: string,
        fields?: Partial<ModelStat> & { device?: DeviceType }
    ): Promise<string> {
        const id = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();

        const entity = {
            id,
            model: 'device',
            name,
            parent,
            owner: fields?.owner ?? ctx.caller,
            device: fields?.device ?? 'null', // Default to null device
            size: 0,
            mtime: now,
            ctime: now,
        };

        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));

        return id;
    }

    /**
     * Delete a device.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to delete
     * @throws ENOENT - If device not found
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        await ctx.hal.storage.delete(`${ENTITY_PREFIX}${id}`);
    }

    /**
     * List children of a device.
     *
     * WHY empty:
     * Devices are leaf nodes with no children.
     *
     * @returns Empty iterator
     */
    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Devices don't have children
        return;
    }
}

// =============================================================================
// DEVICE HANDLE
// =============================================================================

/**
 * ByteDeviceHandle - Handle for device I/O operations.
 *
 * Provides byte-level read/write interface to virtual devices.
 * Each device type has different read/write behavior.
 *
 * INVARIANTS:
 * - Closed handles reject all operations with EBADF
 * - Device type determines read/write behavior
 * - Compression streams must be closed to flush output
 */
class ByteDeviceHandle implements FileHandle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique handle identifier.
     *
     * WHY: Enables handle tracking and revocation.
     */
    readonly id: string;

    /**
     * Path this handle was opened with.
     *
     * WHY: Required by FileHandle interface. Empty for devices.
     */
    readonly path: string = '';

    /**
     * Open flags.
     */
    readonly flags: OpenFlags;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether handle has been closed.
     *
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    /**
     * Model context for HAL access.
     *
     * WHY: Needed for entropy, console, clock access.
     */
    private readonly ctx: ModelContext;

    /**
     * Device type.
     *
     * WHY: Determines behavior of read/write operations.
     */
    private readonly device: DeviceType;

    // =========================================================================
    // CONSOLE STATE
    // =========================================================================

    /**
     * Buffer for console input.
     *
     * WHY: Console reads may return more data than requested.
     * Buffer holds excess for next read.
     */
    private consoleBuffer: Uint8Array = new Uint8Array(0);

    // =========================================================================
    // COMPRESSION STATE
    // =========================================================================

    /**
     * Compression or decompression stream.
     *
     * WHY: Streaming API for transform devices.
     */
    private compressionStream?: CompressionStream | DecompressionStream;

    /**
     * Writer for compression input.
     *
     * WHY: Data is written here to be transformed.
     */
    private streamWriter?: WritableStreamDefaultWriter<BufferSource>;

    /**
     * Reader for compression output.
     *
     * WHY: Transformed data is read from here.
     */
    private streamReader?: ReadableStreamDefaultReader<Uint8Array>;

    /**
     * Queue of compressed/decompressed output chunks.
     *
     * WHY: Output arrives asynchronously via pump.
     * Buffer holds it until read() is called.
     */
    private pendingChunks: Uint8Array[] = [];

    /**
     * Whether stream reader has completed.
     *
     * WHY: Prevents double-cancel on close.
     */
    private readerDone = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new ByteDeviceHandle.
     *
     * @param ctx - Model context for HAL access
     * @param _entityId - Entity UUID (for logging)
     * @param device - Device type
     * @param flags - Open flags
     */
    constructor(ctx: ModelContext, _entityId: string, device: DeviceType, flags: OpenFlags) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.device = device;
        this.flags = flags;

        // Initialize compression streams for compression devices
        this.initCompressionStream();
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Whether handle is closed.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // COMPRESSION INITIALIZATION
    // =========================================================================

    /**
     * Initialize compression/decompression stream for transform devices.
     *
     * ALGORITHM:
     * 1. Create appropriate stream based on device type
     * 2. Get writer/reader handles
     * 3. Start background pump to collect output
     *
     * WHY background pump:
     * Output arrives asynchronously after write(). The pump collects
     * output into pendingChunks where read() can find it.
     */
    private initCompressionStream(): void {
        switch (this.device) {
            case 'gzip':
                this.compressionStream = new CompressionStream('gzip');
                break;
            case 'gunzip':
                this.compressionStream = new DecompressionStream('gzip');
                break;
            case 'deflate':
                this.compressionStream = new CompressionStream('deflate');
                break;
            case 'inflate':
                this.compressionStream = new DecompressionStream('deflate');
                break;
            default:
                // Not a compression device
                return;
        }

        // Get handles to stream endpoints
        this.streamWriter = this.compressionStream.writable.getWriter();
        this.streamReader = this.compressionStream.readable.getReader();

        // Start background pump to collect output
        this.pumpReader();
    }

    /**
     * Background pump that collects compressed/decompressed output.
     *
     * ALGORITHM:
     * Loop reading from stream until done, pushing chunks to queue.
     *
     * WHY async without await in constructor:
     * The pump runs independently. Constructor returns immediately,
     * pump continues in background. Output accumulates in pendingChunks.
     *
     * RACE CONDITION:
     * Pump accesses pendingChunks concurrently with read().
     * JavaScript's single-threaded model means this is safe -
     * push and shift are atomic operations.
     */
    private async pumpReader(): Promise<void> {
        if (!this.streamReader) return;

        try {
            while (true) {
                const { value, done } = await this.streamReader.read();
                if (done) {
                    this.readerDone = true;
                    break;
                }
                if (value) {
                    this.pendingChunks.push(value);
                }
            }
        } catch {
            // Stream error - mark as done
            this.readerDone = true;
        }
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Read bytes from device.
     *
     * Behavior depends on device type:
     * - null: Always returns empty (EOF)
     * - zero: Returns zeros of requested size
     * - random/urandom: Returns random bytes
     * - console: Reads from stdin with buffering
     * - clock: Returns current timestamp string
     * - gzip/gunzip/deflate/inflate: Returns compressed/decompressed output
     *
     * @param size - Maximum bytes to read (default: 4096)
     * @returns Bytes read
     * @throws EBADF - If handle is closed
     * @throws EACCES - If not opened for reading
     * @throws EINVAL - If device type is unknown
     */
    async read(size?: number): Promise<Uint8Array> {
        // RACE FIX: Check closure state first
        if (this._closed) {
            throw new EBADF('Handle closed');
        }
        if (!this.flags.read) {
            throw new EACCES('Handle not opened for reading');
        }

        const readSize = size ?? DEFAULT_READ_SIZE;

        switch (this.device) {
            case 'null':
                // /dev/null always returns EOF
                return new Uint8Array(0);

            case 'zero':
                // /dev/zero returns zeros
                return new Uint8Array(readSize);

            case 'random':
            case 'urandom':
                // Return random bytes (capped to prevent abuse)
                return this.ctx.hal.entropy.read(Math.min(readSize, MAX_RANDOM_READ));

            case 'console':
                return this.readConsole(readSize);

            case 'clock':
                // Return current timestamp as string
                return this.readClock();

            case 'gzip':
            case 'gunzip':
            case 'deflate':
            case 'inflate':
                // Return pending compressed/decompressed output
                return this.readCompressionOutput();

            default:
                throw new EINVAL(`Unknown device type: ${this.device}`);
        }
    }

    /**
     * Read from console with buffering.
     *
     * ALGORITHM:
     * 1. If buffer has data, return from buffer
     * 2. Otherwise, read from stdin
     * 3. Buffer any excess for next read
     *
     * WHY buffering:
     * stdin.read() may return more data than requested.
     * Buffer holds excess for subsequent reads.
     *
     * @param size - Maximum bytes to return
     * @returns Console input
     */
    private async readConsole(size: number): Promise<Uint8Array> {
        // First check buffer for leftover data
        if (this.consoleBuffer.length === 0) {
            const chunk = await this.ctx.hal.console.read();
            if (chunk.length === 0) {
                return new Uint8Array(0); // EOF
            }
            this.consoleBuffer = chunk;
        }

        // Return requested size from buffer
        const toReturn = this.consoleBuffer.slice(0, size);
        this.consoleBuffer = this.consoleBuffer.slice(toReturn.length);
        return toReturn;
    }

    /**
     * Read current timestamp from clock device.
     *
     * @returns Timestamp as newline-terminated string
     */
    private readClock(): Uint8Array {
        const now = this.ctx.hal.clock.now();
        return new TextEncoder().encode(now.toString() + '\n');
    }

    /**
     * Read available output from compression stream.
     *
     * WHY return next chunk not all:
     * Matches typical streaming read semantics.
     * Caller loops until empty return indicates done.
     *
     * @returns Next pending chunk, or empty if none available
     */
    private readCompressionOutput(): Uint8Array {
        if (this.pendingChunks.length > 0) {
            return this.pendingChunks.shift()!;
        }
        // No output available yet
        return new Uint8Array(0);
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Write bytes to device.
     *
     * Behavior depends on device type:
     * - null/zero: Writes discarded, returns data.length
     * - random/urandom: Forbidden (EACCES)
     * - console: Writes to stdout
     * - clock: Forbidden (EACCES)
     * - gzip/gunzip/deflate/inflate: Writes to transform input
     *
     * @param data - Bytes to write
     * @returns Number of bytes written
     * @throws EBADF - If handle is closed
     * @throws EACCES - If not opened for writing or device forbids writes
     * @throws EINVAL - If device type is unknown
     */
    async write(data: Uint8Array): Promise<number> {
        // RACE FIX: Check closure state first
        if (this._closed) {
            throw new EBADF('Handle closed');
        }
        if (!this.flags.write) {
            throw new EACCES('Handle not opened for writing');
        }

        switch (this.device) {
            case 'null':
            case 'zero':
                // Data discarded
                return data.length;

            case 'random':
            case 'urandom':
                throw new EACCES('Cannot write to random device');

            case 'console':
                // Write to stdout
                this.ctx.hal.console.write(data);
                return data.length;

            case 'clock':
                throw new EACCES('Cannot write to clock device');

            case 'gzip':
            case 'gunzip':
            case 'deflate':
            case 'inflate':
                await this.writeCompressionInput(data);
                return data.length;

            default:
                throw new EINVAL(`Unknown device type: ${this.device}`);
        }
    }

    /**
     * Write data to compression stream input.
     *
     * @param data - Bytes to compress/decompress
     * @throws EINVAL - If stream not initialized
     */
    private async writeCompressionInput(data: Uint8Array): Promise<void> {
        if (!this.streamWriter) {
            throw new EINVAL('Compression stream not initialized');
        }
        // Cast required for TypeScript's strict ArrayBuffer typing
        await this.streamWriter.write(data as Uint8Array<ArrayBuffer>);
    }

    // =========================================================================
    // POSITION OPERATIONS
    // =========================================================================

    /**
     * Seek in device.
     *
     * WHY not supported:
     * Devices are streaming by nature. Seeking makes no sense for
     * null, random, console, or compression streams.
     *
     * @throws ENOTSUP - Always (devices are not seekable)
     */
    async seek(_offset: number, _whence: SeekWhence): Promise<number> {
        throw new ENOTSUP('Device is not seekable');
    }

    /**
     * Get current position.
     *
     * WHY always 0:
     * Position is meaningless for streaming devices.
     *
     * @returns Always 0
     */
    async tell(): Promise<number> {
        return 0;
    }

    // =========================================================================
    // FLUSH OPERATIONS
    // =========================================================================

    /**
     * Sync device.
     *
     * For compression devices, closes the writer to flush remaining
     * data through the stream.
     *
     * WHY close writer on sync:
     * Compression algorithms buffer data until they have enough
     * for efficient compression. Closing signals "no more input"
     * so final compressed block is emitted.
     */
    async sync(): Promise<void> {
        if (this.streamWriter) {
            await this.streamWriter.close();
        }
    }

    /**
     * Close handle and release resources.
     *
     * ALGORITHM:
     * 1. Mark handle as closed
     * 2. Close compression writer (flushes remaining)
     * 3. Cancel compression reader (cleanup)
     *
     * Safe to call multiple times.
     */
    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        // Close compression stream writer to flush remaining data
        if (this.streamWriter) {
            try {
                await this.streamWriter.close();
            } catch {
                // Ignore errors on close (may already be closed)
            }
        }

        // Cancel reader if still active
        if (this.streamReader && !this.readerDone) {
            try {
                await this.streamReader.cancel();
            } catch {
                // Ignore errors on cancel
            }
        }
    }

    /**
     * AsyncDisposable support.
     */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

// =============================================================================
// INITIALIZATION HELPERS
// =============================================================================

/**
 * Initialize standard devices under /dev.
 *
 * Creates all standard device files at system boot.
 *
 * WHY exported:
 * Called by kernel during filesystem initialization.
 * Also useful for test setup.
 *
 * @param ctx - Model context
 * @param devFolderId - UUID of /dev folder
 */
/**
 * Created device info returned by initStandardDevices.
 */
export interface CreatedDevice {
    name: string;
    id: string;
}

export async function initStandardDevices(
    ctx: ModelContext,
    devFolderId: string
): Promise<CreatedDevice[]> {
    const deviceModel = new DeviceModel();

    /**
     * Standard devices to create.
     *
     * WHY this list:
     * These cover common use cases:
     * - null/zero: Testing and data manipulation
     * - random/urandom: Cryptographic needs
     * - console: User interaction
     * - clock: Time queries
     * - compression: Data transformation
     */
    const devices: Array<{ name: string; device: DeviceType }> = [
        { name: 'null', device: 'null' },
        { name: 'zero', device: 'zero' },
        { name: 'random', device: 'random' },
        { name: 'urandom', device: 'urandom' },
        { name: 'console', device: 'console' },
        { name: 'clock', device: 'clock' },
        { name: 'gzip', device: 'gzip' },
        { name: 'gunzip', device: 'gunzip' },
        { name: 'deflate', device: 'deflate' },
        { name: 'inflate', device: 'inflate' },
    ];

    const created: CreatedDevice[] = [];

    for (const { name, device } of devices) {
        const id = await deviceModel.create(ctx, devFolderId, name, {
            owner: ctx.caller,
            device,
        } as ModelStat & { device: DeviceType });
        created.push({ name, id });
    }

    return created;
}
