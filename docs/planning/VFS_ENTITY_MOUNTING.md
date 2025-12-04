# VFS Entity Mounting

## Overview

This document describes two related features that enable "everything is a file" for EMS entities:

1. **`fields.pathname` flag** - Controls which field value becomes an entity's filename in VFS
2. **Model mounting** - Projects filtered entity sets as virtual directories

Together, these features allow any entity type to appear in the VFS namespace without requiring explicit file/folder semantics.

## Current State

### What Works

- `entities.pathname` column stores the entity's name in its parent directory
- `entities.parent` column stores the parent entity UUID
- `EntityCache` resolves paths via parent/pathname hierarchy
- VFS `resolvePath()` walks the tree using `EntityCache.getChild(parentId, name)`

### What's Missing

- No way to derive pathname from a model field dynamically
- No way to mount a model type as a virtual directory
- Entities must be explicitly placed with a parent to appear in VFS

## Feature 1: `fields.pathname` Flag

### Concept

A boolean column on the `fields` table that marks which field provides the VFS filename for entities of that model.

### Schema Change

```sql
ALTER TABLE fields ADD COLUMN pathname BOOLEAN DEFAULT FALSE;

-- Constraint: at most one pathname field per model
CREATE UNIQUE INDEX idx_fields_pathname_unique
ON fields (model_name)
WHERE pathname = TRUE;
```

### Behavior

When an entity is created or updated:
1. Find the field with `pathname=true` for this model
2. Use that field's value as `entities.pathname`
3. If no pathname field defined, fall back to `entities.id` (UUID)

### Example

```sql
-- Define contact model with email as pathname
INSERT INTO fields (model_name, field_name, type, pathname)
VALUES ('contact', 'email', 'text', TRUE);

INSERT INTO fields (model_name, field_name, type, pathname)
VALUES ('contact', 'legal_name', 'text', FALSE);
```

```typescript
// Create a contact under /home/user/contacts
await entityOps.createAll('contact', [{
    parent: contactsFolderId,
    email: 'bob@example.com',
    legal_name: 'Bob Smith',
}]);

// Result: /home/user/contacts/bob@example.com exists
// The pathname was derived from the email field
```

### Implementation Location

- **Ring 1 (Pre-validation)**: Look up pathname field for model
- **Ring 2 (Field validation)**: Ensure pathname field has a value
- **Ring 3 (Transform)**: Copy pathname field value to `entities.pathname`
- **Ring 8 (Cache sync)**: EntityCache updated with derived pathname

### Edge Cases

| Case | Behavior |
|------|----------|
| No pathname field defined | Use entity UUID as pathname |
| Pathname field is null/empty | Validation error (required) |
| Duplicate pathname in same parent | Validation error (unique constraint) |
| Pathname field value changes | Update `entities.pathname`, EntityCache invalidated |
| Field contains `/` or invalid chars | Sanitize or reject |

## Feature 2: Model Mounting

### Concept

Mount all entities of a model type (optionally filtered) as a virtual directory. The entities don't need to have that directory as their actual parent - it's a projection/view.

### API

```typescript
interface ModelMountOptions {
    /** Filter entities (WHERE clause) */
    where?: FilterConditions;
    /** Sort order for readdir */
    orderBy?: string;
    /** Maximum entities to show */
    limit?: number;
    /** Read-only mount (no create/delete via VFS) */
    readonly?: boolean;
}

class VFS {
    /**
     * Mount a model type as a virtual directory.
     *
     * @param vfsPath - Path where entities appear
     * @param modelName - Model to mount
     * @param options - Filter, sort, limits
     */
    mountModel(vfsPath: string, modelName: string, options?: ModelMountOptions): void;

    /**
     * Unmount a model mount.
     */
    unmountModel(vfsPath: string): void;
}
```

### Example

```typescript
// Mount all active contacts at /vol/shared/contacts
vfs.mountModel('/vol/shared/contacts', 'contact', {
    where: { status: 'active' },
    orderBy: 'legal_name',
});

// If contact model has legal_name as pathname field:
// /vol/shared/contacts/
//   ├── Alice Jones      → contact entity (actual parent: /org/sales/contacts)
//   ├── Bob Smith        → contact entity (actual parent: /org/hr/contacts)
//   └── Charlie Brown    → contact entity (actual parent: /personal/contacts)

// Read a contact
const handle = await vfs.open('/vol/shared/contacts/Bob Smith');
const data = await handle.read();  // Returns contact entity as JSON? Or custom format?

// List contacts
for await (const entry of vfs.readdir('/vol/shared/contacts')) {
    console.log(entry.name);  // "Alice Jones", "Bob Smith", etc.
}
```

### Path Resolution Changes

```typescript
private async resolvePath(path: string): Promise<string | null> {
    // 1. Check model mounts first (longest prefix match)
    const modelMount = this.findModelMount(path);
    if (modelMount) {
        return this.resolveModelMountPath(modelMount, path);
    }

    // 2. Existing: walk EntityCache tree
    // ...
}

private async resolveModelMountPath(
    mount: ModelMount,
    path: string
): Promise<string | null> {
    // Extract filename from path
    const filename = path.slice(mount.vfsPath.length + 1);

    if (!filename) {
        // Mount root - return synthetic folder ID
        return `mount:${mount.id}`;
    }

    // Query for entity with matching pathname
    const entities = await this.entityOps.selectAny(mount.modelName, {
        where: {
            ...mount.options.where,
            // Match against the pathname-flagged field
            [mount.pathnameField]: filename,
        },
        limit: 1,
    });

    return entities[0]?.id ?? null;
}
```

### readdir for Model Mounts

```typescript
async *readdir(path: string): AsyncIterable<DirEntry> {
    const modelMount = this.findModelMount(path);
    if (modelMount) {
        // Query all matching entities
        for await (const entity of this.entityOps.selectAny(modelMount.modelName, {
            where: modelMount.options.where,
            orderBy: modelMount.options.orderBy,
            limit: modelMount.options.limit,
        })) {
            yield {
                name: entity[modelMount.pathnameField],
                id: entity.id,
                model: entity.model,
            };
        }
        return;
    }

    // Existing readdir logic...
}
```

### Write Operations

| Operation | Readonly Mount | Writable Mount |
|-----------|---------------|----------------|
| `open(read)` | Allowed | Allowed |
| `open(write)` | EROFS | Allowed (updates entity) |
| `create` | EROFS | Creates entity with mount's filter as defaults |
| `unlink` | EROFS | Deletes entity (or just removes from filter?) |
| `mkdir` | EROFS | Not applicable (flat projection) |

### Open Questions

1. **What format when reading an entity?**
   - JSON of all fields?
   - Custom serialization per model?
   - Just the blob data if model has a `data` field?

2. **Nested paths in model mounts?**
   - `/vol/contacts/Bob Smith/notes` - should this work?
   - Could support if contact has child entities

3. **Conflicting pathnames across entities?**
   - Two contacts with same `legal_name` but different actual parents
   - Options: error, append suffix, show first match only

4. **Real-time updates?**
   - Entity created elsewhere appears in mount immediately?
   - Requires watch/subscription on the query

5. **Permissions?**
   - Mount-level ACL vs entity-level ACL?
   - Intersection of both?

## Use Cases

### 1. User Home Directories

```typescript
// Each user entity appears as /home/<username>
vfs.mountModel('/home', 'user', {
    where: { status: 'active' },
});
// user.username is the pathname field
```

### 2. Process Listing

```typescript
// All running processes at /proc
vfs.mountModel('/proc', 'proc', {
    where: { status: { $in: ['running', 'sleeping'] } },
});
// proc.pid or proc.id is the pathname field
```

### 3. Shared Resources

```typescript
// Company-wide documents
vfs.mountModel('/vol/shared/docs', 'document', {
    where: { visibility: 'public' },
    orderBy: 'title',
});
```

### 4. Query as Folder

```typescript
// "Smart folder" - large files
vfs.mountModel('/queries/large-files', 'file', {
    where: { size: { $gt: 10_000_000 } },
    orderBy: '-size',
    limit: 100,
});
```

## Implementation Plan

### Phase 1: `fields.pathname` Flag

1. Add `pathname` column to `fields` table
2. Add unique partial index constraint
3. Modify Ring 3 to derive `entities.pathname` from flagged field
4. Update EntityCache sync in Ring 8
5. Add validation in Ring 2 for pathname field presence

### Phase 2: Model Mounting (Read-Only)

1. Add `ModelMount` type and mount table to VFS
2. Implement `mountModel()` / `unmountModel()` API
3. Modify `resolvePath()` to check model mounts
4. Implement `readdir()` for model mounts
5. Implement `open()` / `stat()` for mounted entities

### Phase 3: Model Mounting (Read-Write)

1. Implement `create()` for writable mounts
2. Implement `unlink()` semantics
3. Handle permission intersection
4. Add watch/subscription for real-time updates

## Related

- `src/ems/entity-cache.ts` - Path resolution cache
- `src/ems/schema.sql` - Entity/field schema
- `src/vfs/vfs.ts` - VFS implementation
- `docs/bugs/EMS_PARALLEL_WRITES.md` - Fixed parallel write issue
