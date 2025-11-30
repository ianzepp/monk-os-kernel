# PUT /api/describe/:model/fields/:field

Update an existing field's properties. Supports both metadata-only updates (fast) and structural changes that trigger ALTER TABLE (slower).

## Path Parameters

- `:model` - Model name (required)
- `:field` - Field name (required)

## Query Parameters

None

## Request Body

```json
{
  "pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
  "description": "Updated email validation pattern",
  "index": true
}
```

### Metadata-Only Updates (Fast)
These fields update only the fields table metadata:
- **description** - Human-readable description
- **pattern** - Regular expression validation
- **minimum** - Minimum value constraint
- **maximum** - Maximum value constraint
- **enum_values** - Allowed values
- **immutable** - Write-once protection
- **sudo** - Sudo requirement for this field
- **tracked** - Change tracking
- **transform** - Data transformation
- Relationship fields (relationship_type, related_model, etc.)

### Structural Updates (ALTER TABLE)
These fields trigger PostgreSQL ALTER TABLE:
- **type** - Change field data type
- **required** - Add/remove NOT NULL constraint
- **default_value** - Add/change DEFAULT constraint
- **unique** - Add/remove UNIQUE constraint
- **index** - Add/remove index
- **searchable** - Add/remove full-text search index

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "model_name": "users",
    "field_name": "email",
    "type": "text",
    "required": true,
    "pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
    "description": "Updated email validation pattern",
    "index": true,
    "updated_at": "2024-01-15T12:45:00Z"
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `NO_UPDATES` | "No valid fields to update" | Empty request body |
| 400 | `INVALID_TYPE` | "Invalid field type" | Unsupported data type |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token |
| 403 | `MODEL_PROTECTED` | "Model is protected" | System model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model |
| 404 | `FIELD_NOT_FOUND` | "Field not found" | Invalid field |

## Example Usage

### Update Description (Metadata Only)

```bash
curl -X PUT http://localhost:9001/api/describe/users/fields/email \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Primary email address for account"
  }'
```

### Update Validation Pattern

```bash
curl -X PUT http://localhost:9001/api/describe/users/fields/email \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
  }'
```

### Make Field Required (ALTER TABLE)

```bash
curl -X PUT http://localhost:9001/api/describe/users/fields/name \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "required": true
  }'
```

### Add Index (ALTER TABLE)

```bash
curl -X PUT http://localhost:9001/api/describe/users/email \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "index": true
  }'
```

### Enable Full-Text Search (ALTER TABLE)

```bash
curl -X PUT http://localhost:9001/api/describe/articles/content \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "searchable": true
  }'
```

### Change Data Type (ALTER TABLE)

```bash
# Convert integer to text
curl -X PUT http://localhost:9001/api/describe/products/code \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text"
  }'
```

## Use Cases

### Improve Validation Rules

```javascript
// Tighten email validation
async function improveEmailValidation() {
  await fetch('/api/describe/users/email', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
      description': 'Email address with strict validation'
    })
  });
}
```

### Add Performance Index

```javascript
// Add index to frequently queried field
async function optimizeQuery(modelName, fieldName) {
  const response = await fetch(`/api/describe/${modelName}/${fieldName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ index: true })
  });

  console.log(`Index added to ${modelName}.${fieldName}`);
}
```

### Enable Change Tracking

```javascript
// Enable audit trail for sensitive field
async function enableAudit(modelName, fieldName) {
  await fetch(`/api/describe/${modelName}/${fieldName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      tracked: true,
      description: 'Tracked for audit compliance'
    })
  });
}
```

### Make Field Immutable

```javascript
// Protect field from future changes
async function lockField(modelName, fieldName) {
  await fetch(`/api/describe/${modelName}/${fieldName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      immutable: true,
      description: 'Immutable transaction ID'
    })
  });
}
```

## Metadata vs Structural Updates

### Metadata Updates (Fast, No Table Lock)
- Updates only the `fields` table
- No ALTER TABLE required
- Immediate effect
- No table locking
- Examples: description, pattern, enum_values

### Structural Updates (Slower, Table Lock)
- Updates `fields` table AND PostgreSQL table
- Requires ALTER TABLE
- May take time on large tables
- Brief table lock during operation
- Examples: type, required, index

## Type Conversion

When changing `type`, PostgreSQL attempts automatic conversion:

**Safe conversions:**
- `integer` → `text` (always works)
- `text` → `integer` (if all values are numeric)
- `decimal` → `integer` (truncates decimals)

**Risky conversions:**
- `text` → `uuid` (fails if non-UUID values exist)
- `integer` → `boolean` (PostgreSQL rules apply)

**Best practice:** Test type changes on a copy first.

## Adding/Removing Constraints

### Making Required
```json
{"required": true}
```
**Effect:** Adds NOT NULL constraint. Fails if NULL values exist.

### Making Unique
```json
{"unique": true}
```
**Effect:** Creates UNIQUE index. Fails if duplicate values exist.

### Removing Constraints
```json
{"required": false}
```
**Effect:** Drops NOT NULL constraint.

## Index Management

### Adding Standard Index
```json
{"index": true}
```
Creates: `CREATE INDEX idx_{model}_{field} ON {model}({field});`

### Adding Full-Text Index
```json
{"searchable": true}
```
Creates: `CREATE INDEX idx_{model}_{field}_fts ON {model} USING gin(to_tsvector('english', {field}));`

### Removing Index
```json
{"index": false}
```
Drops the index.

## Performance Considerations

- **Metadata updates**: Fast (< 10ms)
- **Structural updates**: Depends on table size
- Large tables: Consider maintenance windows for ALTER TABLE
- Adding indexes: Can be slow on large tables
- Type conversions: May require table scan

## Validation

Updates are validated for:
- Field exists and is accessible
- User has permission to modify
- Type is valid (if changing type)
- Structural changes are possible (e.g., no NULLs when adding NOT NULL)

## Related Endpoints

- [`GET /api/describe/:model/fields/:field`](GET.md) - Get field definition
- [`POST /api/describe/:model/fields/:field`](POST.md) - Create new field
- [`DELETE /api/describe/:model/fields/:field`](DELETE.md) - Delete field
- [`PUT /api/describe/:model`](../:model/PUT.md) - Update model metadata
