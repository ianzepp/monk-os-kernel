# PUT /api/data/:model/:record/:relationship/:child

Update a specific child record while preserving its relationship to the parent. The server prevents reassignment to a different parent and ensures the foreign key remains intact throughout the update operation.

## Path Parameters

- `:model` - Parent model name (required)
- `:record` - Parent record UUID (required)
- `:relationship` - Relationship name defined in child model (required)
- `:child` - Child record UUID (required)

## Request Body

Child record update object. Only include the fields you want to update:

```json
{
  "text": "Updated comment text",
  "status": "edited"
}
```

**Important:**
- Do not include the child's `id` in the body—it's specified in the URL path
- Do not include the foreign key field—it's automatically preserved

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "comment-456",
    "text": "Updated comment text",
    "status": "edited",
    "author": "Alice",
    "post_id": "post-123",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T11:00:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

### Response Fields

The updated child record includes:
- All fields (updated values merged with existing values)
- **Foreign key field** - Automatically preserved (e.g., `post_id` remains `post-123`)
- **updated_at** - Automatically set to current timestamp
- Unchanged fields retain their original values

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `INVALID_BODY_FORMAT` | "Request body must be a single object for nested resource update" | Body is not an object or is an array |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Child model has frozen=true |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid parent model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Parent or child record does not exist, or child doesn't belong to parent |
| 404 | `RELATIONSHIP_NOT_FOUND` | "Relationship '{name}' not found for model '{model}'" | Invalid relationship name or not an owned relationship |
| 422 | Validation errors | Various | Observer validation failures |

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

## HTTP Methods

### PUT - Full Update

Replaces fields with provided values (unspecified fields remain unchanged):

```bash
curl -X PUT http://localhost:9001/api/data/posts/post-123/comments/comment-456 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Completely updated comment",
    "author": "Alice Updated",
    "status": "edited"
  }'
```

### PATCH - Partial Update

Updates only the specified fields (more common):

```bash
curl -X PATCH http://localhost:9001/api/data/posts/post-123/comments/comment-456 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "edited"
  }'
```

**Result:** Only `status` is updated, all other fields remain unchanged.

## Example Usage

### Update Comment Text

```bash
curl -X PATCH http://localhost:9001/api/data/posts/post-123/comments/comment-456 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This is the corrected comment text"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "comment-456",
    "text": "This is the corrected comment text",
    "author": "Alice",
    "post_id": "post-123",
    "status": "published",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T11:00:00Z"
  }
}
```

### Update Order Item Quantity

```bash
curl -X PATCH http://localhost:9001/api/data/orders/order-789/items/item-123 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "quantity": 5
  }'
```

### Mark Comment as Edited

```bash
curl -X PATCH http://localhost:9001/api/data/posts/post-123/comments/comment-456 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "edited",
    "edited_at": "2024-01-15T11:00:00Z"
  }'
```

## Foreign Key Preservation

The foreign key is **automatically preserved** by the server:

**Your request (without foreign key):**
```json
{
  "text": "Updated text",
  "status": "edited"
}
```

**Server processes as (with foreign key preserved):**
```json
{
  "text": "Updated text",
  "status": "edited",
  "post_id": "post-123"  // ← Automatically preserved
}
```

Even if you include the foreign key in your request, the server ensures it matches the parent from the URL path.

## Parent-Child Verification

This endpoint performs **dual verification**:

1. **Parent exists**: Verifies parent record exists and is accessible
2. **Child belongs to parent**: Verifies child record exists AND its foreign key matches the parent ID
3. **Foreign key preserved**: Ensures foreign key remains linked to the correct parent

If the child exists but belongs to a different parent, returns **404 RECORD_NOT_FOUND**.

## Merge Behavior

Updates are **merged** with existing child record—only the fields you specify are updated:

**Existing record:**
```json
{
  "id": "comment-456",
  "text": "Original text",
  "author": "Alice",
  "status": "published",
  "post_id": "post-123"
}
```

**Update request:**
```json
{
  "status": "edited"
}
```

**Result:**
```json
{
  "id": "comment-456",
  "text": "Original text",     // ← Unchanged
  "author": "Alice",          // ← Unchanged
  "status": "edited",         // ← Updated
  "post_id": "post-123",      // ← Preserved
  "updated_at": "2024-01-15T11:00:00Z"
}
```

## Observer Pipeline

Updated child records pass through the full observer pipeline:

### Pre-Update Observers
- **Validation** - Model validation, required fields, data types
- **Security** - Check permissions, verify ACLs
- **Business Logic** - Custom validation rules
- **Immutability Check** - Prevent changes to immutable fields
- **Parent Context** - Observers receive parent record information

### Post-Update Observers
- **Audit Logging** - Record update events with parent context
- **Notifications** - Trigger webhooks, emails
- **Side Effects** - Update related records, invalidate caches
- **Parent Updates** - Update parent's updated_at, recalculate aggregates

If any observer throws an error, the transaction rolls back and no changes are persisted.

## Use Cases

### Edit Comment

```javascript
async function editComment(postId, commentId, newText) {
  const response = await fetch(`/api/data/posts/${postId}/comments/${commentId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: newText,
      status: 'edited',
      edited_at: new Date().toISOString()
    })
  });

  const { data: updatedComment } = await response.json();
  return updatedComment;
}
```

### Update Order Item

```javascript
async function updateOrderItemQuantity(orderId, itemId, newQuantity) {
  const response = await fetch(`/api/data/orders/${orderId}/items/${itemId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      quantity: newQuantity
    })
  });

  const { data: updatedItem } = await response.json();
  return updatedItem;
}
```

### Moderate Comment

```javascript
async function moderateComment(postId, commentId, action) {
  let updates = {};

  switch (action) {
    case 'approve':
      updates = { status: 'published', moderated_at: new Date().toISOString() };
      break;
    case 'reject':
      updates = { status: 'rejected', moderated_at: new Date().toISOString() };
      break;
    case 'flag':
      updates = { status: 'flagged', flagged_at: new Date().toISOString() };
      break;
  }

  const response = await fetch(`/api/data/posts/${postId}/comments/${commentId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });

  return response.json();
}
```

## Model Protection

### Frozen Child Models

Child models with `frozen=true` reject all update operations:

```bash
PUT /api/data/posts/post-123/archived_comments/comment-456
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Child Models

Child models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Updating sensitive child record"}

# Then use sudo token
PUT /api/data/documents/doc-123/confidential_notes/note-456
Authorization: Bearer SUDO_TOKEN
```

### Immutable Fields

Fields marked with `immutable=true` cannot be changed after creation:

```bash
PUT /api/data/orders/order-123/items/item-456
{"product_id": "different-product"}

# Error: Cannot modify immutable fields: product_id
```

## Validation Examples

### Invalid Body Format (Array)

```bash
PUT /api/data/posts/post-123/comments/comment-456
[{"text": "New text"}]

# Error 400: INVALID_BODY_FORMAT
{
  "success": false,
  "error": "Request body must be a single object for nested resource update",
  "error_code": "INVALID_BODY_FORMAT"
}
```

### Child Doesn't Belong to Parent

```bash
# comment-456 belongs to post-789, not post-123
PUT /api/data/posts/post-123/comments/comment-456
{"text": "Updated"}

# Error 404: RECORD_NOT_FOUND
```

### Missing Required Field

```bash
PUT /api/data/posts/post-123/comments/comment-456
{"text": ""}  # Empty required field

# Response: 422
{
  "success": false,
  "error": "Validation failed: text cannot be empty",
  "error_code": "VALIDATION_ERROR"
}
```

## Transaction Behavior

The child update executes within a database transaction:
- ✅ **Success** - Child record updated with preserved foreign key
- ❌ **Failure** - Transaction rolled back, no changes persisted

## Alternative Access

If you don't need parent verification, you can update the child directly:

```bash
# Through parent relationship (verifies ownership)
PUT /api/data/posts/post-123/comments/comment-456

# Direct access (no parent verification)
PUT /api/data/comments/comment-456
```

Use the relationship route when:
- You need to verify parent-child relationship
- Building nested update flows (post detail → edit comment)
- Implementing strict access control based on parent
- Want foreign key preservation guaranteed

Use the direct route when:
- You already know the child ID and its validity
- Parent verification is unnecessary
- Simpler API calls are preferred

## Related Endpoints

- [`GET /api/data/:model/:record/:relationship/:child`](GET.md) - Get specific child record
- [`DELETE /api/data/:model/:record/:relationship/:child`](DELETE.md) - Delete specific child record
- [`GET /api/data/:model/:record/:relationship`](../GET.md) - List all child records
- [`PUT /api/data/:model/:record`](../../PUT.md) - Update parent record
