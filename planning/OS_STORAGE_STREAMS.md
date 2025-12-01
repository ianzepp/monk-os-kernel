# Streams-First File Descriptors

Extending the streams-first architecture to file descriptor operations, and unifying the I/O model around Message/Response.

## Implementation Status

**Status: PHASE 1 COMPLETE** (2024-12-01)

### Phase 1 Notes

- Streaming `read()` syscall implemented with `MAX_STREAM_BYTES` enforcement
- Streaming `readdir()` syscall implemented with `MAX_STREAM_ENTRIES` enforcement
- `ByteReader` and `ByteWriter` classes added to `rom/lib/io.ts`
- Userspace API updated: `read()` returns `AsyncIterable<Uint8Array>`, `readdir()` returns `AsyncIterable<string>`
- Convenience functions added: `readAll`, `readText`, `readLines`, `readdirAll`, `copy`, `copyFile`, `readFileBytes`
- Shell migrated to use new API (`ByteReader` for stdin, `readText` for scripts, `readdirAll` for globs)
- Fixed `src/kernel/loader.ts` to handle `export async function*` and `export function*` syntax
- All 525 tests passing

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

### Buffered I/O Classes

The streaming `read()` API yields chunks of arbitrary size (typically 64KB). Some use cases require finer control:

- Shell readline: read byte-by-byte or line-by-line from stdin
- Protocol parsing: read exact byte counts for headers
- Interactive input: consume precisely what's needed, buffer the rest

Two classes provide this control:

| Class | Purpose | Direction |
|-------|---------|-----------|
| `ByteReader` | Consume AsyncIterable with precise byte control | Pull (consumer) |
| `ByteWriter` | Produce AsyncIterable from pushed bytes | Push (producer) |

#### ByteReader

Wraps an `AsyncIterable<Uint8Array>` and provides precise read control:

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(source: AsyncIterable<Uint8Array>)` | Wrap a byte stream |
| `read` | `(n: number) → Promise<Uint8Array>` | Read exactly n bytes (or fewer at EOF) |
| `readUntil` | `(delim: number) → Promise<Uint8Array \| null>` | Read until delimiter byte (inclusive) |
| `readLine` | `() → Promise<string \| null>` | Read one line (handles CR, LF, CRLF) |
| `peek` | `(n: number) → Promise<Uint8Array>` | Peek at next n bytes without consuming |
| `done` | `boolean` (getter) | True if EOF reached and buffer empty |

#### ByteWriter

Produces an `AsyncIterable<Uint8Array>` that yields chunks as they're written:

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(chunkSize?: number)` | Create writer, optional chunk size hint |
| `write` | `(data: Uint8Array) → void` | Push bytes (may buffer) |
| `writeLine` | `(line: string) → void` | Push line with newline |
| `flush` | `() → void` | Force buffered data to be yielded |
| `end` | `() → void` | Signal no more data |
| `[Symbol.asyncIterator]` | `() → AsyncIterator<Uint8Array>` | Get the output stream |

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

### Buffered Reading (ByteReader)

```typescript
import { read, ByteReader } from '/lib/process';

// Shell interactive input - single reader for entire session
const stdin = new ByteReader(read(0));

async function shellLoop(): Promise<void> {
    while (true) {
        await printPrompt();
        const line = await stdin.readLine();
        if (line === null) break;  // EOF
        await executeCommand(line);
    }
}

// Protocol parsing - read exact byte counts
const reader = new ByteReader(read(socketFd));

// Read 4-byte length prefix
const header = await reader.read(4);
const length = new DataView(header.buffer).getUint32(0, false);

// Read exactly that many bytes for body
const body = await reader.read(length);

// Peek without consuming
const magic = await reader.peek(2);
if (magic[0] === 0x1f && magic[1] === 0x8b) {
    // It's gzip - read and decompress
}
```

### Buffered Writing (ByteWriter)

```typescript
import { write, ByteWriter } from '/lib/process';

// Generate HTTP response streaming
const response = new ByteWriter();

response.writeLine('HTTP/1.1 200 OK');
response.writeLine('Content-Type: text/event-stream');
response.writeLine('');

// Start consuming in background
(async () => {
    for await (const chunk of response) {
        await write(socketFd, chunk);
    }
})();

// Producer sends events over time
for (const event of events) {
    response.writeLine(`data: ${JSON.stringify(event)}`);
    response.writeLine('');
    response.flush();  // Send immediately
    await delay(1000);
}
response.end();

// Pipe transformation - uppercase filter
async function* uppercase(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    const reader = new ByteReader(input);
    const writer = new ByteWriter();

    (async () => {
        while (!reader.done) {
            const line = await reader.readLine();
            if (line !== null) {
                writer.writeLine(line.toUpperCase());
            }
        }
        writer.end();
    })();

    yield* writer;
}

// Usage: cat file | uppercase
for await (const chunk of uppercase(read(inputFd))) {
    await write(outputFd, chunk);
}
```

### Connecting ByteReader and ByteWriter (Pipelines)

```typescript
import { read, write, ByteReader, ByteWriter } from '/lib/process';

// Build a pipeline: input → transform1 → transform2 → output
async function pipeline(
    input: AsyncIterable<Uint8Array>,
    ...transforms: Array<(input: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>>
): Promise<void> {
    let stream = input;
    for (const transform of transforms) {
        stream = transform(stream);
    }
    for await (const chunk of stream) {
        await write(1, chunk);  // stdout
    }
}

// Line-numbered output
function* lineNumbers(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    const reader = new ByteReader(input);
    const writer = new ByteWriter();

    (async () => {
        let n = 1;
        while (!reader.done) {
            const line = await reader.readLine();
            if (line !== null) {
                writer.writeLine(`${String(n++).padStart(6)}  ${line}`);
            }
        }
        writer.end();
    })();

    yield* writer;
}

// Usage
await pipeline(read(fd), lineNumbers);
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

// ============================================================================
// Buffered I/O Classes (rom/lib/io.ts)
// ============================================================================
// These classes live in rom/lib/io.ts and are re-exported from rom/lib/process.ts:
//   export { ByteReader, ByteWriter } from '/lib/io';

/**
 * Concatenate two Uint8Arrays.
 */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
}

/**
 * ByteReader - Consume an AsyncIterable<Uint8Array> with precise byte control.
 *
 * Wraps a streaming source and provides methods to read exact byte counts,
 * read until delimiters, or read lines. Maintains an internal buffer to
 * handle chunk boundaries transparently.
 *
 * @example
 * // Interactive shell input
 * const stdin = new ByteReader(read(0));
 * while (true) {
 *     const line = await stdin.readLine();
 *     if (line === null) break;
 *     await execute(line);
 * }
 *
 * @example
 * // Protocol parsing - read fixed header then variable body
 * const reader = new ByteReader(read(socketFd));
 * const header = await reader.read(4);  // Exactly 4 bytes
 * const length = new DataView(header.buffer).getUint32(0);
 * const body = await reader.read(length);
 */
export class ByteReader {
    private iterator: AsyncIterator<Uint8Array>;
    private buffer: Uint8Array = new Uint8Array(0);
    private eof = false;

    constructor(source: AsyncIterable<Uint8Array>) {
        this.iterator = source[Symbol.asyncIterator]();
    }

    /**
     * True if EOF reached and internal buffer is empty.
     */
    get done(): boolean {
        return this.eof && this.buffer.length === 0;
    }

    /**
     * Ensure internal buffer has at least n bytes (or hit EOF).
     */
    private async fill(n: number): Promise<void> {
        while (this.buffer.length < n && !this.eof) {
            const { value, done } = await this.iterator.next();
            if (done) {
                this.eof = true;
                break;
            }
            this.buffer = concat(this.buffer, value);
        }
    }

    /**
     * Read exactly n bytes (or fewer at EOF).
     *
     * @param n - Number of bytes to read
     * @returns Uint8Array of length n (or less if EOF)
     */
    async read(n: number): Promise<Uint8Array> {
        await this.fill(n);
        const result = this.buffer.subarray(0, Math.min(n, this.buffer.length));
        this.buffer = this.buffer.subarray(result.length);
        return result;
    }

    /**
     * Peek at the next n bytes without consuming them.
     *
     * @param n - Number of bytes to peek
     * @returns Uint8Array of up to n bytes
     */
    async peek(n: number): Promise<Uint8Array> {
        await this.fill(n);
        return this.buffer.subarray(0, Math.min(n, this.buffer.length));
    }

    /**
     * Read until delimiter byte (inclusive), or EOF.
     *
     * @param delim - Byte value to stop at (included in result)
     * @returns Bytes up to and including delimiter, or null if EOF with no data
     */
    async readUntil(delim: number): Promise<Uint8Array | null> {
        while (true) {
            const idx = this.buffer.indexOf(delim);
            if (idx !== -1) {
                const result = this.buffer.subarray(0, idx + 1);
                this.buffer = this.buffer.subarray(idx + 1);
                return result;
            }
            if (this.eof) {
                if (this.buffer.length === 0) return null;
                const result = this.buffer;
                this.buffer = new Uint8Array(0);
                return result;
            }
            // Need more data - fill at least one more chunk
            const prevLen = this.buffer.length;
            await this.fill(prevLen + 1);
            // If no progress, we hit EOF
            if (this.buffer.length === prevLen) {
                if (this.buffer.length === 0) return null;
                const result = this.buffer;
                this.buffer = new Uint8Array(0);
                return result;
            }
        }
    }

    /**
     * Read one line (without the newline character).
     * Handles LF, CR, and CRLF line endings.
     *
     * @returns Line string, or null if EOF with no data
     */
    async readLine(): Promise<string | null> {
        const bytes = await this.readUntil(0x0a); // LF
        if (bytes === null) return null;

        let end = bytes.length;

        // Strip trailing LF
        if (end > 0 && bytes[end - 1] === 0x0a) {
            end--;
        }
        // Strip trailing CR (for CRLF)
        if (end > 0 && bytes[end - 1] === 0x0d) {
            end--;
        }

        return new TextDecoder().decode(bytes.subarray(0, end));
    }
}

/**
 * ByteWriter - Produce an AsyncIterable<Uint8Array> from pushed bytes.
 *
 * Allows imperative code to push bytes and have consumers pull them
 * via async iteration. Useful for generating streaming output, protocol
 * encoding, or connecting synchronous producers to async consumers.
 *
 * @example
 * // Generate streaming response
 * const writer = new ByteWriter();
 *
 * // Producer (can be sync or async)
 * writer.writeLine('HTTP/1.1 200 OK');
 * writer.writeLine('Content-Type: text/plain');
 * writer.writeLine('');
 * writer.writeLine('Hello, World!');
 * writer.end();
 *
 * // Consumer
 * for await (const chunk of writer) {
 *     await socket.write(chunk);
 * }
 *
 * @example
 * // Pipe transformation
 * async function transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
 *     const writer = new ByteWriter();
 *
 *     (async () => {
 *         for await (const chunk of input) {
 *             writer.write(processChunk(chunk));
 *         }
 *         writer.end();
 *     })();
 *
 *     return writer;
 * }
 */
export class ByteWriter implements AsyncIterable<Uint8Array> {
    private chunks: Uint8Array[] = [];
    private buffer: Uint8Array = new Uint8Array(0);
    private chunkSize: number;
    private ended = false;
    private error: Error | null = null;

    // For async iteration - resolvers for pending reads
    private waiting: Array<{
        resolve: (result: IteratorResult<Uint8Array>) => void;
        reject: (error: Error) => void;
    }> = [];

    constructor(chunkSize: number = 65536) {
        this.chunkSize = chunkSize;
    }

    /**
     * Write bytes to the stream.
     * Data may be buffered until chunkSize is reached or flush() is called.
     */
    write(data: Uint8Array): void {
        if (this.ended) {
            throw new Error('Cannot write to ended ByteWriter');
        }

        this.buffer = concat(this.buffer, data);

        // Flush complete chunks
        while (this.buffer.length >= this.chunkSize) {
            const chunk = this.buffer.subarray(0, this.chunkSize);
            this.buffer = this.buffer.subarray(this.chunkSize);
            this.emit(chunk);
        }
    }

    /**
     * Write a string line (with trailing newline).
     */
    writeLine(line: string): void {
        this.write(new TextEncoder().encode(line + '\n'));
    }

    /**
     * Force any buffered data to be emitted immediately.
     */
    flush(): void {
        if (this.buffer.length > 0) {
            this.emit(this.buffer);
            this.buffer = new Uint8Array(0);
        }
    }

    /**
     * Signal that no more data will be written.
     * Flushes any remaining buffer and completes the stream.
     */
    end(): void {
        if (this.ended) return;
        this.flush();
        this.ended = true;

        // Resolve any waiting consumers with done
        for (const waiter of this.waiting) {
            waiter.resolve({ done: true, value: undefined });
        }
        this.waiting = [];
    }

    /**
     * Signal an error condition.
     * Any waiting consumers will receive the error.
     */
    abort(error: Error): void {
        this.error = error;
        this.ended = true;

        for (const waiter of this.waiting) {
            waiter.reject(error);
        }
        this.waiting = [];
    }

    /**
     * Emit a chunk to waiting consumers or queue it.
     */
    private emit(chunk: Uint8Array): void {
        // Copy chunk to avoid shared buffer issues
        const copy = new Uint8Array(chunk);

        if (this.waiting.length > 0) {
            const waiter = this.waiting.shift()!;
            waiter.resolve({ done: false, value: copy });
        } else {
            this.chunks.push(copy);
        }
    }

    /**
     * AsyncIterator implementation.
     */
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
            next: async (): Promise<IteratorResult<Uint8Array>> => {
                // Check for error
                if (this.error) {
                    throw this.error;
                }

                // Return queued chunk if available
                if (this.chunks.length > 0) {
                    return { done: false, value: this.chunks.shift()! };
                }

                // If ended, we're done
                if (this.ended) {
                    return { done: true, value: undefined };
                }

                // Wait for next chunk
                return new Promise((resolve, reject) => {
                    this.waiting.push({ resolve, reject });
                });
            },
        };
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
| `rom/lib/io.ts` | New file: `ByteReader`, `ByteWriter` classes, `concat()` helper |
| `src/kernel/syscalls.ts` | `read` handler yields chunks with `MAX_STREAM_BYTES` enforcement |
| `src/kernel/types.ts` | Add `DEFAULT_CHUNK_SIZE`, `MAX_STREAM_BYTES`, `MAX_STREAM_ENTRIES` constants |

### Phase 1.5: Userspace Command Migration

| File | Changes |
|------|---------|
| `rom/bin/shell.ts` | Replace `readline()` with `ByteReader`, use `readLines()` for scripts |
| `rom/bin/cat.ts` | Use `read()` iterator or `readAll()` |
| `rom/bin/head.ts` | Use `ByteReader.readLine()` with count |
| `rom/bin/tail.ts` | Use `ByteReader.readLine()` with ring buffer |
| `rom/bin/wc.ts` | Stream with `read()`, count incrementally |
| `rom/bin/sort.ts` | Use `readAll()` then sort |
| `rom/bin/uniq.ts` | Use `readLines()` |
| `rom/bin/cut.ts` | Use `readLines()` |
| `rom/bin/awk.ts` | Use `readLines()` |
| `rom/bin/sed.ts` | Use `readLines()` |
| `rom/bin/tr.ts` | Stream with `read()` |
| `rom/bin/nl.ts` | Use `readLines()` |
| `rom/bin/tee.ts` | Stream with `read()` |
| `rom/bin/cp.ts` | Use `copy()` or `copyFile()` |
| `rom/bin/ls.ts` | Use `readdirAll()` |
| `rom/bin/rm.ts` | Use `readdirAll()` for recursive |
| `rom/bin/du.ts` | Use `readdirAll()` for tree walk |
| `rom/lib/shell/*.ts` | Update `readdirForGlob()` to use `readdirAll()` |

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

### Core Streaming API

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

### ByteReader

13. **read(n)** - Returns exactly n bytes when available
14. **read(n) at EOF** - Returns fewer bytes at end of stream
15. **readLine()** - Handles LF, CR, CRLF line endings
16. **readLine() across chunks** - Line split across multiple source chunks
17. **readLine() no trailing newline** - Final line without newline returned
18. **readUntil()** - Stops at delimiter, includes delimiter in result
19. **readUntil() at EOF** - Returns remaining bytes if no delimiter
20. **peek()** - Returns bytes without consuming them
21. **peek() then read()** - Same bytes returned, then consumed
22. **done getter** - True only when EOF and buffer empty
23. **Multi-line paste** - Multiple lines buffered, consumed one at a time
24. **Shared iterator** - Single ByteReader used across multiple readline calls

### ByteWriter

25. **write() + iteration** - Written bytes appear in async iteration
26. **writeLine()** - Appends newline character
27. **Chunk buffering** - Small writes buffered until chunkSize
28. **flush()** - Forces immediate emission of buffered data
29. **end()** - Completes iteration, flushes remaining buffer
30. **end() with waiting consumer** - Resolves pending next() with done
31. **abort()** - Rejects pending consumers with error
32. **Write after end** - Throws error
33. **Multiple consumers** - Only one consumer supported (or document behavior)
34. **Concurrent produce/consume** - Producer and consumer in separate async contexts

### Integration

35. **Shell readline** - ByteReader on stdin works for interactive input
36. **Shell script** - readLines() on file fd processes all lines
37. **Pipeline transform** - ByteReader → process → ByteWriter chain works
38. **Copy via streams** - `copy(src, dst)` matches `copyFile()` output
39. **httpd streaming** - ByteWriter produces chunked HTTP responses
