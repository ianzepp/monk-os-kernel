# DELETE /api/data/:model

Remove many records at once—either by moving them to the trash (default) or, for root users, permanently erasing them with `permanent=true`. The operation accepts a list of IDs, making it ideal for scheduled cleanups or administrator-driven maintenance tasks.

## Path Parameters

- `:model` - Model name (required)

## Query Parameters

- `permanent=true` - Perform permanent delete (requires root access)

## Request Body

Always expects an **array of record objects with `id` fields**:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000"
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440001"
  }
]
```

**Important:** Each object **must include an `id` field** to identify which record to delete.

## Success Response (200)

### Soft Delete Response (Default)

Sets `trashed_at` to current timestamp:

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "John Doe",
      "email": "john@example.com",
      "department": "Engineering",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z",
      "trashed_at": "2024-01-15T12:00:00Z",
      "deleted_at": null
    }
  ]
}
```

### Permanent Delete Response (permanent=true)

Sets both `trashed_at` and `deleted_at` to current timestamp:

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "John Doe",
      "email": "john@example.com",
      "department": "Engineering",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T12:00:00Z",
      "trashed_at": "2024-01-15T12:00:00Z",
      "deleted_at": "2024-01-15T12:00:00Z"
    }
  ]
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `BODY_NOT_ARRAY` | "Request body must be an array of records with id fields" | Body is not an array or missing id fields |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `ACCESS_DENIED` | "Insufficient permissions for permanent delete" | permanent=true without root access |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Attempting to delete from frozen model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | One or more IDs don't exist |

## Transaction Behavior

All deletes in the request execute within a **single database transaction**:

✅ **All succeed together** - If every delete succeeds, all are persisted
❌ **All fail together** - If any delete fails, the entire batch is rolled back

## Soft Delete vs Permanent Delete

### Soft Delete (Default)

**What happens:**
- Sets `trashed_at = NOW()`
- Record remains in database
- Hidden from normal queries (unless `?include_trashed=true`)
- Can be restored with revert operation

**Use cases:**
- User-initiated deletes
- Trash bin functionality
- Recoverable deletions
- Audit trail preservation

**Example:**
```bash
DELETE /api/data/users
[{"id": "user-1"}, {"id": "user-2"}]

# Records moved to trash, can be restored
```

### Permanent Delete (permanent=true)

**What happens:**
- Sets `deleted_at = NOW()` (also sets `trashed_at = NOW()`)
- Record remains in database but marked as permanently deleted
- Hidden from all queries (except `?include_deleted=true` with root access)
- **Cannot be restored**

**Requirements:**
- Requires **root access level**
- Intended for compliance, data retention policies, or irreversible cleanup

**Use cases:**
- GDPR/privacy compliance (data removal requests)
- Regulatory data retention enforcement
- Cleanup of old test data
- Final removal after soft delete retention period

**Example:**
```bash
DELETE /api/data/users?permanent=true \
  -H "Authorization: Bearer ROOT_TOKEN"
[{"id": "user-1"}, {"id": "user-2"}]

# Records permanently deleted, cannot be restored
```

## Example Usage

### Soft Delete Multiple Records

```bash
curl -X DELETE http://localhost:9001/api/data/documents \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "doc-123"},
    {"id": "doc-456"},
    {"id": "doc-789"}
  ]'
```

### Permanent Delete (Root Only)

```bash
curl -X DELETE "http://localhost:9001/api/data/users?permanent=true" \
  -H "Authorization: Bearer ROOT_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "user-to-permanently-delete"}
  ]'
```

### Cleanup Old Records

```javascript
// Find old records to delete
const oldRecords = await fetch('/api/find/logs', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    where: {
      created_at: { $lt: '2023-01-01' }
    },
    select: ['id']
  })
});

const { data } = await oldRecords.json();

// Bulk soft delete
await fetch('/api/data/logs', {
  method: 'DELETE',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data) // Array of {id: "..."}
});
```

## Restoring Soft-Deleted Records

Soft-deleted records can be restored using the revert operation:

```bash
# Restore records from trash
PATCH /api/data/users?include_trashed=true \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "user-1"},
    {"id": "user-2"}
  ]'
```

See [`PUT /api/data/:model`](PUT.md#smart-routing-revert-operation) for details.

## Observer Pipeline

Deleted records pass through the observer pipeline:

### Pre-Delete Observers
- **Security** - Check delete permissions
- **Business Logic** - Custom deletion rules
- **Cascade Rules** - Handle related records

### Post-Delete Observers
- **Audit Logging** - Record deletion events
- **Notifications** - Trigger webhooks
- **Cleanup** - Remove related data, invalidate caches

If any observer throws an error, the transaction rolls back and no records are deleted.

## Model Protection

### Frozen Models

Models with `frozen=true` reject all delete operations:

```bash
DELETE /api/data/audit_log
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Models

Models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Deleting sensitive records"}

# Then use sudo token
DELETE /api/data/sensitive_data
Authorization: Bearer SUDO_TOKEN
```

## Cascade Behavior

**Note:** This endpoint does NOT automatically delete related records. You must explicitly:

1. Delete child records first
2. Then delete parent records

**Example:**
```javascript
// Wrong: This may fail if comments exist
await fetch('/api/data/posts', {
  method: 'DELETE',
  body: JSON.stringify([{id: 'post-123'}])
});

// Right: Delete children first, then parent
await fetch('/api/data/comments', {
  method: 'DELETE',
  body: JSON.stringify([
    {id: 'comment-1'},
    {id: 'comment-2'}
  ])
});

await fetch('/api/data/posts', {
  method: 'DELETE',
  body: JSON.stringify([{id: 'post-123'}])
});
```

## Validation Examples

### Missing ID Field

```bash
DELETE /api/data/users
[{"name": "Alice"}]  # Missing 'id' field

# Error 400: BODY_NOT_ARRAY
# "Request body must be an array of records with id fields"
```

### Non-Root Permanent Delete

```bash
DELETE /api/data/users?permanent=true
[{"id": "user-1"}]

# Error 403: ACCESS_DENIED (if not root user)
# "Insufficient permissions for permanent delete"
```

### Non-Existent Record

```bash
DELETE /api/data/users
[{"id": "non-existent-id"}]

# Error 404: RECORD_NOT_FOUND
```

## Performance Considerations

### Batch Size Recommendations

- ✅ **1-100 records**: Optimal performance
- ⚠️ **100-1000 records**: Good, but consider chunking
- ❌ **1000+ records**: Consider using background job or chunking into smaller batches

### Large Dataset Operations

For very large deletions beyond typical API usage:

- **Extracts API** - Export records for analysis before deletion
- **Restores API** - Bulk restore operations if needed

See the Extracts and Restores API documentation for handling high-volume data operations.

## Data Retention Policy Example

Implement a two-stage deletion policy:

```javascript
// Stage 1: Soft delete (user-initiated)
async function moveToTrash(recordIds) {
  await fetch('/api/data/documents', {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(recordIds.map(id => ({ id })))
  });
}

// Stage 2: Permanent delete after 30 days (automated job, root access)
async function cleanupOldTrash() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Find old trashed records
  const response = await fetch('/api/find/documents?include_trashed=true', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${rootToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      where: {
        trashed_at: { $lt: thirtyDaysAgo.toISOString() }
      },
      select: ['id']
    })
  });

  const { data } = await response.json();

  // Permanently delete
  if (data.length > 0) {
    await fetch('/api/data/documents?permanent=true', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${rootToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
  }
}
```

## Related Endpoints

- [`GET /api/data/:model`](GET.md) - Query all records (with include_trashed)
- [`POST /api/data/:model`](POST.md) - Bulk create records
- [`PUT /api/data/:model`](PUT.md) - Bulk update records (includes revert operation)
- [`DELETE /api/data/:model/:id`](../:model/:record/DELETE.md) - Delete single record
