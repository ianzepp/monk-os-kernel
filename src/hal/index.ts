/**
 * Hardware Abstraction Layer (HAL) - Unified device interface
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The HAL is the lowest TypeScript layer in Monk OS, sitting directly atop Bun's
 * runtime primitives. It provides a uniform, testable interface to all hardware
 * resources: storage, networking, timers, cryptography, entropy, console I/O,
 * DNS, IPC, compression, and host OS access.
 *
 * Design philosophy:
 * - Everything below HAL is Bun's responsibility (Workers, native APIs, etc.)
 * - Everything above HAL accesses hardware only through these interfaces
 * - Interfaces are swappable for testing (BunHAL vs MockHAL)
 * - All async operations use Promise/AsyncIterable patterns
 * - Errors follow POSIX conventions (ENOENT, EBADF, etc.)
 *
 * The HAL aggregates 14 device interfaces:
 *
 * 1. BlockDevice: Raw byte storage (files, S3, databases as byte arrays)
 * 2. StorageEngine: Key-value store with transactions (SQLite, PostgreSQL, memory)
 * 3. NetworkDevice: TCP/UDP/HTTP networking (listen, connect, serve)
 * 4. TimerDevice: Scheduling (setTimeout, setInterval, sleep)
 * 5. ClockDevice: Time sources (Date.now, Bun.nanoseconds, monotonic time)
 * 6. EntropyDevice: Random bytes, UUIDs, secure random numbers
 * 7. CryptoDevice: Hash, encryption, signatures, key derivation
 * 8. ConsoleDevice: stdin/stdout/stderr interaction
 * 9. DNSDevice: Hostname resolution, reverse DNS
 * 10. HostDevice: Escape hatch to host OS (Bun.spawn, system info)
 * 11. IPCDevice: Shared memory, mutexes, semaphores, condition variables
 * 12. ChannelDevice: Protocol-aware messaging (HTTP, WebSocket, PostgreSQL, SQLite)
 * 13. CompressionDevice: Gzip/deflate compression/decompression
 * 14. FileDevice: Host filesystem access (KERNEL USE ONLY - see file.ts)
 *
 * BunHAL is the production implementation using Bun primitives. Test implementations
 * (MockHAL, MemoryStorageEngine, etc.) enable deterministic testing without real
 * hardware interaction.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: HAL must be initialized via init() before use
 * INV-2: HAL must be shut down via shutdown() to release resources
 * INV-3: After shutdown(), HAL instance should not be used (undefined behavior)
 * INV-4: All device interfaces remain constant after construction (readonly)
 * INV-5: Device implementations may be swapped during construction but never after
 *
 * CONCURRENCY MODEL
 * =================
 * The HAL itself has minimal state - it's primarily a container for device
 * interfaces. Each device manages its own concurrency:
 *
 * - BlockDevice: File operations may interleave (Bun handles file locking)
 * - StorageEngine: Transactions serialize writes, reads can interleave
 * - NetworkDevice: Multiple sockets can be active concurrently
 * - TimerDevice: Multiple timers can be scheduled concurrently
 * - Etc.
 *
 * The only HAL-level state is the initialized flag, which is set once during
 * init() and never changes after.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: init() is idempotent (safe to call multiple times, only first call has effect)
 * RC-2: shutdown() cancels timers before closing storage (deterministic order)
 * RC-3: Device constructors may start background work (e.g., network listeners)
 *       but should be safe to construct multiple times for testing
 *
 * MEMORY MANAGEMENT
 * =================
 * - BunHAL owns device instances via readonly fields
 * - Device instances own their resources (timers, sockets, file handles, etc.)
 * - shutdown() coordinates resource cleanup across all devices:
 *   1. Cancel all pending timers
 *   2. Close storage connections
 *   3. Network sockets/listeners closed by kernel (not tracked by HAL)
 * - Devices should implement proper cleanup in their own lifecycle methods
 *
 * LIFECYCLE
 * =========
 * 1. Construction: new BunHAL(config) - creates device instances
 * 2. Initialization: await hal.init() - async setup (database connections, etc.)
 * 3. Operation: kernel/VFS use hal.* devices for hardware access
 * 4. Shutdown: await hal.shutdown() - graceful resource cleanup
 *
 * TESTABILITY
 * ===========
 * HAL's primary testing benefit is interface swapping:
 * - BunHAL for production (real Bun primitives)
 * - MockHAL for unit tests (scripted behavior, no real I/O)
 * - Mixed approach: BunStorageEngine + MockNetworkDevice (test specific layers)
 *
 * Example:
 *   const hal = new BunHAL({ storage: { type: 'memory' } });
 *   await hal.init();
 *   // Use hal.storage, hal.timer, etc.
 *   await hal.shutdown();
 *
 * @module hal
 */

// =============================================================================
// DEVICE IMPLEMENTATIONS
// =============================================================================

// WHY: Import all Bun device implementations for BunHAL construction.
// These are the production implementations that wrap Bun primitives.
import { BunBlockDevice, MemoryBlockDevice } from './block.js';
import { BunStorageEngine, MemoryStorageEngine, PostgresStorageEngine } from './storage.js';
import { BunNetworkDevice } from './network.js';
import { BunTimerDevice } from './timer.js';
import { BunClockDevice } from './clock.js';
import { BunEntropyDevice } from './entropy.js';
import { BunCryptoDevice } from './crypto.js';
import { BunConsoleDevice } from './console.js';
import { BunDNSDevice } from './dns.js';
import { BunHostDevice } from './host.js';
import { BunIPCDevice } from './ipc.js';
import { BunChannelDevice } from './channel.js';
import { BunCompressionDevice } from './compression.js';
import { BunFileDevice } from './file.js';
import { EIO } from './errors.js';

// =============================================================================
// ERROR TYPES (RE-EXPORTS)
// =============================================================================

// WHY: Export all error types so higher layers can import from single module.
// Avoids needing to import from hal/errors.js separately.
export {
    HALError,
    // File/Block I/O errors
    EACCES,
    EAGAIN,
    EBADF,
    EBUSY,
    EEXIST,
    EFAULT,
    EFBIG,
    EINVAL,
    EIO,
    EISDIR,
    EMFILE,
    ENAMETOOLONG,
    ENOENT,
    ENOSPC,
    ENOTDIR,
    ENOTEMPTY,
    EPERM,
    EROFS,
    // Network errors
    EADDRINUSE,
    EADDRNOTAVAIL,
    ECONNREFUSED,
    ECONNRESET,
    ETIMEDOUT,
    EHOSTUNREACH,
    ENETUNREACH,
    ENOTCONN,
    EPIPE,
    // Process/IPC errors
    ECANCELED,
    EDEADLK,
    EINTR,
    ECHILD,
    ESRCH,
    // Crypto errors
    EAUTH,
    // General errors
    ENOSYS,
    ENOTSUP,
    EOVERFLOW,
    ERANGE,
    // Helper functions
    isHALError,
    hasErrorCode,
    fromSystemError,
} from './errors.js';

// =============================================================================
// DEVICE INTERFACE TYPES (RE-EXPORTS)
// =============================================================================

// WHY: Export all device interface types so consumers can reference interfaces
// without importing from individual device files.
export type { BlockDevice, BlockStat, BlockLock } from './block.js';
export type { StorageEngine, StorageStat, Transaction, WatchEvent } from './storage.js';
export type {
    NetworkDevice,
    Listener,
    ListenerAcceptOpts,
    Socket,
    SocketReadOpts,
    SocketStat,
    HttpServer,
    HttpHandler,
    ListenOpts,
    ConnectOpts,
    TlsOpts,
} from './network.js';
export type { TimerDevice, TimerHandle } from './timer.js';
export type { ClockDevice } from './clock.js';
export type { EntropyDevice } from './entropy.js';
export type { CryptoDevice, HashAlg, CipherAlg, KeyAlg, KdfAlg } from './crypto.js';
export type { ConsoleDevice } from './console.js';
export type { DNSDevice } from './dns.js';
export type { HostDevice, HostProcess, HostSpawnOpts, HostStat } from './host.js';
export type { IPCDevice, Mutex, MutexLockOpts, Semaphore, CondVar } from './ipc.js';
export type { ChannelDevice, Channel, ChannelOpts } from './channel.js';
export type { CompressionDevice, CompressionAlg, CompressionLevel, CompressionOpts } from './compression.js';
export type { FileDevice, FileStat } from './file.js';

// =============================================================================
// DEVICE IMPLEMENTATION CLASSES (RE-EXPORTS)
// =============================================================================

// WHY: Export all device implementations (Bun and test variants) for direct use.
// Allows constructing devices individually or swapping implementations.
export { BunBlockDevice, MemoryBlockDevice } from './block.js';
export { BunStorageEngine, MemoryStorageEngine, PostgresStorageEngine } from './storage.js';
export { BunNetworkDevice } from './network.js';
export { BunTimerDevice, MockTimerDevice } from './timer.js';
export { BunClockDevice, MockClockDevice } from './clock.js';
export { BunEntropyDevice, SeededEntropyDevice } from './entropy.js';
export { BunCryptoDevice } from './crypto.js';
export { BunConsoleDevice, BufferConsoleDevice } from './console.js';
export { BunDNSDevice, MockDNSDevice } from './dns.js';
export { BunHostDevice, MockHostDevice } from './host.js';
export { BunIPCDevice, MockIPCDevice } from './ipc.js';
export { BunChannelDevice } from './channel.js';
export { BunCompressionDevice, MockCompressionDevice } from './compression.js';
export { BunFileDevice, MockFileDevice } from './file.js';

// =============================================================================
// HAL INTERFACE
// =============================================================================

/**
 * HAL aggregate interface
 *
 * The kernel receives this at boot time. All hardware access goes through
 * these device interfaces.
 *
 * WHY: Aggregating all devices into single interface simplifies dependency
 * injection. Kernel/VFS receive one HAL object instead of 13 separate devices.
 *
 * INVARIANTS:
 * - All device fields are readonly (never reassigned after construction)
 * - init() must be called before using devices
 * - shutdown() must be called before process exit
 */
export interface HAL {
    /** Raw byte storage (files, S3, databases) */
    readonly block: import('./block.js').BlockDevice;

    /** Key-value storage with transactions (SQLite, PostgreSQL, memory) */
    readonly storage: import('./storage.js').StorageEngine;

    /** TCP/UDP/HTTP networking (listen, connect, socket operations) */
    readonly network: import('./network.js').NetworkDevice;

    /** Scheduling (setTimeout, setInterval, sleep) */
    readonly timer: import('./timer.js').TimerDevice;

    /** Time sources (Date.now, Bun.nanoseconds, monotonic time) */
    readonly clock: import('./clock.js').ClockDevice;

    /** Random bytes, UUIDs, secure random numbers */
    readonly entropy: import('./entropy.js').EntropyDevice;

    /** Hash, encryption, signatures, key derivation */
    readonly crypto: import('./crypto.js').CryptoDevice;

    /** stdin/stdout/stderr interaction */
    readonly console: import('./console.js').ConsoleDevice;

    /** Hostname resolution, reverse DNS */
    readonly dns: import('./dns.js').DNSDevice;

    /** Escape hatch to host OS (Bun.spawn, system info) */
    readonly host: import('./host.js').HostDevice;

    /** Shared memory, mutexes, semaphores, condition variables */
    readonly ipc: import('./ipc.js').IPCDevice;

    /** Protocol-aware messaging (HTTP, WebSocket, PostgreSQL, SQLite) */
    readonly channel: import('./channel.js').ChannelDevice;

    /** Gzip/deflate compression/decompression */
    readonly compression: import('./compression.js').CompressionDevice;

    /**
     * Host filesystem access (KERNEL USE ONLY)
     *
     * WARNING: This device is for kernel bootstrap operations only.
     * For user-space file I/O, use VFS or channels.
     *
     * See hal/file.ts for restrictions and proper usage.
     */
    readonly file: import('./file.js').FileDevice;

    /**
     * Initialize the HAL
     *
     * Must be called after construction and before use. Performs async
     * initialization like database connections.
     *
     * WHY: Some devices require async setup (e.g., database connections).
     * Constructors must be synchronous in JavaScript, so we need separate
     * async init method.
     *
     * INVARIANT: Idempotent - safe to call multiple times (only first call has effect).
     */
    init(): Promise<void>;

    /**
     * Gracefully shut down all devices
     *
     * Closes storage connections, network listeners, cancels timers, and
     * releases any held resources. Should be called before process exit to
     * ensure clean shutdown.
     *
     * ALGORITHM:
     * 1. Cancel all pending timers (prevents callbacks after shutdown)
     * 2. Close storage engine (flush writes, close connections)
     * 3. Network sockets/listeners are closed by kernel (not tracked by HAL)
     *
     * WHY: Order matters - timers might reference storage/network, so cancel
     * them first. Storage should be closed last to ensure all writes complete.
     *
     * INVARIANT: After shutdown(), HAL instance should not be used.
     *
     * @returns Promise that resolves when shutdown is complete
     */
    shutdown(): Promise<void>;
}

// =============================================================================
// HAL CONFIGURATION
// =============================================================================

/**
 * HAL configuration options
 *
 * WHY: Allows customizing device implementations and parameters at construction
 * time. Production uses Bun implementations with persistent storage, tests use
 * in-memory variants.
 */
export interface HALConfig {
    /**
     * Block device backing store path
     *
     * WHY: Block device can use file, memory, or remote storage. Path specifies
     * where to persist bytes. If not provided, uses in-memory storage (tests).
     *
     * USAGE:
     * - Production: './data/blocks'
     * - Tests: undefined (memory)
     */
    blockPath?: string;

    /**
     * Storage engine type and configuration
     *
     * WHY: Storage engine is pluggable. Three variants supported:
     * - memory: In-memory (testing, ephemeral)
     * - sqlite: SQLite file (single-node, embedded)
     * - postgres: PostgreSQL (distributed, production)
     *
     * USAGE:
     * - Development: { type: 'memory' }
     * - Single-node: { type: 'sqlite', path: './data/monk.db' }
     * - Production: { type: 'postgres', url: 'postgresql://...' }
     */
    storage?:
        | { type: 'memory' }
        | { type: 'sqlite'; path: string }
        | { type: 'postgres'; url: string };
}

// =============================================================================
// BUNHAL IMPLEMENTATION
// =============================================================================

/**
 * BunHAL - HAL implementation using Bun primitives
 *
 * Production HAL implementation. Constructs all 13 device interfaces using
 * Bun runtime primitives (Bun.spawn, Bun.listen, Bun.serve, bun:sqlite, etc.).
 *
 * WHY: Single class that aggregates all devices simplifies kernel/VFS construction.
 * One `new BunHAL()` call instead of 13 separate device instantiations.
 *
 * USAGE:
 *   const hal = new BunHAL({ storage: { type: 'sqlite', path: './monk.db' } });
 *   await hal.init();
 *   // Use hal.storage, hal.timer, etc.
 *   await hal.shutdown();
 *
 * TESTABILITY: HAL interface enables swapping implementations. Tests can
 * construct MockHAL instead of BunHAL to avoid real I/O.
 */
export class BunHAL implements HAL {
    // =========================================================================
    // DEVICE INSTANCES
    // =========================================================================
    // WHY: readonly ensures devices cannot be reassigned after construction.
    // Devices are constructed in constructor and remain constant.

    readonly block: import('./block.js').BlockDevice;
    readonly storage: import('./storage.js').StorageEngine;
    readonly network: import('./network.js').NetworkDevice;
    readonly timer: import('./timer.js').TimerDevice;
    readonly clock: import('./clock.js').ClockDevice;
    readonly entropy: import('./entropy.js').EntropyDevice;
    readonly crypto: import('./crypto.js').CryptoDevice;
    readonly console: import('./console.js').ConsoleDevice;
    readonly dns: import('./dns.js').DNSDevice;
    readonly host: import('./host.js').HostDevice;
    readonly ipc: import('./ipc.js').IPCDevice;
    readonly channel: import('./channel.js').ChannelDevice;
    readonly compression: import('./compression.js').CompressionDevice;
    readonly file: import('./file.js').FileDevice;

    // =========================================================================
    // LIFECYCLE STATE
    // =========================================================================

    /**
     * Initialization flag
     *
     * WHY: Tracks whether init() has been called. Prevents double-initialization
     * which could leak resources (e.g., multiple database connections).
     *
     * INVARIANT: Set to true during first init() call, never reset.
     */
    private initialized = false;

    // =========================================================================
    // CONSTRUCTION
    // =========================================================================

    /**
     * Construct BunHAL with optional configuration
     *
     * Creates all 13 device instances based on config. Storage and block devices
     * are configurable (memory vs persistent), other devices use Bun implementations.
     *
     * ALGORITHM:
     * 1. Create block device (file-based or memory)
     * 2. Create storage engine (SQLite, PostgreSQL, or memory)
     * 3. Create remaining devices with Bun implementations
     *
     * WHY: Configuration allows tests to use memory storage while production
     * uses persistent storage. Other devices are less frequently mocked.
     *
     * @param config - HAL configuration options
     */
    constructor(config?: HALConfig) {
        // Block device: file-based or memory
        // WHY: Block device is where VFS stores file content as raw bytes.
        // Memory block device is fast for tests, file-based is durable.
        this.block = config?.blockPath
            ? new BunBlockDevice(config.blockPath)
            : new MemoryBlockDevice();

        // Storage engine: SQLite, PostgreSQL, or memory
        // WHY: Storage engine is where VFS stores metadata (filenames, UUIDs, etc.).
        // Choice of engine affects performance, durability, and scalability.
        const storageConfig = config?.storage ?? { type: 'memory' };
        switch (storageConfig.type) {
            case 'memory':
                this.storage = new MemoryStorageEngine();
                break;
            case 'sqlite':
                this.storage = new BunStorageEngine(storageConfig.path);
                break;
            case 'postgres':
                // WHY: PostgreSQL enables distributed VFS with multiple Monk nodes
                // NOTE: pg.init() is called in init() method to handle async schema setup
                this.storage = new PostgresStorageEngine(storageConfig.url);
                break;
            default:
                this.storage = new MemoryStorageEngine();
        }

        // Remaining devices: Bun implementations
        // WHY: These devices are less frequently mocked. Tests that need mocked
        // timers/clocks/etc. can construct devices individually.
        this.timer = new BunTimerDevice();
        this.network = new BunNetworkDevice();
        this.clock = new BunClockDevice();
        this.entropy = new BunEntropyDevice();
        this.crypto = new BunCryptoDevice();
        this.console = new BunConsoleDevice();
        this.dns = new BunDNSDevice();
        this.host = new BunHostDevice();
        this.ipc = new BunIPCDevice();
        this.channel = new BunChannelDevice();
        this.compression = new BunCompressionDevice();
        this.file = new BunFileDevice();
    }

    // =========================================================================
    // LIFECYCLE METHODS
    // =========================================================================

    /**
     * Initialize the HAL
     *
     * Performs async initialization for devices that need it (e.g., database
     * connections). Currently a no-op but reserved for future use.
     *
     * WHY: Some devices may need async setup (database connections, network
     * listeners, etc.). Constructors must be sync, so we need separate init().
     *
     * INVARIANT: Idempotent - safe to call multiple times. Only first call
     * has effect (initialized flag prevents double-init).
     */
    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        // WHY: PostgresStorageEngine requires async schema initialization
        // SQLite and Memory engines initialize synchronously in constructor
        if (this.storage instanceof PostgresStorageEngine) {
            await this.storage.init();
        }
    }

    /**
     * Gracefully shut down all devices
     *
     * Coordinates cleanup across all devices to ensure clean shutdown.
     *
     * ALGORITHM:
     * 1. Cancel all pending timers (synchronous, completes immediately)
     * 2. Close storage engine (flush writes, close connections)
     * 3. Note: Network sockets closed by kernel, not tracked here
     *
     * WHY: Order matters - cancel timers first (they might reference storage),
     * then close storage (ensures writes complete before exit).
     *
     * MEMORY LEAK PREVENTION: Without this, timers continue firing after HAL
     * is destroyed, potentially accessing freed resources.
     *
     * ERROR HANDLING: Errors during shutdown are logged but don't prevent
     * cleanup of other resources. This ensures best-effort cleanup even
     * when some resources fail to close properly.
     */
    async shutdown(): Promise<void> {
        const errors: Error[] = [];

        // WHY: Cancel timers first to prevent callbacks from firing during shutdown.
        // This is synchronous - timers are cancelled immediately before any await.
        try {
            (this.timer as BunTimerDevice).cancelAll();
        } catch (err) {
            errors.push(new EIO(`Timer cleanup failed: ${err instanceof Error ? err.message : String(err)}`));
        }

        // WHY: Close storage after timers are cancelled.
        // Timer callbacks could reference storage, so cancel them first.
        try {
            await this.storage.close();
        } catch (err) {
            errors.push(new EIO(`Storage close failed: ${err instanceof Error ? err.message : String(err)}`));
        }

        // WHY: Network listeners/sockets are closed via their own dispose methods.
        // The HAL doesn't track active connections - that's the kernel's job.
        // Kernel is responsible for tracking and closing them before HAL shutdown.

        // Report errors if any occurred during shutdown
        if (errors.length > 0) {
            const message = errors.map((e) => e.message).join('; ');
            throw new EIO(`HAL shutdown encountered errors: ${message}`);
        }
    }
}

// =============================================================================
// DEPRECATED FACTORY FUNCTION
// =============================================================================

/**
 * Create a HAL instance with Bun implementations
 *
 * @deprecated Use `new BunHAL(config)` and `await hal.init()` instead.
 *
 * WHY: Factory function obscures construction. Better to use constructor
 * directly so caller sees exactly what's being created.
 *
 * MIGRATION:
 *   // Old
 *   const hal = await createBunHAL(config);
 *
 *   // New
 *   const hal = new BunHAL(config);
 *   await hal.init();
 *
 * @param config - HAL configuration
 * @returns Configured HAL instance
 */
export async function createBunHAL(config?: HALConfig): Promise<HAL> {
    const hal = new BunHAL(config);
    await hal.init();
    return hal;
}
