# OS Module

The OS class is the main entry point for Monk OS. It provides a unified interface for booting, configuring, and interacting with the operating system.

## Boot Modes

### Standalone Mode (`exec`)

Use when Monk OS *is* your application. Blocks until shutdown signal.

```typescript
import { OS } from '@monk-api/os';

const os = new OS({
    storage: { type: 'sqlite', path: '.data/monk.db' },
    debug: true,
});

// Blocks until SIGINT/SIGTERM
const exitCode = await os.exec();
process.exit(exitCode);
```

### Library Mode (`boot`)

Use when Monk OS is a component within your application. Returns immediately.

```typescript
import { OS } from '@monk-api/os';

const os = new OS({ storage: { type: 'memory' } });

await os.boot();

// Use the OS APIs...
const content = await os.text('/etc/config.json');

// When done:
await os.shutdown();
```

## Syscall API

The OS provides direct syscall access to the kernel. All syscalls execute in the context of the init process (PID 1).

### Core Methods

```typescript
// Direct syscall - returns unwrapped result
const result = await os.syscall<T>(name, ...args);

// Raw response stream for advanced use cases
const stream = os.syscallStream(name, ...args);
for await (const response of stream) {
    // Handle response.op: 'ok', 'item', 'data', 'error', 'done'
}
```

### Domain Wrappers

```typescript
// Entity Management System (ems:*)
await os.ems('select', 'User', { where: { active: true } });
await os.ems('create', 'User', { name: 'Alice' });
await os.ems('update', 'User', id, { name: 'Bob' });
await os.ems('delete', 'User', id);

// Virtual File System (file:*)
const fd = await os.vfs('open', '/path/to/file', { read: true });
await os.vfs('write', fd, data);
await os.vfs('close', fd);
const stat = await os.vfs('stat', '/path/to/file');

// Process Management (proc:*)
const pid = await os.process('spawn', '/bin/script.ts', { args: ['--flag'] });
await os.process('kill', pid, 15);
await os.process('wait', pid);
```

### Aliases

```typescript
os.file(...)   // Alias for os.vfs()
os.entity(...) // Alias for os.ems()
```

## Convenience Helpers

### File Operations

```typescript
// Read file as bytes
const bytes: Uint8Array = await os.read('/path/to/file');

// Read file as text
const text: string = await os.text('/path/to/file');
const utf16: string = await os.text('/path/to/file', 'utf-16');
```

### Process Operations

```typescript
// Spawn a process (returns PID)
const pid = await os.spawn('/bin/script.ts', {
    args: ['--port', '8080'],
    env: { DEBUG: '1' },
    cwd: '/app',
});

// Kill a process
await os.kill(pid);           // SIGTERM (15)
await os.kill(pid, 9);        // SIGKILL
```

### Filesystem Mounting

```typescript
// Mount host directory into VFS
await os.mount('host', './src', '/app');
await os.mount('host', '/data', '/mnt/data', { readonly: true });

// Unmount
await os.unmount('/app');
```

### Host-to-VFS Copy

```typescript
// Copy a single file from host to VFS
await os.copy('./config.json', '/etc/app/config.json');

// Copy a directory tree (recursive, auto-creates directories)
await os.copy('./src', '/app/src');
```

### Service Management

Services are defined in `/etc/services/*.json` and loaded at boot.

```typescript
// List registered services
const services = await os.service('list');

// Get service definition
const def = await os.service('status', 'httpd');

// Start a service
await os.service('start', 'httpd');

// Stop a service
await os.service('stop', 'httpd');

// Restart a service
await os.service('restart', 'httpd');
```

## Path Aliases

Configure path aliases for convenience:

```typescript
const os = new OS({
    aliases: {
        '@app': '/vol/app',
        '@config': '/etc/app',
    },
});

// Or use the fluent API
os.alias('@app', '/vol/app');

// Aliases are resolved automatically
await os.text('@app/config.json');
await os.spawn('@app/server.ts');
```

## Configuration Reference

```typescript
interface OSConfig {
    // Storage backend
    storage?: {
        type: 'memory' | 'sqlite' | 'postgres';
        path?: string;  // For sqlite
        url?: string;   // For postgres
    };

    // Environment variables for all processes
    env?: Record<string, string>;

    // Path aliases
    aliases?: Record<string, string>;

    // Kernel debug logging
    debug?: boolean;

    // Path to ROM directory on host filesystem (default: './rom')
    romPath?: string;
}
```

## Boot Sequence

1. **HAL** - Hardware abstraction layer (entropy, storage, network)
2. **EMS** - Entity management system (database)
3. **VFS** - Virtual filesystem
4. **Standard directories** - /app, /bin, /etc, /home, /svc, /tmp, /usr, /var, /vol
5. **ROM copy** - Copy bundled userspace from host to VFS
6. **Kernel + Dispatcher** - Process management, syscall routing
7. **Init** - Spawn init process (PID 1)

## Accessing Subsystems

For **production code**, use syscalls rather than direct subsystem access:

```typescript
// File operations via syscall
const stat = await os.syscall('file:stat', '/etc/config.json');
const fd = await os.syscall('file:open', '/tmp/data.txt', { write: true, create: true });

// Entity operations via syscall
const users = await os.ems('select', 'User', { where: { active: true } });
```

For **testing**, use `TestOS` which provides direct internal access:

```typescript
import { TestOS } from '@src/os/test.js';

const os = new TestOS();
await os.boot({ layers: ['vfs'] });  // Partial boot for faster tests

// Direct subsystem access for assertions
const vfs = os.internalVfs;
const ems = os.internalEms;
const kernel = os.internalKernel;
```

See `spec/README.md` for complete testing patterns.

## Example: Complete Application

```typescript
import { OS } from '@monk-api/os';

const os = new OS({
    storage: { type: 'sqlite', path: '.data/app.db' },
    aliases: { '@app': '/vol/app' },
});

await os.boot();

// Mount host directory into VFS
await os.mount('host', './src', '/vol/app');

// Start services
await os.service('start', 'httpd');
await os.service('start', 'worker');

// Application logic...
const users = await os.ems('select', 'User', { where: { active: true } });
const config = JSON.parse(await os.text('@app/config.json'));

// Spawn background process
const pid = await os.spawn('@app/background-job.ts');

// Cleanup
await os.shutdown();
```
