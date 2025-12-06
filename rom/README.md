# ROM - Read-Only Memory (Userspace Code)

This directory contains **userspace code** that runs inside Bun Workers. It is completely isolated from kernel code in `src/`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Host Process (main thread)                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Kernel (src/)                                            │  │
│  │  - HAL, VFS, EMS, Kernel                                  │  │
│  │  - Runs in main thread                                    │  │
│  │  - Has direct access to Bun APIs, filesystem, network     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ▲                                   │
│                              │ postMessage (syscalls)            │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Userspace (rom/)                     [Bun Worker]        │  │
│  │  - Process library (lib/process/)                         │  │
│  │  - Services (svc/)                                        │  │
│  │  - Runs in isolated Worker                                │  │
│  │  - Communicates with kernel via syscalls only             │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Boot Sequence

1. Kernel reads files from `rom/` on the host filesystem
2. Files are copied into VFS as entities with UUIDs and ACLs
3. When a process is spawned, the VFS loader:
   - Reads TypeScript source from VFS
   - Transpiles to JavaScript (via Bun.Transpiler)
   - Rewrites imports to `__require()` calls
   - Bundles all dependencies into a single script
   - Creates a Blob URL and spawns a Worker

## Import Resolution

The VFS loader recognizes these import patterns:

| Pattern | Resolution | Example |
|---------|------------|---------|
| `@rom/...` | VFS root `/` | `@rom/lib/process/index.js` → `/lib/process/index.ts` |
| `/...` | Absolute VFS path | `/lib/process/index.ts` |
| `./...` | Relative to current file | `./errors.js` → same directory |
| `../...` | Relative parent | `../errors.js` → parent directory |

### What Does NOT Work

```typescript
// WRONG: @src/ is a tsconfig alias, not understood by VFS loader
import { something } from '@src/kernel/types.js';

// WRONG: Node/Bun built-ins are not available in Workers
import { something } from 'bun:test';
import { something } from 'node:fs';

// WRONG: npm packages are not bundled
import { something } from 'lodash';
```

The VFS loader will pass these through as external imports, and the Worker will fail at runtime with "Module not found".

## Directory Structure

```
rom/
├── lib/                    # Libraries for userspace code
│   ├── process/            # Syscall wrappers (the "libc")
│   │   ├── index.ts        # Main entry point
│   │   ├── syscall.ts      # postMessage transport
│   │   ├── errors.ts       # Error reconstruction
│   │   ├── channel.ts      # Protocol channels (HTTP, SQL)
│   │   └── types.ts        # Wire protocol types
│   └── errors.ts           # HAL error classes (copied from src/hal/)
├── svc/                    # Kernel services (run as Workers)
│   ├── init.ts             # PID 1, reaps zombies
│   ├── logd.ts             # System log daemon
│   └── gatewayd.ts         # Unix socket gateway for external apps
└── etc/                    # Configuration files
    └── services/           # Service definitions
```

## The Process Library (`lib/process/`)

This is userspace's "libc" - the interface to the kernel. It provides:

- **File operations**: `open`, `read`, `write`, `close`, `stat`, `mkdir`, etc.
- **Process operations**: `spawn`, `exit`, `kill`, `wait`, `getpid`
- **Network operations**: `connect`, `listen`, `recv`, `send`
- **Environment**: `getcwd`, `chdir`, `getenv`, `setenv`
- **Channels**: `httpRequest`, `sqlQuery`

All operations are async and communicate with the kernel via `postMessage`.

### Usage

```typescript
import { open, read, close, println } from '@rom/lib/process/index.js';

export default async function main() {
    const fd = await open('/etc/config.json', { read: true });
    const data = await read(fd);
    await close(fd);
    await println(new TextDecoder().decode(data));
}
```

## Type Imports from `@src/`

TypeScript `import type` statements ARE allowed from `@src/` because they are **elided at compile time** - they don't become runtime `__require()` calls.

```typescript
// OK: Type-only import, elided at runtime
import type { SyscallRequest } from '@src/kernel/types.js';

// WRONG: Value import, becomes __require() at runtime
import { fromCode } from '@src/hal/errors.js';
```

However, for clarity and to avoid confusion, the process library duplicates necessary types locally in `lib/process/types.ts`.

## Why Userspace Must Be Self-Contained

1. **Worker isolation**: Workers cannot access the main thread's modules
2. **VFS bundling**: The loader only bundles what it can read from VFS
3. **No shared memory**: Workers communicate via structured clone (postMessage)
4. **Security**: Userspace should not have direct kernel access

The kernel and userspace are completely separate - they share no code at runtime. The only communication channel is the syscall interface via `postMessage`.

## Writing Userspace Code

1. Put your code in `rom/svc/` (for services) or create a new directory
2. Import only from `@rom/...` or relative paths
3. Use the process library for all kernel interactions
4. Export a `default` function as your entry point

```typescript
// rom/svc/myservice.ts
import { println, sleep } from '@rom/lib/process/index.js';

export default async function main() {
    await println('Service starting...');

    while (true) {
        // Do work
        await sleep(1000);
    }
}
```
