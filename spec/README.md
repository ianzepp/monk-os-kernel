# Test Patterns

This document describes the testing patterns used in the Monk OS codebase.

## Class Hierarchy

```
BaseOS (abstract)
├── OS        - Production init/boot (full linear sequence)
└── TestOS    - Testing init/boot (flexible partial layers)
```

- **OS**: Use for production behavior verification (full init/boot)
- **TestOS**: Use for most tests (partial init, internal accessors)

## TestOS: The Preferred Testing Tool

TestOS provides flexible partial initialization and direct subsystem access:

```typescript
import { TestOS } from '@src/os/test.js';

describe('MyFeature', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        await os.init({ layers: ['dispatcher'] });  // Init up to dispatcher layer
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should do something', async () => {
        // Use syscalls for behavior tests
        const result = await os.syscall('file:stat', '/');
        expect(result.model).toBe('folder');

        // Or access internals for assertions
        const vfs = os.internalVfs;
        const stat = await vfs.stat('/', 'kernel');
        expect(stat).toBeDefined();
    });
});
```

## Init Layers

TestOS supports partial initialization via the `layers` option. Each layer cascades its dependencies:

| Layer | Dependencies | What it provides |
|-------|--------------|------------------|
| `hal` | none | Hardware abstraction (entropy, storage) |
| `ems` | hal | Entity management system |
| `auth` | hal, ems | Authentication |
| `vfs` | hal, ems, auth | Virtual filesystem |
| `kernel` | hal, ems, auth, vfs | Process management (with PID 1 placeholder) |
| `dispatcher` | all above | Syscall routing |
| `gateway` | all above | External socket interface |

```typescript
// Init only what you need
await os.init({ layers: ['vfs'] });        // Just HAL, EMS, Auth, VFS
await os.init({ layers: ['ems'] });        // Just HAL, EMS
await os.init({ layers: ['dispatcher'] }); // Full stack minus gateway

// For backwards compatibility, boot() also accepts layers:
await os.boot({ layers: ['dispatcher'] }); // Auto-calls init() first
```

## Internal Accessors

TestOS provides direct access to subsystems for assertions:

```typescript
os.internalHal        // HAL instance
os.internalEms        // EMS instance
os.internalAuth       // Auth instance
os.internalVfs        // VFS instance
os.internalKernel     // Kernel instance
os.internalDispatcher // SyscallDispatcher instance
os.internalGateway    // Gateway instance
```

These throw if the corresponding layer wasn't booted.

## Syscall Testing

For syscall validation tests, use TestOS with the dispatcher layer:

```typescript
describe('VFS Syscalls', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        await os.init({ layers: ['dispatcher'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should yield EINVAL when path is not a string', async () => {
        await expect(os.syscall('file:open', 123)).rejects.toThrow('path must be a string');
    });

    it('should stat root directory', async () => {
        const result = await os.syscall<{ model: string }>('file:stat', '/');
        expect(result.model).toBe('folder');
    });
});
```

## Virtual Test Process

TestOS creates a virtual test process for syscall dispatch. You can configure it:

```typescript
// Set test user identity
os.setTestUser('alice');

// Set test working directory
os.setTestCwd('/home/alice');

// Access the test process directly
const proc = os.getTestProcess();
```

## HAL Injection

For HAL-specific testing, inject a custom HAL:

```typescript
const customHal = new BunHAL({ storage: { type: 'memory' } });
await customHal.init();

const os = new TestOS();
await os.init({ hal: customHal, layers: ['vfs'] });

// customHal won't be shut down by os.shutdown()
// (ownsHal = false when injected)
```

## VFS Schema Loading

For tests that need VFS models without full boot:

```typescript
import { loadVfsSchema, loadVfsSchemaWithFileDevice } from '@src/os/test.js';

// Load just folder/file/symlink/device models
await loadVfsSchema(ems);

// Also create /dev/null and /dev/zero
await loadVfsSchemaWithFileDevice(ems);
```

## When to Use Production OS

Use `OS` (not `TestOS`) when:

1. Testing full production init/boot sequence
2. Testing service activation
3. Testing ROM copy
4. Testing gateway socket communication
5. Testing process spawn with real scripts

```typescript
import { OS } from '@src/index.js';

it('should init and boot', async () => {
    const os = new OS({ storage: { type: 'memory' } });
    await os.init();
    // Can configure VFS here before boot
    await os.boot();

    // Or just: await os.boot();  // auto-calls init()

    await os.shutdown();
});
```

## Test Directory Structure

```
spec/
├── ems/           # Entity management tests
├── gateway/       # Gateway/socket tests
├── hal/           # HAL device tests
├── kernel/        # Kernel/process tests
├── rom/           # ROM script tests
├── syscall/       # Syscall validation tests
├── vfs/           # VFS operation tests
├── helpers/       # Test utilities
└── os.test.ts     # OS class tests
```

## Best Practices

1. **Use TestOS by default** - Only use OS when testing production init/boot behavior
2. **Init minimal layers** - Faster tests, clearer dependencies
3. **Use syscalls for behavior tests** - Tests the real dispatch chain
4. **Use internal* for assertions** - Direct access for verification
5. **Clean up in afterEach** - Always call `os.shutdown()`
6. **Avoid mocks** - Real integration tests are more valuable
7. **Most tests don't need boot()** - `init()` is sufficient for syscall testing
