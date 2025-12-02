# OS Boot and Execution Model

How external applications consume and run Monk OS.

## Terminology

- **OS** - Monk OS, the operating system package (`@monk-api/os`)
- **App** - The external application consuming the OS

---

## Installation

```bash
npm install @monk-api/os
# or
bun add @monk-api/os
```

---

## Three Execution Modes

### 1. `boot()` - Headless Mode

Boot the OS and return control to the App. The App orchestrates from outside.

```typescript
import { OS } from '@monk-api/os';

const os = new OS({ aliases: { '@app': '/vol/app' } });
await os.boot();

// App continues, OS runs in background
await os.fs.mount('./src/api', '@app');
await os.services.start({ handler: '@app/server.ts', activate: { type: 'boot' } });
await os.shell('ls @app');

// Later...
await os.shutdown();
```

**Use cases:**
- Testing
- Scripting
- Dynamic orchestration
- App needs to interact with OS programmatically

### 2. `boot({ main })` - Hybrid Mode

Boot the OS with an init script running inside, but return control to the App.

```typescript
const os = new OS({ aliases: { '@app': '/vol/app' } });
os.mount('./src', '@app');
await os.boot({ main: '@app/init.ts' });

// Both coexist:
// - init.ts running inside as PID 1
// - App running outside with os.* API access

await os.shell('ps');  // See init and its children
// App can monitor, inject commands, etc.
```

**Use cases:**
- Development with hot reload
- Monitoring/debugging
- App needs both inside processes and outside control

### 3. `exec({ main })` - Takeover Mode

The OS takes over the App's process. The App "goes away."

```typescript
const os = new OS({ aliases: { '@app': '/vol/app' } });
os.mount('./src', '@app');
await os.exec({ main: '@app/init.ts' });

// This line NEVER executes (unless OS exits)
```

**Use cases:**
- Production deployment
- Single-binary distribution
- Traditional daemon model
- `bun build --compile` scenarios

---

## Behavior Comparison

| Method | Returns | App Thread | OS Processes |
|--------|---------|------------|--------------|
| `boot()` | Immediately | Continues | None (headless) |
| `boot({ main })` | When main starts | Continues | main.ts as PID 1 |
| `exec({ main })` | Never* | Becomes OS | main.ts as PID 1 |

*`exec()` only returns if init exits or OS shuts down.

---

## Pre-Boot Configuration

All modes support pre-boot configuration:

```typescript
const os = new OS({
  aliases: { '@app': '/vol/app', '@static': '/vol/static' }
});

// Configure before boot
os.config.storage = { type: 'postgres', url: process.env.DATABASE_URL };
os.mount('./src/api', '@app');
os.mount('./static', '@static', { readonly: true });
os.service({ handler: '@app/server.ts', activate: { type: 'boot' } });

// Then choose mode:
await os.boot();                       // Headless
await os.boot({ main: '@app/init.ts' }); // Hybrid
await os.exec({ main: '@app/init.ts' }); // Takeover
```

### Fluent API Alternative

```typescript
const os = await new OS()
  .alias('@app', '/vol/app')
  .storage({ type: 'postgres', url: '...' })
  .mount('./src/api', '@app')
  .service({ handler: '@app/server.ts', activate: { type: 'boot' } })
  .boot();
```

---

## Execution Model Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  App Main Thread (Bun)                                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  App Code                                             │  │
│  │  const os = new OS({ aliases: { '@app': '/vol/app' } });│  │
│  │  os.mount('./src', '@app');                           │  │
│  │  await os.boot({ main: '@app/init.ts' });             │  │
│  │  await os.shell('ps');  // Can still interact         │  │
│  └───────────────────────────────────────────────────────┘  │
│                            │                                 │
│                            ▼                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  OS Kernel (in-process with App)                      │  │
│  │  - VFS, Process Table, Services                       │  │
│  │  - Syscall dispatch                                   │  │
│  │  - HAL (storage, network, etc.)                       │  │
│  └───────────────────────────────────────────────────────┘  │
│         │                         │                         │
│         ▼                         ▼                         │
│  ┌─────────────┐          ┌─────────────┐                  │
│  │  Worker     │          │  Worker     │                  │
│  │  (init.ts)  │          │  (server)   │                  │
│  │  PID 1      │          │  PID 2      │                  │
│  └─────────────┘          └─────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

---

## The `exec()` Takeover

When `exec()` is called:

1. Boots the OS (HAL, VFS, mounts, services)
2. Spawns `main` as PID 1 (in a Worker)
3. **Blocks** the App's main thread indefinitely
4. Forwards OS signals (SIGTERM, SIGINT) to init
5. When init exits, `exec()` returns with init's exit code
6. App process terminates

```typescript
const os = new OS({ aliases: { '@app': '/vol/app' } });
os.mount('./src', '@app');

// This is the last line of "App code"
const exitCode = await os.exec({ main: '@app/init.ts' });
process.exit(exitCode);
```

### Signal Handling

```typescript
// Bun receives SIGTERM
//   → OS forwards to init (PID 1)
//   → init handles graceful shutdown
//   → init exits
//   → exec() returns
//   → App process exits
```

---

## Boot Sequence

### `boot()` - Headless

```
os.boot()
    │
    ├─ 1. Initialize HAL
    ├─ 2. Initialize VFS (root, /dev, /etc)
    ├─ 3. Apply pre-boot mounts
    ├─ 4. Load services from /etc/services/
    ├─ 5. Start boot-activated services
    └─ 6. Return to App
```

### `boot({ main })` - Hybrid

```
os.boot({ main: '@app/init.ts' })
    │
    ├─ 1. Initialize HAL
    ├─ 2. Initialize VFS (root, /dev, /etc)
    ├─ 3. Apply pre-boot mounts (resolve aliases)
    ├─ 4. Load services from /etc/services/
    ├─ 5. Start boot-activated services
    ├─ 6. Spawn init process (Worker) as PID 1
    └─ 7. Return to App (init continues in background)
```

### `exec({ main })` - Takeover

```
os.exec({ main: '@app/init.ts' })
    │
    ├─ 1. Initialize HAL
    ├─ 2. Initialize VFS (root, /dev, /etc)
    ├─ 3. Apply pre-boot mounts (resolve aliases)
    ├─ 4. Load services from /etc/services/
    ├─ 5. Start boot-activated services
    ├─ 6. Spawn init process (Worker) as PID 1
    ├─ 7. Block App thread
    ├─ 8. Wait for init to exit
    └─ 9. Return init's exit code (or never return)
```

---

## App ↔ OS Communication

### App Outside, OS Inside

The App's `os.*` API talks directly to the kernel (which runs in the App's main thread):

```typescript
// App code (outside)
await os.fs.read('@app/data.json');        // Direct kernel call (alias resolved)
await os.shell('ls @app');                 // Spawns shell Worker, waits
await os.services.start({ ... });          // Kernel starts service
```

### OS Process ↔ App

If an OS process (running in a Worker) needs to communicate with App code:

**Option A: Unix socket**
```typescript
// App side (outside, using Bun)
const server = Bun.listen({
  unix: '/tmp/app.sock',
  socket: { ... }
});

// OS process side (inside Worker)
const conn = await connect('unix', '/tmp/app.sock');
```

**Option B: TCP socket**
```typescript
// OS process listens
const listener = await port('tcp:listen', { port: 9000 });

// App connects (outside, using Bun)
const conn = await Bun.connect({ hostname: 'localhost', port: 9000 });
```

**Option C: Shared file**
```typescript
// OS process writes
await write('/tmp/result.json', data);

// App reads via os.* API
const result = await os.fs.read('/tmp/result.json');
```

---

## The OS API Object

```typescript
interface OS {
  // Configuration (pre-boot)
  config: BootConfig;
  alias(name: string, path: string): this;
  mount(hostPath: string, osPath: string, opts?: MountOpts): this;
  service(def: ServiceDef): this;
  storage(config: StorageConfig): this;

  // Lifecycle
  boot(opts?: BootOpts): Promise<void>;
  exec(opts: ExecOpts): Promise<number>;  // Returns exit code
  shutdown(): Promise<void>;

  // Filesystem
  fs: {
    mount(hostPath: string, osPath: string, opts?: MountOpts): Promise<void>;
    unmount(osPath: string): Promise<void>;
    read(path: string): Promise<Uint8Array>;
    write(path: string, data: Uint8Array): Promise<void>;
    stat(path: string): Promise<Stat>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };

  // Shell
  shell(command: string): Promise<ShellResult>;
  exec(cmd: string, args?: string[]): Promise<ExecResult>;

  // Services
  services: {
    start(config: string | ServiceDef): Promise<void>;
    stop(name: string): Promise<void>;
    list(): Promise<ServiceInfo[]>;
  };

  // Network
  port(type: string, opts: PortOpts): Promise<Port>;
  connect(proto: string, host: string, port: number): Promise<Socket>;

  // Channels
  channel(url: string): Promise<Channel>;

  // Process spawning
  spawn(cmd: string, opts?: SpawnOpts): Promise<Process>;
}
```

---

## Boot Configuration

Minimal boot config - just enough to load ROM:

```typescript
interface BootConfig {
  storage?: StorageConfig;
  env?: Record<string, string>;
}

interface BootOpts {
  main?: string;  // Path to init script (inside OS)
}

interface ExecOpts {
  main: string;   // Required for exec()
}

interface StorageConfig {
  type: 'memory' | 'sqlite' | 'postgres';
  url?: string;
  path?: string;
}
```

Additional configuration (mounts, services) added via API before or after boot.

---

## Filesystem Layout

```
/                        # OS root
├── bin/                 # Core utilities (ROM) [protected]
├── lib/                 # Core libraries (ROM) [protected]
├── etc/                 # OS config [protected]
├── dev/                 # Devices [protected]
├── proc/                # Process info [protected]
├── tmp/                 # Shared temp (memory-backed) [protected]
├── pkg/                 # Packages [protected]
│   ├── <name>/<version>/
│   └── .active
│
└── ... anything else    # App can mount here
    ├── /vol/app/
    ├── /app/
    ├── /data/
    └── etc.
```

### Mount Behavior

Mounts are explicit - the path you specify is the path you get:

```typescript
// Explicit paths - what you write is what you get
os.mount('./src', '/vol/app');           // → /vol/app
os.mount('./config', '/vol/config');     // → /vol/config
os.mount('./data', '/data');             // → /data

// Protected paths - OS refuses
os.mount('./src', '/bin');   // ERROR: /bin is protected
os.mount('./src', '/etc');   // ERROR: /etc is protected
os.mount('./src', '/lib');   // ERROR: /lib is protected

// With aliases - still explicit, just convenient
os.alias('@app', '/vol/app');
os.mount('./src', '@app');               // → /vol/app
```

### Protected Paths

| Path | Owner | App Can Mount? |
|------|-------|----------------|
| `/bin` | ROM | No |
| `/lib` | ROM | No |
| `/etc` | OS | No |
| `/dev` | Kernel | No |
| `/proc` | Kernel | No |
| `/tmp` | Kernel | No |
| `/pkg` | Package manager | No (use `os.pkg.*`) |
| Everything else | App | Yes |

---

## Path Aliases

Define aliases for host paths and OS paths, similar to tsconfig path mapping:

```typescript
const os = new OS({
  aliases: {
    // Host-side aliases (mount sources)
    '@src': './src',
    '@dist': './dist',

    // OS-side aliases (mount targets, handlers)
    '@app': '/vol/app',
    '@config': '/vol/config',
  }
});

// Use in mounts
os.mount('@src', '@app');           // ./src → /vol/app
os.mount('./config', '@config');    // ./config → /vol/config

// Use in service handlers
os.service({ handler: '@app/server.ts', activate: { type: 'boot' } });

// Use in shell commands
await os.shell('ls @app');
```

### Adding Aliases After Construction

```typescript
const os = new OS();
os.alias('@src', './src');
os.alias('@app', '/vol/app');
```

### Use Cases

1. **Dev vs Prod**: `@src` → `./src` in dev, `./dist` in prod
2. **DRY**: Don't repeat paths across mount calls
3. **Refactoring**: Change one alias definition, not N usages
4. **Environment switching**: CI uses different paths than local dev
5. **Explicit but concise**: Full control over where things mount

---

## Multiple OS Instances

Supported for testing and isolation:

```typescript
import { OS } from '@monk-api/os';

// Production instance
const prodOS = new OS();
prodOS.storage({ type: 'postgres', url: process.env.DATABASE_URL });
await prodOS.boot();

// Test instance (isolated)
const testOS = new OS();
testOS.storage({ type: 'memory' });
await testOS.boot();

// They don't share state
await prodOS.fs.write('/tmp/foo', 'prod');
await testOS.fs.read('/tmp/foo');  // Error: not found
```

**Note:** Server ports must not clash between instances.

---

## Example: Production Deployment

```typescript
// main.ts - compiled with `bun build --compile`
import { OS } from '@monk-api/os';

const os = new OS({
  aliases: {
    '@app': '/vol/app',
  }
});

// Mount app code (bundled or from host)
os.mount('./dist', '@app');

// Configure storage
os.storage({
  type: 'postgres',
  url: process.env.DATABASE_URL
});

// Register services
os.service({
  handler: '@app/server.ts',
  activate: { type: 'boot' }
});

// Take over - this is now the OS
await os.exec({ main: '/bin/init' });
```

---

## Example: Development

```typescript
// dev.ts
import { OS } from '@monk-api/os';

const os = new OS({
  aliases: {
    '@src': './src',
    '@app': '/vol/app',
  }
});

os.mount('@src', '@app', { watch: true });  // Hot reload
os.storage({ type: 'sqlite', path: './dev.db' });

await os.boot({ main: '@app/init.ts' });

// App continues - can interact for debugging
console.log('OS booted, init running');
console.log(await os.shell('ps'));

// Keep alive
process.on('SIGINT', async () => {
  await os.shutdown();
  process.exit(0);
});
```

---

## Example: Testing

```typescript
// test.ts
import { OS } from '@monk-api/os';
import { expect, test } from 'bun:test';

test('api returns users', async () => {
  const os = new OS({
    aliases: { '@app': '/vol/app' }
  });
  os.mount('./src', '@app');
  os.storage({ type: 'memory' });

  await os.boot();
  await os.services.start({ handler: '@app/server.ts', activate: { type: 'boot' } });

  // Test via shell or direct channel
  const result = await os.shell('curl localhost:9000/users');
  expect(result.stdout).toContain('users');

  await os.shutdown();
});
```

---

## Future Work

- [ ] `os.mount()` with `watch: true` for hot reload
- [ ] Signal forwarding in `exec()` mode
- [ ] Graceful shutdown coordination
- [ ] Health checks for services
- [ ] Logging/tracing integration
- [ ] Resource limits per OS instance
