# Monk OS

A Plan 9/BeOS-inspired operating system where **Bun is the hardware**.

The single-executable deployment (`bun build --compile`) isn't packaging an app—it's burning firmware.

## Core Design

- **Everything is a file**: Uniform namespace following Plan 9's paradigm
- **Files are queryable**: BeOS-style database-centric filesystem—files have UUIDs, are indexed, queryable
- **Process isolation**: Each process is a Bun Worker with isolated memory
- **Message-driven**: All internal communication uses structured `Message`/`Response` objects—no JSON serialization in the kernel
- **Streams-first**: Default API is `AsyncIterable<Response>`, not arrays

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Userland (rom/bin/*, services)                             │
├─────────────────────────────────────────────────────────────┤
│  Process Library & Syscall API (rom/lib/process/)           │
├─────────────────────────────────────────────────────────────┤
│  OS Public API (boot, exec, syscall wrappers, helpers)      │
├─────────────────────────────────────────────────────────────┤
│  Syscall Layer (dispatcher, stream controller, handlers)    │
├─────────────────────────────────────────────────────────────┤
│  Kernel (processes, handles, worker pools, services)        │
├─────────────────────────────────────────────────────────────┤
│  VFS - Virtual File System (models: file, folder, device,   │
│        proc, link)                                          │
├─────────────────────────────────────────────────────────────┤
│  EMS - Entity Model System (database abstraction, observer  │
│        pipeline, streaming queries)                         │
├─────────────────────────────────────────────────────────────┤
│  HAL - Hardware Abstraction (14 device interfaces)          │
├─────────────────────────────────────────────────────────────┤
│  Bun Runtime                                                │
└─────────────────────────────────────────────────────────────┘
```

## Key Abstractions

**HAL Devices**: Block storage, network, timers, clock, entropy, crypto, console, DNS, host escape, IPC, channels, compression, file (host filesystem access).

**Handle Types**: Unified I/O via `exec(msg) → AsyncIterable<Response>`:
- `file` - VFS files, folders, devices
- `socket` - TCP connections
- `pipe` - Message-based inter-process pipes
- `port` - Listeners, watchers, pubsub
- `channel` - Protocol-aware (HTTP, WebSocket, PostgreSQL)

**Response Ops**: `ok`, `error`, `item`, `data`, `event`, `progress`, `done`, `redirect`—terminal vs streaming semantics baked in.

## Kernel Architecture

The kernel is **message-pure**—structured objects flow between components, never serialized until they hit a true I/O boundary (disk, network).

**Process Model**:
- Each process is a Bun Worker with UUID identity (not integer PIDs)
- Process states: `starting → running → stopped → zombie`
- File descriptors (0-255) map to kernel handle UUIDs per-process
- Standard fds: `0=recv` (messages in), `1=send` (messages out), `2=warn` (diagnostics)

**Syscall Layer** (separate from kernel):
- `SyscallDispatcher` sits outside kernel, receives `(kernel, vfs, ems, hal)` as dependencies
- Switch-based routing for O(1) syscall lookup
- `StreamController` wraps each syscall for backpressure management
- Domain handlers: vfs, ems, hal, process, handle, pool

**Syscall Execution**:
- Syscalls are async generators: `syscall(args) → AsyncIterable<Response>`
- Each `Response` yields independently—no buffering to arrays
- Terminal ops (`ok`, `error`, `done`) signal stream end
- Non-terminal ops (`item`, `data`, `event`) can yield indefinitely

**Multiplexed Streaming**:
- Multiple concurrent syscalls per process, each with unique stream ID
- Dispatcher routes responses to correct stream via `postMessage`
- Backpressure via `stream_ping` every 100ms—pauses at high-water mark
- Stalled streams (no ping for 5s) are aborted

**Worker Pools**:
- Named pools (`freelance`, `compute`) with min/max scaling
- Lease/release model—workers are reusable across invocations
- Idle timeout returns workers to pool, shrinks under low pressure

## Notable Features

**Protocol Channels**: HTTP, WebSocket, PostgreSQL, and SSE abstracted behind a unified `channel` interface. Userland never sees wire protocols—just `send(msg)` and `recv()`. The kernel handles framing, encoding, and connection lifecycle.

**VFS Module Loader**: TypeScript/ESM loaded directly from VFS paths, transpiled on demand. `import '@app/foo'` resolves against the virtual filesystem, not the host. Hot-swappable code without touching the host disk.

**Capability-Based Permissions**: No UNIX rwx bits. Handles are capabilities—if you have the handle, you have permission. Access is granted at `open()` time; the handle itself is the proof of authorization.

**Message Pipes**: Inter-process pipes carry `Response` objects, not byte streams. Structured data flows natively between processes. No serialization overhead inside the kernel—the `item` you `send()` is the `item` the other process `recv()`s.

## Usage

```typescript
import { OS } from '@monk-api/os';

const os = new OS();
await os.boot();

// Mount host directory into VFS
await os.mount('host', './src', '/vol/app');
```

**Headless** — boot and return control to your app:

```typescript
await os.boot();

// Read files
const config = await os.text('/etc/config.json');

// Use syscalls for writes
await os.vfs('write', fd, new TextEncoder().encode(data));

await os.shutdown();
```

**Hybrid** — boot with init, keep control:

```typescript
await os.boot({ main: '/vol/app/init.ts' });

// init runs in a Worker, your app continues
const pid = await os.spawn('/bin/ps');
```

**Takeover** — OS owns the process:

```typescript
await os.exec({ main: '/vol/app/init.ts' });
// never returns (until init exits)
```

Takeover is the `bun build --compile` path—your app becomes the OS.

## ROM Utilities

45+ UNIX-like commands in `rom/bin/`: cat, ls, cp, mv, rm, mkdir, grep, sed, awk, sort, uniq, head, tail, wc, chmod, stat, etc.

Streaming utilities use message-based I/O—`recv(0)` for stdin, `send(1, msg)` for stdout.

## Status

**Overall Completeness: ~95%** — Production-ready for single-node (SQLite) or distributed (PostgreSQL) use.

| Component | Status | Notes |
|-----------|--------|-------|
| Syscall Layer | 100% | Complete migration to src/syscall/, dispatcher outside kernel |
| Kernel/Core | 95% | Process lifecycle, handle management, worker pools |
| Process Mgmt | 95% | UUID/PID, signals, parent-child, worker isolation |
| VFS | 95% | Plan 9 "everything is a file", hybrid EMS/HAL storage |
| EMS | 95% | 8-ring observer pipeline, streaming queries |
| IPC | 90% | Pipes, ports, channels, shared memory (mutex/semaphore) |
| Networking | 85% | TCP/UDP, HTTP/WS, PostgreSQL/SQLite channels |
| HAL Devices | 95% | 14 devices: SQLite + PostgreSQL storage backends |
| Boot | 95% | ROM bootstrap, service activation, lifecycle events |

**Storage Backends**:
- **SQLite** — Embedded, single-node, WAL mode for concurrent reads
- **PostgreSQL** — Distributed, multi-node, full MVCC concurrency

**VFS Architecture**: File/Folder use EMS (SQL). Device/Proc/Link use HAL KV (virtual by design).

See `AGENTS.md` for detailed technical documentation.

## License

Source-available under [Polyform Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). See [LICENSE.md](LICENSE.md).
