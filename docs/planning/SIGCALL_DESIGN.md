# Sigcall Design Document

## Overview

Sigcalls are the inverse of syscalls: kernel-to-userspace requests that expect streaming responses back. They enable userspace processes to act as service handlers, allowing external clients (via gateway) to invoke userspace functionality.

```
Syscall:  userspace ──request──> kernel ──response*──> userspace
Sigcall:  kernel ──request──> userspace ──response*──> kernel
```

## Motivation

The gateway accepts requests from external clients (browser via WebSocket) but can only route them to kernel-space syscall handlers. There's no way to route requests to userspace services like a window server (`displayd`) or timer service (`timerd`).

Sigcalls solve this by allowing userspace processes to register as handlers for specific request types, enabling:

- External client → gateway → dispatcher → userspace handler → response back to client
- Userspace-to-userspace RPC mediated by dispatcher

## Architecture

### Request Flow

```
External Client (Browser)
    │
    │ WebSocket message: { name: 'window:delete', args: [windowId] }
    ▼
Gateway [conn=abc]
    │
    │ sigcall:request to dispatcher
    ▼
Dispatcher
    │
    │ lookup registry: 'window:delete' → displayd (pid)
    │ route to displayd worker
    ▼
displayd (worker)
    │
    │ onSigcall handler invoked
    │ handler yields Response objects
    ▼
Dispatcher
    │
    │ correlate responses, forward to gateway
    ▼
Gateway
    │
    │ correlate to WebSocket connection
    ▼
External Client
```

### Message Types (Unified Naming)

All message types use colon-prefixed naming for consistency:

```typescript
// Syscalls (userspace → kernel → userspace)
'syscall:request'      // was: 'syscall'
'syscall:response'     // was: 'response'
'syscall:ping'         // was: 'stream_ping'
'syscall:cancel'       // was: 'stream_cancel'

// Sigcalls (kernel → userspace → kernel)
'sigcall:request'      // new
'sigcall:response'     // new
'sigcall:ping'         // new
'sigcall:cancel'       // new

// Signals (kernel → userspace, fire-and-forget)
'signal'               // unchanged
```

### Registration

Userspace processes register sigcall handlers via syscall:

```typescript
// In displayd startup
yield* syscall('sigcall:register', 'window:delete');
yield* syscall('sigcall:register', 'window:create');
yield* syscall('sigcall:register', 'window:move');
```

**Rules:**
- Exact pattern matching only (no globs)
- Error if pattern already registered by another process
- Implicit unregistration on process exit

**Registry Structure (in dispatcher):**

```typescript
interface SigcallRegistration {
    name: string;      // 'window:delete'
    pid: string;       // owning process
    // future: permissions, metadata
}

const sigcallRegistry = new Map<string, SigcallRegistration>();
```

### Handler API (Userspace)

```typescript
// rom/lib/process/sigcall.ts

type SigcallHandler = (...args: unknown[]) => AsyncIterable<Response>;

const sigcallHandlers = new Map<string, SigcallHandler>();

export function onSigcall(name: string, handler: SigcallHandler): void {
    sigcallHandlers.set(name, handler);
}

// Worker message handler
self.onmessage = async (event) => {
    const msg = event.data;

    if (msg.type === 'sigcall:request') {
        const handler = sigcallHandlers.get(msg.name);
        if (!handler) {
            self.postMessage({
                type: 'sigcall:response',
                id: msg.id,
                result: respond.error('ENOSYS', `No handler for ${msg.name}`),
            });
            return;
        }

        let processed = 0;
        for await (const response of handler(...msg.args)) {
            self.postMessage({
                type: 'sigcall:response',
                id: msg.id,
                result: response,
            });
            processed++;

            // Backpressure: pause if gap too high (details in controller section)
        }
    }
};
```

**Example Handler:**

```typescript
// In displayd
onSigcall('window:delete', async function*(windowId: string) {
    // Validate
    if (typeof windowId !== 'string') {
        yield respond.error('EINVAL', 'windowId must be string');
        return;
    }

    // Do work (can make syscalls)
    yield* syscall('ems:delete', 'windows', windowId);

    // Emit events
    yield respond.event({ type: 'window:deleted', id: windowId });

    // Terminal response
    yield respond.ok({ deleted: windowId });
});
```

### Sigcall Request Message

```typescript
interface SigcallRequest {
    type: 'sigcall:request';
    id: string;              // correlation ID
    name: string;            // 'window:delete'
    args: unknown[];         // handler arguments
    caller?: {
        connId?: string;     // gateway connection (for push responses)
        pid?: string;        // calling process (if internal)
    };
}
```

### Sigcall Response Message

```typescript
interface SigcallResponse {
    type: 'sigcall:response';
    id: string;              // correlation ID (matches request)
    result: Response;        // { op, data, bytes? }
}
```

## Backpressure

### Controller Hierarchy

```
StreamController (abstract base)
├── SyscallController (kernel produces → userspace consumes)
└── SigcallController (userspace produces → kernel consumes)
```

The inversion determines who sends pings:

| Controller | Producer | Consumer | Who Pings |
|------------|----------|----------|-----------|
| SyscallController | Kernel | Userspace | Userspace sends `syscall:ping` |
| SigcallController | Userspace | Kernel | Kernel sends `sigcall:ping` |

### Sigcall Backpressure Flow

```
displayd (producer)                  Dispatcher (consumer)
      │                                    │
      │ ──sigcall:response──>              │
      │ ──sigcall:response──>              │
      │ ──sigcall:response──>              │
      │                                    │
      │            <──sigcall:ping(3)───   │ (kernel acks 3 processed)
      │                                    │
      │ ... 1000 more responses ...        │
      │                                    │
      │   gap >= HIGH_WATER (1000)         │
      │   await waitForResume() ←──PAUSE   │
      │                                    │
      │            <──sigcall:ping(950)──  │
      │   gap=50 <= LOW_WATER (100)        │
      │   resume()              ←──RESUME  │
```

### Timeout/Stall

Same as syscalls: if no ping received for 5 seconds, producer assumes consumer is dead and aborts with ETIMEDOUT.

## Gateway Integration

Gateway is a userspace process that:
1. Owns WebSocket connections
2. Registers `gateway:push` sigcall handler
3. Routes incoming WebSocket messages to dispatcher
4. Maintains connection ID → WebSocket mapping

### Gateway as Sigcall Handler

```typescript
// Gateway startup
yield* syscall('sigcall:register', 'gateway:push');

const connections = new Map<string, WebSocket>();

// Handle new WebSocket connection
ws.on('connect', () => {
    const connId = uuid();
    connections.set(connId, ws);

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        // Forward to dispatcher with connId attached
        yield* syscall('dispatch', msg.name, { connId, ...msg.args });
    });

    ws.on('close', () => {
        connections.delete(connId);
    });
});

// Handle push requests from other processes
onSigcall('gateway:push', async function*(connId: string, data: unknown) {
    const ws = connections.get(connId);
    if (!ws) {
        yield respond.error('ENOENT', 'Connection not found');
        return;
    }

    ws.send(JSON.stringify(data));
    yield respond.ok();
});
```

### Gateway Connections as Handles

Gateway connections are kernel handles, not sigcall targets. This uses the existing `handle:send` syscall rather than a special `gateway:push` sigcall.

**ConnectionHandle implementation (in gateway):**

```typescript
class ConnectionHandle implements Handle {
    readonly type: HandleType = 'connection';
    readonly id: string;

    constructor(
        id: string,
        private ws: WebSocket,
    ) {
        this.id = id;
    }

    async *exec(msg: Message): AsyncIterable<Response> {
        if (msg.op === 'send') {
            this.ws.send(JSON.stringify(msg.data));
            yield respond.ok();
        }
        else if (msg.op === 'close') {
            this.ws.close();
            yield respond.ok();
        }
        else {
            yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
        }
    }

    async close(): Promise<void> {
        this.ws.close();
    }
}
```

**Connection flow:**

```
Browser ──ws──> Gateway
                   │
                   │ handle = new ConnectionHandle(uuid(), ws)
                   │ fd = kernel.assignHandle(gatewayProc, handle)
                   │
                   │ sigcall('timer:create', { fd, delay:30000 })
                   ▼
               Dispatcher ──> timerd
                                │
                                │ stores fd with timer record
                                │ yield respond.ok({ timerId: 123 })
                                │
               ... 30 seconds ...
                                │
                                │ (tick fires)
                                │ syscall('handle:send', fd, { op:'send', data:{ event:'alarm' } })
                                ▼
               Kernel routes to handle
                                │
                                │ ConnectionHandle.exec() called
                                │ ws.send(JSON.stringify(data))
                                ▼
Browser <───────────────────────┘
```

**Benefits:**
- Uses existing `handle:send` syscall - no new sigcall needed
- Connections are first-class kernel resources (tracked, reference counted)
- Unified model with pipes, ports, channels
- Userspace pushes directly via fd, no dispatcher round-trip

## Dispatcher Changes

### Routing Logic

```typescript
// In dispatcher.dispatch()
async function* dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
    // 1. Check built-in syscall handlers
    const syscallHandler = syscallHandlers.get(name);
    if (syscallHandler) {
        yield* syscallHandler(proc, ...args);
        return;
    }

    // 2. Check sigcall registry
    const registration = sigcallRegistry.get(name);
    if (registration) {
        yield* routeToUserspace(registration, proc, name, args);
        return;
    }

    // 3. Not found
    yield respond.error('ENOSYS', `Unknown: ${name}`);
}
```

### Sigcall Routing

```typescript
async function* routeToUserspace(
    reg: SigcallRegistration,
    caller: Process,
    name: string,
    args: unknown[],
): AsyncIterable<Response> {
    const target = kernel.getProcess(reg.pid);
    if (!target || target.state !== 'running') {
        yield respond.error('ESRCH', 'Handler process not found');
        return;
    }

    const requestId = uuid();
    const controller = new SigcallController();
    pendingSigcalls.set(requestId, controller);

    try {
        // Send request to userspace
        target.worker.postMessage({
            type: 'sigcall:request',
            id: requestId,
            name,
            args,
            caller: { pid: caller.pid },
        });

        // Yield responses as they arrive
        for await (const response of controller.responses()) {
            yield response;

            if (isTerminal(response.op)) {
                break;
            }
        }
    }
    finally {
        pendingSigcalls.delete(requestId);
    }
}
```

### Pending Sigcall Tracker

Mirror of userspace's pending syscall tracker:

```typescript
interface PendingSigcall {
    controller: SigcallController;
    queue: Response[];
    done: boolean;
    waiting: ((response: Response | null) => void) | null;
}

const pendingSigcalls = new Map<string, PendingSigcall>();

// Called when worker sends sigcall:response
function handleSigcallResponse(msg: SigcallResponse): void {
    const pending = pendingSigcalls.get(msg.id);
    if (!pending) return;

    if (isTerminal(msg.result.op)) {
        pending.done = true;
    }

    if (pending.waiting) {
        pending.waiting(msg.result);
        pending.waiting = null;
    } else {
        pending.queue.push(msg.result);
    }
}
```

## Syscalls for Sigcall Management

```typescript
// Register a sigcall handler
'sigcall:register'   (name: string) → ok | error

// Unregister (optional - also happens on exit)
'sigcall:unregister' (name: string) → ok | error

// List registered sigcalls (debugging)
'sigcall:list'       () → item* (name, pid)
```

## Open Questions / TODOs

### Lifecycle
- What happens to in-flight sigcalls when handler process dies?
- Should pending responses be drained or immediately errored?
- Cleanup timing for registration on process exit

### Nesting
- Sigcall handler can make syscalls (works naturally)
- Sigcall handler can make sigcalls to other processes (should work)
- Circular sigcall detection? (A → B → A)

### Permissions
- Can any process register any sigcall name?
- Reserved namespaces?
- Capability tokens for registration?

### Gateway Details
- How does gateway itself start? (chicken-egg with sigcall registration)
- Multiple gateway instances? (load balancing connections)
- Connection timeout/cleanup

## Directory Structure

Rename `src/syscall/` → `src/dispatch/` to reflect that it handles both syscalls and sigcalls:

```
src/dispatch/
├── dispatcher.ts                  ← Dispatcher (routes both syscalls and sigcalls)
├── stream/
│   ├── controller.ts              ← StreamController (abstract base)
│   ├── syscall-controller.ts      ← SyscallController (kernel→userspace)
│   └── sigcall-controller.ts      ← SigcallController (userspace→kernel)
├── sigcall/
│   └── registry.ts                ← Sigcall registration table
├── syscall/
│   ├── vfs.ts                     ← file:* handlers
│   ├── ems.ts                     ← ems:* handlers
│   ├── process.ts                 ← proc:* handlers
│   ├── hal.ts                     ← net:*, port:*, channel:* handlers
│   ├── handle.ts                  ← handle:*, ipc:* handlers
│   ├── pool.ts                    ← pool:*, worker:* handlers
│   ├── auth.ts                    ← auth:* handlers
│   └── llm.ts                     ← llm:* handlers
```

Key points:
- `dispatcher.ts` moves up, handles both routing paths
- `stream/` contains the controller hierarchy (base + two inversions)
- `sigcall/` contains sigcall-specific code (registry, maybe router later)
- `syscall/` contains kernel-side syscall handlers (unchanged content, new location)

## Implementation Order

1. **Directory restructure** - `src/syscall/` → `src/dispatch/`, organize subdirectories
2. **Message type rename** - `response` → `syscall:response`, `stream_ping` → `syscall:ping`, etc.
3. **StreamController refactor** - Extract base class, create SyscallController
4. **SigcallController** - Inverted backpressure (kernel pings userspace)
5. **Sigcall registry** - `sigcall:register`, `sigcall:unregister` syscalls
6. **Dispatcher routing** - Check registry, route to userspace
7. **Userspace handler API** - `onSigcall()`, response streaming
8. **ConnectionHandle** - Gateway connection as kernel handle (uses existing `handle:send`)
9. **Testing** - End-to-end flow with mock gateway/displayd

## Example: Full Timer Flow

```typescript
// === timerd.ts ===
onSigcall('timer:create', async function*(opts: { fd: number, delay: number }) {
    // fd is the gateway connection handle passed from browser request
    const timer = yield* syscall('ems:create', 'timers', {
        fd: opts.fd,
        fireAt: Date.now() + opts.delay,
    });
    yield respond.ok({ timerId: timer.id });
});

onTick(async (dt, now) => {
    const due = yield* syscall('ems:select', 'timers', { fireAt: { $lte: now } });
    for await (const timer of due) {
        // Create alarm window via displayd (sigcall to userspace)
        const window = yield* syscall('window:create', {
            type: 'alarm',
            timerId: timer.id,
        });

        // Push directly to browser via connection handle (syscall, not sigcall)
        yield* syscall('handle:send', timer.fd, {
            op: 'send',
            data: {
                event: 'timer:fired',
                timerId: timer.id,
                windowId: window.id,
            },
        });

        // Cleanup
        yield* syscall('ems:delete', 'timers', timer.id);
    }
});

// === displayd.ts ===
onSigcall('window:create', async function*(opts: { type: string, timerId?: string }) {
    const window = yield* syscall('ems:create', 'windows', {
        type: opts.type,
        timerId: opts.timerId,
    });
    yield respond.ok({ id: window.id });
});

// === gateway.ts ===
// No gateway:push sigcall needed - connections are handles

ws.on('connect', () => {
    const handle = new ConnectionHandle(uuid(), ws);
    const fd = kernel.assignHandle(gatewayProc, handle);

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);
        // Route to dispatcher with fd attached
        for await (const response of dispatcher.dispatch(gatewayProc, msg.name, { fd, ...msg.args })) {
            ws.send(JSON.stringify(response));
        }
    });

    ws.on('close', () => {
        kernel.closeHandle(gatewayProc, fd);
    });
});
```
