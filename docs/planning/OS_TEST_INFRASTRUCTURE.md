# Test Infrastructure Refactoring

> **Status**: Proposed
> **Complexity**: Medium
> **Dependencies**: None

Simplify test patterns by introducing a BaseOS class hierarchy with flexible boot options for testing.

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

Two parallel approaches exist for test setup:

1. **OS class**: Full boot, no partial initialization, no HAL injection
2. **createOsStack()**: Partial boot, HAL injection, but returns raw subsystems (not an OS instance)

This forces tests to choose between:
- Full OS with overhead they don't need
- Raw subsystems without syscall API

---

## Proposed Solution: BaseOS Class Hierarchy

Introduce a three-class hierarchy:

```
BaseOS (abstract)
├── Protected subsystem fields (__hal, __ems, __auth, __vfs, __kernel, __dispatcher, __gateway)
├── shutdown() - works for any subset of initialized layers
├── syscall() - requires kernel, throws if not booted with kernel
├── Convenience methods (spawn, kill, mount)
├── alias(), resolvePath()
├── isBooted()
└── abstract boot()

OS extends BaseOS
└── boot(opts?) - linear, all-or-nothing (production)
    HAL → EMS → Auth → VFS → dirs → ROM → Kernel → Dispatcher → Gateway → Init

TestOS extends BaseOS
├── boot({ hal?, layers? }) - flexible partial boot
│   Layers: hal → ems → auth → vfs → kernel → dispatcher → gateway
└── internal* getters for direct subsystem access
```

### BaseOS

Contains everything except `boot()`:

```typescript
export abstract class BaseOS {
    // Subsystem fields (protected for TestOS access)
    protected __hal: HAL | null = null;
    protected __ems: EMS | null = null;
    protected __auth: Auth | null = null;
    protected __vfs: VFS | null = null;
    protected __kernel: Kernel | null = null;
    protected __dispatcher: SyscallDispatcher | null = null;
    protected __gateway: Gateway | null = null;

    // Config
    protected config: OSConfig;
    protected aliases: Map<string, string> = new Map();
    protected booted = false;

    constructor(config?: OSConfig) { ... }

    // Config API
    alias(name: string, path: string): this { ... }
    resolvePath(path: string): string { ... }

    // Lifecycle
    abstract boot(opts?: unknown): Promise<void>;
    async shutdown(): Promise<void> { ... }  // Shuts down whatever was initialized
    isBooted(): boolean { return this.booted; }

    // Syscall API (requires kernel)
    async syscall<T>(name: string, ...args: unknown[]): Promise<T> { ... }
    syscallStream(name: string, ...args: unknown[]): AsyncIterable<Response> { ... }

    // Convenience methods
    async spawn(...): Promise<number> { ... }
    async kill(...): Promise<void> { ... }
    async mount(...): Promise<void> { ... }
    // etc.
}
```

### OS (Production)

Unchanged behavior, just extends BaseOS:

```typescript
export class OS extends BaseOS {
    async boot(opts?: BootOpts): Promise<void> {
        // Linear boot sequence (unchanged from current):
        // HAL -> EMS -> Auth -> VFS -> dirs -> ROM -> Kernel -> Dispatcher -> Gateway -> Init
    }
}
```

### TestOS

Flexible boot with HAL injection and partial layers:

```typescript
export type TestLayer = 'hal' | 'ems' | 'auth' | 'vfs' | 'kernel' | 'dispatcher' | 'gateway';

export interface TestBootOpts {
    /** Inject existing HAL instance (won't be shut down) */
    hal?: HAL;

    /** Layers to initialize. Dependencies cascade automatically.
     *  Default: all layers */
    layers?: TestLayer[];

    /** Skip ROM copy (faster tests). Default: true */
    skipRom?: boolean;

    /** Skip init process spawn. Default: true */
    skipInit?: boolean;
}

export class TestOS extends BaseOS {
    private ownsHal = true;

    async boot(opts?: TestBootOpts): Promise<void> {
        // Default to full boot if no layers specified
        const layers = opts?.layers ?? ['hal', 'ems', 'auth', 'vfs', 'kernel', 'dispatcher', 'gateway'];

        // Cascade dependencies: gateway -> dispatcher -> kernel -> vfs -> auth -> ems -> hal
        const needGateway = layers.includes('gateway');
        const needDispatcher = layers.includes('dispatcher') || needGateway;
        const needKernel = layers.includes('kernel') || needDispatcher;
        const needVfs = layers.includes('vfs') || needKernel;
        const needAuth = layers.includes('auth') || needVfs;
        const needEms = layers.includes('ems') || needAuth;
        const needHal = layers.includes('hal') || needEms || opts?.hal;

        // HAL
        if (needHal) {
            if (opts?.hal) {
                this.__hal = opts.hal;
                this.ownsHal = false;
            }
            else {
                this.__hal = new BunHAL({ storage: { type: 'memory' } });
                await this.__hal.init();
                this.ownsHal = true;
            }
        }

        // EMS
        if (needEms && this.__hal) {
            this.__ems = new EMS(this.__hal);
            await this.__ems.init();
        }

        // Auth
        if (needAuth && this.__hal && this.__ems) {
            this.__auth = new Auth(this.__hal, this.__ems, { allowAnonymous: true });
            await this.__auth.init();
        }

        // VFS
        if (needVfs && this.__hal && this.__ems) {
            this.__vfs = new VFS(this.__hal, this.__ems);
            await this.__vfs.init();
        }

        // Kernel + Dispatcher
        if (needKernel && this.__hal && this.__ems && this.__vfs) {
            this.__kernel = new Kernel(this.__hal, this.__ems, this.__vfs);

            if (needDispatcher) {
                this.__dispatcher = new SyscallDispatcher(
                    this.__kernel, this.__vfs, this.__ems, this.__hal, this.__auth
                );
                this.__kernel.onWorkerMessage = (worker, msg) =>
                    this.__dispatcher!.onWorkerMessage(worker, msg);
            }
        }

        // Gateway
        if (needGateway && this.__dispatcher && this.__kernel && this.__hal) {
            this.__gateway = new Gateway(this.__dispatcher, this.__kernel, this.__hal);
            // Use unique socket path per test to avoid conflicts
            const socketPath = `/tmp/monk-test-${crypto.randomUUID()}.sock`;
            await this.__gateway.listen(socketPath);
        }

        this.booted = true;
    }

    async shutdown(): Promise<void> {
        // Shutdown in reverse order, only what was initialized
        if (this.__gateway) await this.__gateway.shutdown();
        if (this.__kernel?.isBooted()) await this.__kernel.shutdown();
        if (this.__vfs) await this.__vfs.shutdown();
        if (this.__auth) await this.__auth.shutdown();
        if (this.__ems) await this.__ems.shutdown();
        if (this.ownsHal && this.__hal) await this.__hal.shutdown();

        // Clear references
        this.__gateway = null;
        this.__dispatcher = null;
        this.__kernel = null;
        this.__vfs = null;
        this.__auth = null;
        this.__ems = null;
        this.__hal = null;
        this.booted = false;
    }

    // Direct subsystem access for assertions
    get internalHal(): HAL {
        if (!this.__hal) throw new Error('HAL not booted');
        return this.__hal;
    }
    get internalEms(): EMS {
        if (!this.__ems) throw new Error('EMS not booted');
        return this.__ems;
    }
    get internalAuth(): Auth {
        if (!this.__auth) throw new Error('Auth not booted');
        return this.__auth;
    }
    get internalVfs(): VFS {
        if (!this.__vfs) throw new Error('VFS not booted');
        return this.__vfs;
    }
    get internalKernel(): Kernel {
        if (!this.__kernel) throw new Error('Kernel not booted');
        return this.__kernel;
    }
    get internalDispatcher(): SyscallDispatcher {
        if (!this.__dispatcher) throw new Error('Dispatcher not booted');
        return this.__dispatcher;
    }
    get internalGateway(): Gateway {
        if (!this.__gateway) throw new Error('Gateway not booted');
        return this.__gateway;
    }
}
```

### Remove OS Public Getters

Since TestOS provides `internal*` getters for tests, OS no longer needs public getters:

**Remove from OS:**
- `getHAL()` - tests use `TestOS.internalHal`
- `getVFS()` - tests use `TestOS.internalVfs`
- `getKernel()` - tests use `TestOS.internalKernel`
- `getEMS()` - tests use `TestOS.internalEms`
- `getServices()` - unused
- `getEnv()` - unused

**Keep:**
- `getEntityOps()` - used internally by `EntityAPI` class (`src/os/ems.ts:102`)

### Delete createOsStack()

With TestOS supporting partial boot, `createOsStack()` becomes redundant:

| Before | After |
|--------|-------|
| `createOsStack({ vfs: true })` | `new TestOS().boot({ layers: ['vfs'] })` |
| `createOsStack({ hal: myHal, kernel: true })` | `new TestOS().boot({ hal: myHal })` |
| `createOsStack({ kernel: true, rom: false })` | `new TestOS().boot({ skipRom: true })` |

Delete `src/os/stack.ts` (~370 lines).

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
let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();  // Full boot by default, or { layers: ['vfs'] } if kernel not needed
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

### Subsystem Unit Tests

Before:
```typescript
const stack = await createOsStack({ vfs: true });
// Use stack.vfs directly
await stack.shutdown();
```

After:
```typescript
const os = new TestOS();
await os.boot({ layers: ['vfs'] });
// Use os.internalVfs directly
await os.shutdown();
```

### HAL Injection Tests

Before:
```typescript
const stack = await createOsStack({ hal: customHal, kernel: true });
```

After:
```typescript
const os = new TestOS();
await os.boot({ hal: customHal });
```

---

## Migration Path

### Phase 1: Introduce BaseOS Hierarchy

1. Create `src/os/base.ts` with BaseOS abstract class
2. Move shared code from OS to BaseOS:
   - Protected fields
   - `shutdown()` (parameterize for partial shutdown)
   - `syscall()`, `syscallStream()`
   - Convenience methods
   - `alias()`, `resolvePath()`
3. Update OS to extend BaseOS
4. Update TestOS to extend BaseOS with flexible `boot()`
5. Move TestOS from `spec/helpers/test-os.ts` to `src/os/test.ts`

### Phase 2: Migrate Tests Using createOsStack()

1. Find all usages: `grep -r "createOsStack" spec/`
2. Replace with equivalent TestOS patterns:
   - `{ vfs: true }` -> `{ layers: ['vfs'] }`
   - `{ kernel: true }` -> `{ layers: ['kernel'] }` or `{}` (default)
   - `{ hal: x }` -> `{ hal: x }`
3. Delete `src/os/stack.ts`

### Phase 3: Migrate Syscall Tests

1. Replace mock factories with TestOS
2. Replace direct syscall function calls with `os.syscall()`
3. Delete mock factory code from each file
4. Files to migrate:
   - `spec/syscall/ems.test.ts`
   - `spec/syscall/hal.test.ts`
   - `spec/syscall/handle.test.ts`
   - `spec/syscall/pool.test.ts`
   - `spec/syscall/process.test.ts`
   - `spec/syscall/vfs.test.ts`
   - `spec/syscall/dispatcher.test.ts`
   - `spec/syscall/auth-syscall.test.ts`

### Phase 4: Remove OS Public Getters

1. Update `spec/kernel/shutdown.test.ts`:
   - Change `OS` to `TestOS`
   - Change `os.getVFS()` to `os.internalVfs`
   - Change `os.getKernel()` to `os.internalKernel`
2. Update `spec/os.test.ts`:
   - Remove tests for deleted getters
   - Add tests for BaseOS/TestOS hierarchy
3. Remove getters from OS class
4. Update READMEs to remove getter examples

### Phase 5: Documentation

1. Update `AGENTS.md` testing guidance
2. Create `spec/README.md` documenting test patterns:
   - When to use TestOS (most cases)
   - When to use OS (production behavior verification)
   - Layer options and their uses

---

## Estimated Scope

| Phase | Files | Changes |
|-------|-------|---------|
| Phase 1 | 3-4 | New base.ts, refactor os.ts, refactor test-os.ts |
| Phase 2 | ~15 | Replace createOsStack calls, delete stack.ts |
| Phase 3 | 8 | Migrate syscall test files |
| Phase 4 | 3 | Remove getters, update tests |
| Phase 5 | 2-3 | Documentation |

Total: ~30 files touched, net code reduction (~300+ lines deleted from stack.ts and mock factories).

---

## Benefits

1. **Single class hierarchy**: One way to create OS instances (OS or TestOS)
2. **Flexible testing**: Partial boot, HAL injection, skip ROM/init
3. **Less code**: Delete createOsStack() and mock factories
4. **Real integration tests**: Test actual dispatch chain, not mocks
5. **Clear separation**: Production (OS) vs Testing (TestOS)
6. **Consistent API**: Always working with an OS instance

---

## Design Decisions

### Why BaseOS instead of just adding options to OS?

Keeps production OS simple. Partial boot complexity only exists in test code. Production code path is unchanged and easy to audit.

### Why not make boot() options on OS itself?

```typescript
// Rejected approach:
new OS().boot({ layers: ['vfs'], hal: testHal })
```

This would complicate production OS with test-only features. Better to keep OS minimal and put flexibility in TestOS.

### Why cascade dependencies automatically?

Test authors shouldn't need to remember that VFS requires EMS requires HAL. Specifying `{ layers: ['vfs'] }` should Just Work.

### Why move TestOS to src/os/?

It's part of the public API for testing. Putting it in `src/os/test.ts` makes it importable as `@src/os/test.js` alongside `@src/os/os.js`. It's still only used by tests, but it's implementation code, not test code.

---

## References

- `src/os/os.ts` - Current OS class (will extend BaseOS)
- `src/os/stack.ts` - Current createOsStack() (will be deleted)
- `src/os/types.ts` - OSConfig interface
- `src/hal/index.ts` - HAL interface and BunHAL
- `spec/helpers/test-os.ts` - Current TestOS (will move to src/os/test.ts)
- `spec/syscall/*.test.ts` - Current spaghetti tests
