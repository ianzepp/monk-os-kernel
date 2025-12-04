# OS Pipes & Stream Architecture

## Current State

Pipes use a **message-first architecture** via `MessagePipe` (`src/kernel/resource/message-pipe.ts`). This design passes `Response` objects directly rather than serializing to bytes, enabling structured message passing with built-in backpressure and EOF signaling.

### MessagePipe Features

- **Unidirectional**: Separate `recv` and `send` ends sharing a `MessageQueue`
- **Bounded capacity**: `highWaterMark` (default 1000) with `EAGAIN` backpressure
- **Explicit EOF**: `null` return signals EOF, `EPIPE` for broken pipe
- **Handle-based**: Implements `Handle` interface for kernel integration

```typescript
const [recvEnd, sendEnd] = createMessagePipe('pipe123');
// recvEnd given to consumer process
// sendEnd given to producer process
```

---

## Kernel-Level Issues (Still Applicable)

These issues are in the kernel/syscall layer, not MessagePipe itself:

### 1. Stall Detection Conflates Producer/Consumer

**Problem**: The kernel's `handleSyscall` uses a single `lastPingTime` to detect unresponsive consumers. But this fires incorrectly when the *producer* is slow (e.g., pipe waiting for writer).

**Current Fix** (kernel.ts:662-694):
```typescript
// Only check stall if we've sent items
if (itemsSent > 0 && Date.now() - lastPingTime >= STREAM_STALL_TIMEOUT) { ... }

// Reset ping timer on first item
if (itemsSent === 1) {
    lastPingTime = Date.now();
}
```

**Better Design**: Separate producer activity tracking from consumer responsiveness:
- Producer timeout: time since syscall started with no items produced
- Consumer timeout: time since last ping after items were sent
- Different timeouts for each (producer can be slow, consumer should be fast)

### 2. Arbitrary Timing Constants

**Location**: src/kernel/types.ts:154-157
```typescript
export const STREAM_HIGH_WATER = 1000;     // Pause when this many items unacked
export const STREAM_LOW_WATER = 100;       // Resume when gap falls to this
export const STREAM_STALL_TIMEOUT = 5000;  // Abort if no ping for this long
```

**Location**: rom/lib/process/syscall.ts
```typescript
const PING_INTERVAL_MS = 100;
```

**Concerns**:
- 5s timeout too short for slow operations (large file copies, network)
- 5s timeout too long for interactive use (user waits 5s before error)
- No adaptive tuning based on observed latency

**Potential Improvements**:
- Per-syscall timeout hints
- Adaptive ping intervals based on RTT

---

## Won't Implement (Byte-First Pipe Design)

The following items from the original design assumed a byte-oriented `PipeBuffer`. With the message-first `MessagePipe` architecture, these are no longer applicable:

### ~~Resource Type Leakage in Syscalls~~

**Original Problem**: The `read` syscall checks `resource.type === 'file'` to decide EOF semantics.

**Why Won't Implement**: MessagePipe doesn't use byte-level `read()`. It uses `Handle.exec()` with `recv`/`send` ops. EOF is explicit (`null` return), not inferred from read size.

### ~~Implicit EOF Semantics~~

**Original Problem**: EOF signaled by zero-length read, hard to distinguish from empty data.

**Why Won't Implement**: MessagePipe has explicit EOF:
- `queue.recv()` returns `null` for EOF
- `respond.done()` signals stream completion
- `EPIPE` error for broken pipe

### ~~Pipe Capacity Limits (PipeBuffer)~~

**Original Problem**: `PipeBuffer` has no size limit, could exhaust memory.

**Why Won't Implement**: MessagePipe has bounded `MessageQueue` with `highWaterMark`. Throws `EAGAIN` when full, enabling explicit backpressure handling.

### ~~Memory-Based Backpressure~~

**Original Suggestion**: Use bytes instead of item count for backpressure.

**Why Won't Implement**: MessagePipe passes `Response` objects, not raw bytes. Item-based backpressure is appropriate for message-oriented pipes. Large payloads should be chunked at the application level.

---

## Reference Counting

Current implementation in kernel.ts seems correct but subtle:

1. Pipe created: implicit refcount 1 (no entry in resourceRefs)
2. Child spawned with pipe fd: `refResource()` increments to 2
3. Parent closes its fd: `unrefResource()` decrements to 1
4. Child exits: `unrefResource()` decrements to 0, resource closed

**Risk**: The implicit "1" default in `refResource()` relies on resources always being created with exactly one reference. If a resource is created but never assigned to an fd, it leaks.

**Improvement**: Explicit initial refcount when resources are created:
```typescript
this.resources.set(resource.id, resource);
this.resourceRefs.set(resource.id, 1);  // Explicit
```

---

## Test Coverage Gaps

No integration tests for:
- Pipes with slow producers
- Pipes with fast producers (backpressure / EAGAIN handling)
- Multiple pipes in a pipeline (`a | b | c`)
- Pipe with process that ignores stdin
- Broken pipe handling (reader exits early, EPIPE)

---

## Future Considerations

### Bidirectional Channels

MessagePipe is intentionally unidirectional. For bidirectional communication (shell job control, pseudo-terminals), use two pipes or a different channel type.

### Named Pipes (FIFOs)

Not implemented. Would require VFS integration for `/dev/fifo/*` or similar. Low priority given message-based IPC alternatives.

### Signal Integration

`SIGPIPE` should be sent when writing to a pipe with no readers. Currently MessagePipe throws `EPIPE` error directly. Signal delivery would require kernel signal infrastructure.

---

## Implementation Reference

- **MessagePipe**: `src/kernel/resource/message-pipe.ts`
- **Handle types**: `src/kernel/handle/types.ts`
- **Kernel integration**: `src/kernel/kernel.ts`
