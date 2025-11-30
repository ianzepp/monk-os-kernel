# POST /api/describe/:model/fields

Create multiple fields in bulk for a model.

## Request

```http
POST /api/describe/:model/fields
Authorization: Bearer <token>
Content-Type: application/json
```

### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Target model name |

### Request Body

Array of field definitions. Each field must include `field_name`.

```json
[
  {
    "field_name": "name",
    "type": "text",
    "required": true,
    "description": "User full name"
  },
  {
    "field_name": "email",
    "type": "text",
    "required": true,
    "unique": true,
    "index": true,
    "pattern": "^[^@]+@[^@]+\\.[^@]+$"
  },
  {
    "field_name": "age",
    "type": "integer",
    "minimum": 0,
    "maximum": 150
  }
]
```

### Field Properties

See [Describe API documentation](../PUBLIC.md#field-fields) for complete field property reference.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `field_name` | string | Yes | Field identifier (must be valid PostgreSQL identifier) |
| `type` | string | Yes | Data type: `text`, `integer`, `decimal`, `boolean`, `timestamp`, `date`, `uuid`, `jsonb`, or array types |
| `required` | boolean | No | NOT NULL constraint |
| `unique` | boolean | No | UNIQUE constraint |
| `index` | boolean | No | Create btree index |
| `default_value` | any | No | Default value |
| `description` | string | No | Human-readable description |
| `minimum` | number | No | Minimum value (numeric types) |
| `maximum` | number | No | Maximum value or max length |
| `pattern` | string | No | Regex validation (text types) |
| `enum_values` | string[] | No | Allowed values |
| `tracked` | boolean | No | Enable change tracking |
| `immutable` | boolean | No | Write-once field |
| `sudo` | boolean | No | Require sudo token to modify |
| `searchable` | boolean | No | Enable full-text search |
| `transform` | string | No | Auto-transform: `lowercase`, `uppercase`, `trim`, etc. |

## Response

### Success (200 OK)

```json
{
  "success": true,
  "data": [
    {
      "field_name": "name",
      "type": "text",
      "required": true,
      "description": "User full name"
    },
    {
      "field_name": "email",
      "type": "text",
      "required": true,
      "unique": true,
      "index": true,
      "pattern": "^[^@]+@[^@]+\\.[^@]+$"
    },
    {
      "field_name": "age",
      "type": "integer",
      "minimum": 0,
      "maximum": 150
    }
  ]
}
```

### Errors

| Status | Error Code | Description |
|--------|------------|-------------|
| 400 | `BODY_NOT_ARRAY` | Request body must be an array |
| 400 | `VALIDATION_ERROR` | Field definition missing `field_name` |
| 404 | `MODEL_NOT_FOUND` | Model does not exist |
| 409 | `FIELD_EXISTS` | Field already exists in model |

## Example

### Create all fields for a model in one request

```bash
curl -X POST http://localhost:9001/api/describe/products/fields \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"field_name": "name", "type": "text", "required": true},
    {"field_name": "sku", "type": "text", "required": true, "unique": true, "index": true},
    {"field_name": "price", "type": "decimal", "required": true, "minimum": 0},
    {"field_name": "quantity", "type": "integer", "default_value": 0, "minimum": 0},
    {"field_name": "category", "type": "text", "enum_values": ["electronics", "clothing", "food"]},
    {"field_name": "description", "type": "text", "searchable": true},
    {"field_name": "is_active", "type": "boolean", "default_value": true}
  ]'
```

### Complete model setup workflow

```bash
# Step 1: Create model
curl -X POST http://localhost:9001/api/describe/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "pending"}'

# Step 2: Add ALL fields in one request
curl -X POST http://localhost:9001/api/describe/products/fields \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"field_name": "name", "type": "text", "required": true},
    {"field_name": "price", "type": "decimal", "minimum": 0},
    {"field_name": "quantity", "type": "integer", "default_value": 0}
  ]'

# Step 3: Activate model
curl -X PUT http://localhost:9001/api/describe/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "active"}'
```

## Notes

- All fields are created in a single transaction - if any field fails, none are created
- The `model_name` is automatically injected from the URL parameter
- Field order in the array does not affect column order in PostgreSQL
- Use this endpoint instead of multiple `POST /api/describe/:model/fields/:field` calls for efficiency

## Related

- [GET /api/describe/:model/fields](GET.md) - List all fields
- [POST /api/describe/:model/fields/:field](:field/POST.md) - Create single field
- [Describe API Overview](../PUBLIC.md) - Full field property reference
