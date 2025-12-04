# Timer Port

> **Status**: Planning
> **Complexity**: Low
> **Dependencies**: None

A kernel port that emits periodic tick events, enabling interval-based scheduling with the standard `recv()` API.

---

## Motivation

Currently, periodic tasks require a sleep loop:

```typescript
while (true) {
    await doTask();
    await sleep(60_000);
}
```

This works but has issues:
- **Drift**: Task execution time adds to interval
- **Multiplexing**: Can't easily combine with other event sources
- **Cancellation**: Requires flag variable and check
- **API inconsistency**: Different pattern from WatchPort, PubsubPort

A timer port provides consistent event-driven scheduling:

```typescript
const timer = await port('timer', { interval: 60_000 });

for await (const tick of recv(timer)) {
    await doTask();
}
```

---

## Design

### Port Type

Add `'timer'` to `PortType` union in `src/kernel/types.ts`:

```typescript
export type PortType =
    | 'tcp:listen'
    | 'udp'
    | 'watch'
    | 'pubsub'
    | 'timer';  // NEW
```

### Options

```typescript
interface TimerPortOpts {
    /**
     * Interval between ticks in milliseconds.
     * Must be > 0.
     */
    interval: number;

    /**
     * If true, first tick fires immediately.
     * If false (default), first tick fires after interval.
     */
    immediate?: boolean;

    /**
     * Maximum number of ticks before auto-close.
     * If undefined, runs indefinitely until close().
     */
    count?: number;
}
```

### Message Format

```typescript
// PortMessage from timer port
{
    from: 'timer',
    meta: {
        tick: number;       // Tick count (1-indexed)
        scheduled: number;  // When tick was scheduled (ms timestamp)
        actual: number;     // When tick fired (ms timestamp)
        drift: number;      // actual - scheduled (ms)
    }
}
```

### Timing Semantics

Two common timing models:

| Model | Behavior | Use Case |
|-------|----------|----------|
| **Interval** | Next tick = previous tick + interval | Fixed rate, may drift if task slow |
| **Delay** | Next tick = task complete + interval | Fixed delay between tasks |

**Decision**: Use **interval** model (fixed rate).
- Matches `setInterval()` semantics developers expect
- Drift detection via `meta.drift` field
- If task takes longer than interval, ticks queue up (caller can skip)

---

## Implementation

### TimerPort Class

```typescript
// src/kernel/resource/timer-port.ts

import type { PortType } from '@src/kernel/types.js';
import { EBADF } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

export interface TimerPortOpts {
    interval: number;
    immediate?: boolean;
    count?: number;
}

export class TimerPort implements Port {
    readonly type: PortType = 'timer';
    readonly id: string;
    readonly description: string;

    private _closed = false;
    private tickCount = 0;
    private maxTicks: number | undefined;
    private interval: number;
    private immediate: boolean;

    private messageQueue: PortMessage[] = [];
    private waiters: Array<(msg: PortMessage) => void> = [];
    private timerHandle: Timer | null = null;
    private startTime: number;
    private nextScheduled: number;

    constructor(id: string, opts: TimerPortOpts) {
        this.id = id;
        this.interval = opts.interval;
        this.immediate = opts.immediate ?? false;
        this.maxTicks = opts.count;
        this.description = `timer:${opts.interval}ms`;
        this.startTime = Date.now();
        this.nextScheduled = this.startTime + (this.immediate ? 0 : this.interval);

        this.startTimer();
    }

    get closed(): boolean {
        return this._closed;
    }

    private startTimer(): void {
        if (this.immediate) {
            // Fire first tick immediately
            this.enqueueTick();
        }

        // Schedule subsequent ticks
        this.scheduleNext();
    }

    private scheduleNext(): void {
        if (this._closed) return;
        if (this.maxTicks !== undefined && this.tickCount >= this.maxTicks) {
            // Max ticks reached, auto-close
            this.close();
            return;
        }

        const now = Date.now();
        const delay = Math.max(0, this.nextScheduled - now);

        this.timerHandle = setTimeout(() => {
            this.enqueueTick();
            this.nextScheduled += this.interval;
            this.scheduleNext();
        }, delay);
    }

    private enqueueTick(): void {
        if (this._closed) return;

        this.tickCount++;
        const now = Date.now();
        const scheduled = this.startTime + (this.tickCount * this.interval);
        if (this.immediate) {
            // Adjust for immediate first tick
            // tick 1 was at startTime, tick 2 at startTime + interval, etc.
        }

        const msg: PortMessage = {
            from: 'timer',
            meta: {
                tick: this.tickCount,
                scheduled: this.nextScheduled,
                actual: now,
                drift: now - this.nextScheduled,
            },
        };

        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter(msg);
        } else {
            this.messageQueue.push(msg);
        }
    }

    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async send(): Promise<void> {
        throw new EBADF('Timer ports do not support send()');
    }

    async close(): Promise<void> {
        if (this._closed) return;

        this._closed = true;

        if (this.timerHandle) {
            clearTimeout(this.timerHandle);
            this.timerHandle = null;
        }

        this.waiters = [];
        this.messageQueue = [];
    }
}
```

### Kernel Integration

Add to `src/kernel/resource/index.ts`:

```typescript
export { TimerPort, type TimerPortOpts } from './timer-port.js';
```

### Syscall Handler

Add to network syscalls or create dedicated port syscalls:

```typescript
// In createNetworkSyscalls or new createPortSyscalls

'port:timer': async function* (proc: Process, opts: TimerPortOpts) {
    // Validate options
    if (!opts.interval || opts.interval <= 0) {
        yield respond.error('EINVAL', 'interval must be positive');
        return;
    }

    const id = kernel.hal.entropy.uuid();
    const port = new TimerPort(id, opts);

    // Register in process handle table
    const fd = proc.allocateFd(port);

    yield respond.ok({ fd, id });
}
```

### Userspace API

Add to `rom/lib/process/net.ts` or new `rom/lib/process/port.ts`:

```typescript
export interface TimerOpts {
    interval: number;
    immediate?: boolean;
    count?: number;
}

export function timer(opts: TimerOpts): Promise<number> {
    return call<number>('port:timer', opts);
}
```

---

## Usage Examples

### Basic Interval

```typescript
import { timer, recv, close } from '/lib/process';

const fd = await timer({ interval: 1000 }); // every second

for await (const tick of recv(fd)) {
    console.log(`Tick ${tick.meta.tick} at ${tick.meta.actual}`);

    if (tick.meta.tick >= 10) {
        await close(fd);
        break;
    }
}
```

### One-Shot Timer

```typescript
// Fire once after 5 seconds
const fd = await timer({ interval: 5000, count: 1 });
await recv(fd); // blocks for 5 seconds
console.log('Timer fired!');
// Port auto-closed after count reached
```

### Immediate First Tick

```typescript
// Fire immediately, then every minute
const fd = await timer({ interval: 60_000, immediate: true });

for await (const tick of recv(fd)) {
    await refreshData(); // runs immediately, then every minute
}
```

### Multiplexing with Other Ports

```typescript
import { timer, port, poll, recv } from '/lib/process';

const timerFd = await timer({ interval: 60_000 });
const watchFd = await port('watch', { pattern: '/inbox/*' });

while (true) {
    const ready = await poll([timerFd, watchFd]);

    for (const fd of ready) {
        const msg = await recv(fd);

        if (msg.from === 'timer') {
            await doPeriodicCleanup();
        } else {
            await processNewFile(msg.meta.path);
        }
    }
}
```

### Drift Detection

```typescript
const fd = await timer({ interval: 100 }); // 100ms

for await (const tick of recv(fd)) {
    if (tick.meta.drift > 50) {
        console.warn(`Timer drifted ${tick.meta.drift}ms`);
    }

    await doWork(); // might take variable time
}
```

---

## Implementation Plan

### Phase 1: Core Implementation

1. Add `'timer'` to `PortType` in `src/kernel/types.ts`
2. Create `src/kernel/resource/timer-port.ts`
3. Export from `src/kernel/resource/index.ts`
4. Add `port:timer` syscall handler
5. Add userspace `timer()` function

### Phase 2: Testing

1. Unit tests for TimerPort
   - Basic interval firing
   - Immediate option
   - Count limit and auto-close
   - Manual close stops timer
   - Drift calculation
2. Integration tests
   - Syscall round-trip
   - Multiple timers
   - Timer + other ports with poll()

### Phase 3: Documentation

1. Update `PortType` documentation
2. Add timer examples to process library docs
3. Update OS_AI.md to reference timer port

---

## Open Questions

### 1. Syscall Location

| Option | Pros | Cons |
|--------|------|------|
| `port:timer` in network syscalls | Consistent with UDP/TCP ports | Timers aren't network |
| New `misc:timer` syscall | Clear separation | Another syscall category |
| Generic `port:open` with type param | Unified port creation | More complex dispatch |

**Recommendation**: `port:timer` in network syscalls for now. Can refactor later.

### 2. Backpressure

If `recv()` isn't called, ticks queue up. Options:

| Option | Behavior |
|--------|----------|
| Queue all | Memory grows if consumer slow |
| Drop old | Keep only N most recent ticks |
| Skip | Don't queue, just track missed count |

**Recommendation**: Queue all (matches PubsubPort). Add `meta.missed` field if needed later.

### 3. Precision

JavaScript timers have ~4ms minimum precision (browser) or ~1ms (Node/Bun). For sub-millisecond precision, would need native implementation.

**Recommendation**: Document precision limits. Sub-ms timing is out of scope for v1.

---

## References

- `src/kernel/resource/pubsub-port.ts` - Similar queue-and-waiter pattern
- `src/kernel/resource/watch-port.ts` - Another event-emitting port
- `src/kernel/resource/types.ts` - Port interface definition
- `src/kernel/types.ts` - PortType definition
