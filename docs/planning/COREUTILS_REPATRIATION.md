# Coreutils Repatriation

> **Status**: In Progress
> **Complexity**: Medium
> **Dependencies**: None (enables OS_AI Phase 2)

Bring os-coreutils back into the main OS repo under `rom/`.

---

## Progress

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Copy os-coreutils bin/ and lib/ | **COMPLETE** |
| Phase 2 | Implement rom/lib/process/ | **COMPLETE** |
| Phase 3 | Update imports, verify compilation | **COMPLETE** |
| Phase 4 | Add missing utilities (grep, sql) | Not started |
| Phase 5 | Cleanup and documentation | Not started |

### Completed Work

1. Deleted old byte-based `rom/lib/process/` (never used)
2. Copied 42 utilities from `os-coreutils/bin/` to `rom/bin/`
3. Copied utility libraries from `os-coreutils/lib/`:
   - `args.ts` - Argument parsing
   - `format.ts` - Output formatting
   - `glob.ts` - Glob utilities
   - `shell.ts` - Shell re-export
   - `awk/` - Full AWK implementation
   - `shell/` - Shell parsing and glob expansion
4. Created `rom/lib/process/README.md` with API specification
5. Implemented `rom/lib/process/` (Phase 2):
   - `types.ts` - Response protocol, wire format, domain types, error classes
   - `respond.ts` - Response factory helpers
   - `syscall.ts` - Transport layer (postMessage, UUID correlation, backpressure)
   - `index.ts` - 38 function wrappers + ByteReader class
6. Phase 3 - Updated imports and verified compilation:
   - Created separate `tsconfig.rom.json` (no @src/* access - enforces kernel/userspace boundary)
   - Created `rom/lib/path.ts` for path utilities
   - Fixed all 42 utilities to use new process library API:
     - `DirEntry` is now `{name, model}` object (not string)
     - `onSignal()` callback takes no args (registers for SIGTERM by default)
     - `outputRedirect()` returns `{fd, saved}` (use `restore()` to cleanup)
     - `access()` returns `Grant[]` directly (no wrapper object)
     - `mtime`/`ctime` are numbers (ms since epoch, not Date objects)
     - `readText()` takes path, stdin uses `recv(0)` for messages

---

## Background

### The Diaspora

Originally, userspace utilities lived in `rom/` as part of the OS project. Then came a split:

1. **Separation**: Userspace moved to `@monk-api/os-coreutils` as a separate project
2. **Rationale**: Clean separation between kernel and userspace, communicate via gateway API
3. **Result**: 42 utilities developed independently, including full shell with pipes/redirects/globs

### The Return

AI agents (see `OS_AI.md`) are userspace processes that need shell and coreutils to function. With AI as a core OS feature, coreutils belongs back in the main repo.

---

## Current State (Post Phase 1)

```
rom/
├── bin/                    # 42 utilities (from os-coreutils)
│   ├── shell.ts            # Full shell (pipes, redirects, &&/||, globs, variables)
│   ├── awk.ts              # Full AWK implementation
│   ├── cat.ts, head.ts, tail.ts, wc.ts, sort.ts, uniq.ts, ...
│   └── ...
├── lib/
│   ├── process/            # TO BE IMPLEMENTED
│   │   └── README.md       # API specification
│   ├── args.ts             # Argument parsing (from os-coreutils)
│   ├── format.ts           # Output formatting (from os-coreutils)
│   ├── glob.ts             # Glob utilities (from os-coreutils)
│   ├── shell.ts            # Shell re-export (from os-coreutils)
│   ├── errors.ts           # Error types (existing)
│   ├── awk/                # AWK lexer, parser, interpreter (from os-coreutils)
│   └── shell/              # Command parsing, glob expansion (from os-coreutils)
├── svc/
│   └── init.ts             # PID 1 (needs update for new process lib)
└── etc/
```

---

## Process Library Design

### Architecture

The kernel's syscall layer (`src/syscall/`) already handles complexity:
- Domain-organized syscall handlers (vfs.ts, process.ts, ems.ts, etc.)
- Argument validation
- Error handling
- Stream backpressure via StreamController

The userland process library is **thin wrappers** over postMessage:

```typescript
// The only complex part - syscall transport
function syscall(name, ...args): AsyncIterable<Response> {
    // postMessage + UUID correlation + stream handling
}

// Everything else is one-liners
export function open(path, flags) {
    return unwrap(syscall('file:open', path, flags));
}
```

### File Structure

```
rom/lib/process/
├── index.ts      # All 38 functions + re-exports (organized by section comments)
├── types.ts      # Response, Stat, Grant, OpenFlags, etc.
├── respond.ts    # respond.ok(), respond.item(), respond.done(), respond.error()
└── syscall.ts    # Transport: postMessage, UUID correlation, stream iteration, signals
```

**Rationale:**
- Kernel's syscall layer already does domain separation - no need to duplicate
- Userland wrappers are one-liners - splitting into 8 files adds import overhead without benefit
- `syscall.ts` is the only file with real logic (~200 lines)
- `index.ts` is ~400 lines of thin wrappers, organized with section comments

### Required Exports (from bin/ audit)

#### Functions (38)

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
| **Access Control** | `access`, `symlink` |

#### Types (3)

| Type | Purpose |
|------|---------|
| `Response` | Message protocol (`{ op, data?, bytes? }`) |
| `Stat` | File metadata |
| `Grant` | ACL permissions |

---

## Message-Based Architecture

All process communication is **message-based**, not byte-based. This is a fundamental departure from traditional Unix.

### Unix vs Monk OS

| Aspect | Unix | Monk OS |
|--------|------|---------|
| I/O unit | Byte streams | Response messages |
| Structure | None (parse bytes) | Self-describing (`op` field) |
| End of stream | EOF (implicit) | `done` message (explicit) |
| Errors | Out-of-band | `error` message in stream |
| Stdin/stdout | `read()`/`write()` bytes | `recv()`/`send()` messages |

### The Response Protocol

```typescript
interface Response {
    op: 'ok' | 'error' | 'item' | 'data' | 'done' | 'event' | 'progress';
    data?: unknown;
    bytes?: Uint8Array;  // only for 'data' op
}
```

| Op | Meaning | Terminal? |
|----|---------|-----------|
| `ok` | Success with optional value | Yes |
| `error` | Failure with code/message | Yes |
| `item` | One item in a sequence | No |
| `data` | Binary chunk (file reads) | No |
| `done` | Sequence complete | Yes |

### Standard File Descriptors

| fd | Unix Name | Monk Name | I/O Model |
|----|-----------|-----------|-----------|
| 0 | stdin | recv | `recv(0)` → messages |
| 1 | stdout | send | `send(1, msg)` |
| 2 | stderr | warn | `send(2, msg)` |

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

## Implementation Details

### syscall.ts - Transport Layer

Core responsibilities:
- `postMessage` to kernel with UUID correlation
- Response stream iteration (handle `item`, `data`, `done`, `error`)
- Backpressure protocol (`stream_ping`, `stream_cancel`)
- Signal handling (`onSignal`, default SIGTERM behavior)

```typescript
// Pending request map for correlation
const pending = new Map<string, { resolve, reject, stream? }>();

// Message handler
self.onmessage = (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'response': // Route to pending request
        case 'signal':   // Invoke signal handler
        case 'stream_ping': // Backpressure ack
    }
};

// Core syscall function - returns AsyncIterable<Response>
export function syscall(name: string, ...args: unknown[]): AsyncIterable<Response>;

// Convenience wrappers
export async function call<T>(name, ...args): Promise<T>;      // Single value
export async function collect<T>(name, ...args): Promise<T[]>; // Collect items
```

### types.ts - Type Definitions

```typescript
// Wire format
export interface SyscallRequest {
    type: 'syscall';
    id: string;
    pid: string;
    name: string;
    args: unknown[];
}

export interface SyscallResponse {
    type: 'response';
    id: string;
    result?: Response;
}

export interface SignalMessage {
    type: 'signal';
    signal: number;
}

// Domain types
export interface Response {
    op: 'ok' | 'error' | 'item' | 'data' | 'done' | 'event' | 'progress';
    data?: unknown;
    bytes?: Uint8Array;
}

export interface Stat {
    id: string;
    model: string;
    name: string;
    parent: string | null;
    owner: string;
    size: number;
    mtime: Date;
    ctime: Date;
}

export interface Grant {
    to: string;
    ops: string[];
    expires?: number;
}

export interface OpenFlags {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
}
```

### respond.ts - Response Helpers

```typescript
export const respond = {
    ok: (data?: unknown) => ({ op: 'ok' as const, data }),
    error: (code: string, message: string) => ({
        op: 'error' as const,
        data: { code, message }
    }),
    item: (data: unknown) => ({ op: 'item' as const, data }),
    data: (bytes: Uint8Array) => ({ op: 'data' as const, bytes }),
    done: () => ({ op: 'done' as const }),
};
```

### index.ts - Function Wrappers

Organized by section:

```typescript
// =============================================================================
// RE-EXPORTS
// =============================================================================
export * from './types.js';
export { respond } from './respond.js';
export { onSignal } from './syscall.js';

// =============================================================================
// CONSTANTS
// =============================================================================
export const SIGTERM = 15;
export const SIGKILL = 9;

// =============================================================================
// FILE OPERATIONS
// =============================================================================
export function open(path: string, flags?: OpenFlags): Promise<number> {
    return call('file:open', path, flags ?? { read: true });
}

export function close(fd: number): Promise<void> {
    return call('file:close', fd);
}

export async function* read(fd: number): AsyncIterable<Uint8Array> {
    for await (const r of syscall('file:read', fd)) {
        if (r.op === 'data' && r.bytes) yield r.bytes;
        else if (r.op === 'done') return;
        else if (r.op === 'error') throw toError(r);
    }
}

// ... (stat, rename, unlink, copyFile)

// =============================================================================
// MESSAGE I/O (stdin/stdout)
// =============================================================================
export async function* recv(fd: number): AsyncIterable<Response> {
    yield* syscall('file:recv', fd);
}

export function send(fd: number, msg: Response): Promise<void> {
    return call('file:send', fd, msg);
}

// =============================================================================
// CONSOLE I/O
// =============================================================================
export async function print(text: string): Promise<void> {
    await send(1, respond.item({ text }));
}

export async function println(text: string): Promise<void> {
    await send(1, respond.item({ text: text + '\n' }));
}

export async function eprintln(text: string): Promise<void> {
    await send(2, respond.item({ text: text + '\n' }));
}

// =============================================================================
// DIRECTORY OPERATIONS
// =============================================================================
// mkdir, rmdir, readdirAll

// =============================================================================
// FILE HELPERS
// =============================================================================
// readFile, readFileBytes, readText, head, ByteReader class

// =============================================================================
// PROCESS OPERATIONS
// =============================================================================
// exit, spawn, wait, getpid, getargs

// =============================================================================
// ENVIRONMENT
// =============================================================================
// getcwd, chdir, getenv, setenv

// =============================================================================
// SIGNALS
// =============================================================================
// sleep (re-export onSignal from syscall.ts)

// =============================================================================
// PIPES
// =============================================================================
// pipe, redirect, outputRedirect

// =============================================================================
// ACCESS CONTROL
// =============================================================================
// access, symlink
```

---

## Remaining Work

### Phase 2: Implement rom/lib/process/

1. Create `types.ts` with all type definitions
2. Create `respond.ts` with response helpers
3. Create `syscall.ts` with transport layer
4. Create `index.ts` with all 38 function wrappers
5. Test basic compilation

### Phase 3: Update Imports

1. Configure tsconfig paths: `@rom` → `./rom`
2. Verify all 42 utilities compile
3. Update `rom/svc/init.ts` for new API
4. Run existing tests

### Phase 4: Add Missing Utilities

1. `grep.ts` - Text pattern search (regex support)
2. `sql.ts` - SQLite CLI for agent memory access

### Phase 5: Cleanup

1. Archive `@monk-api/os-coreutils` repo
2. Update AGENTS.md with new rom/ structure
3. Add tests for process library

---

## Open Questions

### 1. Import Paths

os-coreutils uses `@rom/lib/process`. Options:

| Option | Notes |
|--------|-------|
| **tsconfig paths** | Add `@rom` → `./rom` mapping (recommended) |
| Relative imports | Change all imports to `../../lib/process` |

### 2. Test Location

| Option | Notes |
|--------|-------|
| **`spec/rom/`** | Mirror rom/ structure (recommended) |
| `rom/spec/` | Keep tests with code |

### 3. ByteReader Implementation

The `ByteReader` class is used by several utilities. Options:

| Option | Notes |
|--------|-------|
| Port from os-coreutils | If it exists there |
| Implement fresh | Simple wrapper over async iteration |

---

## References

- `rom/lib/process/README.md` - Detailed API specification
- `src/syscall/` - Kernel syscall layer (already implemented)
- `docs/implemented/OS_SYSCALL_LAYER.md` - Syscall architecture
- `docs/implemented/OS_PROCESS.md` - Original process library design
- `docs/implemented/OS_PROCESS_IO.md` - ProcessIOHandle (kernel-side)
