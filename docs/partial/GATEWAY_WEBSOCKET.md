# Gateway WebSocket Support

## Status

**Phases 1 & 2: COMPLETE** (2024-12-09)

- HAL WebSocket server with accept() pattern implemented
- Gateway dual-transport (TCP + WebSocket) implemented
- All existing Gateway tests pass

**Phases 3 & 4: NOT STARTED**

- Browser client (os-sdk WebSocket transport)
- displayd migration to userspace syscall handler

---

## Motivation

Gateway currently speaks TCP+msgpack, which works for server-side clients (os-sdk, os-shell). Browsers cannot open raw TCP sockets, so they need WebSocket transport to connect.

**Goal**: Add WebSocket support to Gateway so browsers can connect directly, using the same msgpack protocol over WS frames instead of length-prefixed TCP.

### Use Case: Browser Display Client

```
Browser                          Gateway                    displayd (userspace)
   │                                │                              │
   │  WebSocket connect             │                              │
   ├───────────────────────────────▶│                              │
   │                                │  (virtual process created)   │
   │                                │                              │
   │  { id: "1", call: "display:connect", args: [...] }            │
   ├───────────────────────────────▶│─────────────────────────────▶│
   │                                │                              │
   │  { id: "1", op: "ok", data: { displayId: "..." } }            │
   │◀───────────────────────────────│◀─────────────────────────────┤
   │                                │                              │
   │  { id: "2", call: "display:subscribe", args: [displayId] }    │
   ├───────────────────────────────▶│─────────────────────────────▶│
   │                                │                              │
   │  (stream held open, events pushed as { op: "item" })          │
   │◀ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│◀ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
```

## Current Gateway Architecture

Understanding the existing TCP implementation is essential before adding WebSocket support.

### How TCP Works Today

The Gateway (`src/gateway/gateway.ts`) handles TCP clients as follows:

1. **Accept loop** (`acceptLoop`): Waits on `listener.accept()`, spawns `handleClient()` per connection
2. **Client handler** (`handleClient`):
   - Creates a virtual process via `createVirtualProcess()` for isolation
   - Reads length-prefixed msgpack frames from the socket
   - Fires off `processMessage()` for each complete frame
3. **Message processor** (`processMessage`):
   - Decodes msgpack payload
   - Calls `dispatcher.execute(proc, id, call, args)`
   - Iterates the response stream, writing each response back via `sendFrame()`
4. **Response sender** (`sendFrame`):
   - `pack(data)` → msgpack bytes
   - Prepend 4-byte big-endian length
   - `socket.write(frame)`

Key insight: The Socket is used **directly for wire I/O**, not through the kernel handle system. The virtual process only holds the handle table, active streams, cwd, and env - it doesn't route responses through fd 1.

### Wire Protocol

```
TCP Frame:  [4-byte BE length][msgpack payload]
Request:    { id: "abc", call: "vfs:read", args: ["/etc/hosts"] }
Response:   { id: "abc", op: "ok", data: { ... } }
            { id: "abc", op: "item", data: { ... } }  // streaming
            { id: "abc", op: "done" }                  // terminal
```

## Architecture

### Dual Transport

Gateway listens on two ports:

| Port | Transport | Framing | Clients |
|------|-----------|---------|---------|
| 7778 | TCP | 4-byte length prefix + msgpack | os-sdk, os-shell |
| 7779 | WebSocket | msgpack per WS binary frame | browsers |

Both transports use identical msgpack message format. The only difference is framing:
- TCP: `[4-byte length][msgpack]`
- WebSocket: `[msgpack]` (WS handles framing natively)

### Implementation Approach

Add a parallel WebSocket path that reuses the core dispatch logic:

```
┌─────────────────────────────────────────────────────────────┐
│                        Gateway                               │
├─────────────────────────────────────────────────────────────┤
│  TCP Accept Loop          │  WebSocket Accept Loop          │
│  ────────────────         │  ──────────────────────         │
│  listener.accept()        │  wsServer.accept()              │
│       ↓                   │       ↓                         │
│  handleClient(socket)     │  handleWebSocketClient(ws)      │
│       ↓                   │       ↓                         │
│  read length-prefixed     │  iterate WS binary frames       │
│  frames from socket       │       ↓                         │
│       ↓                   │       ↓                         │
├───────────────────────────┴─────────────────────────────────┤
│                    processMessage()                          │
│  ─────────────────────────────────────────────────────────  │
│  1. unpack(payload) → { id, call, args }                    │
│  2. dispatcher.execute(proc, id, call, args)                │
│  3. for await (response of stream) → write to client        │
├─────────────────────────────────────────────────────────────┤
│  TCP: sendFrame()         │  WS: sendWebSocketFrame()       │
│  [4-byte len][msgpack]    │  ws.send(msgpack)               │
└─────────────────────────────────────────────────────────────┘
```

### Code Changes to Gateway

The refactor is minimal because `processMessage()` already handles all dispatch logic. We just need:

1. **Parameterize the write function** - `processMessage()` currently calls `this.sendResponse(socket, ...)` directly. Change it to accept a write callback:

```typescript
type SendFn = (id: string, response: Response) => Promise<boolean>;

private async processMessage(
    send: SendFn,              // Replaces socket parameter
    proc: Process,
    clientId: number,
    payload: Uint8Array,
    isDisconnecting: () => boolean,
): Promise<void> {
    // ... decode, validate ...

    for await (const response of this.dispatcher.execute(proc, id, msg.call, args)) {
        if (isDisconnecting()) break;

        const sent = await send(id, response);  // Use callback
        if (!sent) break;

        if (isTerminal(response.op)) break;
    }
}
```

2. **TCP handler provides TCP send function**:

```typescript
private async handleClient(socket: Socket): Promise<void> {
    const send: SendFn = (id, response) => this.sendTcpResponse(socket, id, response);
    // ... create virtual process ...
    // ... read loop calls processMessage(send, proc, ...) ...
}

private async sendTcpResponse(socket: Socket, id: string, response: Response): Promise<boolean> {
    const wire = this.prepareForWire(id, response);
    const payload = pack(wire);
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, payload.length);
    frame.set(payload, 4);
    try {
        await socket.write(frame);
        return true;
    } catch {
        return false;
    }
}
```

3. **WebSocket handler provides WS send function**:

```typescript
private async handleWebSocketClient(ws: ServerWebSocket): Promise<void> {
    const send: SendFn = (id, response) => this.sendWebSocketResponse(ws, id, response);
    // ... create virtual process ...
    // ... iterate ws messages, call processMessage(send, proc, ...) ...
}

private async sendWebSocketResponse(ws: ServerWebSocket, id: string, response: Response): Promise<boolean> {
    const wire = this.prepareForWire(id, response);
    const payload = pack(wire);
    try {
        ws.sendBinary(payload);  // No length prefix needed
        return true;
    } catch {
        return false;
    }
}
```

### Client Tracking

Currently `clients` is `Set<Socket>`. For WebSocket support:

```typescript
// Option A: Separate sets
private tcpClients = new Set<Socket>();
private wsClients = new Set<ServerWebSocket>();

// Option B: Union type (simpler shutdown logic)
private clients = new Set<Socket | ServerWebSocket>();
```

Option B is simpler - both have a `close()` method, so shutdown can iterate the single set.

## HAL Changes

### New WebSocket Server API

Add to `NetworkDevice` interface in `src/hal/network/types.ts`:

```typescript
interface NetworkDevice {
    // Existing
    listen(port: number): Promise<Listener>;
    connect(host: string, port: number): Promise<Socket>;

    // New
    listenWebSocket(port: number): Promise<WebSocketServer>;
}

interface WebSocketServer {
    readonly port: number;
    accept(): Promise<ServerWebSocket>;
    close(): Promise<void>;
}

interface ServerWebSocket {
    sendBinary(data: Uint8Array): void;
    sendText(data: string): void;
    close(): void;

    // For async iteration of incoming messages
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
}
```

### Bun Implementation

Bun uses a callback-based WebSocket API via `Bun.serve()`. The HAL implementation bridges this to async iteration using a queue:

```typescript
// src/hal/network/websocket-server.ts

export class BunWebSocketServer implements WebSocketServer {
    private server: ReturnType<typeof Bun.serve>;
    private pendingConnections: ServerWebSocket[] = [];
    private waiters: Array<(ws: ServerWebSocket) => void> = [];

    constructor(port: number) {
        this.server = Bun.serve({
            port,
            fetch(req, server) {
                if (server.upgrade(req)) return;
                return new Response("WebSocket expected", { status: 400 });
            },
            websocket: {
                open: (ws) => {
                    const wrapped = new BunServerWebSocket(ws);
                    const waiter = this.waiters.shift();
                    if (waiter) {
                        waiter(wrapped);
                    } else {
                        this.pendingConnections.push(wrapped);
                    }
                },
                message: (ws, message) => {
                    // Route to the wrapped instance
                    (ws.data as BunServerWebSocket).pushMessage(message);
                },
                close: (ws) => {
                    (ws.data as BunServerWebSocket).pushClose();
                },
            },
        });
    }

    get port(): number {
        return this.server.port;
    }

    accept(): Promise<ServerWebSocket> {
        const pending = this.pendingConnections.shift();
        if (pending) return Promise.resolve(pending);

        return new Promise(resolve => {
            this.waiters.push(resolve);
        });
    }

    async close(): Promise<void> {
        this.server.stop();
    }
}

class BunServerWebSocket implements ServerWebSocket {
    private messageQueue: Array<Uint8Array | string> = [];
    private messageWaiters: Array<(msg: Uint8Array | string | null) => void> = [];
    private closed = false;

    constructor(private ws: Bun.ServerWebSocket<unknown>) {
        ws.data = this;  // Link for message routing
    }

    pushMessage(msg: Uint8Array | string): void {
        const waiter = this.messageWaiters.shift();
        if (waiter) {
            waiter(msg);
        } else {
            this.messageQueue.push(msg);
        }
    }

    pushClose(): void {
        this.closed = true;
        for (const waiter of this.messageWaiters) {
            waiter(null);
        }
        this.messageWaiters = [];
    }

    sendBinary(data: Uint8Array): void {
        this.ws.sendBinary(data);
    }

    sendText(data: string): void {
        this.ws.sendText(data);
    }

    close(): void {
        this.ws.close();
    }

    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array | string> {
        while (!this.closed) {
            const queued = this.messageQueue.shift();
            if (queued !== undefined) {
                yield queued;
                continue;
            }

            const msg = await new Promise<Uint8Array | string | null>(resolve => {
                this.messageWaiters.push(resolve);
            });

            if (msg === null) break;  // Connection closed
            yield msg;
        }
    }
}
```

## Browser Client

### MessagePack in Browser

Both `msgpackr` and `@msgpack/msgpack` work in browsers. Use whichever os-sdk already uses:

```typescript
import { pack, unpack } from 'msgpackr';

const ws = new WebSocket('ws://localhost:7779');
ws.binaryType = 'arraybuffer';

ws.onmessage = (event) => {
    const response = unpack(new Uint8Array(event.data));
    // Route by response.id to pending request handlers
};

function call(syscall: string, args: unknown[], id: string): void {
    ws.send(pack({ id, call: syscall, args }));
}
```

### os-sdk Browser Build

Extend os-sdk to support WebSocket transport:

```typescript
const client = new OSClient();
await client.connect({
    transport: 'websocket',  // vs 'tcp' (default)
    url: 'ws://localhost:7779',
});

// Same API from here on
const fd = await client.open('/etc/hosts', { read: true });
```

Or create a separate `@monk-api/os-sdk-browser` package if bundle size matters.

## Resolved Questions

1. **Single port vs dual port?**
   - **Decision**: Dual port (7778 TCP, 7779 WS)
   - **Rationale**: Simpler implementation, no HTTP upgrade complexity, explicit transport selection

2. **Ping/pong keepalive**
   - Bun handles WebSocket ping/pong automatically
   - No Gateway code needed

3. **Message size limits**
   - TCP has `MAX_READ_BUFFER_SIZE` (1MB) for the length-prefixed buffer
   - WebSocket: Bun has configurable `maxPayloadLength` (default 16MB)
   - Set to 1MB to match TCP: `websocket: { maxPayloadLength: 1024 * 1024 }`

## Open Questions

1. **Authentication**
   - TCP currently has no auth
   - WebSocket could require auth token in URL query param or first message
   - Defer to later iteration

2. **Error on oversized message**
   - TCP sends `ENOMEM` error before disconnecting on buffer overflow
   - WebSocket: Bun may just close the connection silently on oversized message
   - Consider sending error frame before close if possible

## Implementation Plan

### Phase 1: HAL WebSocket Server

Files to create/modify:
- `src/hal/network/types.ts` - Add `WebSocketServer`, `ServerWebSocket` interfaces
- `src/hal/network/websocket-server.ts` - `BunWebSocketServer` implementation
- `src/hal/network/device.ts` - Add `listenWebSocket()` to `BunNetworkDevice`
- `spec/hal/websocket.test.ts` - Unit tests

Deliverable: `hal.network.listenWebSocket(port)` returns working `WebSocketServer`

### Phase 2: Gateway WebSocket Support

Files to modify:
- `src/gateway/gateway.ts`:
  - Add `wsListener?: WebSocketServer` field
  - Add `wsPort` parameter to `listen(tcpPort, wsPort?)`
  - Refactor `processMessage()` to accept `SendFn` callback
  - Add `wsAcceptLoop()` and `handleWebSocketClient()`
  - Add `sendWebSocketResponse()`
  - Update `shutdown()` to close WS server and clients
- `spec/gateway/websocket.test.ts` - Integration tests

Deliverable: Gateway accepts both TCP and WebSocket connections

### Phase 3: Browser Client

Files to create/modify:
- `packages/os-sdk/src/transports/websocket.ts` - WebSocket transport
- `packages/os-sdk/src/client.ts` - Transport selection in `connect()`
- Browser build configuration (if needed)

Deliverable: os-sdk works in browsers via WebSocket

### Phase 4: displayd Migration

- Move displayd from standalone server to userspace syscall handler
- Register `display:*` syscalls
- Browser connects via Gateway WebSocket, calls display syscalls
- Remove displayd's HTTP/WS server code

Deliverable: Display system runs through Gateway like all other syscalls
