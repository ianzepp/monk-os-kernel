# Process Library

Userland interface to Monk OS kernel. Provides message-based I/O for pipeline composition.

---

## Message-Based Architecture

All process communication in Monk OS is **message-based**, not byte-based. This is a fundamental departure from traditional Unix.

### Unix: Byte Streams

In Unix, processes communicate via unstructured byte streams:

```typescript
// Unix-style: raw bytes, no structure
const bytes = fs.readFileSync('/file');        // Uint8Array
process.stdout.write(bytes);                    // raw bytes out
const line = readline.read();                   // must parse bytes into lines
```

Problems with byte streams:
- No inherent structure - consumers must parse
- No end-of-stream signaling beyond EOF
- No error propagation through pipes
- No metadata alongside data

### Monk OS: Message Streams

In Monk OS, processes communicate via structured `Response` messages:

```typescript
// Monk OS: structured messages with semantic meaning
for await (const msg of recv(0)) {
    switch (msg.op) {
        case 'item':  // one logical item (line, record, etc.)
            process(msg.data);
            break;
        case 'done':  // explicit end-of-stream
            break;
        case 'error': // error propagation
            handleError(msg.data.code, msg.data.message);
            break;
    }
}
```

Benefits of message streams:
- **Self-describing**: Each message has an `op` field indicating its type
- **Structured data**: `msg.data` contains typed fields, not raw bytes
- **Explicit termination**: `done` message signals end-of-stream
- **Error propagation**: `error` messages flow through pipelines
- **Metadata support**: Messages can carry context alongside data

### The Response Protocol

Every message is a `Response` object:

```typescript
interface Response {
    op: 'ok' | 'error' | 'item' | 'data' | 'done' | 'event' | 'progress';
    data?: unknown;
    bytes?: Uint8Array;  // only for 'data' op (binary content)
}
```

| Op | Meaning | Terminal? |
|----|---------|-----------|
| `ok` | Success with optional value | Yes |
| `error` | Failure with code/message | Yes |
| `item` | One item in a sequence | No |
| `data` | Binary chunk (file reads) | No |
| `done` | Sequence complete | Yes |
| `event` | Async notification | No |
| `progress` | Progress indicator | No |

### Standard File Descriptors

Monk OS uses message-based terminology for standard fds:

| fd | Unix Name | Monk Name | Purpose |
|----|-----------|-----------|---------|
| 0 | stdin | recv | Receive messages |
| 1 | stdout | send | Send messages |
| 2 | stderr | warn | Diagnostic output |

### Why Messages?

1. **Pipeline semantics**: Commands like `sort`, `uniq`, `grep` naturally operate on logical items, not byte boundaries
2. **Error handling**: Errors propagate through pipelines without special handling
3. **Structured data**: JSON-like data flows without serialization overhead inside the OS
4. **Stream control**: Explicit `done` vs implicit EOF eliminates ambiguity

---

## Required Exports

Derived from audit of `rom/bin/*.ts` imports.

### Functions (38)

| Category | Functions |
|----------|-----------|
| **I/O Console** | `print`, `println`, `eprintln` |
| **I/O Message** | `recv`, `send`, `respond` |
| **File Ops** | `open`, `close`, `read`, `write`, `stat`, `rename`, `unlink`, `copyFile` |
| **File Helpers** | `readFile`, `readFileBytes`, `readText`, `head`, `ByteReader` |
| **Directory** | `mkdir`, `rmdir`, `readdirAll` |
| **Process** | `exit`, `spawn`, `wait`, `getpid`, `getargs` |
| **Environment** | `getcwd`, `chdir`, `getenv`, `setenv` |
| **Signals** | `onSignal`, `SIGTERM`, `sleep` |
| **Pipes** | `pipe`, `redirect`, `outputRedirect` |
| **Access Control** | `access` |
| **Links** | `symlink` |

### Types (3)

| Type | Used By |
|------|---------|
| `Response` | Message protocol |
| `Stat` | File metadata |
| `Grant` | ACL permissions |

## Message-Based I/O

The key differentiator from traditional byte-based I/O:

```typescript
// recv(fd) - yields Response messages from file descriptor
for await (const msg of recv(0)) {
    if (msg.op === 'item') {
        const { text } = msg.data;
        // process text
    }
    if (msg.op === 'done') break;
}

// send(fd, msg) - writes Response message to file descriptor
await send(1, respond.item({ text: 'hello' }));
await send(1, respond.done());

// respond helper - constructs Response objects
respond.ok(data?)      // { op: 'ok', data }
respond.error(code, message)  // { op: 'error', data: { code, message } }
respond.item(data)     // { op: 'item', data }
respond.done()         // { op: 'done' }
```

## Pipeline Composition

Messages enable clean pipeline composition:

```
echo "hello" | cat | wc -c
     │         │      │
     │         │      └─ recv(0) → count items → send(1, respond.item({count}))
     │         └─ recv(0) → pass through → send(1, msg)
     └─ send(1, respond.item({text: "hello"})) → send(1, respond.done())
```

## File Structure

```
rom/lib/process/
├── README.md      # This file
├── index.ts       # Main exports
├── types.ts       # Response, Stat, Grant, Message types
├── syscall.ts     # Transport layer (postMessage to kernel)
└── respond.ts     # Response helper constructors
```
