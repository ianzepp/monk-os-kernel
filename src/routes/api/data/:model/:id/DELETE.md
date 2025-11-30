# DELETE /api/data/:model/:record

Delete a single record by UUID, defaulting to a reversible soft delete while supporting permanent removal for root users. The response includes the record metadata with updated deletion timestamps, allowing clients to immediately update local caches or display confirmation messages.

## Path Parameters

- `:model` - Model name (required)
- `:record` - Record UUID (required)

## Query Parameters

- `permanent=true` - Perform permanent delete (requires root access)

## Request Body

None - DELETE request with no body.

## Success Response (200)

### Soft Delete Response (Default)

Sets `trashed_at` to current timestamp:

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": null
  }
}
```

### Permanent Delete Response (permanent=true)

Sets both `trashed_at` and `deleted_at` to current timestamp:

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T12:00:00Z",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": "2024-01-15T12:00:00Z"
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `ACCESS_DENIED` | "Insufficient permissions for permanent delete" | permanent=true without root access |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Attempting to delete from frozen model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Record ID does not exist |

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
curl -X DELETE http://localhost:9001/api/data/users/user-123 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Record moved to trash, can be restored
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
curl -X DELETE "http://localhost:9001/api/data/users/user-123?permanent=true" \
  -H "Authorization: Bearer ROOT_JWT_TOKEN"

# Record permanently deleted, cannot be restored
```

## Example Usage

### Soft Delete Single Record

```bash
curl -X DELETE http://localhost:9001/api/data/documents/doc-123 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "doc-123",
    "title": "Meeting Notes",
    "content": "...",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": null
  }
}
```

### Permanent Delete (Root Only)

```bash
curl -X DELETE "http://localhost:9001/api/data/users/user-to-delete?permanent=true" \
  -H "Authorization: Bearer ROOT_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "user-to-delete",
    "name": "Test User",
    "email": "test@example.com",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T12:00:00Z",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": "2024-01-15T12:00:00Z"
  }
}
```

### Delete with Confirmation

```javascript
async function deleteDocument(docId) {
  if (!confirm('Are you sure you want to delete this document?')) {
    return;
  }

  const response = await fetch(`/api/data/documents/${docId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (response.ok) {
    const { data: deletedDoc } = await response.json();
    console.log('Document moved to trash:', deletedDoc);
    return deletedDoc;
  }
}
```

## Restoring Soft-Deleted Records

Soft-deleted records can be restored using the revert operation:

```bash
# Restore single record from trash
curl -X PATCH "http://localhost:9001/api/data/users/user-123?include_trashed=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

See [`PUT /api/data/:model/:record`](PUT.md#smart-routing-revert-operation) for details.

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

If any observer throws an error, the operation fails and no changes are persisted.

## Model Protection

### Frozen Models

Models with `frozen=true` reject all delete operations:

```bash
DELETE /api/data/audit_log/record-123
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Models

Models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Deleting sensitive records"}

# Then use sudo token
DELETE /api/data/sensitive_data/record-123
Authorization: Bearer SUDO_TOKEN
```

## Cascade Behavior

**Note:** This endpoint does NOT automatically delete related records. You must explicitly:

1. Delete child records first
2. Then delete parent records

**Example:**
```javascript
// Wrong: This may fail if comments exist
await fetch('/api/data/posts/post-123', {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${token}` }
});

// Right: Delete children first, then parent
// Option 1: Use relationship endpoint
await fetch('/api/data/posts/post-123/comments', {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${token}` }
});

// Option 2: Or delete comments individually
const comments = await getCommentsForPost('post-123');
for (const comment of comments) {
  await fetch(`/api/data/comments/${comment.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

// Then delete the post
await fetch('/api/data/posts/post-123', {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${token}` }
});
```

## Validation Examples

### Non-Root Permanent Delete

```bash
DELETE /api/data/users/user-123?permanent=true
# Using non-root token

# Error 403: ACCESS_DENIED
{
  "success": false,
  "error": "Insufficient permissions for permanent delete",
  "error_code": "ACCESS_DENIED"
}
```

### Non-Existent Record

```bash
DELETE /api/data/users/non-existent-id

# Error 404: RECORD_NOT_FOUND
{
  "success": false,
  "error": "Record not found",
  "error_code": "RECORD_NOT_FOUND"
}
```

### Frozen Model

```bash
DELETE /api/data/audit_log/record-123

# Error 403: MODEL_FROZEN
{
  "success": false,
  "error": "Model 'audit_log' is frozen. All data operations are temporarily disabled.",
  "error_code": "MODEL_FROZEN"
}
```

## Use Cases

### Trash Bin Implementation

```javascript
// Move to trash
async function moveToTrash(recordId) {
  const response = await fetch(`/api/data/documents/${recordId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data } = await response.json();
  console.log('Moved to trash:', data.trashed_at);
  return data;
}

// Restore from trash
async function restoreFromTrash(recordId) {
  const response = await fetch(`/api/data/documents/${recordId}?include_trashed=true`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const { data } = await response.json();
  console.log('Restored:', data);
  return data;
}
```

### GDPR Data Removal

```javascript
// Permanently delete user data for GDPR compliance
async function gdprDeleteUser(userId, reason) {
  // Must use root token for permanent delete
  const response = await fetch(`/api/data/users/${userId}?permanent=true`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${rootToken}`,
      'X-Audit-Reason': reason
    }
  });

  if (response.ok) {
    const { data } = await response.json();
    console.log('User permanently deleted:', data.deleted_at);

    // Also delete related data
    await gdprDeleteUserRelatedData(userId);
  }
}
```

### Two-Stage Deletion Policy

```javascript
// Stage 1: User deletes record (soft delete)
async function userDelete(recordId) {
  return fetch(`/api/data/documents/${recordId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

// Stage 2: Automated cleanup after 30 days (permanent delete)
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

  const { data: oldRecords } = await response.json();

  // Permanently delete each record
  for (const record of oldRecords) {
    await fetch(`/api/data/documents/${record.id}?permanent=true`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${rootToken}` }
    });
  }
}
```

## Related Endpoints

- [`GET /api/data/:model/:record`](GET.md) - Retrieve single record
- [`PUT /api/data/:model/:record`](PUT.md) - Update single record (includes revert operation)
- [`DELETE /api/data/:model`](../:model/DELETE.md) - Bulk delete records
