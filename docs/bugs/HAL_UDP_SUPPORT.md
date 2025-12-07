# Bug: HAL missing UDP socket abstraction

## Status
**OPEN** - UDP support documented but not implemented in HAL

## Summary
The HAL NetworkDevice is documented as supporting "TCP/UDP/HTTP networking" but only TCP is implemented. UDP socket creation bypasses HAL entirely.

## Current State

`src/hal/network.ts:38` acknowledges the gap:
```
* - UDP is supported via Bun.listen({ type: 'udp' }) but not exposed yet.
```

`src/hal/index.ts:22` documents the intent:
```
* 3. NetworkDevice: TCP/UDP/HTTP networking (listen, connect, serve)
```

## Violation

`src/kernel/resource/udp-port.ts:369` calls Bun directly:
```typescript
this.socket = Bun.udpSocket({
    port: this.opts.bind,
    hostname: this.opts.address ?? '0.0.0.0',
    socket: { ... }
}) as unknown as BunUdpSocket;
```

This violates the OS rule that Bun primitives should only be used in HAL.

## Proposed Fix

Add UDP support to HAL NetworkDevice:

1. Define `UdpSocket` interface in `src/hal/network/types.ts`:
```typescript
interface UdpSocket {
    send(data: Uint8Array, port: number, host: string): number;
    close(): void;
}

interface UdpSocketOpts {
    port: number;
    hostname?: string;
    onData: (buf: Uint8Array, port: number, addr: string) => void;
    onError: (error: Error) => void;
}
```

2. Add `udpSocket()` method to NetworkDevice in `src/hal/network/device.ts`:
```typescript
udpSocket(opts: UdpSocketOpts): UdpSocket
```

3. Create `BunUdpSocket` implementation wrapping `Bun.udpSocket()`

4. Create `MockUdpSocket` for testing

## Files Affected

- `src/hal/network/types.ts` - Add UdpSocket types
- `src/hal/network/device.ts` - Add udpSocket() method
- `src/hal/index.ts` - Export new types
- `src/kernel/resource/udp-port.ts` - Consumer (see HAL_PORT_CLEANUP.md)

## Related

- HAL_PORT_CLEANUP.md - Update UdpPort to use HAL
- HAL_CONSOLE_LOGGING.md - Structured logging in callbacks
