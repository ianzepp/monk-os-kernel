# Process I/O Architecture

How Monk OS mediates process stdin/stdout/stderr.

## Overview

`ProcessIOHandle` acts as a kernel-controlled intermediary between processes and their I/O destinations. It enables:

- **Routing**: Direct process output to different destinations
- **Tapping**: Observe process I/O without modifying the process (tee behavior)
- **Injection**: Send input to processes from external sources

This is analogous to shell redirects (`| > >> <`) but at the handle level, controlled by the kernel rather than the shell.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Process (inside OS)                                            │
│                                                                 │
│  write(1, "hello")  ─────►  fd 1                                │
│                              │                                  │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  ProcessIOHandle                                                │
│                                                                 │
│  ┌─────────┐     ┌────────────────────────────────────────┐    │
│  │ source  │     │ target                                 │    │
│  │ (reads) │     │ (writes go here synchronously)         │    │
│  └─────────┘     └────────────────────────────────────────┘    │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ taps (async queues)                                    │    │
│  │                                                        │    │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                │    │
│  │  │ Queue 1 │  │ Queue 2 │  │ Queue 3 │  ...           │    │
│  │  │  ▼      │  │  ▼      │  │  ▼      │                │    │
│  │  │ Drain   │  │ Drain   │  │ Drain   │                │    │
│  │  │ Loop    │  │ Loop    │  │ Loop    │                │    │
│  │  └─────────┘  └─────────┘  └─────────┘                │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Writes:**
1. Process writes to fd (e.g., stdout)
2. `ProcessIOHandle.send({ op: 'write', data })` is called
3. Message sent to `target` synchronously (caller waits for response)
4. Message pushed to all tap queues instantly (non-blocking)
5. Each tap's drain loop processes messages independently

**Reads:**
1. Process reads from fd (e.g., stdin)
2. `ProcessIOHandle.send({ op: 'read' })` is called
3. Message forwarded to `source`, responses returned to caller

---

## Tap Queue Model

Each tap has its own async queue and independent drain loop:

```typescript
class TapQueue<T> {
    push(item: T): boolean;   // Instant, non-blocking
    pull(): Promise<T | null>; // Waits if empty, null if closed
    close(): void;             // Stops drain loop
}
```

**Benefits:**
- Slow taps (network logging) don't block fast targets (console)
- Each tap processes at its own pace
- Natural backpressure point (queue depth)

**Monitoring:**
```typescript
handle.getTapQueueDepth(tap); // Check queue backlog
```

---

## Use Cases

### 1. Mirror OS console to host console

```typescript
const os = new OS();
await os.boot({ main: '@app/server.ts' });

// Watch /dev/console output
os.watch('/dev/console', (event) => {
    process.stdout.write(event.data);
});
```

### 2. Tap specific process stdout

```typescript
// Tap PID 1's stdout
const tap = createTapHandle();
kernel.getProcessIOHandle(1, 'stdout').addTap(tap);
```

### 3. Debug process I/O

```typescript
// Log all writes with metadata
handle.addTap({
    async *send(msg) {
        console.log(`[${Date.now()}] write: ${msg.data.data.length} bytes`);
        yield respond.ok();
    }
});
```

---

## API

### ProcessIOHandle

```typescript
class ProcessIOHandle implements Handle {
    readonly type: 'process-io';

    // Configuration
    setTarget(handle: Handle | null): void;
    getTarget(): Handle | null;
    setSource(handle: Handle | null): void;
    getSource(): Handle | null;

    // Tap management
    addTap(handle: Handle): void;    // Starts drain loop
    removeTap(handle: Handle): void; // Stops drain loop
    getTaps(): Set<Handle>;
    getTapQueueDepth(handle: Handle): number;

    // Message handling
    send(msg: Message): AsyncIterable<Response>;
    close(): Promise<void>;
}
```

### Supported Operations

| Op | Behavior |
|----|----------|
| `read` | Forward to source, return responses |
| `write` | Send to target (sync) + queue to taps (async) |
| `stat` | Return handle info (hasTarget, hasSource, tapCount) |

---

## Known Issues

### Critical

| Issue | Risk | Mitigation |
|-------|------|------------|
| **Unbounded queue** | Slow tap + fast writer = OOM | TODO: Add max queue size with drop policy |
| **Message mutation** | Same Message object passed to target + all taps; mutations leak between handlers | TODO: Clone messages before dispatch |
| **No drain await on close** | `close()` doesn't wait for drain loops to complete; zombie async operations | TODO: Track and await drain promises |

### Operational

| Issue | Risk | Mitigation |
|-------|------|------------|
| **Silent tap failures** | Errors swallowed, no logging, no alerting | TODO: Error callback or event emission |
| **No bad-tap detection** | Tap can fail forever, never auto-removed | TODO: Failure counter, auto-remove threshold |
| **No backpressure signal** | Writer has no way to know taps are behind | TODO: Expose queue health metrics |

### Concurrency

| Issue | Risk | Mitigation |
|-------|------|------------|
| **Race on close** | `push()` and `close()` can race | Low risk: push returns false if closed |
| **Drain mid-send on close** | Drain loop may be mid-send() when queue closes | Low risk: send completes, next pull returns null |

---

## Future Work

- [ ] Queue limits with configurable drop policy (oldest, newest, error)
- [ ] Message cloning option
- [ ] Await drain loops on close
- [ ] Tap error callbacks / events
- [ ] Auto-remove failing taps
- [ ] Metrics: messages processed, errors, latency per tap
- [ ] Integration with `/proc/<pid>/stdout` virtual files
- [ ] Wire up to kernel process spawning

---

## References

- `src/kernel/handle.ts` - ProcessIOHandle implementation
- `spec/kernel/process-io-handle.test.ts` - 30 tests
- `planning/OS_BOOT_EXEC.md` - OS boot/execution model
