# JSON Daemon (jsond)

JSONL-over-TCP/WebSocket API server for Monk OS.

## Philosophy

HTTP has accumulated ceremony that modern JSON APIs don't need:
- **Methods** (GET/POST/etc) - often just POST everywhere, or a thin REST veneer
- **Status codes** - reduced to "worked" (200), "your fault" (4xx), "my fault" (5xx)
- **Content negotiation** - always `application/json`
- **Headers** - mostly just Authorization

What remains useful: TLS, compression, routing, auth, streaming.

**jsond** strips HTTP down to the essentials:
- TCP socket speaks JSONL (newline-delimited JSON)
- Each line is a `Message` with an `op` and optional `data`
- Responses stream back as `Response` objects
- Persistent connections with connection-scoped auth
- WebSocket transport for browsers

---

## Wire Protocol

### Message Format

Uses the universal `Message` / `Response` types from `@src/message`:

```typescript
// Client → Server
interface Message {
    op: string;      // Operation name (e.g., "auth:login", "data:list")
    data?: unknown;  // Operation-specific payload
}

// Server → Client
interface Response {
    op: 'ok' | 'error' | 'item' | 'chunk' | 'event' | 'progress' | 'done' | 'redirect';
    data?: unknown;
}
```

### Transport

- **Framing**: NDJSON (newline-delimited) - one JSON object per line
- **TCP**: Raw TCP socket, suitable for server-to-server, CLI tools
- **WebSocket**: For browsers (same JSONL protocol over WS frames)

### Example Session

```
# Client authenticates
→ {"op":"auth:login","data":{"tenant":"acme","username":"ian","password":"..."}}
← {"op":"ok","data":{"token":"eyJ...","user":{"id":"...","tenant":"acme"}}}

# Client queries data (streaming response)
→ {"op":"data:list","data":{"model":"orders","filter":{"status":"pending"}}}
← {"op":"item","data":{"id":"1","status":"pending",...}}
← {"op":"item","data":{"id":"2","status":"pending",...}}
← {"op":"done"}

# Single-record fetch
→ {"op":"data:get","data":{"model":"orders","id":"123"}}
← {"op":"ok","data":{"id":"123","status":"shipped",...}}

# Error response
→ {"op":"data:get","data":{"model":"orders","id":"999"}}
← {"op":"error","data":{"code":"NOT_FOUND","message":"Order 999 not found"}}
```

---

## Authentication

Connection-scoped auth via first message:

1. Client sends `auth:login` with credentials
2. Server validates, sets `conn.user`
3. All subsequent messages on that connection are authenticated
4. No per-message tokens needed (connection is the auth context)

```
→ {"op":"auth:login","data":{"tenant":"acme","username":"ian","token":"eyJ..."}}
← {"op":"ok","data":{"user":{"id":"...","tenant":"acme"}}}

# Connection is now authenticated - no token needed
→ {"op":"data:list","data":{"model":"orders"}}
← ...
```

For token refresh, client can send another `auth:login` before expiry.

---

## Architecture

### Hybrid Routing

File-system based routing with explicit overrides:

```typescript
const api = createApi();

// Auto-load handlers from directory structure
await api.scan('/usr/api/ops');

// Apply middleware by pattern
api.use('*', requestLogger);
api.use('auth:*', rateLimit(10));
api.use('data:*', requireAuth, withTenant);

// Explicit overrides
api.op('health').handler(async function* () {
    yield respond.ok({ status: 'up' });
});

await api.listen({ tcp: 9000, ws: 9001 });
```

### File-System Routing

Directory structure defines op names:

```
/usr/api/ops/
├── auth/
│   ├── login.ts        → auth:login
│   └── refresh.ts      → auth:refresh
├── data/
│   ├── list.ts         → data:list
│   ├── get.ts          → data:get
│   ├── create.ts       → data:create
│   └── update.ts       → data:update
└── describe/
    └── model.ts        → describe:model
```

### Handler Signature

Handlers are async generators that yield `Response` objects:

```typescript
// /usr/api/ops/data/list.ts
import { respond } from '@usr/lib/api';
import type { OpContext } from '@usr/lib/api';

export default async function* ({ conn, msg, system }: OpContext) {
    const { model, filter } = msg.data;

    // Check auth
    if (!conn.user) {
        yield respond.error('UNAUTHORIZED', 'Authentication required');
        return;
    }

    // Stream results
    for await (const record of system.database.streamAny(model, filter)) {
        yield respond.item(record);
    }
    yield respond.done();
}
```

### Middleware

Middleware wraps handlers with cross-cutting concerns:

```typescript
type Middleware = (
    ctx: OpContext,
    next: () => AsyncIterable<Response>
) => AsyncIterable<Response>;

// Auth middleware
const requireAuth: Middleware = async function* (ctx, next) {
    if (!ctx.conn.user) {
        yield respond.error('UNAUTHORIZED', 'Authentication required');
        return;
    }
    yield* next();
};

// Tenant middleware (sets up system context)
const withTenant: Middleware = async function* (ctx, next) {
    const system = await createSystem(ctx.conn.user.tenant);
    try {
        ctx.system = system;
        yield* next();
    } finally {
        await system.close();
    }
};
```

---

## Directory Structure

```
usr/
├── api/
│   └── ops/                    # Op handlers (auto-scanned)
│       ├── auth/
│       │   └── login.ts        → auth:login
│       └── data/
│           ├── get.ts          → data:get
│           └── list.ts         → data:list
├── lib/
│   └── api/                    # API framework library
│       ├── index.ts            # Barrel export
│       ├── types.ts            # Core types
│       ├── router.ts           # Op pattern matching
│       └── server.ts           # createApi() builder
└── sbin/
    └── jsond.ts                # JSON daemon

rom/
└── etc/
    └── services/
        └── jsond.json          # Service definition (boot-activated)
```

---

## Types

### Connection

```typescript
interface Connection {
    id: string;                          // Unique connection ID
    user?: User;                         // Set by auth handler
    send(response: Response): Promise<void>;
    close(): Promise<void>;
    meta: Record<string, unknown>;       // Arbitrary metadata
}

interface User {
    id: string;
    tenant: string;
    [key: string]: unknown;
}
```

### OpContext

```typescript
interface OpContext {
    conn: Connection;                    // The connection
    msg: Message;                        // Current message
    params: Record<string, string>;      // From op pattern wildcards
    system?: unknown;                    // Set by tenant middleware
    [key: string]: unknown;              // Middleware can add fields
}
```

### OpHandler

```typescript
type OpHandler = (ctx: OpContext) => AsyncIterable<Response>;
```

---

## Response Types

From `@src/message`:

| Op | Purpose | Example |
|----|---------|---------|
| `ok` | Success with optional data | `{ op: 'ok', data: { id: '123' } }` |
| `error` | Error with code and message | `{ op: 'error', data: { code: 'NOT_FOUND', message: '...' } }` |
| `item` | Single item in a stream | `{ op: 'item', data: { ... } }` |
| `chunk` | Binary chunk (base64) | `{ op: 'chunk', data: 'base64...' }` |
| `event` | Push event | `{ op: 'event', data: { type: 'created', ... } }` |
| `progress` | Progress update | `{ op: 'progress', data: { percent: 50 } }` |
| `done` | Stream complete | `{ op: 'done' }` |
| `redirect` | Redirect to another location | `{ op: 'redirect', data: { location: '...' } }` |

---

## Comparison to HTTP

| HTTP/REST | jsond |
|-----------|-------|
| `GET /api/data/:model` | `{ op: "data:list", data: { model } }` |
| `GET /api/data/:model/:id` | `{ op: "data:get", data: { model, id } }` |
| `POST /api/data/:model` | `{ op: "data:create", data: { model, ... } }` |
| Route params (`:model`) | Fields in `msg.data` |
| Headers (Authorization) | First `auth:login` message |
| Status codes (404, 401) | `respond.error(code, msg)` |
| JSON response body | Streaming `Response` objects |
| Request-response cycle | Persistent connection, many ops |

---

## Configuration

Environment variables for jsond:

| Variable | Default | Description |
|----------|---------|-------------|
| `JSOND_TCP_PORT` | 9000 | TCP listen port |
| `JSOND_WS_PORT` | 9001 | WebSocket listen port |
| `JSOND_HOST` | 0.0.0.0 | Bind address |
| `JSOND_OPS_DIR` | /usr/api/ops | Handler directory |

---

## Service Definition

```json
{
  "handler": "/usr/sbin/jsond",
  "activate": {
    "type": "boot"
  },
  "description": "JSON daemon (JSONL-over-TCP/WebSocket API server)"
}
```

---

## Static Assets

For browsers, a minimal `httpd` serves static files:
- HTML shell
- CSS
- JavaScript bundle (including jsond client library)
- Images, fonts

Browser loads the page via HTTP, then opens a jsond WebSocket connection for all API calls.

---

## Future Work

- [ ] JWT validation in auth handler
- [ ] Rate limiting middleware
- [ ] Request logging middleware
- [ ] Tenant/system context middleware
- [ ] Browser client library
- [ ] TLS support
- [ ] Connection keepalive/ping
- [ ] Op metrics/tracing
