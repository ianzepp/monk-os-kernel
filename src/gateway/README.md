# Gateway - External Syscall Interface

The Gateway provides external applications access to Monk OS syscalls over a Unix domain socket. It runs in kernel context (not as a Worker), executing syscalls directly without IPC overhead.

## Architecture

```
External Apps                     Monk OS Kernel
─────────────                     ──────────────
os-shell ─────┐
              │  Unix socket      ┌─────────────────────────────┐
displayd ─────┼─────────────────▶ │  Gateway                    │
              │  JSON protocol    │    │                        │
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

Newline-delimited JSON over Unix socket.

### Request

```json
{ "id": "abc", "call": "file:open", "args": ["/etc/hosts", {"read": true}] }
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Client-generated correlation ID |
| `call` | string | Syscall name (e.g., `file:open`, `ems:select`) |
| `args` | array | Syscall arguments |

### Response

```json
{ "id": "abc", "op": "ok", "data": { "fd": 3 } }
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Echoed from request |
| `op` | string | Operation result (see below) |
| `data` | object | Result payload (optional) |
| `bytes` | string | Base64-encoded binary data (for `op: "data"`) |
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
| `data` | No | Binary data chunk (base64) |
| `event` | No | Async notification |
| `progress` | No | Progress indicator |

Terminal operations end the response stream for that request ID.

## Examples

### Single-value syscall

```
→ {"id":"1","call":"proc:getpid","args":[]}
← {"id":"1","op":"ok","data":{"pid":42}}
```

### Streaming syscall

```
→ {"id":"2","call":"file:readdir","args":["/home"]}
← {"id":"2","op":"item","data":{"name":"alice","model":"folder"}}
← {"id":"2","op":"item","data":{"name":"bob","model":"folder"}}
← {"id":"2","op":"done"}
```

### Error

```
→ {"id":"3","call":"file:open","args":["/nonexistent"]}
← {"id":"3","op":"error","code":"ENOENT","message":"No such file or directory"}
```

### Concurrent requests

```
→ {"id":"a","call":"file:read","args":[3]}
→ {"id":"b","call":"proc:getpid","args":[]}
← {"id":"b","op":"ok","data":{"pid":42}}
← {"id":"a","op":"data","bytes":"SGVsbG8gV29ybGQ="}
← {"id":"a","op":"done"}
```

## Usage

### OS Integration

```typescript
import { Gateway } from '@src/gateway/index.js';

// After dispatcher is created
const gateway = new Gateway(dispatcher, kernel, hal);
await gateway.listen('/tmp/monk.sock');

// On shutdown
await gateway.stop();
```

### Client (os-sdk)

```typescript
import { connect } from 'net';

const socket = connect('/tmp/monk.sock');

// Send request
const id = '1';
socket.write(`{"id":"${id}","call":"file:stat","args":["/etc"]}\n`);

// Read response
socket.on('data', (chunk) => {
    const line = chunk.toString();
    const response = JSON.parse(line);

    if (response.id === id) {
        if (response.op === 'ok') {
            console.log('Stat:', response.data);
        } else if (response.op === 'error') {
            console.error(`${response.code}: ${response.message}`);
        }
    }
});
```

## Design Decisions

### Why Unix socket (not TCP)?

- Security via filesystem permissions
- No network exposure
- Lower overhead for local IPC
- Standard pattern (Docker, PostgreSQL, MySQL)

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

## Files

```
src/gateway/
├── index.ts     # Exports Gateway class
├── gateway.ts   # Gateway implementation (~400 lines)
└── README.md    # This file
```
