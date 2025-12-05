# Monastery Architecture

Multi-service orchestration for Monk OS using isolated OS instances with shared storage.

## Overview

**Problem**: How do we run multiple services (httpd, smtpd, logd, displayd) with proper isolation while allowing them to share state?

**Solution**: Each service runs as its own Monk OS instance with isolated process tables and workers, but shares storage through PostgreSQL (EMS entities) and host filesystem mounts.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Monastery                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                     Primary OS (Abbot)                            │  │
│  │  - Reads /etc/monastery.json                                      │  │
│  │  - Spawns service OS instances via Bun.spawn()                    │  │
│  │  - Monitors health, restarts on failure                           │  │
│  │  - Manages service registry                                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                   │                                      │
│                            Bun.spawn()                                   │
│         ┌─────────────────┬───────┴───────┬─────────────────┐           │
│         ▼                 ▼               ▼                 ▼           │
│   ┌──────────┐      ┌──────────┐    ┌──────────┐      ┌──────────┐     │
│   │ httpd OS │      │ smtpd OS │    │  logd OS │      │displayd OS│    │
│   │          │      │          │    │          │      │          │     │
│   │ Workers  │      │ Workers  │    │ Workers  │      │ Workers  │     │
│   └────┬─────┘      └────┬─────┘    └────┬─────┘      └────┬─────┘     │
│        │                 │               │                 │           │
└────────┼─────────────────┼───────────────┼─────────────────┼───────────┘
         │                 │               │                 │
         └────────────┬────┴───────┬───────┴────┬────────────┘
                      ▼            ▼            ▼
              ┌─────────────┐ ┌─────────┐ ┌──────────────┐
              │ PostgreSQL  │ │  Host   │ │   Network    │
              │ (EMS/State) │ │Filesystem│ │  (clients)  │
              └─────────────┘ └─────────┘ └──────────────┘
```

## Philosophy

### Why Isolated OS Instances?

1. **True isolation**: Each service has its own process table, workers, and failure domain
2. **Independent scaling**: Run 4 httpd instances, 1 smtpd instance
3. **Simple deployment**: Each service is a single compiled binary (`bun build --compile`)
4. **No shared memory bugs**: Services can't corrupt each other's state
5. **Clean restarts**: Restart httpd without affecting smtpd

### Why Shared Storage?

1. **Data consistency**: All services see the same entities
2. **No serialization overhead**: Just read/write to VFS paths
3. **Built-in coordination**: PostgreSQL handles concurrent access
4. **Cross-service watch**: PG LISTEN/NOTIFY enables real-time updates

### The Hybrid Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    Per-Service (Isolated)                        │
├─────────────────────────────────────────────────────────────────┤
│  Process Table     - Workers are service-local                  │
│  HAL Instance      - Own timers, entropy, crypto                │
│  Local VFS         - /bin, /tmp, /proc, /dev                    │
│  Worker Pools      - Service manages its own concurrency        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Cross-Service (Shared)                        │
├─────────────────────────────────────────────────────────────────┤
│  /run/services     - Unix sockets for IPC (native messages)     │
│  /sys/services     - Service registry (discovery, health)       │
│  /data             - Application entities (users, files, etc.)  │
│  /vol/shared       - Host filesystem (uploads, config, assets)  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Service Configuration

### /etc/monastery.json

```json
{
    "postgres": "postgres://user:pass@localhost:5432/monastery",
    "shared": "./shared",

    "services": {
        "redisd": {
            "handler": "/bin/redisd",
            "instances": 1,
            "restart": "always",
            "priority": 0,
            "env": {
                "REDIS_BACKEND": "memory"
            }
        },
        "authd": {
            "handler": "/bin/authd",
            "instances": 1,
            "restart": "always",
            "priority": 1,
            "depends": ["redisd"],
            "env": {
                "JWT_SECRET": "${JWT_SECRET}",
                "JWT_ISSUER": "monastery.local",
                "JWT_TTL": "3600",
                "MAGIC_LINK_TTL": "600"
            }
        },
        "logd": {
            "handler": "/bin/logd",
            "instances": 1,
            "restart": "always",
            "priority": 1,
            "depends": ["redisd"]
        },
        "smtpd": {
            "handler": "/bin/smtpd",
            "instances": 1,
            "restart": "on-failure",
            "priority": 2,
            "env": {
                "PORT": "2525"
            },
            "depends": ["redisd", "logd"]
        },
        "jsond": {
            "handler": "/bin/jsond",
            "instances": 2,
            "restart": "always",
            "priority": 3,
            "env": {
                "PORT": "9000",
                "JSOND_ROOT": "/data"
            },
            "depends": ["redisd", "authd"]
        },
        "httpd": {
            "handler": "/bin/httpd",
            "instances": 4,
            "restart": "always",
            "priority": 3,
            "env": {
                "PORT": "8080",
                "WORKERS": "8"
            },
            "healthCheck": {
                "http": "http://localhost:${PORT}/health",
                "interval": 5000,
                "timeout": 3000
            },
            "depends": ["redisd", "authd", "logd", "smtpd"]
        },
        "displayd": {
            "handler": "/bin/displayd",
            "instances": 1,
            "restart": "always",
            "priority": 4,
            "env": {
                "PORT": "3000"
            },
            "depends": ["httpd"]
        }
    }
}
```

### Service Configuration Schema

```typescript
interface MonasteryConfig {
    // Shared PostgreSQL connection (all services connect here)
    postgres: string;

    // Host directory for shared filesystem mounts
    shared: string;

    // Service definitions
    services: Record<string, ServiceConfig>;
}

interface ServiceConfig {
    // Path to service binary (relative to VFS /bin)
    handler: string;

    // Number of instances to run (default: 1)
    instances?: number;

    // Restart policy
    restart?: 'always' | 'on-failure' | 'never';

    // Start priority (lower = earlier, default: 10)
    priority?: number;

    // Environment variables passed to service
    env?: Record<string, string>;

    // Services that must start before this one
    depends?: string[];

    // Health check configuration
    healthCheck?: {
        // HTTP endpoint to check
        http?: string;

        // Check interval in ms (default: 10000)
        interval?: number;

        // Request timeout in ms (default: 5000)
        timeout?: number;

        // Failures before restart (default: 3)
        threshold?: number;
    };

    // Resource limits (future)
    limits?: {
        maxWorkers?: number;
        maxMemory?: string;
    };
}
```

---

## VFS Mount Strategy

Each service OS boots with the same mount configuration:

```typescript
const os = new OS({
    storage: {
        type: 'postgres',
        url: config.postgres
    }
})
.on('vfs', (os) => {
    // Shared entity storage (EMS via PostgreSQL)
    // All services see the same /data tree
    os.fs.mountEntity('/data');

    // Service registry (EMS via PostgreSQL)
    // All services see the same /sys/services tree
    os.fs.mountEntity('/sys/services');

    // Shared host filesystem
    // All services see the same /vol/shared tree
    os.fs.mountHost('/vol/shared', config.shared);

    // Unix socket directory (for inter-service IPC)
    // All services create/connect to sockets here
    os.fs.mountHost('/run/services', './run/services');

    // Service-specific host mount (optional)
    // Each service can have private host storage
    os.fs.mountHost('/vol/local', `./data/${serviceName}`);
});
```

### Mount Types

| Mount | Path | Backing | Shared? | Use Case |
|-------|------|---------|---------|----------|
| EntityMount | `/data` | PostgreSQL EMS | Yes | User data, entities, state |
| EntityMount | `/sys/services` | PostgreSQL EMS | Yes | Service registry, discovery |
| HostMount | `/vol/shared` | Host `./shared` | Yes | Uploads, config, assets |
| HostMount | `/vol/local` | Host `./data/{svc}` | No | Service-local temp files |
| HostMount | `/run/services` | Host `./run/services` | Yes | Unix socket files for IPC |
| VFS (default) | `/bin`, `/etc` | ROM/EMS | Per-service | Binaries, service config |
| VFS (default) | `/tmp` | Memory | Per-service | Temporary files |
| VFS (default) | `/proc` | HAL | Per-service | Process info |
| VFS (default) | `/dev` | HAL | Per-service | Devices |

### Cross-Service Data Flow

```
httpd receives upload:
    write('/vol/shared/uploads/abc.jpg', data)
    create('/data/files/abc', { path: '/vol/shared/uploads/abc.jpg', ... })

displayd serves file:
    stat('/data/files/abc')  // sees entity created by httpd
    read('/vol/shared/uploads/abc.jpg')  // reads same physical file

httpd needs to send email (via Unix socket):
    info = read('/sys/services/smtpd/smtpd-0-abc123')  // { unix: '/run/services/smtpd.sock', ... }
    conn = connect({ unix: info.unix })
    send(conn, { op: 'send_email', data: { to, subject, body } })
    response = recv(conn)  // { op: 'ok', data: { messageId } }
    close(conn)
```

---

## Service Manager Implementation

### Types

```typescript
// monastery/src/types.ts

export interface ServiceInstance {
    id: string;                    // Unique instance ID
    name: string;                  // Service name (httpd, smtpd, etc.)
    index: number;                 // Instance index (0, 1, 2, ...)
    process: Subprocess;           // Bun.spawn handle
    status: ServiceStatus;
    pid: number;                   // OS-level PID
    startedAt: number;             // Timestamp
    restarts: number;              // Restart count
    lastHealthCheck?: number;      // Last successful health check
    healthFailures: number;        // Consecutive health failures
}

export type ServiceStatus =
    | 'starting'      // Process spawned, waiting for health
    | 'running'       // Healthy and serving
    | 'unhealthy'     // Failed health checks
    | 'stopping'      // SIGTERM sent, waiting for exit
    | 'stopped'       // Clean exit
    | 'failed';       // Non-zero exit or crash

export interface ServiceRegistry {
    name: string;
    instances: {
        id: string;
        host: string;
        port: number;
        status: ServiceStatus;
    }[];
}
```

### ServiceManager Class

```typescript
// monastery/src/service-manager.ts

import type { Subprocess } from 'bun';
import type { MonasteryConfig, ServiceConfig, ServiceInstance, ServiceStatus } from './types';

export class ServiceManager {
    private config: MonasteryConfig;
    private instances = new Map<string, ServiceInstance[]>();
    private healthTimers = new Map<string, Timer>();

    constructor(config: MonasteryConfig) {
        this.config = config;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    async startAll(): Promise<void> {
        const order = this.resolveDependencyOrder();

        for (const name of order) {
            await this.startService(name);
        }

        console.log('[monastery] All services started');
    }

    async shutdownAll(): Promise<void> {
        // Stop health checks
        for (const timer of this.healthTimers.values()) {
            clearInterval(timer);
        }
        this.healthTimers.clear();

        // Shutdown in reverse dependency order
        const order = this.resolveDependencyOrder().reverse();

        for (const name of order) {
            await this.stopService(name);
        }

        console.log('[monastery] All services stopped');
    }

    // =========================================================================
    // SERVICE CONTROL
    // =========================================================================

    async startService(name: string): Promise<void> {
        const config = this.config.services[name];
        if (!config) {
            throw new Error(`Unknown service: ${name}`);
        }

        // Check dependencies are running
        for (const dep of config.depends ?? []) {
            const depInstances = this.instances.get(dep);
            const allRunning = depInstances?.every(i => i.status === 'running');
            if (!allRunning) {
                throw new Error(`Dependency ${dep} is not running`);
            }
        }

        const count = config.instances ?? 1;
        const instances: ServiceInstance[] = [];

        for (let i = 0; i < count; i++) {
            const instance = await this.spawnInstance(name, config, i);
            instances.push(instance);
        }

        this.instances.set(name, instances);

        // Start health monitoring
        if (config.healthCheck) {
            this.startHealthMonitor(name, config);
        }

        console.log(`[monastery] ${name}: started ${count} instance(s)`);
    }

    async stopService(name: string): Promise<void> {
        // Stop health monitor
        const timer = this.healthTimers.get(name);
        if (timer) {
            clearInterval(timer);
            this.healthTimers.delete(name);
        }

        const instances = this.instances.get(name);
        if (!instances) return;

        // Graceful shutdown with timeout
        await Promise.all(instances.map(async (instance) => {
            instance.status = 'stopping';
            instance.process.kill('SIGTERM');

            const exited = await Promise.race([
                instance.process.exited,
                Bun.sleep(10_000).then(() => null)
            ]);

            if (exited === null) {
                // Force kill after timeout
                instance.process.kill('SIGKILL');
                await instance.process.exited;
            }

            instance.status = 'stopped';
        }));

        this.instances.delete(name);
        console.log(`[monastery] ${name}: stopped`);
    }

    async restartService(name: string): Promise<void> {
        await this.stopService(name);
        await this.startService(name);
    }

    // =========================================================================
    // INSTANCE MANAGEMENT
    // =========================================================================

    private async spawnInstance(
        name: string,
        config: ServiceConfig,
        index: number
    ): Promise<ServiceInstance> {
        const id = `${name}-${index}-${Date.now().toString(36)}`;

        // Build environment
        const env: Record<string, string> = {
            ...process.env,
            ...config.env,

            // Monastery context
            MONK_SERVICE: name,
            MONK_INSTANCE: id,
            MONK_INDEX: String(index),

            // Shared infrastructure
            MONK_POSTGRES: this.config.postgres,
            MONK_SHARED: this.config.shared,
        };

        // Spawn OS with service as main
        // WHY: Bun.spawn (not kernel spawn) - each service is a separate OS process
        const proc = Bun.spawn({
            cmd: ['bun', 'run', 'dist/os.js', '--main', config.handler],
            env,
            stdout: 'pipe',
            stderr: 'pipe',
            cwd: process.cwd(),
        });

        const instance: ServiceInstance = {
            id,
            name,
            index,
            process: proc,
            status: 'starting',
            pid: proc.pid,
            startedAt: Date.now(),
            restarts: 0,
            healthFailures: 0,
        };

        // Handle exit
        proc.exited.then((code) => {
            this.handleExit(instance, code, config);
        });

        // Stream logs
        this.streamLogs(instance, proc);

        // Wait for healthy (if health check configured)
        if (config.healthCheck) {
            await this.waitForHealthy(instance, config.healthCheck);
        }
        else {
            // No health check - mark running after brief delay
            await Bun.sleep(100);
        }

        instance.status = 'running';
        return instance;
    }

    private handleExit(
        instance: ServiceInstance,
        code: number,
        config: ServiceConfig
    ): void {
        // Don't restart if we're intentionally stopping
        if (instance.status === 'stopping') {
            instance.status = 'stopped';
            return;
        }

        const shouldRestart =
            config.restart === 'always' ||
            (config.restart === 'on-failure' && code !== 0);

        if (shouldRestart) {
            instance.status = 'failed';
            instance.restarts++;

            // Exponential backoff: 1s, 2s, 4s, 8s, ... max 60s
            const backoff = Math.min(1000 * Math.pow(2, instance.restarts - 1), 60_000);

            console.log(`[monastery] ${instance.id}: exited (code ${code}), restarting in ${backoff}ms`);

            setTimeout(async () => {
                try {
                    const newInstance = await this.spawnInstance(
                        instance.name,
                        config,
                        instance.index
                    );
                    newInstance.restarts = instance.restarts;

                    // Replace in instances array
                    const instances = this.instances.get(instance.name);
                    if (instances) {
                        const idx = instances.findIndex(i => i.id === instance.id);
                        if (idx >= 0) {
                            instances[idx] = newInstance;
                        }
                    }
                }
                catch (err) {
                    console.error(`[monastery] ${instance.name}: failed to restart`, err);
                }
            }, backoff);
        }
        else {
            instance.status = code === 0 ? 'stopped' : 'failed';
            console.log(`[monastery] ${instance.id}: exited (code ${code}), not restarting`);
        }
    }

    // =========================================================================
    // HEALTH MONITORING
    // =========================================================================

    private startHealthMonitor(name: string, config: ServiceConfig): void {
        const check = config.healthCheck!;
        const interval = check.interval ?? 10_000;

        const timer = setInterval(() => {
            this.checkServiceHealth(name, config);
        }, interval);

        this.healthTimers.set(name, timer);
    }

    private async checkServiceHealth(name: string, config: ServiceConfig): Promise<void> {
        const instances = this.instances.get(name);
        if (!instances) return;

        const check = config.healthCheck!;
        const threshold = check.threshold ?? 3;

        for (const instance of instances) {
            if (instance.status !== 'running' && instance.status !== 'unhealthy') {
                continue;
            }

            const healthy = await this.checkInstanceHealth(instance, check);

            if (healthy) {
                instance.lastHealthCheck = Date.now();
                instance.healthFailures = 0;
                if (instance.status === 'unhealthy') {
                    instance.status = 'running';
                    console.log(`[monastery] ${instance.id}: recovered`);
                }
            }
            else {
                instance.healthFailures++;
                console.log(`[monastery] ${instance.id}: health check failed (${instance.healthFailures}/${threshold})`);

                if (instance.healthFailures >= threshold) {
                    instance.status = 'unhealthy';
                    console.log(`[monastery] ${instance.id}: unhealthy, restarting`);
                    instance.process.kill('SIGTERM');
                }
            }
        }
    }

    private async checkInstanceHealth(
        instance: ServiceInstance,
        check: NonNullable<ServiceConfig['healthCheck']>
    ): Promise<boolean> {
        try {
            if (check.http) {
                // Interpolate environment variables in URL
                const url = check.http.replace(/\$\{(\w+)\}/g, (_, key) => {
                    return process.env[key] ?? '';
                });

                const res = await fetch(url, {
                    signal: AbortSignal.timeout(check.timeout ?? 5000),
                });
                return res.ok;
            }

            // Default: process is alive
            return !instance.process.killed;
        }
        catch {
            return false;
        }
    }

    private async waitForHealthy(
        instance: ServiceInstance,
        check: NonNullable<ServiceConfig['healthCheck']>
    ): Promise<void> {
        const maxWait = 30_000;
        const checkInterval = 500;
        const start = Date.now();

        while (Date.now() - start < maxWait) {
            if (await this.checkInstanceHealth(instance, check)) {
                return;
            }
            await Bun.sleep(checkInterval);
        }

        throw new Error(`${instance.id}: failed to become healthy within ${maxWait}ms`);
    }

    // =========================================================================
    // LOGGING
    // =========================================================================

    private streamLogs(instance: ServiceInstance, proc: Subprocess): void {
        const prefix = `[${instance.name}:${instance.index}]`;

        // Stream stdout
        (async () => {
            const reader = proc.stdout.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value);
                for (const line of text.split('\n')) {
                    if (line) console.log(`${prefix} ${line}`);
                }
            }
        })();

        // Stream stderr
        (async () => {
            const reader = proc.stderr.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value);
                for (const line of text.split('\n')) {
                    if (line) console.error(`${prefix} ${line}`);
                }
            }
        })();
    }

    // =========================================================================
    // DEPENDENCY RESOLUTION
    // =========================================================================

    private resolveDependencyOrder(): string[] {
        const services = this.config.services;
        const visited = new Set<string>();
        const visiting = new Set<string>();
        const order: string[] = [];

        const visit = (name: string) => {
            if (visited.has(name)) return;
            if (visiting.has(name)) {
                throw new Error(`Circular dependency detected: ${name}`);
            }

            visiting.add(name);

            const config = services[name];
            if (!config) {
                throw new Error(`Unknown service in depends: ${name}`);
            }

            for (const dep of config.depends ?? []) {
                visit(dep);
            }

            visiting.delete(name);
            visited.add(name);
            order.push(name);
        };

        // Sort by priority first, then visit
        const sorted = Object.entries(services)
            .sort(([, a], [, b]) => (a.priority ?? 10) - (b.priority ?? 10))
            .map(([name]) => name);

        for (const name of sorted) {
            visit(name);
        }

        return order;
    }

    // =========================================================================
    // STATUS
    // =========================================================================

    getStatus(): Record<string, ServiceInstance[]> {
        const status: Record<string, ServiceInstance[]> = {};
        for (const [name, instances] of this.instances) {
            status[name] = instances.map(i => ({
                ...i,
                process: undefined as any,  // Don't include process handle
            }));
        }
        return status;
    }
}
```

### Entry Point

```typescript
// monastery/src/main.ts

import { OS } from '@monk-api/os';
import { ServiceManager } from './service-manager';
import type { MonasteryConfig } from './types';

async function main() {
    // Boot primary OS (the Abbot)
    const os = new OS({
        storage: { type: 'memory' },  // Abbot doesn't need persistent storage
    });

    await os.boot();

    // Load monastery configuration
    const configPath = process.env.MONK_CONFIG ?? './etc/monastery.json';
    const configFile = await Bun.file(configPath).text();
    const config: MonasteryConfig = JSON.parse(configFile);

    // Create service manager
    const manager = new ServiceManager(config);

    // Handle shutdown signals
    const shutdown = async () => {
        console.log('[monastery] Shutting down...');
        await manager.shutdownAll();
        await os.shutdown();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Start all services
    await manager.startAll();

    console.log('[monastery] Ready');
}

main().catch((err) => {
    console.error('[monastery] Fatal error:', err);
    process.exit(1);
});
```

---

## Service Discovery

Services discover each other through the shared VFS at `/sys/services`. The service registry is backed by EMS entities in PostgreSQL, giving us standard file operations, watch support, and cross-service visibility.

### Registry Structure

```
/sys/services/
├── httpd/
│   ├── httpd-0-abc123     # instance entity
│   ├── httpd-1-def456
│   └── httpd-2-ghi789
├── smtpd/
│   └── smtpd-0-jkl012
└── logd/
    └── logd-0-mno345
```

Each instance entity contains:

```typescript
interface ServiceInstance {
    // Unix socket path (primary, same-host IPC)
    unix: string;           // '/run/services/smtpd.sock'

    // TCP fallback (distributed deployments)
    host?: string;          // 'localhost' or IP
    port?: number;          // Service port

    status: 'running' | 'stopping' | 'unhealthy';
    startedAt: number;      // Unix timestamp
    metadata?: {
        version?: string;
        workers?: number;
        [key: string]: unknown;
    };
}
```

### Service Registration

Services register themselves on boot using standard VFS operations:

```typescript
// Service registers itself on boot
const instanceId = process.env.MONK_INSTANCE!;
const serviceName = process.env.MONK_SERVICE!;
const socketPath = `/run/services/${serviceName}.sock`;

// Create Unix socket for IPC
const sock = await listen({ unix: socketPath });

// Register in service directory
await mkdir(`/sys/services/${serviceName}`);
await writeFile(`/sys/services/${serviceName}/${instanceId}`, JSON.stringify({
    unix: socketPath,
    host: hostname(),
    port: parseInt(process.env.PORT ?? '0'),
    status: 'running',
    startedAt: Date.now(),
    metadata: {
        version: '1.0.0',
        workers: 4,
    },
}));

// Heartbeat via touch (updates mtime)
setInterval(() => {
    touch(`/sys/services/${serviceName}/${instanceId}`);
}, 5000);

// Deregister on shutdown
process.on('SIGTERM', async () => {
    await close(sock);
    await unlink(socketPath);
    await unlink(`/sys/services/${serviceName}/${instanceId}`);
    process.exit(0);
});
```

### Service Lookup

Services find each other by reading the registry:

```typescript
// Find a specific service
async function findService(name: string): Promise<ServiceInstance | null> {
    try {
        const instances = await readdir(`/sys/services/${name}`);
        if (instances.length === 0) return null;

        // Pick first available (or implement load balancing)
        const data = await readFile(`/sys/services/${name}/${instances[0]}`);
        return JSON.parse(data);
    }
    catch {
        return null;
    }
}

// Find all instances of a service
async function findAllInstances(name: string): Promise<ServiceInstance[]> {
    const instances = await readdir(`/sys/services/${name}`);
    const results: ServiceInstance[] = [];

    for (const id of instances) {
        const data = await readFile(`/sys/services/${name}/${id}`);
        results.push(JSON.parse(data));
    }

    return results;
}

// Usage - connect via Unix socket
const smtp = await findService('smtpd');
if (smtp) {
    const conn = await connect({ unix: smtp.unix });
    await send(conn, { op: 'send_email', data: { to, subject, body } });
    const response = await recv(conn);
    await close(conn);
}
```

### Watching for Service Changes

Because the registry is backed by EMS, `watch()` works automatically:

```typescript
// Watch for any service changes
for await (const event of watch('/sys/services/**')) {
    switch (event.type) {
        case 'create':
            console.log(`Service instance came up: ${event.path}`);
            break;
        case 'delete':
            console.log(`Service instance went down: ${event.path}`);
            break;
        case 'modify':
            console.log(`Service instance updated: ${event.path}`);
            break;
    }
}

// Watch for specific service
for await (const event of watch('/sys/services/httpd/*')) {
    // React to httpd scaling up/down
    await updateLoadBalancer();
}
```

### Client-Side Load Balancing

Services can implement their own load balancing:

```typescript
class ServiceClient {
    private instances: Map<string, ServiceInstance> = new Map();
    private roundRobin = 0;

    constructor(private serviceName: string) {
        this.startWatching();
    }

    private async startWatching() {
        // Initial load
        for (const id of await readdir(`/sys/services/${this.serviceName}`)) {
            const data = await readFile(`/sys/services/${this.serviceName}/${id}`);
            this.instances.set(id, JSON.parse(data));
        }

        // Watch for changes
        for await (const event of watch(`/sys/services/${this.serviceName}/*`)) {
            if (event.type === 'create' || event.type === 'modify') {
                const data = await readFile(event.path);
                this.instances.set(event.name, JSON.parse(data));
            }
            else if (event.type === 'delete') {
                this.instances.delete(event.name);
            }
        }
    }

    getEndpoint(): { host: string; port: number } | null {
        const running = [...this.instances.values()]
            .filter(i => i.status === 'running');

        if (running.length === 0) return null;

        // Round-robin
        const instance = running[this.roundRobin % running.length];
        this.roundRobin++;

        return { host: instance.host, port: instance.port };
    }
}

// Usage
const httpClient = new ServiceClient('httpd');
const endpoint = httpClient.getEndpoint();
if (endpoint) {
    await fetch(`http://${endpoint.host}:${endpoint.port}/api`);
}
```

### DNS (Production/K8s)

In containerized environments, you can skip the VFS registry and use DNS:

```typescript
// Services are deployed as K8s Services with stable DNS names
await fetch('http://httpd.monastery.svc.cluster.local:8080/api');
```

The VFS registry remains useful for health status, metadata, and instance-level routing even when using external DNS.

---

## Cross-Service Communication

Services communicate using native message objects over Unix sockets (same host) or TCP (distributed). This matches the internal message-based architecture—no HTTP serialization overhead for internal RPC.

### Communication Methods

| Method | Use Case | Overhead | Reliability |
|--------|----------|----------|-------------|
| Unix Sockets | Same-host RPC (primary) | Minimal (kernel IPC) | Reliable |
| TCP | Distributed deployments | Network stack | Reliable |
| Shared VFS | Data sharing, state | EMS/PostgreSQL | Durable |
| HTTP | External clients only | Headers, framing | Reliable |

### Unix Sockets (Primary IPC)

Each service exposes a Unix socket at `/run/services/{name}.sock`:

```
/run/services/
├── httpd.sock
├── smtpd.sock
├── logd.sock
└── displayd.sock
```

**Server side (smtpd):**

```typescript
// smtpd listens on Unix socket
const sock = await listen({ unix: '/run/services/smtpd.sock' });

for await (const conn of accept(sock)) {
    // Handle connection in background
    handleConnection(conn);
}

async function handleConnection(conn: number) {
    for await (const msg of recv(conn)) {
        switch (msg.op) {
            case 'send_email':
                const result = await sendEmail(msg.data);
                await send(conn, respond.ok({ messageId: result.id }));
                break;

            case 'check_quota':
                const quota = await getQuota(msg.data.userId);
                await send(conn, respond.ok(quota));
                break;

            default:
                await send(conn, respond.error('ENOSYS', `Unknown op: ${msg.op}`));
        }
    }
    await close(conn);
}
```

**Client side (httpd calling smtpd):**

```typescript
// Connect to smtpd via Unix socket
const conn = await connect({ unix: '/run/services/smtpd.sock' });

// Send request (native message object, no JSON.stringify needed at app level)
await send(conn, { op: 'send_email', data: { to, subject, body } });

// Receive response
const response = await recv(conn);
if (response.op === 'ok') {
    console.log('Sent:', response.data.messageId);
}

await close(conn);
```

### Service Registry with Socket Paths

The `/sys/services` registry advertises socket paths:

```typescript
interface ServiceInstance {
    // Unix socket (same host)
    unix: string;           // '/run/services/smtpd.sock'

    // TCP fallback (distributed)
    host?: string;          // 'node-2.cluster.local'
    port?: number;          // 2525

    status: 'running' | 'stopping' | 'unhealthy';
    startedAt: number;
}

// Registration on boot
await writeFile(`/sys/services/smtpd/${instanceId}`, JSON.stringify({
    unix: '/run/services/smtpd.sock',
    host: hostname(),
    port: 2525,
    status: 'running',
    startedAt: Date.now(),
}));
```

### Service Client Helper

A helper class for service-to-service calls:

```typescript
class ServiceClient {
    private conn: number | null = null;

    constructor(private serviceName: string) {}

    async call<T>(op: string, data?: unknown): Promise<T> {
        // Lazy connect
        if (!this.conn) {
            const info = await this.resolve();
            this.conn = await connect({ unix: info.unix });
        }

        await send(this.conn, { op, data });
        const response = await recv(this.conn);

        if (response.op === 'error') {
            throw new Error(response.data.message);
        }

        return response.data as T;
    }

    private async resolve(): Promise<ServiceInstance> {
        const instances = await readdir(`/sys/services/${this.serviceName}`);
        if (instances.length === 0) {
            throw new Error(`Service not found: ${this.serviceName}`);
        }
        const data = await readFile(`/sys/services/${this.serviceName}/${instances[0]}`);
        return JSON.parse(data);
    }

    async close() {
        if (this.conn) {
            await close(this.conn);
            this.conn = null;
        }
    }
}

// Usage
const smtp = new ServiceClient('smtpd');
const result = await smtp.call<{ messageId: string }>('send_email', {
    to: 'user@example.com',
    subject: 'Hello',
    body: 'World',
});
console.log('Sent:', result.messageId);
```

### TCP Fallback (Distributed Deployments)

When services run on different hosts, fall back to TCP:

```typescript
async function connectToService(name: string): Promise<number> {
    const info = await resolveService(name);

    // Prefer Unix socket if available and local
    if (info.unix && info.host === hostname()) {
        return connect({ unix: info.unix });
    }

    // Fall back to TCP
    if (info.host && info.port) {
        return connect({ host: info.host, port: info.port });
    }

    throw new Error(`No route to service: ${name}`);
}
```

### Via Shared VFS (Data Sharing)

For durable data that multiple services need to access, use the shared VFS:

```typescript
// httpd creates a job entity
await writeFile('/data/jobs/123.json', JSON.stringify(job));

// smtpd watches for new jobs (via EMS/PostgreSQL)
for await (const event of watch('/data/jobs/*.json')) {
    if (event.type === 'create') {
        const job = JSON.parse(await readFile(event.path));
        await sendEmail(job);
        await unlink(event.path);  // Mark as processed
    }
}
```

### HTTP (External Only)

Reserve HTTP for external clients and webhooks:

```typescript
// httpd exposes HTTP for external clients
Bun.serve({
    port: 8080,
    async fetch(req) {
        // External API
        if (req.url.endsWith('/api/send-email')) {
            const { to, subject, body } = await req.json();

            // Internal call via Unix socket
            const smtp = new ServiceClient('smtpd');
            const result = await smtp.call('send_email', { to, subject, body });

            return Response.json(result);
        }
    }
});
```

### Why Not HTTP Internally?

| | HTTP | Unix Socket Messages |
|---|------|---------------------|
| Connection | TCP + TLS handshake | Kernel IPC |
| Serialization | JSON → UTF-8 → JSON | Native objects |
| Headers | ~500 bytes overhead | None |
| Latency | ~1-10ms | ~0.1ms |
| Fit | Text-based, external | Binary, internal |

Internal services already speak `{ op, data }` messages. HTTP adds unnecessary serialization and connection overhead. Unix sockets let services communicate in their native format.

---

## Core Infrastructure Services

These services form the foundation of the Monastery. They start first and other services depend on them.

### redisd - Shared State & Caching

A Redis-protocol server that provides shared state for all services. Services configure their HAL to point at `redisd` via Unix socket, without knowing or caring about the actual backend.

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  httpd OS   │  │  smtpd OS   │  │ displayd OS │
│             │  │             │  │             │
│ HAL.storage │  │ HAL.storage │  │ HAL.storage │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────┬───────┴────────┬───────┘
                │  Redis protocol │
                │  (Unix socket)  │
                ▼                 ▼
       ┌─────────────────────────────────┐
       │           redisd OS             │
       │  /run/services/redisd.sock      │
       │                                 │
       │  Backend (configurable):        │
       │  - memory (default, fast)       │
       │  - redis (real Redis cluster)   │
       │  - ems (PostgreSQL via EMS)     │
       └─────────────────────────────────┘
```

**Why redisd:**

| Benefit | Description |
|---------|-------------|
| HAL abstraction | Services use `storage: { type: 'redis', unix: '...' }` |
| Process isolation | redisd crash doesn't take down services |
| Swappable backend | Memory for dev, Redis for prod, no code changes |
| Standard protocol | Any Redis client works, debug with `redis-cli` |
| Shared cache | All services share state without custom IPC |

**Service configuration:**

```json
{
    "services": {
        "redisd": {
            "handler": "/bin/redisd",
            "instances": 1,
            "restart": "always",
            "priority": 0,
            "env": {
                "REDIS_BACKEND": "memory"
            }
        }
    }
}
```

**redisd implementation:**

```typescript
// monastery/bin/redisd.ts
import { OS } from '@monk-api/os';

// Backend implementations
interface Backend {
    get(key: string): Promise<Buffer | null>;
    set(key: string, value: Buffer, options?: { ex?: number }): Promise<void>;
    del(key: string): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    publish(channel: string, message: string): Promise<number>;
    subscribe(channel: string, callback: (message: string) => void): Promise<void>;
}

class MemoryBackend implements Backend {
    private data = new Map<string, { value: Buffer; expiresAt?: number }>();
    private subscribers = new Map<string, Set<(msg: string) => void>>();

    async get(key: string): Promise<Buffer | null> {
        const entry = this.data.get(key);
        if (!entry) return null;
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            this.data.delete(key);
            return null;
        }
        return entry.value;
    }

    async set(key: string, value: Buffer, options?: { ex?: number }): Promise<void> {
        this.data.set(key, {
            value,
            expiresAt: options?.ex ? Date.now() + options.ex * 1000 : undefined,
        });
    }

    async del(key: string): Promise<number> {
        return this.data.delete(key) ? 1 : 0;
    }

    async keys(pattern: string): Promise<string[]> {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return [...this.data.keys()].filter(k => regex.test(k));
    }

    async publish(channel: string, message: string): Promise<number> {
        const subs = this.subscribers.get(channel);
        if (!subs) return 0;
        for (const cb of subs) cb(message);
        return subs.size;
    }

    async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
        if (!this.subscribers.has(channel)) {
            this.subscribers.set(channel, new Set());
        }
        this.subscribers.get(channel)!.add(callback);
    }
}

class RedisBackend implements Backend {
    // Proxy to real Redis server
    constructor(private url: string) {}
    // ... delegate to redis client
}

// RESP protocol parser/encoder
function parseRESP(data: Buffer): Array<string[]> {
    const commands: Array<string[]> = [];
    let pos = 0;

    while (pos < data.length) {
        if (data[pos] !== 0x2a) break; // '*'
        pos++;

        // Parse array length
        let lenEnd = data.indexOf(0x0d, pos); // '\r'
        const argc = parseInt(data.slice(pos, lenEnd).toString());
        pos = lenEnd + 2; // skip \r\n

        const args: string[] = [];
        for (let i = 0; i < argc; i++) {
            if (data[pos] !== 0x24) break; // '$'
            pos++;

            // Parse bulk string length
            lenEnd = data.indexOf(0x0d, pos);
            const len = parseInt(data.slice(pos, lenEnd).toString());
            pos = lenEnd + 2; // skip \r\n

            // Parse bulk string value
            args.push(data.slice(pos, pos + len).toString());
            pos += len + 2; // skip value + \r\n
        }

        commands.push(args);
    }

    return commands;
}

function encodeRESP(value: unknown): Buffer {
    if (value === null || value === undefined) {
        return Buffer.from('$-1\r\n');
    }
    if (typeof value === 'string') {
        return Buffer.from(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
    }
    if (Buffer.isBuffer(value)) {
        return Buffer.concat([
            Buffer.from(`$${value.length}\r\n`),
            value,
            Buffer.from('\r\n'),
        ]);
    }
    if (typeof value === 'number') {
        return Buffer.from(`:${value}\r\n`);
    }
    if (Array.isArray(value)) {
        const parts = [Buffer.from(`*${value.length}\r\n`)];
        for (const item of value) {
            parts.push(encodeRESP(item));
        }
        return Buffer.concat(parts);
    }
    if (value === 'OK') {
        return Buffer.from('+OK\r\n');
    }
    // Error
    if (value instanceof Error) {
        return Buffer.from(`-ERR ${value.message}\r\n`);
    }
    return Buffer.from(`-ERR unknown type\r\n`);
}

// Main server
const os = new OS({ storage: { type: 'memory' } });

await os.boot();

const backendType = process.env.REDIS_BACKEND ?? 'memory';
const backend: Backend = backendType === 'redis'
    ? new RedisBackend(process.env.REDIS_URL!)
    : new MemoryBackend();

const socketPath = '/run/services/redisd.sock';

Bun.listen({
    unix: socketPath,
    socket: {
        async data(socket, data) {
            const commands = parseRESP(Buffer.from(data));

            for (const [cmd, ...args] of commands) {
                let result: unknown;

                try {
                    switch (cmd.toUpperCase()) {
                        case 'PING':
                            result = 'PONG';
                            break;

                        case 'GET':
                            result = await backend.get(args[0]);
                            break;

                        case 'SET': {
                            const options: { ex?: number } = {};
                            for (let i = 2; i < args.length; i += 2) {
                                if (args[i].toUpperCase() === 'EX') {
                                    options.ex = parseInt(args[i + 1]);
                                }
                            }
                            await backend.set(args[0], Buffer.from(args[1]), options);
                            result = 'OK';
                            break;
                        }

                        case 'DEL':
                            result = await backend.del(args[0]);
                            break;

                        case 'KEYS':
                            result = await backend.keys(args[0]);
                            break;

                        case 'PUBLISH':
                            result = await backend.publish(args[0], args[1]);
                            break;

                        case 'SUBSCRIBE':
                            await backend.subscribe(args[0], (msg) => {
                                socket.write(encodeRESP(['message', args[0], msg]));
                            });
                            socket.write(encodeRESP(['subscribe', args[0], 1]));
                            continue; // Don't send another response

                        default:
                            result = new Error(`Unknown command: ${cmd}`);
                    }
                }
                catch (err) {
                    result = err;
                }

                socket.write(encodeRESP(result));
            }
        },
    },
});

// Register in service directory
const instanceId = process.env.MONK_INSTANCE ?? 'redisd-0';
await Bun.write('/sys/services/redisd/' + instanceId, JSON.stringify({
    unix: socketPath,
    status: 'running',
    startedAt: Date.now(),
    metadata: { backend: backendType },
}));

console.log(`redisd listening on ${socketPath} (backend: ${backendType})`);
```

**HAL Redis StorageEngine:**

Services use this HAL storage engine to talk to `redisd`:

```typescript
// src/hal/storage-redis.ts
import type { StorageEngine } from './storage';

export class RedisStorageEngine implements StorageEngine {
    private socket: ReturnType<typeof Bun.connect> | null = null;
    private pending = new Map<number, { resolve: Function; reject: Function }>();
    private nextId = 0;
    private buffer = Buffer.alloc(0);

    constructor(private socketPath: string) {}

    async init(): Promise<void> {
        this.socket = await Bun.connect({
            unix: this.socketPath,
            socket: {
                data: (_, data) => this.handleData(data),
                error: (_, err) => console.error('Redis socket error:', err),
            },
        });
    }

    async shutdown(): Promise<void> {
        this.socket?.end();
        this.socket = null;
    }

    async get(key: string): Promise<Uint8Array | null> {
        const result = await this.command('GET', key);
        return result ? new Uint8Array(result) : null;
    }

    async set(key: string, value: Uint8Array): Promise<void> {
        await this.command('SET', key, Buffer.from(value));
    }

    async delete(key: string): Promise<boolean> {
        const result = await this.command('DEL', key);
        return result === 1;
    }

    async *list(prefix: string): AsyncIterable<string> {
        const keys = await this.command('KEYS', prefix + '*') as string[];
        for (const key of keys) yield key;
    }

    async has(key: string): Promise<boolean> {
        const result = await this.get(key);
        return result !== null;
    }

    private command(cmd: string, ...args: unknown[]): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });

            // Encode RESP array
            const parts = [cmd, ...args];
            let msg = `*${parts.length}\r\n`;
            for (const part of parts) {
                const str = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
                msg += `$${str.length}\r\n`;
                this.socket!.write(msg);
                this.socket!.write(str);
                this.socket!.write('\r\n');
                msg = '';
            }
            if (msg) this.socket!.write(msg);
        });
    }

    private handleData(data: Buffer): void {
        // Parse RESP response and resolve pending promise
        // (simplified - real impl needs proper streaming parser)
    }
}
```

**Service usage:**

```typescript
// Any service can now use Redis-backed HAL storage
const os = new OS({
    storage: {
        type: 'redis',
        unix: '/run/services/redisd.sock',
    },
});
```

Or use a Redis client directly for pub/sub:

```typescript
import { createClient } from 'redis';

const redis = createClient({ socket: { path: '/run/services/redisd.sock' } });
await redis.connect();

// Publish events
await redis.publish('user:created', JSON.stringify({ id: 123 }));

// Subscribe to events
await redis.subscribe('email:*', (message, channel) => {
    console.log(`${channel}: ${message}`);
});
```

### authd - Identity & Authentication

Authentication service that validates JWTs, manages users, and handles login flows. All services call authd via Unix socket to validate requests.

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  httpd OS   │  │  smtpd OS   │  │ displayd OS │
│             │  │             │  │             │
│ validate()  │  │ validate()  │  │ validate()  │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────┬───────┴────────┬───────┘
                │  { op, data }  │
                │  Unix socket   │
                ▼                ▼
       ┌─────────────────────────────────┐
       │           authd OS              │
       │  /run/services/authd.sock       │
       │                                 │
       │  Operations:                    │
       │  - validate  (JWT → user)       │
       │  - begin     (start login)      │
       │  - callback  (complete login)   │
       │  - refresh   (renew JWT)        │
       │  - revoke    (invalidate)       │
       │                                 │
       │  Storage:                       │
       │  - Users: /data/users/* (EMS)   │
       │  - Tokens: redisd (TTL)         │
       │  - Sessions: redisd (TTL)       │
       └─────────────────────────────────┘
```

**Why authd as a service:**

| Benefit | Description |
|---------|-------------|
| Centralized | One place for all auth logic |
| Swappable | Change auth provider without touching services |
| Isolated | Auth bugs don't crash other services |
| Cacheable | authd can cache validated JWTs in redisd |
| Auditable | Single point for auth logging |

**Service configuration:**

```json
{
    "services": {
        "authd": {
            "handler": "/bin/authd",
            "instances": 1,
            "restart": "always",
            "priority": 1,
            "depends": ["redisd"],
            "env": {
                "JWT_SECRET": "${JWT_SECRET}",
                "JWT_ISSUER": "monastery.local",
                "JWT_AUDIENCE": "monastery.local",
                "JWT_TTL": "3600",
                "MAGIC_LINK_TTL": "600"
            }
        }
    }
}
```

**authd operations:**

| Op | Input | Output | Description |
|----|-------|--------|-------------|
| `validate` | `{ jwt }` | `{ user, grants }` | Verify JWT, return identity |
| `begin` | `{ email, provider }` | `{ ok }` | Start login flow |
| `callback` | `{ token, provider }` | `{ jwt, user }` | Complete login, issue JWT |
| `refresh` | `{ jwt }` | `{ jwt }` | Issue new JWT |
| `revoke` | `{ jwt }` or `{ userId }` | `{ ok }` | Invalidate token/user |

**authd implementation:**

```typescript
// monastery/bin/authd.ts
import { OS } from '@monk-api/os';

interface User {
    id: string;
    email: string;
    tenant?: string;
    status: 'active' | 'suspended' | 'pending';
    displayName?: string;
}

interface Grant {
    path: string;
    ops: ('read' | 'write' | 'list' | 'delete' | '*')[];
}

interface JwtPayload {
    sub: string;        // user ID
    email: string;
    tenant?: string;
    iat: number;
    exp: number;
}

// JWT utilities
async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: JwtPayload = {
        ...payload,
        iat: now,
        exp: now + parseInt(process.env.JWT_TTL ?? '3600'),
    };

    // Use Bun's native crypto or jose library
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = btoa(JSON.stringify(fullPayload));
    const signature = await createHmacSignature(`${header}.${body}`);

    return `${header}.${body}.${signature}`;
}

async function verifyJwt(token: string): Promise<JwtPayload> {
    const [header, body, signature] = token.split('.');

    // Verify signature
    const expected = await createHmacSignature(`${header}.${body}`);
    if (signature !== expected) {
        throw new Error('Invalid signature');
    }

    const payload: JwtPayload = JSON.parse(atob(body));

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('Token expired');
    }

    return payload;
}

async function createHmacSignature(data: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(process.env.JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Service clients
class RedisClient {
    private conn: number | null = null;

    async get(key: string): Promise<string | null> { /* ... */ }
    async set(key: string, value: string, ttl?: number): Promise<void> { /* ... */ }
    async del(key: string): Promise<void> { /* ... */ }
}

class SmtpClient {
    async send(to: string, subject: string, body: string): Promise<void> { /* ... */ }
}

// Main
const os = new OS({
    storage: { type: 'postgres', url: process.env.MONK_POSTGRES! }
});

await os.boot();

const redis = new RedisClient('/run/services/redisd.sock');
const smtp = new SmtpClient('/run/services/smtpd.sock');
const socketPath = '/run/services/authd.sock';

// Operation handlers
async function handleValidate(data: { jwt: string }): Promise<{ user: User; grants: Grant[] }> {
    // 1. Check cache first
    const cached = await redis.get(`auth:validated:${data.jwt}`);
    if (cached) {
        return JSON.parse(cached);
    }

    // 2. Verify JWT
    const payload = await verifyJwt(data.jwt);

    // 3. Load user from EMS
    const userPath = `/data/users/${payload.sub}`;
    const userData = await os.fs.readFile(userPath, 'utf8');
    const user: User = JSON.parse(userData);

    if (user.status !== 'active') {
        throw new Error('User not active');
    }

    // 4. Load grants (from user or role)
    const grants = await loadGrants(user);

    // 5. Cache result
    const result = { user, grants };
    const ttl = payload.exp - Math.floor(Date.now() / 1000);
    await redis.set(`auth:validated:${data.jwt}`, JSON.stringify(result), ttl);

    return result;
}

async function handleBegin(data: { email: string; provider: string }): Promise<{ ok: true }> {
    if (data.provider !== 'magic-link') {
        throw new Error(`Unknown provider: ${data.provider}`);
    }

    // 1. Find or create user
    let user: User;
    try {
        const userData = await os.fs.readFile(`/data/users/by-email/${data.email}`, 'utf8');
        user = JSON.parse(userData);
    }
    catch {
        // Create pending user
        const id = crypto.randomUUID();
        user = {
            id,
            email: data.email,
            status: 'pending',
        };
        await os.fs.writeFile(`/data/users/${id}`, JSON.stringify(user));
    }

    // 2. Generate magic link token
    const token = crypto.randomUUID();
    const ttl = parseInt(process.env.MAGIC_LINK_TTL ?? '600');
    await redis.set(`auth:magic:${token}`, user.id, ttl);

    // 3. Send email via smtpd
    const baseUrl = process.env.BASE_URL ?? 'http://localhost:8080';
    await smtp.send(
        data.email,
        'Sign in to Monastery',
        `Click here to sign in: ${baseUrl}/auth/callback?token=${token}&provider=magic-link`
    );

    return { ok: true };
}

async function handleCallback(data: { token: string; provider: string }): Promise<{ jwt: string; user: User }> {
    if (data.provider !== 'magic-link') {
        throw new Error(`Unknown provider: ${data.provider}`);
    }

    // 1. Validate token
    const userId = await redis.get(`auth:magic:${data.token}`);
    if (!userId) {
        throw new Error('Invalid or expired token');
    }

    // 2. Consume token (one-time use)
    await redis.del(`auth:magic:${data.token}`);

    // 3. Load and activate user
    const userData = await os.fs.readFile(`/data/users/${userId}`, 'utf8');
    const user: User = JSON.parse(userData);

    if (user.status === 'pending') {
        user.status = 'active';
        await os.fs.writeFile(`/data/users/${userId}`, JSON.stringify(user));
    }

    // 4. Issue JWT
    const jwt = await signJwt({
        sub: user.id,
        email: user.email,
        tenant: user.tenant,
    });

    return { jwt, user };
}

async function handleRefresh(data: { jwt: string }): Promise<{ jwt: string }> {
    // Verify old token (even if expired, within grace period)
    const payload = await verifyJwt(data.jwt);

    // Issue new token
    const jwt = await signJwt({
        sub: payload.sub,
        email: payload.email,
        tenant: payload.tenant,
    });

    // Revoke old token
    await redis.set(`auth:revoked:${data.jwt}`, '1', 86400);

    return { jwt };
}

async function handleRevoke(data: { jwt?: string; userId?: string }): Promise<{ ok: true }> {
    if (data.jwt) {
        // Revoke single token
        await redis.set(`auth:revoked:${data.jwt}`, '1', 86400);
    }
    else if (data.userId) {
        // Revoke all tokens for user (increment user's token version)
        await redis.set(`auth:version:${data.userId}`, Date.now().toString());
    }

    return { ok: true };
}

async function loadGrants(user: User): Promise<Grant[]> {
    // Default grants based on user
    const grants: Grant[] = [
        // User can access their own home
        { path: `/home/${user.id}/**`, ops: ['*'] },
    ];

    // Tenant grants
    if (user.tenant) {
        grants.push({ path: `/data/tenants/${user.tenant}/**`, ops: ['read', 'write', 'list'] });
    }

    // Load role-based grants
    try {
        const rolesData = await os.fs.readFile(`/data/users/${user.id}/roles`, 'utf8');
        const roles: string[] = JSON.parse(rolesData);

        for (const role of roles) {
            const roleData = await os.fs.readFile(`/etc/roles/${role}.json`, 'utf8');
            const roleGrants: Grant[] = JSON.parse(roleData).grants;
            grants.push(...roleGrants);
        }
    }
    catch {
        // No roles defined
    }

    return grants;
}

// Socket server
Bun.listen({
    unix: socketPath,
    socket: {
        async data(socket, data) {
            const messages = parseMessages(data);

            for (const msg of messages) {
                let result: unknown;

                try {
                    switch (msg.op) {
                        case 'validate':
                            result = await handleValidate(msg.data);
                            break;
                        case 'begin':
                            result = await handleBegin(msg.data);
                            break;
                        case 'callback':
                            result = await handleCallback(msg.data);
                            break;
                        case 'refresh':
                            result = await handleRefresh(msg.data);
                            break;
                        case 'revoke':
                            result = await handleRevoke(msg.data);
                            break;
                        default:
                            throw new Error(`Unknown op: ${msg.op}`);
                    }

                    socket.write(encodeMessage({ op: 'ok', data: result }));
                }
                catch (err) {
                    socket.write(encodeMessage({
                        op: 'error',
                        data: { code: 'AUTH_ERROR', message: (err as Error).message }
                    }));
                }
            }
        },
    },
});

// Register
const instanceId = process.env.MONK_INSTANCE ?? 'authd-0';
await os.fs.mkdir('/sys/services/authd');
await os.fs.writeFile(`/sys/services/authd/${instanceId}`, JSON.stringify({
    unix: socketPath,
    status: 'running',
    startedAt: Date.now(),
}));

console.log(`authd listening on ${socketPath}`);
```

**Auth middleware for httpd:**

```typescript
// monastery/lib/auth.ts
import { ServiceClient } from './service-client';

const authd = new ServiceClient('authd');

export interface AuthContext {
    user: User;
    grants: Grant[];
}

export async function authenticate(req: Request): Promise<AuthContext | null> {
    // Extract JWT from header or cookie
    const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
              ?? getCookie(req, 'token');

    if (!jwt) return null;

    try {
        return await authd.call<AuthContext>('validate', { jwt });
    }
    catch {
        return null;
    }
}

export function requireAuth(handler: (req: Request, auth: AuthContext) => Promise<Response>) {
    return async (req: Request): Promise<Response> => {
        const auth = await authenticate(req);

        if (!auth) {
            return new Response('Unauthorized', { status: 401 });
        }

        return handler(req, auth);
    };
}

// Usage in httpd
const routes = {
    'GET /api/profile': requireAuth(async (req, auth) => {
        return Response.json(auth.user);
    }),

    'POST /auth/login': async (req) => {
        const { email } = await req.json();
        await authd.call('begin', { email, provider: 'magic-link' });
        return Response.json({ ok: true });
    },

    'GET /auth/callback': async (req) => {
        const url = new URL(req.url);
        const token = url.searchParams.get('token')!;
        const provider = url.searchParams.get('provider')!;

        const { jwt, user } = await authd.call<{ jwt: string; user: User }>(
            'callback',
            { token, provider }
        );

        return new Response(null, {
            status: 302,
            headers: {
                'Location': '/',
                'Set-Cookie': `token=${jwt}; HttpOnly; Secure; SameSite=Strict; Path=/`,
            },
        });
    },
};
```

**Boot order with authd:**

```
redisd  (priority 0)  ← token/session storage
authd   (priority 1)  ← depends on redisd
logd    (priority 1)  ← depends on redisd
smtpd   (priority 2)  ← authd calls for magic links
jsond   (priority 3)  ← external API gateway
httpd   (priority 3)  ← web server, auth callbacks
```

### jsond - External API Gateway

NDJSON-over-TCP API server that exposes VFS and services to external clients. Much lighter than HTTP - no headers, no framing, just newline-delimited JSON.

```
┌───────────────────────────────────────────────────────────────────┐
│                      External Clients                              │
│  displayd (browser)  │  CLI tools  │  remote services             │
└───────────────────────────────────────────────────────────────────┘
                              │
                         TCP :9000
                      NDJSON protocol
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                         jsond OS                                   │
│  TCP :9000 (external clients)                                     │
│  /run/services/jsond.sock (internal services)                     │
│                                                                    │
│  Operations:                                                       │
│  - auth      (validate JWT, get identity)                         │
│  - stat      (file metadata)                                      │
│  - list      (directory listing, streaming)                       │
│  - read      (file content)                                       │
│  - write     (create/update file)                                 │
│  - delete    (remove file)                                        │
│  - watch     (subscribe to changes, streaming)                    │
│  - call      (route to other services)                            │
└───────────────────────────────────────────────────────────────────┘
                              │
                       Unix sockets
                              │
        ┌─────────────┬───────┴───────┬─────────────┐
        ▼             ▼               ▼             ▼
   ┌─────────┐  ┌─────────┐    ┌─────────┐   ┌─────────┐
   │  authd  │  │ redisd  │    │  smtpd  │   │  ...    │
   └─────────┘  └─────────┘    └─────────┘   └─────────┘
```

**Why NDJSON instead of HTTP:**

| | HTTP | NDJSON |
|---|------|--------|
| Headers | ~500 bytes/request | 0 |
| Connection | New TCP per request (or keep-alive dance) | Persistent, multiplexed |
| Framing | Content-Length or chunked encoding | Just newlines |
| Streaming | Complex (SSE, chunked, WebSocket upgrade) | Send lines as they come |
| Parsing | Full HTTP parser | `JSON.parse()` per line |
| Bidirectional | Request/response only | Full duplex |
| Same format | Need to wrap in HTTP | Native `{ op, data }` messages |

**Protocol:**

```
Client → Server (newline-delimited):
{"op":"auth","data":{"jwt":"eyJ..."}}\n
{"op":"list","data":{"path":"/users"}}\n
{"op":"watch","data":{"path":"/data/jobs/*"}}\n

Server → Client (newline-delimited):
{"op":"ok","data":{"user":{"id":"...","email":"..."},"grants":[...]}}\n
{"op":"item","data":{"name":"user-1","model":"user","size":256}}\n
{"op":"item","data":{"name":"user-2","model":"user","size":128}}\n
{"op":"done"}\n
{"op":"event","data":{"type":"create","path":"/data/jobs/123"}}\n
```

**Service configuration:**

```json
{
    "services": {
        "jsond": {
            "handler": "/bin/jsond",
            "instances": 2,
            "restart": "always",
            "priority": 3,
            "depends": ["redisd", "authd"],
            "env": {
                "PORT": "9000",
                "JSOND_ROOT": "/data"
            }
        }
    }
}
```

**jsond implementation:**

```typescript
// monastery/bin/jsond.ts
import { OS } from '@monk-api/os';

interface Message {
    id?: string;        // Optional request ID for correlation
    op: string;
    data?: unknown;
}

interface Response {
    id?: string;        // Echo request ID if provided
    op: 'ok' | 'error' | 'item' | 'done' | 'event';
    data?: unknown;
}

// Service clients
const authd = new ServiceClient('authd');

// Connection state
interface Connection {
    socket: Socket;
    user?: User;
    grants?: Grant[];
    watches: Map<string, AsyncIterator<WatchEvent>>;
}

const os = new OS({
    storage: { type: 'postgres', url: process.env.MONK_POSTGRES! }
});

await os.boot();

const root = process.env.JSOND_ROOT ?? '/data';
const port = parseInt(process.env.PORT ?? '9000');

// TCP server for external clients
Bun.listen({
    port,
    socket: {
        open(socket) {
            socket.data = {
                socket,
                watches: new Map(),
                buffer: '',
            } as Connection & { buffer: string };
        },

        async data(socket, data) {
            const conn = socket.data as Connection & { buffer: string };
            conn.buffer += new TextDecoder().decode(data);

            // Process complete lines
            let newlineIdx: number;
            while ((newlineIdx = conn.buffer.indexOf('\n')) !== -1) {
                const line = conn.buffer.slice(0, newlineIdx).trim();
                conn.buffer = conn.buffer.slice(newlineIdx + 1);

                if (!line) continue;

                try {
                    const msg: Message = JSON.parse(line);
                    await handleMessage(conn, msg);
                }
                catch (err) {
                    send(socket, {
                        op: 'error',
                        data: { code: 'PARSE_ERROR', message: 'Invalid JSON' }
                    });
                }
            }
        },

        close(socket) {
            const conn = socket.data as Connection;
            // Clean up watches
            for (const iter of conn.watches.values()) {
                iter.return?.();
            }
        },
    },
});

// Also listen on Unix socket for internal services
Bun.listen({
    unix: '/run/services/jsond.sock',
    socket: {
        // Same handlers as TCP
    },
});

function send(socket: Socket, response: Response): void {
    socket.write(JSON.stringify(response) + '\n');
}

async function handleMessage(conn: Connection, msg: Message): Promise<void> {
    const { socket } = conn;
    const response = (r: Omit<Response, 'id'>) => send(socket, { ...r, id: msg.id });

    try {
        switch (msg.op) {
            // =================================================================
            // AUTH
            // =================================================================
            case 'auth': {
                const { jwt } = msg.data as { jwt: string };
                const result = await authd.call<{ user: User; grants: Grant[] }>('validate', { jwt });
                conn.user = result.user;
                conn.grants = result.grants;
                response({ op: 'ok', data: result });
                break;
            }

            // =================================================================
            // VFS OPERATIONS (require auth)
            // =================================================================
            case 'stat': {
                requireAuth(conn);
                const { path } = msg.data as { path: string };
                const fullPath = resolvePath(path, conn);
                const result = await os.fs.stat(fullPath);
                response({ op: 'ok', data: result });
                break;
            }

            case 'list': {
                requireAuth(conn);
                const { path } = msg.data as { path: string };
                const fullPath = resolvePath(path, conn);

                for await (const entry of os.fs.readdir(fullPath)) {
                    send(socket, { id: msg.id, op: 'item', data: entry });
                }
                response({ op: 'done' });
                break;
            }

            case 'read': {
                requireAuth(conn);
                const { path } = msg.data as { path: string };
                const fullPath = resolvePath(path, conn);

                const content = await os.fs.readFile(fullPath, 'utf8');

                // Try to parse as JSON
                try {
                    response({ op: 'ok', data: JSON.parse(content) });
                }
                catch {
                    response({ op: 'ok', data: content });
                }
                break;
            }

            case 'write': {
                requireAuth(conn);
                const { path, data } = msg.data as { path: string; data: unknown };
                const fullPath = resolvePath(path, conn);
                checkGrant(conn, fullPath, 'write');

                const content = typeof data === 'string' ? data : JSON.stringify(data);
                await os.fs.writeFile(fullPath, content);
                response({ op: 'ok' });
                break;
            }

            case 'delete': {
                requireAuth(conn);
                const { path } = msg.data as { path: string };
                const fullPath = resolvePath(path, conn);
                checkGrant(conn, fullPath, 'delete');

                await os.fs.unlink(fullPath);
                response({ op: 'ok' });
                break;
            }

            // =================================================================
            // WATCH (streaming)
            // =================================================================
            case 'watch': {
                requireAuth(conn);
                const { path, id: watchId } = msg.data as { path: string; id?: string };
                const fullPath = resolvePath(path, conn);

                const watcher = os.fs.watch(fullPath);
                const actualWatchId = watchId ?? crypto.randomUUID();
                conn.watches.set(actualWatchId, watcher);

                // Stream events until unwatch or disconnect
                (async () => {
                    try {
                        for await (const event of watcher) {
                            send(socket, {
                                id: actualWatchId,
                                op: 'event',
                                data: event
                            });
                        }
                    }
                    catch {
                        // Watch ended
                    }
                })();

                response({ op: 'ok', data: { watchId: actualWatchId } });
                break;
            }

            case 'unwatch': {
                const { id: watchId } = msg.data as { id: string };
                const watcher = conn.watches.get(watchId);
                if (watcher) {
                    watcher.return?.();
                    conn.watches.delete(watchId);
                }
                response({ op: 'ok' });
                break;
            }

            // =================================================================
            // SERVICE ROUTING
            // =================================================================
            case 'call': {
                requireAuth(conn);
                const { service, op, data } = msg.data as {
                    service: string;
                    op: string;
                    data?: unknown;
                };

                // Route to internal service via Unix socket
                const client = new ServiceClient(service);
                const result = await client.call(op, data);
                response({ op: 'ok', data: result });
                break;
            }

            // =================================================================
            // UTILITY
            // =================================================================
            case 'ping': {
                response({ op: 'ok', data: { pong: Date.now() } });
                break;
            }

            default:
                response({
                    op: 'error',
                    data: { code: 'UNKNOWN_OP', message: `Unknown operation: ${msg.op}` }
                });
        }
    }
    catch (err) {
        const error = err as Error;
        response({
            op: 'error',
            data: {
                code: error.name === 'AuthError' ? 'UNAUTHORIZED' : 'ERROR',
                message: error.message
            }
        });
    }
}

function requireAuth(conn: Connection): void {
    if (!conn.user) {
        const err = new Error('Not authenticated');
        err.name = 'AuthError';
        throw err;
    }
}

function resolvePath(path: string, conn: Connection): string {
    // Prevent path traversal
    if (path.includes('..')) {
        throw new Error('Path traversal not allowed');
    }

    // Resolve relative to root
    const fullPath = root + (path.startsWith('/') ? path : '/' + path);

    // Check read grant
    checkGrant(conn, fullPath, 'read');

    return fullPath;
}

function checkGrant(conn: Connection, path: string, op: string): void {
    if (!conn.grants) return;

    const hasGrant = conn.grants.some(grant => {
        // Check path match (supports ** glob)
        const pattern = grant.path.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
        const regex = new RegExp(`^${pattern}$`);
        if (!regex.test(path)) return false;

        // Check op
        return grant.ops.includes('*') || grant.ops.includes(op as any);
    });

    if (!hasGrant) {
        throw new Error(`Permission denied: ${op} on ${path}`);
    }
}

// Register
const instanceId = process.env.MONK_INSTANCE ?? 'jsond-0';
await os.fs.mkdir('/sys/services/jsond');
await os.fs.writeFile(`/sys/services/jsond/${instanceId}`, JSON.stringify({
    unix: '/run/services/jsond.sock',
    host: 'localhost',
    port,
    status: 'running',
    startedAt: Date.now(),
}));

console.log(`jsond listening on :${port} and /run/services/jsond.sock (root: ${root})`);
```

**Client usage (displayd / browser):**

```typescript
// Simple NDJSON client
class JsondClient {
    private socket: WebSocket | TCPSocket;
    private pending = new Map<string, { resolve: Function; reject: Function }>();
    private buffer = '';

    constructor(url: string) {
        // Could be WebSocket (browser) or TCP (Node/Bun)
        this.connect(url);
    }

    private connect(url: string) {
        // For browser, use WebSocket with a bridge
        // For Bun/Node, use TCP directly
    }

    async auth(jwt: string): Promise<{ user: User; grants: Grant[] }> {
        return this.call('auth', { jwt });
    }

    async stat(path: string): Promise<Stat> {
        return this.call('stat', { path });
    }

    async list(path: string): Promise<Entry[]> {
        return this.collect('list', { path });
    }

    async read<T = unknown>(path: string): Promise<T> {
        return this.call('read', { path });
    }

    async write(path: string, data: unknown): Promise<void> {
        await this.call('write', { path, data });
    }

    watch(path: string, callback: (event: WatchEvent) => void): () => void {
        const id = crypto.randomUUID();
        this.send({ id, op: 'watch', data: { path, id } });

        // Register callback for events with this ID
        this.eventHandlers.set(id, callback);

        // Return unsubscribe function
        return () => {
            this.send({ op: 'unwatch', data: { id } });
            this.eventHandlers.delete(id);
        };
    }

    private async call<T>(op: string, data?: unknown): Promise<T> {
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send({ id, op, data });
        });
    }

    private async collect<T>(op: string, data?: unknown): Promise<T[]> {
        const id = crypto.randomUUID();
        const items: T[] = [];

        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: (response: Response) => {
                    if (response.op === 'item') {
                        items.push(response.data as T);
                    }
                    else if (response.op === 'done') {
                        resolve(items);
                    }
                },
                reject,
            });
            this.send({ id, op, data });
        });
    }
}

// Usage
const client = new JsondClient('localhost:9000');
await client.auth(jwt);

const users = await client.list('/users');
const user = await client.read('/users/123');

const unwatch = client.watch('/data/jobs/*', (event) => {
    console.log('Job changed:', event);
});
```

**WebSocket bridge for browsers:**

Since browsers can't do raw TCP, jsond can also accept WebSocket connections that bridge to the same NDJSON protocol:

```typescript
// In jsond, add WebSocket support
Bun.serve({
    port: 9001,  // WebSocket port
    fetch(req, server) {
        if (server.upgrade(req)) {
            return;
        }
        return new Response('WebSocket only', { status: 400 });
    },
    websocket: {
        message(ws, message) {
            // Same handleMessage() as TCP, but over WebSocket
            const msg = JSON.parse(message as string);
            handleMessage(ws.data, msg);
        },
        // ...
    },
});
```

---

## Example Services

### httpd

```typescript
// monastery/bin/httpd.ts
import { OS } from '@monk-api/os';

const os = new OS({
    storage: {
        type: 'postgres',
        url: process.env.MONK_POSTGRES!,
    },
})
.on('vfs', (os) => {
    os.fs.mountEntity('/data');
    os.fs.mountHost('/vol/shared', process.env.MONK_SHARED!);
})
.on('boot', async (os) => {
    const port = parseInt(process.env.PORT ?? '8080');

    Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === '/health') {
                return new Response('ok');
            }

            if (url.pathname.startsWith('/files/')) {
                const path = '/vol/shared' + url.pathname.slice(6);
                const data = await os.fs.readFile(path);
                return new Response(data);
            }

            // ... routes
        },
    });

    console.log(`httpd listening on :${port}`);
});

await os.boot();
```

### logd

```typescript
// monastery/bin/logd.ts
import { OS } from '@monk-api/os';

const os = new OS({
    storage: {
        type: 'postgres',
        url: process.env.MONK_POSTGRES!,
    },
})
.on('boot', async (os) => {
    const port = parseInt(process.env.PORT ?? '9000');

    // HTTP endpoint for log ingestion
    Bun.serve({
        port,
        async fetch(req) {
            if (req.method === 'POST' && req.url.endsWith('/log')) {
                const entry = await req.json();
                await appendLog(entry);
                return new Response('ok');
            }
            return new Response('not found', { status: 404 });
        },
    });

    // Also listen on PostgreSQL NOTIFY for log events
    const sql = os.fs.getDatabase();
    await sql`LISTEN log`;

    for await (const notification of sql.notifications()) {
        await appendLog(JSON.parse(notification.payload));
    }
});

async function appendLog(entry: any) {
    const line = JSON.stringify({
        ...entry,
        timestamp: new Date().toISOString(),
    });

    // Append to log file
    await Bun.write(
        Bun.file('/vol/shared/logs/system.log'),
        line + '\n',
        { append: true }
    );
}

await os.boot();
```

---

## Deployment

### Development

```bash
# Start monastery in dev mode
bun run monastery/src/main.ts
```

### Production (Single Binary per Service)

```bash
# Build each service as standalone binary
bun build --compile monastery/bin/httpd.ts --outfile dist/httpd
bun build --compile monastery/bin/smtpd.ts --outfile dist/smtpd
bun build --compile monastery/bin/logd.ts --outfile dist/logd

# Build the abbot
bun build --compile monastery/src/main.ts --outfile dist/monastery

# Run
./dist/monastery
```

### Docker

```dockerfile
# Dockerfile.httpd
FROM oven/bun:1
COPY dist/httpd /app/httpd
CMD ["/app/httpd"]
```

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data

  httpd:
    build:
      context: .
      dockerfile: Dockerfile.httpd
    environment:
      MONK_POSTGRES: postgres://postgres@postgres:5432/monastery
      PORT: 8080
    depends_on:
      - postgres

  # ... other services
```

---

## Migration Path

### Phase 1: Extract Monastery Structure

1. Create `@monk-api/monastery` repo
2. Move service daemons from `os/rom/bin/` to `monastery/bin/`
3. Keep core OS utilities (cat, ls, shell) in `os/rom/bin/`

### Phase 2: Implement ServiceManager

1. Build ServiceManager with Bun.spawn
2. Test with single service (logd)
3. Add health monitoring

### Phase 3: Shared Storage

1. Configure shared PostgreSQL
2. Implement EntityMount for `/data`
3. Test cross-service data access

### Phase 4: Production Hardening

1. Add metrics/observability
2. Implement graceful rolling restarts
3. Add resource limits
4. Production deployment configs

---

## Open Questions

1. **Service mesh?** Do we need Envoy/Linkerd for service-to-service communication, or is direct HTTP + PG sufficient?

2. **Secrets management?** How do services get database credentials securely?

3. **Configuration hot-reload?** Can we update service config without full restart?

4. **Multi-node?** How does this extend to multiple physical hosts? (Probably: external load balancer + shared PG)

5. **Logging aggregation?** Should logd be a central service, or should each service write to shared filesystem?

---

## Summary

The Monastery architecture provides:

- **Isolation**: Each service is a full OS instance with own workers
- **Simplicity**: Services don't know they're orchestrated - just an OS with a main
- **Shared state**: PostgreSQL EMS + host mounts for cross-service data
- **Reliability**: Health monitoring, automatic restarts, dependency ordering
- **Scalability**: Run N instances of any service
- **Deployment flexibility**: Dev mode, single binaries, or containers
