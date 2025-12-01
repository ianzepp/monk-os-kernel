# Channels

Protocol-aware bidirectional message exchange over persistent connections.

## Overview

Channels are the third I/O primitive in Monk OS, alongside file descriptors (Resources) and Ports. They provide a message-based interface for protocol-aware communication where:

- The underlying transport is a stream (TCP, HTTP, WebSocket)
- The application-level communication is message-based
- The HAL handles all protocol framing and boundaries
- Both request/response and streaming patterns are supported

## Philosophy

Monk OS has three I/O primitives:

| Primitive | Model | Addressing | Operations | Examples |
|-----------|-------|------------|------------|----------|
| **fd** (Resource) | Byte stream | Connected | `read()`, `write()` | TCP socket, file, pipe |
| **portId** (Port) | Message queue | Many sources | `port_recv()`, `port_send()` | UDP, listener, watch, pubsub |
| **channelId** (Channel) | Request/Response | 1:1 persistent | `channel_call()`, `channel_stream()` | HTTP, PostgreSQL, WebSocket |

Channels fill the gap between raw sockets and message queues: they maintain a persistent connection with protocol-level message framing, supporting both synchronous request/response and asynchronous streaming.

## Problem Statement

Bun provides high-level database adapters (PostgreSQL, MySQL) and HTTP clients that handle protocol details internally. We want userspace to access these without:

1. Exposing Bun's interfaces directly (breaks HAL abstraction)
2. Implementing wire protocols in userspace (PostgreSQL, HTTP/2, etc.)
3. Managing connection pooling and keep-alive manually

The Channel abstraction lets userspace do:

```typescript
const db = await channel.open('postgres', 'postgresql://localhost/mydb');
const rows = await channel.call(db, { op: 'query', data: { sql: 'SELECT 1' } });
```

While the HAL handles all protocol details via Bun's native adapters.

## Message Format

Channels use the same `Message`/`Response` format as VFS Models, providing a unified message-passing paradigm across the entire OS.

### Message (Request)

```typescript
interface Message {
    /** Operation to perform */
    op: string;
    /** Operation-specific data */
    data?: unknown;
}
```

### Response

```typescript
interface Response {
    /** Response type */
    op: 'ok' | 'error' | 'item' | 'chunk' | 'event' | 'progress' | 'done';
    /** Response data */
    data?: unknown;
}
```

### Response Types

| Type | Meaning | Usage |
|------|---------|-------|
| `ok` | Success with optional result | Single-value responses |
| `error` | Failure with code and message | Any operation failure |
| `item` | One item in a stream | Streaming rows, objects |
| `chunk` | Binary data chunk | File transfers, large payloads |
| `event` | Pushed event notification | Server-sent events, LISTEN/NOTIFY |
| `progress` | Progress update | Long operations |
| `done` | Stream complete | End of streaming response |
| `redirect` | Resource is over there | HTTP 301, database sharding, symlink | 

### Core Types Location

The `Message`/`Response` types are defined in `src/message.ts` as the universal message format for Monk OS:

- **VFS Models**: `model.handle(ctx, id, msg)` → `AsyncIterable<Response>`
- **Channels**: `channel.handle(ch, msg)` → `AsyncIterable<Response>`
- **Future**: IPC, RPC, inter-process messaging

VFS-specific typed messages (e.g., `Messages.Open`, `Messages.Read`) remain in `src/vfs/message.ts` and extend the core types.

This unification means: **Everything is a message. Files respond to messages. Channels respond to messages.**

## Syscalls

### Naming Convention

Internal syscall names use `channel_` prefix for namespacing:

| Syscall | Direction | Purpose | Status |
|---------|-----------|---------|--------|
| `channel_open` | Client | Connect to remote service | Implemented |
| `channel_accept` | Server | Wrap accepted socket with protocol | Not implemented |
| `channel_call` | Client | Request → single Response | Implemented |
| `channel_stream` | Client | Request → streaming Response | Implemented |
| `channel_push` | Server | Push event to client | Implemented |
| `channel_recv` | Server | Receive from client (bidirectional) | Implemented |
| `channel_close` | Both | Close channel | Implemented |

### Syscall Signatures

```typescript
// Connect to a remote service (client-side)
channel_open(proto: string, url: string, opts?: ChannelOpts): Promise<number>

// Wrap accepted socket with protocol (server-side) - NOT YET IMPLEMENTED
// channel_accept(socketFd: number, proto: string, opts?: ChannelOpts): Promise<number>

// Send request, receive single response (waits for ok/error)
channel_call(ch: number, msg: Message): Promise<Response>

// Send request, iterate responses until 'done'
channel_stream(ch: number, msg: Message): AsyncIterable<Response>

// Push response to remote (server-side)
channel_push(ch: number, response: Response): Promise<void>

// Receive message from client (bidirectional protocols)
channel_recv(ch: number): Promise<Message>

// Close channel
channel_close(ch: number): Promise<void>
```

### Userspace API

```typescript
// src/process/channel.ts
export const channel = {
    async open(proto: string, url: string, opts?: ChannelOpts): Promise<number> {
        return withTypedErrors(syscall('channel_open', proto, url, opts));
    },

    // Note: accept() not yet implemented - requires HTTP server integration

    async call<T = unknown>(ch: number, msg: Message): Promise<Response & { data?: T }> {
        return withTypedErrors(syscall('channel_call', ch, msg));
    },

    async *stream(ch: number, msg: Message): AsyncIterable<Response> {
        // Note: Requires kernel support for streaming syscalls
        const result = await withTypedErrors(syscall('channel_stream', ch, msg));
        if (Array.isArray(result)) {
            for (const response of result) {
                yield response;
            }
        }
    },

    async push(ch: number, response: Response): Promise<void> {
        return withTypedErrors(syscall('channel_push', ch, response));
    },

    async recv(ch: number): Promise<Message> {
        return withTypedErrors(syscall('channel_recv', ch));
    },

    async close(ch: number): Promise<void> {
        return withTypedErrors(syscall('channel_close', ch));
    },
};

// Helper functions
export function httpRequest(request: HttpRequest): Message {
    return { op: 'request', data: request };
}

export function sqlQuery(sql: string, params?: unknown[], cursor?: boolean): Message {
    return { op: 'query', data: { sql, params, cursor } };
}

export function sqlExecute(sql: string): Message {
    return { op: 'execute', data: { sql } };
}
```

## Protocol Types

### Supported Protocols

| Protocol | Client Ops | Server Ops | Transport | Bun Primitive | Status |
|----------|------------|------------|-----------|---------------|--------|
| `http` / `https` | `call`, `stream` | — | fetch | `fetch()` | Implemented |
| `websocket` / `ws` / `wss` | `call`, `stream`, `push`, `recv` | — | WebSocket | `new WebSocket()` | Implemented |
| `sse` | — | `push` | EventSource | Socket write | Implemented |
| `postgres` / `postgresql` | `call`, `stream` | — | pg wire | `Bun.sql()` | Placeholder |
| `mysql` | `call`, `stream` | — | mysql wire | `Bun.sql()` | Future |
| `redis` | `call`, `stream` | — | RESP | — | Future |
| `jsonrpc` | `call` | `push` | varies | — | Future |

### Protocol-Specific Message Ops

#### HTTP

```typescript
// Request
{ op: 'request', data: { method: 'GET', path: '/api/users', query?: {...}, headers?: {...}, body?: {...} } }

// Responses
{ op: 'ok', data: { users: [...] } }           // JSON response
{ op: 'item', data: { id: 1, name: '...' } }   // JSONL streaming
{ op: 'done' }                                  // End of stream
```

#### PostgreSQL

```typescript
// Query (returns all rows)
{ op: 'query', data: { sql: 'SELECT * FROM users', params?: [...] } }
// Response: { op: 'ok', data: [rows...] }

// Query with cursor (streams rows)
{ op: 'query', data: { sql: 'SELECT * FROM users', cursor: true } }
// Response: { op: 'item', data: row }, ..., { op: 'done' }

// Execute (DDL, no results)
{ op: 'execute', data: { sql: 'CREATE TABLE ...' } }
// Response: { op: 'ok' }

// Listen for notifications
{ op: 'listen', data: { channel: 'events' } }
// Response: { op: 'event', data: { channel: 'events', payload: '...' } }, ...
```

#### SSE (Server-Sent Events)

```typescript
// Client subscribes
{ op: 'subscribe', data: { topics?: ['fs.*'] } }

// Server pushes events
{ op: 'event', data: { type: 'fs.changed', path: '/home/bob/...' } }
```

## Usage Examples

### HTTP API Client

```typescript
// /usr/apps/crm-manager/sync.ts
import { channel } from 'monk:process';

async function syncCRM() {
    // Open persistent channel to API
    const api = await channel.open('http', 'https://crm.company.com/api', {
        headers: { 'Authorization': `Bearer ${env.CRM_TOKEN}` },
        keepAlive: true,
        timeout: 30000
    });

    try {
        // Single request/response
        const accounts = await channel.call(api, {
            op: 'request',
            data: { method: 'GET', path: '/data/accounts' }
        });
        // accounts = { op: 'ok', data: { accounts: [...] } }

        // Filtered query
        const contacts = await channel.call(api, {
            op: 'request',
            data: {
                method: 'GET',
                path: '/data/contacts',
                query: { where: 'account_id = 123', limit: 50 }
            }
        });

        // Streaming large dataset
        const stream = channel.stream(api, {
            op: 'request',
            data: {
                method: 'GET',
                path: '/data/contacts',
                query: { where: 'updated > 2024-01-01' },
                accept: 'application/jsonl'
            }
        });

        for await (const response of stream) {
            if (response.op === 'item') {
                await processContact(response.data);
            }
        }

    } finally {
        await channel.close(api);
    }
}
```

### Database Operations

```typescript
// /usr/apps/reporting/generate.ts
import { channel } from 'monk:process';

async function generateReport() {
    const db = await channel.open('postgres', 'postgresql://localhost/analytics');

    try {
        // Simple query
        const summary = await channel.call(db, {
            op: 'query',
            data: { sql: 'SELECT COUNT(*) as total FROM events' }
        });
        // summary = { op: 'ok', data: [{ total: 12345 }] }

        // Parameterized query
        const userEvents = await channel.call(db, {
            op: 'query',
            data: {
                sql: 'SELECT * FROM events WHERE user_id = $1',
                params: [userId]
            }
        });

        // Stream large result set
        const allEvents = channel.stream(db, {
            op: 'query',
            data: {
                sql: 'SELECT * FROM events ORDER BY created_at',
                cursor: true
            }
        });

        for await (const response of allEvents) {
            if (response.op === 'item') {
                await writeToReport(response.data);
            }
        }

    } finally {
        await channel.close(db);
    }
}
```

### Server-Side Event Push (Desktop File Manager)

```typescript
// /bin/desktop.ts
import { channel, port } from 'monk:process';

// Called when browser connects to GET /events/workspace
async function handleEventStream(socketFd: number, userId: string) {
    // Wrap accepted socket as SSE channel (server-side)
    const push = await channel.accept(socketFd, 'sse');

    // Subscribe to VFS changes for user's workspace
    const watch = await port.open('watch', {
        pattern: `/home/${userId}/workspace/**`
    });

    // Send initial "connected" event
    await channel.push(push, {
        op: 'event',
        data: { type: 'connected', userId }
    });

    try {
        // Bridge: VFS watch events → SSE push to browser
        for await (const event of port.iterate(watch)) {
            await channel.push(push, {
                op: 'event',
                data: {
                    type: 'fs.changed',
                    path: event.from,
                    op: event.meta.op,
                    entity: event.meta.entity
                }
            });
        }
    } catch (err) {
        // Client disconnected
    } finally {
        await channel.close(push);
        await port.close(watch);
    }
}
```

### Browser Client (for completeness)

```javascript
// Desktop app running in browser
const events = new EventSource('/events/workspace');

events.onmessage = async (e) => {
    const event = JSON.parse(e.data);

    if (event.type === 'fs.changed') {
        // Refresh file listing via separate API call
        const response = await fetch(`/api/files${event.path}`);
        const { files } = await response.json();
        renderFileList(files);
    }
};
```

### Bidirectional WebSocket

```typescript
// /bin/chat-server.ts
import { channel } from 'monk:process';

async function handleWebSocket(socketFd: number, userId: string) {
    const ws = await channel.accept(socketFd, 'websocket');

    try {
        // Bidirectional: receive from client, push to client
        while (true) {
            const msg = await channel.recv(ws);

            if (msg.op === 'send-message') {
                // Broadcast to other users (via pubsub)
                await broadcastMessage(msg.data);
            } else if (msg.op === 'typing') {
                await broadcastTyping(userId);
            }
        }
    } catch (err) {
        // Client disconnected
    } finally {
        await channel.close(ws);
    }
}

// Pushing to connected client
async function notifyUser(ws: number, notification: unknown) {
    await channel.push(ws, {
        op: 'event',
        data: notification
    });
}
```

## HAL Implementation

### Channel Device Interface

```typescript
// src/hal/channel.ts

export interface ChannelDevice {
    /**
     * Open a channel as client.
     */
    open(proto: string, url: string, opts?: ChannelOpts): Promise<Channel>;

    /**
     * Wrap an accepted socket as server-side channel.
     */
    accept(socket: Socket, proto: string, opts?: ChannelOpts): Promise<Channel>;
}

export interface Channel {
    /** Unique channel ID */
    readonly id: string;

    /** Protocol type */
    readonly proto: string;

    /** Description (URL or connection info) */
    readonly description: string;

    /** Whether the channel is closed */
    readonly closed: boolean;

    /**
     * Handle a message (internal).
     * Both call() and stream() use this; call() just takes first response.
     */
    handle(msg: Message): AsyncIterable<Response>;

    /**
     * Push a response to remote (server-side).
     */
    push(response: Response): Promise<void>;

    /**
     * Receive a message from remote (bidirectional).
     */
    recv(): Promise<Message>;

    /**
     * Close the channel.
     */
    close(): Promise<void>;
}

export interface ChannelOpts {
    /** Default headers (HTTP) */
    headers?: Record<string, string>;
    /** Keep connection alive */
    keepAlive?: boolean;
    /** Request timeout in ms */
    timeout?: number;
    /** Database name (postgres) */
    database?: string;
}
```

### Bun Implementation

```typescript
// src/hal/channel.ts

export class BunChannelDevice implements ChannelDevice {
    async open(proto: string, url: string, opts?: ChannelOpts): Promise<Channel> {
        switch (proto) {
            case 'http':
            case 'https':
                return new BunHttpChannel(url, opts);

            case 'websocket':
            case 'ws':
            case 'wss':
                return new BunWebSocketClientChannel(url, opts);

            case 'postgres':
            case 'postgresql':
                return new BunPostgresChannel(url, opts);  // Placeholder

            default:
                throw new Error(`Unsupported protocol: ${proto}`);
        }
    }

    async accept(socket: Socket, proto: string, opts?: ChannelOpts): Promise<Channel> {
        switch (proto) {
            case 'sse':
                return new BunSSEServerChannel(socket, opts);

            case 'websocket':
                // WebSocket server-side requires HTTP upgrade
                throw new Error('WebSocket server channels should be created via HTTP upgrade');

            default:
                throw new Error(`Unsupported server protocol: ${proto}`);
        }
    }
}
```

### HTTP Channel

```typescript
class BunHttpChannel implements Channel {
    private baseUrl: string;
    private defaultHeaders: Record<string, string>;

    constructor(url: string, opts?: ChannelOpts) {
        this.baseUrl = url;
        this.defaultHeaders = opts?.headers ?? {};
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (msg.op !== 'request') {
            yield { op: 'error', data: { code: 'EINVAL', message: `Unknown op: ${msg.op}` } };
            return;
        }

        const req = msg.data as HttpRequest;
        const url = this.buildUrl(req.path, req.query);

        const response = await fetch(url, {
            method: req.method,
            headers: { ...this.defaultHeaders, ...req.headers },
            body: req.body ? JSON.stringify(req.body) : undefined,
        });

        if (!response.ok) {
            yield {
                op: 'error',
                data: { code: `HTTP_${response.status}`, message: response.statusText }
            };
            return;
        }

        // Check for streaming response
        if (req.accept === 'application/jsonl' ||
            response.headers.get('content-type')?.includes('application/jsonl')) {
            // Stream JSONL
            for await (const line of this.readLines(response.body!)) {
                if (line.trim()) {
                    yield { op: 'item', data: JSON.parse(line) };
                }
            }
            yield { op: 'done' };
        } else {
            // Single JSON response
            yield { op: 'ok', data: await response.json() };
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('HTTP client channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('HTTP client channels do not support recv');
    }

    async close(): Promise<void> {
        // Connection pooling handled by fetch
    }

    private buildUrl(path: string, query?: Record<string, unknown>): string {
        const url = new URL(path, this.baseUrl);
        if (query) {
            for (const [key, value] of Object.entries(query)) {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }

    private async *readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!;

            for (const line of lines) {
                yield line;
            }
        }

        if (buffer.trim()) {
            yield buffer;
        }
    }
}
```

### PostgreSQL Channel

> **Note**: PostgreSQL support is currently a placeholder. Full implementation pending Bun.sql stability.

```typescript
class BunPostgresChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'postgres';
    readonly description: string;
    private _closed = false;

    constructor(url: string, _opts?: ChannelOpts) {
        this.description = url;
        // TODO: Initialize Bun.sql connection when available
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        // Placeholder - returns ENOSYS until Bun.sql integration
        switch (msg.op) {
            case 'query':
            case 'execute':
                yield respond.error('ENOSYS', 'PostgreSQL support not yet implemented');
                break;
            default:
                yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('PostgreSQL channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('PostgreSQL channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
    }
}
```

### SSE Server Channel

```typescript
class BunSSEChannel implements Channel {
    private socket: Socket;
    private encoder = new TextEncoder();

    constructor(socket: Socket, _opts?: ChannelOpts) {
        this.socket = socket;
        // Send SSE headers
        this.sendHeaders();
    }

    private async sendHeaders(): Promise<void> {
        const headers = [
            'HTTP/1.1 200 OK',
            'Content-Type: text/event-stream',
            'Cache-Control: no-cache',
            'Connection: keep-alive',
            '',
            ''
        ].join('\r\n');
        await this.socket.write(this.encoder.encode(headers));
    }

    async *handle(_msg: Message): AsyncIterable<Response> {
        // SSE server channels don't handle incoming messages this way
        yield { op: 'error', data: { code: 'EINVAL', message: 'Use push() for SSE' } };
    }

    async push(response: Response): Promise<void> {
        const event = `data: ${JSON.stringify(response.data)}\n\n`;
        await this.socket.write(this.encoder.encode(event));
    }

    async recv(): Promise<Message> {
        throw new Error('SSE server channels do not support recv');
    }

    async close(): Promise<void> {
        await this.socket.close();
    }
}
```

## Integration with HAL

### HAL Interface Update

```typescript
// src/hal/index.ts

export interface HAL {
    readonly block: BlockDevice;
    readonly storage: StorageEngine;
    readonly network: NetworkDevice;
    readonly channel: ChannelDevice;    // NEW
    readonly timer: TimerDevice;
    readonly clock: ClockDevice;
    readonly entropy: EntropyDevice;
    readonly crypto: CryptoDevice;
    readonly console: ConsoleDevice;
    readonly dns: DNSDevice;
    readonly host: HostDevice;
    readonly ipc: IPCDevice;

    shutdown(): Promise<void>;
}
```

### Kernel Syscall Registration

```typescript
// src/kernel/syscalls.ts

export function createChannelSyscalls(
    hal: HAL,
    allocateChannel: (proc: Process, channel: Channel, description: string) => number,
    getChannel: (proc: Process, ch: number) => Channel | undefined,
    closeChannel: (proc: Process, ch: number) => Promise<void>
): SyscallRegistry {
    return {
        async channel_open(proc: Process, proto: unknown, url: unknown, opts: unknown): Promise<number> {
            if (typeof proto !== 'string') throw new EINVAL('proto must be a string');
            if (typeof url !== 'string') throw new EINVAL('url must be a string');

            const channel = await hal.channel.open(proto, url, opts as ChannelOpts);
            return allocateChannel(proc, channel, `${proto}:${url}`);
        },

        async channel_accept(proc: Process, socketFd: unknown, proto: unknown, opts: unknown): Promise<number> {
            // Get socket from fd, wrap with protocol
            // ... implementation
        },

        async channel_call(proc: Process, ch: unknown, msg: unknown): Promise<Response> {
            if (typeof ch !== 'number') throw new EINVAL('ch must be a number');

            const channel = getChannel(proc, ch);
            if (!channel) throw new EBADF(`Bad channel: ${ch}`);

            // Get first response from handle()
            for await (const response of channel.handle(msg as Message)) {
                return response;
            }
            return { op: 'error', data: { code: 'EIO', message: 'No response' } };
        },

        async *channel_stream(proc: Process, ch: unknown, msg: unknown): AsyncIterable<Response> {
            if (typeof ch !== 'number') throw new EINVAL('ch must be a number');

            const channel = getChannel(proc, ch);
            if (!channel) throw new EBADF(`Bad channel: ${ch}`);

            yield* channel.handle(msg as Message);
        },

        async channel_push(proc: Process, ch: unknown, response: unknown): Promise<void> {
            if (typeof ch !== 'number') throw new EINVAL('ch must be a number');

            const channel = getChannel(proc, ch);
            if (!channel) throw new EBADF(`Bad channel: ${ch}`);

            await channel.push(response as Response);
        },

        async channel_recv(proc: Process, ch: unknown): Promise<Message> {
            if (typeof ch !== 'number') throw new EINVAL('ch must be a number');

            const channel = getChannel(proc, ch);
            if (!channel) throw new EBADF(`Bad channel: ${ch}`);

            return channel.recv();
        },

        async channel_close(proc: Process, ch: unknown): Promise<void> {
            if (typeof ch !== 'number') throw new EINVAL('ch must be a number');
            await closeChannel(proc, ch);
        },
    };
}
```

## Complete Syscall Reference

### File Operations (unchanged)

| Syscall | Arguments | Returns |
|---------|-----------|---------|
| `open` | path, flags | fd |
| `close` | fd | void |
| `read` | fd, size? | Uint8Array |
| `write` | fd, data | number |
| `seek` | fd, offset, whence | number |
| `stat` | path | Stat |

### Port Operations

| Syscall | Arguments | Returns |
|---------|-----------|---------|
| `port` | type, opts | portId |
| `recv` | portId | PortMessage |
| `send` | portId, to, data | void |
| `pclose` | portId | void |

### Channel Operations (new)

| Syscall | Arguments | Returns |
|---------|-----------|---------|
| `channel_open` | proto, url, opts? | channelId |
| `channel_accept` | socketFd, proto, opts? | channelId |
| `channel_call` | channelId, msg | Response |
| `channel_stream` | channelId, msg | AsyncIterable\<Response\> |
| `channel_push` | channelId, response | void |
| `channel_recv` | channelId | Message |
| `channel_close` | channelId | void |

### Network (raw connections)

| Syscall | Arguments | Returns |
|---------|-----------|---------|
| `connect` | proto, host, port | fd |

## Design Decisions

### Why a Third Primitive?

1. **fds (Resources)** are byte streams - no message boundaries
2. **Ports** are for N:1 or 1:N patterns (listeners, UDP, pubsub) - not request/response
3. **Channels** are 1:1 request/response with protocol awareness

Trying to fit channels into fd or port semantics creates awkward APIs.

### Why `op`-Based Messages?

Aligns with VFS message passing (`src/vfs/message.ts`). The entire OS uses the same paradigm:

- Files respond to `{ op: 'read' }` with `{ op: 'chunk', data: ... }`
- Channels respond to `{ op: 'query' }` with `{ op: 'ok', data: rows }`

### Why HAL Handles Protocol Framing?

- Bun already has optimized implementations (database adapters, fetch)
- Protocol details (HTTP/2, PostgreSQL wire format) are complex
- Userspace shouldn't need to know about connection pooling, keep-alive, TLS

### Channel IDs vs File Descriptors

Channels get their own ID namespace (like ports) rather than sharing fd space because:

- Channels have different operations (`call`, `stream`, `push` vs `read`, `write`)
- Prevents confusion about what operations are valid on a handle
- Allows protocol-specific metadata without polluting fd structure

## Future Considerations

### Additional Protocols

- **Redis**: `{ op: 'get', data: { key: '...' } }`, `{ op: 'subscribe', data: { channels: [...] } }`
- **gRPC**: Streaming RPC with typed messages
- **GraphQL**: `{ op: 'query', data: { query: '...', variables: {...} } }`

### Connection Pooling

HAL implementations may pool connections internally. The channel abstraction hides this:

```typescript
// These might share underlying TCP connections
const ch1 = await channel.open('postgres', 'postgresql://localhost/db');
const ch2 = await channel.open('postgres', 'postgresql://localhost/db');
```

### Multiplexing

HTTP/2 and WebSocket support multiple logical streams per connection. The channel abstraction can expose this:

```typescript
const http2 = await channel.open('http2', 'https://api.example.com');
// Multiple concurrent requests share one connection
const [users, posts] = await Promise.all([
    channel.call(http2, { op: 'request', data: { path: '/users' } }),
    channel.call(http2, { op: 'request', data: { path: '/posts' } }),
]);
```

## Source Files

| File | Purpose |
|------|---------|
| `src/message.ts` | Core Message/Response types (universal) |
| `src/hal/channel.ts` | ChannelDevice interface and Bun implementations |
| `src/hal/index.ts` | HAL aggregate interface (exports channel device) |
| `src/kernel/types.ts` | Process.channels, MAX_CHANNELS constant |
| `src/kernel/syscalls.ts` | Channel syscall handlers (createChannelSyscalls) |
| `src/kernel/kernel.ts` | Channel resource tracking and lifecycle |
| `src/process/channel.ts` | Userspace channel API |
| `src/process/index.ts` | Process library exports (includes channel) |
| `src/vfs/message.ts` | VFS-specific typed messages (extends core) |
