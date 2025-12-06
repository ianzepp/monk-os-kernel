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

### Service Management

Services are defined in `/etc/services/*.json` and loaded at boot (but not auto-started).

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

## Lifecycle Events

Register callbacks for boot stages:

```typescript
const os = new OS()
    .on('hal', async (os) => {
        // HAL initialized
    })
    .on('ems', async (os) => {
        // Entity management ready
    })
    .on('vfs', async (os) => {
        // Filesystem ready
    })
    .on('kernel', async (os) => {
        // Kernel ready, before init starts
    })
    .on('boot', (os) => {
        // Fully booted
    })
    .on('shutdown', (os) => {
        // Shutting down
    });

await os.boot();
```

## Package Installation

Install packages at boot or runtime:

```typescript
// Via config
const os = new OS({
    packages: ['@monk/httpd', '@monk/shell'],
});

// Via fluent API (queued for boot)
os.install('@monk/httpd');

// Runtime installation
await os.pkg.install('@monk/httpd');
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

    // Packages to install at boot
    packages?: Array<string | { name: string; opts?: PackageOpts }>;

    // Path aliases
    aliases?: Record<string, string>;

    // Kernel debug logging
    debug?: boolean;
}
```

## Boot Sequence

1. **HAL** - Hardware abstraction layer (entropy, storage, network)
2. **EMS** - Entity management system (database)
3. **VFS** - Virtual filesystem
4. **Standard directories** - /app, /bin, /etc, /home, /tmp, /usr, /var, /vol
5. **Packages** - Install queued packages
6. **Kernel** - Process management, syscall dispatch
7. **Init** - Spawn init process (PID 1)
8. **Services** - Load service definitions (not auto-started)

## Accessing Subsystems

For advanced use cases, access internal subsystems directly:

```typescript
const hal = os.getHAL();       // Hardware abstraction
const vfs = os.getVFS();       // Virtual filesystem
const kernel = os.getKernel(); // Process/syscall management
const ems = os.getEMS();       // Entity management
```

## Example: Complete Application

```typescript
import { OS } from '@monk-api/os';

const os = new OS({
    storage: { type: 'sqlite', path: '.data/app.db' },
    aliases: { '@app': '/vol/app' },
})
    .on('vfs', async (os) => {
        // Mount host directory into VFS
        os.getVFS().mount('./src', '/vol/app', 'kernel');
    });

await os.boot();

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
