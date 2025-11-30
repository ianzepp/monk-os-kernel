# Monk OS Hardware Abstraction Layer (HAL)

## Overview

The HAL is the lowest layer of Monk OS that can be written in TypeScript. It wraps Bun's primitives to provide swappable, testable interfaces for the kernel.

Everything below the HAL is Bun's responsibility. Everything above accesses hardware through these interfaces.

```
┌─────────────────────────────────────────┐
│  Kernel, Syscalls, Processes            │
├─────────────────────────────────────────┤
│  HAL (this document)                    │ ◄── Lowest you can write
├─────────────────────────────────────────┤
│  Bun APIs                               │ ◄── You call these, can't replace
├─────────────────────────────────────────┤
│  Bun internals (Zig + JavaScriptCore)   │
├─────────────────────────────────────────┤
│  Host OS                                │
├─────────────────────────────────────────┤
│  Physical Hardware                      │
└─────────────────────────────────────────┘
```

## Design Principles

### Naming Convention

- **Terse but greppable**: Short names that are still searchable
- **Lowercase methods**: `genkey` not `generateKey`, but `semaphore` not `sema`
- **POSIX-style for I/O**: `read`, `write`, `stat`, `sync`
- **Domain-specific elsewhere**: `get`/`put` for key-value, `lookup` for DNS

### Litmus Test

> "If someone searches the codebase for this concept, will they find it?"

- `grep -r "semaphore"` - finds it
- `grep -r "sema"` - might miss it, false positives (semantic, semaphore elsewhere)
- `grep -r "monotonic"` - finds it
- `grep -r "mono"` - monokai? monorepo? monolithic?

### Consistency Patterns

| Pattern | Used In | Meaning |
|---------|---------|---------|
| `read` | BlockDevice, Socket, Console, Entropy | Get bytes from source |
| `write` | BlockDevice, Socket, Console | Put bytes to destination |
| `stat` | BlockDevice, StorageEngine, Socket, Host | Get metadata |
| `get/put/delete` | StorageEngine | Key-value semantics |
| `list` | StorageEngine, Env | Enumerate items |
| `watch` | StorageEngine | Subscribe to changes |
| `sync` | BlockDevice | Flush to durable storage |
| `close` | Socket, Listener | Release resource |

---

## HAL Aggregate Interface

```typescript
interface HAL {
  block: BlockDevice;
  storage: StorageEngine;
  network: NetworkDevice;
  timer: TimerDevice;
  clock: ClockDevice;
  entropy: EntropyDevice;
  crypto: CryptoDevice;
  console: ConsoleDevice;
  env: EnvDevice;
  dns: DNSDevice;
  host: HostDevice;
  ipc: IPCDevice;
}
```

The kernel receives the HAL at boot:

```typescript
class Kernel {
  constructor(private hal: HAL) {}
}
```

---

## Device Interfaces

### BlockDevice

Raw byte storage with offset-based access. Used for virtual disk, swap, raw partitions.

**Bun primitives**: `Bun.file()`, `bun:sqlite` blob storage

```typescript
interface BlockDevice {
  /**
   * Read bytes from device at offset.
   * @param offset - Byte offset to start reading
   * @param size - Number of bytes to read
   * @returns Raw bytes
   */
  read(offset: number, size: number): Promise<Uint8Array>;

  /**
   * Write bytes to device at offset.
   * @param offset - Byte offset to start writing
   * @param data - Bytes to write
   */
  write(offset: number, data: Uint8Array): Promise<void>;

  /**
   * Flush pending writes to durable storage.
   */
  sync(): Promise<void>;

  /**
   * Get device metadata.
   */
  stat(): Promise<BlockStat>;
}

interface BlockStat {
  /** Total size in bytes */
  size: number;
  /** Optimal I/O block size */
  blocksize: number;
  /** True if writes are not permitted */
  readonly: boolean;
}
```

**Implementations**:
- `BunFileBlockDevice` - backed by `Bun.file()`
- `SQLiteBlockDevice` - backed by blob table in SQLite
- `S3BlockDevice` - backed by S3 object with range requests
- `MemoryBlockDevice` - backed by `ArrayBuffer` (testing)

---

### StorageEngine

Structured key-value storage with transactions and subscriptions. This is the primary data store for the VFS and application data.

**Bun primitives**: `bun:sqlite`, PostgreSQL client

```typescript
interface StorageEngine {
  /**
   * Get value by key.
   * @returns Value bytes or null if not found
   */
  get(key: string): Promise<Uint8Array | null>;

  /**
   * Store value by key.
   * Overwrites if exists.
   */
  put(key: string, value: Uint8Array): Promise<void>;

  /**
   * Delete key.
   * No error if key doesn't exist.
   */
  delete(key: string): Promise<void>;

  /**
   * List keys matching prefix.
   * @param prefix - Key prefix to match (empty string for all)
   * @yields Matching keys
   */
  list(prefix: string): AsyncIterable<string>;

  /**
   * Check if key exists without reading value.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get key metadata without reading value.
   * @returns Metadata or null if not found
   */
  stat(key: string): Promise<StorageStat | null>;

  /**
   * Begin a transaction.
   * All operations on returned Transaction are atomic.
   */
  begin(): Promise<Transaction>;

  /**
   * Watch for changes matching pattern.
   * Pattern supports * and ** globs.
   * @yields Change events
   */
  watch(pattern: string): AsyncIterable<WatchEvent>;
}

interface StorageStat {
  /** Value size in bytes */
  size: number;
  /** Last modification time (ms since epoch) */
  mtime: number;
}

interface Transaction {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface WatchEvent {
  /** Key that changed */
  key: string;
  /** Type of change */
  op: 'put' | 'delete';
  /** New value (undefined for delete) */
  value?: Uint8Array;
  /** Timestamp of change */
  timestamp: number;
}
```

**Implementations**:
- `SQLiteEngine` - embedded SQLite (standalone mode)
- `PostgresEngine` - external PostgreSQL with LISTEN/NOTIFY for watch
- `MemoryEngine` - in-memory Map (testing)

---

### NetworkDevice

TCP/UDP sockets and HTTP server. Processes access the network through this interface.

**Bun primitives**: `Bun.listen()`, `Bun.serve()`, `Bun.connect()`

```typescript
interface NetworkDevice {
  /**
   * Create a TCP listener.
   * @param port - Port to listen on
   * @param opts - Listen options
   * @returns Listener handle
   */
  listen(port: number, opts?: ListenOpts): Promise<Listener>;

  /**
   * Connect to a TCP server.
   * @param host - Hostname or IP
   * @param port - Port number
   * @param opts - Connection options
   * @returns Connected socket
   */
  connect(host: string, port: number, opts?: ConnectOpts): Promise<Socket>;

  /**
   * Create an HTTP server.
   * @param port - Port to listen on
   * @param handler - Request handler
   * @returns Server handle
   */
  serve(port: number, handler: HttpHandler): Promise<HttpServer>;
}

interface ListenOpts {
  /** Hostname to bind to (default: 0.0.0.0) */
  hostname?: string;
  /** Enable TLS */
  tls?: TlsOpts;
}

interface ConnectOpts {
  /** Connection timeout in ms */
  timeout?: number;
  /** Enable TLS */
  tls?: boolean;
}

interface TlsOpts {
  key: string;
  cert: string;
}

interface Listener {
  /** Accept next incoming connection */
  accept(): Promise<Socket>;
  /** Stop listening and close */
  close(): Promise<void>;
  /** Local address */
  addr(): { hostname: string; port: number };
}

interface Socket {
  /** Read available data (blocks until data arrives) */
  read(): Promise<Uint8Array>;
  /** Write data to socket */
  write(data: Uint8Array): Promise<void>;
  /** Close socket */
  close(): Promise<void>;
  /** Socket metadata */
  stat(): SocketStat;
}

interface SocketStat {
  remoteAddr: string;
  remotePort: number;
  localAddr: string;
  localPort: number;
}

type HttpHandler = (req: Request) => Response | Promise<Response>;

interface HttpServer {
  /** Stop server */
  close(): Promise<void>;
  /** Server address */
  addr(): { hostname: string; port: number };
}
```

**Implementations**:
- `BunNetworkDevice` - wraps Bun.listen, Bun.serve, Bun.connect

---

### TimerDevice

Timers for scheduling, delays, and watchdogs.

**Bun primitives**: `setTimeout`, `setInterval`, `Bun.sleep()`

```typescript
interface TimerDevice {
  /**
   * Sleep for duration.
   * @param ms - Milliseconds to sleep
   * @param signal - Optional abort signal for early wake
   * @throws AbortError if signal is aborted
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;

  /**
   * Call function repeatedly at interval.
   * @param ms - Interval in milliseconds
   * @param fn - Function to call
   * @returns Handle for cancellation
   */
  interval(ms: number, fn: () => void): TimerHandle;

  /**
   * Call function once after delay.
   * @param ms - Delay in milliseconds
   * @param fn - Function to call
   * @returns Handle for cancellation
   */
  timeout(ms: number, fn: () => void): TimerHandle;

  /**
   * Cancel a timer.
   * No error if already cancelled or fired.
   */
  cancel(handle: TimerHandle): void;
}

interface TimerHandle {
  /** Unique timer identifier */
  id: number;
}
```

**Implementations**:
- `BunTimerDevice` - wraps setTimeout, setInterval, Bun.sleep
- `MockTimerDevice` - fake time for testing (advance manually)

---

### ClockDevice

Wall clock and monotonic time sources.

**Bun primitives**: `Date.now()`, `Bun.nanoseconds()`

```typescript
interface ClockDevice {
  /**
   * Current wall clock time.
   * Can jump forward or backward (NTP, DST, manual changes).
   * @returns Milliseconds since Unix epoch
   */
  now(): number;

  /**
   * Monotonic time that never goes backward.
   * Use for measuring durations.
   * @returns Nanoseconds since arbitrary fixed point
   */
  monotonic(): bigint;

  /**
   * Time since OS boot.
   * @returns Milliseconds since kernel started
   */
  uptime(): number;
}
```

**Implementations**:
- `BunClockDevice` - wraps Date.now(), Bun.nanoseconds()
- `MockClockDevice` - controllable time for testing

---

### EntropyDevice

Cryptographically secure random number generation.

**Bun primitives**: `crypto.getRandomValues()`, `crypto.randomUUID()`

```typescript
interface EntropyDevice {
  /**
   * Get random bytes.
   * @param size - Number of bytes
   * @returns Cryptographically secure random bytes
   */
  read(size: number): Uint8Array;

  /**
   * Generate a UUID v4.
   * @returns UUID string (36 chars with hyphens)
   */
  uuid(): string;
}
```

**Implementations**:
- `BunEntropyDevice` - wraps crypto.getRandomValues, crypto.randomUUID
- `SeededEntropyDevice` - deterministic PRNG for testing

---

### CryptoDevice

Cryptographic operations: hashing, encryption, key derivation.

**Bun primitives**: `Bun.hash()`, `Bun.CryptoHasher`, `crypto.subtle`

```typescript
interface CryptoDevice {
  /**
   * Compute hash of data.
   * @param alg - Hash algorithm
   * @param data - Data to hash
   * @returns Hash digest
   */
  hash(alg: HashAlg, data: Uint8Array): Promise<Uint8Array>;

  /**
   * Compute HMAC of data.
   * @param alg - Hash algorithm for HMAC
   * @param key - HMAC key
   * @param data - Data to authenticate
   * @returns HMAC digest
   */
  hmac(alg: HashAlg, key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;

  /**
   * Encrypt data.
   * @param alg - Cipher algorithm
   * @param key - Encryption key
   * @param data - Plaintext
   * @returns Ciphertext (includes IV/nonce as needed)
   */
  encrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array>;

  /**
   * Decrypt data.
   * @param alg - Cipher algorithm
   * @param key - Decryption key
   * @param data - Ciphertext
   * @returns Plaintext
   */
  decrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array>;

  /**
   * Generate a cryptographic key.
   * @param alg - Key algorithm
   * @returns Generated key
   */
  genkey(alg: KeyAlg): Promise<CryptoKey>;

  /**
   * Derive key from password.
   * @param alg - KDF algorithm
   * @param password - Password bytes
   * @param salt - Salt bytes
   * @returns Derived key bytes
   */
  derive(alg: KdfAlg, password: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;
}

type HashAlg = 'sha256' | 'sha384' | 'sha512' | 'blake2b' | 'md5';
type CipherAlg = 'aes-256-gcm' | 'aes-256-cbc' | 'chacha20-poly1305';
type KeyAlg = 'aes-256' | 'rsa-2048' | 'rsa-4096' | 'ed25519' | 'x25519';
type KdfAlg = 'pbkdf2' | 'argon2id' | 'scrypt';
```

**Implementations**:
- `BunCryptoDevice` - wraps Bun.hash, Bun.CryptoHasher, crypto.subtle

---

### ConsoleDevice

Raw console I/O for kernel logging and early boot output.

**Bun primitives**: `process.stdout`, `process.stderr`, `process.stdin`

```typescript
interface ConsoleDevice {
  /**
   * Read from stdin.
   * Blocks until data available.
   * @returns Input bytes
   */
  read(): Promise<Uint8Array>;

  /**
   * Write to stdout.
   * @param data - Bytes to write
   */
  write(data: Uint8Array): void;

  /**
   * Write to stderr.
   * @param data - Bytes to write
   */
  error(data: Uint8Array): void;
}
```

**Implementations**:
- `BunConsoleDevice` - wraps process.stdin/stdout/stderr
- `BufferConsoleDevice` - captures output for testing

---

### EnvDevice

Boot-time environment variables and configuration.

**Bun primitives**: `process.env`, `Bun.env`

```typescript
interface EnvDevice {
  /**
   * Get environment variable.
   * @param key - Variable name
   * @returns Value or undefined if not set
   */
  get(key: string): string | undefined;

  /**
   * Set environment variable.
   * @param key - Variable name
   * @param value - Variable value
   */
  set(key: string, value: string): void;

  /**
   * Get all environment variables.
   * @returns Copy of environment
   */
  list(): Record<string, string>;
}
```

**Implementations**:
- `BunEnvDevice` - wraps Bun.env
- `MockEnvDevice` - isolated environment for testing

---

### DNSDevice

Domain name resolution.

**Bun primitives**: `Bun.dns`

```typescript
interface DNSDevice {
  /**
   * Resolve hostname to IP addresses.
   * @param host - Hostname to resolve
   * @returns Array of IP addresses (IPv4 and/or IPv6)
   */
  lookup(host: string): Promise<string[]>;

  /**
   * Reverse DNS lookup.
   * @param addr - IP address
   * @returns Array of hostnames
   */
  reverse(addr: string): Promise<string[]>;
}
```

**Implementations**:
- `BunDNSDevice` - wraps Bun.dns
- `MockDNSDevice` - configurable responses for testing

---

### HostDevice

Escape hatch to the host operating system. Use sparingly.

**Bun primitives**: `Bun.spawn()`, `os` module equivalents

```typescript
interface HostDevice {
  /**
   * Spawn a process on the host OS.
   * This is an escape hatch - prefer kernel-level processes.
   * @param cmd - Command to run
   * @param args - Command arguments
   * @param opts - Spawn options
   * @returns Process handle
   */
  spawn(cmd: string, args: string[], opts?: HostSpawnOpts): HostProcess;

  /**
   * Host OS platform.
   * @returns 'darwin', 'linux', or 'windows'
   */
  platform(): string;

  /**
   * Host CPU architecture.
   * @returns 'x64', 'arm64', etc.
   */
  arch(): string;

  /**
   * Host machine hostname.
   */
  hostname(): string;

  /**
   * Host system statistics.
   */
  stat(): HostStat;
}

interface HostSpawnOpts {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Stdin source */
  stdin?: 'pipe' | 'inherit' | 'ignore';
  /** Stdout destination */
  stdout?: 'pipe' | 'inherit' | 'ignore';
  /** Stderr destination */
  stderr?: 'pipe' | 'inherit' | 'ignore';
}

interface HostProcess {
  /** Process ID on host OS */
  pid: number;
  /** Write to stdin (if piped) */
  stdin?: WritableStream<Uint8Array>;
  /** Read from stdout (if piped) */
  stdout?: ReadableStream<Uint8Array>;
  /** Read from stderr (if piped) */
  stderr?: ReadableStream<Uint8Array>;
  /** Wait for process to exit */
  wait(): Promise<{ exitCode: number }>;
  /** Send signal to process */
  kill(signal?: number): void;
}

interface HostStat {
  /** Number of CPU cores */
  cpus: number;
  /** Total memory in bytes */
  memtotal: number;
  /** Free memory in bytes */
  memfree: number;
}
```

**Implementations**:
- `BunHostDevice` - wraps Bun.spawn, os module
- `MockHostDevice` - scripted responses for testing

---

### IPCDevice

Inter-process communication primitives: shared memory, message ports, synchronization.

**Bun primitives**: `SharedArrayBuffer`, `MessagePort`, `Atomics`

```typescript
interface IPCDevice {
  /**
   * Allocate shared memory buffer.
   * Can be transferred to workers for shared state.
   * @param size - Buffer size in bytes
   * @returns Shared buffer
   */
  alloc(size: number): SharedArrayBuffer;

  /**
   * Create a message port pair.
   * One end can be transferred to a worker.
   * @returns Connected port pair
   */
  port(): { a: MessagePort; b: MessagePort };

  /**
   * Create a mutex backed by shared memory.
   * @param buf - Shared buffer
   * @param offset - Byte offset for mutex state
   * @returns Mutex handle
   */
  mutex(buf: SharedArrayBuffer, offset: number): Mutex;

  /**
   * Create a semaphore backed by shared memory.
   * @param buf - Shared buffer
   * @param offset - Byte offset for semaphore state
   * @param n - Initial semaphore value
   * @returns Semaphore handle
   */
  semaphore(buf: SharedArrayBuffer, offset: number, n: number): Semaphore;

  /**
   * Create a condition variable backed by shared memory.
   * @param buf - Shared buffer
   * @param offset - Byte offset for condvar state
   * @returns Condition variable handle
   */
  condvar(buf: SharedArrayBuffer, offset: number): CondVar;
}

interface Mutex {
  /** Acquire lock (blocks until available) */
  lock(): void;
  /** Try to acquire lock without blocking */
  trylock(): boolean;
  /** Release lock */
  unlock(): void;
}

interface Semaphore {
  /** Decrement (blocks if zero) */
  wait(): void;
  /** Try to decrement without blocking */
  trywait(): boolean;
  /** Increment (wakes one waiter) */
  post(): void;
  /** Current value */
  value(): number;
}

interface CondVar {
  /** Wait for signal (must hold associated mutex) */
  wait(mutex: Mutex): void;
  /** Wait with timeout, returns false if timed out */
  timedwait(mutex: Mutex, ms: number): boolean;
  /** Wake one waiting thread */
  signal(): void;
  /** Wake all waiting threads */
  broadcast(): void;
}
```

**Implementations**:
- `BunIPCDevice` - wraps SharedArrayBuffer, MessagePort, Atomics
- `MockIPCDevice` - single-threaded simulation for testing

---

## File Structure

```
src/lib/hal/
├── index.ts          # HAL aggregate interface and types
├── block.ts          # BlockDevice implementations
├── storage.ts        # StorageEngine implementations
├── network.ts        # NetworkDevice implementations
├── timer.ts          # TimerDevice implementations
├── clock.ts          # ClockDevice implementations
├── entropy.ts        # EntropyDevice implementations
├── crypto.ts         # CryptoDevice implementations
├── console.ts        # ConsoleDevice implementations
├── env.ts            # EnvDevice implementations
├── dns.ts            # DNSDevice implementations
├── host.ts           # HostDevice implementations
├── ipc.ts            # IPCDevice implementations
└── mock/             # Mock implementations for testing
    ├── index.ts
    ├── timer.ts
    ├── clock.ts
    ├── entropy.ts
    ├── console.ts
    ├── env.ts
    ├── dns.ts
    └── host.ts
```

---

## Usage Example

```typescript
import { createBunHAL } from './hal';
import { Kernel } from './kernel';

// Production: real Bun HAL
const hal = createBunHAL({
  storage: { type: 'postgres', url: process.env.DATABASE_URL },
});
const kernel = new Kernel(hal);
await kernel.boot();

// Testing: mock HAL
import { createMockHAL } from './hal/mock';

const mockHal = createMockHAL();
mockHal.clock.set(0);  // Control time
mockHal.entropy.seed(12345);  // Deterministic randomness
const testKernel = new Kernel(mockHal);
```

---

## Bun Primitive Mapping

| HAL Device | Bun Primitive |
|------------|---------------|
| BlockDevice | `Bun.file()`, `bun:sqlite` |
| StorageEngine | `bun:sqlite`, pg client |
| NetworkDevice | `Bun.listen()`, `Bun.serve()`, `Bun.connect()` |
| TimerDevice | `setTimeout`, `setInterval`, `Bun.sleep()` |
| ClockDevice | `Date.now()`, `Bun.nanoseconds()` |
| EntropyDevice | `crypto.getRandomValues()`, `crypto.randomUUID()` |
| CryptoDevice | `Bun.hash()`, `Bun.CryptoHasher`, `crypto.subtle` |
| ConsoleDevice | `process.stdin`, `process.stdout`, `process.stderr` |
| EnvDevice | `Bun.env`, `process.env` |
| DNSDevice | `Bun.dns` |
| HostDevice | `Bun.spawn()`, `os` module |
| IPCDevice | `SharedArrayBuffer`, `MessagePort`, `Atomics` |
