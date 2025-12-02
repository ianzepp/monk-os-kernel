# Userspace Byte-to-Message Migration

## Terminology

**IMPORTANT**: Monk OS uses distinct terminology for message-based vs byte-based I/O:

### Process I/O Naming (message-oriented)
| FD | Old Name | New Name | Purpose |
|----|----------|----------|---------|
| 0 | stdin | recv | Receive messages |
| 1 | stdout | send | Send messages |
| 2 | stderr | warn | Diagnostic/warning output |

### Method Naming Convention
| Data Type | Input | Output |
|-----------|-------|--------|
| `Response` | `recv()` | `send()` |
| `Uint8Array` | `read()` | `write()` |

### PipeEnd Type
```typescript
// Pipe ends use message terminology
type PipeEnd = 'recv' | 'send';
```

**Rationale**: This naming enforces the distinction between message-based operations (recv/send) and byte-based operations (read/write). A `LineWriter` might have a `recv` side for messages and a `write` side for bytes.

---

## Problem Statement

The kernel was designed around message-passing (`Message` and `Response` objects), but userspace was never updated to match. This creates unnecessary byte serialization at process boundaries.

### Current Architecture (Wrong)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ls -l                                                                       │
│    entries[] (structured data)                                               │
│         ↓                                                                    │
│    println(name)  →  TextEncoder.encode()  →  write(1, bytes)               │
│                                                    ↓                         │
│                                              Uint8Array                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                                     ↓
                              ┌───────────────────────────────────────┐
                              │  PipeBuffer (Uint8Array[])            │
                              │  - Stores raw bytes                   │
                              │  - No structure preserved             │
                              └───────────────────────────────────────┘
                                                     ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  grep pattern                                                                │
│    read(0)  →  Uint8Array  →  TextDecoder.decode()  →  string               │
│                                                            ↓                 │
│    line.includes(pattern)  →  TextEncoder.encode()  →  write(1, bytes)      │
└─────────────────────────────────────────────────────────────────────────────┘
                                                     ↓
                              ┌───────────────────────────────────────┐
                              │  PipeBuffer (Uint8Array[])            │
                              └───────────────────────────────────────┘
                                                     ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  sort                                                                        │
│    read(0)  →  bytes  →  decode  →  lines[]  →  sort()  →  encode  →  write │
└─────────────────────────────────────────────────────────────────────────────┘
                                                     ↓
                              ┌───────────────────────────────────────┐
                              │  /dev/console                         │
                              │  Finally displays bytes               │
                              └───────────────────────────────────────┘
```

**Conversion count for `ls | grep | sort`**: 6 encode/decode cycles

### Correct Architecture (Message-First)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ls -l                                                                       │
│    entries[] (structured data)                                               │
│         ↓                                                                    │
│    yield Response { op: 'item', data: { text: name + '\n' } }               │
└─────────────────────────────────────────────────────────────────────────────┘
                                                     ↓
                              ┌───────────────────────────────────────┐
                              │  MessagePipe (Response[])             │
                              │  - Stores Response objects            │
                              │  - Structure preserved                │
                              └───────────────────────────────────────┘
                                                     ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  grep pattern                                                                │
│    for await (const msg of recv(0))                                         │
│      if (msg.data.text.includes(pattern))                                   │
│        send(1, msg)                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                                     ↓
                              ┌───────────────────────────────────────┐
                              │  MessagePipe (Response[])             │
                              └───────────────────────────────────────┘
                                                     ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  sort                                                                        │
│    collect all items  →  sort by data.text  →  yield sorted items           │
└─────────────────────────────────────────────────────────────────────────────┘
                                                     ↓
                              ┌───────────────────────────────────────┐
                              │  /dev/console                         │
                              │  ONLY HERE: Response → bytes          │
                              │  TextEncoder.encode(item.data.text)   │
                              └───────────────────────────────────────┘
```

**Conversion count for `ls | grep | sort`**: 1 encode (at final output only)

---

## Root Cause

The kernel architecture was updated to be message-first, but the userspace process library (`rom/lib/process/`) still uses byte-oriented I/O primitives that date from earlier design.

### Evidence: Kernel is Message-First

From `AGENTS.md`:
> "No JSON serialization in kernel - Only at true I/O boundaries (disk, network)"
> "Message objects everywhere internally - Not byte strings"

The kernel's `Handle` interface is message-oriented:
```typescript
interface Handle {
    exec(msg: Message): AsyncIterable<Response>;
}
```

Syscalls return `AsyncIterable<Response>`, not byte streams.

### Evidence: Userspace is Byte-First

From `rom/lib/process/io.ts`:
```typescript
export async function println(text: string): Promise<void> {
    await write(1, new TextEncoder().encode(text + '\n'));  // bytes!
}
```

From `rom/lib/process/file.ts`:
```typescript
export async function* read(fd: number, chunkSize?: number): AsyncIterable<Uint8Array> {
    // Returns bytes, not Response objects
}

export async function write(fd: number, data: Uint8Array): Promise<number> {
    // Takes bytes, not Response objects
}
```

From `src/kernel/resource/pipe-buffer.ts`:
```typescript
export class PipeBuffer {
    private chunks: Uint8Array[] = [];  // Stores bytes!

    write(data: Uint8Array): number { ... }
    async read(size?: number): Promise<Uint8Array> { ... }
}
```

---

## Specific Files Requiring Changes

### Layer 1: Pipe Infrastructure

| File | Action |
|------|--------|
| `src/kernel/resource/pipe-buffer.ts` | **DELETE** |
| `src/kernel/handle/pipe.ts` | **DELETE** |
| `src/kernel/resource/message-pipe.ts` | **CREATE** - `MessagePipe` implements `Handle` directly |
| `src/kernel/kernel.ts:createPipe()` | **UPDATE** - use `MessagePipe` |

### Layer 2: Process Library (Userspace)

| File | Current | Required |
|------|---------|----------|
| `rom/lib/process/file.ts` | `read()` returns `Uint8Array` | `read()` returns `Response` items |
| `rom/lib/process/file.ts` | `write()` takes `Uint8Array` | `write()` takes `Response` or has message variant |
| `rom/lib/process/io.ts` | `println()` encodes to bytes | `println()` yields `Response` item |
| `rom/lib/process/io.ts` | `print()` encodes to bytes | `print()` yields `Response` item |

### Layer 3: Userspace Utilities

All utilities in `rom/bin/` that use `println()` or `write()` will automatically benefit once Layer 2 is fixed. However, utilities that do streaming I/O may need updates:

| File | Current | Required |
|------|---------|----------|
| `rom/bin/cat.ts` | Reads bytes, writes bytes | Pass through Response items |
| `rom/bin/grep.ts` | Decodes bytes to filter | Filter Response items directly |
| `rom/bin/sort.ts` | Decodes bytes to sort | Sort Response items directly |
| `rom/bin/head.ts` | Counts bytes/lines | Count Response items |
| `rom/bin/tail.ts` | Buffers bytes | Buffer Response items |
| `rom/bin/wc.ts` | Counts bytes | Count from Response items |
| `rom/bin/tee.ts` | Copies bytes | Copies Response items |
| `rom/bin/tr.ts` | Transforms bytes | Transform Response item content |
| `rom/bin/cut.ts` | Slices bytes | Slice Response item content |
| `rom/bin/uniq.ts` | Compares byte lines | Compare Response items |
| `rom/bin/nl.ts` | Numbers byte lines | Number Response items |

### Layer 4: Console Device (Byte Boundary)

| File | Current | Required |
|------|---------|----------|
| `src/vfs/models/device.ts` | Console accepts bytes | Console accepts Response items, converts to bytes for display |

---

## Migration Strategy

### Phase 1: MessagePipe - The Core Primitive ✓ COMPLETED

> **Status**: Implemented in `src/kernel/resource/message-pipe.ts`. PipeBuffer and PipeHandleAdapter have been removed.

`MessagePipe` IS the `|` operator. It's the fundamental unit of inter-process communication.

**Design principle**: Messages in, messages out. Always. No bytes inside the pipe.

```
┌──────────────┐     ┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ LineReader   │────>│ MessagePipe │────>│ MessagePipe │────>│ LineWriter   │
│ (console in) │     │    (|)      │     │    (|)      │     │ (console out)│
└──────────────┘     └─────────────┘     └─────────────┘     └──────────────┘
     bytes              Response            Response              bytes
      ↑                                                            ↓
   keyboard                                                     display
```

**MessagePipe class** - replaces `PipeBuffer`, lives in `src/kernel/resource/message-pipe.ts`:

```typescript
export class MessagePipe implements AsyncIterable<Response> {
    private messages: Response[] = [];
    private waiters: Array<(msg: Response | null) => void> = [];
    private closed = false;
    private readonly highWaterMark: number;

    constructor(highWaterMark: number = 1000) {
        this.highWaterMark = highWaterMark;
    }

    /** Send a message into the pipe */
    send(msg: Response): void {
        if (this.closed) throw new EPIPE('Pipe closed');
        if (this.waiters.length > 0) {
            this.waiters.shift()!(msg);
            return;
        }
        if (this.messages.length >= this.highWaterMark) {
            throw new EAGAIN('Pipe full');
        }
        this.messages.push(msg);
    }

    /** Receive a message (null = EOF) */
    async recv(): Promise<Response | null> {
        if (this.messages.length > 0) return this.messages.shift()!;
        if (this.closed) return null;
        return new Promise(resolve => this.waiters.push(resolve));
    }

    /** Close pipe (EOF to readers) */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const w of this.waiters) w(null);
        this.waiters = [];
    }

    /** Async iteration */
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Response> {
        while (true) {
            const msg = await this.recv();
            if (msg === null) return;
            yield msg;
        }
    }
}
```

**Shell pipeline construction** for `ls | grep foo | sort`:

```typescript
const pipe1 = new MessagePipe();
const pipe2 = new MessagePipe();

spawn('ls',   { stdout: pipe1 });
spawn('grep', { stdin: pipe1, stdout: pipe2, args: ['foo'] });
spawn('sort', { stdin: pipe2, stdout: new LineWriter(console) });
```

**Integration steps**:

1. **Create** `src/kernel/resource/message-pipe.ts`:
   - `MessagePipe` class implementing `Handle` interface directly
   - No separate adapter needed - MessagePipe IS the handle
   - Read/write end distinction via constructor parameter

2. **Update** `src/kernel/kernel.ts`:
   - `createPipe()` returns two `MessagePipe` handles (read end, write end)
   - Both backed by same internal message queue
   - Update imports

3. **Delete** (entirely):
   - `src/kernel/resource/pipe-buffer.ts`
   - `src/kernel/handle/pipe.ts`

4. **Update** re-exports:
   - `src/kernel/resource/index.ts` - remove `PipeBuffer`, add `MessagePipe`
   - `src/kernel/handle/index.ts` - remove `PipeHandleAdapter`
   - `src/kernel/handle.ts` - remove `PipeHandleAdapter`
   - `src/kernel/resource.ts` - remove `PipeBuffer`, add `MessagePipe`

**MessagePipe as Handle**:

```typescript
export class MessagePipe implements Handle {
    readonly id: string;
    readonly type: HandleType = 'pipe';
    readonly description: string;

    private queue: Response[] = [];
    private waiters: Array<(msg: Response | null) => void> = [];
    private _closed = false;

    constructor(
        id: string,
        private readonly end: 'read' | 'write',
        private readonly sharedQueue: MessageQueue,
        description: string
    ) {
        this.id = id;
        this.description = description;
    }

    get closed(): boolean { return this._closed; }

    async *exec(msg: Message): AsyncIterable<Response> {
        if (msg.op === 'recv' && this.end === 'read') {
            // Yield messages until EOF
            for await (const item of this.sharedQueue) {
                yield item;
            }
            yield respond.done();
        } else if (msg.op === 'send' && this.end === 'write') {
            this.sharedQueue.send(msg.data as Response);
            yield respond.ok();
        } else {
            yield respond.error('EBADF', `Cannot ${msg.op} on ${this.end} end`);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        if (this.end === 'write') {
            this.sharedQueue.closeWrite();
        } else {
            this.sharedQueue.closeRead();
        }
    }
}
```

### Phase 2: Process Library I/O ✓ COMPLETED

> **Status**: Implemented. Process library now uses message-based I/O for fd 0/1/2.

**Changes made:**

| File | Change |
|------|--------|
| `rom/lib/process/pipe.ts` | Added `recv()` and `send()` for message I/O |
| `rom/lib/process/io.ts` | Updated `print`/`println`/`eprint`/`eprintln` to send messages |
| `rom/lib/process/types.ts` | Added `respond` helper |
| `rom/lib/process/syscall.ts` | Fixed `iterate()` to handle `chunk` responses |
| `rom/lib/process/net.ts` | Renamed `recv`/`send` → `portRecv`/`portSend` |
| `rom/lib/process/index.ts` | Export `recv`, `send`, `respond` |
| `src/kernel/syscalls/file.ts` | Added `recv`/`send` syscalls |
| `src/kernel/syscalls/network.ts` | Renamed to `port:recv`/`port:send` |

**API:**

```typescript
// Receive messages from fd (typically fd 0)
export async function* recv(fd: number = 0): AsyncIterable<Response>

// Send a message to fd (typically fd 1)
export async function send(fd: number, msg: Response): Promise<void>

// Convenience functions now use message I/O
export async function println(s: string): Promise<void> {
    await send(1, respond.item({ text: s + '\n' }));
}
```

**Note**: Byte-oriented `read()`/`write()` remain for file I/O (fd 3+)

### Phase 3: Update Streaming Utilities

1. Update `grep`, `sort`, `head`, `tail`, etc. to operate on Response items
2. These become simpler - no encode/decode cycles

### Phase 4: Console as Byte Boundary

1. Update `/dev/console` device to accept Response items
2. Console converts `item.data.line` (or similar) to bytes for display
3. This is the ONE place where message→byte conversion happens for stdout

---

## Response Item Format for Text Streams

Standard format for text in pipes:

```typescript
// Text (includes newline if needed)
{ op: 'item', data: { text: string } }

// Binary chunk (for file copies, etc.)
{ op: 'chunk', data: { bytes: Uint8Array } }

// End of stream
{ op: 'done' }

// Error
{ op: 'error', data: { code: string, message: string } }
```

Utilities can check `response.op`:
- `'item'` → text, access via `response.data.text`
- `'chunk'` → binary data, access via `response.data.bytes`
- `'done'` → EOF
- `'error'` → handle error

**Note**: The `text` field contains exactly what should be output, including any trailing newline. `println("hello")` sends `{ text: "hello\n" }`.

---

## Benefits After Migration

1. **Zero serialization in pipelines** - Messages flow through without encode/decode
2. **Structured data preservation** - Can pass rich objects, not just strings
3. **Type safety** - Response items are typed, not opaque bytes
4. **Simpler utilities** - grep/sort/etc. don't need encode/decode logic
5. **Consistent architecture** - Userspace matches kernel design
6. **Future extensibility** - Can add metadata, progress, etc. to Response items

---

## Risks and Considerations

### Backward Compatibility

Utilities that expect raw bytes will break. This is a breaking change to the process library API.

**Mitigation**: Keep byte-oriented functions for actual file I/O, deprecate for pipe I/O.

### Binary Data

Some utilities legitimately work with binary data (e.g., `xxd`, `base64`, file copies).

**Mitigation**: Use `{ op: 'chunk', data: { bytes: Uint8Array } }` for binary streams. The message wrapper adds minimal overhead.

### External Processes

If Monk OS ever needs to interact with actual Unix processes (via HAL host escape), those use byte streams.

**Mitigation**: Byte conversion happens at the HAL boundary, same as console.

---

---

## Boundary Adapters: LineReader / LineWriter

The system needs adapters at the boundaries where bytes meet messages.

### The Model

```
                    ┌─────────────────────────────────────┐
  bytes (keyboard)  │         LineReader                  │  Response items
  ─────────────────>│  bytes → readLine() → item(line)   │─────────────────>
                    └─────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
  Response items    │         LineWriter                  │  bytes (display)
  ─────────────────>│  item → String(data) + '\n'        │─────────────────>
                    │  chunk → raw bytes                  │
                    └─────────────────────────────────────┘
```

### Existing Code to Leverage

`rom/lib/io.ts` already has:

```typescript
class ByteReader {
    constructor(source: AsyncIterable<Uint8Array>)
    async readLine(): Promise<string | null>  // handles LF, CR, CRLF
    async read(n: number): Promise<Uint8Array>
}

class ByteWriter implements AsyncIterable<Uint8Array> {
    writeLine(line: string): void
    write(data: Uint8Array): void
    end(): void
}
```

### New Adapters Needed

**LineReader** - wraps byte source, yields Response items:

```typescript
class LineReader implements AsyncIterable<Response> {
    private reader: ByteReader;

    constructor(source: AsyncIterable<Uint8Array>) {
        this.reader = new ByteReader(source);
    }

    async *[Symbol.asyncIterator](): AsyncIterableIterator<Response> {
        while (true) {
            const line = await this.reader.readLine();
            if (line === null) {
                yield respond.done();
                return;
            }
            yield respond.item(line);
        }
    }
}
```

**LineWriter** - accepts Response items, writes bytes:

```typescript
class LineWriter {
    constructor(private sink: (data: Uint8Array) => Promise<void>) {}

    async write(response: Response): Promise<void> {
        if (response.op === 'item') {
            const line = String(response.data);
            await this.sink(new TextEncoder().encode(line + '\n'));
        } else if (response.op === 'chunk') {
            await this.sink((response.data as { bytes: Uint8Array }).bytes);
        }
        // 'done', 'error' - no output
    }

    async writeAll(stream: AsyncIterable<Response>): Promise<void> {
        for await (const response of stream) {
            await this.write(response);
            if (response.op === 'done' || response.op === 'error') break;
        }
    }
}
```

### Where Adapters Are Used

| Location | Adapter | Purpose |
|----------|---------|---------|
| `/dev/console` stdin | LineReader | Keyboard bytes → items for shell |
| `/dev/console` stdout | LineWriter | Items from commands → display bytes |
| File read (text mode) | LineReader | File bytes → items for processing |
| File write (text mode) | LineWriter | Items → file bytes |
| Host stdin | LineReader | External input → items |
| Host stdout | LineWriter | Items → external output |

### Pipe: No Adapter

Pipes between processes need NO adapter - they pass `Response` objects directly:

```
ls stdout ──[Response]──> MessagePipe ──[Response]──> grep stdin
```

No LineReader/LineWriter in the middle. Messages flow through unchanged.

### Console Device Update

`/dev/console` would use these adapters internally:

```typescript
class ConsoleDevice {
    // Reading from console (keyboard input)
    async *read(): AsyncIterable<Response> {
        const reader = new LineReader(this.hal.console.stdin());
        yield* reader;
    }

    // Writing to console (display output)
    async write(stream: AsyncIterable<Response>): Promise<void> {
        const writer = new LineWriter((bytes) => this.hal.console.stdout(bytes));
        await writer.writeAll(stream);
    }
}
```

---

## Summary: Where Bytes Live

| Component | Data Format | Notes |
|-----------|-------------|-------|
| Keyboard/Display | bytes | Hardware boundary |
| `/dev/console` | bytes ↔ Response | Uses LineReader/LineWriter |
| Disk files | bytes | Storage boundary |
| File handles (text) | bytes ↔ Response | Uses LineReader/LineWriter |
| Pipes | Response | Pure message passing |
| Network sockets | bytes | Wire boundary |
| Channels (HTTP, SQL) | Response | Protocol-aware messages |

**Rule**: Bytes exist only at hardware/storage/network boundaries. Everything else is messages.

---

## Open Questions

1. Should `println()` be updated in place, or should we add new `emitLine()` function?
2. How should utilities detect whether stdin is message-oriented or byte-oriented (for compatibility)?
3. Should Response items include source metadata (pid, timestamp)?
4. What's the migration path for existing scripts that use byte I/O?
5. Should LineReader/LineWriter live in `rom/lib/io.ts` alongside ByteReader/ByteWriter?
