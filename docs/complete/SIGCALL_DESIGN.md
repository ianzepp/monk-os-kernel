# Sigcall Design Document

## Completion Status

**Status: Complete (with gaps)**

| Component | Status | Notes |
|-----------|--------|-------|
| Directory restructure (`src/dispatch/`) | Done | |
| Message types (sigcall:request/response) | Done | |
| StreamController hierarchy | Done | Base class + SyscallController + SigcallController |
| Sigcall registry | Done | `src/dispatch/sigcall/registry.ts` |
| Management syscalls | Done | sigcall:register, sigcall:unregister, sigcall:list |
| Dispatcher routing | Done | Unknown syscalls check registry, route to userspace |
| Userspace handler API | Done | onSigcall/offSigcall in `rom/lib/process/sigcall.ts` |
| Process exit cleanup | Done | `unregisterAll()` called in force-exit |
| Working example | Done | AI service uses `ai:task` sigcall |

**Gaps (not implemented):**

| Feature | Status | Notes |
|---------|--------|-------|
| `sigcall:ping` / `sigcall:cancel` | Not done | SigcallController exists but kernel never sends pings |
| In-flight cleanup on handler death | Not done | Caller hangs forever if handler dies mid-stream |
| Circular sigcall detection | Not done | A -> B -> A would deadlock |
| ConnectionHandle for gateway | Not done | Gateway uses different approach |

**Open questions resolved:**

- Reserved namespaces: Only `syscall:*` is blocked (prevents userspace from shadowing kernel syscalls)
- Registration permissions: Any process can register any name (first wins)
- Process exit cleanup: Automatic via `unregisterAll(pid)` in force-exit

---

## Overview

Sigcalls are the inverse of syscalls: kernel-to-userspace requests that expect streaming responses back. They enable userspace processes to act as service handlers, allowing external clients (via gateway) to invoke userspace functionality.

```
Syscall:  userspace ──request──> kernel ──response*──> userspace
Sigcall:  kernel ──request──> userspace ──response*──> kernel
```

## Motivation

The gateway accepts requests from external clients (browser via WebSocket) but can only route them to kernel-space syscall handlers. There's no way to route requests to userspace services like a window server (`displayd`) or timer service (`timerd`).

Sigcalls solve this by allowing userspace processes to register as handlers for specific request types, enabling:

- External client -> gateway -> dispatcher -> userspace handler -> response back to client
- Userspace-to-userspace RPC mediated by dispatcher

## Architecture

### Request Flow

```
External Client (Browser)
    |
    | WebSocket message: { name: 'window:delete', args: [windowId] }
    v
Gateway [conn=abc]
    |
    | sigcall:request to dispatcher
    v
Dispatcher
    |
    | lookup registry: 'window:delete' -> displayd (pid)
    | route to displayd worker
    v
displayd (worker)
    |
    | onSigcall handler invoked
    | handler yields Response objects
    v
Dispatcher
    |
    | correlate responses, forward to gateway
    v
Gateway
    |
    | correlate to WebSocket connection
    v
External Client
```

### Message Types (Unified Naming)

All message types use colon-prefixed naming for consistency:

```typescript
// Syscalls (userspace -> kernel -> userspace)
'syscall:request'      // was: 'syscall'
'syscall:response'     // was: 'response'
'syscall:ping'         // was: 'stream_ping'
'syscall:cancel'       // was: 'stream_cancel'

// Sigcalls (kernel -> userspace -> kernel)
'sigcall:request'      // implemented
'sigcall:response'     // implemented
'sigcall:ping'         // NOT IMPLEMENTED
'sigcall:cancel'       // NOT IMPLEMENTED

// Signals (kernel -> userspace, fire-and-forget)
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
- `syscall:*` namespace is reserved (cannot be registered)

**Registry Structure (in dispatcher):**

```typescript
interface SigcallRegistration {
    name: string;      // 'window:delete'
    pid: string;       // owning process
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

export function offSigcall(name: string): void {
    sigcallHandlers.delete(name);
}

// Worker message handler (in handleSigcallRequest)
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

    for await (const response of handler(...msg.args)) {
        self.postMessage({
            type: 'sigcall:response',
            id: msg.id,
            result: response,
        });

        if (isTerminal(response.op)) break;
    }
}
```

**Example Handler (from AI service):**

```typescript
// In rom/app/ai/main.ts
await call('sigcall:register', 'ai:task');

onSigcall('ai:task', async function*(instruction: unknown) {
    if (!instr || typeof instr.task !== 'string') {
        yield respond.error('EINVAL', 'instruction.task must be a string');
        return;
    }

    const result = await executeTask(instr, {}, consolidateMemory);

    if (result.status === 'ok') {
        yield respond.ok({ result, model, duration_ms, request_id });
    }
    else {
        yield respond.error('EIO', result.error ?? 'Task failed');
    }
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
        pid?: string;        // calling process
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
+-- SyscallController (kernel produces -> userspace consumes)
+-- SigcallController (userspace produces -> kernel consumes)
```

The inversion determines who sends pings:

| Controller | Producer | Consumer | Who Pings |
|------------|----------|----------|-----------|
| SyscallController | Kernel | Userspace | Userspace sends `syscall:ping` |
| SigcallController | Userspace | Kernel | Kernel sends `sigcall:ping` |

**Note:** SigcallController exists but the kernel does not currently send `sigcall:ping` messages. High-volume handlers could cause memory issues.

## Dispatcher Implementation

### Routing Logic

```typescript
// In dispatcher.dispatch()
async function* dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
    // 1. Switch statement handles built-in syscalls
    switch (name) {
        case 'file:open': ...
        case 'proc:spawn': ...
        // etc.
    }

    // 2. Default case checks sigcall registry
    const registration = sigcallRegistry.lookup(name);
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
    pendingSigcalls.set(requestId, { queue: [], done: false, waiting: null });

    try {
        target.worker.postMessage({
            type: 'sigcall:request',
            id: requestId,
            name,
            args,
            caller: { pid: caller.id },
        });

        // Yield responses as they arrive
        while (true) {
            const response = await waitForResponse(requestId);
            yield response;
            if (isTerminal(response.op)) break;
        }
    }
    finally {
        pendingSigcalls.delete(requestId);
    }
}
```

## Syscalls for Sigcall Management

```typescript
// Register a sigcall handler
'sigcall:register'   (name: string) -> ok({ name, pid }) | error

// Unregister (optional - also happens on exit)
'sigcall:unregister' (name: string) -> ok({ name }) | error

// List registered sigcalls (debugging)
'sigcall:list'       () -> item*({ name, pid }) + done
```

## Directory Structure

```
src/dispatch/
+-- index.ts                   <- Exports Dispatcher
+-- dispatcher.ts              <- Switch routing, sigcall routing
+-- types.ts                   <- Shared types
+-- stream/
|   +-- index.ts
|   +-- controller.ts          <- StreamController (abstract base)
|   +-- syscall-controller.ts  <- SyscallController (kernel->userspace)
|   +-- sigcall-controller.ts  <- SigcallController (userspace->kernel)
|   +-- constants.ts           <- HIGH_WATER, LOW_WATER, STALL_TIMEOUT
|   +-- types.ts
+-- sigcall/
|   +-- index.ts
|   +-- registry.ts            <- Sigcall registration table
+-- syscall/
    +-- vfs.ts                 <- file:* handlers
    +-- ems.ts                 <- ems:* handlers
    +-- process.ts             <- proc:* handlers
    +-- hal.ts                 <- net:*, port:*, channel:* handlers
    +-- handle.ts              <- handle:*, ipc:* handlers
    +-- pool.ts                <- pool:*, worker:* handlers
    +-- sigcall.ts             <- sigcall:register/unregister/list
```

## Future Work

1. **sigcall:ping/cancel** - Complete backpressure story for high-volume handlers
2. **Handler death cleanup** - Timeout or error in-flight sigcalls when handler dies
3. **Circular detection** - Prevent A -> B -> A deadlocks
4. **Metrics** - Track sigcall latency, volume per handler
