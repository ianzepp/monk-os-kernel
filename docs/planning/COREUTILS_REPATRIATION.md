# Coreutils Repatriation

> **Status**: Proposed
> **Complexity**: Medium
> **Dependencies**: None (enables OS_AI Phase 2)

Bring os-coreutils back into the main OS repo under `rom/`.

---

## Background

### The Diaspora

Originally, userspace utilities lived in `rom/` as part of the OS project. Then came a split:

1. **Separation**: Userspace moved to `@monk-api/os-coreutils` as a separate project
2. **Rationale**: Clean separation between kernel and userspace, communicate via gateway API
3. **Result**: 41 utilities developed independently, including full shell with pipes/redirects/globs

### The Return

AI agents (see `OS_AI.md`) are userspace processes that need shell and coreutils to function. With AI as a core OS feature, coreutils belongs back in the main repo.

---

## Current State

### os-coreutils (External)

```
@monk-api/os-coreutils/
├── bin/           # 41 utilities
│   ├── shell.ts   # Full shell (pipes, redirects, &&/||, globs, variables)
│   ├── awk.ts     # Full AWK implementation
│   ├── sed.ts
│   ├── cat.ts, head.ts, tail.ts, wc.ts, sort.ts, uniq.ts, ...
│   └── ...
├── lib/
│   ├── shell/     # Command parsing, glob expansion
│   ├── awk/       # AWK lexer, parser, interpreter
│   ├── args.ts    # Argument parsing
│   └── format.ts  # Output formatting
└── spec/          # Tests
```

**Missing utilities:**
- `grep` - text search
- `sql` - SQLite CLI (needed for agent memory)

### rom/lib/process/ (Internal)

The current process library uses **byte-based I/O**:

```typescript
// Current approach - byte streams
const fd = await open('/file');
for await (const chunk of read(fd)) {  // yields Uint8Array
    // process bytes
}
await write(fd, bytes);
await close(fd);
```

**Usage**: Almost nothing. Only `rom/svc/init.ts` and `rom/bin/true.ts`/`false.ts` use it, and they only use `exit()`, `wait()`, `sleep()`, `println()`.

### os-coreutils Expects Message-Based I/O

```typescript
// os-coreutils approach - message streams
for await (const msg of recv(0)) {  // yields Response objects
    if (msg.op === 'item') { ... }
    if (msg.op === 'done') break;
}
await send(1, respond.item({ text: line }));
await send(1, respond.done());
```

This aligns with how the dispatcher already works - it yields `Response` objects with `op` fields.

---

## The Mismatch

| Aspect | rom/lib/process/ | os-coreutils expects |
|--------|------------------|---------------------|
| I/O model | Byte streams (`Uint8Array`) | Message streams (`Response`) |
| Read | `read(fd)` → `AsyncIterable<Uint8Array>` | `recv(fd)` → `AsyncIterable<Response>` |
| Write | `write(fd, bytes)` | `send(fd, Response)` |
| Response creation | N/A | `respond.item()`, `respond.done()`, `respond.error()` |
| Helpers | N/A | `ByteReader`, `readText()`, `readdirAll()` |

**Key insight**: The dispatcher already uses messages (`{ op: 'item', data }`, `{ op: 'done' }`, etc.). The byte-based layer in `rom/lib/process/` was never actually adopted.

---

## Design

### Message-First I/O

Standardize on message-based I/O throughout:

```typescript
// stdin: receive messages
for await (const msg of recv(0)) {
    if (msg.op === 'item') {
        const { text } = msg.data;
        // process text
    }
    if (msg.op === 'done') break;
}

// stdout: send messages
await send(1, respond.item({ text: 'hello' }));
await send(1, respond.done());

// File I/O: still uses open/read/write/close but yields messages
const fd = await open('/file');
for await (const msg of read(fd)) {
    if (msg.op === 'data') {
        const bytes = msg.bytes;  // Uint8Array for binary
    }
}
```

### Response Helpers

```typescript
const respond = {
    ok: (data?) => ({ op: 'ok', data }),
    error: (code, message) => ({ op: 'error', data: { code, message } }),
    item: (data) => ({ op: 'item', data }),
    data: (bytes) => ({ op: 'data', bytes }),
    done: () => ({ op: 'done' }),
};
```

### Pipeline Composition

Messages enable clean pipeline composition:

```
echo "hello" | cat | wc -c
     │         │      │
     │         │      └─ recv(0) → count items → send(1, respond.item({count}))
     │         └─ recv(0) → pass through → send(1, msg)
     └─ send(1, respond.item({text: "hello"})) → send(1, respond.done())
```

---

## Directory Structure (Post-Repatriation)

```
rom/
├── bin/
│   ├── shell.ts       # From os-coreutils
│   ├── awk.ts         # From os-coreutils
│   ├── cat.ts         # From os-coreutils
│   ├── grep.ts        # NEW - text search
│   ├── sql.ts         # NEW - SQLite CLI for agents
│   ├── true.ts        # Existing
│   ├── false.ts       # Existing
│   └── ... (38 more)
├── lib/
│   ├── process/       # REWRITE - message-based
│   │   ├── index.ts   # Main exports
│   │   ├── syscall.ts # Transport (keep existing)
│   │   ├── respond.ts # Response helpers (NEW)
│   │   └── types.ts   # Types
│   ├── shell/         # From os-coreutils
│   ├── awk/           # From os-coreutils
│   ├── args.ts        # From os-coreutils
│   └── format.ts      # From os-coreutils
├── svc/
│   └── init.ts        # Existing (update imports)
└── etc/
```

---

## Implementation Phases

### Phase 1: Prepare rom/lib/process/

1. Add `respond` helpers (response constructors)
2. Add `recv(fd)` - yields `Response` messages from fd
3. Add `send(fd, msg)` - writes `Response` message to fd
4. Add convenience helpers: `readdirAll()`, `readText()`, `ByteReader`
5. Keep existing functions that init.ts uses: `exit`, `wait`, `onSignal`, `sleep`, `getpid`
6. Update `println`/`eprintln` to use message-based output

### Phase 2: Copy os-coreutils

1. Copy `bin/*.ts` to `rom/bin/`
2. Copy `lib/shell/` to `rom/lib/shell/`
3. Copy `lib/awk/` to `rom/lib/awk/`
4. Copy `lib/args.ts`, `lib/format.ts` to `rom/lib/`
5. Copy `spec/` tests to appropriate location

### Phase 3: Update Imports

1. Change `@rom/lib/process` imports to relative paths or update tsconfig
2. Verify all utilities compile
3. Run tests

### Phase 4: Add Missing Utilities

1. Implement `grep.ts` - text pattern search
2. Implement `sql.ts` - SQLite CLI for agent memory access

### Phase 5: Cleanup

1. Archive or delete `@monk-api/os-coreutils` repo
2. Remove unused byte-based functions from process lib
3. Update documentation

---

## Open Questions

### 1. Import Paths

os-coreutils uses `@rom/lib/process`. Options:

| Option | Notes |
|--------|-------|
| tsconfig paths | Add `@rom` → `./rom` mapping |
| Relative imports | Change all imports to `../../lib/process` |
| Keep @rom | If rom/ becomes a separate package in monorepo |

### 2. Test Location

Where do coreutils tests go?

| Option | Notes |
|--------|-------|
| `spec/rom/` | Mirror rom/ structure |
| `rom/spec/` | Keep tests with code |
| `spec/bin/`, `spec/lib/` | Flat structure |

### 3. Binary Data

How should binary file I/O work with message model?

| Option | Notes |
|--------|-------|
| `op: 'data'` with `bytes` | Current approach, explicit binary |
| Separate `readBytes()`/`writeBytes()` | Different API for binary |
| Always messages, encode binary | Base64 or similar (inefficient) |

Recommendation: Keep `op: 'data'` with `bytes: Uint8Array` for binary chunks.

---

## References

- `@monk-api/os-coreutils/` - Source repo for utilities
- `rom/lib/process/` - Current process library (to be updated)
- `src/gateway/gateway.ts` - Gateway protocol (already message-based)
- `docs/planning/OS_AI.md` - AI agents need shell/coreutils (Phase 2)
