# Userspace Syscall Handlers

> **SUPERSEDED**: This document has been superseded by [SIGCALL_DESIGN.md](../planning/SIGCALL_DESIGN.md). The key difference is that the new design uses postMessage for responses (symmetric with syscalls) rather than MessagePipe (which created two different mental models). The new design also introduces distinct "sigcall" terminology to make the inversion explicit.

## Motivation

Currently, all syscalls are handled in kernel context by `SyscallDispatcher`. This is monolithic—adding new syscall families requires editing the dispatcher, and handlers can't be restarted independently.

**Goal**: Allow userspace processes to register as syscall handlers. The dispatcher becomes a router, not an implementer.

### Initial Use Case: Prior

Prior wants to expose `ai:task` as a syscall so Gateway clients can invoke the agentic loop:

```typescript
// In Prior's init
await call('syscall:register', 'ai:*', getpid());

// Client via Gateway
const result = await call('ai:task', { task: 'Explain this code', model: 'claude-sonnet-4' });
// Returns streaming responses through the agentic loop
```

**Namespace rationale**: `ai:*` describes *what* it does, not *who* implements it. External clients shouldn't need to know there's something called "Prior"—they just want AI capabilities. This also allows future expansion:

- `ai:task` — agentic task with bang commands (Prior)
- `ai:complete` — raw LLM completion (could move from `llm:complete`)
- `ai:embed` — embeddings
- `ai:consolidate` — memory consolidation

### Primary Use Case: Display Server

The display server manages browser-based windowing. Previously it ran its own HTTP/WebSocket server, but with Gateway WebSocket support (see `GATEWAY_WEBSOCKET.md`), displayd becomes a pure syscall handler:

```typescript
// In displayd's init
await call('syscall:register', 'display:*');

// Browser via Gateway WebSocket
await call('display:connect', { width: 1920, height: 1080 });
await call('display:create-window', { title: 'My App', width: 800, height: 600 });
const events = call('display:subscribe', displayId);  // Long-lived stream
```

**Benefits**:
- Single entry point (Gateway handles auth, transport)
- displayd has no network code
- Browser is just another Gateway client

### Future Use Case: Shell Server

A shell server registers `shell:exec` for piped command execution:

```typescript
// In shell server's init
await call('syscall:register', 'shell:*', getpid());

// Client via Gateway or another process
const output = await call('shell:exec', "echo 'foo\nbar' | sort | wc -l");
// Streams stdout/stderr, returns exit code
```

### Future Use Case: Plugin System

Third-party plugins register their own syscall namespaces:

```typescript
await call('syscall:register', 'plugin:myplugin:*', getpid());
```

## Architecture

### Routing Table

```
┌─────────────────────────────────────────────────────────┐
│                   Syscall Routing Table                  │
├──────────────┬──────────────┬───────────────────────────┤
│ Pattern      │ Handler Type │ Target                    │
├──────────────┼──────────────┼───────────────────────────┤
│ proc:*       │ kernel       │ built-in                  │
│ fs:*         │ kernel       │ built-in                  │
│ ems:*        │ kernel       │ built-in                  │
│ llm:*        │ kernel       │ built-in                  │
│ ai:*         │ process      │ pid                       │
│ shell:*      │ process      │ pid                       │
│ plugin:foo:* │ process      │ pid                       │
└──────────────┴──────────────┴───────────────────────────┘
```

### Handler Types

| Type | Mechanism | Use Case |
|------|-----------|----------|
| `kernel` | Direct function call via switch statement | Core syscalls (proc, fs, ems, llm, etc.) |
| `process` | MessagePipe + postMessage | Userspace servers (prior, displayd, plugins) |

### Response Channel Pattern

The key insight: use the existing `MessagePipe` infrastructure as a "data channel" for responses. This is analogous to FTP's control channel (syscall-request) + data channel (pipe) pattern.

When the dispatcher routes a syscall to a userspace handler:

1. Dispatcher creates a `MessagePipe` pair
2. Dispatcher keeps the recv end
3. Dispatcher allocates the send end as a handle in the handler's process
4. Dispatcher sends the request via `postMessage` with the response fd
5. Handler writes responses to the pipe via `handle:send`
6. Dispatcher reads from pipe and forwards to original caller
7. Backpressure flows naturally through the pipe

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Response Channel Pattern                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Caller              Dispatcher                    Handler Process       │
│    │                     │                              │                │
│    │  syscall:ai:task    │                              │                │
│    ├────────────────────▶│                              │                │
│    │                     │                              │                │
│    │                     │  1. Create MessagePipe       │                │
│    │                     │     [recvEnd, sendEnd]       │                │
│    │                     │                              │                │
│    │                     │  2. Allocate sendEnd as fd   │                │
│    │                     │     in handler process       │                │
│    │                     │                              │                │
│    │                     │  3. postMessage(request)     │                │
│    │                     │     { type: 'syscall-request'│                │
│    │                     │       id, call, args,        │                │
│    │                     │       responseFd }           │                │
│    │                     ├─────────────────────────────▶│                │
│    │                     │                              │                │
│    │                     │         4. Handler writes to responseFd       │
│    │                     │            handle:send(fd, { op: 'item' })    │
│    │                     │◀ ─ ─ ─ ─ ─(MessagePipe)─ ─ ─ ┤                │
│    │                     │                              │                │
│    │  { op: 'item' }     │  5. Dispatcher reads from    │                │
│    │◀────────────────────│     recvEnd, forwards to     │                │
│    │                     │     caller                   │                │
│    │                     │                              │                │
│    │                     │◀ ─ ─ ─ ─ ─(MessagePipe)─ ─ ─ ┤                │
│    │  { op: 'item' }     │                              │                │
│    │◀────────────────────│                              │                │
│    │                     │                              │                │
│    │                     │◀ ─ ─ ─ ─ ─(MessagePipe)─ ─ ─ ┤                │
│    │  { op: 'done' }     │            handle:send(fd, { op: 'done' })    │
│    │◀────────────────────│            handle:close(fd)  │                │
│    │                     │                              │                │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why MessagePipe?**

- Already exists in the kernel (`src/kernel/resource/message-pipe.ts`)
- In-memory, no serialization—`Response` objects pass through directly
- Built-in backpressure via high water mark (EAGAIN when full)
- Integrates with handle table—handler uses normal `handle:send` syscall
- EOF signaling when pipe closes

**Why not postMessage for responses?**

- `postMessage` is fire-and-forget—no backpressure
- Would need to rebuild streaming, correlation, and flow control
- Signals have the same problem
- The existing syscall machinery has backpressure, but only works caller→kernel

## New Syscalls

### `syscall:register`

Register a syscall pattern handler.

```typescript
await call('syscall:register', pattern: string, pid?: string);
```

- `pattern`: Syscall pattern with optional wildcard (e.g., `ai:*`, `shell:exec`)
- `pid`: Handler process ID (defaults to caller's pid)

**Constraints**:
- Cannot override kernel handlers (all existing hardcoded prefixes are reserved)
- More specific patterns take precedence (`ai:task` > `ai:*`)
- Only one handler per pattern (duplicate registration returns `EEXIST`)

### `syscall:unregister`

Remove a syscall handler.

```typescript
await call('syscall:unregister', pattern: string);
```

**Constraints**:
- Only the registering process can unregister (or kernel)
- Automatic unregister on process exit

### `syscall:list`

List registered handlers (for debugging).

```typescript
const handlers = await call('syscall:list');
// [{ pattern: 'ai:*', pid: '...', type: 'process' }, ...]
```

## Handler Protocol

### Request Delivery

When the dispatcher routes a syscall to a userspace process:

```typescript
// Dispatcher creates pipe and allocates send end to handler
const [recvEnd, sendEnd] = createMessagePipe(requestId);
const responseFd = allocHandle(kernel, handlerProc, sendEnd);

// Dispatcher → Handler (via postMessage)
handlerProc.worker.postMessage({
    type: 'syscall-request',
    id: string,           // Request ID for correlation
    call: string,         // Full syscall name (e.g., 'ai:task')
    args: unknown[],      // Syscall arguments
    caller: string,       // Caller's process ID (for access control)
    responseFd: number,   // Handle to write responses to
});
```

### Response Delivery

Handler writes responses to the pipe using normal syscalls:

```typescript
// Handler → Dispatcher (via MessagePipe)
await syscall('handle:send', responseFd, { op: 'item', data: chunk });
await syscall('handle:send', responseFd, { op: 'item', data: chunk });
await syscall('handle:send', responseFd, { op: 'done' });
await syscall('handle:close', responseFd);
```

Terminal ops (`ok`, `error`, `done`) signal end of stream. Handler should close the fd after terminal response.

### Backpressure

If the original caller is slow to consume responses:
1. Dispatcher's read from `recvEnd` slows down
2. Pipe's internal queue fills up (high water mark = 1000 messages)
3. Handler's `handle:send` returns `EAGAIN`
4. Handler must retry or buffer

This matches how kernel syscall handlers work—generators naturally pause at `yield` when StreamController applies backpressure.

## `onSyscallRequest` Helper

The process runtime provides `onSyscallRequest`, following the existing `onSignal`/`onTick` pattern:

```typescript
import { onSyscallRequest } from '@monk/process';

// Register handler - framework manages pipe writes
onSyscallRequest(async function* (call, args, caller) {
    if (call === 'display:subscribe') {
        // Streaming response via generator
        for await (const event of eventSource) {
            yield { op: 'item', data: event };
        }
        return { op: 'done' };
    }

    if (call === 'display:create-window') {
        // Single response
        const window = await createWindow(args[0]);
        return { op: 'ok', data: window };
    }
});
```

The helper:
- Listens for `syscall-request` messages
- Extracts the `responseFd` from the request
- Converts generator yields to `handle:send` calls
- Sends terminal response and closes fd on return/throw
- Catches exceptions and sends `{ op: 'error', code, message }`

This keeps handlers focused on business logic, not protocol plumbing.

## Process Lifecycle

### Registration

```typescript
// Prior startup
export default async function main(): Promise<void> {
    await call('syscall:register', 'ai:*');

    onSyscallRequest(async function* (call, args, caller) {
        if (call === 'ai:task') {
            for await (const chunk of executeTask(args[0])) {
                yield { op: 'item', data: chunk };
            }
            return { op: 'done' };
        }
    });

    // ... rest of Prior init
}
```

### Cleanup

When a handler process exits:
1. Kernel detects process exit
2. All patterns registered by that process are unregistered
3. All open response pipes are closed (recvEnd sees EOF)
4. In-flight requests to that handler receive `{ op: 'error', code: 'ESRCH' }`

## Resolved Questions

1. **Kernel handler override**: Userspace cannot shadow kernel syscalls. All existing hardcoded prefixes in the dispatcher switch statement are reserved.

2. **Concurrency**: Handler process handles multiple concurrent requests. Each request gets its own `responseFd`, so responses don't interleave.

3. **Handler crash**: All pending requests get `{ op: 'error', code: 'ESRCH', message: 'Handler exited' }` because their response pipes close.

4. **Response protocol**: Handlers use `handle:send` to write to a `MessagePipe`. No new message types needed for responses—just the existing handle/pipe infrastructure.

## Open Questions

1. **Pattern precedence**: If both `ai:*` and `ai:task` are registered to different processes, which wins?
   - Proposal: Most specific wins (longest prefix match)

2. **Access control**: Can any process register any pattern?
   - Proposal: Namespace by user, or require capability

3. **Handler timeout**: What if a handler never responds (hangs)?
   - Proposal: Configurable timeout (default 30s?), returns `{ op: 'error', code: 'ETIMEDOUT' }`
   - Alternative: Caller's responsibility to cancel

## Implementation

### Dispatcher Changes

1. **Routing table**: Add `Map<string, { pid: string }>` to dispatcher for userspace handlers

2. **Pending forwards**: Add `Map<string, { callerProc, originalRequestId, recvEnd }>` to track in-flight forwarded requests

3. **Before switch statement**: Check routing table first
   ```typescript
   const handler = this.findUserspaceHandler(name);
   if (handler) {
       yield* this.forwardToHandler(proc, requestId, name, args, handler);
       return;
   }
   // ... existing switch statement
   ```

4. **Forward logic**:
   ```typescript
   private async *forwardToHandler(
       callerProc: Process,
       requestId: string,
       name: string,
       args: unknown[],
       handler: { pid: string },
   ): AsyncIterable<Response> {
       const handlerProc = this.kernel.processes.get(handler.pid);
       if (!handlerProc || handlerProc.state !== 'running') {
           yield respond.error('ESRCH', 'Handler process not found');
           return;
       }

       // Create response channel
       const [recvEnd, sendEnd] = createMessagePipe(requestId);
       const responseFd = allocHandle(this.kernel, handlerProc, sendEnd);

       // Send request to handler
       handlerProc.worker.postMessage({
           type: 'syscall-request',
           id: requestId,
           call: name,
           args,
           caller: callerProc.id,
           responseFd,
       });

       // Read responses from pipe and forward to caller
       for await (const response of recvEnd.exec({ op: 'recv' })) {
           if (response.op === 'done') {
               yield response;
               break;
           }
           yield response;
           if (response.op === 'ok' || response.op === 'error') {
               break;
           }
       }

       // Cleanup
       await recvEnd.close();
   }
   ```

5. **New syscalls**: Add `syscall:register`, `syscall:unregister`, `syscall:list` to the switch statement

### Userspace Changes

1. **Message handler**: Extend ROM's `onmessage` to handle `syscall-request` type

2. **`onSyscallRequest` helper**: New function in ROM that:
   - Registers a handler for `syscall-request` messages
   - Wraps the user's generator, writing yields to `responseFd`
   - Handles errors and cleanup

### Files to Modify

- `src/syscall/dispatcher.ts` - Add routing table, forward logic, new syscalls
- `src/kernel/types.ts` - Add `SyscallRequestMessage` type
- `rom/lib/process/syscall.ts` - Add `onSyscallRequest` helper
- `rom/lib/process/index.ts` - Export new helper

## Example: Display Server

```typescript
// /svc/displayd.ts
export default async function main(): Promise<void> {
    await call('syscall:register', 'display:*');

    onSyscallRequest(async function* (call, args, caller) {
        if (call === 'display:connect') {
            const display = await createDisplay(args[0]);
            return { op: 'ok', data: { displayId: display.id } };
        }

        if (call === 'display:subscribe') {
            const displayId = args[0] as string;
            for await (const event of subscribeToDisplay(displayId)) {
                yield { op: 'item', data: event };
            }
            return { op: 'done' };
        }
    });
}

// Browser client via Gateway WebSocket
const { displayId } = await call('display:connect', { width: 1920, height: 1080 });
for await (const event of call('display:subscribe', displayId)) {
    renderEvent(event);
}
```
