# Test Infrastructure Refactoring

> **Status**: Proposed
> **Complexity**: Medium
> **Dependencies**: None

Simplify test patterns by making HAL injectable into OS, eliminating manual mock wiring across spec/ subsystems.

---

## Problem Statement

The test suite has inconsistent patterns across subsystems:

| Subsystem | Current Pattern | Verdict |
|-----------|-----------------|---------|
| `spec/hal/` | Direct device instantiation | Clean |
| `spec/vfs/` | `createOsStack({ vfs: true })` | Clean |
| `spec/ems/` | Real HAL + in-memory SQLite | Clean |
| `spec/kernel/` | `createOsStack({ kernel: true })` | Clean |
| `spec/syscall/` | Manual mock wiring per file | **Spaghetti** |
| `spec/gateway/` | Minimal mocks + real sockets | Clean |
| `spec/rom/` | Full `new OS()` boot | Heavyweight |

The `spec/syscall/` tests are the worst offenders. Each file manually creates:
- `createMockProcess()`
- `createMockKernel()`
- `createMockVfs()`
- `createMockEms()`

...with `as unknown as Kernel` casts everywhere. This is verbose, error-prone, and tests mock behavior rather than real integration.

---

## Root Cause

Two missing pieces:

1. **No HAL injection into OS**: Cannot do `new OS({ hal: testHAL })`
2. **No TestHAL class**: No pre-built fast HAL for testing

The `createOsStack()` helper exists but returns raw subsystems, not an OS instance:

```typescript
const stack = await createOsStack({ vfs: true });
stack.hal   // HAL instance
stack.vfs   // VFS instance
stack.shutdown()
// No syscall(), service(), spawn() - not a real OS
```

---

## Proposed Solution

### 1. Add HAL injection to OS

```typescript
interface OSConfig {
    hal?: HAL;  // NEW: optional HAL injection
    storage?: {
        type: 'memory' | 'sqlite' | 'postgres';
        path?: string;
        url?: string;
    };
    env?: Record<string, string>;
    aliases?: Record<string, string>;
    debug?: boolean;
    romPath?: string;
}
```

When `hal` is provided, OS uses it directly instead of creating `BunHAL`.

When `hal` is not provided but `storage` is, OS creates HAL with that storage config (current behavior).

### 2. Create MemoryHAL (or TestHAL)

A pre-configured HAL optimized for testing:

```typescript
// Option A: Factory function
export function createMemoryHAL(): HAL {
    return new BunHAL({ storage: { type: 'memory' } });
}

// Option B: Subclass with test conveniences
export class TestHAL extends BunHAL {
    constructor() {
        super({ storage: { type: 'memory' } });
    }

    // Optional: test utilities
    reset(): Promise<void>;  // Clear all storage
    seedData(data: Record<string, unknown>): Promise<void>;
}
```

Option A is simpler and probably sufficient.

### 3. TestOS Already Exists

**Location**: `spec/helpers/test-os.ts`

TestOS already provides direct subsystem access via `internal*` prefixed getters:

```typescript
export class TestOS extends OS {
    get internalHal(): HAL { ... }
    get internalEms(): EMS { ... }
    get internalVfs(): VFS { ... }
    get internalKernel(): Kernel { ... }
    get internalDispatcher(): SyscallDispatcher { ... }
    get internalGateway(): Gateway { ... }
}
```

**Why `internal*` prefix?** Avoids conflicts with existing `ems()` and `vfs()` syscall wrapper methods on OS.

**Usage in tests**:
```typescript
import { TestOS } from '@spec/helpers/test-os.js';

it('should create file entity in EMS', async () => {
    const os = new TestOS({ hal: createMemoryHAL() });  // HAL injection is the missing piece
    await os.boot();

    // Use public API
    await os.syscall('file:open', '/test.txt', { write: true, create: true });

    // Direct subsystem access for assertions
    const entity = await os.internalEms.ops.selectOne('file', { pathname: '/test.txt' });
    expect(entity).toBeDefined();

    await os.shutdown();
});
```

**What's missing**: HAL injection (`OS({ hal })`) - TestOS exists but can't inject a custom HAL yet.

### 4. Remove OS Public Getters

Since all external access goes through the gateway protocol (not OS as a library), the public getters are unnecessary API surface:

**Remove from OS:**
- `getHAL()` - tests use `TestOS.internalHal`
- `getVFS()` - tests use `TestOS.internalVfs`
- `getKernel()` - tests use `TestOS.internalKernel`
- `getEMS()` - tests use `TestOS.internalEms`
- `getServices()` - unused
- `getEnv()` - unused

**Keep:**
- `getEntityOps()` - used internally by `EntityAPI` class (`src/os/ems.ts:102`)

**Migration:**
- `spec/kernel/shutdown.test.ts` - switch from `OS` to `TestOS`
- `spec/os.test.ts` - remove tests for deleted getters
- Update READMEs to remove getter examples

### 5. Update OS boot sequence

```typescript
class OS {
    private hal: HAL;
    private ownsHal: boolean;  // Track whether OS created HAL

    async boot(opts?: BootOpts): Promise<void> {
        // Use injected HAL or create one
        if (this.config.hal) {
            this.hal = this.config.hal;
            this.ownsHal = false;
        } else {
            this.hal = new BunHAL(this.config.storage);
            this.ownsHal = true;
            await this.hal.init();
        }

        // ... rest of boot
    }

    async shutdown(): Promise<void> {
        // ... shutdown subsystems

        // Only shutdown HAL if we created it
        if (this.ownsHal) {
            await this.hal.shutdown();
        }
    }
}
```

---

## Test Patterns After Refactoring

### Syscall Tests (Currently Spaghetti)

Before:
```typescript
// 50+ lines of mock factories per file
function createMockProcess(): Process { ... }
function createMockKernel(): Kernel { ... }
function createMockVfs(): VFS { ... }

it('should stat root directory', async () => {
    const proc = createMockProcess();
    const kernel = {} as Kernel;
    const vfs = { stat: mock(() => Promise.resolve({...})) } as unknown as VFS;

    const response = await firstResponse(fileStat(proc, kernel, vfs, '/'));
    // Testing mock behavior, not real behavior
});
```

After:
```typescript
let os: OS;

beforeEach(async () => {
    os = new OS({ hal: createMemoryHAL() });
    await os.boot();
});

afterEach(async () => {
    await os.shutdown();
});

it('should stat root directory', async () => {
    const result = await os.syscall('file:stat', '/');
    expect(result.model).toBe('folder');
    // Testing real behavior through real dispatch
});
```

### Integration Tests

Before:
```typescript
const stack = await createOsStack({ kernel: true });
// Have to use stack.kernel.someInternalMethod()
```

After:
```typescript
const os = new OS({ hal: createMemoryHAL() });
await os.boot();
// Use public API: os.syscall(), os.spawn(), os.service()
```

### When to Still Use createOsStack()

Keep `createOsStack()` for rare cases needing subsystem internals:
- Testing VFS model dispatch logic directly
- Testing EMS observer pipeline in isolation
- Testing kernel handle assignment internals

But these should be exceptions, not the norm.

---

## Migration Path

### Phase 1: Add HAL Injection

1. Add `hal?: HAL` to `OSConfig`
2. Update `OS.boot()` to use injected HAL
3. Update `OS.shutdown()` to track HAL ownership
4. Add `createMemoryHAL()` factory to `src/hal/`

### Phase 2: Migrate Syscall Tests

1. Create shared test helper: `spec/helpers/os.ts`
   ```typescript
   export async function createTestOS(): Promise<OS> {
       const os = new OS({ hal: createMemoryHAL() });
       await os.boot();
       return os;
   }
   ```

2. Migrate `spec/syscall/*.test.ts` one file at a time:
   - Replace mock factories with `createTestOS()`
   - Replace direct syscall function calls with `os.syscall()`
   - Delete mock factory code

3. Delete orphaned mock utilities

### Phase 3: Consolidate Other Tests

1. Review `spec/vfs/`, `spec/ems/`, `spec/kernel/`
2. Where tests use `createOsStack()` but only need public API, switch to `OS`
3. Keep `createOsStack()` only where subsystem internals are needed

### Phase 4: Cleanup

1. Consider deprecating `createOsStack()` or making it internal
2. Update AGENTS.md testing guidance
3. Document the test patterns in `spec/README.md`

---

## Estimated Scope

| Phase | Files | Effort |
|-------|-------|--------|
| Phase 1 | 4-5 files (OS, types, HAL factory, READMEs) | Small |
| Phase 2 | ~10 syscall test files | Medium |
| Phase 3 | ~15 other test files | Medium |
| Phase 4 | Docs only | Small |

Total: ~30 files touched, mostly deletions.

Notes:
- TestOS already exists at `spec/helpers/test-os.ts`
- OS public getters removed (tests use TestOS instead)

---

## Benefits

1. **Less code**: Delete hundreds of lines of mock factories
2. **Real integration tests**: Test actual dispatch chain, not mocks
3. **Single pattern**: One way to test above HAL level
4. **Faster feedback**: Catch integration bugs that mocks hide
5. **Easier onboarding**: New contributors see one clear pattern

---

## Open Questions

1. **TestHAL vs createMemoryHAL()**: Is a factory function enough, or do we need a class with test utilities (reset, seed)?

2. **HAL lifecycle**: If test provides HAL, should OS ever call `hal.init()`? Current proposal: no, caller is responsible.

3. **createOsStack() fate**: Deprecate, make internal, or keep as escape hatch?

---

## References

- `src/os/os.ts` - OS class (already has protected fields for TestOS)
- `src/os/stack.ts` - Current `createOsStack()` helper
- `src/os/types.ts` - OSConfig interface (needs `hal?: HAL`)
- `src/hal/index.ts` - HAL interface and BunHAL
- `spec/helpers/test-os.ts` - TestOS subclass (already exists)
- `spec/syscall/*.test.ts` - Current spaghetti tests
