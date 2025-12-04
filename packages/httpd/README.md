# @monk-api/httpd

HTTP server service for Monk OS.

## Installation

```typescript
import { OS } from '@monk-api/os';

const os = new OS();
os.install('@monk-api/httpd');
await os.boot();
```

## Usage

### Basic

```typescript
// Start with OS environment defaults
await os.service.start('httpd');
```

### With explicit config

```typescript
await os.service.start('httpd', {
    port: 3000,
    hostname: '0.0.0.0',
});
```

### Serve files from VFS

```typescript
// Mount a host directory into VFS
os.on('vfs', (os) => {
    os.fs.mount('./public', '/var/www');
});

await os.boot();

// Start httpd serving from VFS path
await os.service.start('httpd', { root: '/var/www' });
```

Files are served from VFS, which can be:
- Host filesystem mounts (`os.fs.mount()`)
- Entity files stored in VFS (SQLite/PostgreSQL)
- Mix of both

### With custom request handler

```typescript
await os.service.start('httpd', {
    port: 8080,
    onRequest: (req) => {
        return new Response('Hello from Monk OS');
    },
});
```

## Configuration

### Priority

1. Explicit config passed to `os.service.start()`
2. OS environment variables
3. Service defaults (8080, localhost)

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `HTTPD_HOSTNAME` | Bind hostname | `localhost` |

```typescript
const os = new OS({
    env: {
        PORT: '3000',
        HTTPD_HOSTNAME: '0.0.0.0',
    },
});
```

### Config Options

| Option | Type | Description |
|--------|------|-------------|
| `port` | `number` | Server port |
| `hostname` | `string` | Bind hostname |
| `root` | `string` | VFS path to serve files from |
| `onRequest` | `(req: Request) => Response` | Custom request handler |

## Default Endpoints

| Path | Description |
|------|-------------|
| `GET /` | Service info |
| `GET /health` | Health check (returns JSON) |

## Stopping

```typescript
await os.service.stop('httpd');
```

## Service Definition

Located at `etc/services/httpd.json`:

```json
{
    "name": "httpd",
    "handler": "/usr/httpd/sbin/httpd.ts",
    "host": true,
    "activate": { "type": "manual" },
    "defaults": {
        "port": 8080,
        "hostname": "localhost"
    }
}
```

The `host: true` flag indicates this runs directly on Bun (not as a kernel Worker process).
