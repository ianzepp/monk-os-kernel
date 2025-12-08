# Virtual Models - Kernel Resources as EMS Entities

## Overview

Extend EMS to support "virtual models" - entity types backed by kernel data structures instead of SQL tables. This completes the symmetry where every resource is both path-addressable (VFS) and query-addressable (EMS).

## Motivation

Currently:
- Files/folders: VFS path access + EMS query access
- Processes: VFS path access (`/proc/{uuid}/stat`) only
- Handles: fd number only, no discovery mechanism

With virtual models:
```typescript
// Find zombie processes
await os.ems('select', 'process', {
    where: { state: 'zombie' }
});

// Find all socket connections to port 443
await os.ems('select', 'handle', {
    where: { type: 'socket', remote_port: 443 }
});

// Find processes with open handles to a specific file
await os.ems('select', 'handle', {
    where: { type: 'file', path: { $like: '/var/log/%' } }
});
```

## Design

### Virtual Model Interface

```typescript
interface VirtualModel {
    readonly name: string;           // 'process', 'handle', 'port', etc.
    readonly virtual: true;          // Distinguishes from SQL-backed models
    readonly writable: boolean;      // Can mutations go through?

    // Schema for validation and query building
    fields(): FieldDef[];

    // Query execution - replaces SQL
    select(filter: FilterData): AsyncIterable<EntityRecord>;

    // Optional: count without fetching
    count?(filter: FilterData): Promise<number>;

    // Optional: mutations (if writable)
    update?(id: string, changes: Record<string, unknown>): Promise<EntityRecord>;
    delete?(id: string): Promise<void>;
}
```

### Process Model

```typescript
const ProcessModel: VirtualModel = {
    name: 'process',
    virtual: true,
    writable: true,  // Can send signals via update

    fields: () => [
        { name: 'id', type: 'uuid', primary: true },
        { name: 'parent', type: 'uuid', indexed: true },
        { name: 'state', type: 'string', indexed: true },  // starting, running, stopped, zombie
        { name: 'path', type: 'string' },                  // executable path
        { name: 'cwd', type: 'string' },
        { name: 'created_at', type: 'timestamp', indexed: true },
        { name: 'exited_at', type: 'timestamp' },
        { name: 'exit_code', type: 'integer' },
        { name: 'handle_count', type: 'integer' },         // open fds
        { name: 'child_count', type: 'integer' },
    ],

    async *select(filter) {
        // Query kernel.processTable directly
        for (const proc of kernel.processTable.values()) {
            const record = processToRecord(proc);
            if (matchesFilter(record, filter.where)) {
                yield record;
            }
        }
    },

    async update(id, changes) {
        // Special case: signal field sends a signal
        if (changes.signal) {
            await kernel.kill(id, changes.signal);
            return this.getOne(id);
        }
        throw new EPERM('process fields are read-only');
    }
};
```

### Handle Model

```typescript
const HandleModel: VirtualModel = {
    name: 'handle',
    virtual: true,
    writable: false,

    fields: () => [
        { name: 'id', type: 'uuid', primary: true },
        { name: 'type', type: 'string', indexed: true },   // file, socket, pipe, port, channel
        { name: 'process', type: 'uuid', indexed: true },  // owning process
        { name: 'fd', type: 'integer' },                   // fd number in that process
        { name: 'description', type: 'string' },
        { name: 'created_at', type: 'timestamp' },
        { name: 'refcount', type: 'integer' },

        // File-specific
        { name: 'path', type: 'string', indexed: true },
        { name: 'flags', type: 'json' },                   // { read, write, append, ... }
        { name: 'position', type: 'integer' },

        // Socket-specific
        { name: 'remote_host', type: 'string', indexed: true },
        { name: 'remote_port', type: 'integer', indexed: true },
        { name: 'local_port', type: 'integer' },
        { name: 'bytes_read', type: 'integer' },
        { name: 'bytes_written', type: 'integer' },

        // Channel-specific
        { name: 'protocol', type: 'string' },              // http, ws, postgres, sqlite
        { name: 'url', type: 'string' },
    ],

    async *select(filter) {
        // Walk all processes, collect handle info
        for (const proc of kernel.processTable.values()) {
            for (const [fd, handleId] of proc.handles) {
                const handle = kernel.handles.get(handleId);
                const record = handleToRecord(handle, proc.id, fd);
                if (matchesFilter(record, filter.where)) {
                    yield record;
                }
            }
        }
    }
};
```

### Registration

```typescript
// In EMS initialization
ems.registerVirtualModel(ProcessModel);
ems.registerVirtualModel(HandleModel);
ems.registerVirtualModel(PortModel);
ems.registerVirtualModel(ServiceModel);
```

### Query Execution Path

```
ems:select('handle', filter)
       │
       ▼
   EMS.select()
       │
       ├── Is model virtual?
       │      │
       │      ├── Yes: model.select(filter) ──► kernel data
       │      │
       │      └── No: SQL query ──► database
       │
       ▼
   Stream records through observer pipeline (rings 7-9 only?)
       │
       ▼
   Return to caller
```

### Observer Pipeline Interaction

Virtual models skip most observer rings since they're not persisted:

| Ring | Virtual Models |
|------|----------------|
| 0 - Data Preparation | Skip (no merging needed) |
| 1 - Validation | Skip (kernel already validates) |
| 2-4 - Security/Business/Enrichment | Optional (could add ACL checks) |
| 5 - Database | Skip (no SQL) |
| 6 - DDL | Skip (no schema changes) |
| 7 - Audit | Run (track queries for audit log) |
| 8 - Cache | Skip (no caching virtual data) |
| 9 - Notification | Run (emit events) |

## Example Queries

```typescript
// All running processes
await os.ems('select', 'process', {
    where: { state: 'running' }
});

// Orphaned processes (parent exited)
await os.ems('select', 'process', {
    where: { parent: { $null: true }, state: { $ne: 'zombie' } }
});

// Processes sorted by age
await os.ems('select', 'process', {
    order: { field: 'created_at', sort: 'asc' }
});

// All socket handles
await os.ems('select', 'handle', {
    where: { type: 'socket' }
});

// Connections to a specific host
await os.ems('select', 'handle', {
    where: { remote_host: { $like: '%slack%' } }
});

// Handles for a specific process
await os.ems('select', 'handle', {
    where: { process: someProcessId }
});

// Files open for writing
await os.ems('select', 'handle', {
    where: { type: 'file', 'flags.write': true }
});

// Kill a process via update (if writable: true)
await os.ems('update', 'process', zombiePid, { signal: 15 });
```

## VFS Symmetry

With virtual models, every resource has dual access:

| Resource | VFS Path | EMS Query |
|----------|----------|-----------|
| File | `/home/alice/doc.txt` | `{ where: { path: '/home/alice/doc.txt' } }` |
| Folder | `/home/alice/` | `{ where: { parent: aliceFolderId } }` |
| Process | `/proc/{uuid}/stat` | `{ where: { id: uuid } }` |
| Handle | `/proc/{uuid}/fd/3` | `{ where: { process: uuid, fd: 3 } }` |
| Device | `/dev/random` | `{ where: { model: 'device', name: 'random' } }` |

## Future Extensions

### Service Model
```typescript
await os.ems('select', 'service', {
    where: { state: 'running', activation: 'tcp:listen' }
});
```

### Mount Model
```typescript
await os.ems('select', 'mount', {
    where: { type: 'host' }
});
```

### Pool/Worker Model
```typescript
await os.ems('select', 'worker', {
    where: { pool: 'compute', state: 'busy' }
});
```

## Implementation Steps

1. Define `VirtualModel` interface in `src/ems/`
2. Add `registerVirtualModel()` to EMS class
3. Update `EntityOps.selectAll()` to check for virtual models
4. Implement `ProcessModel` backed by `kernel.processTable`
5. Implement `HandleModel` backed by kernel handle tables
6. Add syscall routing in `src/syscall/ems.ts`
7. Tests for virtual model queries
8. Documentation

## Open Questions

1. **Caching** - Should virtual model results be cached briefly? Process table changes frequently.

2. **Pagination** - How to handle `offset` for virtual models where underlying data changes between pages?

3. **Joins** - Can you query across virtual and SQL models? `handles where process.path = '/bin/server'`

4. **Write semantics** - What mutations make sense? Kill process, close handle, anything else?

5. **Permissions** - Should processes only see their own handles by default? ACL on virtual models?
