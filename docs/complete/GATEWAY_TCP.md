# Gateway Unix Socket → TCP Migration

## Motivation

The Gateway currently uses Unix sockets for external syscall access. Two problems:

1. **Connection close is broken** — data flows, but teardown hangs (tests never pass)
2. **Unix socket is local-only** — limits deployment flexibility

TCP solves both: well-understood close semantics (FIN/ACK) and network accessibility.

## Files to Modify

### 1. `src/gateway/gateway.ts` (main change)

- Change `listen(socketPath: string)` → `listen(port: number)`
- Remove `unlink()` call (no stale socket file to clean up)
- Change `this.hal.network.listen(0, { unix: socketPath })` → `this.hal.network.listen(port)`
- Remove `GatewayDeps` interface (only used for `unlink`)

### 2. `src/os/os.ts`

- Change from `MONK_SOCKET` env var to `MONK_PORT` (or just use a constant)
- Change `await this.__gateway.listen(socketPath)` → `await this.__gateway.listen(port)`

### 3. `src/os/test.ts`

- Same change: `listen(port)` instead of `listen(socketPath)`
- Remove socket file cleanup in tests

### 4. `src/gateway/README.md`

- Update documentation to reflect TCP instead of Unix socket
- Update examples

### 5. `spec/gateway/gateway.test.ts`

- Remove `getTestSocketPath()` helper
- Remove socket file cleanup (`rmSync`, `existsSync`)
- Use port 0 (auto-assign) for test isolation
- Change all `network.connect(socketPath, 0)` → `network.connect('localhost', port)`

### 6. `spec/gateway/gateway-edge-cases.test.ts`

- Same changes as above

### 7. `perf/gateway/gateway.perf.ts`

- Same changes

## No Changes Needed

- `src/hal/network/*` — already supports TCP, just not being used
- `src/gateway/debug.ts` — protocol-agnostic
- Wire protocol (msgpack framing) — stays exactly the same
- `os-sdk` — will need updates but that's a separate package

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Transport | Unix socket (`/tmp/monk.sock`) | TCP (port 7778 default) |
| Config | `MONK_SOCKET` env var | `MONK_PORT` env var |
| Listen call | `listen(socketPath)` | `listen(port)` |
| Connect | `connect(path, 0)` | `connect(host, port)` |
| Cleanup | `unlink()` stale socket | None needed |
| Remote access | Local only | Network accessible |

The msgpack protocol, framing, multiplexing, streaming—all unchanged. It's purely a transport swap.
