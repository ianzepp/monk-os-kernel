# OS Hardening

End-to-end architecture and code review for failure points, edge cases, and defensive error handling.

**Theme**: Fail fast, fail with clear reasons.

## Review Summary

Completed: 2024-12-01

| Component | Critical | High | Medium | Low | Status |
|-----------|----------|------|--------|-----|--------|
| kernel.ts | 1 | 3 | 4 | 2 | Reviewed |
| syscalls.ts | 0 | 1 | 2 | 1 | Reviewed |
| resource.ts | 0 | 2 | 2 | 0 | Reviewed |
| vfs.ts | 0 | 1 | 1 | 1 | Reviewed |
| rom/lib/ | 0 | 1 | 2 | 0 | Reviewed |
| hal/ | 0 | 0 | 1 | 1 | Reviewed |

---

## Critical Issues

### K-001: Path Traversal via `..` Not Filtered
**File**: `src/vfs/vfs.ts:546-558`
**Priority**: Critical (Security)

The `normalizePath()` function collapses slashes and handles trailing slashes but does **not** resolve `..` components. A malicious path like `/home/user/../../../etc/passwd` is not normalized.

```typescript
// Current code - no .. handling
private normalizePath(path: string): string {
    let normalized = path.replace(/\/+$/, '') || '/';
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }
    normalized = normalized.replace(/\/+/g, '/');
    return normalized;
}
```

**Risk**: Path traversal attacks could access files outside intended directories.

**Fix**:
```typescript
private normalizePath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    const normalized: string[] = [];

    for (const part of parts) {
        if (part === '..') {
            normalized.pop(); // Go up, but never above root
        } else if (part !== '.') {
            normalized.push(part);
        }
    }

    return '/' + normalized.join('/');
}
```

---

## High Priority Issues

### K-002: Implicit Reference Count Initialization
**File**: `src/kernel/kernel.ts:826-829, 879-891`
**Priority**: High (Resource Leak)

The `refResource()` function uses `?? 1` assuming initial refcount is 1:

```typescript
private refResource(resourceId: string): void {
    const refs = this.resourceRefs.get(resourceId) ?? 1; // Assumes 1
    this.resourceRefs.set(resourceId, refs + 1);
}
```

But `resourceRefs` is never set when resources are created. This works by coincidence but is fragile.

**Risk**: If a resource is created but never assigned to an fd, refcount will never reach 0 and resource leaks.

**Fix**: Explicitly initialize refcount when creating resources:
```typescript
// When creating resource
this.resources.set(resource.id, resource);
this.resourceRefs.set(resource.id, 1); // Explicit
```

Also applies to: `handleRefs`, `portRefs`

---

### K-003: PipeBuffer Has No Capacity Limit
**File**: `src/kernel/resource.ts:668-837`
**Priority**: High (DoS)

`PipeBuffer` stores chunks without any size limit:

```typescript
write(data: Uint8Array): number {
    // No size check!
    this.chunks.push(data);
    this.totalBytes += data.length;
    return data.length;
}
```

**Risk**: A writer can exhaust kernel memory by writing faster than reader consumes.

**Fix**: Add bounded buffer with backpressure:
```typescript
const PIPE_BUFFER_HIGH_WATER = 64 * 1024; // 64KB

write(data: Uint8Array): number {
    if (this.totalBytes + data.length > PIPE_BUFFER_HIGH_WATER) {
        // Block or throw EAGAIN
        throw new EAGAIN('Pipe buffer full');
    }
    // ... existing write logic
}
```

---

### K-004: Port recv() Blocks Indefinitely
**File**: `src/kernel/resource.ts:261-269, 373-392, 475-488, 581-593`
**Priority**: High (Process Hang)

All port types have `recv()` that blocks forever with no cancellation:

```typescript
async recv(): Promise<PortMessage> {
    return new Promise((resolve) => {
        this.waiters.push(resolve); // Waits forever
    });
}
```

As noted in the code comment (lines 236-240): "If a process is blocked in recv() when SIGTERM arrives, it can't respond gracefully."

**Risk**: Processes cannot be gracefully terminated while blocked in recv().

**Fix**: Add AbortSignal support:
```typescript
async recv(signal?: AbortSignal): Promise<PortMessage> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new ECANCELED('Recv cancelled'));
            return;
        }

        const cleanup = () => {
            signal?.removeEventListener('abort', onAbort);
        };

        const onAbort = () => {
            cleanup();
            reject(new ECANCELED('Recv cancelled'));
        };

        signal?.addEventListener('abort', onAbort);
        this.waiters.push((msg) => {
            cleanup();
            resolve(msg);
        });
    });
}
```

---

### K-005: No Timeout on wait() Syscall
**File**: `src/kernel/kernel.ts:497-527`
**Priority**: High (Process Hang)

The `wait()` syscall blocks until a child exits with no timeout:

```typescript
return new Promise(resolve => {
    const waiters = this.waiters.get(target.id) ?? [];
    waiters.push((status) => {
        this.reapZombie(caller, pid, target);
        resolve({ ...status, pid });
    });
    this.waiters.set(target.id, waiters);
});
```

**Risk**: If child never becomes zombie (e.g., stuck in blocked recv), parent hangs forever.

**Fix**: Add optional timeout parameter to wait syscall.

---

### K-006: Read Syscall EOF Semantics Are Type-Dependent
**File**: `src/kernel/syscalls.ts:167-172`
**Priority**: High (Correctness)

EOF detection checks resource type directly:

```typescript
// Short read indicates EOF for files, not for sockets/pipes
if (resource.type === 'file' && chunk.length < size) {
    break;
}
```

**Risk**: Wrong EOF behavior if resource type changes or new types added.

**Fix**: Resources should encapsulate EOF semantics:
```typescript
interface Resource {
    read(size?: number): Promise<Uint8Array>;
    isEOF(): boolean;  // Resource knows when it's exhausted
}
```

---

### K-007: ByteWriter Has No Backpressure
**File**: `rom/lib/io.ts:207-330`
**Priority**: High (Memory)

`ByteWriter` queues chunks without limit:

```typescript
private emit(chunk: Uint8Array): void {
    if (this.waiting.length > 0) {
        const waiter = this.waiting.shift()!;
        waiter.resolve({ done: false, value: chunk });
    } else {
        this.chunks.push(chunk); // Unbounded queue
    }
}
```

**Risk**: Producer outrunning consumer exhausts memory.

**Fix**: Add high-water mark and make `write()` async with backpressure.

---

## Medium Priority Issues

### K-008: Error Swallowing in Cleanup Code
**File**: `src/kernel/kernel.ts:425-448, 343, 884, 904, 1034`
**Priority**: Medium (Debuggability)

Cleanup code catches and ignores errors:

```typescript
// Lines 425-448 - exit cleanup
for (const [fd] of proc.fds) {
    try {
        await this.closeResource(proc, fd);
    } catch {
        // Ignore errors during cleanup  <-- Silent!
    }
}

// Line 343 - shutdown
await port.close().catch(() => {});  // Silent!
```

**Risk**: Real bugs hidden, debugging difficult.

**Fix**: Log errors at debug level even if ignoring:
```typescript
try {
    await this.closeResource(proc, fd);
} catch (err) {
    debug('cleanup', `fd ${fd} close failed: ${(err as Error).message}`);
}
```

---

### K-009: SIGTERM Timer Not Cancelled
**File**: `src/kernel/kernel.ts:486-491`
**Priority**: Medium (Resource Waste)

When kill() sends SIGTERM, it schedules SIGKILL but doesn't track the timer:

```typescript
setTimeout(() => {
    if (target.state === 'running') {
        this.forceExit(target, 128 + SIGTERM);
    }
}, TERM_GRACE_MS);
```

**Risk**: Timer fires even if process exited naturally. While it checks state, the timer still consumes resources.

**Fix**: Track and cancel timeout when process exits:
```typescript
const timeoutId = setTimeout(...);
// Store timeoutId and cancel in forceExit/exit
```

---

### K-010: Missing Input Validation on Syscall Args
**File**: `src/kernel/kernel.ts:181-207`
**Priority**: Medium (Robustness)

Several syscalls don't fully validate arguments:

```typescript
// redirect syscall - doesn't validate fds are positive integers
this.syscalls.register('redirect', wrapSyscall((proc, args) => {
    const { target, source } = args as { target: number; source: number };
    // target/source could be NaN, negative, non-integer
    return this.redirectFd(proc, target, source);
}));
```

**Fix**: Validate all untrusted inputs:
```typescript
if (!Number.isInteger(target) || target < 0) {
    throw new EINVAL('target must be non-negative integer');
}
```

---

### K-011: Unbounded Waiters Arrays
**File**: `src/kernel/kernel.ts:519, resource.ts:308, 429, 673`
**Priority**: Medium (Memory)

Waiter arrays grow unbounded:

```typescript
this.waiters.push(resolve);
// Never cleaned up if many callers wait
```

**Risk**: Memory growth if many processes wait on same resource.

**Fix**: Limit waiters with EAGAIN when full, or use Set with cleanup.

---

### K-012: chdir Doesn't Validate Directory Exists
**File**: `src/kernel/syscalls.ts:372-380`
**Priority**: Medium (Correctness)

The `chdir` syscall sets cwd without verifying path exists:

```typescript
async *chdir(proc: Process, path: unknown): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }
    // TODO: Verify path exists and is a directory  <-- Missing!
    proc.cwd = path;
    yield respond.ok();
}
```

**Fix**: Call `vfs.stat()` and verify it's a folder before changing cwd.

---

### K-013: Shell Tokenizer Silently Drops Trailing Escape
**File**: `rom/lib/shell/parse.ts:79-117`
**Priority**: Medium (UX)

If input ends with `\`, the escape flag is set but never used:

```typescript
for (const char of input) {
    if (escape) {
        current += char;
        escape = false;
        continue;
    }
    if (char === '\\') {
        escape = true;  // Set but never cleared if last char
        continue;
    }
    // ...
}
```

**Risk**: `echo test\` loses the backslash silently.

**Fix**: Check `escape` after loop and handle appropriately (error or treat `\` as literal).

---

### K-014: VFS findChild Is O(n) Per Path Component
**File**: `src/vfs/vfs.ts:593-606`
**Priority**: Medium (Performance)

Path resolution scans all entities for each component:

```typescript
private async findChild(parentId: string, name: string): Promise<string | null> {
    for await (const key of this.hal.storage.list('entity:')) {
        const data = await this.hal.storage.get(key);
        // ...
    }
}
```

**Risk**: Deep paths with many files become very slow.

**Fix**: Maintain parent→children index, or use path→id cache.

---

## Low Priority Issues

### K-015: Debug Category Inconsistency
**File**: `src/kernel/kernel.ts:50-54`
**Priority**: Low (DX)

Debug categories are strings without enforcement:

```typescript
debug('syscall', ...);
debug('tcp', ...);
debug('channel', ...);
debug('spawn', ...);
```

**Fix**: Use enum or type for categories.

---

### K-016: Magic Numbers in Stream Constants
**File**: `src/kernel/types.ts:154-158`
**Priority**: Low (Maintainability)

Stream constants are hardcoded with TODO comment:

```typescript
export const STREAM_HIGH_WATER = 1000;  // Item count, not bytes
export const STREAM_LOW_WATER = 100;
export const STREAM_STALL_TIMEOUT = 5000;
```

**Fix**: Consider byte-based thresholds as noted in the TODO.

---

### K-017: HAL Error Mapping Has Catch-All
**File**: `src/hal/errors.ts:364-413`
**Priority**: Low (Debuggability)

`fromSystemError()` maps unknown codes to EIO:

```typescript
default:
    return new EIO(message || 'Unknown error');
```

**Risk**: Original error code lost.

**Fix**: Preserve original code in message or add wrapper type.

---

## Already Noted Issues (from OS_PIPES.md)

These are tracked in OS_PIPES.md and confirmed during this review:

1. **Stall detection conflates producer/consumer** - Fixed with `itemsSent > 0` check
2. **Resource type leakage in syscalls** - Still present (K-006)
3. **Arbitrary timing constants** - Noted (K-016)
4. **Implicit EOF semantics** - Documented
5. **Implicit refcount initialization** - (K-002)

---

## Hardening Patterns

Reference patterns to apply consistently:

### Defensive fd Access
```typescript
const resource = this.getResource(proc, fd);
if (!resource) {
    throw new EBADF(`Bad file descriptor: ${fd}`);
}
if (resource.closed) {
    throw new EBADF(`File descriptor closed: ${fd}`);
}
```

### Timeout Wrappers
```typescript
async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new ETIMEDOUT(msg)), ms)
    );
    return Promise.race([promise, timeout]);
}
```

### Resource Cleanup with Logging
```typescript
const cleanup: Array<() => Promise<void>> = [];
try {
    // ... acquire resources, push cleanup functions
} finally {
    for (const fn of cleanup.reverse()) {
        await fn().catch(err => debug('cleanup', `Error: ${err.message}`));
    }
}
```

### Input Validation
```typescript
function validateFd(fd: unknown): asserts fd is number {
    if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0) {
        throw new EINVAL('fd must be a non-negative integer');
    }
}
```

### Bounded Queues
```typescript
class BoundedQueue<T> {
    private items: T[] = [];
    private readonly maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    push(item: T): boolean {
        if (this.items.length >= this.maxSize) {
            return false; // Caller should handle backpressure
        }
        this.items.push(item);
        return true;
    }
}
```

---

## Implementation Priority

### Phase 1: Critical Security (Do First)
- [x] K-001: Fix path traversal in normalizePath (completed 2024-12-01)

### Phase 2: Resource Safety (Next)
- [ ] K-002: Explicit refcount initialization
- [x] K-003: Bounded pipe buffers (completed 2024-12-01)
- [ ] K-007: ByteWriter backpressure

### Phase 3: Reliability
- [ ] K-004: Cancellable port recv
- [ ] K-005: Timeout on wait syscall
- [ ] K-006: Resource encapsulates EOF

### Phase 4: Debuggability
- [ ] K-008: Log cleanup errors
- [ ] K-010: Input validation
- [ ] K-012: chdir validation

### Phase 5: Polish
- [ ] Remaining medium/low issues

---

## TypeScript Strict Mode

Enabled strict type checking in `tsconfig.json` and `tsconfig.src.json` to catch type safety issues at compile time.

### Settings Enabled

```json
{
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true,
  "strictFunctionTypes": true,
  "strictBindCallApply": true,
  "strictPropertyInitialization": true,
  "noImplicitThis": true,
  "useUnknownInCatchVariables": true,
  "alwaysStrict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true
}
```

### Errors by File (as of 2024-12-01)

**All 54 strict mode errors have been resolved.**

Fixes applied:
- Removed unused scaffolding variables and class members
- Added non-null assertions where array bounds are guaranteed
- Prefixed intentionally unused parameters with underscore
- Added `override` modifiers for overridden methods
- Used `@ts-expect-error` for intentional scaffolding code
- Improved input validation (e.g., mounts.ts size unit validation)
- Changed Bun UDP socket type to `any` (Bun types evolving)

### Key Issue: `noUncheckedIndexedAccess`

This setting treats array/Map access as returning `T | undefined`, catching real bugs:

```typescript
// Before: chunk could be undefined, runtime crash
const chunk = this.chunks[0];
chunk.length; // Boom!

// After: Must handle undefined
const chunk = this.chunks[0];
if (chunk) {
    chunk.length; // Safe
}
// Or use assertion when bounds are known
const chunk = this.chunks[0]!; // Safe: checked length > 0
```

### Validation Utilities

Created `src/kernel/validate.ts` with fail-fast validators:

- **Primitive**: `assertString`, `assertNumber`, `assertNonNegativeInt`, `assertUint8Array`
- **Optional**: `optionalString`, `optionalPositiveInt`, `optionalBoolean`
- **Message data**: `getMessageData`, `getDataString`, `getDataUint8Array`
- **Resource**: `assertResourceOpen`, `assertDefined`, `unwrap`, `unwrapOr`

Usage pattern:
```typescript
import { assertString, assertNonNegativeInt, getMessageData } from '@src/kernel/validate.js';

async *open(proc: Process, path: unknown, flags: unknown): AsyncIterable<Response> {
    assertString(path, 'path');           // Throws EINVAL if not string
    assertNonNegativeInt(fd, 'fd');       // Throws EINVAL if not non-negative int

    const data = getMessageData(msg);     // Returns {} if undefined
    const chunkSize = getOptionalDataPositiveInt(data, 'chunkSize');
}
```

---

## Test Cases Needed

### Resource Leaks
- [ ] Create resource, never assign to fd, verify cleanup
- [ ] Spawn child, parent exits before wait, verify reaping
- [ ] Create pipe, close write end, verify read returns EOF

### Memory Exhaustion
- [ ] Fast writer, slow reader through pipe
- [ ] Many processes waiting on same zombie
- [ ] Large directory listing

### Path Traversal
- [ ] `/home/user/../../../etc/passwd`
- [ ] `./././../..`
- [ ] Symlinks pointing outside allowed paths (when enabled)

### Timeouts
- [ ] Process blocked in recv, SIGTERM, verify graceful exit
- [ ] Parent waiting on stuck child, verify eventual cleanup

---

## Review Sessions

| Date | Component | Reviewer | Status |
|------|-----------|----------|--------|
| 2024-12-01 | kernel.ts | Claude | Complete |
| 2024-12-01 | syscalls.ts | Claude | Complete |
| 2024-12-01 | resource.ts | Claude | Complete |
| 2024-12-01 | vfs.ts | Claude | Complete |
| 2024-12-01 | rom/lib/ | Claude | Complete |
| 2024-12-01 | hal/errors.ts | Claude | Complete |
