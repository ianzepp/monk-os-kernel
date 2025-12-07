# Bug: UdpPort and WatchPort bypass HAL

## Status
**OPEN** - Kernel resource ports should use HAL abstractions

## Summary
`UdpPort` calls `Bun.udpSocket()` directly, violating HAL boundaries. Both `UdpPort` and `WatchPort` use `console.error` instead of `hal.console.error()` for error logging.

## Violations

### UdpPort

1. **Bun.udpSocket() bypass** (`src/kernel/resource/udp-port.ts:369`):
```typescript
this.socket = Bun.udpSocket({
    port: this.opts.bind,
    hostname: this.opts.address ?? '0.0.0.0',
    ...
});
```

2. **console.error bypass** (`src/kernel/resource/udp-port.ts:407`):
```typescript
error(_socket, error) {
    console.error('UDP socket error:', error);
}
```

### WatchPort

1. **console.error bypass** (`src/kernel/resource/watch-port.ts:412`):
```typescript
if (!this._closed) {
    // WHY console.error: No kernel logging available in async context
    console.error('WatchPort error:', error);
}
```

Note: WatchPort already uses dependency injection for `vfsWatch` - no Bun primitives.

## History

Both files created at commit `9e946c0` (position 229/359), approximately 1/3 into the codebase history. The HAL console pattern may not have been established when these were written.

## Proposed Fix

### UdpPort

1. Add HAL to constructor:
```typescript
constructor(
    id: string,
    opts: UdpSocketOpts,
    description: string,
    hal: HAL,  // NEW
)
```

2. Replace `Bun.udpSocket()` with `hal.network.udpSocket()` (requires HAL_UDP_SUPPORT.md first)

3. Replace `console.error` with `hal.console.error()`

### WatchPort

1. Add HAL to constructor:
```typescript
constructor(
    id: string,
    pattern: string,
    vfsWatch: (pattern: string) => AsyncIterable<WatchEvent>,
    description: string,
    hal: HAL,  // NEW
)
```

2. Replace `console.error` with `hal.console.error()`

### Call Site Updates

Update these files to pass HAL when creating ports:
- `src/kernel/kernel/create-port.ts`
- `src/kernel/kernel/activate-service.ts`
- `src/kernel/kernel/create-io-source-handle.ts`

## Dependencies

- HAL_UDP_SUPPORT.md must be completed first for the `Bun.udpSocket()` replacement
- WatchPort can be fixed independently (only needs console)

## Files Affected

- `src/kernel/resource/udp-port.ts`
- `src/kernel/resource/watch-port.ts`
- `src/kernel/kernel/create-port.ts`
- `src/kernel/kernel/activate-service.ts`
- `src/kernel/kernel/create-io-source-handle.ts`

## Related

- HAL_UDP_SUPPORT.md - HAL UDP abstraction (prerequisite for UdpPort)
- HAL_CONSOLE_LOGGING.md - Broader console.error cleanup
