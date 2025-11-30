# GET /api/describe/:model/fields

List all fields for a model. Returns an array of field definitions including metadata, constraints, and configuration.

## Path Parameters

- `:model` - Model name (required)

## Query Parameters

None

## Request Body

None - GET request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "model_name": "users",
      "field_name": "email",
      "type": "text",
      "required": true,
      "unique": true,
      "pattern": "^[^@]+@[^@]+\\.[^@]+$",
      "index": true,
      "description": "User email address",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "model_name": "users",
      "field_name": "name",
      "type": "text",
      "required": true,
      "description": "User full name",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### Response Fields

Each field object contains:

- **id** - Field record UUID
- **model_name** - Name of the model
- **field_name** - Name of the field
- **type** - Data type (text, integer, decimal, boolean, timestamp, etc.)
- **required** - Whether field is required (NOT NULL)
- **unique** - Whether field values must be unique
- **default_value** - Default value for the field
- **minimum** - Minimum value for numeric types
- **maximum** - Maximum value for numeric types or max length for text
- **pattern** - Regular expression pattern for text validation
- **enum_values** - Array of allowed values
- **description** - Human-readable description
- **immutable** - Whether value can be set once but never changed
- **sudo** - Whether sudo token required to modify
- **index** - Whether field has standard btree index
- **searchable** - Whether full-text search is enabled
- **tracked** - Whether changes are tracked in history
- **transform** - Auto-transform values (lowercase, uppercase, trim, etc.)
- **relationship_type** - Type of relationship (owned, referenced)
- **related_model** - Target model for relationships
- **related_field** - Target field for relationships
- **relationship_name** - Name of the relationship for API access
- **cascade_delete** - Whether to cascade delete
- **required_relationship** - Whether relationship is required
- **created_at** - Timestamp when field was created
- **updated_at** - Timestamp when field was last modified

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |

## Example Usage

### List All Fields

```bash
curl -X GET http://localhost:9001/api/describe/users/fields \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "model_name": "users",
      "field_name": "email",
      "type": "text",
      "required": true,
      "unique": true,
      "pattern": "^[^@]+@[^@]+\\.[^@]+$",
      "index": true,
      "description": "User email address",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "model_name": "users",
      "field_name": "name",
      "type": "text",
      "required": true,
      "description": "User full name",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### Using in JavaScript

```javascript
async function listFields(modelName) {
  const response = await fetch(`/api/describe/${modelName}/fields`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: fields } = await response.json();
  return fields;
}

// Get all required fields
async function getRequiredFields(modelName) {
  const fields = await listFields(modelName);
  return fields.filter(col => col.required);
}

// Get all indexed fields
async function getIndexedFields(modelName) {
  const fields = await listFields(modelName);
  return fields.filter(col => col.index || col.unique || col.searchable);
}
```

## Use Cases

### Model Documentation Generator

```javascript
// Generate documentation for a model
async function generateModelDoc(modelName) {
  const fields = await listFields(modelName);

  const doc = fields.map(col => {
    const constraints = [];
    if (col.required) constraints.push('required');
    if (col.unique) constraints.push('unique');
    if (col.immutable) constraints.push('immutable');

    return `- **${col.field_name}** (${col.type})${constraints.length ? ' [' + constraints.join(', ') + ']' : ''}: ${col.description || 'No description'}`;
  }).join('\n');

  return doc;
}
```

### Validation Model Builder

```javascript
// Build client-side validation from field metadata
async function buildValidationModel(modelName) {
  const fields = await listFields(modelName);

  const model = {};

  for (const col of fields) {
    model[col.field_name] = {
      type: col.type,
      required: col.required,
      unique: col.unique,
      pattern: col.pattern,
      min: col.minimum,
      max: col.maximum,
      enum: col.enum_values
    };
  }

  return model;
}
```

### Migration Checker

```javascript
// Compare fields between environments
async function compareModelFields(modelName, env1, env2) {
  const cols1 = await fetchFields(env1, modelName);
  const cols2 = await fetchFields(env2, modelName);

  const names1 = cols1.map(c => c.field_name);
  const names2 = cols2.map(c => c.field_name);

  const onlyIn1 = names1.filter(n => !names2.includes(n));
  const onlyIn2 = names2.filter(n => !names1.includes(n));

  return {
    missing_in_env2: onlyIn1,
    missing_in_env1: onlyIn2,
    common: names1.filter(n => names2.includes(n))
  };
}
```

## Field Ordering

Fields are returned sorted by `field_name` in ascending order. This ensures consistent ordering across requests and environments.

## System Fields

System-managed fields (id, timestamps, access_*) are not returned by this endpoint. This endpoint only returns user-defined fields from the model definition.

## Performance Considerations

- Results are fetched directly from the `fields` table
- Fast response time (typically < 20ms for models with < 100 fields)
- No joins or complex queries required
- Safe for frequent polling

## Related Endpoints

- [`GET /api/describe/:model`](../GET.md) - Get model metadata
- [`GET /api/describe/:model/fields/:field`](:field/GET.md) - Get individual field
- [`POST /api/describe/:model/fields/:field`](:field/POST.md) - Add new field
- [`PUT /api/describe/:model/fields/:field`](:field/PUT.md) - Update field
- [`DELETE /api/describe/:model/fields/:field`](:field/DELETE.md) - Remove field
