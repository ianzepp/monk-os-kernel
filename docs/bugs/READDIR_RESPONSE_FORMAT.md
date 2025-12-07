# Bug: readdir returns only names, not DirEntry objects

## Status
**FIXED** - Kernel now yields `{ name, model }` objects

## Symptom
SDK clients using `readdirSync()` receive string names instead of `DirEntry` objects. Code expecting `{ name, model }` fails:

```
TypeError: undefined is not an object (evaluating 'a.name.localeCompare')
```

## Root Cause
**Kernel yields only `entry.name`, SDK expects `{ name, model }`**

### Kernel implementation (`src/syscall/vfs.ts:417`)
```typescript
for await (const entry of vfs.readdir(path, proc.user)) {
    yield respond.item(entry.name);  // Only name string
}
```

### SDK type expectation (`os-sdk/src/types.ts:221-224`)
```typescript
export interface DirEntry {
    name: string;
    model: string;
}
```

The VFS `readdir()` returns full entry objects with `name` and `model`, but the syscall only forwards the name.

## Actual vs Expected

**Actual response:**
```json
["dev", "app", "tmp"]
```

**Expected response (per SDK types):**
```json
[
  { "name": "dev", "model": "folder" },
  { "name": "app", "model": "folder" },
  { "name": "tmp", "model": "folder" }
]
```

## POSIX Context
- Strict POSIX `readdir()` returns only inode + name
- BSD/Linux extension adds `d_type` (file type) for efficiency
- Most practical implementations include type to avoid per-entry `stat()` calls

## Proposed Fix
Modify kernel to yield full entry object:

```typescript
// src/syscall/vfs.ts:417
for await (const entry of vfs.readdir(path, proc.user)) {
    yield respond.item({ name: entry.name, model: entry.model });
}
```

This is a one-line change. The VFS already provides the `model` field.

## Impact
- SDK `readdir()` / `readdirSync()` return wrong type
- File servers must `stat()` each entry to distinguish files from folders
- Performance penalty for directory listings

## Discovered By
httpd integration tests against live gateway.

## Test Case
```typescript
// Should pass after fix
const entries = await client.readdirSync('/');
expect(entries[0]).toHaveProperty('name');
expect(entries[0]).toHaveProperty('model');
```

## Related Files
- `src/syscall/vfs.ts:395-425` - fileReaddir implementation (fix location)
- `os-sdk/src/types.ts:218-224` - DirEntry type definition
- `os-sdk/src/client.ts:282-291` - SDK readdir methods

## Priority
**Medium** - Workaround exists (stat each entry) but inefficient
