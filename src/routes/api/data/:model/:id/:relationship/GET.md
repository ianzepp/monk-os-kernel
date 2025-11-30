# GET /api/data/:model/:record/:relationship

List all child records tied to a parent through a defined relationship. This endpoint automatically filters child records by the parent's foreign key, enforces ACL inheritance, and supports the same trashed/deleted flags as top-level queries.

## Path Parameters

- `:model` - Parent model name (required)
- `:record` - Parent record UUID (required)
- `:relationship` - Relationship name defined in child model (required)

## Query Parameters

- `include_trashed=true` - Include soft-deleted child records (where `trashed_at IS NOT NULL`)
- `include_deleted=true` - Include permanently deleted child records (where `deleted_at IS NOT NULL`) - requires root access

### Response Transformation Parameters

- `unwrap` - Remove envelope, return data array directly
- `select=field1,field2` - Return only specified fields (implies unwrap)
- `stat=false` - Exclude timestamp fields (created_at, updated_at, trashed_at, deleted_at)
- `access=false` - Exclude ACL fields (access_read, access_edit, access_full)

## Request Body

None - GET request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": [
    {
      "id": "comment-1",
      "text": "Great post!",
      "post_id": "post-123",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z",
      "trashed_at": null,
      "deleted_at": null
    },
    {
      "id": "comment-2",
      "text": "Thanks for sharing",
      "post_id": "post-123",
      "created_at": "2024-01-15T10:31:00Z",
      "updated_at": "2024-01-15T10:31:00Z",
      "trashed_at": null,
      "deleted_at": null
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
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid parent model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Parent record ID does not exist |
| 404 | `RELATIONSHIP_NOT_FOUND` | "Relationship '{name}' not found for model '{model}'" | Invalid relationship name or not an owned relationship |

## Relationship Requirements

This endpoint only works with **owned relationships** defined in the child model. The relationship must be configured using the `x-monk-relationship` extension:

```json
{
  "title": "Comments",
  "type": "object",
  "properties": {
    "text": {"type": "string"},
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

### Relationship Types

- **`owned`** - Child belongs to parent, enables nested routes (required for this endpoint)
- **`referenced`** - Loose reference, does not support nested routes

## Example Usage

### Get All Comments for a Post

```bash
curl -X GET http://localhost:9001/api/data/posts/post-123/comments \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "comment-1",
      "text": "Great article!",
      "post_id": "post-123",
      "author": "Alice",
      "created_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "comment-2",
      "text": "Very informative",
      "post_id": "post-123",
      "author": "Bob",
      "created_at": "2024-01-15T10:35:00Z"
    }
  ]
}
```

### Include Trashed Child Records

```bash
curl -X GET "http://localhost:9001/api/data/posts/post-123/comments?include_trashed=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response includes soft-deleted comments:**
```json
{
  "success": true,
  "data": [
    {
      "id": "comment-1",
      "text": "Active comment",
      "post_id": "post-123",
      "trashed_at": null
    },
    {
      "id": "comment-2",
      "text": "Deleted comment",
      "post_id": "post-123",
      "trashed_at": "2024-01-15T12:00:00Z"
    }
  ]
}
```

### Get Order Items

```bash
curl -X GET http://localhost:9001/api/data/orders/order-456/items \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Returns all items belonging to order-456.**

## Response Transformation Examples

### Select Specific Fields

```bash
curl -X GET "http://localhost:9001/api/data/posts/post-123/comments?select=id,text,author" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (unwrapped with only selected fields):**
```json
[
  {
    "id": "comment-1",
    "text": "Great article!",
    "author": "Alice"
  },
  {
    "id": "comment-2",
    "text": "Very informative",
    "author": "Bob"
  }
]
```

### Exclude Timestamps

```bash
curl -X GET "http://localhost:9001/api/data/posts/post-123/comments?stat=false" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (without timestamp fields):**
```json
{
  "success": true,
  "data": [
    {
      "id": "comment-1",
      "text": "Great article!",
      "post_id": "post-123",
      "author": "Alice"
    }
  ]
}
```

## Use Cases

### Display Related Records

```javascript
async function loadPostComments(postId) {
  const response = await fetch(`/api/data/posts/${postId}/comments`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: comments } = await response.json();
  return comments;
}
```

### Count Related Items

```javascript
async function getOrderItemCount(orderId) {
  const response = await fetch(`/api/data/orders/${orderId}/items`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: items } = await response.json();
  return items.length;
}
```

### Check for Empty Relationships

```javascript
async function hasComments(postId) {
  const response = await fetch(`/api/data/posts/${postId}/comments`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: comments } = await response.json();
  return comments.length > 0;
}
```

### Load Parent and Children Together

```javascript
async function loadPostWithComments(postId) {
  // Load parent and children in parallel
  const [postResponse, commentsResponse] = await Promise.all([
    fetch(`/api/data/posts/${postId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }),
    fetch(`/api/data/posts/${postId}/comments`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
  ]);

  const { data: post } = await postResponse.json();
  const { data: comments } = await commentsResponse.json();

  return { ...post, comments };
}
```

## Automatic Filtering

This endpoint automatically:
- Filters child records to only those belonging to the specified parent
- Verifies parent record exists and is accessible
- Applies ACL permissions based on user's access to parent
- Excludes trashed/deleted records unless explicitly requested

## Empty Results

If no child records exist for the parent, returns an empty array:

```json
{
  "success": true,
  "data": []
}
```

This is **not an error**—it simply means the parent has no children for this relationship.

## Parent Verification

The endpoint first verifies:
1. Parent record exists
2. User has read access to parent record
3. Relationship is defined and is type "owned"

If any verification fails, appropriate error is returned before querying children.

## ACL Inheritance

Child records inherit access control from their parent:
- If user can read parent, they can read children
- If user lacks parent access, endpoint returns 404 (does not reveal parent existence)
- Root users bypass all ACL checks

## Model Protection

This endpoint respects model-level protection on the **child model**:

- **Frozen child models**: Read operations are **allowed**
- **Sudo-protected child models**: No special requirements for read operations
- **Immutable child models/fields**: No restrictions on read operations

## Related Endpoints

- [`POST /api/data/:model/:record/:relationship`](POST.md) - Create child record
- [`DELETE /api/data/:model/:record/:relationship`](DELETE.md) - Delete all child records
- [`GET /api/data/:model/:record/:relationship/:child`](:child/GET.md) - Get specific child record
- [`GET /api/data/:model/:record`](../GET.md) - Get parent record
