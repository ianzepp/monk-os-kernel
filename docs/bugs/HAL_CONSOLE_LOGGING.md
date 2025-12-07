# Bug: Kernel code uses console.error instead of HAL

## Status
**OPEN** - Low priority cleanup

## Summary
Several kernel components use `console.error` directly instead of `hal.console.error()`. This bypasses the HAL abstraction layer, though the practical impact is minimal since `printk` also wraps `console.log`.

## Current State

The codebase has `printk` at `src/kernel/kernel/printk.ts:27`:
```typescript
console.log(`[kernel:${category}] ${message}`);
```

And `hal.console.error()` for proper HAL-abstracted error output.

Some code uses raw `console.error` with comments explaining why:
```typescript
// WHY console.error: No kernel logging available in callback context
console.error('...');
```

## Violations

| File | Line | Context |
|------|------|---------|
| `src/kernel/resource/udp-port.ts` | 407 | Socket error callback |
| `src/kernel/resource/watch-port.ts` | 412 | Async iterator error |
| `src/gateway/gateway.ts` | 284 | Accept loop error |
| `src/hal/network/listener.ts` | 359 | Bun socket error callback |
| `src/hal/dns.ts` | 329 | DNS reverse lookup not implemented |
| `src/os/os.ts` | 1094 | Directory creation warning |

## Analysis

### Already Have HAL Access
- `gateway.ts` - Has `private readonly hal: HAL` in constructor
- `udp-port.ts` - Needs HAL added (see HAL_PORT_CLEANUP.md)
- `watch-port.ts` - Needs HAL added (see HAL_PORT_CLEANUP.md)

### Inside HAL (Acceptable)
- `hal/network/listener.ts` - This IS the HAL layer; using console directly is expected
- `hal/dns.ts` - Same; inside HAL

### OS Layer
- `os/os.ts` - Top-level OS, may use console for user-facing output

## Proposed Fix

### Priority 1: Gateway (easy fix)
`gateway.ts:284` has HAL available, just not using it:
```typescript
// Current
console.error(`Gateway accept error: ${error.message}`);

// Fixed
this.hal.console.error(
    new TextEncoder().encode(`Gateway accept error: ${error.message}\n`)
);
```

### Priority 2: Ports (see HAL_PORT_CLEANUP.md)
UdpPort and WatchPort need HAL added to constructor first.

### Priority 3: HAL internals (optional)
Code inside `src/hal/` using console is arguably correct - HAL is the boundary.

## Impact

Low. The structured logging benefit is:
- Consistent format with category tags
- Single point of control for log routing
- Testability (can mock hal.console)

But `console.error` in error handlers is pragmatic and the comments acknowledge the tradeoff.

## Files Affected

- `src/gateway/gateway.ts` - Quick fix
- `src/kernel/resource/udp-port.ts` - Via HAL_PORT_CLEANUP.md
- `src/kernel/resource/watch-port.ts` - Via HAL_PORT_CLEANUP.md

## Related

- HAL_PORT_CLEANUP.md - UdpPort/WatchPort HAL refactor
- HAL_UDP_SUPPORT.md - Prerequisite for UdpPort
