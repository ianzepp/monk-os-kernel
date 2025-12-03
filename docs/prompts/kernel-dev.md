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
 * INV-2: [Second invariant]
 * ...
 *
 * CONCURRENCY MODEL
 * =================
 * [Explain what's single-threaded vs async, what can interleave]
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

## Error Handling Patterns

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
- [ ] Constants have WHY comments explaining chosen values
- [ ] Section markers create clear visual structure
