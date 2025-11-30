# POST /api/data/:model/:record/:relationship

Create a new child record that automatically inherits the parent foreign key and observer context. This endpoint keeps relationship logic server-side—clients only send the child payload, and the API links it to the parent atomically.

## Path Parameters

- `:model` - Parent model name (required)
- `:record` - Parent record UUID (required)
- `:relationship` - Relationship name defined in child model (required)

## Request Body

Single child record object. The foreign key is automatically set—do not include it in the body:

```json
{
  "text": "This is a new comment",
  "author": "Alice",
  "status": "published"
}
```

**Important:** Body must be a single object, not an array. For bulk child creation, use the bulk endpoint on the child model directly.

## Success Response (201)

```json
{
  "success": true,
  "data": {
    "id": "comment-3",
    "text": "This is a new comment",
    "author": "Alice",
    "status": "published",
    "post_id": "post-123",
    "created_at": "2024-01-15T10:32:00Z",
    "updated_at": "2024-01-15T10:32:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

### Response Fields

The created child record includes:
- **id** - Auto-generated UUID
- **User-provided fields** - All fields from the request
- **Foreign key field** - Automatically set to parent record ID (e.g., `post_id`)
- **created_at** - Timestamp when record was created
- **updated_at** - Initially same as created_at
- **trashed_at** - Always null for new records
- **deleted_at** - Always null for new records

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `INVALID_BODY_FORMAT` | "Request body must be a single object for nested resource creation" | Body is not an object or is an array |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Child model has frozen=true |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid parent model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Parent record ID does not exist |
| 404 | `RELATIONSHIP_NOT_FOUND` | "Relationship '{name}' not found for model '{model}'" | Invalid relationship name or not an owned relationship |
| 422 | Validation errors | Various | Observer validation failures |

## Relationship Requirements

This endpoint only works with **owned relationships** defined in the child model:

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

## Example Usage

### Create Comment for Post

```bash
curl -X POST http://localhost:9001/api/data/posts/post-123/comments \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This is a great article!",
    "author": "Alice",
    "status": "published"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "comment-456",
    "text": "This is a great article!",
    "author": "Alice",
    "status": "published",
    "post_id": "post-123",
    "created_at": "2024-01-15T10:32:00Z",
    "updated_at": "2024-01-15T10:32:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

### Add Item to Order

```bash
curl -X POST http://localhost:9001/api/data/orders/order-789/items \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "product_id": "prod-456",
    "quantity": 2,
    "price": 29.99
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "item-123",
    "product_id": "prod-456",
    "quantity": 2,
    "price": 29.99,
    "order_id": "order-789",
    "created_at": "2024-01-15T10:32:00Z"
  }
}
```

### Create Attachment for Document

```bash
curl -X POST http://localhost:9001/api/data/documents/doc-abc/attachments \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "report.pdf",
    "size": 102400,
    "mime_type": "application/pdf"
  }'
```

## Foreign Key Handling

The foreign key is **automatically set** by the server:

**Your request (without foreign key):**
```json
{
  "text": "New comment",
  "author": "Bob"
}
```

**Server processes as (with foreign key):**
```json
{
  "text": "New comment",
  "author": "Bob",
  "post_id": "post-123"  // ← Automatically added
}
```

**Do not include the foreign key in your request**—it will be ignored or may cause validation errors.

## Observer Pipeline

Created child records pass through the full observer pipeline:

### Pre-Create Observers
- **Validation** - Model validation, required fields, data types
- **Enrichment** - Auto-generate IDs, set defaults, add timestamps
- **Security** - Check permissions, apply ACLs
- **Business Logic** - Custom validation rules
- **Parent Context** - Observers receive parent record information

### Post-Create Observers
- **Audit Logging** - Record creation events with parent context
- **Notifications** - Trigger webhooks, emails
- **Side Effects** - Update parent records, invalidate caches
- **Cascade Updates** - Update parent's updated_at, counters, etc.

If any observer throws an error, the transaction rolls back and no child record is created.

## Use Cases

### Add Comment to Blog Post

```javascript
async function addComment(postId, commentText, author) {
  const response = await fetch(`/api/data/posts/${postId}/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: commentText,
      author: author,
      status: 'published'
    })
  });

  const { data: newComment } = await response.json();
  return newComment;
}
```

### Add Multiple Items to Order

```javascript
async function addItemsToOrder(orderId, items) {
  // Create each item individually through relationship endpoint
  const createdItems = await Promise.all(
    items.map(item =>
      fetch(`/api/data/orders/${orderId}/items`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(item)
      }).then(r => r.json())
    )
  );

  return createdItems.map(result => result.data);
}
```

### Nested Creation with Form Data

```javascript
async function createOrderWithItems(orderData, items) {
  // 1. Create the parent order
  const orderResponse = await fetch('/api/data/orders', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([orderData])
  });

  const { data: [order] } = await orderResponse.json();

  // 2. Add items to the order
  const itemPromises = items.map(item =>
    fetch(`/api/data/orders/${order.id}/items`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(item)
    })
  );

  await Promise.all(itemPromises);

  // 3. Return complete order with items
  return loadOrderWithItems(order.id);
}
```

## Model Protection

### Frozen Child Models

Child models with `frozen=true` reject all create operations:

```bash
POST /api/data/posts/post-123/archived_comments
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Child Models

Child models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Adding sensitive child record"}

# Then use sudo token
POST /api/data/documents/doc-123/confidential_notes
Authorization: Bearer SUDO_TOKEN
```

## Validation Examples

### Invalid Body Format (Array Instead of Object)

```bash
POST /api/data/posts/post-123/comments
[{"text": "Comment 1"}, {"text": "Comment 2"}]

# Error 400: INVALID_BODY_FORMAT
{
  "success": false,
  "error": "Request body must be a single object for nested resource creation",
  "error_code": "INVALID_BODY_FORMAT"
}
```

### Missing Required Field

```bash
POST /api/data/posts/post-123/comments
{"author": "Alice"}  # Missing required 'text' field

# Response: 422
{
  "success": false,
  "error": "Validation failed: text is required",
  "error_code": "VALIDATION_ERROR"
}
```

### Invalid Relationship

```bash
POST /api/data/posts/post-123/invalid_relationship

# Error 404: RELATIONSHIP_NOT_FOUND
{
  "success": false,
  "error": "Relationship 'invalid_relationship' not found for model 'posts'",
  "error_code": "RELATIONSHIP_NOT_FOUND"
}
```

## Parent Verification

Before creating the child record, the endpoint verifies:
1. Parent record exists
2. User has read access to parent record
3. Relationship is defined and is type "owned"

This ensures child records are always created with valid parent references.

## ACL Inheritance

Child records can inherit access control from their parent:
- Default ACLs may be based on parent's access lists
- Observers can apply custom ACL logic based on parent
- Root users bypass all ACL checks

## Transaction Behavior

The child creation executes within a database transaction:
- ✅ **Success** - Child record created and linked to parent
- ❌ **Failure** - Transaction rolled back, no changes persisted

## Related Endpoints

- [`GET /api/data/:model/:record/:relationship`](GET.md) - List all child records
- [`DELETE /api/data/:model/:record/:relationship`](DELETE.md) - Delete all child records
- [`PUT /api/data/:model/:record/:relationship/:child`](:child/PUT.md) - Update specific child record
- [`POST /api/data/:model`](../../:model/POST.md) - Bulk create records (use for multiple children)
