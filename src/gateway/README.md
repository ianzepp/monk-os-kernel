# Gateway - External Syscall Interface

The Gateway provides external applications access to Monk OS syscalls over TCP. It runs in kernel context (not as a Worker), executing syscalls directly without IPC overhead.

## Architecture

```
External Apps                     Monk OS Kernel
─────────────                     ──────────────
os-shell ─────┐
              │  TCP (port 7778)  ┌─────────────────────────────┐
displayd ─────┼─────────────────▶ │  Gateway                    │
              │  msgpack protocol │    │                        │
os-coreutils ─┘                   │    ▼                        │
                                  │  SyscallDispatcher.execute()│
                                  │    │                        │
                                  │    ▼                        │
                                  │  Kernel / VFS / EMS / HAL   │
                                  └─────────────────────────────┘
```

Each client connection gets an isolated **virtual process** with its own:
- File descriptor table (handles)
- Current working directory
- Environment variables

## Wire Protocol

Length-prefixed MessagePack over TCP.

### Message Framing

Each message is framed as:
```
[4-byte big-endian length][msgpack payload]
```

This allows:
- Efficient binary parsing (no delimiter scanning)
- Native `Uint8Array` support (no base64 encoding needed)
- Smaller message sizes compared to JSON

### Request

```javascript
{ id: "abc", call: "file:open", args: ["/etc/hosts", { read: true }] }
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Client-generated correlation ID |
| `call` | string | Syscall name (e.g., `file:open`, `ems:select`) |
| `args` | array | Syscall arguments (binary data as `Uint8Array`) |

### Response

```javascript
{ id: "abc", op: "ok", data: { fd: 3 } }
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Echoed from request |
| `op` | string | Operation result (see below) |
| `data` | object | Result payload (optional) |
| `bytes` | Uint8Array | Binary data (for `op: "data"`) |
| `code` | string | Error code (for `op: "error"`) |
| `message` | string | Error message (for `op: "error"`) |

### Response Operations

| Op | Terminal | Description |
|----|----------|-------------|
| `ok` | Yes | Success with optional data |
| `error` | Yes | Failure with code and message |
| `done` | Yes | Stream complete (after items) |
| `redirect` | Yes | Follow redirect (symlinks, mounts) |
| `item` | No | One item in a sequence |
| `data` | No | Binary data chunk |
| `event` | No | Async notification |
| `progress` | No | Progress indicator |

Terminal operations end the response stream for that request ID.

### Binary Data

MessagePack handles binary data (`Uint8Array`) natively:

```javascript
// Request with binary data
{
    id: "1",
    call: "file:write",
    args: [3, { data: new Uint8Array([72, 101, 108, 108, 111]) }]
}

// Response with binary data
{
    id: "1",
    op: "data",
    bytes: new Uint8Array([72, 101, 108, 108, 111])
}
```

No base64 encoding is needed - this is a key advantage over JSON.

## Examples

### Single-value syscall

```
→ { id: "1", call: "proc:getpid", args: [] }
← { id: "1", op: "ok", data: { pid: 42 } }
```

### Streaming syscall

```
→ { id: "2", call: "file:readdir", args: ["/home"] }
← { id: "2", op: "item", data: { name: "alice", model: "folder" } }
← { id: "2", op: "item", data: { name: "bob", model: "folder" } }
← { id: "2", op: "done" }
```

### Error

```
→ { id: "3", call: "file:open", args: ["/nonexistent"] }
← { id: "3", op: "error", code: "ENOENT", message: "No such file or directory" }
```

### Concurrent requests

```
→ { id: "a", call: "file:read", args: [3] }
→ { id: "b", call: "proc:getpid", args: [] }
← { id: "b", op: "ok", data: { pid: 42 } }
← { id: "a", op: "data", bytes: Uint8Array([72, 101, 108, 108, 111]) }
← { id: "a", op: "done" }
```

## Usage

### OS Integration

```typescript
import { Gateway } from '@src/gateway/index.js';

// After dispatcher is created
const gateway = new Gateway(dispatcher, kernel, hal);
const port = await gateway.listen(7778);  // Or use 0 for auto-assign

// On shutdown
await gateway.shutdown();
```

### Client (os-sdk)

```typescript
import { OSClient } from '@monk-api/os-sdk';

const client = new OSClient();
await client.connect({ host: 'localhost', port: 7778 });

// Read a file
const fd = await client.open('/etc/hosts', { read: true });
const data = await client.read(fd);
await client.fclose(fd);

// Write binary data
const fd2 = await client.open('/tmp/test', { write: true, create: true });
await client.write(fd2, new Uint8Array([1, 2, 3]));
await client.fclose(fd2);

client.close();
```

## Design Decisions

### Why MessagePack (not JSON)?

- Native binary support (`Uint8Array` without base64)
- Smaller message sizes (~30-50% reduction)
- Faster encode/decode
- Still human-debuggable with tools

### Why length-prefix framing (not newlines)?

- No delimiter scanning needed
- Works with binary payloads containing any byte value
- Explicit message boundaries

### Why TCP (not Unix socket)?

- Well-understood close semantics (FIN/ACK) - avoids teardown issues
- Network accessible for distributed deployments
- Works across containers and machines
- Simple configuration (just a port number)

### Why kernel context (not Worker)?

- Direct `dispatcher.execute()` without postMessage IPC
- Lower latency for syscalls
- Simpler debugging (single call stack)
- Gateway is infrastructure, not user code

### Why virtual processes?

- Each client gets isolated state (handles, cwd, env)
- No Worker thread overhead per connection
- Clean resource cleanup on disconnect

### Why client-generated IDs?

- Standard pattern for multiplexed protocols (JSON-RPC, GraphQL)
- Client controls correlation scheme (UUID, counter, etc.)
- Gateway stays simple (just echoes ID back)

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MONK_PORT` | `7778` | TCP port for Gateway |

## Files

```
src/gateway/
├── index.ts     # Exports Gateway class
├── gateway.ts   # Gateway implementation
└── README.md    # This file
```
