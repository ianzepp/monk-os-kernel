/**
 * Hardware Abstraction Layer (HAL)
 *
 * The lowest layer of Monk OS written in TypeScript.
 * Wraps Bun primitives to provide swappable, testable interfaces.
 *
 * Everything below HAL is Bun's responsibility.
 * Everything above accesses hardware through these interfaces.
 */

// Local imports for BunHAL class implementation
import { BunBlockDevice, MemoryBlockDevice } from './block.js';
import { BunStorageEngine, MemoryStorageEngine } from './storage.js';
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

// Error types
export {
    HALError,
    // File/Block I/O
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
    // Network
    EADDRINUSE,
    EADDRNOTAVAIL,
    ECONNREFUSED,
    ECONNRESET,
    ETIMEDOUT,
    EHOSTUNREACH,
    ENETUNREACH,
    ENOTCONN,
    EPIPE,
    // Process/IPC
    ECANCELED,
    EDEADLK,
    EINTR,
    ECHILD,
    ESRCH,
    // Crypto
    EAUTH,
    // General
    ENOSYS,
    ENOTSUP,
    EOVERFLOW,
    ERANGE,
    // Helpers
    isHALError,
    hasErrorCode,
    fromSystemError,
} from './errors.js';

// Device interfaces
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

// Bun implementations
export { BunBlockDevice, MemoryBlockDevice } from './block.js';
export { BunStorageEngine, MemoryStorageEngine } from './storage.js';
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

/**
 * HAL aggregate interface.
 *
 * The kernel receives this at boot time. All hardware access
 * goes through these device interfaces.
 */
export interface HAL {
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

    /**
     * Initialize the HAL.
     * Must be called after construction and before use.
     */
    init(): Promise<void>;

    /**
     * Gracefully shut down all devices.
     *
     * Closes storage connections, network listeners, cancels timers,
     * and releases any held resources. Should be called before process
     * exit to ensure clean shutdown.
     *
     * After shutdown(), the HAL instance should not be used.
     */
    shutdown(): Promise<void>;
}

/**
 * HAL configuration options
 */
export interface HALConfig {
    /**
     * Block device backing store path.
     * If not provided, uses in-memory storage.
     */
    blockPath?: string;

    /**
     * Storage engine type and configuration.
     * - 'memory': In-memory (testing/standalone)
     * - 'sqlite': SQLite file path
     * - 'postgres': PostgreSQL connection URL
     */
    storage?:
        | { type: 'memory' }
        | { type: 'sqlite'; path: string }
        | { type: 'postgres'; url: string };
}

/**
 * BunHAL - HAL implementation using Bun primitives.
 *
 * Usage:
 *   const hal = new BunHAL(config);
 *   await hal.init();
 *   // ... use hal ...
 *   await hal.shutdown();
 */
export class BunHAL implements HAL {
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

    private initialized = false;

    constructor(config?: HALConfig) {
        // Block device
        this.block = config?.blockPath
            ? new BunBlockDevice(config.blockPath)
            : new MemoryBlockDevice();

        // Storage engine
        const storageConfig = config?.storage ?? { type: 'memory' };
        switch (storageConfig.type) {
            case 'memory':
                this.storage = new MemoryStorageEngine();
                break;
            case 'sqlite':
                this.storage = new BunStorageEngine(storageConfig.path);
                break;
            case 'postgres':
                // TODO: PostgresStorageEngine
                throw new Error('PostgreSQL storage not yet implemented');
            default:
                this.storage = new MemoryStorageEngine();
        }

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
    }

    /**
     * Initialize the HAL.
     * Currently a no-op but reserved for future async initialization.
     */
    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        // Reserved for future async initialization (e.g., database connections)
    }

    /**
     * Gracefully shut down all devices.
     */
    async shutdown(): Promise<void> {
        // Cancel all pending timers
        (this.timer as BunTimerDevice).cancelAll();

        // Close storage engine (database connections)
        await this.storage.close();

        // Note: Network listeners/sockets are closed via their own
        // dispose methods. The HAL doesn't track active connections.
        // Kernel is responsible for tracking and closing them.
    }
}

/**
 * Create a HAL instance with Bun implementations.
 *
 * @deprecated Use `new BunHAL(config)` and `await hal.init()` instead.
 * @param config - HAL configuration
 * @returns Configured HAL instance
 */
export async function createBunHAL(config?: HALConfig): Promise<HAL> {
    const hal = new BunHAL(config);
    await hal.init();
    return hal;
}
