# Streams-First Architecture

Universal streaming as the primary data flow model for Monk OS.

## Implementation Status

**Status: IMPLEMENTED** (2024-12)

All phases complete:
- Phase 1: Transport layer ✓
- Phase 2: Syscall handlers ✓
- Phase 3: API surface ✓
- Phase 4: Tests ✓

### Key Files Modified

| File | Changes |
|------|---------|
| `src/kernel/types.ts` | Added `activeStreams`, `streamPingHandlers` to Process; stream constants; `StreamPingMessage`, `StreamCancelMessage` types |
| `src/kernel/syscalls.ts` | All handlers converted to async generators returning `AsyncIterable<Response>` |
| `src/kernel/kernel.ts` | `handleSyscall` iterates responses with backpressure; handles `stream_ping` and `stream_cancel` |
| `src/message.ts` | Added `unwrapStream()` helper |
| `rom/lib/process.ts` | Complete rewrite with streaming transport, `call()`, `collect()`, `iterate()` wrappers |

### Implementation Notes

1. **Backpressure was added** - The original spec suggested deferring backpressure. During implementation, we added time-based progress reporting and kernel-side backpressure (see updated Liveness section below).

2. **Error handling simplified** - Syscall handlers now use `yield respond.error()` instead of throwing exceptions. The kernel catches uncaught exceptions and converts them to error responses.

3. **All 525 tests pass** - Existing tests updated to use `unwrapStream()` helper for extracting single values from streams.

## Thesis

Monk OS should treat **streams of `Response` objects as the fundamental unit of data flow**, not arrays. Every syscall, every VFS operation, every channel interaction produces an `AsyncIterable<Response>`. Arrays become a convenience wrapper for collecting stream results, not the primary interface.

This inverts the typical design where arrays are primary and streaming is bolted on. Instead:

- **Streams are primary**: All operations yield `Response` objects over time
- **Arrays are derived**: Convenience functions collect streams when needed
- **JSONL is native**: The internal protocol *is* newline-delimited responses
- **One code path**: No separate implementations for "regular" vs "streaming" operations

## What This Solves

### 1. Memory Efficiency

**Problem**: Buffering large results (database queries, directory listings, log files) risks OOM.

**Solution**: Streams process one item at a time. A query returning 1M rows uses O(1) memory, not O(n).

### 2. Latency

**Problem**: Clients wait for entire result set before seeing first item.

**Solution**: First `Response` available immediately. Time-to-first-byte approaches zero for streaming endpoints.

### 3. Architectural Inconsistency

**Problem**: Current codebase has mixed patterns:
- VFS `handle()` returns `AsyncIterable<Response>` (streaming)
- VFS `list()` returns `AsyncIterable<string>` (streaming)
- Syscalls return `Promise<T>` (single value)
- `channel_stream` is a special case bolted onto the syscall system

**Solution**: Everything returns `AsyncIterable<Response>`. The `Response.op` field distinguishes single values (`ok`) from streams (`item`/`done`).

### 4. Streaming Syscall Transport

**Problem**: The syscall transport (`postMessage`) can't serialize `AsyncIterable`. Current `channel_stream` implementation is broken - it expects an array that never arrives.

**Solution**: Kernel sends multiple `response` messages, one per yielded `Response`. Userspace reassembles into `AsyncIterable`.

### 5. JSONL as Afterthought

**Problem**: JSONL support requires conversion at API boundaries. Two code paths (array vs stream) must be maintained.

**Solution**: Internal format *is* a stream of JSON objects. JSONL output is just serialization. Array output is just collection.

### 6. Infinite/Unbounded Sources

**Problem**: Watches, SSE, WebSocket, pub/sub produce events indefinitely. Array model cannot represent this.

**Solution**: Streams naturally represent unbounded sequences. Consumer controls lifecycle via iteration.

## The Response Protocol

The existing `Response` type already encodes streaming semantics:

```typescript
interface Response {
    op: 'ok' | 'error' | 'item' | 'chunk' | 'event' | 'progress' | 'done' | 'redirect';
    data?: unknown;
}
```

| Op | Meaning | Terminal? |
|----|---------|-----------|
| `ok` | Success with value | **Yes** - value + completion in one |
| `error` | Failure | **Yes** - stream complete |
| `item` | One item in sequence | No - more expected |
| `chunk` | Binary data segment | No - more expected |
| `event` | Pushed notification | No - more expected |
| `progress` | Progress update | No - more expected |
| `done` | Sequence complete | **Yes** - stream complete |
| `redirect` | Go elsewhere | **Yes** - stream complete |

### Terminal vs Non-Terminal Ops

**Terminal ops** (`ok`, `error`, `done`, `redirect`) signal stream completion. No more responses follow.

**Non-terminal ops** (`item`, `chunk`, `event`, `progress`) signal partial data. More responses expected until a terminal op arrives.

**Key distinction**:
- `ok` = "here is your single value, we're done" (value + completion in one message)
- `item` + `done` = "here are multiple values, now we're done" (separate messages)

There is no length hint upfront. The recipient iterates until it receives a terminal op.

### Response Patterns

| Pattern | Responses Sent |
|---------|----------------|
| Single value | `{ op: 'ok', data: 42 }` |
| Multiple items | `{ op: 'item', data: 1 }` → `{ op: 'item', data: 2 }` → `{ op: 'done' }` |
| Empty collection | `{ op: 'done' }` |
| Error | `{ op: 'error', data: { code, message } }` |
| Progress + result | `{ op: 'progress', data: { current: 50 } }` → `{ op: 'ok', data: result }` |

**Why no length hint?** Many streams are unbounded (watches, SSE, WebSocket) or unknown upfront (database cursors). Simpler to just iterate until terminal.

## Syscall Transport Protocol

### Current (Broken for Streaming)

```
Userspace                    Kernel
    |                           |
    |-- syscall request ------->|
    |                           |
    |<-- single response -------|  (can't represent streams)
```

### Proposed (Streams-Native)

```
Userspace                    Kernel
    |                           |
    |-- syscall request ------->|
    |                           |
    |<-- response { op:'item' } |
    |<-- response { op:'item' } |
    |<-- response { op:'done' } |
```

For single-value syscalls:

```
Userspace                    Kernel
    |                           |
    |-- syscall request ------->|
    |                           |
    |<-- response { op:'ok' } --|  (stream of length 1)
```

The message format remains:

```typescript
// Request (unchanged)
{ type: 'syscall', id: string, name: string, args: unknown[] }

// Response (unchanged structure, but may receive multiple per request)
{ type: 'response', id: string, result: Response }

// Error response (unchanged)
{ type: 'response', id: string, error: { code: string, message: string } }
```

## Stream Lifecycle

Streams need explicit lifecycle management for cancellation and liveness detection.

### Messages

| Message | Direction | Purpose |
|---------|-----------|---------|
| `syscall` | U → K | Start operation |
| `response` | K → U | Item/done/error/ok |
| `stream_ping` | U → K | Consumer liveness signal |
| `stream_cancel` | U → K | Stop producing, cleanup |

### Cancellation

When userspace stops iterating (normal completion, `break`, or exception), it must notify the kernel to stop producing and release resources.

```
Userspace                           Kernel
   |                                   |
   |<-- response { op:'item' }         |
   |<-- response { op:'item' }         |
   |                                   |
   |   (userspace throws/breaks)       |
   |                                   |
   |-- stream_cancel { id } ---------->|  (finally block)
   |                                   |
   (kernel stops iteration, cleanup)   |
```

**Kernel behavior on cancel:**
- Abort the async iteration loop
- Clean up resources (close channels, cursors, handles)
- Remove stream from active tracking

**Userspace behavior:**
- Send `stream_cancel` in `finally` block of syscall generator
- Always sent, even on normal completion (kernel ignores if already done)

### Liveness and Backpressure

For long-running or high-volume streams, the kernel needs:
1. **Liveness detection** - Know if consumer is still alive
2. **Backpressure** - Slow down if consumer can't keep up

**Solution: Time-based progress pings**

Consumer sends periodic pings with a `processed` count. Kernel compares against items sent to determine gap. If gap too large, kernel pauses until consumer catches up.

**Stream Ping Message:**
```typescript
interface StreamPingMessage {
    type: 'stream_ping';
    id: string;
    processed: number;  // Items consumer has yielded to caller
}
```

**Constants:**

| Constant | Value | Purpose |
|----------|-------|---------|
| `STREAM_HIGH_WATER` | 1000 | Pause when this many items unacked |
| `STREAM_LOW_WATER` | 100 | Resume when gap falls to this |
| `STREAM_PING_INTERVAL` | 100ms | Consumer pings every 100ms |
| `STREAM_STALL_TIMEOUT` | 5000ms | Abort if no ping for this long |

**Kernel backpressure implementation:**
```typescript
// Kernel tracks per-stream
let itemsSent = 0;
let itemsAcked = 0;
let lastPingTime = Date.now();
let resumeResolve: (() => void) | null = null;

// Ping handler updates acked count and may resume
proc.streamPingHandlers.set(request.id, (processed: number) => {
    itemsAcked = processed;
    lastPingTime = Date.now();
    if (resumeResolve && (itemsSent - itemsAcked) <= STREAM_LOW_WATER) {
        resumeResolve();
        resumeResolve = null;
    }
});

for await (const response of iterable) {
    // Check for stall
    if (Date.now() - lastPingTime >= STREAM_STALL_TIMEOUT) {
        yield respond.error('ETIMEDOUT', 'Stream consumer unresponsive');
        return;
    }

    yield response;
    itemsSent++;

    // Backpressure: pause if too far ahead
    const gap = itemsSent - itemsAcked;
    if (gap >= STREAM_HIGH_WATER) {
        await new Promise(resolve => { resumeResolve = resolve; });
    }
}
```

**Userspace time-based ping:**

The `syscall()` generator sends pings every 100ms with current processed count:

```typescript
async function* syscall(name: string, ...args: unknown[]): AsyncIterable<Response> {
    const id = crypto.randomUUID();
    let processed = 0;
    let lastPingTime = Date.now();

    try {
        self.postMessage({ type: 'syscall', id, name, args });

        while (true) {
            while (stream.queue.length > 0) {
                const response = stream.queue.shift()!;
                yield response;
                processed++;

                // Time-based ping with progress count
                const now = Date.now();
                if (now - lastPingTime >= 100) {
                    self.postMessage({ type: 'stream_ping', id, processed });
                    lastPingTime = now;
                }

                if (response.op === 'ok' || response.op === 'done' || response.op === 'error') {
                    return;
                }
            }
        }
    } finally {
        streams.delete(id);
        self.postMessage({ type: 'stream_cancel', id });
    }
}
```

**How it adapts to consumer speed:**
- Fast consumer (10k items/sec) → ping every ~1000 items, kernel never pauses
- Slow consumer (10 items/sec) → ping every ~1 item, kernel pauses frequently
- Blocked consumer → no pings → kernel times out after 5s

**Result:** Automatic backpressure without explicit flow control messages. Consumer code is simple:

```typescript
// Consumer doesn't think about pings or backpressure
for await (const row of channel.stream(db, query)) {
    await expensiveProcessing(row);  // Kernel automatically slows down
}
```

### Stream Lifecycle Summary

| Stream Size | Duration | Ping Sent? | Cancel Sent? |
|-------------|----------|------------|--------------|
| Small (<500 items) | Fast | No | Yes (finally) |
| Medium (<1000 items) | <5s | No | Yes (finally) |
| Large (>1000 items) | Any | Yes (auto) | Yes (finally) |
| Any | >5s | Yes (auto) | Yes (finally) |
| Infinite (SSE) | Forever | Yes (auto) | Yes (on break) |

The 80% case (small/fast operations) completes before thresholds. Large or slow streams get automatic pings. All streams get cleanup via cancel.

### Resource Cleanup

When a stream is cancelled or abandoned, underlying resources (database cursors, HTTP connections, file handles) must be released. This is handled via **async iterator finally blocks**.

**Key insight**: When you `break` out of a `for await` loop (or it throws), JavaScript calls the iterator's `return()` method, which executes any `finally` blocks in the generator.

**HAL channels are responsible for cleanup:**

```typescript
// HAL PostgreSQL Channel
async *handle(msg: Message): AsyncIterable<Response> {
    const cursor = await this.db.createCursor(msg.data.sql);

    try {
        for await (const row of cursor) {
            yield respond.item(row);
        }
        yield respond.done();
    } finally {
        // ALWAYS runs - normal completion, break, or error
        await cursor.close();
    }
}

// HAL HTTP Channel - chunked response
async *handle(msg: Message): AsyncIterable<Response> {
    const response = await fetch(this.buildUrl(msg));
    const reader = response.body.getReader();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield respond.chunk(value);
        }
        yield respond.done();
    } finally {
        reader.releaseLock();  // Cleanup even if abandoned
    }
}
```

**Kernel ensures clean abort via `break`:**

```typescript
for await (const response of iterable) {
    if (abort.signal.aborted) {
        break;  // Triggers iterator.return() → finally blocks run
    }
    // ...
}
```

**Cleanup chain:**

| Event | Kernel | HAL | Resources |
|-------|--------|-----|-----------|
| Normal completion | Loop ends | `finally` runs | Closed |
| `stream_cancel` | `break` | `finally` runs | Closed |
| Ping timeout | `break` | `finally` runs | Closed |
| Process death | All streams aborted | `finally` runs | Closed |

**Implementation requirement**: All HAL channel `handle()` methods must use try/finally for resource cleanup.

### HTTP Mid-Stream Errors

Streaming HTTP responses send status 200 before the body. If an error occurs mid-stream, the status code cannot be changed.

**Solution**: Errors are part of the stream. The JSONL body contains `Response` objects, including errors:

```
HTTP/1.1 200 OK
Content-Type: application/jsonl

{"op":"item","data":{"id":1,"name":"Alice"}}
{"op":"item","data":{"id":2,"name":"Bob"}}
{"op":"error","data":{"code":"EIO","message":"Database connection lost"}}
```

**Client handling:**

```typescript
for await (const line of response.body.lines()) {
    const r = JSON.parse(line) as Response;

    if (r.op === 'error') {
        const err = r.data as { code: string; message: string };
        throw new Error(`${err.code}: ${err.message}`);
    }
    if (r.op === 'done') {
        break;  // Success - stream complete
    }
    if (r.op === 'item') {
        process(r.data);
    }
}
```

**Outcome matrix:**

| Scenario | HTTP Status | Final `op` | Outcome |
|----------|-------------|------------|---------|
| Full success | 200 | `done` | Success |
| Empty result | 200 | `done` | Success (0 items) |
| Error before stream | 4xx/5xx | N/A | Failure (no body) |
| Error mid-stream | 200 | `error` | Partial data + Failure |

**Documentation requirement**: HTTP 200 means "streaming started", not "operation succeeded". Clients must consume the entire stream and check the final response to determine success.

This pattern is consistent with gRPC streaming, Server-Sent Events, and WebSocket protocols where errors can arrive at any point in the stream.

## Implementation Changes

### 1. Kernel Message Handler

**File**: `src/kernel/kernel.ts`

**Current**: `handleMessage()` awaits single result, sends single response.

**Change**: Iterate all yielded `Response` objects, send each as separate message.

```typescript
private async handleSyscall(proc: Process, request: SyscallRequest): Promise<void> {
    try {
        const iterable = this.syscalls.dispatch(proc, request.name, request.args);

        for await (const response of iterable) {
            proc.worker.postMessage({
                type: 'response',
                id: request.id,
                result: response,
            });

            // Terminal ops end the stream
            if (response.op === 'ok' || response.op === 'done' || response.op === 'error') {
                return;
            }
        }
    } catch (error) {
        // Uncaught exceptions become error responses
        proc.worker.postMessage({
            type: 'response',
            id: request.id,
            result: respond.error((error as any).code ?? 'EIO', (error as Error).message),
        });
    }
}
```

### 2. Syscall Dispatcher

**File**: `src/kernel/syscalls.ts`

**Current**: `dispatch()` returns `Promise<unknown>`.

**Change**: Returns `AsyncIterable<Response>`. All handlers become async generators.

```typescript
// Dispatcher signature
dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response>

// Handler signature
type SyscallHandler = (proc: Process, ...args: unknown[]) => AsyncIterable<Response>;
```

### 3. Syscall Handlers - Single Value

**File**: `src/kernel/syscalls.ts`

**Current**: Return value directly.

**Change**: Yield `respond.ok(value)`.

```typescript
// Before
async open(proc, path, flags): Promise<number> {
    const handle = await vfs.open(path, flags, proc.id);
    return allocateFd(proc, handle);
}

// After
async *open(proc, path, flags): AsyncIterable<Response> {
    const handle = await vfs.open(path, flags, proc.id);
    const fd = allocateFd(proc, handle);
    yield respond.ok(fd);
}
```

### 4. Syscall Handlers - Collections

**File**: `src/kernel/syscalls.ts`

**Current**: Return array.

**Change**: Yield items, then `done`.

```typescript
// Before
async readdir(proc, path): Promise<string[]> {
    const names: string[] = [];
    for await (const name of vfs.readdir(path, proc.id)) {
        names.push(name);
    }
    return names;
}

// After
async *readdir(proc, path): AsyncIterable<Response> {
    for await (const name of vfs.readdir(path, proc.id)) {
        yield respond.item(name);
    }
    yield respond.done();
}
```

### 5. Syscall Handlers - Channels

**File**: `src/kernel/syscalls.ts`

**Current**: `channel_call` returns single response, `channel_stream` returns array (broken).

**Change**: Both yield from channel's `handle()`. `channel_call` stops at first terminal response.

```typescript
// channel_call - yield until terminal
async *channel_call(proc, ch, msg): AsyncIterable<Response> {
    const channel = getChannel(proc, ch);
    for await (const response of channel.handle(msg)) {
        yield response;
        if (response.op === 'ok' || response.op === 'error') return;
    }
    yield respond.error('EIO', 'No response from channel');
}

// channel_stream - yield everything
async *channel_stream(proc, ch, msg): AsyncIterable<Response> {
    const channel = getChannel(proc, ch);
    yield* channel.handle(msg);
}
```

### 6. Userspace Transport - Streaming Support

**File**: `rom/lib/process.ts`

**Current**: Each syscall ID maps to single pending promise.

**Change**: Syscall IDs map to stream state. Multiple responses accumulate until terminal.

```typescript
interface StreamState {
    queue: Response[];
    resolve: (() => void) | null;
    done: boolean;
}

const streams = new Map<string, StreamState>();

// Message handler routes to stream state
self.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'response') {
        const stream = streams.get(msg.id);
        if (stream) {
            stream.queue.push(msg.result);
            if (msg.result.op === 'ok' || msg.result.op === 'done' || msg.result.op === 'error') {
                stream.done = true;
            }
            stream.resolve?.();
            stream.resolve = null;
        }
    }
};
```

### 7. Userspace Transport - Syscall Function

**File**: `rom/lib/process.ts`

**Current**: `syscall()` returns `Promise<T>`.

**Change**: `syscall()` returns `AsyncIterable<Response>`. Add convenience wrappers.

```typescript
// Core: yields Response objects
async function* syscall(name: string, ...args: unknown[]): AsyncIterable<Response> {
    const id = crypto.randomUUID();
    const stream: StreamState = { queue: [], resolve: null, done: false };
    streams.set(id, stream);

    try {
        self.postMessage({ type: 'syscall', id, name, args });

        while (true) {
            while (stream.queue.length === 0 && !stream.done) {
                await new Promise<void>(r => { stream.resolve = r; });
            }

            while (stream.queue.length > 0) {
                const response = stream.queue.shift()!;
                yield response;

                if (response.op === 'ok' || response.op === 'done' || response.op === 'error') {
                    return;
                }
            }

            if (stream.done) return;
        }
    } finally {
        streams.delete(id);
    }
}

// Convenience: unwrap single ok value
async function call<T>(name: string, ...args: unknown[]): Promise<T> {
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'ok') return response.data as T;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
    }
    throw new SyscallError('EIO', 'No response');
}

// Convenience: collect items to array
async function collect<T>(name: string, ...args: unknown[]): Promise<T[]> {
    const items: T[] = [];
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'item') items.push(response.data as T);
        if (response.op === 'done') return items;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
        if (response.op === 'ok') return [response.data as T]; // Single value as array
    }
    return items;
}

// Convenience: iterate items (hide Response wrapper)
async function* iterate<T>(name: string, ...args: unknown[]): AsyncIterable<T> {
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'item') yield response.data as T;
        if (response.op === 'ok') { yield response.data as T; return; }
        if (response.op === 'done') return;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
    }
}
```

### 8. Userspace API - Exported Functions

**File**: `rom/lib/process.ts`

**Current**: Functions return raw values or arrays.

**Change**: Functions use appropriate convenience wrapper. Add streaming variants.

```typescript
// Single-value syscalls use call()
export const open = (path: string, flags?: OpenFlags) => call<number>('open', path, flags);
export const stat = (path: string) => call<Stat>('stat', path);
export const getpid = () => call<number>('getpid');

// Collection syscalls use collect() by default, expose iterate() variant
export const readdir = (path: string) => collect<string>('readdir', path);
export const readdirStream = (path: string) => iterate<string>('readdir', path);

// Channel API
export const channel = {
    open: (proto: string, url: string, opts?: ChannelOpts) => call<number>('channel_open', proto, url, opts),
    call: <T>(ch: number, msg: Message) => call<Response>('channel_call', ch, msg),
    stream: (ch: number, msg: Message) => iterate<Response>('channel_stream', ch, msg),
    push: (ch: number, response: Response) => call<void>('channel_push', ch, response),
    recv: (ch: number) => call<Message>('channel_recv', ch),
    close: (ch: number) => call<void>('channel_close', ch),
};
```

### 9. Kernel-Side Userspace Library

**File**: `src/process/syscall.ts`, `src/process/channel.ts`

**Change**: Mirror the same patterns as `rom/lib/process.ts`. This library is used by code running directly in the kernel context (not in workers).

### 10. Response Helpers

**File**: `src/message.ts`

**Current**: `respond` object has helper functions.

**Change**: Ensure all streaming ops are covered.

```typescript
export const respond = {
    ok: <T>(data?: T): Response => ({ op: 'ok', data }),
    error: (code: string, message: string): Response => ({ op: 'error', data: { code, message } }),
    item: <T>(data: T): Response => ({ op: 'item', data }),
    chunk: (data: Uint8Array): Response => ({ op: 'chunk', data }),
    event: (type: string, data?: unknown): Response => ({ op: 'event', data: { type, ...data } }),
    progress: (current: number, total?: number): Response => ({ op: 'progress', data: { current, total } }),
    done: (): Response => ({ op: 'done' }),
    redirect: (location: string): Response => ({ op: 'redirect', data: { location } }),
};
```

## Files Requiring Changes

### Core Kernel

| File | Change |
|------|--------|
| `src/kernel/kernel.ts` | Iterate responses and send multiple messages; handle `stream_ping` and `stream_cancel`; track active streams per process with `AbortController`; enforce ping thresholds |
| `src/kernel/syscalls.ts` | All handlers become `async *`, return `AsyncIterable<Response>` |
| `src/kernel/types.ts` | Update `SyscallHandler` type; add `activeStreams` and `streamPingHandlers` to `Process` |

### Userspace Libraries

| File | Change |
|------|--------|
| `rom/lib/process.ts` | Stream-aware message handler; `syscall()` returns `AsyncIterable<Response>` with automatic ping and cancel; add `call()`/`collect()`/`iterate()` convenience wrappers |
| `src/process/syscall.ts` | Same changes as rom/lib for kernel-side userspace |
| `src/process/channel.ts` | Use new streaming primitives |

### HAL Layer

| File | Change |
|------|--------|
| `src/hal/channel.ts` | All `handle()` methods must use try/finally for resource cleanup (cursors, readers, connections) |

### Message Types

| File | Change |
|------|--------|
| `src/message.ts` | Verify `respond` helpers complete (likely minimal changes) |

### Kernel Message Types

New message types for stream lifecycle:

```typescript
// Userspace → Kernel: consumer liveness
{ type: 'stream_ping', id: string }

// Userspace → Kernel: stop producing, cleanup
{ type: 'stream_cancel', id: string }
```

### Process Type Additions

```typescript
interface Process {
    // ... existing fields ...

    /** Active streaming syscalls: request id → abort controller */
    activeStreams: Map<string, AbortController>;

    /** Ping handlers for active streams: request id → reset function */
    streamPingHandlers: Map<string, () => void>;
}
```

### Tests

| File | Change |
|------|--------|
| `src-spec/kernel/*.test.ts` | Update syscall expectations to handle streaming responses |
| `src-spec/kernel/stream.test.ts` | New: test stream lifecycle (ping, cancel, timeout) |
| `src-spec/process/*.test.ts` | Test streaming behavior and automatic ping |

## Syscall Conversion Reference

### Single-Value Syscalls (use `respond.ok`)

These yield once with `ok`:

- `open`, `close`, `read`, `write`, `seek`
- `stat`, `fstat`, `mkdir`, `unlink`, `rmdir`, `rename`, `symlink`
- `getpid`, `getppid`, `spawn`, `kill`, `wait`
- `getcwd`, `chdir`, `getenv`, `setenv`, `getargs`
- `connect`, `pipe`
- `channel_open`, `channel_call`, `channel_push`, `channel_recv`, `channel_close`
- `port`, `recv`, `send`, `pclose`
- `access` (both read and write variants)

### Collection Syscalls (use `respond.item` + `respond.done`)

These yield multiple items:

- `readdir` - yields directory entry names

### Streaming Syscalls (pass through `Response`)

These yield whatever the underlying source yields:

- `channel_stream` - yields from channel's `handle()`

### Future Candidates for Streaming

Operations that could benefit from streaming in the future:

- `read` - yield chunks for large files
- `watch` - yield events (currently uses ports)
- `glob` - yield matching paths

## Migration Strategy

### Phase 1: Transport Layer

1. Update `src/kernel/kernel.ts`:
   - Iterate and send multiple responses per syscall
   - Handle `stream_ping` message (reset liveness counters)
   - Handle `stream_cancel` message (abort stream, cleanup)
   - Track active streams per process with `AbortController`
   - Enforce ping thresholds (1000 items / 5s)
2. Update `src/kernel/types.ts`:
   - Add `activeStreams` and `streamPingHandlers` to `Process`
3. Update `rom/lib/process.ts`:
   - Accumulate responses into `AsyncIterable<Response>`
   - Automatic ping every 500 items
   - Send `stream_cancel` in finally block
4. Add `call()`, `collect()`, `iterate()` convenience functions
5. Existing syscalls continue to work (yield single `ok`)

### Phase 2: Syscall Handlers

1. Convert syscall handlers one by one to `async *` generators
2. Single-value handlers: yield `respond.ok(value)`
3. Collection handlers: yield `respond.item(x)` per item, then `respond.done()`
4. Channel handlers: yield from channel's `handle()`

### Phase 3: API Surface

1. Update exported functions to use appropriate wrapper
2. Add `*Stream` variants for collection syscalls
3. Update documentation and examples

### Phase 4: Tests

1. Update kernel syscall tests for streaming responses
2. Add stream lifecycle tests (ping, cancel, timeout)
3. Test automatic ping behavior in userspace
4. Verify backward compatibility

## Design Decisions

### Why Not Separate Message Types?

Could have used `{ type: 'stream_item' }` instead of `{ type: 'response', result: { op: 'item' } }`.

**Decision**: Reuse existing `Response` type because:
- Already has streaming semantics (`item`, `done`, `error`)
- Channels already yield `Response` objects
- One type to understand, not two
- Natural alignment with VFS message passing

### Why Terminal Ops?

The `ok`, `done`, `error` ops signal stream completion.

**Decision**: Explicit terminals because:
- Consumer knows when to stop iterating
- Error handling is unambiguous
- Distinguishes "empty result" from "no response yet"
- Matches existing `Response` semantics

### Why Convenience Wrappers?

Most code doesn't want to handle `Response` objects directly.

**Decision**: Layer conveniences on top because:
- `call()` for simple request/response
- `collect()` for "give me an array"
- `iterate()` for "give me items without Response wrapper"
- Raw `syscall()` available for full control

### Why Progress-Based Backpressure?

We chose time-based progress pings over explicit pause/resume messages.

**Decision**: Progress-based backpressure because:
- Consumer reports `processed` count every 100ms
- Kernel calculates gap (`itemsSent - itemsAcked`)
- Kernel pauses at high-water (1000), resumes at low-water (100)
- No explicit pause/resume messages needed
- Naturally adapts to consumer speed
- Single message type serves both liveness and backpressure

## Example: End-to-End Flow

### Database Query Streaming

```typescript
// Userspace
const db = await channel.open('postgres', 'postgresql://localhost/mydb');

for await (const response of channel.stream(db, sqlQuery('SELECT * FROM users'))) {
    if (response.op === 'item') {
        console.log('Row:', response.data);
    }
}

// Kernel syscall handler
async *channel_stream(proc, ch, msg): AsyncIterable<Response> {
    const channel = getChannel(proc, ch);
    yield* channel.handle(msg);  // PostgreSQL channel yields rows as items
}

// HAL channel
async *handle(msg: Message): AsyncIterable<Response> {
    const result = await db.query(msg.data.sql);
    for (const row of result) {
        yield respond.item(row);
    }
    yield respond.done();
}

// Wire: 4 messages sent to worker
{ type: 'response', id: 'x', result: { op: 'item', data: { id: 1, name: 'Alice' } } }
{ type: 'response', id: 'x', result: { op: 'item', data: { id: 2, name: 'Bob' } } }
{ type: 'response', id: 'x', result: { op: 'item', data: { id: 3, name: 'Carol' } } }
{ type: 'response', id: 'x', result: { op: 'done' } }
```

### HTTP JSONL Output

```typescript
// API route
export async function GET(ctx: Context): Promise<Response> {
    const ch = await channel.open('postgres', DB_URL);
    const stream = channel.stream(ch, sqlQuery(ctx.query.sql));

    // Stream responses directly to HTTP
    const body = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            for await (const response of stream) {
                if (response.op === 'item') {
                    controller.enqueue(encoder.encode(JSON.stringify(response.data) + '\n'));
                }
            }
            controller.close();
            await channel.close(ch);
        }
    });

    return new Response(body, {
        headers: { 'Content-Type': 'application/jsonl' }
    });
}
```

The internal stream format *is* the JSONL format. No conversion needed.

## Implementation Feedback

### What Worked Well

1. **`respond.*` helpers** - Clean, readable handler code. `yield respond.ok(value)` is immediately understandable.

2. **Convenience wrappers** - The `call()`, `collect()`, `iterate()` functions hide streaming complexity. Most code doesn't need to know about `Response` objects.

3. **Minimal kernel changes** - The streaming logic is contained in `handleSyscall()`. The rest of the kernel is largely unchanged.

4. **Test compatibility** - Adding `unwrapStream()` helper allowed existing tests to work with minimal changes.

### Design Refinements During Implementation

1. **Backpressure added** - Original spec deferred backpressure. We added it using time-based progress pings. The `processed` count in pings enables kernel-side gap calculation and automatic pausing.

2. **Time-based over item-based** - Original spec used item-count thresholds (ping every 500 items). Changed to time-based (ping every 100ms) which naturally adapts to consumer speed.

3. **Error handling via yield** - Syscall handlers use `yield respond.error()` instead of throwing. Cleaner than try/catch wrapping and consistent with the streaming model.

### Potential Future Improvements

1. **True streaming for reads** - File `read()` still returns full buffer. Could yield `chunk` responses for large files.

2. **Progress integration** - Channels that support progress (HTTP uploads) could yield `progress` responses. Current wrappers ignore them.

3. **Redirect auto-follow** - The `redirect` response op exists but userspace doesn't auto-follow. May need explicit handling for HTTP-style redirects.

4. **Cancel on normal completion** - Currently `stream_cancel` is always sent in finally block, even on normal completion. Harmless but wasteful. Could track completion state.

### Constants Tuning

Current values are reasonable defaults but may need adjustment based on real-world usage:

| Constant | Value | Notes |
|----------|-------|-------|
| `STREAM_HIGH_WATER` | 1000 | May need increase for very fast producers |
| `STREAM_LOW_WATER` | 100 | Determines resume granularity |
| `STREAM_PING_INTERVAL` | 100ms | Balance between responsiveness and overhead |
| `STREAM_STALL_TIMEOUT` | 5000ms | May need increase for legitimately slow consumers |
