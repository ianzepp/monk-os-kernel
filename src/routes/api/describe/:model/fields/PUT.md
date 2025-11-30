# PUT /api/describe/:model/fields

Update multiple fields in bulk for a model.

## Request

```http
PUT /api/describe/:model/fields
Authorization: Bearer <token>
Content-Type: application/json
```

### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Target model name |

### Request Body

Array of field updates. Each field must include `field_name` to identify which field to update.

```json
[
  {
    "field_name": "email",
    "index": true,
    "searchable": true
  },
  {
    "field_name": "name",
    "required": true
  },
  {
    "field_name": "status",
    "tracked": true
  }
]
```

### Updateable Properties

See [Describe API documentation](../PUBLIC.md#field-fields) for complete field property reference.

| Property | Type | Description |
|----------|------|-------------|
| `required` | boolean | NOT NULL constraint |
| `unique` | boolean | UNIQUE constraint |
| `index` | boolean | Create btree index |
| `default_value` | any | Default value |
| `description` | string | Human-readable description |
| `minimum` | number | Minimum value (numeric types) |
| `maximum` | number | Maximum value or max length |
| `pattern` | string | Regex validation (text types) |
| `enum_values` | string[] | Allowed values |
| `tracked` | boolean | Enable change tracking |
| `immutable` | boolean | Write-once field |
| `sudo` | boolean | Require sudo token to modify |
| `searchable` | boolean | Enable full-text search |
| `transform` | string | Auto-transform: `lowercase`, `uppercase`, `trim`, etc. |

**Note:** `field_name` and `type` cannot be changed after field creation.

## Response

### Success (200 OK)

```json
{
  "success": true,
  "data": [
    {
      "field_name": "email",
      "type": "text",
      "index": true,
      "searchable": true
    },
    {
      "field_name": "name",
      "type": "text",
      "required": true
    },
    {
      "field_name": "status",
      "type": "text",
      "tracked": true
    }
  ]
}
```

### Errors

| Status | Error Code | Description |
|--------|------------|-------------|
| 400 | `BODY_NOT_ARRAY` | Request body must be an array |
| 400 | `FIELD_NAME_REQUIRED` | Each field update must include `field_name` |
| 404 | `MODEL_NOT_FOUND` | Model does not exist |
| 404 | `FIELD_NOT_FOUND` | Field does not exist in model |

## Examples

### Enable tracking on multiple fields

```bash
curl -X PUT http://localhost:9001/api/describe/orders/fields \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"field_name": "status", "tracked": true},
    {"field_name": "total", "tracked": true},
    {"field_name": "shipping_address", "tracked": true}
  ]'
```

### Add indexes to frequently queried fields

```bash
curl -X PUT http://localhost:9001/api/describe/users/fields \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"field_name": "email", "index": true, "unique": true},
    {"field_name": "username", "index": true},
    {"field_name": "created_at", "index": true}
  ]'
```

### Update validation rules

```bash
curl -X PUT http://localhost:9001/api/describe/products/fields \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"field_name": "price", "minimum": 0, "required": true},
    {"field_name": "quantity", "minimum": 0, "default_value": 0},
    {"field_name": "status", "enum_values": ["draft", "active", "archived"]}
  ]'
```

## Notes

- All fields are updated in a single transaction - if any field fails, none are updated
- Field lookups use the ModelCache for efficiency (no extra DB queries)
- Structural changes (index, unique, required) trigger ALTER TABLE operations
- Metadata-only changes (tracked, description, minimum, etc.) do not alter the table

## Related

- [GET /api/describe/:model/fields](GET.md) - List all fields
- [POST /api/describe/:model/fields](POST.md) - Bulk create fields
- [PUT /api/describe/:model/fields/:field](:field/PUT.md) - Update single field
- [Describe API Overview](../PUBLIC.md) - Full field property reference
