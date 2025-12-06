# Monk OS - Architectural Thesis

## Executive Summary

Monk OS should evolve from a self-contained operating system with bundled userland into a **kernel with internal services** that external applications consume via syscalls. The kernel's Worker-based process system remains valuable for **kernel services** (logd, authd, gatewayd), while **user applications** (shell, display, utilities) run externally and connect via Unix socket.

This enables clean separation between kernel infrastructure and user-facing applications, allowing rapid iteration on UI/UX without touching core OS code.

---

## Current State

The OS currently bundles everything:

```
os/
├── src/           # Kernel (hal, vfs, ems, kernel, os)
├── rom/
│   ├── lib/       # Syscall wrappers (process library)
│   ├── bin/       # 45+ UNIX utilities (cat, ls, shell, etc.)
│   └── etc/       # Configuration
├── src/display/   # Display server (proof of concept)
└── packages/display-client/  # Browser UI
```

Problems:
1. **Display server in kernelspace** - `src/display/` runs alongside kernel internals
2. **Mixed concerns in rom/bin** - Kernel services (logd) alongside user utilities (cat, ls)
3. **No external access** - Only Workers can make syscalls (postMessage transport)
4. **Tight coupling** - Display, shell, and kernel evolve together

---

## Proposed Architecture

### Core Principle

The OS runs **kernel services** as internal Workers, and exposes syscalls to **external applications** via `gatewayd`. Internal Workers and external apps use the same syscall interface - only the transport differs.

```
┌─────────────────────────────────────────────────────────────┐
│  Host (macOS/Linux)                                         │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ shell    │  │ your app │  │ displayd │  │ other apps  │ │
│  │ (external)│  │(external)│  │(external)│  │ (external)  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
│       │             │             │               │         │
│       └─────────────┴──────┬──────┴───────────────┘         │
│                            │                                │
│                    Unix socket (/tmp/monk.sock)             │
│                            │                                │
│  ┌─────────────────────────┴─────────────────────────────┐  │
│  │                         OS                            │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Kernel Services (Workers)                      │  │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │  │  │
│  │  │  │ gatewayd │ │  logd    │ │  authd   │  ...   │  │  │
│  │  │  └──────────┘ └──────────┘ └──────────┘        │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Kernel (syscall dispatch, process mgmt)        │  │  │
│  │  ├─────────────────────────────────────────────────┤  │  │
│  │  │  VFS          │  EMS (+ display entities)       │  │  │
│  │  ├─────────────────────────────────────────────────┤  │  │
│  │  │  HAL (storage, network, crypto, etc.)           │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Package Decomposition

| Package | Role | Dependencies |
|---------|------|--------------|
| `@monk-api/os` | Kernel + kernel services + gatewayd | None |
| `@monk-api/os-sdk` | Syscall SDK for external apps | None (types only) |
| `@monk-api/os-coreutils` | User utilities (ls, cat, grep, etc.) | os-sdk |
| `@monk-api/os-shell` | Interactive shell / TTY | os-sdk, os-coreutils |
| `@monk-api/displayd` | WebSocket ↔ OS syscall bridge | os-sdk |
| `@monk-api/displayd-client` | Browser rendering, event capture | displayd |

Release cadence flows downstream: OS → os-sdk → displayd / os-coreutils → displayd-client / os-shell

---

## Key Decisions

### 1. Kernel Services vs. User Applications

**Kernel services** (run inside OS as Workers):
- Boot-critical, always-on functionality
- Tightly coupled to kernel lifecycle
- Low-latency access to kernel internals
- Examples: `gatewayd`, `logd`, `authd`, `scheduled`, `watchd`

**User applications** (run outside OS as host processes):
- User-facing, connect/disconnect freely
- Iterate rapidly without kernel changes
- May have multiple implementations
- Examples: `shell`, `displayd`, `cat`, `ls`, your apps

The OS package contains:

```
os/
├── src/               # Kernel, HAL, VFS, EMS, OS public API
├── rom/
│   ├── lib/           # Syscall SDK (for internal Workers)
│   ├── svc/           # Kernel services (gatewayd, logd, authd, etc.)
│   └── etc/           # Configuration (mounts.json, pools.json)
```

**Rationale**: The Worker infrastructure isn't wasted. Kernel services belong inside the OS where they have privileged access. User utilities and apps belong outside where they can iterate independently.

### 2. gatewayd - The Bridge

`gatewayd` is a kernel service (Worker) that exposes syscalls over Unix socket:

```
External app → Unix socket → gatewayd (Worker) → kernel syscalls
```

- Runs as a Worker inside OS (in rom/svc/)
- Listens on Unix socket (default: `/tmp/monk.sock`)
- Each connection becomes a "virtual process" with its own handle table
- Proxies syscalls to kernel, streams responses back

**Rationale**: External access is provided by a kernel service, not by modifying the kernel itself. gatewayd is just another service that happens to bridge transports.

### 3. os-sdk - External Syscall SDK

`@monk-api/os-sdk` mirrors `rom/lib/` for external applications:

```typescript
// External app using os-sdk
import { open, readFile, mkdir } from '@monk-api/os-sdk';

const data = await readFile('/etc/config.json');
await mkdir('/var/logs');
```

Same API as `rom/lib/`, different transport:
- `rom/lib/` uses postMessage (for Workers)
- `os-sdk` uses Unix socket via gatewayd (for external apps)

**Rationale**: One API to learn. Internal and external processes use identical interfaces. The transport is an implementation detail.

### 4. Display Entities Live in OS (Model B)

The EMS schema includes display-related models:
- `display` - Browser session
- `window` - Application window
- `element` - DOM-like tree nodes
- `event` - Input events
- `cursor` - Mouse state
- `selection` - Text selection

displayd does NOT own these entities. It's a thin relay that:
1. Connects to OS via gatewayd (Unix socket)
2. Accepts WebSocket connections from browsers
3. Translates WebSocket messages → `ems:*` syscalls
4. Pushes entity changes back to browsers

**Rationale**:
- OS processes can create/query windows via standard syscalls
- Window ownership tied to process lifecycle (kill process → close windows)
- Uniform entity model - windows are just entities like files
- Single source of truth in OS database

### 5. displayd is a Thin Relay

displayd runs as an external host process. It:
- Connects to OS via os-sdk (Unix socket → gatewayd)
- Opens WebSocket server for browsers
- Bridges protocol: WebSocket ↔ syscalls

```typescript
// Browser sends: { op: 'window:create', data: { title: 'My App', ... } }
// displayd translates to syscall:
import { call } from '@monk-api/os-sdk';

await call('ems:create', 'window', {
    display_id: displayId,
    title: 'My App',
    ...
});
```

**Rationale**: Keeps kernel simple. displayd is just another external app that happens to speak WebSocket. Could be replaced or have multiple implementations.

### 6. displayd-client Iterates Independently

displayd-client contains all browser UI:
- Window chrome and controls
- Desktop environment (taskbar, launcher, wallpaper)
- File manager views
- Terminal/shell UI
- Canvas for games/graphics
- Settings panels
- Themes, animations, accessibility

**Rationale**: Display infrastructure (displayd) is stable like a display server. UI/UX (displayd-client) iterates rapidly like a desktop environment. Different release cadences justify separate packages.

### 7. os-coreutils and os-shell are External

User utilities move to `@monk-api/os-coreutils`:
- Run as external host processes
- Import `@monk-api/os-sdk` for syscalls
- Can be used as executables (shell spawns them)
- Can be used as library (shell imports and calls directly)

os-shell provides interactive access:
- Connects to OS via os-sdk
- Parses commands, executes utilities
- Spawns utilities as host subprocesses or calls in-process

**Rationale**: User utilities don't need privileged kernel access. They're clients of the OS, not part of it. Mirrors Linux - kernel is separate from coreutils.

---

## Syscall Interface

External apps (via os-sdk) and internal Workers (via rom/lib) use the same syscalls:

### File Operations (VFS)
```typescript
const fd = await open('/var/data/file.txt', { read: true });
const data = await readFile('/etc/config.json');
await mkdir('/var/logs');
for await (const entry of readdir('/home')) { ... }
```

### Entity Operations (EMS)
```typescript
const window = await call('ems:create', 'window', { title: 'My App', ... });
const windows = await collect('ems:select', 'window', { where: { display_id } });
await call('ems:update', 'window', id, { x: 100, y: 200 });
await call('ems:delete', 'window', id);
```

### Network Operations
```typescript
const fd = await call('net:connect', 'tcp', 'example.com', 80);
const portFd = await call('port:create', 'tcp:listen', { port: 8080 });
const { from, socketFd } = await call('port:recv', portFd);
```

### Process Operations
```typescript
const pid = await spawn('/svc/worker.ts', { args: ['--flag'] });
const status = await wait(pid);
await call('proc:setenv', 'DEBUG', '1');
```

---

## Migration Path

### Dependency Graph

```
Phase 1: Reorganize rom/
    │
    ▼
Phase 2: Implement gatewayd
    │
    ▼
Phase 3: Create os-sdk
    │
    ├────────────────────┬────────────────────┐
    ▼                    ▼                    ▼
Phase 4:             Phase 5:             Phase 6:
Display schema       os-coreutils         (parallel work)
    │                    │
    ▼                    ▼
Phase 7:             Phase 8:
Fix displayd         os-shell
    │
    ▼
Phase 8:
Fix displayd-client
    │
    ▼
Phase 9: Cleanup & OS 1.0
```

**Critical path**: Phases 1-3. Once gatewayd + os-sdk work, everything else unblocks.

---

### Phase 1: Reorganize rom/
- Rename `rom/bin/` → `rom/svc/` for kernel services
- Keep only kernel services: logd, init (if needed)
- Move user utilities out (prepare for os-coreutils)
- Move `spec/rom/bin/*` tests out (will go to os-coreutils)

### Phase 2: Implement gatewayd
- Create `rom/svc/gatewayd.ts` - Unix socket listener
- Accept connections, create virtual process context
- Proxy syscalls to kernel, stream responses
- Boot gatewayd as a kernel service
- Test: can external process connect and make syscall?

### Phase 3: Create os-sdk
- Create `@monk-api/os-sdk` package
- Mirror `rom/lib/` API with Unix socket transport
- Connect to gatewayd, same message format as Workers
- Publish package
- Test: external process → gatewayd → kernel → response

**────── External apps now possible ──────**

### Phase 4: Display schema (parallel with 5, 6)
- Move `schema.sql` entities into OS EMS schema
- Display/window/element/event/cursor/selection models
- Available via `ems:*` syscalls
- Test: can create/query display entities via syscalls?

### Phase 5: os-coreutils (parallel with 4, 6)
- Create `@monk-api/os-coreutils` package
- Move utilities from `rom/bin/` (cat, ls, grep, awk, etc.)
- Move tests from `spec/rom/bin/`
- Import `@monk-api/os-sdk` for syscalls
- Work as both executables and importable library

### Phase 6: Other parallel work
- Any kernel service development (authd, scheduled, etc.)
- Documentation updates
- Performance testing

### Phase 7: Fix displayd (after Phase 4)
- Initialize `@monk-api/displayd` package (already extracted)
- Add package.json, tsconfig, etc.
- Import `@monk-api/os-sdk`, connect via gatewayd
- WebSocket server for browsers
- Bridge: WebSocket messages ↔ `ems:*` syscalls

### Phase 8: Fix displayd-client + os-shell
- **displayd-client** (after Phase 7):
  - Initialize `@monk-api/displayd-client` package
  - Connect to displayd WebSocket
  - Render windows, capture events

- **os-shell** (after Phase 5):
  - Create `@monk-api/os-shell` package
  - Interactive REPL using os-coreutils
  - Command parsing, job control, history

### Phase 9: Cleanup & Release
- Remove extracted code from OS (already done for display)
- Update AGENTS.md documentation
- Final test pass
- Tag OS 1.0 release

---

## Benefits

1. **Workers aren't wasted** - Kernel services run as Workers where they belong
2. **Clean separation** - Kernel services vs. user applications
3. **External app development** - Regular Bun/Node apps using os-sdk
4. **Independent iteration** - UI/utilities evolve without kernel changes
5. **Multiple frontends** - Different shells, different desktop environments
6. **Testability** - Each package tested in isolation
7. **Focused kernel** - OS package contains only kernel + services

---

## Open Questions

1. **Authentication** - How do gatewayd connections prove identity? Unix socket peer credentials? Tokens?

2. **Session management** - Each gatewayd connection is a "virtual process"? Explicit session creation?

3. **Handle passing** - Can file descriptors be passed over Unix socket (SCM_RIGHTS)? Or handle IDs only?

4. **Service discovery** - How do external apps find gatewayd? Fixed path? Environment variable? mDNS?

5. **Schema migrations** - Display entities in OS schema. How to version/migrate when displayd evolves?

6. **os-sdk packaging** - Should os-sdk include type definitions only, or also runtime? Dual package (types + runtime)?

---

## Conclusion

The OS kernel and its Worker-based process system remain valuable. The change is recognizing that **kernel services** (gatewayd, logd, authd) belong inside the OS, while **user applications** (shell, display, utilities) belong outside.

`gatewayd` is the bridge - a kernel service that exposes syscalls to external apps via Unix socket. This preserves the Worker infrastructure while enabling external development.

The display proof-of-concept validated WebSocket ↔ EMS ↔ DOM rendering. Now it needs proper layering: entities in OS, bridge in displayd (external), UI in displayd-client.

Target: OS 1.0 as a kernel with internal services, accessible via gatewayd.
