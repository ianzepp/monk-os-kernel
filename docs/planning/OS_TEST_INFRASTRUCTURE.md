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

Each syscall test file follows a common pattern that needs migration:

**Common deletions (all files):**
- `createMockProcess()` helper (19-43 lines each)
- `firstResponse()` helper (6-7 lines)
- `collectResponses()` helper (8-10 lines, where present)
- `as unknown as Kernel`, `as unknown as VFS`, etc. casts

**Common additions (all files):**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();  // or { layers: [...] } for partial boot
});

afterEach(async () => {
    await os.shutdown();
});
```

---

#### 3.1 `spec/syscall/vfs.test.ts` (544 lines)

**Current pattern:**
```typescript
import { fileOpen, fileClose, ... } from '@src/syscall/vfs.js';

function createMockProcess(...) { ... }  // 22 lines
function firstResponse(...) { ... }       // 7 lines
function collectResponses(...) { ... }    // 9 lines

let mockKernel: Kernel;
let mockVfs: VFS;

beforeEach(() => {
    proc = createMockProcess();
    mockKernel = {} as Kernel;
    mockVfs = { stat: mock(() => ...) } as unknown as VFS;
});

it('should yield EINVAL when path is not a string', async () => {
    const response = await firstResponse(fileOpen(proc, mockKernel, mockVfs, 123));
    expect(response.op).toBe('error');
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();
});

afterEach(async () => {
    await os.shutdown();
});

it('should yield EINVAL when path is not a string', async () => {
    await expect(os.syscall('file:open', 123)).rejects.toThrow('EINVAL');
});

it('should stat root directory', async () => {
    const result = await os.syscall('file:stat', '/');
    expect(result.model).toBe('folder');
});
```

**Decision:** Tests like "should yield EINVAL when path is not a string" are validation tests. They can either:
1. Migrate to TestOS (slower, but tests real dispatch chain)
2. Stay as unit tests with mocks (faster, but tests mocks not real code)

**Recommendation:** Migrate to TestOS. The validation logic is part of the syscall layer and should be tested through the real dispatch chain.

**Lines deleted:** ~40 (helpers + mock setup)
**Lines changed:** ~500 (all test cases)

---

#### 3.2 `spec/syscall/ems.test.ts` (385 lines)

**Current pattern:**
```typescript
import { emsSelect, emsCreate, ... } from '@src/syscall/ems.js';

function createMockProcess(...) { ... }
function firstResponse(...) { ... }
function collectResponses(...) { ... }

let mockEms: EMS;

beforeEach(() => {
    proc = createMockProcess();
    mockEms = {
        ops: {
            selectAny: mock(() => (async function* () {
                yield { id: '1', name: 'entity1' };
            })()),
        },
    } as unknown as EMS;
});

it('should stream entities as items', async () => {
    const responses = await collectResponses(emsSelect(proc, mockEms, 'user', {}));
    expect(responses[0]!.data).toEqual({ id: '1', name: 'entity1' });
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();
    // Seed test data if needed
    await os.syscall('ems:create', 'user', { name: 'entity1' });
});

afterEach(async () => {
    await os.shutdown();
});

it('should stream entities as items', async () => {
    const results = await os.syscall('ems:select', 'user', {});
    expect(results[0].name).toBe('entity1');
});
```

**Note:** Tests that verify mock interactions (`expect(mockEms.ops.selectAny).toHaveBeenCalledWith(...)`) need rethinking. Either:
1. Remove them (mock interaction tests are low value)
2. Convert to behavior tests (verify the *result* not the *call*)

**Lines deleted:** ~40 (helpers + mock setup)
**Lines changed:** ~345

---

#### 3.3 `spec/syscall/hal.test.ts` (312 lines)

**Current pattern:**
```typescript
import { netConnect, portCreate, channelOpen, ... } from '@src/syscall/hal.js';

function createMockProcess(...) { ... }
function firstResponse(...) { ... }

let mockKernel: Kernel;
let mockHal: HAL;

beforeEach(() => {
    proc = createMockProcess();
    mockKernel = {} as Kernel;
    mockHal = {} as HAL;
});

it('should yield EINVAL when proto is not a string', async () => {
    const response = await firstResponse(netConnect(proc, mockKernel, mockHal, 123, 'localhost', 80));
    expect(response.op).toBe('error');
    expect((response.data as { code: string }).code).toBe('EINVAL');
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();
});

afterEach(async () => {
    await os.shutdown();
});

it('should yield EINVAL when proto is not a string', async () => {
    await expect(os.syscall('net:connect', 123, 'localhost', 80)).rejects.toThrow('EINVAL');
});
```

**Note:** All tests in this file are pure validation tests (EINVAL checks). No mock behavior verification.

**Lines deleted:** ~30 (helpers)
**Lines changed:** ~280

---

#### 3.4 `spec/syscall/handle.test.ts` (205 lines)

**Current pattern:**
```typescript
import { handleRedirect, handleRestore, ... } from '@src/syscall/handle.js';

function createMockProcess(...) { ... }
function firstResponse(...) { ... }

let mockKernel: Kernel;

beforeEach(() => {
    proc = createMockProcess();
    mockKernel = {} as Kernel;
});

it('should yield ESRCH when process is not running', async () => {
    proc.state = 'zombie';
    const response = await firstResponse(handleSend(proc, mockKernel, 3, {}));
    expect((response.data as { code: string }).code).toBe('ESRCH');
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();
});

afterEach(async () => {
    await os.shutdown();
});

it('should yield EINVAL when target is not a number', async () => {
    await expect(os.syscall('handle:redirect', 'string', 1)).rejects.toThrow('EINVAL');
});
```

**Note:** The `proc.state = 'zombie'` test requires a zombie process, which is harder to set up with TestOS. Options:
1. Create a process, kill it, then test against it
2. Skip this test (it's testing an edge case)
3. Keep a separate unit test for this edge case

**Lines deleted:** ~30 (helpers)
**Lines changed:** ~175

---

#### 3.5 `spec/syscall/pool.test.ts` (208 lines)

**Current pattern:**
```typescript
import { poolLease, workerLoad, ... } from '@src/syscall/pool.js';

function createMockProcess(...) { ... }
function firstResponse(...) { ... }

let mockKernel: Kernel;

beforeEach(() => {
    proc = createMockProcess();
    mockKernel = {} as Kernel;
});

it('should yield EINVAL when workerId is not a string', async () => {
    const response = await firstResponse(workerLoad(proc, mockKernel, 123, '/script.js'));
    expect((response.data as { code: string }).code).toBe('EINVAL');
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();
});

afterEach(async () => {
    await os.shutdown();
});

it('should yield EINVAL when workerId is not a string', async () => {
    await expect(os.syscall('worker:load', 123, '/script.js')).rejects.toThrow('EINVAL');
});
```

**Lines deleted:** ~30 (helpers)
**Lines changed:** ~180

---

#### 3.6 `spec/syscall/process.test.ts` (433 lines)

**Current pattern:**
```typescript
import { procSpawn, procExit, procGetargs, ... } from '@src/syscall/process.js';

function createMockProcess(...) { ... }
function firstResponse(...) { ... }

let mockKernel: Kernel;

beforeEach(() => {
    proc = createMockProcess({ args: ['arg1', 'arg2'] });
    mockKernel = {} as Kernel;
});

it('should return process arguments', async () => {
    const response = await firstResponse(procGetargs(proc));
    expect(response.data).toEqual(['arg1', 'arg2']);
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();
});

afterEach(async () => {
    await os.shutdown();
});

it('should return process arguments', async () => {
    // Init process has default args
    const result = await os.syscall('proc:getargs');
    expect(Array.isArray(result)).toBe(true);
});
```

**Note:** Some tests like `procGetargs` need spawned processes with specific args. With TestOS:
```typescript
it('should return spawned process arguments', async () => {
    // Write a script that checks its args
    const script = `
        import { getargs, exit } from '@rom/lib/process/index.js';
        const args = await getargs();
        // Somehow verify args... (this is where integration testing gets complex)
    `;
    // This test may be better left as a unit test
});
```

**Decision:** Tests for `procGetargs`, `procGetcwd`, `procGetenv` etc. that operate on process state are actually simpler as unit tests. Consider keeping mock-based unit tests for these.

**Lines deleted:** ~30 (helpers)
**Lines changed:** ~400

---

#### 3.7 `spec/syscall/dispatcher.test.ts` (376 lines)

**Current pattern:**
```typescript
import { SyscallDispatcher } from '@src/syscall/dispatcher.js';

function createMockProcess(...) { ... }
function createMockDeps() {
    const mockKernel = { processes: { ... } } as unknown as Kernel;
    const mockVfs = { stat: mock(...) } as unknown as VFS;
    const mockEms = { ops: { ... } } as unknown as EMS;
    const mockHal = {} as HAL;
    return { mockKernel, mockVfs, mockEms, mockHal };
}

beforeEach(() => {
    const mocks = createMockDeps();
    dispatcher = new SyscallDispatcher(mocks.mockKernel, mocks.mockVfs, mocks.mockEms, mocks.mockHal, undefined);
    proc = createMockProcess();
});

it('should yield ENOSYS for unknown syscalls', async () => {
    const response = await firstResponse(dispatcher, proc, 'unknown:syscall', []);
    expect((response.data as { code: string }).code).toBe('ENOSYS');
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();
});

afterEach(async () => {
    await os.shutdown();
});

it('should yield ENOSYS for unknown syscalls', async () => {
    await expect(os.syscall('unknown:syscall')).rejects.toThrow('ENOSYS');
});

it('should route proc:getcwd correctly', async () => {
    const result = await os.syscall('proc:getcwd');
    expect(result).toBe('/');  // Init process cwd
});
```

**Note:** The "syscall coverage" tests that verify all syscalls are routed (not ENOSYS) are still valuable. These can be migrated to TestOS.

**Lines deleted:** ~60 (helpers + mock deps)
**Lines changed:** ~316

---

#### 3.8 `spec/syscall/auth-syscall.test.ts` (567 lines)

**Current pattern:**
```typescript
import { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import { Auth } from '@src/auth/index.js';

function createMockProcess(...) { ... }
function createMockDeps() { ... }

beforeEach(async () => {
    const mocks = createMockDeps();
    auth = new Auth(mocks.mockHal, undefined, { allowAnonymous: true });
    await auth.init();
    dispatcher = new SyscallDispatcher(..., auth);
    proc = createMockProcess();
});

afterEach(async () => {
    await auth.shutdown();
});
```

**Migration:**
```typescript
import { TestOS } from '@src/os/test.js';

let os: TestOS;

beforeEach(async () => {
    os = new TestOS();
    await os.boot();  // Auth is included by default
});

afterEach(async () => {
    await os.shutdown();
});

it('should validate JWT and return fresh token', async () => {
    // Mint token via internal Auth
    const original = await os.internalAuth.mintToken('alice');

    // Call auth:token syscall
    const result = await os.syscall('auth:token', original.token);
    expect(result.user).toBe('alice');
});
```

**Note:** This file already uses a real Auth instance. Migration is mostly about switching to TestOS for cleaner lifecycle management.

**Lines deleted:** ~50 (helpers + mock deps)
**Lines changed:** ~517

---

#### Summary: Phase 3 Line Changes

| File | Current | Delete | Change | Net Reduction |
|------|---------|--------|--------|---------------|
| vfs.test.ts | 544 | 40 | 500 | ~40 |
| ems.test.ts | 385 | 40 | 345 | ~40 |
| hal.test.ts | 312 | 30 | 280 | ~30 |
| handle.test.ts | 205 | 30 | 175 | ~30 |
| pool.test.ts | 208 | 30 | 180 | ~30 |
| process.test.ts | 433 | 30 | 400 | ~30 |
| dispatcher.test.ts | 376 | 60 | 316 | ~60 |
| auth-syscall.test.ts | 567 | 50 | 517 | ~50 |
| **Total** | **3030** | **310** | **2713** | **~310** |

The ~310 lines deleted are the duplicated `createMockProcess()` and helper functions.

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
