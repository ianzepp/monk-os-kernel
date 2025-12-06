# OS Boot Modes

Monk OS supports two distinct boot modes depending on your use case.

## Standalone Mode (`exec`)

Use this when Monk OS *is* your application. The OS takes over, runs until shutdown signal.

```typescript
import { OS } from '@monk-api/os';

const os = new OS({
    storage: { type: 'sqlite', path: '.data/monk.db' },
    display: { enabled: true, port: 8080 },
    debug: true,
});

// Blocks until SIGINT/SIGTERM
const exitCode = await os.exec();
process.exit(exitCode);
```

This is what `bun start` uses. The display server starts, browsers can connect, and the process runs until you press Ctrl+C.

### CLI Options

```bash
bun start                    # In-memory, display on :8080
bun start --sqlite           # SQLite persistence
bun start --port 3000        # Custom display port
bun start --no-display       # Headless (no display server)
bun start --debug            # Kernel debug logging
```

## Library Mode (`boot`)

Use this when Monk OS is a component within your larger application. Boot returns immediately, you keep control.

```typescript
import { OS } from '@monk-api/os';

const os = new OS({
    storage: { type: 'memory' },
});

// Returns immediately after boot completes
await os.boot();

// Now use the OS APIs
await os.fs.mount('./src', '/app');
await os.process.spawn('/app/main.ts');

// Your application continues running...
// When done:
await os.shutdown();
```

### Lifecycle Hooks

Library mode supports lifecycle hooks for setup at specific boot stages:

```typescript
const os = new OS()
    .on('vfs', async (os) => {
        // VFS is ready, mount directories
        await os.fs.mount('./src', '/app');
    })
    .on('boot', (os) => {
        console.log('OS fully booted');
    });

await os.boot();
```

Available events: `hal`, `ems`, `vfs`, `kernel`, `boot`, `shutdown`

## Configuration

```typescript
interface OSConfig {
    // Storage backend
    storage?: {
        type: 'memory' | 'sqlite' | 'postgres';
        path?: string;  // For sqlite
        url?: string;   // For postgres
    };

    // Display server (standalone mode)
    display?: {
        enabled?: boolean;  // Default: false
        port?: number;      // Default: 8080
        host?: string;      // Default: '0.0.0.0'
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

Both modes follow the same boot sequence:

1. **HAL** - Hardware abstraction layer
2. **EMS** - Entity management system (database)
3. **Display** - HTTP/WebSocket server (if enabled)
4. **VFS** - Virtual filesystem
5. **Standard directories** - /bin, /etc, /home, /tmp, /var, /vol
6. **Packages** - Install queued packages
7. **Kernel** - Process management
8. **Init** - Spawn init process (if `main` provided)

## When to Use Which

| Scenario | Mode |
|----------|------|
| Building a desktop-like OS with browser UI | Standalone (`exec`) |
| Running Monk as a service/daemon | Standalone (`exec`) |
| Embedding Monk in an Electron app | Library (`boot`) |
| Using Monk for testing/CI | Library (`boot`) |
| Building a web app that uses Monk internally | Library (`boot`) |
