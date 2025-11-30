# DELETE /api/data/:model/:record/:relationship

Remove or detach all child records for a given parent relationship in one request. This endpoint scopes the deletion to only children belonging to the specified parent, making it safe for bulk cleanup operations.

## Path Parameters

- `:model` - Parent model name (required)
- `:record` - Parent record UUID (required)
- `:relationship` - Relationship name defined in child model (required)

## Query Parameters

- `permanent=true` - Perform permanent delete on all child records (requires root access)

## Request Body

None - DELETE request with no body.

## Success Response (200)

### Soft Delete Response (Default)

Sets `trashed_at` on all child records:

```json
{
  "success": true,
  "data": [
    {
      "id": "comment-1",
      "text": "First comment",
      "post_id": "post-123",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z",
      "trashed_at": "2024-01-15T12:00:00Z",
      "deleted_at": null
    },
    {
      "id": "comment-2",
      "text": "Second comment",
      "post_id": "post-123",
      "created_at": "2024-01-15T10:31:00Z",
      "updated_at": "2024-01-15T10:31:00Z",
      "trashed_at": "2024-01-15T12:00:00Z",
      "deleted_at": null
    }
  ]
}
```

### Permanent Delete Response (permanent=true)

Sets both `trashed_at` and `deleted_at` on all child records:

```json
{
  "success": true,
  "data": [
    {
      "id": "comment-1",
      "text": "First comment",
      "post_id": "post-123",
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
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `ACCESS_DENIED` | "Insufficient permissions for permanent delete" | permanent=true without root access |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Child model has frozen=true |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid parent model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Parent record ID does not exist |
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

## Example Usage

### Soft Delete All Comments for Post

```bash
curl -X DELETE http://localhost:9001/api/data/posts/post-123/comments \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "comment-1",
      "text": "Great post!",
      "post_id": "post-123",
      "trashed_at": "2024-01-15T12:00:00Z"
    },
    {
      "id": "comment-2",
      "text": "Thanks!",
      "post_id": "post-123",
      "trashed_at": "2024-01-15T12:00:00Z"
    }
  ]
}
```

### Permanently Delete All Order Items (Root Only)

```bash
curl -X DELETE "http://localhost:9001/api/data/orders/order-456/items?permanent=true" \
  -H "Authorization: Bearer ROOT_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "item-1",
      "order_id": "order-456",
      "trashed_at": "2024-01-15T12:00:00Z",
      "deleted_at": "2024-01-15T12:00:00Z"
    },
    {
      "id": "item-2",
      "order_id": "order-456",
      "trashed_at": "2024-01-15T12:00:00Z",
      "deleted_at": "2024-01-15T12:00:00Z"
    }
  ]
}
```

### Clear All Attachments

```bash
curl -X DELETE http://localhost:9001/api/data/documents/doc-abc/attachments \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Soft Delete vs Permanent Delete

### Soft Delete (Default)

**What happens:**
- Sets `trashed_at = NOW()` on all child records belonging to parent
- Records remain in database
- Hidden from normal queries (unless `?include_trashed=true`)
- Can be restored with revert operation

**Use cases:**
- Clear all child records temporarily
- Trash bin functionality
- Recoverable bulk deletions

### Permanent Delete (permanent=true)

**What happens:**
- Sets `deleted_at = NOW()` on all child records (also sets `trashed_at = NOW()`)
- Records remain in database but marked as permanently deleted
- Hidden from all queries (except `?include_deleted=true` with root access)
- **Cannot be restored**

**Requirements:**
- Requires **root access level**
- Intended for compliance, data retention policies, or irreversible cleanup

**Use cases:**
- GDPR/privacy compliance (remove all related data)
- Cleanup of test data
- Final removal after soft delete retention period

## Automatic Scoping

This endpoint **only deletes child records belonging to the specified parent**:

```bash
DELETE /api/data/posts/post-123/comments
# Only deletes comments where post_id = 'post-123'
# Comments belonging to other posts are NOT affected
```

This scoping makes the endpoint safe for bulk operations without risk of affecting unrelated records.

## Empty Results

If no child records exist for the parent, returns an empty array:

```json
{
  "success": true,
  "data": []
}
```

This is **not an error**—the operation completed successfully, but there were no children to delete.

## Observer Pipeline

Deleted child records pass through the observer pipeline:

### Pre-Delete Observers
- **Security** - Check delete permissions on child records
- **Business Logic** - Custom deletion rules
- **Cascade Rules** - Handle related records of children
- **Parent Context** - Observers receive parent record information

### Post-Delete Observers
- **Audit Logging** - Record deletion events with parent context
- **Notifications** - Trigger webhooks
- **Cleanup** - Remove related data, invalidate caches
- **Parent Updates** - Update parent's updated_at, counters, etc.

If any observer throws an error, the transaction rolls back and no records are deleted.

## Use Cases

### Clear All Comments Before Deleting Post

```javascript
async function deletePostWithComments(postId) {
  // First, delete all comments
  await fetch(`/api/data/posts/${postId}/comments`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  // Then delete the post
  await fetch(`/api/data/posts/${postId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}
```

### Cancel Order (Move Items to Trash)

```javascript
async function cancelOrder(orderId) {
  // Soft delete all items in the order
  const response = await fetch(`/api/data/orders/${orderId}/items`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: deletedItems } = await response.json();
  console.log(`Moved ${deletedItems.length} items to trash`);

  // Update order status
  await fetch(`/api/data/orders/${orderId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'cancelled' })
  });
}
```

### GDPR Data Removal

```javascript
async function gdprRemoveUserData(userId) {
  // Permanently delete all user-related data
  // Must use root token for permanent deletes

  // Delete user's posts and their comments
  const posts = await getUserPosts(userId);

  for (const post of posts) {
    // Permanently delete all comments for each post
    await fetch(`/api/data/posts/${post.id}/comments?permanent=true`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${rootToken}` }
    });

    // Then permanently delete the post
    await fetch(`/api/data/posts/${post.id}?permanent=true`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${rootToken}` }
    });
  }

  // Finally, delete the user
  await fetch(`/api/data/users/${userId}?permanent=true`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${rootToken}` }
  });
}
```

### Clear Draft Records

```javascript
async function clearDraftComments(postId) {
  // Get all draft comments
  const response = await fetch(`/api/data/posts/${postId}/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      where: { status: 'draft' },
      select: ['id']
    })
  });

  // Note: Above uses Find API. For this endpoint, you'd delete all comments
  // and may need to filter differently, or delete individually

  // Alternative: Delete all comments (including drafts)
  await fetch(`/api/data/posts/${postId}/comments`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}
```

## Model Protection

### Frozen Child Models

Child models with `frozen=true` reject all delete operations:

```bash
DELETE /api/data/posts/post-123/archived_comments
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Child Models

Child models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Deleting sensitive child records"}

# Then use sudo token
DELETE /api/data/documents/doc-123/confidential_notes
Authorization: Bearer SUDO_TOKEN
```

## Transaction Behavior

All child deletions execute within a **single database transaction**:

✅ **All succeed together** - If every deletion succeeds, all are persisted
❌ **All fail together** - If any deletion fails, the entire batch is rolled back

## Parent Verification

Before deleting child records, the endpoint verifies:
1. Parent record exists
2. User has read access to parent record
3. Relationship is defined and is type "owned"

This ensures operations are scoped to valid parents only.

## Restoring Soft-Deleted Children

Soft-deleted child records can be restored using the bulk revert operation on the child model:

```bash
# First, find trashed comments for the post
POST /api/find/comments?include_trashed=true
{"where": {"post_id": "post-123", "trashed_at": {"$ne": null}}}

# Then revert them
PATCH /api/data/comments?include_trashed=true
[{"id": "comment-1"}, {"id": "comment-2"}]
```

## Related Endpoints

- [`GET /api/data/:model/:record/:relationship`](GET.md) - List all child records
- [`POST /api/data/:model/:record/:relationship`](POST.md) - Create child record
- [`DELETE /api/data/:model/:record/:relationship/:child`](:child/DELETE.md) - Delete specific child record
- [`DELETE /api/data/:model`](../../:model/DELETE.md) - Bulk delete records
