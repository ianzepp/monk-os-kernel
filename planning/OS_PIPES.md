# OS Pipes & Stream Architecture

## Current State

Pipes work for basic cases (`ls -l | sort`) after fixes in 6.1, but the underlying architecture has design debt.

## Issues Discovered

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

### 2. Resource Type Leakage in Syscalls

**Problem**: The `read` syscall checks `resource.type === 'file'` to decide EOF semantics (syscalls.ts:167-170):

```typescript
// Short read indicates EOF for files, not for sockets/pipes
if (resource.type === 'file' && chunk.length < size) {
    break;
}
```

**Better Design**: Resources should encapsulate their own EOF semantics:
```typescript
interface Resource {
    read(size?: number): Promise<Uint8Array>;
    isEOF(): boolean;  // Resource knows when it's exhausted
}
```

Or use a sentinel value / wrapper type:
```typescript
type ReadResult = { data: Uint8Array; eof: boolean };
```

### 3. Arbitrary Timing Constants

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
- 1000 high-water mark assumes small items; could OOM with large chunks
- No adaptive tuning based on observed latency

**Potential Improvements**:
- Per-syscall timeout hints
- Adaptive ping intervals based on RTT
- Memory-based backpressure (bytes, not items)

### 4. Implicit EOF Semantics

**Problem**: EOF is signaled by:
- Zero-length read for resources
- `respond.done()` for syscall streams
- Pipe write-end closing

No explicit EOF marker in the protocol. This works but:
- Hard to distinguish EOF from empty data
- No way to signal "pause" vs "done"
- Error vs EOF requires checking response.op

**Potential Improvement**: Explicit stream states
```typescript
type StreamItem =
    | { type: 'data'; payload: Uint8Array }
    | { type: 'eof' }
    | { type: 'error'; code: string; message: string }
    | { type: 'pause'; resumeAfter?: number };
```

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

## Test Coverage Gaps

No integration tests for:
- Pipes with slow producers
- Pipes with fast producers (backpressure)
- Multiple pipes in a pipeline (`a | b | c`)
- Pipe with process that ignores stdin
- Broken pipe handling (reader exits early)

## Future Considerations

### Bidirectional Pipes
Current pipes are unidirectional. Shell job control, pseudo-terminals, and interactive programs may need bidirectional channels.

### Named Pipes (FIFOs)
Not implemented. Would require VFS integration for `/dev/fifo/*` or similar.

### Pipe Capacity Limits
Current `PipeBuffer` has no size limit. Large writes could exhaust memory. Should implement bounded buffers with blocking writes.

### Signal Integration
`SIGPIPE` should be sent when writing to a pipe with no readers. Currently throws `EPIPE` error directly.
