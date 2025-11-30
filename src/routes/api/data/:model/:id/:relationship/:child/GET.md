# GET /api/data/:model/:record/:relationship/:child

Fetch a specific child record while verifying it belongs to the specified parent. This prevents leaking related records between parents and provides secure access to individual child resources with full trashed/deleted state visibility.

## Path Parameters

- `:model` - Parent model name (required)
- `:record` - Parent record UUID (required)
- `:relationship` - Relationship name defined in child model (required)
- `:child` - Child record UUID (required)

## Query Parameters

- `include_trashed=true` - Include soft-deleted records (where `trashed_at IS NOT NULL`)
- `include_deleted=true` - Include permanently deleted records (where `deleted_at IS NOT NULL`) - requires root access

### Response Transformation Parameters

- `unwrap` - Remove envelope, return record object directly
- `select=field1,field2` - Return only specified fields (implies unwrap)
- `stat=false` - Exclude timestamp fields (created_at, updated_at, trashed_at, deleted_at)
- `access=false` - Exclude ACL fields (access_read, access_edit, access_full)

## Request Body

None - GET request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "comment-1",
    "text": "Great post!",
    "author": "Alice",
    "post_id": "post-123",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
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

## Example Usage

### Get Specific Comment

```bash
curl -X GET http://localhost:9001/api/data/posts/post-123/comments/comment-456 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "comment-456",
    "text": "Great article!",
    "author": "Alice",
    "post_id": "post-123",
    "status": "published",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

### Get Trashed Child Record

```bash
curl -X GET "http://localhost:9001/api/data/posts/post-123/comments/comment-456?include_trashed=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response includes trashed record:**
```json
{
  "success": true,
  "data": {
    "id": "comment-456",
    "text": "Deleted comment",
    "post_id": "post-123",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": null
  }
}
```

### Get Order Item

```bash
curl -X GET http://localhost:9001/api/data/orders/order-789/items/item-123 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Parent-Child Verification

This endpoint performs **dual verification**:

1. **Parent exists**: Verifies parent record exists and is accessible
2. **Child belongs to parent**: Verifies child record exists AND its foreign key matches the parent ID

If the child exists but belongs to a different parent, returns **404 RECORD_NOT_FOUND** (does not reveal child's existence).

### Example: Security Through Verification

```bash
# Comment-456 belongs to post-123
GET /api/data/posts/post-123/comments/comment-456
# ✅ Returns comment-456

# Comment-456 does NOT belong to post-999
GET /api/data/posts/post-999/comments/comment-456
# ❌ Returns 404 (protects against unauthorized access)
```

## Response Transformation Examples

### Unwrap Response

```bash
curl -X GET "http://localhost:9001/api/data/posts/post-123/comments/comment-456?unwrap" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (unwrapped):**
```json
{
  "id": "comment-456",
  "text": "Great article!",
  "author": "Alice",
  "post_id": "post-123",
  "created_at": "2024-01-15T10:30:00Z"
}
```

### Select Specific Fields

```bash
curl -X GET "http://localhost:9001/api/data/posts/post-123/comments/comment-456?select=id,text,author" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (unwrapped with selected fields):**
```json
{
  "id": "comment-456",
  "text": "Great article!",
  "author": "Alice"
}
```

## Use Cases

### Load Single Child for Editing

```javascript
async function loadCommentForEdit(postId, commentId) {
  const response = await fetch(`/api/data/posts/${postId}/comments/${commentId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: comment } = await response.json();
  return comment;
}
```

### Verify Child Ownership

```javascript
async function verifyCommentBelongsToPost(postId, commentId) {
  try {
    const response = await fetch(`/api/data/posts/${postId}/comments/${commentId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.ok) {
      return true; // Comment belongs to post
    }
  } catch (error) {
    return false; // Comment doesn't belong to post or doesn't exist
  }
}
```

### Load Child with Parent Context

```javascript
async function loadCommentWithPost(postId, commentId) {
  // Load both in parallel
  const [postResponse, commentResponse] = await Promise.all([
    fetch(`/api/data/posts/${postId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }),
    fetch(`/api/data/posts/${postId}/comments/${commentId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
  ]);

  const { data: post } = await postResponse.json();
  const { data: comment } = await commentResponse.json();

  return { post, comment };
}
```

### Check Child Deletion State

```javascript
async function checkCommentStatus(postId, commentId) {
  const response = await fetch(
    `/api/data/posts/${postId}/comments/${commentId}?include_trashed=true`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 404) {
    return 'not_found_or_wrong_parent';
  }

  const { data: comment } = await response.json();

  if (comment.deleted_at) {
    return 'permanently_deleted';
  } else if (comment.trashed_at) {
    return 'trashed';
  } else {
    return 'active';
  }
}
```

## Security Benefits

### Prevents Cross-Parent Access

This endpoint ensures users can only access children that belong to the specified parent:

```javascript
// Attacker tries to access comment from different post
GET /api/data/posts/attacker-post/comments/victim-comment
// Returns 404 even if victim-comment exists
// (prevents information leakage)
```

### Explicit Parent Context

By requiring both parent and child IDs in the URL, the endpoint:
- Makes the relationship explicit in the API call
- Prevents accidental cross-contamination of data
- Provides clear audit trails (logs show parent-child relationship)

## ACL Inheritance

Child record access inherits from parent:
- If user can read parent, they can read children
- If user lacks parent access, endpoint returns 404
- Root users bypass all ACL checks

## Model Protection

This endpoint respects model-level protection on the **child model**:

- **Frozen child models**: Read operations are **allowed**
- **Sudo-protected child models**: No special requirements for read operations
- **Immutable child models/fields**: No restrictions on read operations

## Alternative Access

If you don't need parent verification, you can access the child directly:

```bash
# Through parent relationship (verifies ownership)
GET /api/data/posts/post-123/comments/comment-456

# Direct access (no parent verification)
GET /api/data/comments/comment-456
```

Use the relationship route when:
- You need to verify parent-child relationship
- Building nested UI (post detail → comment detail)
- Implementing strict access control based on parent

Use the direct route when:
- You already know the child ID
- Parent verification is unnecessary
- Simpler API calls are preferred

## Related Endpoints

- [`GET /api/data/:model/:record/:relationship`](../GET.md) - List all child records
- [`PUT /api/data/:model/:record/:relationship/:child`](PUT.md) - Update specific child record
- [`DELETE /api/data/:model/:record/:relationship/:child`](DELETE.md) - Delete specific child record
- [`GET /api/data/:model/:record`](../../GET.md) - Get parent record
