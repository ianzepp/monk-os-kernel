# OS Services Architecture

> **Status**: Planning
> **Complexity**: Medium
> **Dependencies**: None

External, installable userspace services for Monk OS.

---

## Philosophy

The core OS is minimal - kernel, VFS, EMS, HAL. Everything else is a **userspace service** that:

1. Lives in an **external npm package** (e.g., `@anthropic/monk-smtpd`)
2. Is **installed at runtime** via `os.install()`
3. Is **started post-boot** via `os.service()`
4. Runs as a **normal process** with no special kernel privileges

The OS provides the platform. Services provide the features.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Application                                                     │
│                                                                  │
│  const os = new OS();                                           │
│  await os.boot();                                               │
│                                                                  │
│  // Install services from npm packages                          │
│  await os.install('@anthropic/monk-authd');                         │
│  await os.install('@anthropic/monk-smtpd');                         │
│  await os.install('@anthropic/monk-httpd');                         │
│                                                                  │
│  // Start services with config                                  │
│  await os.service('start', 'smtpd', { smtp: '...' });          │
│  await os.service('start', 'authd', { jwt: { ... } });         │
│  await os.service('start', 'httpd', { port: 8080 });           │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  OS Kernel (core only)                                           │
│  - Process management                                            │
│  - VFS / EMS                                                     │
│  - Syscalls                                                      │
│  - HAL devices                                                   │
│  - Service manager (start/stop/status)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Service Package Structure

Each service is an npm package with a standard structure:

```
@anthropic/monk-smtpd/
├── package.json
├── manifest.json          # Service metadata
├── sbin/
│   └── smtpd.ts          # Main service handler
├── lib/
│   └── ...               # Support libraries
├── etc/
│   └── smtpd/
│       └── config.schema.json   # Config validation
└── README.md
```

### manifest.json

```json
{
    "name": "smtpd",
    "version": "1.0.0",
    "description": "SMTP email sending service",

    "handler": "/sbin/smtpd.ts",

    "install": {
        "files": {
            "/sbin/smtpd.ts": "sbin/smtpd.ts",
            "/lib/smtp/client.ts": "lib/client.ts"
        },
        "schema": {
            "/etc/smtpd/": "etc/smtpd/"
        }
    },

    "dependencies": {
        "hal": ["channel"],
        "ems": ["email_queue"]
    },

    "config": {
        "schema": "etc/smtpd/config.schema.json",
        "required": ["smtp", "from"]
    }
}
```

---

## API

### os.install()

Install a service package into the VFS.

```typescript
interface InstallOptions {
    /** Override default install paths */
    paths?: Record<string, string>;

    /** Skip if already installed */
    skipIfExists?: boolean;
}

async install(
    packageName: string,
    opts?: InstallOptions
): Promise<InstallResult>;

interface InstallResult {
    name: string;
    version: string;
    files: string[];          // Installed file paths
    schemas?: string[];       // EMS schemas applied
}
```

**Implementation:**

```typescript
async install(packageName: string, opts?: InstallOptions): Promise<InstallResult> {
    // 1. Resolve package (require.resolve or import.meta.resolve)
    const packagePath = await this.resolvePackage(packageName);

    // 2. Read manifest
    const manifest = await this.readManifest(packagePath);

    // 3. Copy files to VFS
    for (const [vfsPath, pkgPath] of Object.entries(manifest.install.files)) {
        const content = await Bun.file(path.join(packagePath, pkgPath)).bytes();
        await this.vfs.writeFile(vfsPath, content);
    }

    // 4. Apply EMS schemas if needed
    if (manifest.dependencies?.ems) {
        for (const schema of manifest.dependencies.ems) {
            await this.ems.applySchema(schema);
        }
    }

    // 5. Register in service catalog
    await this.services.register(manifest.name, manifest);

    return {
        name: manifest.name,
        version: manifest.version,
        files: Object.keys(manifest.install.files),
    };
}
```

### os.service()

Manage service lifecycle.

```typescript
type ServiceAction = 'start' | 'stop' | 'restart' | 'status' | 'list';

async service(
    action: ServiceAction,
    name?: string,
    config?: Record<string, unknown>
): Promise<ServiceResult>;

interface ServiceResult {
    name: string;
    status: 'running' | 'stopped' | 'failed';
    pid?: number;
    error?: string;
}
```

**Usage:**

```typescript
// Start with config
await os.service('start', 'smtpd', {
    smtp: process.env.SMTP_URL,
    from: 'noreply@example.com',
});

// Stop
await os.service('stop', 'smtpd');

// Check status
const status = await os.service('status', 'smtpd');
console.log(status); // { name: 'smtpd', status: 'running', pid: 123 }

// List all services
const all = await os.service('list');
// [{ name: 'smtpd', status: 'running' }, { name: 'authd', status: 'stopped' }]
```

**Implementation:**

```typescript
async service(
    action: ServiceAction,
    name?: string,
    config?: Record<string, unknown>
): Promise<ServiceResult | ServiceResult[]> {
    switch (action) {
        case 'start': {
            const manifest = await this.services.getManifest(name);

            // Validate config against schema
            if (manifest.config?.schema) {
                this.validateConfig(config, manifest.config.schema);
            }

            // Write config to VFS
            await this.vfs.writeFile(
                `/etc/${name}/config.json`,
                JSON.stringify(config)
            );

            // Spawn service process
            const pid = await this.kernel.spawn(manifest.handler, {
                args: [],
                env: { SERVICE_NAME: name },
            });

            // Track in service table
            this.services.track(name, pid);

            return { name, status: 'running', pid };
        }

        case 'stop': {
            const pid = this.services.getPid(name);
            if (pid) {
                await this.kernel.kill(pid, SIGTERM);
                this.services.untrack(name);
            }
            return { name, status: 'stopped' };
        }

        case 'status': {
            const pid = this.services.getPid(name);
            const running = pid && this.kernel.isRunning(pid);
            return { name, status: running ? 'running' : 'stopped', pid };
        }

        case 'list': {
            return this.services.listAll();
        }
    }
}
```

---

## Service Communication

Services communicate via **pubsub**, not direct calls:

```typescript
// Application calls authd
const authPort = await os.port('pubsub', { subscribe: ['auth.response.*'] });
const requestId = crypto.randomUUID();

await os.publish('auth.validate', {
    jwt: token,
    replyTo: `auth.response.${requestId}`,
});

const response = await os.recv(authPort);
```

### Convenience Wrapper

```typescript
// os.call() wraps the pubsub request/response pattern
const result = await os.call('auth.validate', { jwt: token });
// Internally: publish, wait for response, return
```

**Implementation:**

```typescript
async call<T>(
    topic: string,
    data: Record<string, unknown>,
    timeout = 30000
): Promise<T> {
    const requestId = crypto.randomUUID();
    const replyTopic = `${topic.split('.')[0]}.response.${requestId}`;

    // Subscribe to response
    const port = await this.port('pubsub', { subscribe: [replyTopic] });

    try {
        // Send request
        await this.publish(topic, { ...data, replyTo: replyTopic });

        // Wait for response with timeout
        const response = await Promise.race([
            this.recv(port),
            sleep(timeout).then(() => { throw new Error('Timeout'); }),
        ]);

        if (response.meta?.error) {
            throw new Error(response.meta.error);
        }

        return response.meta as T;
    } finally {
        await this.closePort(port);
    }
}
```

---

## Service Catalog

Services are tracked in `/etc/services/catalog.json`:

```json
{
    "smtpd": {
        "version": "1.0.0",
        "handler": "/sbin/smtpd.ts",
        "installed": "2024-12-04T10:00:00Z",
        "package": "@anthropic/monk-smtpd"
    },
    "authd": {
        "version": "1.0.0",
        "handler": "/sbin/authd.ts",
        "installed": "2024-12-04T10:00:00Z",
        "package": "@anthropic/monk-authd"
    }
}
```

Runtime state in `/var/services/`:

```
/var/services/
├── smtpd.pid              # PID file
├── smtpd.status           # Status (running/stopped/failed)
└── smtpd.log              # Service logs (optional)
```

---

## Example: Full Setup

```typescript
import { OS } from '@anthropic/monk-os';

const os = new OS();

// Boot core OS
await os.boot();

// Install services (from npm peer dependencies)
await os.install('@anthropic/monk-smtpd');
await os.install('@anthropic/monk-authd');
await os.install('@anthropic/monk-httpd');

// Start SMTP first (authd depends on it for magic links)
await os.service('start', 'smtpd', {
    smtp: process.env.SMTP_URL,
    from: 'noreply@myapp.com',
});

// Start auth
await os.service('start', 'authd', {
    jwt: {
        secret: process.env.JWT_SECRET,
        issuer: 'myapp.com',
        ttl: 3600,
    },
    provider: 'magic-link',
    magicLink: {
        baseUrl: 'https://myapp.com',
        tokenTtl: 600,
    },
});

// Start HTTP server
await os.service('start', 'httpd', {
    port: 8080,
    routes: '/etc/httpd/routes.json',
});

console.log('All services started');

// Application code can now use services
const user = await os.call('auth.validate', { jwt: someToken });
```

---

## Service Dependencies

Services can declare dependencies on other services:

```json
// @anthropic/monk-authd/manifest.json
{
    "name": "authd",
    "requires": {
        "services": ["smtpd"],    // Must be running
        "optional": ["httpd"]     // Nice to have
    }
}
```

**Enforcement:**

```typescript
async service('start', name, config) {
    const manifest = await this.services.getManifest(name);

    // Check required services are running
    for (const dep of manifest.requires?.services ?? []) {
        const status = await this.service('status', dep);
        if (status.status !== 'running') {
            throw new Error(`Required service '${dep}' is not running`);
        }
    }

    // Continue with start...
}
```

---

## Graceful Shutdown

```typescript
// In application
process.on('SIGTERM', async () => {
    // Stop services in reverse order
    await os.service('stop', 'httpd');
    await os.service('stop', 'authd');
    await os.service('stop', 'smtpd');

    await os.shutdown();
    process.exit(0);
});

// Or use os.shutdown() which stops all services
await os.shutdown(); // Stops all running services, then kernel
```

---

## Implementation Plan

### Phase 1: Core Infrastructure

1. Add `ServiceManager` class to kernel
2. Implement `os.install()` - copy files to VFS
3. Implement `os.service('start')` - spawn + track
4. Implement `os.service('stop')` - kill + cleanup
5. Implement `os.service('status')` and `os.service('list')`

### Phase 2: Communication

1. Add `os.publish()` convenience method
2. Add `os.call()` request/response wrapper
3. Add timeout handling

### Phase 3: Service Packages

1. Define manifest.json schema
2. Create `@anthropic/monk-smtpd` package
3. Create `@anthropic/monk-authd` package
4. Create `@anthropic/monk-httpd` package

### Phase 4: Polish

1. Dependency checking
2. Config validation
3. Graceful shutdown
4. Health checks
5. Logging integration

---

## Impact on Other Docs

| Document | Change |
|----------|--------|
| OS_AUTHD.md | Remove boot-time config, use `os.service('start', ...)` |
| OS_SMTPD.md | Package as `@anthropic/monk-smtpd`, not built-in |
| OS_AI.md | AI process could be a service too |

---

## Open Questions

| Question | Options | Notes |
|----------|---------|-------|
| Package resolution | `require.resolve` vs explicit path | Use Node resolution for now |
| Hot reload | Restart on file change? | Nice for dev, skip for v1 |
| Service isolation | Same process pool vs separate? | Same pool for simplicity |
| Versioning | Check compatibility? | Later - trust semver for now |

---

## References

- `src/kernel/services.ts` - Existing service types (update this)
- systemd - Inspiration for service management
- npm - Package installation model
