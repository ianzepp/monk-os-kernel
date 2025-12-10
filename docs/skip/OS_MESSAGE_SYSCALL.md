# Unify Syscall Transport with Message Format

> **Status:** Won't implement. Current formats work fine, unification not worth the churn.

## Current State

Two message formats exist:

**SyscallRequest/SyscallResponse** (Worker ↔ Kernel postMessage)
```typescript
{ type: 'syscall', id: 'uuid', name: 'file:open', args: ['/path', {}] }
{ type: 'response', id: 'uuid', result: 3 }
{ type: 'response', id: 'uuid', error: { code: 'ENOENT', message: '...' } }
```

**Message/Response** (VFS handlers, channels, streaming)
```typescript
{ op: 'read', data: { size: 1024 } }
{ op: 'ok', data: 3 }
{ op: 'error', data: { code: 'ENOENT', message: '...' } }
{ op: 'item', data: { name: 'foo.txt' } }
{ op: 'done' }
```

## Proposal

Unify into single format:

```typescript
// Request
{ op: 'file:open', id: 'uuid', data: { path: '/etc/passwd', flags: {} } }

// Responses
{ op: 'ok', id: 'uuid', data: 3 }
{ op: 'error', id: 'uuid', data: { code: 'ENOENT', message: '...' } }
{ op: 'item', id: 'uuid', data: { name: 'foo.txt' } }
{ op: 'done', id: 'uuid' }
```

## Benefits

- One message format across syscalls, gatewayd, channels, VFS
- Streaming syscalls naturally use `item`/`done` responses
- Simpler mental model for external SDK developers

## Migration

1. Change syscall `args: unknown[]` to `data: object`
2. Add `id` to Message type for correlation
3. Update kernel dispatcher
4. Update process library wrappers
5. Update gatewayd

## Open Questions

- Named params (`data: { path, flags }`) vs positional (`args: [path, flags]`)
- Backwards compatibility for existing syscall signatures
- Performance impact of object vs array for args
