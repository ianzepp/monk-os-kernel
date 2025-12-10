# Bug: Gateway does not support binary data in requests

## Status
**FIXED** - Migrated to MessagePack wire protocol (binary data handled natively)

## Symptom
SDK clients cannot write binary data to files via the gateway. The `file:write` syscall fails with:

```
SyscallError: Invalid data format for send
    code: "EINVAL"
```

## Root Cause
**JSON serialization loses `Uint8Array` type**

The gateway wire protocol uses newline-delimited JSON. When the SDK sends binary data:

```typescript
// SDK sends:
{ id: "1", call: "file:write", args: [3, { data: Uint8Array([104, 101, 108, 108, 111]) }] }

// JSON.stringify produces:
{ "id": "1", "call": "file:write", "args": [3, { "data": { "0": 104, "1": 101, ... } }] }

// Gateway parses to:
{ id: "1", call: "file:write", args: [3, { data: { "0": 104, "1": 101, ... } }] }
```

The `Uint8Array` becomes a plain object with numeric string keys, which the kernel rejects.

## Affected Code

### Kernel expectation (`src/kernel/handle/file.ts:358-361`)
```typescript
if ('data' in data && (data as { data: unknown }).data instanceof Uint8Array) {
    // From write() syscall: { data: Uint8Array }
    bytes = (data as { data: Uint8Array }).data;
}
```

The kernel checks `instanceof Uint8Array` which fails for JSON-deserialized data.

### Gateway has no incoming binary conversion
The gateway converts outgoing binary to base64 (`src/gateway/gateway.ts:543-550`):
```typescript
if (bytes instanceof Uint8Array) {
    wire.bytes = Buffer.from(bytes).toString('base64');
}
```

But there is no corresponding conversion for incoming request arguments.

## Proposed Fix

### Option A: Gateway decodes incoming binary (Recommended)
Add argument transformation in `processMessage()` before dispatching:

```typescript
// In gateway.ts processMessage()
const args = this.decodeArgs(msg.args ?? []);

// Helper to recursively find and decode binary data
private decodeArgs(args: unknown[]): unknown[] {
    return args.map(arg => this.decodeBinaryFields(arg));
}

private decodeBinaryFields(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }

    // Check for base64 marker: { $base64: "..." }
    if ('$base64' in value && typeof (value as any).$base64 === 'string') {
        return Buffer.from((value as any).$base64, 'base64');
    }

    // Check for array marker: { $bytes: [...] }
    if ('$bytes' in value && Array.isArray((value as any).$bytes)) {
        return new Uint8Array((value as any).$bytes);
    }

    // Recurse into objects
    if (Array.isArray(value)) {
        return value.map(v => this.decodeBinaryFields(v));
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
        result[k] = this.decodeBinaryFields(v);
    }
    return result;
}
```

SDK would send:
```typescript
// Base64 encoding (compact)
{ id: "1", call: "file:write", args: [3, { data: { $base64: "aGVsbG8=" } }] }

// Or array encoding (readable)
{ id: "1", call: "file:write", args: [3, { data: { $bytes: [104, 101, 108, 108, 111] } }] }
```

### Option B: Kernel accepts number arrays
Modify `FileHandleAdapter.send()` to accept `number[]`:

```typescript
if ('data' in data) {
    const raw = (data as { data: unknown }).data;
    if (raw instanceof Uint8Array) {
        bytes = raw;
    } else if (Array.isArray(raw) && raw.every(n => typeof n === 'number')) {
        bytes = new Uint8Array(raw);
    }
}
```

This is simpler but spreads wire format concerns into the kernel.

## Wire Protocol Amendment

If Option A is chosen, document in `src/gateway/README.md`:

```markdown
### Binary Data in Requests

Binary data in request arguments should use one of these encodings:

**Base64 (recommended for large data):**
```json
{ "data": { "$base64": "aGVsbG8gd29ybGQ=" } }
```

**Byte array (readable for small data):**
```json
{ "data": { "$bytes": [104, 101, 108, 108, 111] } }
```

The gateway decodes these markers to `Uint8Array` before passing to syscalls.
```

## Impact
- SDK `write()`, `writeFile()` methods non-functional
- Any syscall that accepts binary data is affected
- Workaround: None for SDK clients

## Test Case
```typescript
// In os-sdk/spec/client.test.ts (currently skipped)
test('open/write/read/fclose work together', async () => {
    const fd = await client.open('/tmp/test.txt', { write: true, create: true });
    await client.write(fd, 'Hello');  // <-- Fails here
    await client.fclose(fd);
});
```

## Related Files
- `src/gateway/gateway.ts` - Request processing (fix location)
- `src/gateway/README.md` - Wire protocol docs
- `src/kernel/handle/file.ts` - FileHandleAdapter.send() (alternative fix)
- `os-sdk/src/client.ts` - SDK write() method

## Priority
**High** - Blocks basic file I/O for all SDK clients
