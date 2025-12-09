# HAL Module

The Hardware Abstraction Layer is the lowest TypeScript layer in Monk OS, sitting directly atop Bun's runtime primitives. It provides a uniform, testable interface to all hardware resources and abstracts platform-specific details behind well-defined device interfaces.

## Philosophy

- Everything below HAL is Bun's responsibility (Workers, native APIs)
- Everything above HAL accesses hardware only through HAL interfaces
- Interfaces are swappable for testing (BunHAL vs MockHAL)
- All async operations use Promise/AsyncIterable patterns
- Errors follow POSIX conventions (ENOENT, EBADF, etc.)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Kernel / VFS / EMS                                         │
├─────────────────────────────────────────────────────────────┤
│  HAL Interface (16 device abstractions)                     │
├─────────────────────────────────────────────────────────────┤
│  BunHAL Implementation                                      │
├─────────────────────────────────────────────────────────────┤
│  Bun Runtime (Workers, native APIs)                         │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/hal/
├── index.ts              # HAL interface, BunHAL class, error re-exports
├── errors.ts             # POSIX-style error classes
├── block.ts              # BlockDevice (raw byte storage)
├── clock.ts              # ClockDevice (time sources)
├── compression.ts        # CompressionDevice (gzip/deflate)
├── console.ts            # ConsoleDevice (stdin/stdout/stderr)
├── crypto.ts             # CryptoDevice (hash, encrypt, sign)
├── dns.ts                # DNSDevice (hostname resolution)
├── entropy.ts            # EntropyDevice (random bytes, UUIDs)
├── file.ts               # FileDevice (host filesystem, kernel-only)
├── host.ts               # HostDevice (spawn native processes)
├── ipc.ts                # IPCDevice (shared memory, mutex, semaphore)
├── json.ts               # JsonDevice (JSON encoding/decoding)
├── timer.ts              # TimerDevice (setTimeout, setInterval)
├── yaml.ts               # YamlDevice (YAML encoding/decoding)
├── storage.ts            # StorageEngine barrel (re-exports storage/)
├── network.ts            # NetworkDevice barrel (re-exports network/)
├── channel.ts            # ChannelDevice barrel (re-exports channel/)
├── storage/
│   ├── types.ts          # StorageEngine, Transaction, WatchEvent
│   ├── sqlite.ts         # BunStorageEngine (SQLite)
│   ├── memory.ts         # MemoryStorageEngine
│   └── postgres.ts       # PostgresStorageEngine
├── network/
│   ├── types.ts          # NetworkDevice, Listener, Socket, HttpServer, WebSocket types
│   ├── device.ts         # BunNetworkDevice
│   ├── listener.ts       # BunListener
│   ├── socket.ts         # BunSocket
│   └── websocket-server.ts # BunWebSocketServer, BunWebSocketConnection
└── channel/
    ├── types.ts          # Channel interface
    ├── device.ts         # BunChannelDevice factory
    ├── http.ts           # HTTP client
    ├── http-server.ts    # HTTP server channel
    ├── websocket.ts      # WebSocket client
    ├── sse.ts            # Server-Sent Events
    ├── postgres.ts       # PostgreSQL wire protocol
    └── sqlite.ts         # SQLite interface
```

## Device Reference

### BlockDevice (`block.ts`)

Raw byte storage with offset-based access.

| Operation | Description |
|-----------|-------------|
| `read(offset, size)` | Read bytes at offset |
| `write(offset, data)` | Write bytes at offset |
| `sync()` | Flush to durable storage |
| `stat()` | Get device metadata |
| `writelock(offset, size)` | Acquire advisory write lock |

**Implementations:** `BunBlockDevice` (file-backed), `MemoryBlockDevice` (ephemeral)

---

### StorageEngine (`storage/`)

Structured key-value store with ACID transactions.

| Operation | Description |
|-----------|-------------|
| `get(key)` | Retrieve value by key |
| `put(key, value)` | Store key-value pair |
| `delete(key)` | Remove key |
| `list(prefix)` | Enumerate keys with prefix |
| `exists(key)` | Check existence |
| `begin()` | Start transaction |
| `watch(pattern)` | Subscribe to changes |
| `close()` | Shutdown storage |

**Implementations:** `BunStorageEngine` (SQLite), `MemoryStorageEngine`, `PostgresStorageEngine`

---

### NetworkDevice (`network/`)

TCP/HTTP networking with WebSocket support.

| Operation | Description |
|-----------|-------------|
| `listen(port, opts?)` | Create TCP server listener |
| `connect(host, port, opts?)` | Establish TCP client connection |
| `serve(port, handler, opts?)` | Start HTTP server (with optional WebSocket upgrade) |
| `listenWebSocket(port, opts?)` | Create WebSocket server with accept pattern |

**Sub-interfaces:**
- `Listener` - Accept connections (`accept()`, `close()`)
- `Socket` - Bidirectional byte stream (`read()`, `write()`, `close()`)
- `HttpServer` - HTTP request/response handling
- `WebSocketServer` - WebSocket server with accept pattern
- `WebSocketConnection` - WebSocket client connection

---

### TimerDevice (`timer.ts`)

Time-based scheduling and delays.

| Operation | Description |
|-----------|-------------|
| `sleep(ms, signal?)` | Async sleep with cancellation |
| `timeout(ms, callback)` | Schedule one-time callback |
| `interval(ms, callback)` | Schedule repeating callback |
| `cancel(handle)` | Cancel specific timer |
| `cancelAll()` | Cancel all active timers |

**Implementations:** `BunTimerDevice`, `MockTimerDevice`

---

### ClockDevice (`clock.ts`)

Time sources.

| Operation | Description |
|-----------|-------------|
| `now()` | Wall clock time (Date.now()) |
| `monotonic()` | Monotonic nanoseconds (never decreases) |
| `uptime()` | Time since HAL initialization |

**Implementations:** `BunClockDevice`, `MockClockDevice`

---

### EntropyDevice (`entropy.ts`)

Cryptographically secure random generation.

| Operation | Description |
|-----------|-------------|
| `read(size)` | Get secure random bytes |
| `uuid()` | Generate RFC 9562 UUID v7 (timestamp-sortable) |

**Implementations:** `BunEntropyDevice`, `SeededEntropyDevice`

---

### CryptoDevice (`crypto.ts`)

Cryptographic operations.

| Operation | Description |
|-----------|-------------|
| `hash(alg, data)` | Compute hash (SHA-256, SHA-384, SHA-512, SHA-1, MD5, BLAKE2b) |
| `encrypt(alg, key, data)` | Encrypt data (AES-256-GCM, AES-256-CBC, AES-128-GCM) |
| `decrypt(alg, key, data)` | Decrypt data |
| `sign(alg, key, data)` | Create signature |
| `verify(alg, key, data, sig)` | Verify signature |
| `generateKey(alg)` | Generate cryptographic key |
| `deriveKey(alg, password, salt)` | Derive key (PBKDF2-SHA256, Argon2id) |

**Implementations:** `BunCryptoDevice`

---

### ConsoleDevice (`console.ts`)

stdin/stdout/stderr interaction.

| Operation | Description |
|-----------|-------------|
| `read(size)` | Read from stdin |
| `readline()` | Read line from stdin |
| `write(data)` | Write to stdout |
| `error(data)` | Write to stderr |
| `isTTY()` | Check if terminal |

**Implementations:** `BunConsoleDevice`, `BufferConsoleDevice`

---

### DNSDevice (`dns.ts`)

Hostname resolution.

| Operation | Description |
|-----------|-------------|
| `lookup(hostname)` | Forward lookup (IPv4 + IPv6) |
| `lookup4(hostname)` | Forward IPv4 only |
| `lookup6(hostname)` | Forward IPv6 only |
| `reverse(ip)` | Reverse lookup |

**Implementations:** `BunDNSDevice`, `MockDNSDevice`

---

### HostDevice (`host.ts`)

Escape hatch to host operating system.

| Operation | Description |
|-----------|-------------|
| `spawn(cmd, opts)` | Spawn native process |
| `exec(cmd)` | Run command and collect output |
| `platform()` | OS (linux, darwin, win32) |
| `arch()` | CPU architecture |
| `hostname()` | System hostname |
| `stat()` | Memory/CPU statistics |

**Warning:** Security-sensitive. Command injection risk if input untrusted.

**Implementations:** `BunHostDevice`, `MockHostDevice`

---

### IPCDevice (`ipc.ts`)

Inter-process communication and synchronization.

| Operation | Description |
|-----------|-------------|
| `createSharedMemory(size)` | Create shared buffer |
| `createMessagePort()` | Create message channel |
| `createMutex(buf, offset)` | Create mutual exclusion lock |
| `createSemaphore(buf, offset, value)` | Create counting semaphore |
| `createCondVar(buf, offset)` | Create condition variable |

**Note:** `Atomics.wait()` only works from Workers (not main thread).

**Implementations:** `BunIPCDevice`, `MockIPCDevice`

---

### ChannelDevice (`channel/`)

Protocol-aware bidirectional message exchange.

| Protocol | Description |
|----------|-------------|
| HTTP/HTTPS | Request/response via fetch() |
| HTTP Server | Server-side request handling |
| WebSocket | Full-duplex client connection |
| SSE | Server-Sent Events |
| PostgreSQL | Query/result pattern |
| SQLite | Database interface |

**Operations:** `open(uri, proto, opts)` returns `Channel` with `exec(msg)` method

**Implementations:**
- `BunChannelDevice` - Factory for creating channels
- `BunHttpChannel` - HTTP client
- `BunHttpServerChannel` - HTTP server
- `BunWebSocketClientChannel` - WebSocket client
- `BunSSEServerChannel` - Server-Sent Events
- `BunPostgresChannel` - PostgreSQL
- `BunSqliteChannel` - SQLite

---

### CompressionDevice (`compression.ts`)

Data compression/decompression.

| Operation | Description |
|-----------|-------------|
| `compress(alg, data, level?)` | Compress data (gzip, deflate) |
| `decompress(alg, data)` | Decompress data |

**Note:** Synchronous operations. Suitable for data <10MB.

**Implementations:** `BunCompressionDevice`, `MockCompressionDevice`

---

### FileDevice (`file.ts`)

Host filesystem access (kernel use only).

| Operation | Description |
|-----------|-------------|
| `read(path)` | Read entire file |
| `readText(path)` | Read as UTF-8 string |
| `stat(path)` | Get file metadata |

**Warning:** Kernel-only. For user-space file I/O, use VFS.

**Implementations:** `BunFileDevice`, `MockFileDevice`

---

### JsonDevice (`json.ts`) / YamlDevice (`yaml.ts`)

Encoding/decoding utilities.

| Operation | Description |
|-----------|-------------|
| `parse(text)` | Parse string to object |
| `stringify(value)` | Serialize object to string |

**Implementations:**
- JSON: `BunJsonDevice`, `MockJsonDevice`
- YAML: `BunYamlDevice`, `MockYamlDevice`

## HAL Interface

```typescript
interface HAL {
    readonly block: BlockDevice;
    readonly storage: StorageEngine;
    readonly network: NetworkDevice;
    readonly timer: TimerDevice;
    readonly clock: ClockDevice;
    readonly entropy: EntropyDevice;
    readonly crypto: CryptoDevice;
    readonly console: ConsoleDevice;
    readonly dns: DNSDevice;
    readonly host: HostDevice;
    readonly ipc: IPCDevice;
    readonly channel: ChannelDevice;
    readonly compression: CompressionDevice;
    readonly file: FileDevice;
    readonly json: JsonDevice;
    readonly yaml: YamlDevice;

    init(): Promise<void>;
    shutdown(): Promise<void>;
}
```

## Configuration

```typescript
interface HALConfig {
    blockPath?: string;  // Block device storage path
    storage?: {
        type: 'memory' | 'sqlite' | 'postgres';
        path?: string;    // sqlite only
        url?: string;     // postgres only
    }
}
```

## Error Handling

All errors extend `HALError` with POSIX-style codes:

**File/Block I/O:**
`EACCES`, `EAGAIN`, `EBADF`, `EBUSY`, `EEXIST`, `EFAULT`, `EFBIG`, `EINVAL`, `EIO`, `EISDIR`, `EMFILE`, `ENAMETOOLONG`, `ENOENT`, `ENOSPC`, `ENOTDIR`, `ENOTEMPTY`, `EPERM`, `EROFS`

**Network:**
`EADDRINUSE`, `EADDRNOTAVAIL`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTCONN`, `EPIPE`

**Process/IPC:**
`ECANCELED`, `EDEADLK`, `EINTR`, `ECHILD`, `ESRCH`

**Crypto:**
`EAUTH` (authentication/verification failed)

**General:**
`ENOSYS`, `ENOTSUP`, `EOVERFLOW`, `ERANGE`

**Helper Functions:**
- `isHALError(err)` - Type guard
- `hasErrorCode(err, code)` - Code matching
- `fromSystemError(err)` - Map Bun/Node errors
- `fromCode(code, message)` - Create from strings

## Lifecycle

```typescript
const hal = new BunHAL(config);
await hal.init();      // Initialize all devices
// ... use devices ...
await hal.shutdown();  // Cleanup (cancels timers, closes storage)
```

Both `init()` and `shutdown()` are idempotent.
