# Phase 6: VFS Integration

## Overview

The VFS integration makes model records accessible as files. The path `/data/{model}/{id}` maps to a record in the database. CRUD operations through the filesystem are translated to database operations.

## Path Structure

```
/data/                          # Root for all user-defined models
/data/{model}/                  # Model directory (list records)
/data/{model}/{id}              # Record as JSON file
/data/{model}/{id}/{field}      # Field value (for relationships)

/sys/models/                    # Model definitions (introspection)
/sys/models/{model}             # Single model definition
/sys/fields/{model}/            # Field definitions for model
/sys/fields/{model}/{field}     # Single field definition
```

## DataModel Implementation

Create a new model type that bridges VFS and DatabaseService:

### `src/vfs/models/data.ts`

```typescript
import { PosixModel } from '../model';
import type { ModelContext, ModelStat, FileHandle, FieldDef } from '../model';
import type { DatabaseService } from '../../db/database';
import type { ModelCache } from '../../db/model-cache';
import { respond } from '../../message';

/**
 * DataModel - Exposes database records as files
 *
 * Maps VFS operations to DatabaseService:
 * - open(id) → selectById, return JSON handle
 * - stat(id) → selectById, return metadata
 * - create(parent, name) → createOne
 * - unlink(id) → deleteOne
 * - list(modelId) → selectAny
 */
export class DataModel extends PosixModel {
    readonly name = 'data';

    constructor(
        private db: DatabaseService,
        private cache: ModelCache
    ) {
        super();
    }

    fields(): FieldDef[] {
        // Dynamic - based on the specific model being accessed
        return [];
    }

    /**
     * Get record as file stat
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        // ID format: {model}:{recordId}
        const [modelName, recordId] = this.parseId(id);

        if (!recordId) {
            // Model directory
            return this.modelDirectoryStat(modelName);
        }

        const record = this.db.selectById(modelName, recordId);
        if (!record) {
            throw new Error(`Record not found: ${modelName}/${recordId}`);
        }

        return this.recordToStat(modelName, record);
    }

    /**
     * Open record for reading/writing
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: number,
        opts?: Record<string, unknown>
    ): Promise<FileHandle> {
        const [modelName, recordId] = this.parseId(id);

        if (!recordId) {
            throw new Error('Cannot open model directory');
        }

        const record = this.db.selectById(modelName, recordId);
        if (!record) {
            throw new Error(`Record not found: ${modelName}/${recordId}`);
        }

        return new DataRecordHandle(
            id,
            modelName,
            recordId,
            record,
            this.db,
            flags
        );
    }

    /**
     * Create new record
     */
    async create(
        ctx: ModelContext,
        parentId: string,
        name: string,
        fields?: Record<string, unknown>
    ): Promise<string> {
        // parentId is the model name
        const modelName = parentId;

        // name could be the ID (if provided) or auto-generated
        const data = fields || {};
        if (name && name !== 'new') {
            data.id = name;
        }

        const record = await this.db.createOne(modelName, data);
        return `${modelName}:${record.id}`;
    }

    /**
     * Delete record
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        const [modelName, recordId] = this.parseId(id);

        if (!recordId) {
            throw new Error('Cannot delete model directory');
        }

        await this.db.deleteOne(modelName, recordId);
    }

    /**
     * List records in model
     */
    async *list(ctx: ModelContext, id: string): AsyncIterable<string> {
        const modelName = id;

        // Verify model exists
        const model = this.cache.get(modelName);
        if (!model) {
            throw new Error(`Model not found: ${modelName}`);
        }

        const records = this.db.selectAny(modelName, {}, { limit: 1000 });

        for (const record of records) {
            yield `${modelName}:${record.id}`;
        }
    }

    /**
     * Set record fields
     */
    async setstat(
        ctx: ModelContext,
        id: string,
        fields: Record<string, unknown>
    ): Promise<void> {
        const [modelName, recordId] = this.parseId(id);

        if (!recordId) {
            throw new Error('Cannot update model directory');
        }

        await this.db.updateOne(modelName, recordId, fields);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private parseId(id: string): [string, string | null] {
        const parts = id.split(':');
        return [parts[0], parts[1] || null];
    }

    private modelDirectoryStat(modelName: string): ModelStat {
        const model = this.cache.get(modelName);
        if (!model) {
            throw new Error(`Model not found: ${modelName}`);
        }

        return {
            id: modelName,
            model: 'folder',  // Appears as directory
            name: modelName,
            parent: 'data',
            owner: 'system',
            size: 0,
            mtime: Date.now(),
            ctime: Date.now(),
        };
    }

    private recordToStat(modelName: string, record: any): ModelStat {
        const content = JSON.stringify(record, null, 2);

        return {
            id: `${modelName}:${record.id}`,
            model: 'data',
            name: record.id,
            parent: modelName,
            owner: record.created_by || 'system',
            size: new TextEncoder().encode(content).length,
            mtime: new Date(record.updated_at).getTime(),
            ctime: new Date(record.created_at).getTime(),
            mimetype: 'application/json',
        };
    }
}

/**
 * Handle for reading/writing a record
 */
class DataRecordHandle implements FileHandle {
    private content: Uint8Array;
    private position: number = 0;
    private dirty: boolean = false;

    constructor(
        public readonly id: string,
        private modelName: string,
        private recordId: string,
        private record: Record<string, unknown>,
        private db: DatabaseService,
        private flags: number
    ) {
        // Serialize record to JSON
        this.content = new TextEncoder().encode(
            JSON.stringify(record, null, 2)
        );
    }

    get closed(): boolean {
        return false;  // Managed externally
    }

    async read(size?: number): Promise<Uint8Array> {
        const chunk = this.content.slice(
            this.position,
            size ? this.position + size : undefined
        );
        this.position += chunk.length;
        return chunk;
    }

    async write(data: Uint8Array): Promise<number> {
        // Accumulate writes (simple append for now)
        const newContent = new Uint8Array(this.content.length + data.length);
        newContent.set(this.content);
        newContent.set(data, this.content.length);
        this.content = newContent;
        this.dirty = true;
        return data.length;
    }

    async seek(offset: number, whence: number): Promise<number> {
        switch (whence) {
            case 0: // SEEK_SET
                this.position = offset;
                break;
            case 1: // SEEK_CUR
                this.position += offset;
                break;
            case 2: // SEEK_END
                this.position = this.content.length + offset;
                break;
        }
        return this.position;
    }

    async close(): Promise<void> {
        if (this.dirty) {
            // Parse content back to record and update
            const text = new TextDecoder().decode(this.content);
            const data = JSON.parse(text);

            // Remove system fields - they shouldn't be overwritten
            delete data.id;
            delete data.created_at;
            delete data.updated_at;
            delete data.trashed_at;
            delete data.expired_at;

            await this.db.updateOne(this.modelName, this.recordId, data);
        }
    }
}
```

## VFS Mount Configuration

### Registering the DataModel

```typescript
// In VFS initialization (src/vfs/vfs.ts)

import { DataModel } from './models/data';

class VFS {
    private dataModel: DataModel;

    async init(db: DatabaseService, cache: ModelCache): Promise<void> {
        // ... existing init ...

        // Register data model
        this.dataModel = new DataModel(db, cache);
        this.registerModel('data', this.dataModel);

        // Mount /data as data model root
        this.mountData('/data', this.dataModel);
    }
}
```

### Path Resolution Changes

```typescript
// In VFS path resolution

async resolve(path: string): Promise<{ model: Model; id: string }> {
    const parts = path.split('/').filter(Boolean);

    // Handle /data paths specially
    if (parts[0] === 'data') {
        if (parts.length === 1) {
            // /data - list all models
            return { model: this.dataModel, id: 'root' };
        }

        const modelName = parts[1];

        if (parts.length === 2) {
            // /data/invoices - list records
            return { model: this.dataModel, id: modelName };
        }

        // /data/invoices/abc123 - specific record
        const recordId = parts[2];
        return { model: this.dataModel, id: `${modelName}:${recordId}` };
    }

    // ... existing resolution for other paths ...
}
```

## Syscall Integration

### File Operations

```typescript
// In kernel/syscalls/file.ts

case 'file:stat':
    const resolved = await vfs.resolve(path);
    const stat = await resolved.model.stat(ctx, resolved.id);
    return respond.ok(stat);

case 'file:open':
    const resolved = await vfs.resolve(path);
    const handle = await resolved.model.open(ctx, resolved.id, flags);
    const fd = kernel.allocHandle(handle);
    return respond.ok({ fd });

case 'file:readdir':
    const resolved = await vfs.resolve(path);
    const entries: ModelStat[] = [];
    for await (const id of resolved.model.list(ctx, resolved.id)) {
        const stat = await resolved.model.stat(ctx, id);
        entries.push(stat);
    }
    return respond.ok(entries);
```

### Data-Specific Operations

Add new syscalls for data operations:

```typescript
// New syscalls for structured data access

case 'data:query':
    // Query with filters
    const { model, where, limit, offset, order } = msg.data;
    const records = db.selectAny(model, where, { limit, offset, order });
    return respond.ok(records);

case 'data:create':
    // Create record
    const { model, data } = msg.data;
    const record = await db.createOne(model, data);
    return respond.ok(record);

case 'data:update':
    // Update record
    const { model, id, changes } = msg.data;
    const updated = await db.updateOne(model, id, changes);
    return respond.ok(updated);

case 'data:delete':
    // Delete record
    const { model, id } = msg.data;
    await db.deleteOne(model, id);
    return respond.ok();
```

## Example Usage

### From Process (Userland)

```typescript
import * as fs from 'process/fs';
import * as data from 'process/data';

// List all invoices (via filesystem)
const entries = await fs.readdir('/data/invoices');
for (const entry of entries) {
    console.log(entry.name);  // Record IDs
}

// Read a record (via filesystem)
const content = await fs.readFile('/data/invoices/abc123');
const invoice = JSON.parse(new TextDecoder().decode(content));

// Create a record (via filesystem)
await fs.writeFile('/data/invoices/new', JSON.stringify({
    number: 'INV-001',
    customer_id: 'cust-xyz',
    total: 100.00,
    status: 'draft',
}));

// Or use data API directly (more efficient)
const invoice = await data.create('invoices', {
    number: 'INV-001',
    customer_id: 'cust-xyz',
    total: 100.00,
    status: 'draft',
});

// Query with filters
const paidInvoices = await data.query('invoices', {
    where: { status: 'paid' },
    order: ['created_at desc'],
    limit: 10,
});
```

### From External (OS API)

```typescript
import { OS } from '@monk/os';

const os = new OS();
await os.boot();

// Via filesystem API
const invoices = await os.fs.readdir('/data/invoices');

// Via direct database (if exposed)
const paidInvoices = os.data.query('invoices', {
    where: { status: 'paid' },
});
```

## Relationship Traversal

### Path-Based Traversal

```
/data/invoices/abc123/customer    → Returns the related customer record
/data/customers/xyz/invoices      → Returns all invoices for customer
```

```typescript
// In DataModel.stat() or a specialized handler

async statField(modelName: string, recordId: string, fieldName: string): Promise<ModelStat> {
    const model = this.cache.require(modelName);
    const field = model.getField(fieldName);

    if (!field) {
        throw new Error(`Field '${fieldName}' not found on model '${modelName}'`);
    }

    // If it's a relationship field, return the related record
    if (field.relationship_type) {
        const record = this.db.selectById(modelName, recordId);
        const relatedId = record[fieldName];

        if (!relatedId) {
            throw new Error(`Record has no ${fieldName}`);
        }

        const relatedRecord = this.db.selectById(field.related_model!, relatedId as string);
        return this.recordToStat(field.related_model!, relatedRecord);
    }

    // Otherwise return field value as file
    const record = this.db.selectById(modelName, recordId);
    const value = record[fieldName];

    return {
        id: `${modelName}:${recordId}:${fieldName}`,
        model: 'data',
        name: fieldName,
        parent: `${modelName}:${recordId}`,
        owner: 'system',
        size: JSON.stringify(value).length,
        mtime: Date.now(),
        ctime: Date.now(),
        mimetype: 'application/json',
    };
}
```

## Preserving Existing Models

The existing FileModel, FolderModel, DeviceModel, ProcModel continue to work for:

```
/tmp/                    # FileModel (temporary files)
/dev/                    # DeviceModel (virtual devices)
/proc/                   # ProcModel (process info)
/vol/                    # FileModel (mounted volumes)
/data/                   # DataModel (NEW - database records)
```

The VFS routes based on path prefix:

```typescript
async resolve(path: string): Promise<{ model: Model; id: string }> {
    const parts = path.split('/').filter(Boolean);

    switch (parts[0]) {
        case 'data':
            return this.resolveData(parts.slice(1));
        case 'dev':
            return this.resolveDevice(parts.slice(1));
        case 'proc':
            return this.resolveProc(parts.slice(1));
        case 'sys':
            return this.resolveSys(parts.slice(1));
        default:
            return this.resolveFile(parts);
    }
}
```

## Directory Structure

```
src/vfs/
├── models/
│   ├── file.ts          # Existing - regular files
│   ├── folder.ts        # Existing - directories
│   ├── device.ts        # Existing - /dev/*
│   ├── proc.ts          # Existing - /proc/*
│   ├── data.ts          # NEW - database records
│   └── sys.ts           # NEW - model introspection (optional)
```

## Acceptance Criteria

- [ ] `/data/{model}/` lists all records in model
- [ ] `/data/{model}/{id}` returns record as JSON
- [ ] `stat()` on record returns size, mtime, etc.
- [ ] `open()` returns readable JSON content
- [ ] `write()` and close updates record in database
- [ ] `create()` via writeFile creates new record
- [ ] `unlink()` soft-deletes record
- [ ] Validation errors propagate properly
- [ ] Existing /tmp, /dev, /proc paths still work
- [ ] Relationship traversal works (optional)
- [ ] Data-specific syscalls available for efficiency

## Performance Considerations

1. **Caching:** ModelCache prevents repeated model/field queries
2. **Streaming:** Large result sets should stream, not buffer
3. **Lazy Loading:** Don't load record content until read()
4. **Batch Operations:** Support bulk operations via syscalls

## Next Steps

After VFS integration:

1. **Query API** (Phase 7) - Rich query interface beyond path access
2. **Indexing** - Full-text search for searchable fields
3. **Relationships** - Proper traversal and loading
4. **Permissions** - ACL integration with database records
