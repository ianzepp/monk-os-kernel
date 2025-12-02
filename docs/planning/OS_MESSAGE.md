# OS Message Architecture

## Overview

This document outlines the message-oriented architecture for Monk OS, where all internal communication uses structured messages rather than byte streams. Byte serialization only occurs at true I/O boundaries (disk, network).

## Design Principles

1. **Messages everywhere**: All internal communication uses `Message` and `Response` objects
2. **Kernel is message-pure**: No byte conversion or JSON serialization in kernel code
3. **Boundaries handle encoding**: Only FileHandleAdapter (disk) and SocketHandleAdapter (network) deal with bytes
4. **Uniform operations**: All handles use `recv`/`send`/`stat`/`close` ops
5. **Structured response data**: `Response.data` is always a structured object, never raw primitives

## Message Format

### Request Message

```typescript
interface Message {
    op: string;           // Operation: 'recv', 'send', 'stat', 'close', etc.
    data?: unknown;       // Operation-specific structured data
}
```

### Response Message

```typescript
interface Response {
    op: 'ok' | 'error' | 'item' | 'chunk' | 'event' | 'progress' | 'done' | 'redirect';
    data?: object;        // Always a structured object
}
```

### Response Types

| Type | Data Shape | Usage |
|------|------------|-------|
| `ok` | `{ ... }` | Success with optional result |
| `error` | `{ code: string, message: string }` | Error with code and message |
| `item` | `{ ... }` | Single item in a stream |
| `chunk` | `{ bytes: Uint8Array }` | Byte data (only at I/O boundaries) |
| `event` | `{ type: string, ... }` | Async event notification |
| `progress` | `{ percent?, current?, total? }` | Progress update |
| `done` | `{}` | Stream complete |
| `redirect` | `{ location, permanent?, reason? }` | Redirect to another location |

**Key change**: `chunk.data` is `{ bytes: Uint8Array }`, not raw `Uint8Array`.

## Handle Architecture

All I/O primitives implement the `Handle` interface:

```typescript
interface Handle {
    readonly id: string;
    readonly type: HandleType;
    readonly description: string;
    readonly closed: boolean;
    exec(msg: Message): AsyncIterable<Response>;  // Execute a message/command
    close(): Promise<void>;
}
```

**Key naming**: `exec` (not `send`) avoids collision with `msg.op = 'send'`.

### Unified Operations

All handles respond to the same core operations:

| Op | Description | Request Data | Response |
|----|-------------|--------------|----------|
| `recv` | Receive next message | `{ chunkSize? }` | `item` or `chunk` stream |
| `send` | Send message through handle | `{ ... }` | `ok` with result |
| `stat` | Get metadata | none | `ok` with handle info |
| `close` | Close handle | none | `ok` |

Handle-specific operations (e.g., `seek` for files) extend this base set.

### Usage Pattern

```typescript
// Receive from a handle
handle.exec({ op: 'recv' })

// Send through a handle
handle.exec({ op: 'send', data: { ... } })

// Get handle info
handle.exec({ op: 'stat' })
```

## Data Flow by Handle Type

### FileHandleAdapter (True I/O Boundary)

```
recv: VFS reads bytes from disk → respond.chunk({ bytes })
send: Message with { bytes } → VFS writes to disk
```

Files are a true I/O boundary. Bytes are expected and appropriate here.

### SocketHandleAdapter (True I/O Boundary)

```
recv: HAL reads bytes from network → respond.chunk({ bytes })
send: Message with { bytes } → HAL writes to network
```

Network is a true I/O boundary. Bytes are expected and appropriate here.

### PortHandleAdapter (Internal Message Passing)

```
recv: Port.recv() → respond.item({ from, data?, meta? })
send: Message → Port.send()
```

Ports (pubsub, watch, udp) return structured `PortMessage` objects:

```typescript
interface PortMessage {
    from: string;                    // Source identifier (topic, address, path)
    data?: Uint8Array;               // Optional binary payload (UDP only)
    meta?: Record<string, unknown>;  // Optional metadata
}
```

**Note**: `PortMessage.data` may contain bytes for UDP (network boundary), but pubsub/watch messages can be purely structured via `meta`.

### PipeHandleAdapter (Internal Message Passing)

```
recv: Pipe.recv() → respond.item({ ... })
send: Message → Pipe.send()
```

Pipes pass structured messages between processes. No byte conversion.

### ProcessIOHandle (Message Router)

```
recv: Forward to source.exec({ op: 'recv' }) → return source's response
send: Forward to target.exec({ op: 'send', data }) → return target's response
      Also queue to taps (non-blocking)
```

ProcessIOHandle is purely a router. It doesn't inspect or transform message content.

## Service I/O Configuration

Services declare their I/O routing in the service definition:

```json
{
    "handler": "/bin/logd",
    "activate": { "type": "boot" },
    "io": {
        "stdin": { "type": "pubsub", "subscribe": ["log.*"] },
        "stdout": { "type": "file", "path": "/var/log/system.log" }
    }
}
```

The kernel wires ProcessIOHandle based on this configuration:
- `stdin.source` = PortHandleAdapter wrapping pubsub port
- `stdout.target` = FileHandleAdapter wrapping log file

## Example: logd Service

### Message Flow

```
Publisher                    Kernel                      logd                    Disk
    |                          |                          |                       |
    |--publish(log.kernel)---->|                          |                       |
    |                          |                          |                       |
    |                          |  logd.exec({ op:'recv' })|                       |
    |                          |<-------------------------|                       |
    |                          |                          |                       |
    |                          |--respond.item({-------->|                       |
    |                          |    from: "log.kernel",   |                       |
    |                          |    meta: { level, msg }})|                       |
    |                          |                          |                       |
    |                          |                          |--format to string-----|
    |                          |                          |                       |
    |                          |<--exec({ op:'send',------|                       |
    |                          |    data:{ bytes } })     |                       |
    |                          |                          |                       |
    |                          |--------------------------|----bytes to disk----->|
```

### logd Implementation

```typescript
import { recv, send } from '/lib/process';

// Receive structured messages from stdin (pubsub source)
for await (const response of recv(0)) {
    if (response.op === 'item') {
        const msg = response.data as PortMessage;

        // Format log entry (userspace responsibility)
        const line = `[${new Date().toISOString()}] [${msg.from}] ${msg.meta?.message}\n`;

        // Send bytes to stdout (file target) - encoding in userspace
        await send(1, { bytes: new TextEncoder().encode(line) });
    }
}
```

**Key points**:
- logd receives structured `PortMessage` objects, not JSON strings
- Text encoding (`TextEncoder`) happens in userspace, not kernel
- Kernel just routes messages; FileHandleAdapter writes bytes to disk

## Migration: Removed Components

### PortSourceAdapter (DELETED)

Previously wrapped a Port to present as byte-stream source by:
1. Calling `port.recv()` to get `PortMessage`
2. Serializing to JSON string
3. Encoding to bytes
4. Returning as `respond.chunk()`

This violated the "kernel is message-pure" principle. Deleted in favor of using PortHandleAdapter directly.

## Code Changes Required

### message.ts

```typescript
// Before
export interface Responses.Chunk extends Response {
    op: 'chunk';
    data: Uint8Array;
}

// After
export interface Responses.Chunk extends Response {
    op: 'chunk';
    data: {
        bytes: Uint8Array;
    };
}

// Update helper
export const respond = {
    chunk: (bytes: Uint8Array): Responses.Chunk => ({
        op: 'chunk',
        data: { bytes }
    }),
    // ...
};
```

### FileHandleAdapter

```typescript
// Before
yield respond.item(chunk);  // chunk is Uint8Array

// After
yield respond.chunk(chunk);  // Uses updated respond.chunk()
```

### Handle interface (types.ts)

```typescript
// Before
send(msg: Message): AsyncIterable<Response>;

// After
exec(msg: Message): AsyncIterable<Response>;
```

### PortHandleAdapter

```typescript
// Use recv/send ops (already matches internal port.recv()/port.send())
case 'recv':
    const msg = await this.port.recv();
    yield respond.item(msg);  // Structured PortMessage
    break;

case 'send':
    await this.port.send(data.to, data.data);
    yield respond.ok();
    break;
```

### FileHandleAdapter

```typescript
// Rename read → recv, write → send
case 'recv':
    // ... existing read logic
    yield respond.chunk(bytes);
    break;

case 'send':
    // ... existing write logic
    yield respond.ok({ written });
    break;
```

### ProcessIOHandle

```typescript
// Update to use exec() and recv/send ops
private async *recv(msg: Message): AsyncIterable<Response> {
    if (!this.source) {
        yield respond.error('EBADF', 'No source configured');
        return;
    }
    yield* this.source.exec(msg);  // Forward recv to source
}

private async *send(msg: Message): AsyncIterable<Response> {
    if (!this.target) {
        yield respond.error('EBADF', 'No target configured');
        return;
    }
    // Send to target
    for await (const response of this.target.exec(msg)) {
        yield response;
    }
    // Queue to taps
    for (const entry of this.taps.values()) {
        entry.queue.push(msg);
    }
}
```

### Userspace (rom/lib/process)

```typescript
// Receive returns Response stream
export async function* recv(fd: number): AsyncIterable<Response> {
    const handle = getHandle(fd);
    yield* handle.exec({ op: 'recv' });
}

// Send accepts structured data
export async function send(fd: number, data: object): Promise<void> {
    const handle = getHandle(fd);
    for await (const response of handle.exec({ op: 'send', data })) {
        if (response.op === 'ok') return;
        if (response.op === 'error') throw new Error(response.data.message);
    }
}
```

## Open Questions

### 1. Should ports still have `data: Uint8Array`?

For UDP, yes - network is a true I/O boundary. For pubsub/watch, messages could be purely structured:

```typescript
// UDP message (has bytes from network)
{ from: "192.168.1.1:5000", data: Uint8Array }

// Pubsub message (purely structured)
{ from: "log.kernel", meta: { level: "info", message: "Boot complete" } }

// Watch message (purely structured)
{ from: "/etc/config.json", meta: { event: "modify" } }
```

### 2. Should we unify PortMessage into Response.Item?

Could simplify by having ports return standard `Response.Item` with typed data:

```typescript
respond.item({
    type: 'pubsub',
    from: 'log.kernel',
    meta: { level: 'info' }
})
```

### 3. Line-based reading utilities?

Many processes want line-based input. This could be a userspace utility:

```typescript
// Userspace helper that buffers chunks and yields lines
export async function* recvLines(fd: number): AsyncIterable<string> {
    let buffer = '';
    for await (const response of recv(fd)) {
        if (response.op === 'chunk') {
            buffer += new TextDecoder().decode(response.data.bytes);
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) yield line;
        } else if (response.op === 'item') {
            // Structured message - yield as JSON line?
            yield JSON.stringify(response.data);
        }
    }
    if (buffer) yield buffer;
}
```

## Implementation Impact

### Core Changes

| File | Changes |
|------|---------|
| `src/message.ts` | `Chunk.data: Uint8Array` → `{ bytes: Uint8Array }` |
| `src/kernel/handle/types.ts` | `send()` → `exec()` |

### Handle Implementations (7 files)

| File | Changes |
|------|---------|
| `src/kernel/handle/file.ts` | `send→exec`, `read→recv`, `write→send` |
| `src/kernel/handle/socket.ts` | `send→exec`, `read→recv`, `write→send` |
| `src/kernel/handle/pipe.ts` | `send→exec`, `read→recv`, `write→send` |
| `src/kernel/handle/port.ts` | `send→exec` (already uses `recv`/`send` ops) |
| `src/kernel/handle/channel.ts` | `send→exec` (already uses `recv`/`send` ops) |
| `src/kernel/handle/process-io.ts` | `send→exec`, `read→recv`, `write→send`, forward calls |
| `src/kernel/handle/port-source.ts` | **DELETE** (unnecessary adapter) |

### Kernel & Syscalls

| File | Changes |
|------|---------|
| `src/kernel/kernel.ts` | `handle.send()` → `handle.exec()` |
| `src/kernel/syscalls/file.ts` | `op: 'read'/'write'` → `'recv'/'send'` |
| `src/vfs/message.ts` | `op: 'read'/'write'` → `'recv'/'send'` |

### Tests

**Needs changes:**

| File | Changes |
|------|---------|
| `spec/kernel/process-io-handle.test.ts` | `handle.send()` → `handle.exec()`, `op: 'read'/'write'` → `'recv'/'send'` (~20 occurrences) |
| `spec/kernel/resource.test.ts` | Review pubsub tests that pass `Uint8Array` data |

**Example transformation:**

```typescript
// Before
handle.send({ op: 'read' })
handle.send({ op: 'write', data: { data: new Uint8Array([1]) } })
handle.send({ op: 'stat' })

// After
handle.exec({ op: 'recv' })
handle.exec({ op: 'send', data: { data: new Uint8Array([1]) } })
handle.exec({ op: 'stat' })
```

**Tests that are fine (at boundaries):**

| File | Reason |
|------|--------|
| `spec/hal/*.test.ts` | HAL layer - bytes expected |
| `spec/vfs/*.test.ts` | VFS layer - bytes expected |
| `spec/kernel/loader.test.ts` | Loading files - bytes expected |
| `spec/kernel/network.test.ts` | Network - bytes expected |
| `spec/kernel/boot.test.ts` | File writing - bytes expected |
| `spec/rom/io.test.ts` | Byte stream utilities - bytes expected |

### Userspace

| File | Changes |
|------|---------|
| `rom/bin/logd.ts` | Rewrite to use message model |
| `rom/lib/process/*.ts` | Update I/O helpers if they reference ops |

### Totals

- **~12 source files** to modify
- **1 file to delete** (port-source.ts)
- **2 test files** to update
- **~2 userspace files** to update

### JSON.stringify Usage Audit

**Appropriate (at boundaries):**

| File | Usage | Reason |
|------|-------|--------|
| `src/hal/channel/http.ts` | Request body | Network boundary |
| `src/hal/channel/websocket.ts` | WS messages | Network boundary |
| `src/hal/channel/sse.ts` | SSE events | Network boundary |
| `src/vfs/models/*.ts` | Entity storage | Storage boundary |
| `src/kernel/kernel.ts:666` | Debug logging | Fine |

**Needs review:**

| File | Usage | Issue |
|------|-------|-------|
| `src/kernel/resource/watch-port.ts:66` | Watch event → Uint8Array | Serializing internal message |
| `src/kernel/handle/port-source.ts:62` | PortMessage → JSON | **DELETE** |

### Uint8Array Usage Audit

**Appropriate (true boundaries):**

- `src/hal/*` - All HAL (network, storage, console, crypto)
- `src/vfs/*` - File storage operations
- `src/kernel/resource/udp-port.ts` - Network boundary
- `src/kernel/resource/pipe-buffer.ts` - Low-level pipe impl

**Needs review:**

| File | Usage | Issue |
|------|-------|-------|
| `src/message.ts:59` | `Chunk.data: Uint8Array` | Change to `{ bytes }` |
| `src/vfs/message.ts:44,107` | VFS message types | May need structured data option |
| `src/kernel/resource/pubsub-port.ts` | `data: Uint8Array` | Internal messages shouldn't require bytes |
| `src/kernel/resource/watch-port.ts` | `data: Uint8Array` | Internal messages shouldn't require bytes |
| `src/process/index.ts` | `read()`/`write()` API | Userspace API assumes bytes |

### PortMessage.data Question

```typescript
interface PortMessage {
    from: string;
    data?: Uint8Array;  // <-- Should this be optional/structured for pubsub/watch?
    meta?: Record<string, unknown>;
}
```

| Port Type | `data` field | Reason |
|-----------|--------------|--------|
| UDP | `Uint8Array` required | Network boundary, bytes expected |
| Pubsub | Optional, use `meta` | Internal message passing, structured |
| Watch | Optional, use `meta` | Internal message passing, structured |

Recommendation: Keep `data?: Uint8Array` for network ports (UDP), but pubsub/watch should primarily use `meta` for structured data. The `data` field becomes optional and only used when raw bytes are actually needed.

## Summary

| Layer | Handles | Notes |
|-------|---------|-------|
| HAL | Bytes | True I/O boundary (disk, network, console) |
| VFS | Bytes | File system operations |
| FileHandleAdapter | Bytes ↔ Messages | Boundary adapter |
| SocketHandleAdapter | Bytes ↔ Messages | Boundary adapter |
| PortHandleAdapter | Messages | Structured PortMessage |
| PipeHandleAdapter | Messages | Structured inter-process |
| ProcessIOHandle | Messages | Pure router, no transformation |
| Kernel | Messages | No byte conversion, no JSON |
| Userspace | Either | Encoding is userspace responsibility |
