# EMS Module

The Entity Management System provides a database-backed entity store with CRUD operations, soft delete, and a powerful query system. All EMS operations are exposed as `ems:*` syscalls.

## Syscall Reference

### Query Operations

#### `ems:select`

Query entities matching filter criteria. Returns results as a stream.

```typescript
const users = await os.ems<User[]>('select', 'User', filter);
```

**Parameters:**
- `model: string` - Model/table name
- `filter?: FilterData` - Query filter (optional)

**FilterData:**
```typescript
interface FilterData {
    where?: WhereConditions;  // Filter conditions
    order?: OrderSpec[];      // Sort order
    limit?: number;           // Max records
    offset?: number;          // Skip records
    select?: string[];        // Fields to return
}
```

**Returns:** Array of matching records

**Errors:**
- `EINVAL` - Invalid model name
- `EIO` - Database error

---

### Mutation Operations

#### `ems:create`

Create a new entity.

```typescript
const user = await os.ems<User>('create', 'User', {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
});
```

**Parameters:**
- `model: string` - Model/table name
- `fields: object` - Entity data (id auto-generated if not provided)

**Returns:** Created record with generated `id`, `created_at`, `updated_at`

**Errors:**
- `EINVAL` - Invalid model or fields
- `EIO` - Database error (constraint violation, etc.)

---

#### `ems:update`

Update an existing entity by ID.

```typescript
const updated = await os.ems<User>('update', 'User', userId, {
    role: 'moderator',
    updatedBy: currentUserId,
});
```

**Parameters:**
- `model: string` - Model/table name
- `id: string` - Entity ID (UUID)
- `changes: object` - Fields to update

**Returns:** Updated record

**Errors:**
- `EINVAL` - Invalid arguments
- `ENOENT` - Entity not found
- `EIO` - Database error

---

#### `ems:delete`

Soft delete an entity (sets `trashed_at` timestamp).

```typescript
const deleted = await os.ems<User>('delete', 'User', userId);
```

**Parameters:**
- `model: string` - Model/table name
- `id: string` - Entity ID

**Returns:** Deleted record (with `trashed_at` set)

**Errors:**
- `EINVAL` - Invalid arguments
- `ENOENT` - Entity not found
- `EIO` - Database error

---

#### `ems:revert`

Restore a soft-deleted entity (clears `trashed_at`).

```typescript
const restored = await os.ems<User>('revert', 'User', userId);
```

**Parameters:**
- `model: string` - Model/table name
- `id: string` - Entity ID

**Returns:** Restored record (with `trashed_at` cleared)

**Errors:**
- `EINVAL` - Invalid arguments
- `ENOENT` - Entity not found
- `EIO` - Database error

---

#### `ems:expire`

Permanently delete an entity (hard delete).

```typescript
const expired = await os.ems<User>('expire', 'User', userId);
```

**Parameters:**
- `model: string` - Model/table name
- `id: string` - Entity ID

**Returns:** Deleted record (before removal)

**Errors:**
- `EINVAL` - Invalid arguments
- `ENOENT` - Entity not found
- `EIO` - Database error

---

## Filter Operators

The `where` clause supports 26 operators for complex queries.

### Comparison Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `$eq` | Equal (implicit default) | `{ status: 'active' }` or `{ status: { $eq: 'active' } }` |
| `$ne` / `$neq` | Not equal | `{ status: { $ne: 'deleted' } }` |
| `$gt` | Greater than | `{ age: { $gt: 18 } }` |
| `$gte` | Greater than or equal | `{ age: { $gte: 21 } }` |
| `$lt` | Less than | `{ price: { $lt: 100 } }` |
| `$lte` | Less than or equal | `{ quantity: { $lte: 0 } }` |

### Pattern Matching

| Operator | Description | Example |
|----------|-------------|---------|
| `$like` | SQL LIKE pattern | `{ name: { $like: 'John%' } }` |
| `$ilike` | Case-insensitive LIKE | `{ email: { $ilike: '%@gmail.com' } }` |
| `$nlike` | NOT LIKE | `{ name: { $nlike: 'test%' } }` |
| `$nilike` | NOT case-insensitive LIKE | `{ email: { $nilike: '%@test.com' } }` |
| `$regex` | Regular expression | `{ phone: { $regex: '^\\+1' } }` |
| `$nregex` | NOT regex | `{ code: { $nregex: '^TEST' } }` |

### Text Search

| Operator | Description | Example |
|----------|-------------|---------|
| `$find` / `$text` | Simple text search | `{ description: { $find: 'important' } }` |

### Array Membership

| Operator | Description | Example |
|----------|-------------|---------|
| `$in` | Value in array | `{ status: { $in: ['active', 'pending'] } }` |
| `$nin` | Value not in array | `{ role: { $nin: ['banned', 'suspended'] } }` |

### Range & Null

| Operator | Description | Example |
|----------|-------------|---------|
| `$between` | Value between range | `{ age: { $between: [18, 65] } }` |
| `$exists` | Field is not null | `{ email: { $exists: true } }` |
| `$null` | Field is null | `{ deleted_at: { $null: true } }` |

### JSON Array

| Operator | Description | Example |
|----------|-------------|---------|
| `$size` | JSON array length | `{ tags: { $size: 3 } }` |

### Logical Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `$and` | All conditions match | `{ $and: [{ a: 1 }, { b: 2 }] }` |
| `$or` | Any condition matches | `{ $or: [{ status: 'active' }, { role: 'admin' }] }` |
| `$not` | Negate condition | `{ $not: { status: 'deleted' } }` |
| `$nand` | NOT AND | `{ $nand: [{ a: 1 }, { b: 2 }] }` |
| `$nor` | NOT OR | `{ $nor: [{ banned: true }, { suspended: true }] }` |

---

## Order Specification

Sort results with the `order` option:

```typescript
// Single field
await os.ems('select', 'User', {
    order: { field: 'created_at', sort: 'desc' }
});

// Multiple fields
await os.ems('select', 'User', {
    order: [
        { field: 'role', sort: 'asc' },
        { field: 'name', sort: 'asc' }
    ]
});

// Shorthand strings
await os.ems('select', 'User', {
    order: 'name'           // Ascending
});
await os.ems('select', 'User', {
    order: ['-created_at']  // Descending (prefix with -)
});
```

---

## Pagination

Use `limit` and `offset` for pagination:

```typescript
// First page (10 items)
const page1 = await os.ems('select', 'User', {
    limit: 10,
    offset: 0
});

// Second page
const page2 = await os.ems('select', 'User', {
    limit: 10,
    offset: 10
});
```

---

## Soft Delete Handling

By default, `ems:select` excludes soft-deleted records. The underlying EntityOps supports a `trashed` option:

- `'exclude'` (default) - Only non-deleted records
- `'include'` - Both deleted and non-deleted
- `'only'` - Only deleted records

Note: The syscall layer currently uses the default behavior. For advanced trash handling, use the EntityOps API directly via `os.getEMS().ops`.

---

## Entity Record Structure

All entities have these system fields:

```typescript
interface EntityRecord {
    id: string;           // UUID primary key
    created_at: string;   // ISO timestamp
    updated_at: string;   // ISO timestamp
    trashed_at?: string;  // Set when soft-deleted
    expired_at?: string;  // Set when hard-deleted (before removal)
    // ... user-defined fields
}
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `EINVAL` | Invalid argument (bad model name, missing fields) |
| `ENOENT` | Entity not found |
| `EIO` | Database/IO error |

---

## Examples

### Query with Complex Filter

```typescript
// Find active users in marketing or sales, created this year
const users = await os.ems<User[]>('select', 'User', {
    where: {
        status: 'active',
        $or: [
            { department: 'marketing' },
            { department: 'sales' }
        ],
        created_at: { $gte: '2025-01-01' }
    },
    order: [
        { field: 'department', sort: 'asc' },
        { field: 'name', sort: 'asc' }
    ],
    limit: 50
});
```

### CRUD Workflow

```typescript
// Create
const user = await os.ems<User>('create', 'User', {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'user'
});
console.log('Created:', user.id);

// Read
const [found] = await os.ems<User[]>('select', 'User', {
    where: { id: user.id }
});

// Update
const updated = await os.ems<User>('update', 'User', user.id, {
    role: 'admin'
});

// Soft delete
await os.ems('delete', 'User', user.id);

// Restore
await os.ems('revert', 'User', user.id);

// Hard delete
await os.ems('expire', 'User', user.id);
```

### Search with Pagination

```typescript
async function searchUsers(query: string, page: number, pageSize = 20) {
    return os.ems<User[]>('select', 'User', {
        where: {
            $or: [
                { name: { $ilike: `%${query}%` } },
                { email: { $ilike: `%${query}%` } }
            ]
        },
        order: { field: 'name', sort: 'asc' },
        limit: pageSize,
        offset: page * pageSize
    });
}
```

### Batch Operations via Streaming

For large datasets, use `syscallStream` to process records as they arrive:

```typescript
const stream = os.syscallStream('ems:select', 'LogEntry', {
    where: { level: 'error' },
    order: { field: 'timestamp', sort: 'desc' }
});

for await (const response of stream) {
    if (response.op === 'item') {
        const entry = response.data as LogEntry;
        console.log(`[${entry.timestamp}] ${entry.message}`);
    }
}
```
