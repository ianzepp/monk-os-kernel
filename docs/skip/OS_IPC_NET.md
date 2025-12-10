# IPC/Network Syscall Reorganization

> **Status**: Future
> **Complexity**: Medium
> **Dependencies**: None (but blocks timer port, other local event sources)

Reorganize port and network syscalls around a cleaner conceptual split: local event sources (IPC) vs external I/O (network).

---

## Motivation

Current port types have inconsistent naming and no clear taxonomy:

| Current Type | Prefix Style | Actually Is |
|--------------|--------------|-------------|
| `tcp:listen` | protocol:op | Network I/O |
| `udp:bind` | protocol:op | Network I/O |
| `fs:watch` | subsystem:op | Local events |
| `pubsub:subscribe` | mechanism:op | Local IPC |

Additionally:
- `ipc:pipe` exists in `handle.ts`, separate from the port system
- Proposed `timer` port would be another local event source
- No clear home for future local primitives (signals, named channels)

The split between "ports" (in `hal.ts`) and "IPC" (in `handle.ts`) is accidental, not designed.

---

## Proposed Taxonomy

### Local Event Sources (`ipc:*`)

Things where the kernel or another process generates events. No external network boundary crossed.

| Type | Description |
|------|-------------|
| `ipc:pipe` | Bidirectional process-to-process channel (exists) |
| `ipc:pubsub` | Topic-based messaging (was `pubsub:subscribe`) |
| `ipc:watch` | Filesystem change events (was `fs:watch`) |
| `ipc:timer` | Periodic tick events (new) |

Future candidates: signals, named channels, shared memory notifications.

### External I/O (`net:*`)

Things that cross the system boundary - actual network I/O with external hosts.

| Type | Description |
|------|-------------|
| `net:tcp:listen` | Accept TCP connections (was `tcp:listen`) |
| `net:udp:bind` | Receive UDP datagrams (was `udp:bind`) |
| `net:connect` | Outbound TCP/Unix connection (exists) |

Channels (`channel:*`) remain separate - they're protocol-aware wrappers over connections.

---

## Current Architecture

```
src/syscall/
├── handle.ts    → handle:*, ipc:*  (just ipc:pipe)
├── hal.ts       → net:*, port:*, channel:*
```

```
src/kernel/kernel/create-port.ts
├── tcp:listen
├── udp:bind
├── fs:watch
└── pubsub:subscribe
```

---

## Proposed Architecture

### Option A: Consolidate into `hal.ts`

Keep all ports in one place, just fix the naming:

```typescript
// hal.ts handles both ipc:* and net:* ports
case 'ipc:timer':    // new
case 'ipc:watch':    // was fs:watch
case 'ipc:pubsub':   // was pubsub:subscribe
case 'net:tcp:listen':  // was tcp:listen
case 'net:udp:bind':    // was udp:bind
```

Move `ipc:pipe` from `handle.ts` to port system.

### Option B: Split files

```
src/syscall/
├── handle.ts    → handle:* only
├── ipc.ts       → ipc:* (pipe, pubsub, watch, timer)
├── net.ts       → net:* (tcp, udp, connect)
├── channel.ts   → channel:*
```

Cleaner separation but more files.

---

## Migration Path

1. **Add aliases** - New names work alongside old names
2. **Deprecation warnings** - Old names log warning
3. **Update docs/examples** - Use new names everywhere
4. **Remove old names** - Breaking change in major version

Or: just change them all at once if no external consumers yet.

---

## Timer Port (Deferred)

Originally proposed in OS_TIMER_PORT.md. A kernel port that emits periodic tick events.

```typescript
const fd = await syscall('ipc:timer', { interval: 1000 });

for await (const tick of recv(fd)) {
    // tick.meta: { tick, scheduled, actual, drift }
}
```

### Design Summary

- **Options**: `interval` (required), `immediate` (optional), `count` (optional)
- **Timing**: Fixed-rate interval model (matches setInterval semantics)
- **Message**: Includes tick count, scheduled time, actual time, drift

### Implementation

Straightforward once naming is resolved:
1. Add `TimerPort` class to `src/kernel/resource/`
2. Add case to `create-port.ts` switch
3. Add userspace `timer()` wrapper

See git history for full original design (OS_TIMER_PORT.md).

---

## Open Questions

1. **Channel relationship** - Are channels a third category, or a layer on top of net?
2. **Pipe unification** - Should `ipc:pipe` become a port, or stay as handle-level primitive?
3. **Backwards compatibility** - Any external consumers of current type strings?

---

## References

- `src/syscall/hal.ts` - Current port/net/channel syscalls
- `src/syscall/handle.ts` - Current ipc:pipe implementation
- `src/kernel/kernel/create-port.ts` - Port type dispatch
- `src/kernel/resource/` - Port implementations
