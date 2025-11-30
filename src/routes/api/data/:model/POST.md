# POST /api/data/:model

Create one or more records in the specified model while automatically invoking the observer rings for validation, security, and enrichment. The request executes inside a transaction, ensuring every record is either persisted together or the entire batch rolls back if a single record fails.

## Path Parameters

- `:model` - Model name (required)

## Request Body

Always expects an **array of record objects**. Each object should contain the fields defined in the model.

```json
[
  {
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering"
  },
  {
    "name": "Jane Smith",
    "email": "jane@example.com",
    "department": "Marketing"
  }
]
```

**Important:** Even when creating a single record, the body must be an array:
```json
[
  {
    "name": "Single User",
    "email": "user@example.com"
  }
]
```

## Success Response (201)

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
      "trashed_at": null,
      "deleted_at": null
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "Jane Smith",
      "email": "jane@example.com",
      "department": "Marketing",
      "created_at": "2024-01-15T10:30:01Z",
      "updated_at": "2024-01-15T10:30:01Z",
      "trashed_at": null,
      "deleted_at": null
    }
  ]
}
```

### Response Fields

Each created record includes:
- **id** - Auto-generated UUID
- **User-provided fields** - All fields from the request
- **created_at** - Timestamp when record was created
- **updated_at** - Initially same as created_at
- **trashed_at** - Always null for new records
- **deleted_at** - Always null for new records

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `BODY_NOT_ARRAY` | "Request body must be an array of records" | Body is not an array |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_FROZEN` | "Model is frozen" | Attempting to write to frozen model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 422 | Validation errors | Various | Observer validation failures (see below) |

## Transaction Behavior

All records in the request are created within a **single database transaction**:

✅ **All succeed together** - If every record passes validation, all are persisted
❌ **All fail together** - If any record fails, the entire batch is rolled back

**Example:**
```json
// Request: Create 3 users
[
  {"name": "Alice", "email": "alice@example.com"},
  {"name": "Bob", "email": "invalid-email"},  // ← Validation error
  {"name": "Charlie", "email": "charlie@example.com"}
]

// Result: Transaction rolled back, ZERO records created
// Error response indicates which record failed
```

## Example Usage

### Create Multiple Users

```bash
curl -X POST http://localhost:9001/api/data/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"name": "Alice", "email": "alice@example.com", "role": "admin"},
    {"name": "Bob", "email": "bob@example.com", "role": "user"}
  ]'
```

### Create Single Record

```bash
curl -X POST http://localhost:9001/api/data/products \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "Widget",
      "price": 29.99,
      "sku": "WDG-001",
      "in_stock": true
    }
  ]'
```

### Bulk Import from CSV

```javascript
// Convert CSV data to JSON array
const csvData = `name,email,department
Alice Johnson,alice@example.com,Engineering
Bob Smith,bob@example.com,Marketing
Charlie Brown,charlie@example.com,Sales`;

const records = csvData
  .split('\n')
  .slice(1) // Skip header
  .map(line => {
    const [name, email, department] = line.split(',');
    return { name, email, department };
  });

// Bulk create
const response = await fetch('/api/data/users', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(records)
});

const { data: createdUsers } = await response.json();
console.log(`Created ${createdUsers.length} users`);
```

## Observer Pipeline

Created records pass through the full observer pipeline:

### Pre-Create Observers
- **Validation** - Model validation, required fields, data types
- **Enrichment** - Auto-generate IDs, set defaults, add timestamps
- **Security** - Check permissions, apply ACLs
- **Business Logic** - Custom validation rules

### Post-Create Observers
- **Audit Logging** - Record creation events
- **Notifications** - Trigger webhooks, emails
- **Side Effects** - Update related records, invalidate caches

If any observer throws an error, the transaction rolls back and no records are created.

## Model Protection

### Frozen Models

Models with `frozen=true` **reject all create operations**:

```bash
POST /api/data/audit_log
# Error 403: MODEL_FROZEN
# "Model 'audit_log' is frozen. All data operations are temporarily disabled."
```

### Sudo-Protected Models

Models with `sudo=true` require a sudo token:

```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Creating financial records"}

# Then use sudo token
POST /api/data/financial_accounts
Authorization: Bearer SUDO_TOKEN
```

### Immutable Models and Fields

**Model-level immutability** (`models.immutable=true`):
- Entire records can be created once but never modified
- No updates allowed to any field after creation
- Use for audit logs, blockchain-style records

**Field-level immutability** (`fields.immutable=true`):
- Specific fields can be set once during creation but never modified
- Other fields in the record can still be updated
- Use for transaction IDs, immutable identifiers

```json
// Allowed: Set immutable field during creation
[{"transaction_id": "TX123", "amount": 1000}]

// Later update attempt will fail:
PUT /api/data/transactions/abc-123
{"transaction_id": "TX456"}  // Error: Cannot modify immutable field

// But if model.immutable=false, other fields can be updated:
PUT /api/data/transactions/abc-123
{"amount": 1500}  // OK: amount is not immutable
```

## Field Defaults and Auto-Generation

The system automatically handles:

- **id** - Generated as UUID if not provided
- **created_at** - Set to current timestamp
- **updated_at** - Set to current timestamp
- **trashed_at** - Set to null
- **deleted_at** - Set to null
- **Default values** - Applied from model definition

**Example:**
```json
// Request (minimal)
[{"name": "Alice"}]

// Response (with auto-generated fields)
{
  "success": true,
  "data": [{
    "id": "550e8400-e29b-41d4-a716-446655440000",  // ← Auto-generated
    "name": "Alice",
    "created_at": "2024-01-15T10:30:00Z",         // ← Auto-generated
    "updated_at": "2024-01-15T10:30:00Z",         // ← Auto-generated
    "trashed_at": null,                            // ← Auto-generated
    "deleted_at": null                             // ← Auto-generated
  }]
}
```

## Validation Examples

### Required Field Missing

```bash
POST /api/data/users
[{"email": "alice@example.com"}]  # Missing required 'name' field

# Response: 422
{
  "success": false,
  "error": "Validation failed: name is required",
  "error_code": "VALIDATION_ERROR"
}
```

### Invalid Data Type

```bash
POST /api/data/products
[{"name": "Widget", "price": "not-a-number"}]  # price should be number

# Response: 422
{
  "success": false,
  "error": "Validation failed: price must be a number",
  "error_code": "VALIDATION_ERROR"
}
```

### Duplicate Unique Field

```bash
POST /api/data/users
[
  {"email": "alice@example.com", "name": "Alice"},
  {"email": "alice@example.com", "name": "Alice Clone"}  # Duplicate email
]

# Response: 422 (transaction rolled back, no records created)
{
  "success": false,
  "error": "Duplicate value for unique field: email",
  "error_code": "VALIDATION_ERROR"
}
```

## Performance Considerations

### Batch Size Recommendations

- ✅ **1-100 records**: Optimal performance
- ⚠️ **100-1000 records**: Good, but consider chunking for UI feedback
- ❌ **1000+ records**: Consider using background job or chunking into smaller batches

### Large Dataset Operations

For very large imports or exports beyond typical API usage:

- **Extracts API** - Export large datasets efficiently
- **Restores API** - Import large datasets with optimized bulk loading

See the Extracts and Restores API documentation for handling high-volume data operations.

## Related Endpoints

- [`GET /api/data/:model`](GET.md) - Query all records
- [`PUT /api/data/:model`](PUT.md) - Bulk update records
- [`DELETE /api/data/:model`](DELETE.md) - Bulk delete records
- [`POST /api/bulk`](../../bulk/PUBLIC.md) - Multi-model batch operations
