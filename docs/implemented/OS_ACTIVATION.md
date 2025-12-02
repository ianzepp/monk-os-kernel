# Service Activation Message Refactoring

## Problem

Current implementation encodes structured activation data as JSON bytes:

```typescript
// Watch activation (wasteful)
data: new TextEncoder().encode(JSON.stringify({
    path: msg.from,
    op: msg.meta?.op,
    data: msg.data ? Array.from(msg.data) : undefined,
}))
```

This creates unnecessary serialization overhead for purely in-memory code paths. TCP works correctly because it's genuinely a byte stream, but watch/pubsub/UDP are internal and should pass native objects.

## Solution

Use the existing `Message` type (`src/message.ts`) for activation context:

```typescript
interface Message {
    op: string;
    data?: unknown;
}
```

Store activation message on Process, retrieve via syscall.

## Activation Messages by Type

| Activation | Socket | activationMessage |
|------------|--------|-------------------|
| boot | none | `undefined` (no trigger) |
| tcp | fd 0/1/2 | `{ op: 'tcp', data: { remoteAddr, remotePort, localAddr, localPort } }` |
| pubsub | none | `{ op: 'pubsub', data: { topic, payload? } }` |
| watch | none | `{ op: 'watch', data: { path, event, content? } }` |
| udp | none | `{ op: 'udp', data: { from, payload? } }` |

## Data Flow

### Before (watch example)
```
VFS event (native)
  → JSON.stringify({path, op, data: Array.from(...)})
  → TextEncoder.encode()
  → PipeBuffer
  → service reads stdin
  → JSON.parse()
  → native object (with Uint8Array reconstructed)
```

### After (watch example)
```
VFS event (native)
  → Message { op: 'watch', data: { path, event, content } }
  → proc.activationMessage = message
  → service calls getActivation() syscall
  → native Message (Uint8Array stays as Uint8Array)
```

## Touch Points

| File | Change |
|------|--------|
| `src/kernel/types.ts` | Add `activationMessage?: Message` to `Process` |
| `src/kernel/kernel.ts` | `runActivationLoop` return type: `{ socket?, activation? }` |
| `src/kernel/kernel.ts` | `activateService` transforms return Message instead of JSON bytes |
| `src/kernel/kernel.ts` | `spawnServiceHandler` - remove inputData/pipe logic, store activation |
| `src/kernel/kernel.ts` | New syscall `getActivation` → returns `proc.activationMessage` |
| `src/rom/lib/syscall.ts` | Add `getActivation(): Promise<Message \| null>` |
| Service handlers | Call `getActivation()` instead of reading stdin |

## What Gets Deleted

- `new TextEncoder().encode(JSON.stringify({...}))` in activation transforms
- `Array.from(msg.data)` conversions (Uint8Array stays native)
- PipeBuffer creation for `inputData` case in spawnServiceHandler
- The entire `inputData` parameter and code path

## Implementation Order

1. `src/kernel/types.ts` - Add `activationMessage?: Message` to Process
2. `src/kernel/kernel.ts`:
   - Update `runActivationLoop` return type
   - Update 4 activation transforms in `activateService`
   - Refactor `spawnServiceHandler(name, def, socket?, activation?)`
   - Add `getActivation` syscall
3. `src/rom/lib/syscall.ts` - Add userspace wrapper
4. Update any existing service handlers

## Benefits

1. No JSON serialization/deserialization overhead
2. Native objects throughout (Uint8Array stays as Uint8Array)
3. Type-safe activation messages
4. Cleaner separation: bytes for byte streams, Messages for structured data
5. Consistent with Message-based architecture
