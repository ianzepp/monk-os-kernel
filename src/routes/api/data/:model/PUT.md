# PUT /api/data/:model

Apply updates to every record in the payload, using the provided `id` fields to target rows. Use this endpoint for bulk edits, model migrations, or cross-record data fixes—observers ensure validation and audit hooks run for each updated record, and omitting an `id` immediately rejects the request.

## Path Parameters

- `:model` - Model name (required)

## Query Parameters

- `include_trashed=true` - When combined with PATCH method, performs revert operation

## Request Body

Always expects an **array of record objects with `id` fields**. Only include the fields you want to update:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Updated",
    "department": "Senior Engineering"
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "email": "jane.smith@example.com"
  }
]
```

**Important:** Each object **must include an `id` field** to identify which record to update.

## Success Response (200)

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "John Updated",
      "email": "john@example.com",
      "department": "Senior Engineering",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T11:00:00Z",
      "trashed_at": null,
      "deleted_at": null
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "Jane Smith",
      "email": "jane.smith@example.com",
      "department": "Marketing",
      "created_at": "2024-01-15T10:30:01Z",
      "updated_at": "2024-01-15T11:00:05Z",
      "trashed_at": null,
      "deleted_at": null
    }
  ]
}
```

### Response Fields

Each updated record includes:
- All fields (updated values merged with existing values)
- **updated_at** - Timestamp when record was updated
- Unchanged fields retain their original values

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `BODY_NOT_ARRAY` | "Request body must be an array of update records with id fields" | Body is not an array or missing id fields |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Attempting to write to frozen model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | One or more IDs don't exist |
| 422 | Validation errors | Various | Observer validation failures |

## Transaction Behavior

All updates in the request execute within a **single database transaction**:

✅ **All succeed together** - If every update passes validation, all are persisted
❌ **All fail together** - If any update fails, the entire batch is rolled back

## Example Usage

### Bulk Update User Departments

```bash
curl -X PUT http://localhost:9001/api/data/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "user-1", "department": "Engineering"},
    {"id": "user-2", "department": "Engineering"},
    {"id": "user-3", "department": "Engineering"}
  ]'
```

### Partial Field Updates

Only the fields you include are updated—other fields remain unchanged:

```bash
curl -X PUT http://localhost:9001/api/data/products \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "prod-1", "price": 29.99},
    {"id": "prod-2", "in_stock": false}
  ]'
```

**Result:**
- Product 1: Only `price` updated, other fields unchanged
- Product 2: Only `in_stock` updated, other fields unchanged

### Bulk Status Change

```bash
curl -X PUT http://localhost:9001/api/data/orders \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "order-123", "status": "shipped", "shipped_at": "2024-01-15T10:00:00Z"},
    {"id": "order-456", "status": "shipped", "shipped_at": "2024-01-15T10:05:00Z"},
    {"id": "order-789", "status": "shipped", "shipped_at": "2024-01-15T10:10:00Z"}
  ]'
```

## Smart Routing: Revert Operation

When using **PATCH method** with `include_trashed=true`, this endpoint performs a **revert operation** instead of an update:

```bash
PATCH /api/data/users?include_trashed=true \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"id": "user-1"},
    {"id": "user-2"}
  ]'
```

**Behavior:**
- Finds records where `trashed_at IS NOT NULL`
- Sets `trashed_at = NULL` (restores from trash)
- Returns restored records

**Use case:** Bulk restore soft-deleted records from trash bin.

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

If any observer throws an error, the transaction rolls back and no records are updated.

## Model Protection

### Frozen Models

Models with `frozen=true` reject all update operations:

```bash
PUT /api/data/audit_log
# Error 403: MODEL_FROZEN
```

### Sudo-Protected Models

Models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Updating financial records"}

# Then use sudo token
PUT /api/data/financial_accounts
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
PUT /api/data/transactions
[{"id": "tx-123", "transaction_id": "NEW-ID"}]

# Error: Cannot modify immutable fields: transaction_id

# But if model.immutable=false, other fields can be updated:
PUT /api/data/transactions
[{"id": "tx-123", "amount": 1500}]  # OK: amount is not immutable
```

## Validation Examples

### Missing ID Field

```bash
PUT /api/data/users
[{"name": "Updated Name"}]  # Missing 'id' field

# Error 400: BODY_NOT_ARRAY
# "Request body must be an array of update records with id fields"
```

### Non-Existent Record

```bash
PUT /api/data/users
[{"id": "non-existent-id", "name": "Test"}]

# Error 404: RECORD_NOT_FOUND
```

### Invalid Field Value

```bash
PUT /api/data/products
[{"id": "prod-1", "price": "not-a-number"}]

# Error 422: Validation failed: price must be a number
```

## Merge Behavior

Updates are **merged** with existing records:

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
[{"id": "user-1", "department": "Management"}]
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
- User-defined fields

## Performance Considerations

### Batch Size Recommendations

- ✅ **1-100 records**: Optimal performance
- ⚠️ **100-1000 records**: Good, but consider chunking
- ❌ **1000+ records**: Consider using background job or chunking into smaller batches

### Large Dataset Operations

For very large updates beyond typical API usage:

- **Extracts API** - Export large datasets for offline processing
- **Restores API** - Import updated datasets with optimized bulk loading

See the Extracts and Restores API documentation for handling high-volume data operations.

## Related Endpoints

- [`GET /api/data/:model`](GET.md) - Query all records
- [`POST /api/data/:model`](POST.md) - Bulk create records
- [`DELETE /api/data/:model`](DELETE.md) - Bulk delete records
- [`PUT /api/data/:model/:id`](../:model/:record/PUT.md) - Update single record
