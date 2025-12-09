# Monk OS Network Architecture

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| HAL NetworkDevice | ✅ Done | `src/hal/network.ts` |
| Resource abstraction | ✅ Done | `src/kernel/resource.ts` |
| Kernel `connect()` | ✅ Done | `src/kernel/syscalls.ts` |
| SocketResource | ✅ Done | `src/kernel/resource.ts` |
| Port interface | ✅ Done | `src/kernel/resource.ts` |
| Kernel `port()` | ✅ Done | `src/kernel/kernel.ts` |
| Port syscalls (recv/send/pclose) | ✅ Done | `src/kernel/syscalls.ts` |
| TCP listener port | ✅ Done | `src/kernel/resource.ts` (ListenerPort) |
| UDP port | ✅ Done | `src/kernel/resource.ts` (UdpPort) |
| Watch port | ✅ Done | `src/kernel/resource.ts` (WatchPort) |
| Pub/Sub port | ✅ Done | `src/kernel/resource.ts` (PubsubPort) |

---

## Philosophy

**Network is NOT part of VFS.**

TCP connections feel file-like (streams), but:
- **UDP is connectionless** - datagrams with addresses, not a connected stream
- **Listeners are factories** - they produce connections, they aren't connections themselves
- **Path asymmetry is ugly** - `/dev/tcp/listen/8080` vs `/dev/tcp/127.0.0.1:8080`

Instead, network has dedicated kernel syscalls that return two primitives:
- **FileHandle** for connected streams (TCP connections)
- **Port** for message-based I/O (UDP, listeners, watch, pub/sub)

## Two Primitives

| Primitive | Addressing | Methods | Examples |
|-----------|------------|---------|----------|
| **FileHandle** | Connected to one target | `read()`, `write()` | TCP connection, file, pipe |
| **Port** | Many sources/destinations | `recv()`, `send(to, data)` | UDP, TCP listener, watch, pub/sub |

### Why Two?

**FileHandle** = implicit addressing. You opened a connection to a specific target. All reads/writes go there.

```typescript
const conn = await kernel.connect('tcp', '10.0.0.1', 8080);
await conn.write(data);       // goes to 10.0.0.1:8080
const resp = await conn.read(); // comes from 10.0.0.1:8080
```

**Port** = explicit addressing. You're bound to receive from many sources, send to many destinations.

```typescript
const sock = await kernel.port('udp', { port: 9000 });
await sock.send('10.0.0.1:9001', data);  // explicit destination
await sock.send('10.0.0.2:9001', data);  // different destination
const msg = await sock.recv();            // msg.from tells you who sent it
```

## Kernel Syscalls

### connect()

Create a connected stream (TCP or Unix socket).

```typescript
interface Kernel {
  connect(proto: 'tcp', host: string, port: number): Promise<FileHandle>;
  connect(proto: 'unix', path: string): Promise<FileHandle>;
}
```

Returns a FileHandle with:
- `read(size?: number): Promise<Uint8Array>` - read from stream
- `write(data: Uint8Array): Promise<number>` - write to stream
- `close(): Promise<void>` - close connection

**TCP Example:**

```typescript
const conn = await kernel.connect('tcp', 'example.com', 80);
await conn.write(new TextEncoder().encode('GET / HTTP/1.0\r\n\r\n'));
const response = await conn.read();
await conn.close();
```

**Unix Socket Example:**

```typescript
const conn = await kernel.connect('unix', '/var/run/db.sock');
await conn.write(query);
const result = await conn.read();
await conn.close();
```

Unix sockets provide faster local IPC than TCP loopback. Permission to connect is controlled by VFS ACL on the socket path.

### port()

Create a message-based I/O channel.

```typescript
interface Kernel {
  port(type: PortType, opts: PortOpts): Promise<Port>;
}

type PortType = 'tcp:listen' | 'udp' | 'watch' | 'pubsub';

interface PortOpts {
  // tcp:listen
  port?: number;
  host?: string;        // bind address, default '127.0.0.1' (loopback for security)
  backlog?: number;     // listen backlog, default 128

  // udp
  bind?: number;        // local port to bind

  // watch
  pattern?: string;     // glob pattern for paths

  // pubsub
  subscribe?: string | string[];  // topic patterns
}
```

## Port Interface

```typescript
interface Port extends AsyncDisposable {
  /** Receive next message (blocks until available) */
  recv(): Promise<Message>;

  /** Send message to destination */
  send(to: string, data: Uint8Array): Promise<void>;

  /** Close port and release resources */
  close(): Promise<void>;

  /** Async iteration over messages */
  [Symbol.asyncIterator](): AsyncIterator<Message>;
}

interface Message {
  /** Source identifier */
  from: string;

  /** Payload (Uint8Array for data, FileHandle for tcp:listen) */
  data: Uint8Array | FileHandle;

  /** Optional metadata */
  meta?: Record<string, unknown>;
}
```

## Port Types

### tcp:listen

TCP server. `recv()` yields new connections as FileHandles.

```typescript
const listener = await kernel.port('tcp:listen', { port: 8080 });

for await (const msg of listener) {
  const conn: FileHandle = msg.data as FileHandle;
  // msg.from = '10.0.0.1:54321' (client address)

  // Handle connection (usually spawn to separate handler)
  handleConnection(conn);
}
```

**Message shape:**
```typescript
{
  from: '10.0.0.1:54321',   // remote address
  data: FileHandle,         // connected socket
  meta: undefined
}
```

### udp

UDP socket. Send/receive datagrams with addresses.

```typescript
const sock = await kernel.port('udp', { port: 9000 });

// Send to specific address
await sock.send('10.0.0.1:9001', data);

// Receive from anyone
const msg = await sock.recv();
// msg.from = '10.0.0.2:12345'
// msg.data = Uint8Array (datagram payload)
```

**Message shape:**
```typescript
{
  from: '10.0.0.2:12345',   // sender address
  data: Uint8Array,         // datagram payload
  meta: undefined
}
```

### watch

File system watcher. Receive events when paths change.

```typescript
const watcher = await kernel.port('watch', { pattern: '/users/*' });

for await (const event of watcher) {
  // event.from = '/users/123' (path that changed)
  // event.meta = { op: 'create' | 'update' | 'delete' }
  // event.data = Uint8Array (new content, if available)
}
```

**Message shape:**
```typescript
{
  from: '/users/123',       // path that changed
  data: Uint8Array,         // new content (optional)
  meta: {
    op: 'create' | 'update' | 'delete',
    fields?: string[]       // which fields changed (for update)
  }
}
```

**Pattern syntax:**
- `/users/123` - exact path
- `/users/*` - direct children of /users
- `/users/**` - all descendants of /users
- `/users/*/profile` - profile of any user

### pubsub

Topic-based pub/sub. Send/receive messages by topic.

```typescript
const bus = await kernel.port('pubsub', { subscribe: 'orders.*' });

// Receive messages
for await (const msg of bus) {
  // msg.from = 'orders.created' (topic)
  // msg.data = Uint8Array (message payload)
}

// Send message (in another process)
await bus.send('orders.created', orderData);
```

**Message shape:**
```typescript
{
  from: 'orders.created',   // topic
  data: Uint8Array,         // message payload
  meta: {
    publisher?: string,     // publisher UUID (optional)
    seq?: number           // sequence number (optional)
  }
}
```

**Topic patterns:**
- `orders.created` - exact topic
- `orders.*` - one level wildcard
- `orders.>` - multi-level wildcard (all under orders)

## Flow Control

### FileHandle (Streams)

Backpressure via return values:

```typescript
const written = await conn.write(data);
if (written < data.length) {
  // Partial write, buffer is full
  // Caller must retry remaining bytes
}
```

Read blocks until data available or EOF:

```typescript
const data = await conn.read(1024);
if (data.length === 0) {
  // EOF - connection closed
}
```

### Port (Messages)

`recv()` blocks until message available:

```typescript
const msg = await port.recv();  // blocks
```

`send()` may block if destination buffer is full (UDP) or queue is full (pubsub):

```typescript
await port.send(to, data);  // may block
```

For non-blocking check, use `tryRecv()` / `trySend()` (if implemented):

```typescript
const msg = port.tryRecv();  // returns null if no message
const ok = port.trySend(to, data);  // returns false if would block
```

## Layering

```
┌─────────────────────────────────────────────────────────────┐
│  Userland                                                   │
│  HTTP library, WebSocket library, RPC framework, etc.       │
├─────────────────────────────────────────────────────────────┤
│  Kernel Syscalls                                            │
│  connect() → FileHandle    port() → Port                    │
├─────────────────────────────────────────────────────────────┤
│  HAL NetworkDevice                                          │
│  Bun.listen(), Bun.connect(), Bun.serve()                  │
├─────────────────────────────────────────────────────────────┤
│  Bun Runtime                                                │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** HTTP, WebSocket, gRPC, etc. are userland libraries built on top of TCP FileHandles. The kernel provides raw transport; protocols are implemented above.

## Examples

### Echo Server

```typescript
async function echoServer(kernel: Kernel) {
  const listener = await kernel.port('tcp:listen', { port: 7 });

  for await (const msg of listener) {
    const conn = msg.data as FileHandle;
    // Echo back everything received
    try {
      while (true) {
        const data = await conn.read(1024);
        if (data.length === 0) break;  // EOF
        await conn.write(data);
      }
    } finally {
      await conn.close();
    }
  }
}
```

### UDP Time Server

```typescript
async function timeServer(kernel: Kernel) {
  const sock = await kernel.port('udp', { port: 37 });

  for await (const msg of sock) {
    // RFC 868: 32-bit seconds since 1900-01-01
    const now = Math.floor(Date.now() / 1000) + 2208988800;
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, now, false);
    await sock.send(msg.from, buf);
  }
}
```

### File Change Notifier

```typescript
async function notifyChanges(kernel: Kernel) {
  const watcher = await kernel.port('watch', { pattern: '/data/**' });
  const bus = await kernel.port('pubsub', { subscribe: [] });  // send-only

  for await (const event of watcher) {
    // Republish file events as pub/sub messages
    await bus.send(`file.${event.meta?.op}`,
      new TextEncoder().encode(event.from));
  }
}
```

### Request/Response over Pub/Sub

```typescript
async function rpcClient(kernel: Kernel, method: string, params: unknown) {
  const correlationId = crypto.randomUUID();
  const bus = await kernel.port('pubsub', { subscribe: `rpc.response.${correlationId}` });

  // Send request
  await bus.send('rpc.request', new TextEncoder().encode(JSON.stringify({
    id: correlationId,
    method,
    params
  })));

  // Wait for response
  const msg = await bus.recv();
  await bus.close();

  return JSON.parse(new TextDecoder().decode(msg.data as Uint8Array));
}
```

## Security

### Port Permissions

Creating ports requires kernel-level permission. Process capabilities determine which ports can be created:

| Port Type | Required Capability |
|-----------|---------------------|
| tcp:listen | `net.listen` + port range |
| udp | `net.udp` + port range |
| watch | `vfs.watch` + path pattern |
| pubsub | `pubsub.subscribe` + topic pattern |

### Network Isolation

Processes can be isolated from network entirely (no `net.*` capabilities). Useful for sandboxed computation.

## Relationship to VFS

VFS and Network are peers under the Kernel:

```
┌─────────────────────────────────────────────────────────────┐
│  Kernel                                                     │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │      VFS        │  │    Network      │                  │
│  │                 │  │                 │                  │
│  │  open()         │  │  connect()      │                  │
│  │  read()         │  │  port()         │                  │
│  │  write()        │  │                 │                  │
│  │  stat()         │  │                 │                  │
│  │  ...            │  │                 │                  │
│  └────────┬────────┘  └────────┬────────┘                  │
│           │                    │                            │
│           ▼                    ▼                            │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  StorageEngine  │  │  NetworkDevice  │                  │
│  │  (HAL)          │  │  (HAL)          │                  │
│  └─────────────────┘  └─────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

**Watch ports** are the bridge: they're created via `kernel.port('watch', ...)` but receive events from VFS writes. The Kernel's message router connects VFS mutations to watch port subscribers.

## Security Considerations

### Service Binding Defaults

**Services bind to loopback by default** (`127.0.0.1`) for security. This prevents accidental exposure of services to external networks in development or containerized environments.

To bind to all interfaces (dangerous in production):
```json
{
  "handler": "/bin/httpd",
  "activate": {
    "type": "tcp:listen",
    "port": 8080,
    "host": "0.0.0.0"
  }
}
```

### Telnet Service

The `telnetd` service provides plaintext shell access. It is **enabled by default** but binds to `127.0.0.1` (loopback only), preventing external network access.

**Security recommendations:**
- Telnet transmits credentials and commands in plaintext
- Loopback binding prevents external exposure by default
- To disable telnetd entirely, remove `/etc/services/telnetd.json`
- Consider SSH or TLS-wrapped alternatives for remote access
- Never configure telnetd with `"host": "0.0.0.0"` in production

### Recommended Patterns

**Internal services** (development/localhost only):
```json
{
  "activate": { "type": "tcp:listen", "port": 8080 }
}
```

**External services** (behind reverse proxy):
- Bind to `127.0.0.1` and use nginx/haproxy/caddy as reverse proxy
- Configure TLS termination at the proxy layer
- Apply authentication and rate limiting at proxy

**Containerized deployments:**
- Services default to loopback, preventing accidental external exposure
- Use container networking (`--publish` or `EXPOSE`) to explicitly expose ports
- Apply network policies at container orchestration level

## Open Questions

1. **WebSocket support** - Should there be a `ws:listen` port type, or is WebSocket purely userland over TCP? Leaning toward userland.

2. **TLS** - How to handle TLS? Options:
   - `kernel.connect('tls', host, port)` - separate protocol
   - `{ tls: true }` option on connect/listen
   - Userland TLS wrapper over raw TCP

3. **Multicast UDP** - Support for joining multicast groups? Likely a `{ multicast: '224.0.0.1' }` option on UDP ports.

4. **Unix sockets** - **Yes.** `connect('unix', '/var/run/socket')` returns fd like TCP. Port argument ignored. Uses VFS ACL on socket path for permission. No HAL changes needed - kernel dispatches to `Bun.connect({ unix: path })` based on proto.
