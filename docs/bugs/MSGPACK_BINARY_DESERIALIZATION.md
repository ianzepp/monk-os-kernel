# Bug: MessagePack deserializes Uint8Array as plain Object

## Status
**OPEN**

## Symptom
SDK `write()` calls fail with EINVAL despite MessagePack wire protocol migration:

```
SyscallError: Invalid data format for send
 syscall: "file:write",
    code: "EINVAL"
```

## Root Cause
**msgpackr deserializes binary data as plain Object, not Uint8Array**

Debug logging in kernel shows:
```
[DEBUG file:write] data type: object
[DEBUG file:write] has data prop: true
[DEBUG file:write] inner data type: object
[DEBUG file:write] inner data constructor: Object    <-- Should be Uint8Array
[DEBUG file:write] instanceof Uint8Array: false
[DEBUG file:write] instanceof Buffer: false
```

The SDK sends `{ data: Uint8Array([72, 101, 108, 108, 111]) }` but the kernel receives `{ data: { 0: 72, 1: 101, 2: 108, 3: 108, 4: 111 } }`.

## Analysis

### SDK side (os-sdk/src/transport.ts)
Uses `msgpackr` to encode:
```typescript
import { pack, unpack } from 'msgpackr';
// ...
const payload = pack(request);
```

### Gateway side (os/src/gateway/gateway.ts)
Uses `msgpackr` to decode:
```typescript
import { pack, unpack } from 'msgpackr';
// ...
msg = unpack(payload);
```

### The Problem
`msgpackr` by default does NOT preserve `Uint8Array` type. Binary data is decoded as a plain object with numeric keys unless explicitly configured.

## Proposed Fix

### Option A: Configure msgpackr for binary handling (Recommended)

```typescript
import { Packr, Unpackr } from 'msgpackr';

// Configure encoder/decoder with binary support
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

// Use instance methods instead of standalone functions
const encoded = packr.pack(data);
const decoded = unpackr.unpack(payload);
```

Or use the `mapsAsObjects` and binary-specific options:
```typescript
import { Packr } from 'msgpackr';

const packr = new Packr({
    useRecords: false,
    mapsAsObjects: true,
    // Ensure binary data stays as Uint8Array
});
```

### Option B: Manual binary field handling
Gateway transforms binary fields after decode:
```typescript
function restoreBinaryFields(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj;

    // Check if object looks like serialized Uint8Array (has only numeric keys)
    if (!Array.isArray(obj)) {
        const keys = Object.keys(obj);
        if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
            const values = keys.map(k => (obj as any)[k]);
            if (values.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
                return new Uint8Array(values);
            }
        }
    }

    // Recurse
    if (Array.isArray(obj)) {
        return obj.map(restoreBinaryFields);
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        result[k] = restoreBinaryFields(v);
    }
    return result;
}
```

This is fragile - Option A is preferred.

## Related
- `GATEWAY_BINARY_DATA.md` - Marked as FIXED but this is the underlying cause
- The previous bug assumed JSON was the issue; MessagePack has the same problem without proper configuration

## Test Case
```typescript
// In os-sdk
const fd = await client.open('/tmp/test.txt', { write: true, create: true });
await client.write(fd, 'Hello');  // <-- Fails with EINVAL
await client.fclose(fd);
```

## Files
- `os/src/gateway/gateway.ts:75` - msgpackr import
- `os/src/gateway/gateway.ts:426` - unpack() call
- `os-sdk/src/transport.ts:10` - msgpackr import
- `os/src/kernel/handle/file.ts:368` - instanceof Uint8Array check

## Priority
**High** - Blocks all file write operations for SDK clients
