# Streams-First File Descriptors

Extending the streams-first architecture to file descriptor operations, and unifying the I/O model around Message/Response.

## Implementation Status

**Status: PLANNED**

## Overview

With the streams-first syscall architecture in place (see [OS_STREAMS.md](./OS_STREAMS.md)), file descriptor operations should follow the same pattern. Instead of `read()` returning a single buffer, it streams chunks until EOF. This aligns file I/O with the rest of the OS and enables memory-efficient processing of large files.

## Unified Handle Architecture

### The Problem

Currently Monk OS has three separate I/O primitives:

| Primitive | Table | Operations | Internal Protocol |
|-----------|-------|------------|-------------------|
| fd | `proc.fds` | `read()`, `write()`, `seek()` | `AsyncIterable<Response>` |
| portId | `proc.ports` | `recv()`, `send()` | `AsyncIterable<Response>` |
| channelId | `proc.channels` | `call()`, `stream()` | `AsyncIterable<Response>` |

All three use `Message`/`Response` internally, but expose different APIs and use separate resource tables.

### The Solution

Unify at the kernel level while preserving ergonomic userspace APIs:

```
┌─────────────────────────────────────────────────────────────┐
│  Userspace API (ergonomic, typed)                           │
│                                                             │
│  read(fd) → AsyncIterable<Uint8Array>                       │
│  http.get('/users') → Promise<User[]>                       │
│  db.query('SELECT...') → Promise<Row[]>                     │
│  copy(src, dst) → Promise<number>                           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Library Layer (hides Message/Response)                     │
│                                                             │
│  read() sends { op: 'read' }, unwraps chunks                │
│  http.get() sends { op: 'request' }, unwraps response       │
│  db.query() sends { op: 'query' }, collects rows            │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Kernel (unified handle + Message/Response protocol)        │
│                                                             │
│  All handles: send(Message) → AsyncIterable<Response>       │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  VFS / HAL (already Message/Response)                       │
│                                                             │
│  Model.handle(msg) → AsyncIterable<Response>                │
│  Channel.handle(msg) → AsyncIterable<Response>              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### VFS Already Uses This Pattern

VFS Models are already message-based:

```typescript
// src/vfs/model.ts
interface MessageModel {
    handle(ctx: ModelContext, id: string, msg: Message): AsyncIterable<Response>;
}
```

POSIX-style operations (`open`, `read`, `write`) are adaptations on top of the message interface.

### Unified Handle Type

```typescript
// Kernel-level handle (internal)
interface Handle {
    /** Handle type for dispatch */
    readonly type: 'file' | 'socket' | 'pipe' | 'channel' | 'port';

    /** Send message, receive streaming response */
    send(msg: Message): AsyncIterable<Response>;

    /** Close and release resources */
    close(): Promise<void>;
}
```

### Message Operations by Handle Type

| Handle Type | Supported Ops | Response Pattern |
|-------------|---------------|------------------|
| file | `read`, `write`, `seek`, `stat` | `chunk*` → `done` |
| socket | `read`, `write`, `stat` | `chunk*` → `done` |
| pipe | `read`, `write` | `chunk*` → `done` |
| channel | `request`, `query`, `subscribe`, etc. | varies by protocol |
| port | `recv` | `item*` → (blocks) |

### Benefits

1. **Single resource table** - One `proc.handles` instead of three tables
2. **Uniform limits** - One `MAX_HANDLES` instead of separate limits
3. **Handle passing** - Pass any handle between processes uniformly
4. **Universal `open()`** - `open('/path')`, `open('postgres://...')`, `open('https://...')`
5. **Consistent lifecycle** - All handles closed the same way

### Userspace API Unchanged

The unification is internal. Userspace still writes:

```typescript
// File operations (convenience wrappers)
const data = await readAll(fd);
for await (const line of readLines(fd)) { ... }

// HTTP operations (library wrapper)
const users = await http.get<User[]>('/users');

// Database operations (library wrapper)
const rows = await db.query<Row>('SELECT * FROM users');
```

The `Message`/`Response` protocol is hidden - an implementation detail.

### Historical Context

This pattern has precedent in several operating systems:

| OS | Era | Primitive | Notes |
|----|-----|-----------|-------|
| BeOS/Haiku | 1995 | BMessage | Universal typed message passing |
| QNX | 1982 | MsgSend/Receive | All I/O is message passing |
| Plan 9 | 1992 | 9P protocol | Files are Tmsg/Rmsg endpoints |
| Fuchsia | 2016 | Channels + FIDL | Capability handles with typed messages |
| **Monk OS** | 2024 | Handle + Message/Response | Unified streaming I/O |

Fuchsia is the closest modern analog - capability-based handles with schema-defined messages, hiding the protocol behind client libraries.

## Philosophy

**Streams are primary. Buffers are derived.**

- `read()` yields chunks → natural for large files, pipes, network
- `readAll()` collects chunks → convenience for small files
- `readLines()` yields lines → natural for text processing
- `readText()` collects as string → convenience for config files

This mirrors the existing pattern:
- `syscall()` yields `Response` objects (primary)
- `call()` unwraps single value (convenience)
- `collect()` gathers items into array (convenience)

## API Changes

### Read Operations

| Function | Signature | Description |
|----------|-----------|-------------|
| `read` | `(fd: number, chunkSize?: number) → AsyncIterable<Uint8Array>` | Stream chunks until EOF |
| `readAll` | `(fd: number) → Promise<Uint8Array>` | Collect all chunks into single buffer |
| `readLines` | `(fd: number) → AsyncIterable<string>` | Stream lines (text files) |
| `readText` | `(fd: number) → Promise<string>` | Read entire file as string |

### Directory Operations

| Function | Signature | Description |
|----------|-----------|-------------|
| `readdir` | `(path: string) → AsyncIterable<string>` | Stream directory entries |
| `readdirAll` | `(path: string) → Promise<string[]>` | Collect all entries into array |

### Copy Operations

| Function | Signature | Description |
|----------|-----------|-------------|
| `copy` | `(srcFd: number, dstFd: number) → Promise<number>` | Stream data between fds, return bytes |
| `copyFile` | `(srcPath: string, dstPath: string) → Promise<number>` | Open, copy, close both |

### Convenience Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `readFile` | `(path: string, maxSize?) → Promise<string>` | Open, read text, close |
| `readFileBytes` | `(path: string, maxSize?) → Promise<Uint8Array>` | Open, read binary, close |
| `writeFile` | `(path: string, content: string) → Promise<void>` | Open, write, close |

### Removed/Changed

| Old | New | Notes |
|-----|-----|-------|
| `read(fd, size?)` returning `Promise<Uint8Array>` | `read(fd, chunkSize?)` returning `AsyncIterable<Uint8Array>` | `size` repurposed as chunk size hint |
| `readdirStream(path)` | `readdir(path)` | Streaming is now the default |
| `readdir(path)` returning `Promise<string[]>` | `readdirAll(path)` | Explicit collection |

## Usage Examples

### Streaming Large Files

```typescript
import { open, read, close } from '/lib/process';

const fd = await open('/var/log/app.log', { read: true });

for await (const chunk of read(fd)) {
    await processChunk(chunk);
}

await close(fd);
```

### Reading Small Files

```typescript
import { open, readAll, close } from '/lib/process';

const fd = await open('/etc/config.json', { read: true });
const data = await readAll(fd);
const config = JSON.parse(new TextDecoder().decode(data));
await close(fd);

// Or use convenience function
import { readFile } from '/lib/process';
const config = JSON.parse(await readFile('/etc/config.json'));
```

### Line-by-Line Processing

```typescript
import { open, readLines, close } from '/lib/process';

const fd = await open('/var/log/access.log', { read: true });

for await (const line of readLines(fd)) {
    const [timestamp, method, path, status] = line.split(' ');
    if (status === '500') {
        console.log(`Error at ${timestamp}: ${method} ${path}`);
    }
}

await close(fd);
```

### Directory Listing

```typescript
import { readdir, readdirAll } from '/lib/process';

// Stream entries (memory efficient for large directories)
for await (const name of readdir('/home/user/documents')) {
    console.log(name);
}

// Collect all (convenient for small directories)
const entries = await readdirAll('/etc');
console.log(`Found ${entries.length} entries`);
```

### Copying Data

```typescript
import { open, copy, copyFile, close } from '/lib/process';

// Copy between open file descriptors
const src = await open('/data/input.bin', { read: true });
const dst = await open('/data/output.bin', { write: true, create: true });
const bytes = await copy(src, dst);
await close(src);
await close(dst);

// Or use convenience function (opens, copies, closes)
const bytes = await copyFile('/data/input.bin', '/data/output.bin');
```

## Implementation

### Userspace Library

```typescript
// rom/lib/process.ts

// ============================================================================
// Streaming File Operations
// ============================================================================

/**
 * Stream chunks from a file descriptor until EOF.
 *
 * @param fd - File descriptor to read from
 * @param chunkSize - Optional hint for chunk size (kernel may ignore)
 */
export function read(fd: number, chunkSize?: number): AsyncIterable<Uint8Array> {
    return iterate<Uint8Array>('read', fd, chunkSize);
}

const DEFAULT_MAX_READ = 10 * 1024 * 1024;      // 10MB
const DEFAULT_MAX_ENTRIES = 10_000;              // 10k directory entries

/**
 * Read entire file descriptor contents into a single buffer.
 *
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readAll(fd: number, maxSize: number = DEFAULT_MAX_READ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of read(fd)) {
        total += chunk.length;
        if (total > maxSize) {
            throw new SyscallError('EFBIG', `Read exceeded ${maxSize} bytes`);
        }
        chunks.push(chunk);
    }

    // Fast path: single chunk
    if (chunks.length === 1) {
        return chunks[0];
    }

    // Concatenate chunks
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

/**
 * Stream lines from a text file.
 * Each yielded string is one line without the newline character.
 */
export async function* readLines(fd: number): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of read(fd)) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
            yield line;
        }
    }

    // Flush remaining buffer (file without trailing newline)
    buffer += decoder.decode(); // Flush decoder
    if (buffer) {
        yield buffer;
    }
}

/**
 * Read entire file descriptor contents as a string.
 *
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readText(fd: number, maxSize: number = DEFAULT_MAX_READ): Promise<string> {
    const data = await readAll(fd, maxSize);
    return new TextDecoder().decode(data);
}

// ============================================================================
// Streaming Directory Operations
// ============================================================================

/**
 * Stream directory entries.
 */
export function readdir(path: string): AsyncIterable<string> {
    return iterate<string>('readdir', path);
}

/**
 * Read all directory entries into an array.
 *
 * @param maxEntries - Maximum entries to read (default 10k, kernel limit 100k)
 */
export async function readdirAll(path: string, maxEntries: number = DEFAULT_MAX_ENTRIES): Promise<string[]> {
    const entries: string[] = [];
    for await (const entry of readdir(path)) {
        if (entries.length >= maxEntries) {
            throw new SyscallError('EFBIG', `Directory listing exceeded ${maxEntries} entries`);
        }
        entries.push(entry);
    }
    return entries;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Read entire file as string. Opens, reads, and closes.
 *
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readFile(path: string, maxSize: number = DEFAULT_MAX_READ): Promise<string> {
    const fd = await open(path, { read: true });
    try {
        return await readText(fd, maxSize);
    } finally {
        await close(fd);
    }
}

/**
 * Read entire file as bytes. Opens, reads, and closes.
 *
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readFileBytes(path: string, maxSize: number = DEFAULT_MAX_READ): Promise<Uint8Array> {
    const fd = await open(path, { read: true });
    try {
        return await readAll(fd, maxSize);
    } finally {
        await close(fd);
    }
}

/**
 * Write string to file. Opens, writes, and closes.
 */
export async function writeFile(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, truncate: true });
    try {
        await write(fd, new TextEncoder().encode(content));
    } finally {
        await close(fd);
    }
}

/**
 * Copy data from one file descriptor to another.
 * Streams chunks to avoid memory issues with large files.
 *
 * @returns Total bytes copied
 */
export async function copy(srcFd: number, dstFd: number): Promise<number> {
    let total = 0;
    for await (const chunk of read(srcFd)) {
        await write(dstFd, chunk);
        total += chunk.length;
    }
    return total;
}

/**
 * Copy a file from source path to destination path.
 * Opens both files, copies data, and closes both.
 *
 * @returns Total bytes copied
 */
export async function copyFile(srcPath: string, dstPath: string): Promise<number> {
    const src = await open(srcPath, { read: true });
    try {
        const dst = await open(dstPath, { write: true, create: true, truncate: true });
        try {
            return await copy(src, dst);
        } finally {
            await close(dst);
        }
    } finally {
        await close(src);
    }
}
```

### Kernel Syscall Handler

```typescript
// src/kernel/syscalls.ts

const DEFAULT_CHUNK_SIZE = 65536; // 64KB

async *read(proc: Process, fd: unknown, chunkSize?: unknown): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = getHandle(proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    const size = typeof chunkSize === 'number' ? chunkSize : DEFAULT_CHUNK_SIZE;

    try {
        while (true) {
            const chunk = await handle.read(size);

            // EOF
            if (chunk.length === 0) {
                break;
            }

            yield respond.item(chunk);

            // Short read indicates EOF
            if (chunk.length < size) {
                break;
            }
        }

        yield respond.done();
    } catch (err) {
        yield respond.error('EIO', (err as Error).message);
    }
}

const MAX_STREAM_ENTRIES = 100_000;  // 100k entries hard cap

async *readdir(proc: Process, path: unknown): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    let count = 0;

    try {
        for await (const name of vfs.list(path, proc.id)) {
            count++;
            if (count > MAX_STREAM_ENTRIES) {
                yield respond.error('EFBIG', `Directory listing exceeded ${MAX_STREAM_ENTRIES} entries`);
                return;
            }
            yield respond.item(name);
        }
        yield respond.done();
    } catch (err) {
        yield respond.error('ENOENT', (err as Error).message);
    }
}
```

## Memory Safety

### Two-Layer Protection

| Layer | Limit | Purpose |
|-------|-------|---------|
| Kernel | `MAX_STREAM_BYTES` (100MB) | Hard cap, protects system stability |
| Userspace | `maxSize` parameter (10MB default) | Fail fast, protects application |

### Kernel Enforcement

The kernel enforces a hard limit on total bytes yielded per read stream:

```typescript
// src/kernel/types.ts
const MAX_STREAM_BYTES = 100 * 1024 * 1024;  // 100MB hard cap

// src/kernel/syscalls.ts
async *read(proc: Process, fd: unknown, chunkSize?: unknown): AsyncIterable<Response> {
    // ... validation ...

    let totalYielded = 0;

    while (true) {
        const chunk = await handle.read(size);
        if (chunk.length === 0) break;

        totalYielded += chunk.length;
        if (totalYielded > MAX_STREAM_BYTES) {
            yield respond.error('EFBIG', `Read stream exceeded ${MAX_STREAM_BYTES} bytes`);
            return;
        }

        yield respond.item(chunk);
    }
    yield respond.done();
}
```

This protects against:
- Malicious userspace passing `Infinity` to `readAll()`
- Buggy code reading from infinite sources (`/dev/zero`, endless pipes)
- Worker OOM destabilizing the kernel process

### Userspace Convenience Limits

Userspace collection functions have a lower default limit for fast failure:

```typescript
// rom/lib/process.ts
const DEFAULT_MAX_READ = 10 * 1024 * 1024;  // 10MB default

export async function readAll(fd: number, maxSize: number = DEFAULT_MAX_READ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of read(fd)) {
        total += chunk.length;
        if (total > maxSize) {
            throw new SyscallError('EFBIG', `Read exceeded ${maxSize} bytes`);
        }
        chunks.push(chunk);
    }

    // ... concatenate ...
}
```

### Collection Function Limits

| Function | Default Limit | Kernel Limit |
|----------|---------------|--------------|
| `readAll(fd, maxSize?)` | 10MB | 100MB |
| `readText(fd, maxSize?)` | 10MB | 100MB |
| `readFileBytes(path, maxSize?)` | 10MB | 100MB |
| `readFile(path, maxSize?)` | 10MB | 100MB |
| `readdirAll(path, maxEntries?)` | 10,000 entries | 100,000 entries |

### Opting Out (With Caution)

```typescript
// Read up to kernel limit (use with caution)
const data = await readAll(fd, Infinity);

// This will fail at 100MB with EFBIG from kernel
// Userspace cannot bypass kernel limit
```

### Streaming Bypasses Limits

The limits only apply to collection functions. Streaming is unbounded:

```typescript
// No limit - caller controls memory via iteration
for await (const chunk of read(fd)) {
    await processAndDiscard(chunk);  // Constant memory
}

// No limit - caller processes line by line
for await (const line of readLines(fd)) {
    await processLine(line);  // Constant memory
}
```

## Chunk Size Behavior

The `chunkSize` parameter is a **hint** to the kernel, not a guarantee:

| Scenario | Behavior |
|----------|----------|
| `read(fd)` | Kernel uses default (64KB) |
| `read(fd, 4096)` | Kernel attempts 4KB chunks |
| Pipe/socket | May return smaller chunks based on availability |
| Near EOF | Final chunk may be smaller |
| Device | Device-specific chunking |

The caller should never assume chunk boundaries align with logical boundaries (e.g., lines). Use `readLines()` for line-oriented processing.

## Response Protocol

File reads use the standard streaming response protocol:

```
Kernel                              Userspace
  |                                     |
  |-- { op: 'item', data: chunk1 } ---->|
  |-- { op: 'item', data: chunk2 } ---->|
  |-- { op: 'item', data: chunk3 } ---->|
  |-- { op: 'done' } ------------------>|
```

For empty files:

```
Kernel                              Userspace
  |                                     |
  |-- { op: 'done' } ------------------>|
```

For errors mid-stream:

```
Kernel                              Userspace
  |                                     |
  |-- { op: 'item', data: chunk1 } ---->|
  |-- { op: 'error', data: {...} } ---->|
```

## Backpressure

File reads benefit from the same backpressure mechanism as other streams (see [OS_STREAMS.md](./OS_STREAMS.md)):

- Consumer sends `stream_ping` with processed count every 100ms
- Kernel pauses at high-water mark (1000 items)
- Kernel resumes at low-water mark (100 items)

For typical file reads with 64KB chunks, this means ~64MB can be buffered before backpressure kicks in. Adjust `chunkSize` for memory-constrained scenarios.

## Interaction with seek()

Streaming reads are **sequential by default**. The `seek()` syscall repositions for the next read:

```typescript
const fd = await open('/data/file.bin', { read: true });

// Read from middle of file
await seek(fd, 1024, 'start');

// Stream from position 1024 onwards
for await (const chunk of read(fd)) {
    // ...
}
```

Calling `seek()` during iteration is **undefined behavior**. If random access is needed, use multiple `seek()` + `readAll()` calls instead of streaming.

## Migration Guide

### Before (Single Buffer)

```typescript
const fd = await open('/path/to/file');
const data = await read(fd);  // Promise<Uint8Array>
await close(fd);
```

### After (Streaming)

```typescript
// Option 1: Stream chunks
const fd = await open('/path/to/file');
for await (const chunk of read(fd)) {  // AsyncIterable<Uint8Array>
    // process chunk
}
await close(fd);

// Option 2: Collect all (same behavior as before)
const fd = await open('/path/to/file');
const data = await readAll(fd);  // Promise<Uint8Array>
await close(fd);

// Option 3: Convenience function
const data = await readFileBytes('/path/to/file');
```

### readdir Migration

```typescript
// Before
const entries = await readdir('/path');  // Promise<string[]>

// After
const entries = await readdirAll('/path');  // Promise<string[]>

// Or stream (new default)
for await (const entry of readdir('/path')) {
    // ...
}
```

## Future Considerations

### Streaming Writes

Currently `write(fd, data)` takes a complete buffer. A streaming write API could accept an async iterable:

```typescript
// Future possibility
async function writeStream(fd: number, chunks: AsyncIterable<Uint8Array>): Promise<number>

// Usage
await writeStream(fd, generateChunks());
```

### Typed Line Parsing

A generic line parser could handle common formats:

```typescript
// Future possibility
function readLinesAs<T>(fd: number, parser: (line: string) => T): AsyncIterable<T>

// Usage
for await (const record of readLinesAs(fd, JSON.parse)) {
    // record is parsed JSON
}
```

### Memory-Mapped Files

For random access patterns, memory-mapped files could complement streaming:

```typescript
// Future possibility
const mapped = await mmap('/path/to/file');
const slice = mapped.slice(1024, 2048);  // Zero-copy view
```

## Files Changed

### Phase 1: Streaming File I/O

| File | Changes |
|------|---------|
| `rom/lib/process.ts` | New streaming read API, flip readdir default, add `maxSize`/`maxEntries` params |
| `src/kernel/syscalls.ts` | `read` handler yields chunks with `MAX_STREAM_BYTES` enforcement |
| `src/kernel/types.ts` | Add `DEFAULT_CHUNK_SIZE`, `MAX_STREAM_BYTES`, `MAX_STREAM_ENTRIES` constants |

### Phase 2: Unified Handle Architecture (Future)

| File | Changes |
|------|---------|
| `src/kernel/types.ts` | Replace `fds`, `ports`, `channels` with single `handles` table |
| `src/kernel/handle.ts` | New unified `Handle` interface with `send()` method |
| `src/kernel/syscalls.ts` | Single `send(handle, msg)` syscall dispatches to handle type |
| `src/kernel/kernel.ts` | Unified handle allocation, tracking, and cleanup |
| `src/vfs/model.ts` | Already message-based - no changes needed |
| `src/hal/channel.ts` | Already message-based - no changes needed |
| `rom/lib/process.ts` | Internal refactor to use `send()`, public API unchanged |

## Testing

1. **Streaming reads** - Verify chunks arrive incrementally for large files
2. **EOF handling** - Empty files yield `done` immediately
3. **Short reads** - Pipes and sockets may yield smaller chunks
4. **readLines** - Verify line splitting across chunk boundaries
5. **Backpressure** - Slow consumers don't cause unbounded buffering
6. **Error mid-stream** - Verify errors surface correctly during iteration
7. **readAll/readdirAll** - Verify collection matches streaming results
8. **Userspace limits** - `readAll()` throws EFBIG at 10MB default
9. **Kernel limits** - `read()` stream terminates with EFBIG at 100MB
10. **Limit override** - `readAll(fd, 50*1024*1024)` allows up to 50MB
11. **Infinite sources** - `/dev/zero` hits kernel limit, doesn't OOM
12. **Directory limits** - Large directories hit entry count limits
