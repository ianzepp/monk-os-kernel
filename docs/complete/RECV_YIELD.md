# Bug: SocketHandleAdapter.recv() yield hangs on EOF

## Status
**FIXED** - Race condition in BunSocket.read() resolved

## Symptom
When a client closes a Unix socket connection, gatewayd's read loop does not exit. The `afterEach` cleanup in smoke tests times out because gatewayd cannot be stopped gracefully.

## Root Cause
**Race condition in `BunSocket.read()`** (`src/hal/network/socket.ts:167-224`)

The bug is NOT in the async generator chain as originally suspected. The actual issue is a race between the `isClosed()` check and Promise creation in `BunSocket.read()`:

```typescript
async read(opts?: SocketReadOpts): Promise<Uint8Array> {
    if (this.dataQueue.length > 0) {
        return this.dataQueue.shift()!;
    }

    if (this.isClosed()) {           // <-- Check happens here
        return new Uint8Array(0);
    }
                                      // <-- RACE WINDOW: close can fire here
    return new Promise((resolve, reject) => {
        // ...
        this.setDataResolve(data => {  // <-- Resolver stored here
            resolve(data);
        });
    });
}
```

The listener's close handler (`src/hal/network/listener.ts:339-348`) only wakes a pending read if `dataResolve` is non-null:

```typescript
close(socket: any) {
    (socket as any)._setClosed(true);
    const dataResolve = (socket as any)._getDataResolve();
    if (dataResolve) {
        dataResolve(new Uint8Array(0));  // Wake with EOF
    }
}
```

### Timeline of Failure

1. `recv()` calls `await this.socket.read()`
2. `read()` checks `isClosed()` → false
3. **Socket close event fires** (client called `end()`)
4. Close handler sets `closed = true`
5. Close handler checks `dataResolve` → **null** (Promise not created yet)
6. Close handler does nothing, returns
7. `read()` creates Promise, stores resolver in `dataResolve`
8. `read()` waits forever - close already happened, no one will wake it

### Why the Debug Trace is Misleading

The original debug trace suggested `recv()` hangs at `yield respond.done()`. In reality, `recv()` never reaches the yield because it's blocked at `await this.readChunk()` → `await this.socket.read()`. The `BunSocket.read()` Promise never resolves due to the race condition.

## Reproduction
```bash
bun test spec/rom/svc/gatewayd.test.ts
```

The test itself succeeds (response sent and received correctly), but the afterEach hook times out trying to stop gatewayd.

## Call Stack Analysis

### Normal Flow (Working)
1. gatewayd (Worker): `for await (const chunk of read(socketFd))`
2. Process lib: `syscall('file:read', fd)` - posts message to kernel
3. Kernel: `fileRead()` -> `yield* handle.exec({ op: 'recv' })`
4. SocketHandleAdapter: `recv()` yields `data` chunks
5. Kernel sends response messages back to Worker
6. Worker receives, gatewayd gets chunks

### EOF Flow (Broken)
1. Client calls `socket.end()`
2. Bun's listener `close` handler fires
3. Handler calls `dataResolve(new Uint8Array(0))` - wakes pending read
4. `SocketHandleAdapter.recv()`: `readChunk()` returns empty array
5. `recv()` breaks out of while loop
6. `recv()` executes `yield respond.done()` **<- HANGS HERE**
7. `yield respond.done()` never completes - caller doesn't consume it

## Debug Trace
```
SocketHandleAdapter.recv: got chunk, length=0
SocketHandleAdapter.recv: EOF, breaking
SocketHandleAdapter.recv: yielding done
# No "done yielded" message - yield is suspended
```

## Technical Details

The issue is in how streaming syscalls work between Workers and the kernel:

1. Worker's `syscall()` function is an async generator that:
   - Posts request message to kernel
   - Waits for response messages via `onmessage`
   - Yields each response to the caller

2. Kernel processes syscalls via `yield*` delegation:
   ```typescript
   // In syscall dispatcher
   case 'file:read':
       yield* fileRead(proc, this.kernel, args[0], args[1]);
   ```

3. For streaming ops, the kernel iterates the handle's generator and sends each yielded value back to the Worker as a message.

4. **The bug**: When `recv()` yields `done`, the kernel should:
   - Receive the yielded value
   - Send it as a message to the Worker
   - The Worker's syscall generator should yield it
   - gatewayd's `read()` should see `op: 'done'` and return

   But somewhere in this chain, the `done` response isn't being delivered or consumed.

## Likely Causes (Original - Superseded)

These were the original hypotheses before root cause was identified:

1. ~~**Kernel syscall loop exits early**: The kernel's iteration of `handle.exec()` may exit before consuming the final `done` yield.~~

2. ~~**Message not sent**: The kernel may not be sending the `done` response message to the Worker.~~

3. ~~**Worker not processing**: The Worker's syscall generator may not be iterating to receive the `done` message.~~

**Actual cause**: Race condition in HAL layer, not in the async generator chain.

## Impact
- Smoke tests time out during cleanup
- gatewayd processes cannot be stopped gracefully when clients disconnect
- Resource leaks (sockets remain open)

## Workarounds
1. Force-kill gatewayd instead of graceful stop
2. Use shorter timeouts in test cleanup
3. Unit tests (which mock the read loop) are unaffected

## Related Files
- **`src/hal/network/socket.ts`** - BunSocket.read() - **THE BUG IS HERE**
- **`src/hal/network/listener.ts`** - Socket close handler
- `src/kernel/handle/socket.ts` - SocketHandleAdapter.recv()
- `src/syscall/vfs.ts` - fileRead() syscall handler
- `src/syscall/dispatcher.ts` - Syscall routing
- `rom/lib/process/index.ts` - Worker-side read() and syscall()
- `src/kernel/worker/` - Worker message handling

## Fix

Add a post-setup closed check in `BunSocket.read()` (`src/hal/network/socket.ts`):

```typescript
return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (opts?.timeout) {
        timeoutId = setTimeout(() => {
            this.setDataResolve(null);
            reject(new ETIMEDOUT('Read timeout'));
        }, opts.timeout);
    }

    this.setDataResolve(data => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        resolve(data);
    });

    // RACE FIX: Check if closed AFTER setting resolver
    // Close handler may have fired between isClosed() check above and here
    if (this.isClosed()) {
        this.setDataResolve(null);
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        resolve(new Uint8Array(0));
    }
});
```

This ensures that even if the close handler fired during the race window (after the initial `isClosed()` check but before the resolver was set), the read will still return EOF.

## Next Steps (Original - Superseded)
1. ~~Add logging to kernel's syscall iteration to verify `done` is consumed~~
2. ~~Check Worker's `onmessage` handler for response delivery~~
3. ~~Verify the syscall generator's iteration completes properly~~
4. ~~Consider if streaming syscalls need explicit termination signals~~

## Resolution
1. ✅ Applied fix to `src/hal/network/socket.ts` - BunSocket.read()
2. ✅ Applied same fix to `src/hal/channel/websocket.ts` - recv() and waitForResponse()
3. ✅ Verified `bun test spec/rom/svc/gatewayd.test.ts` passes
4. ✅ Verified all HAL tests pass (487 tests)
