# Phase 6: VFS Integration

## Overview

Wire VFS operations to the entity+data architecture, starting with `/tmp` as a proof-of-concept.

**Approach:** Incremental. Start simple, learn as we go.

## Architecture

```
/tmp/foo.txt
    │
    ├── Entity (SQL) ─────────────────────┐
    │   `temp` table                      │
    │   - id, name, parent, owner         │
    │   - size, mimetype                  │
    │   - created_at, updated_at          │
    │                                     │
    │   stat() ──► SELECT from temp       │
    │   setstat() ──► Observer pipeline   │
    │                                     │
    └── Data (HAL) ───────────────────────┘
        blob storage (keyed by entity id)

        read() ──► HAL.storage.get(id)
        write() ──► HAL.storage.put(id, data)
```

**Key principle:** Entity metadata in SQL (with observer validation), blob data in HAL (direct I/O).

## Implementation Plan

### Step 1: Add `temp` model to schema.sql

```sql
-- =============================================================================
-- TEMP TABLE (for /tmp filesystem)
-- =============================================================================

CREATE TABLE IF NOT EXISTS temp (
    -- System fields
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,

    -- File metadata
    name        TEXT NOT NULL,
    parent      TEXT,           -- Parent temp id (for nested folders, future)
    owner       TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    mimetype    TEXT
);

CREATE INDEX IF NOT EXISTS idx_temp_parent ON temp(parent) WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temp_name ON temp(parent, name) WHERE trashed_at IS NULL;

-- Seed model definition
INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('temp', 'system', 'Temporary file storage');

-- Seed field definitions
INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('temp', 'name', 'text', 1, 'Filename'),
    ('temp', 'parent', 'text', 0, 'Parent folder id'),
    ('temp', 'owner', 'text', 1, 'Owner process/user'),
    ('temp', 'size', 'integer', 0, 'File size in bytes'),
    ('temp', 'mimetype', 'text', 0, 'MIME type');
```

### Step 2: Create TempModel class

```typescript
// src/vfs/models/temp.ts

import { PosixModel } from '../model.js';
import type { ModelStat, ModelContext, FieldDef } from '../model.js';
import type { FileHandle, OpenFlags } from '../handle.js';
import type { DatabaseOps } from '../../model/database-ops.js';
import { ENOENT, EEXIST } from '../../hal/index.js';

/**
 * TempModel - SQL-backed file storage for /tmp
 *
 * Entity metadata stored in SQL `temp` table.
 * Blob data stored in HAL storage (keyed by entity id).
 */
export class TempModel extends PosixModel {
    readonly name = 'temp';

    constructor(
        private db: DatabaseOps,
        private hal: HAL
    ) {
        super();
    }

    fields(): FieldDef[] {
        return [
            { name: 'id', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
            { name: 'parent', type: 'string' },
            { name: 'owner', type: 'string', required: true },
            { name: 'size', type: 'number' },
            { name: 'mimetype', type: 'string' },
        ];
    }

    /**
     * Get file metadata from SQL
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const records = await this.db.selectAll('temp', { id });
        const entity = records[0];

        if (!entity || entity.trashed_at) {
            throw new ENOENT(`temp file not found: ${id}`);
        }

        return {
            id: entity.id,
            model: 'temp',
            name: entity.name,
            parent: entity.parent || 'tmp-root',
            owner: entity.owner,
            size: entity.size || 0,
            mtime: new Date(entity.updated_at).getTime(),
            ctime: new Date(entity.created_at).getTime(),
            mimetype: entity.mimetype,
        };
    }

    /**
     * Update file metadata via observer pipeline
     */
    async setstat(ctx: ModelContext, id: string, fields: Record<string, unknown>): Promise<void> {
        await this.db.updateAll('temp', [{ id, ...fields }]);
    }

    /**
     * Create new temp file
     */
    async create(
        ctx: ModelContext,
        parentId: string | null,
        name: string,
        fields?: Record<string, unknown>
    ): Promise<string> {
        const results = await this.db.createAll('temp', [{
            name,
            parent: parentId,
            owner: ctx.caller,
            size: 0,
            mimetype: fields?.mimetype || 'application/octet-stream',
            ...fields,
        }]);

        return results[0].id;
    }

    /**
     * Open file for reading/writing
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags
    ): Promise<FileHandle> {
        // Verify entity exists
        const records = await this.db.selectAll('temp', { id });
        if (!records[0] || records[0].trashed_at) {
            throw new ENOENT(`temp file not found: ${id}`);
        }

        // Load blob from HAL (or empty if new)
        let content: Uint8Array;
        try {
            content = await this.hal.storage.get(`temp:${id}`);
        } catch {
            content = new Uint8Array(0);
        }

        return new TempFileHandle(id, content, this.db, this.hal);
    }

    /**
     * Delete temp file (soft delete)
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        await this.db.deleteAll('temp', [{ id }]);

        // Also remove blob
        try {
            await this.hal.storage.delete(`temp:${id}`);
        } catch {
            // Ignore - blob may not exist
        }
    }

    /**
     * List temp files (flat for now)
     */
    async *list(ctx: ModelContext, parentId: string | null): AsyncIterable<string> {
        const records = await this.db.selectAll('temp', { parent: parentId });
        for (const record of records) {
            if (!record.trashed_at) {
                yield record.id;
            }
        }
    }
}

/**
 * File handle for temp files
 */
class TempFileHandle implements FileHandle {
    private content: Uint8Array;
    private position = 0;
    private dirty = false;
    private _closed = false;

    constructor(
        public readonly id: string,
        initialContent: Uint8Array,
        private db: DatabaseOps,
        private hal: HAL
    ) {
        this.content = initialContent;
    }

    get closed(): boolean {
        return this._closed;
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
        // Expand buffer if needed
        const endPos = this.position + data.length;
        if (endPos > this.content.length) {
            const newContent = new Uint8Array(endPos);
            newContent.set(this.content);
            this.content = newContent;
        }

        // Write data at position
        this.content.set(data, this.position);
        this.position += data.length;
        this.dirty = true;

        return data.length;
    }

    async seek(offset: number, whence: number): Promise<number> {
        switch (whence) {
            case 0: this.position = offset; break;           // SEEK_SET
            case 1: this.position += offset; break;          // SEEK_CUR
            case 2: this.position = this.content.length + offset; break; // SEEK_END
        }
        return this.position;
    }

    async close(): Promise<void> {
        if (this._closed) return;

        if (this.dirty) {
            // Write blob to HAL
            await this.hal.storage.put(`temp:${this.id}`, this.content);

            // Update size in SQL
            await this.db.updateAll('temp', [{
                id: this.id,
                size: this.content.length,
            }]);
        }

        this._closed = true;
    }
}
```

### Step 3: Wire into Kernel

```typescript
// In kernel boot sequence

import { TempModel } from '../vfs/models/temp.js';
import { DatabaseOps } from '../model/database-ops.js';

// After VFS and database are initialized...
private async initTempModel(): Promise<void> {
    const tempModel = new TempModel(this.db, this.hal);

    // Register model with VFS
    this.vfs.registerModel('temp', tempModel);

    // Mount at /tmp
    // (implementation depends on VFS mount system)
}
```

### Step 4: Path Resolution

The VFS needs to route `/tmp/*` paths to TempModel:

```typescript
// In VFS path resolution

async resolve(path: string): Promise<{ model: Model; id: string }> {
    const parts = path.split('/').filter(Boolean);

    if (parts[0] === 'tmp') {
        // Route to TempModel
        if (parts.length === 1) {
            return { model: this.tempModel, id: null }; // /tmp directory
        }

        // /tmp/filename - look up by name
        const name = parts[1];
        const records = await this.db.selectAll('temp', { name, parent: null });
        if (records[0]) {
            return { model: this.tempModel, id: records[0].id };
        }

        throw new ENOENT(path);
    }

    // ... existing resolution for other paths
}
```

## What This Proves

Once `/tmp` works with entity+data architecture:

1. **Observer pipeline works for VFS** - setstat() validates via Ring 1, audits via Ring 7
2. **SQL queryability** - Can query temp files: `SELECT * FROM temp WHERE size > 1000`
3. **Separation works** - Entity in SQL, blob in HAL, both accessible
4. **Pattern is repeatable** - Can apply same approach to `/vol`, `/data`, etc.

## Future Expansion

After `/tmp` works:

| Path | Model | Entity Storage | Blob Storage |
|------|-------|----------------|--------------|
| `/tmp` | temp | SQL `temp` table | HAL blob |
| `/vol` | file | SQL `file` table | HAL blob |
| `/data/{model}` | data | SQL `{model}` table | None (JSON only) |
| `/dev` | device | SQL `device` table | None |
| `/proc` | proc | SQL `proc` table | Dynamic |

## Acceptance Criteria

- [ ] `temp` model exists in schema.sql
- [ ] TempModel class implemented
- [ ] Can create file in `/tmp` via VFS
- [ ] Entity metadata stored in SQL `temp` table
- [ ] Blob data stored in HAL
- [ ] `stat()` reads from SQL
- [ ] `setstat()` goes through observer pipeline
- [ ] `read()`/`write()` use HAL blob storage
- [ ] Existing tests pass

## Non-Goals (For Now)

- Nested folders in `/tmp` (flat only)
- Auto-expiration of temp files
- Full `/vol` migration
- `/data` path for user models

Keep it simple. Learn as we go.
