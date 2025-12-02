# Bun Primitives in Monk OS

This document tracks Bun runtime primitives used by Monk OS and opportunities for enhancement.

## Philosophy

Monk OS treats **Bun as hardware**. The HAL wraps Bun primitives to provide swappable, testable
interfaces. This document ensures we leverage Bun's capabilities fully.

---

## Current Implementations

### File I/O
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `Bun.file()` | BlockDevice | Read file handles |
| `Bun.write()` | BlockDevice | Write file contents |

### Storage
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `bun:sqlite` | StorageEngine | Key-value storage, subscriptions |
| `Bun.sql()` | StorageEngine | PostgreSQL (stub only) |

### Network
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `Bun.listen()` | NetworkDevice | TCP server |
| `Bun.connect()` | NetworkDevice | TCP client |
| `Bun.serve()` | NetworkDevice | HTTP server |
| `Bun.udpSocket()` | NetworkDevice | UDP sockets |

### Crypto
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `Bun.CryptoHasher` | CryptoDevice | Streaming hash |
| `Bun.hash()` | CryptoDevice | One-shot hash |
| `Bun.password.hash()` | CryptoDevice | Argon2/bcrypt |
| `Bun.password.verify()` | CryptoDevice | Password verification |
| `crypto.subtle` | CryptoDevice | Encrypt/decrypt/sign |

### Process & Host
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `Bun.spawn()` | HostDevice | Execute host commands |
| `Bun.spawnSync()` | HostDevice | Synchronous execution |
| `Worker` | IPCDevice | Process isolation |
| `SharedArrayBuffer` | IPCDevice | Shared memory |
| `Atomics` | IPCDevice | Synchronization |
| `MessageChannel` | IPCDevice | Message passing |

### Time & Entropy
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `Bun.sleep()` | TimerDevice | Async sleep |
| `Bun.nanoseconds()` | ClockDevice | Monotonic time |
| `Date.now()` | ClockDevice | Wall clock |
| `crypto.getRandomValues()` | EntropyDevice | Random bytes |

### DNS & Console
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `Bun.dns.lookup()` | DNSDevice | Name resolution |
| `Bun.stdin` | ConsoleDevice | Standard input |
| `process.stdout` | ConsoleDevice | Standard output |
| `process.stderr` | ConsoleDevice | Standard error |

### Compression
| Primitive | HAL Device | Usage |
|-----------|------------|-------|
| `Bun.gzipSync()` | CompressionDevice | Gzip compress |
| `Bun.gunzipSync()` | CompressionDevice | Gzip decompress |
| `Bun.deflateSync()` | CompressionDevice | Deflate compress |
| `Bun.inflateSync()` | CompressionDevice | Deflate decompress |

---

## Recommendations

### High Priority

#### 1. Compression Device
**Primitives:** `Bun.gzipSync()`, `Bun.gunzipSync()`, `Bun.deflateSync()`, `Bun.inflateSync()`

**Status:** DONE - Implemented in `src/hal/compression.ts`

```typescript
interface CompressionDevice {
    compress(alg: 'gzip' | 'deflate', data: Uint8Array, opts?: { level?: 0-9 }): Uint8Array;
    decompress(alg: 'gzip' | 'deflate', data: Uint8Array): Uint8Array;
    gzip(data: Uint8Array, opts?): Uint8Array;
    gunzip(data: Uint8Array): Uint8Array;
    deflate(data: Uint8Array, opts?): Uint8Array;
    inflate(data: Uint8Array): Uint8Array;
}
```

**Use cases:**
- Compressed VFS storage
- Network transfer encoding
- Log rotation / archival
- Backup/export optimization

#### 2. Native Glob Matching
**Primitive:** `Bun.Glob`

**Status:** Limited usefulness - host filesystem only

`Bun.Glob` has two modes:
- `glob.match(path)` - Pure pattern matching (usable)
- `glob.scan(dir)` - File system scanning (host FS only, unusable for VFS)

**Limitation:** The VFS is an in-memory abstraction backed by SQLite/PostgreSQL,
not the host filesystem. `Bun.Glob.scan()` cannot walk the VFS.

**Potential use case:** HostMount / LocalMount that exposes host filesystem paths
could benefit from `Bun.Glob.scan()` for efficient directory traversal.

**Current approach:** Userspace `rom/lib/glob.ts` provides pure pattern matching.
Shell does `readdir()` + filter with `glob.match()`. This works with the VFS.

**Minor optimization:** Could replace manual regex in `src/hal/storage.ts:339-346`
with `Bun.Glob.match()` for pattern matching, but low priority.

**Complexity:** N/A (not recommended for kernel/VFS)

#### 3. Memory-Mapped Files
**Primitive:** `Bun.mmap()`

**Status:** Limited usefulness - host filesystem only

**Limitation:** Like `Bun.Glob`, `Bun.mmap()` operates on the host filesystem,
not the VFS. The VFS is backed by SQLite/PostgreSQL storage.

Additionally, the VFS already streams chunks, supporting effectively infinite
file sizes. mmap requires the entire file to fit in virtual address space.

**Potential use cases:**
- Inter-worker shared memory (but `SharedArrayBuffer` already exists in IPCDevice)
- HostMount/LocalMount for host filesystem access

**Not recommended:** No clear use case for kernel/VFS at this time.

**Complexity:** N/A

### Medium Priority

#### 4. Bun Transpiler
**Primitive:** `Bun.Transpiler`

**Current:** Loader in `src/kernel/loader.ts` does import rewriting but not full transpilation.

```typescript
const transpiler = new Bun.Transpiler({
    loader: 'ts',
    target: 'bun'
});

const result = transpiler.transformSync(code);
const imports = transpiler.scanImports(code);
```

**Use cases:**
- Execute TypeScript from VFS without pre-compilation
- Analyze module dependencies
- Runtime code transformation

**Complexity:** Medium

#### 5. Efficient Buffer Building
**Primitive:** `Bun.ArrayBufferSink`

**Status:** Not needed

**Why:** Monk OS uses a Response-based streaming protocol (see `planning/OS_STREAMS.md`):
- All syscalls return `AsyncIterable<Response>`
- Built-in backpressure via ping/ack with high/low water marks
- Bun handles socket buffering internally via `socket.write()`

There's no manual buffer building to optimize. The streams architecture handles
backpressure at the protocol level, not the byte level.

**Complexity:** N/A

#### 6. PostgreSQL Storage Engine
**Primitive:** `Bun.sql()`

**Current:** Stub only in `src/hal/index.ts:192`

```typescript
const db = Bun.sql`postgres://localhost/monk`;
const rows = await db`SELECT * FROM entities WHERE id = ${id}`;
```

**Benefits:** Production-grade storage, connection pooling, SQL injection safety

**Complexity:** Medium

### Low Priority

#### 7. Redis Integration
**Primitive:** `Bun.redis`

```typescript
const redis = Bun.redis();
await redis.set('key', 'value');
await redis.publish('channel', message);
```

**Use cases:** Caching, pub/sub messaging, session storage, rate limiting

**Complexity:** Easy

#### 8. S3 Storage
**Primitive:** `Bun.S3Client`, `Bun.s3()`

```typescript
const file = Bun.s3('s3://bucket/path/to/file');
const content = await file.text();
await Bun.write(file, newContent);
```

**Use cases:** Cloud storage backend, backup, distributed VFS mount

**Complexity:** Medium

#### 9. Promise Inspection
**Primitive:** `Bun.peek()`

```typescript
const state = Bun.peek(promise); // Returns value if resolved, promise if pending
const status = Bun.peek.status(promise); // 'fulfilled' | 'rejected' | 'pending'
```

**Use cases:** Non-blocking I/O checks, scheduler optimization, debugging

**Complexity:** Easy

#### 10. Foreign Function Interface
**Primitive:** `Bun.FFI`

```typescript
const lib = Bun.dlopen('libfoo.so', {
    add: { args: ['i32', 'i32'], returns: 'i32' }
});
const result = lib.symbols.add(1, 2);
```

**Use cases:** Hardware drivers, native libraries, performance-critical code

**Complexity:** Hard

---

## New Device Ideas

### CompressionDevice
**Status:** Not implemented
**Primitives:** gzip, deflate, zlib
**Priority:** High

Syscalls:
- `compress(algorithm, data, options?) → Uint8Array`
- `decompress(algorithm, data) → Uint8Array`

### TranspilerDevice
**Status:** Not implemented
**Primitives:** Bun.Transpiler
**Priority:** Medium

Syscalls:
- `transpile(code, options?) → string`
- `scanImports(code) → Import[]`

### MmapDevice
**Status:** Not implemented
**Primitives:** Bun.mmap
**Priority:** High

Syscalls:
- `mmap(path, options?) → fd`
- `munmap(fd) → void`

### RedisDevice
**Status:** Not implemented
**Primitives:** Bun.redis
**Priority:** Low

Could integrate with existing pub/sub port type or be standalone cache.

### S3Device
**Status:** Not implemented
**Primitives:** Bun.S3Client
**Priority:** Low

Could be a VFS mount type for cloud storage.

---

## Code Improvement Targets

| File | Lines | Issue | Solution | Status |
|------|-------|-------|----------|--------|
| `src/hal/storage.ts` | 339-346 | Manual glob regex | `Bun.Glob.match()` | Low priority (VFS limitation) |
| `src/hal/block.ts` | 177-231 | Read-modify-write | `Bun.mmap()` | N/A (host FS only) |
| `src/hal/network.ts` | 508-518 | N/A | `ArrayBufferSink` | Not needed (Bun handles internally) |
| `src/hal/crypto.ts` | 170-187 | Missing algorithms | Add blake2b256, md5 | Pending |
| `src/hal/dns.ts` | 84-112 | No caching | Add TTL cache | Pending |
| `src/hal/index.ts` | 192 | PostgreSQL stub | `Bun.sql()` | Pending |

---

## Utilization Summary

| Category | Used | Available | Coverage |
|----------|------|-----------|----------|
| File I/O | 2 | 2 | 100% |
| Memory Map | 0 | 1 | N/A (host FS only) |
| Storage | 1 | 4 (+ pg, mysql, redis) | 25% |
| Compression | 3 | 3 | 100% |
| Pattern Matching | 0 | 1 | N/A (host FS only) |
| Transpilation | 0 | 1 | 0% |
| Cloud | 0 | 1 | 0% |
| Buffering | 0 | 1 | N/A (streams architecture) |
| Native Code | 0 | 1 | 0% |

**Overall:** ~40% of applicable Bun capabilities leveraged (excluding host-FS-only primitives)

---

## References

- [Bun API Reference](https://bun.sh/docs/api)
- [Bun.mmap](https://bun.sh/docs/api/mmap)
- [Bun.Glob](https://bun.sh/docs/api/glob)
- [Bun Compression](https://bun.sh/docs/api/utils#bun-gzipsync)
- [Bun.Transpiler](https://bun.sh/docs/api/transpiler)
- [Bun SQL](https://bun.sh/docs/api/sql)
