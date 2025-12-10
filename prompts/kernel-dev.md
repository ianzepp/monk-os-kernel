# Kernel Developer Code Review Prompt

Use this prompt when rewriting core infrastructure files in Monk OS.

---

## The Prompt

```
I'd like you to pretend a Linux kernel developer and a staff engineer TypeScript developer had a baby, and that baby was doing a code review on [FILENAME]. I'm looking for:

1. **Race conditions** - Identify async operations that could interleave badly, state that could be corrupted by concurrent access, TOCTOU bugs, and missing synchronization
2. **Assumptions and invariants** - Document what must always be true for the code to work correctly
3. **Comprehensive comments** - Explain WHAT the code does and WHY it does it that way
4. **Testability** - Improve dependency injection, add test helper methods, make state inspectable
5. **Error handling** - Ensure errors are caught, logged, and don't leave state corrupted

Produce a rewritten [FILENAME] that both parents would be proud of.
```

---

## Expected Output Structure

The rewritten file should follow this structure:

### 1. Module Header Block

```typescript
/**
 * [Module Name] - [One-line description]
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * [2-4 paragraphs explaining the module's role in the system]
 *
 * STATE MACHINE
 * =============
 * [ASCII diagram of state transitions if applicable]
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: [First invariant]
 *        VIOLATED BY: [What operation could break this]
 * INV-2: [Second invariant]
 *        VIOLATED BY: [What operation could break this]
 * ...
 *
 * CONCURRENCY MODEL
 * =================
 * [Explain what's single-threaded vs async, what can interleave]
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * postMessage crosses thread boundaries. The kernel runs in the main thread
 * while each process runs in its own worker thread.
 *
 * LOCK ORDERING (to prevent deadlock)
 * ===================================
 * [If multiple locks exist, document acquisition order]
 * L-1: Always acquire [first lock] before [second lock]
 * L-2: ...
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: [First mitigation strategy]
 * RC-2: [Second mitigation strategy]
 * ...
 *
 * MEMORY MANAGEMENT
 * =================
 * [Explain resource lifecycle, cleanup responsibilities]
 *
 * @module [module-name]
 */
```

### 2. Constants Section

```typescript
// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * [Constant description]
 * WHY: [Explain why this value was chosen]
 */
const SOME_CONSTANT = 42;
```

### 3. Types Section

```typescript
// =============================================================================
// TYPES
// =============================================================================

/**
 * [Type description]
 *
 * TESTABILITY: [Explain how this enables testing if applicable]
 */
export interface SomeDeps {
    /** [Field description] */
    someField: SomeType;
}
```

### 4. Helper Functions

```typescript
// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * [Function description]
 *
 * WHY: [Explain why this helper exists]
 */
function helperFunction(): void {
    // ...
}
```

### 5. Main Class with Grouped Sections

```typescript
// =============================================================================
// MAIN CLASS
// =============================================================================

export class SomeClass {
    // =========================================================================
    // SECTION NAME (e.g., CORE DEPENDENCIES, STATE MANAGEMENT)
    // =========================================================================

    /**
     * [Field description]
     *
     * WHY: [Explain purpose]
     * INVARIANT: [State any invariants this field maintains]
     */
    private readonly someField: SomeType;

    // ... more sections ...
}
```

---

## Comment Style Guide

### Method Comments

```typescript
/**
 * [Brief description of what the method does]
 *
 * ALGORITHM: (if complex)
 * 1. [Step 1]
 * 2. [Step 2]
 * ...
 *
 * RACE CONDITION: (if applicable)
 * [Describe the race and how it's mitigated]
 *
 * @param paramName - [Description]
 * @returns [Description]
 * @throws ErrorType - [When this error is thrown]
 */
```

### Inline Comments

Use inline comments to explain WHY, not WHAT:

```typescript
// BAD: Increment counter
counter++;

// GOOD: Track items for backpressure calculation
counter++;

// GOOD: RACE FIX: Check state after await - process may have been killed
if (proc.state !== 'running') {
    return;
}
```

### Section Markers

Use consistent section markers:

```typescript
// =============================================================================
// MAJOR SECTION (top-level in class)
// =============================================================================

// -------------------------------------------------------------------------
// Minor Section (within a major section)
// -------------------------------------------------------------------------
```

---

## Race Condition Patterns to Look For

### 1. State After Await

```typescript
// BEFORE (buggy)
async function handleRequest(proc: Process) {
    const data = await fetchData();
    proc.worker.postMessage(data); // Process may be dead!
}

// AFTER (safe)
async function handleRequest(proc: Process) {
    const data = await fetchData();
    // RACE FIX: Check process state after every await
    if (proc.state !== 'running') {
        return;
    }
    proc.worker.postMessage(data);
}
```

### 2. Callback Cleanup on Timeout

```typescript
// BEFORE (leaky)
const waitPromise = new Promise(resolve => {
    waiters.push(resolve); // Never removed on timeout!
});
setTimeout(() => reject(new Error('timeout')), 5000);

// AFTER (clean)
const entry = {
    callback: resolve,
    cleanup: () => {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
    }
};
waiters.push(entry);
const timeoutId = setTimeout(() => {
    entry.cleanup(); // Remove before rejecting
    reject(new Error('timeout'));
}, 5000);
```

### 3. TOCTOU (Time-of-Check-Time-of-Use)

```typescript
// BEFORE (racy)
if (await exists(path)) {
    await writeFile(path, data); // Someone else may have deleted it!
}

// AFTER (atomic)
try {
    await writeFile(path, data, { createOnly: true });
} catch (err) {
    if (err.code === 'EEXIST') {
        // Handle conflict
    }
}
```

### 4. Event Listener Cleanup

```typescript
// BEFORE (leaky)
class RequestHandler {
    start(proc: Process) {
        proc.on('exit', this.handleExit); // Never removed if handler outlives proc!
    }
}

// AFTER (clean)
class RequestHandler {
    private cleanupFns = new Map<number, () => void>();

    start(proc: Process) {
        const handler = () => this.handleExit(proc);
        proc.on('exit', handler);

        // Store cleanup function
        this.cleanupFns.set(proc.pid, () => {
            proc.off('exit', handler);
        });
    }

    stop(proc: Process) {
        const cleanup = this.cleanupFns.get(proc.pid);
        if (cleanup) {
            cleanup();
            this.cleanupFns.delete(proc.pid);
        }
    }
}
```

---

## Testability Patterns

### Dependency Injection Interface

```typescript
/**
 * Dependencies that can be injected for testing.
 */
export interface ModuleDeps {
    /** Current time in milliseconds (default: Date.now) */
    now: () => number;

    /** Schedule a callback (default: setTimeout) */
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;

    /** Cancel a scheduled callback (default: clearTimeout) */
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

function createDefaultDeps(): ModuleDeps {
    return {
        now: () => Date.now(),
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (id) => clearTimeout(id),
    };
}

constructor(deps?: Partial<ModuleDeps>) {
    this.deps = { ...createDefaultDeps(), ...deps };
}
```

### Test Helper Methods

```typescript
// =========================================================================
// PUBLIC ACCESSORS (for testing)
// =========================================================================

/**
 * Get internal state count.
 * TESTING: Allows tests to verify no leaks.
 */
getItemCount(): number {
    return this.items.size;
}

/**
 * Check if resource is held.
 * TESTING: Allows tests to verify cleanup.
 */
isResourceHeld(id: string): boolean {
    return this.resources.has(id);
}
```

---

## HAL Boundary

### Never Use Bun Primitives Outside HAL

**CRITICAL**: All Bun APIs must be accessed through HAL. The kernel, VFS, EMS, and syscall layers must NEVER import or call Bun primitives directly.

```typescript
// BAD - Direct Bun usage in kernel code
import { $ } from 'bun';
const socket = Bun.udpSocket({ port: 9999 });
const hash = Bun.hash(content);
const file = Bun.file('/tmp/foo');
await Bun.sleep(1000);

// GOOD - Use HAL abstractions
// For UDP: use hal.network (when implemented) or kernel ports
// For hashing: use hal.crypto.hash()
// For files: use hal.file or VFS
// For timing: use hal.timer.setTimeout()
```

**WHY**:
1. **Testability**: HAL can be mocked for unit tests without real I/O
2. **Portability**: Decouples from Bun-specific APIs
3. **Consistency**: Single source of truth for platform operations
4. **Visibility**: `bun run build:warn` catches violations

**Current Violations** (tracked in `docs/bugs/`):
- `src/kernel/resource/udp-port.ts` - Uses `Bun.udpSocket()` directly
- `src/kernel/loader/vfs-loader.ts` - Uses `Bun.Transpiler` and `Bun.hash()`

**If HAL doesn't support what you need**: Add it to HAL first, then use it. Don't bypass HAL "just this once."

---

## Error Handling Patterns

### Use Typed Errors, Not Generic Error

**CRITICAL**: Never use `new Error()` in kernel code. Always use typed errors from `@src/hal/errors.js`.

```typescript
// BAD - Generic error loses type information
throw new Error('File not found: /tmp/foo');
throw new Error(`Invalid argument: ${value}`);
throw new Error('Permission denied');

// GOOD - Typed errors enable precise handling
import { ENOENT, EINVAL, EACCES, EBADF, EIO } from '@src/hal/errors.js';

throw new ENOENT('/tmp/foo');
throw new EINVAL(`Invalid argument: ${value}`);
throw new EACCES('Permission denied');
```

**Available error types** (see `src/hal/errors.ts` for full list):

| Error | Code | Use When |
|-------|------|----------|
| `ENOENT` | 2 | File/path not found |
| `EACCES` | 13 | Permission denied |
| `EBADF` | 9 | Bad file descriptor |
| `EINVAL` | 22 | Invalid argument |
| `EEXIST` | 17 | File already exists |
| `ENOTDIR` | 20 | Not a directory |
| `EISDIR` | 21 | Is a directory |
| `ENOSPC` | 28 | No space left |
| `ETIMEDOUT` | 110 | Operation timed out |
| `EIO` | 5 | Generic I/O error (last resort) |

**WHY**: Typed errors enable callers to handle specific cases:
```typescript
try {
    await vfs.open(path, flags, caller);
}
catch (err) {
    if (err instanceof ENOENT) {
        // Handle missing file specifically
    }
    else if (err instanceof EACCES) {
        // Handle permission error specifically
    }
    throw err; // Re-throw unknown errors
}
```

### Catch and Log, Don't Swallow

```typescript
// BEFORE (silent failure)
handle.close().catch(() => {});

// AFTER (logged failure)
handle.close().catch((err) => {
    this.printk('cleanup', `handle ${id} close failed: ${formatError(err)}`);
});
```

### Safe Message Sending

```typescript
/**
 * Send a response to a process.
 *
 * SAFETY: Catches and logs errors from postMessage.
 * This can happen if worker is terminating.
 */
private sendResponse(proc: Process, id: string, response: Response): void {
    try {
        proc.worker.postMessage({ type: 'response', id, result: response });
    } catch (err) {
        this.printk('warn', `Failed to send to ${proc.cmd}: ${formatError(err)}`);
    }
}
```

---

## Checklist Before Submitting Rewrite

- [ ] Module header with ARCHITECTURE, INVARIANTS, CONCURRENCY MODEL
- [ ] All async methods check state after await points
- [ ] All callbacks have cleanup functions for timeout scenarios
- [ ] Dependencies injectable via constructor parameter
- [ ] Test helper methods for inspecting internal state
- [ ] Every field has a comment explaining WHY it exists
- [ ] Every non-trivial method has algorithm/race condition documentation
- [ ] Error handling logs failures, doesn't swallow silently
- [ ] **No `new Error()` - use typed errors (ENOENT, EINVAL, etc.)**
- [ ] **No Bun primitives - use HAL abstractions**
- [ ] Constants have WHY comments explaining chosen values
- [ ] Section markers create clear visual structure
