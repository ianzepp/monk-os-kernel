# PUT /api/data/:model/:record

Update a single record by UUID, applying either a full replacement or partial patch depending on the HTTP method. The operation enforces model validation, applies the observer pipeline, and returns the updated record so clients can refresh their UI state without issuing a follow-up GET request.

## Path Parameters

- `:model` - Model name (required)
- `:record` - Record UUID (required)

## Query Parameters

- `include_trashed=true` - When combined with PATCH method, performs revert operation instead of update

## Request Body

Record update object. Only include the fields you want to update:

```json
{
  "name": "John Updated",
  "department": "Senior Engineering"
}
```

**Note:** Do not include `id` in the body—the record ID is specified in the URL path.

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Updated",
    "email": "john@example.com",
    "department": "Senior Engineering",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T11:00:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

### Response Fields

Each updated record includes:
- All fields (updated values merged with existing values)
- **updated_at** - Automatically set to current timestamp
- Unchanged fields retain their original values

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Attempting to write to frozen model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Record ID does not exist |
| 422 | Validation errors | Various | Observer validation failures |

## HTTP Methods

### PUT - Full Update

Replaces all fields with provided values (unspecified fields remain unchanged in practice):

```bash
curl -X PUT http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Updated",
    "email": "john.updated@example.com",
    "department": "Senior Engineering"
  }'
```

### PATCH - Partial Update

Updates only the specified fields (more common):

```bash
curl -X PATCH http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "department": "Senior Engineering"
  }'
```

**Result:** Only `department` is updated, all other fields remain unchanged.

## Smart Routing: Revert Operation

When using **PATCH method** with `include_trashed=true`, this endpoint performs a **revert operation** instead of an update:

```bash
curl -X PATCH "http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000?include_trashed=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

**Behavior:**
- Finds record where `trashed_at IS NOT NULL`
- Sets `trashed_at = NULL` (restores from trash)
- Returns restored record

**Use case:** Restore a single soft-deleted record from trash.

## Example Usage

### Update Single Field

```bash
curl -X PATCH http://localhost:9001/api/data/products/prod-123 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"price": 29.99}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "prod-123",
    "name": "Widget",
    "price": 29.99,
    "sku": "WDG-001",
    "in_stock": true,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T11:00:00Z"
  }
}
```

### Update Multiple Fields

```bash
curl -X PATCH http://localhost:9001/api/data/users/user-123 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe Updated",
    "department": "Engineering",
    "title": "Senior Engineer"
  }'
```

### Restore Trashed Record

```bash
curl -X PATCH "http://localhost:9001/api/data/users/user-123?include_trashed=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "user-123",
    "name": "John Doe",
    "email": "john@example.com",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T11:00:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

## Merge Behavior

Updates are **merged** with existing records—only the fields you specify are updated:

**Existing record:**
```json
{
  "id": "user-1",
  "name": "Alice",
  "email": "alice@example.com",
  "department": "Engineering",
  "role": "Senior"
}
```

**Update request:**
```json
{
  "department": "Management"
}
```

**Result:**
```json
{
  "id": "user-1",
  "name": "Alice",              // ← Unchanged
  "email": "alice@example.com", // ← Unchanged
  "department": "Management",   // ← Updated
  "role": "Senior",             // ← Unchanged
  "updated_at": "2024-01-15T11:00:00Z"
}
```

## Updating System Fields

Most system fields are **protected** and cannot be updated:

❌ **Cannot update:**
- `id` - Record identifier (immutable)
- `created_at` - Creation timestamp (immutable)
- `trashed_at` - Use DELETE endpoint instead
- `deleted_at` - Use DELETE with permanent=true instead

✅ **Can update:**
- `updated_at` - Automatically set to current timestamp
- All user-defined fields (subject to model validation and protection)

## Observer Pipeline

Updated records pass through the full observer pipeline:

### Pre-Update Observers
- **Validation** - Model validation, required fields, data types
- **Security** - Check permissions, verify ACLs
- **Business Logic** - Custom validation rules
- **Immutability Check** - Prevent changes to immutable fields

### Post-Update Observers
- **Audit Logging** - Record update events
- **Notifications** - Trigger webhooks, emails
- **Side Effects** - Update related records, invalidate caches

If any observer throws an error, the transaction rolls back and no changes are persisted.

## Model Protection

### Frozen Models

Models with `frozen=true` reject all update operations:

```bash
PUT /api/data/audit_log/record-123
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Models

Models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Updating financial records"}

# Then use sudo token
PUT /api/data/financial_accounts/acc-123
Authorization: Bearer SUDO_TOKEN
```

### Immutable Models and Fields

**Model-level immutability** (`models.immutable=true`):
- Entire records cannot be modified after creation
- All update operations will fail
- Use for audit logs, blockchain-style records

**Field-level immutability** (`fields.immutable=true`):
- Specific fields cannot be changed after creation
- Other fields in the record can still be updated
- Use for transaction IDs, immutable identifiers

```bash
PUT /api/data/transactions/tx-123
{"transaction_id": "NEW-ID"}

# Error: Cannot modify immutable fields: transaction_id

# But if model.immutable=false, other fields can be updated:
PUT /api/data/transactions/tx-123
{"amount": 1500}  # OK: amount is not immutable
```

## Validation Examples

### Invalid Field Value

```bash
PUT /api/data/products/prod-123
{"price": "not-a-number"}

# Response: 422
{
  "success": false,
  "error": "Validation failed: price must be a number",
  "error_code": "VALIDATION_ERROR"
}
```

### Missing Required Field

If a required field is omitted and has no existing value:

```bash
PUT /api/data/users/user-123
{"email": ""}  # Required field with empty value

# Response: 422
{
  "success": false,
  "error": "Validation failed: email is required",
  "error_code": "VALIDATION_ERROR"
}
```

### Immutable Field Modification Attempt

```bash
PUT /api/data/transactions/tx-123
{"transaction_id": "NEW-TX-ID"}

# Response: 422
{
  "success": false,
  "error": "Cannot modify immutable fields: transaction_id",
  "error_code": "VALIDATION_ERROR"
}
```

## Use Cases

### Update User Profile

```javascript
async function updateUserProfile(userId, updates) {
  const response = await fetch(`/api/data/users/${userId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });

  const { data: updatedUser } = await response.json();
  return updatedUser;
}

// Usage
const user = await updateUserProfile('user-123', {
  department: 'Engineering',
  title: 'Senior Engineer'
});
```

### Toggle Boolean Field

```javascript
async function toggleProductAvailability(productId) {
  // Get current state
  const { data: product } = await fetch(`/api/data/products/${productId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  // Toggle and update
  const response = await fetch(`/api/data/products/${productId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      in_stock: !product.in_stock
    })
  });

  return response.json();
}
```

### Restore Deleted Record

```javascript
async function restoreUser(userId) {
  const response = await fetch(`/api/data/users/${userId}?include_trashed=true`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (response.ok) {
    const { data: restoredUser } = await response.json();
    console.log('User restored:', restoredUser);
    return restoredUser;
  }
}
```

## Related Endpoints

- [`GET /api/data/:model/:record`](GET.md) - Retrieve single record
- [`DELETE /api/data/:model/:record`](DELETE.md) - Delete single record
- [`PUT /api/data/:model`](../:model/PUT.md) - Bulk update records
