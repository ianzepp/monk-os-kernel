/**
 * Hardware Abstraction Layer (HAL)
 *
 * The lowest layer of Monk OS written in TypeScript.
 * Wraps Bun primitives to provide swappable, testable interfaces.
 *
 * Everything below HAL is Bun's responsibility.
 * Everything above accesses hardware through these interfaces.
 */

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
 * Create a HAL instance with Bun implementations.
 *
 * @param config - HAL configuration
 * @returns Configured HAL instance
 */
export async function createBunHAL(config?: HALConfig): Promise<HAL> {
    const { BunBlockDevice, MemoryBlockDevice } = await import('./block.js');
    const { BunStorageEngine, MemoryStorageEngine } = await import('./storage.js');
    const { BunNetworkDevice } = await import('./network.js');
    const { BunTimerDevice } = await import('./timer.js');
    const { BunClockDevice } = await import('./clock.js');
    const { BunEntropyDevice } = await import('./entropy.js');
    const { BunCryptoDevice } = await import('./crypto.js');
    const { BunConsoleDevice } = await import('./console.js');
    const { BunDNSDevice } = await import('./dns.js');
    const { BunHostDevice } = await import('./host.js');
    const { BunIPCDevice } = await import('./ipc.js');

    // Block device
    const block = config?.blockPath
        ? new BunBlockDevice(config.blockPath)
        : new MemoryBlockDevice();

    // Storage engine
    let storage: import('./storage.js').StorageEngine;
    const storageConfig = config?.storage ?? { type: 'memory' };
    switch (storageConfig.type) {
        case 'memory':
            storage = new MemoryStorageEngine();
            break;
        case 'sqlite':
            storage = new BunStorageEngine(storageConfig.path);
            break;
        case 'postgres':
            // TODO: PostgresStorageEngine
            throw new Error('PostgreSQL storage not yet implemented');
        default:
            storage = new MemoryStorageEngine();
    }

    const timer = new BunTimerDevice();

    return {
        block,
        storage,
        network: new BunNetworkDevice(),
        timer,
        clock: new BunClockDevice(),
        entropy: new BunEntropyDevice(),
        crypto: new BunCryptoDevice(),
        console: new BunConsoleDevice(),
        dns: new BunDNSDevice(),
        host: new BunHostDevice(),
        ipc: new BunIPCDevice(),

        async shutdown(): Promise<void> {
            // Cancel all pending timers
            timer.cancelAll();

            // Close storage engine (database connections)
            await storage.close();

            // Note: Network listeners/sockets are closed via their own
            // dispose methods. The HAL doesn't track active connections.
            // Kernel is responsible for tracking and closing them.
        },
    };
}
