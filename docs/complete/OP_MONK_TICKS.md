# OP_MONK_TICKS: Kernel Tick System

## Overview

Add a kernel-driven tick system that provides AI processes ("monks") with regular
opportunities to act autonomously. Like a CPU clock cycle, the tick gives processes
agency without requiring external stimulus.

## Motivation

Currently, Prior (and future AI processes) are passive - they wait for external
instructions via TCP. With ticks, they become truly agentic:

- **Self-discovery**: Explore the environment at boot
- **Background tasks**: Continue long-running work across ticks
- **Proactive behavior**: Monitor, optimize, respond to changes
- **Heartbeat**: Regular proof-of-life for system health

## Design

### Signal-Based Delivery

Extend the existing signal infrastructure rather than creating a parallel system.

```
Kernel Timer
     │
     │ interval(TICK_INTERVAL_MS)
     ▼
┌─────────────┐
│ Tick        │
│ Broadcaster │
└─────────────┘
     │
     │ for each subscriber
     ▼
┌─────────────┐     postMessage({ type: 'signal', signal: SIGTICK, payload })
│ Process     │◄────────────────────────────────────────────────────────────
│ (Worker)    │
└─────────────┘
     │
     │ handleSignal(SIGTICK, payload)
     ▼
   onTick(dt, now, seq)
```

### Opt-In Subscription

Processes must explicitly subscribe to receive ticks. This prevents:
- Wasted cycles on processes that don't need ticks
- Accidental tick handlers in simple utilities
- Unbounded tick queues in slow processes

```typescript
// Process subscribes to ticks
await call('proc:tick:subscribe');

// Process unsubscribes
await call('proc:tick:unsubscribe');
```

### Tick Payload

Each tick delivers timing information:

```typescript
interface TickPayload {
    dt: number;   // Milliseconds since last tick
    now: number;  // Current timestamp (Date.now())
    seq: number;  // Monotonic tick sequence number
}
```

### Constants

```typescript
// Signal number (using high range to avoid conflicts)
export const SIGTICK = 30;

// Default tick interval
export const TICK_INTERVAL_MS = 1000;  // 1 second
```

## Implementation

### 1. Type Changes (src/kernel/types.ts)

```typescript
// Add SIGTICK constant
export const SIGTICK = 30;

// Extend SignalMessage to carry payload
export interface SignalMessage {
    type: 'signal';
    signal: number;
    payload?: unknown;
}

// Tick-specific payload type
export interface TickPayload {
    dt: number;
    now: number;
    seq: number;
}
```

### 2. Kernel Tick State (src/kernel/kernel.ts or new file)

```typescript
interface TickState {
    lastTick: number;
    seq: number;
    subscribers: Set<string>;  // Process UUIDs
    timerHandle: TimerHandle | null;
}

const tickState: TickState = {
    lastTick: Date.now(),
    seq: 0,
    subscribers: new Set(),
    timerHandle: null,
};
```

### 3. Tick Broadcaster

```typescript
function startTickBroadcaster(hal: HAL, kernel: Kernel): void {
    tickState.timerHandle = hal.timer.interval(TICK_INTERVAL_MS, () => {
        const now = Date.now();
        const dt = now - tickState.lastTick;
        tickState.lastTick = now;
        tickState.seq++;

        const payload: TickPayload = { dt, now, seq: tickState.seq };

        for (const uuid of tickState.subscribers) {
            const proc = kernel.processes.get(uuid);
            if (proc && proc.state === 'running') {
                deliverSignal(proc, SIGTICK, payload);
            }
        }

        // Clean up dead subscribers
        for (const uuid of tickState.subscribers) {
            const proc = kernel.processes.get(uuid);
            if (!proc || proc.state === 'zombie') {
                tickState.subscribers.delete(uuid);
            }
        }
    });
}
```

### 4. Subscription Syscalls (src/syscall/process.ts)

```typescript
// proc:tick:subscribe - Register for ticks
async function* procTickSubscribe(ctx: SyscallContext): SyscallGenerator {
    tickState.subscribers.add(ctx.process.uuid);
    yield { op: 'ok' };
}

// proc:tick:unsubscribe - Unregister from ticks
async function* procTickUnsubscribe(ctx: SyscallContext): SyscallGenerator {
    tickState.subscribers.delete(ctx.process.uuid);
    yield { op: 'ok' };
}
```

### 5. Signal Delivery Extension (src/kernel/kernel/deliver-signal.ts)

```typescript
export function deliverSignal(
    proc: Process,
    signal: number,
    payload?: unknown
): void {
    try {
        proc.worker.postMessage({
            type: 'signal',
            signal,
            payload,
        } satisfies SignalMessage);
    }
    catch (err) {
        // Worker may be terminating, best-effort delivery
        console.warn(`Failed to deliver signal ${signal} to ${proc.pid}:`, err);
    }
}
```

### 6. Process Library (rom/lib/process/syscall.ts)

```typescript
// Extend handleSignal to pass payload
async function handleSignal(signal: number, payload?: unknown): Promise<void> {
    const handler = signalHandlers.get(signal);
    if (handler) {
        await handler(payload);
    }
    else if (signal === SIGTERM) {
        await defaultTermHandler();
    }
}

// Update onSignal signature
type SignalHandler = (payload?: unknown) => void | Promise<void>;

// Convenience wrapper for ticks
export function onTick(handler: (dt: number, now: number, seq: number) => void | Promise<void>): void {
    onSignal(SIGTICK, (payload) => {
        const { dt, now, seq } = payload as TickPayload;
        return handler(dt, now, seq);
    });
}
```

### 7. Process Library Exports (rom/lib/process/index.ts)

```typescript
export { onTick } from './syscall.js';

// Subscription helpers
export async function subscribeTicks(): Promise<void> {
    await call('proc:tick:subscribe');
}

export async function unsubscribeTicks(): Promise<void> {
    await call('proc:tick:unsubscribe');
}
```

## Usage Example: Prior

```typescript
import { onTick, subscribeTicks, eprintln } from '@rom/lib/process/index.js';

async function main(): Promise<void> {
    // ... existing setup ...

    // Subscribe to kernel ticks
    await subscribeTicks();

    // Register tick handler for agentic loop
    onTick(async (dt, now, seq) => {
        // Self-discovery on first tick
        if (seq === 1) {
            await discoverEnvironment();
        }

        // Periodic maintenance
        if (seq % 60 === 0) {  // Every ~60 seconds
            await consolidateMemory();
        }

        // Check for pending autonomous work
        await processAutonomousQueue();
    });

    // ... TCP listener loop ...
}
```

## Configuration

Future enhancement: per-process tick intervals via subscription options.

```typescript
// Not implemented yet, but the shape:
await call('proc:tick:subscribe', { interval: 5000 });  // 5-second ticks
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/kernel/types.ts` | Add SIGTICK, extend SignalMessage, add TickPayload |
| `src/kernel/kernel/deliver-signal.ts` | Add payload parameter |
| `src/kernel/tick.ts` | New file: tick state and broadcaster |
| `src/syscall/process.ts` | Add proc:tick:subscribe, proc:tick:unsubscribe |
| `rom/lib/process/syscall.ts` | Extend handleSignal, add onTick |
| `rom/lib/process/index.ts` | Export onTick, subscribeTicks, unsubscribeTicks |
| `rom/bin/prior.ts` | Add tick handler for agentic behavior |

## Testing

1. Basic subscription/unsubscription
2. Tick delivery timing (dt should be ~TICK_INTERVAL_MS)
3. Sequence monotonicity
4. Dead process cleanup
5. Multiple subscribers
6. Unsubscribe stops delivery

## Status

- [x] Design document
- [x] Type definitions (src/kernel/types.ts, rom/lib/process/types.ts)
- [x] Kernel tick broadcaster (src/kernel/kernel/tick.ts)
- [x] Subscription syscalls (proc:tick:subscribe, proc:tick:unsubscribe)
- [x] Process library helpers (onTick, subscribeTicks, unsubscribeTicks)
- [x] Prior integration (rom/bin/prior.ts)
