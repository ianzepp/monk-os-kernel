# DELETE /api/data/:model/:record/:relationship/:child

Delete a specific child record while verifying it belongs to the specified parent. This provides secure, targeted deletion of individual child resources with soft delete by default and permanent deletion for root users.

## Path Parameters

- `:model` - Parent model name (required)
- `:record` - Parent record UUID (required)
- `:relationship` - Relationship name defined in child model (required)
- `:child` - Child record UUID (required)

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
    "id": "comment-456",
    "text": "Great post!",
    "author": "Alice",
    "post_id": "post-123",
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
    "id": "comment-456",
    "text": "Great post!",
    "author": "Alice",
    "post_id": "post-123",
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
| 403 | `MODEL_FROZEN` | "Model is frozen" | Child model has frozen=true |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid parent model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Parent or child record does not exist, or child doesn't belong to parent |
| 404 | `RELATIONSHIP_NOT_FOUND` | "Relationship '{name}' not found for model '{model}'" | Invalid relationship name or not an owned relationship |

## Relationship Requirements

This endpoint only works with **owned relationships** defined in the child model:

```json
{
  "title": "Comments",
  "type": "object",
  "properties": {
    "post_id": {
      "type": "string",
      "x-monk-relationship": {
        "type": "owned",
        "model": "posts",
        "name": "comments"
      }
    }
  }
}
```

## Soft Delete vs Permanent Delete

### Soft Delete (Default)

**What happens:**
- Sets `trashed_at = NOW()` on the specific child record
- Record remains in database
- Hidden from normal queries (unless `?include_trashed=true`)
- Can be restored with revert operation

**Use cases:**
- User-initiated deletions
- Trash bin functionality
- Recoverable deletions
- Maintaining audit trails

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
- GDPR/privacy compliance (remove specific data)
- Cleanup of inappropriate content
- Final removal after soft delete retention period

## Example Usage

### Soft Delete Single Comment

```bash
curl -X DELETE http://localhost:9001/api/data/posts/post-123/comments/comment-456 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "comment-456",
    "text": "This comment was deleted",
    "post_id": "post-123",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": null
  }
}
```

### Permanently Delete Order Item (Root Only)

```bash
curl -X DELETE "http://localhost:9001/api/data/orders/order-789/items/item-123?permanent=true" \
  -H "Authorization: Bearer ROOT_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "item-123",
    "order_id": "order-789",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": "2024-01-15T12:00:00Z"
  }
}
```

### Remove Attachment

```bash
curl -X DELETE http://localhost:9001/api/data/documents/doc-abc/attachments/att-789 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Parent-Child Verification

This endpoint performs **dual verification** before deletion:

1. **Parent exists**: Verifies parent record exists and is accessible
2. **Child belongs to parent**: Verifies child record exists AND its foreign key matches the parent ID

If the child exists but belongs to a different parent, returns **404 RECORD_NOT_FOUND** (protects against unauthorized deletion).

### Example: Security Through Verification

```bash
# Comment-456 belongs to post-123
DELETE /api/data/posts/post-123/comments/comment-456
# ✅ Deletes comment-456

# Comment-456 does NOT belong to post-999
DELETE /api/data/posts/post-999/comments/comment-456
# ❌ Returns 404 (prevents unauthorized deletion)
```

## Observer Pipeline

Deleted child records pass through the observer pipeline:

### Pre-Delete Observers
- **Security** - Check delete permissions on child record
- **Business Logic** - Custom deletion rules
- **Cascade Rules** - Handle records related to this child
- **Parent Context** - Observers receive parent record information

### Post-Delete Observers
- **Audit Logging** - Record deletion events with parent context
- **Notifications** - Trigger webhooks
- **Cleanup** - Remove related data, invalidate caches
- **Parent Updates** - Update parent's updated_at, recalculate counters

If any observer throws an error, the operation fails and no changes are persisted.

## Use Cases

### Delete Single Comment

```javascript
async function deleteComment(postId, commentId) {
  const response = await fetch(`/api/data/posts/${postId}/comments/${commentId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (response.ok) {
    const { data: deletedComment } = await response.json();
    console.log('Comment moved to trash:', deletedComment);
    return true;
  }

  return false;
}
```

### Remove Item from Order

```javascript
async function removeOrderItem(orderId, itemId) {
  const confirmed = confirm('Remove this item from the order?');

  if (!confirmed) return false;

  const response = await fetch(`/api/data/orders/${orderId}/items/${itemId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  return response.ok;
}
```

### Delete with Confirmation UI

```javascript
async function deleteAttachmentWithConfirmation(docId, attachmentId) {
  // Show confirmation dialog
  const confirmed = await showConfirmDialog({
    title: 'Delete Attachment?',
    message: 'This will move the attachment to trash. You can restore it later.',
    confirmText: 'Delete',
    cancelText: 'Cancel'
  });

  if (!confirmed) return null;

  // Delete the attachment
  const response = await fetch(
    `/api/data/documents/${docId}/attachments/${attachmentId}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );

  const { data: deletedAttachment } = await response.json();
  return deletedAttachment;
}
```

### GDPR Compliance - Delete Specific Record

```javascript
async function gdprDeleteComment(postId, commentId, reason) {
  // Must use root token for permanent delete
  const response = await fetch(
    `/api/data/posts/${postId}/comments/${commentId}?permanent=true`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${rootToken}`,
        'X-Audit-Reason': reason
      }
    }
  );

  if (response.ok) {
    const { data } = await response.json();
    console.log('Comment permanently deleted:', data.deleted_at);
    return true;
  }

  return false;
}
```

## Model Protection

### Frozen Child Models

Child models with `frozen=true` reject all delete operations:

```bash
DELETE /api/data/posts/post-123/archived_comments/comment-456
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Child Models

Child models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Deleting sensitive child record"}

# Then use sudo token
DELETE /api/data/documents/doc-123/confidential_notes/note-456
Authorization: Bearer SUDO_TOKEN
```

## Transaction Behavior

The child deletion executes within a database transaction:
- ✅ **Success** - Child record deleted/trashed
- ❌ **Failure** - Transaction rolled back, no changes persisted

## Restoring Soft-Deleted Children

Soft-deleted child records can be restored using the revert operation on the child model:

```bash
# Restore single child record
PATCH /api/data/comments/comment-456?include_trashed=true
```

Or restore via bulk operation if multiple children need restoration.

## Validation Examples

### Non-Root Permanent Delete

```bash
DELETE /api/data/posts/post-123/comments/comment-456?permanent=true
# Using non-root token

# Error 403: ACCESS_DENIED
{
  "success": false,
  "error": "Insufficient permissions for permanent delete",
  "error_code": "ACCESS_DENIED"
}
```

### Child Doesn't Belong to Parent

```bash
# comment-456 belongs to post-789, not post-123
DELETE /api/data/posts/post-123/comments/comment-456

# Error 404: RECORD_NOT_FOUND
{
  "success": false,
  "error": "Record not found",
  "error_code": "RECORD_NOT_FOUND"
}
```

### Non-Existent Child

```bash
DELETE /api/data/posts/post-123/comments/non-existent-id

# Error 404: RECORD_NOT_FOUND
```

## Alternative Access

If you don't need parent verification, you can delete the child directly:

```bash
# Through parent relationship (verifies ownership)
DELETE /api/data/posts/post-123/comments/comment-456

# Direct access (no parent verification)
DELETE /api/data/comments/comment-456
```

Use the relationship route when:
- You need to verify parent-child relationship
- Building nested deletion flows (post detail → delete comment)
- Implementing strict access control based on parent
- Want explicit parent context in audit logs

Use the direct route when:
- You already know the child ID and its validity
- Parent verification is unnecessary
- Simpler API calls are preferred

## Cascade Considerations

When deleting a child record that has its own children:
- The endpoint only deletes the specified child
- Does NOT automatically cascade to grandchildren
- You must explicitly delete grandchildren first if needed

**Example:**
```javascript
// If comments have replies, delete in order:
// 1. Delete reply (grandchild)
await fetch(`/api/data/comments/${commentId}/replies/${replyId}`, {
  method: 'DELETE'
});

// 2. Then delete comment (child)
await fetch(`/api/data/posts/${postId}/comments/${commentId}`, {
  method: 'DELETE'
});
```

## Related Endpoints

- [`GET /api/data/:model/:record/:relationship/:child`](GET.md) - Get specific child record
- [`PUT /api/data/:model/:record/:relationship/:child`](PUT.md) - Update specific child record
- [`DELETE /api/data/:model/:record/:relationship`](../DELETE.md) - Delete all child records
- [`DELETE /api/data/:model/:record`](../../DELETE.md) - Delete parent record
