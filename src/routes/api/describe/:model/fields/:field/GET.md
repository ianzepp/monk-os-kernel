# GET /api/describe/:model/fields/:field

Retrieve a specific field definition including type, constraints, validation rules, and metadata. This endpoint returns the complete field configuration from the fields table.

## Path Parameters

- `:model` - Model name (required)
- `:field` - Field name (required)

## Query Parameters

None

## Request Body

None - GET request with no body.

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
    "unique": true,
    "pattern": "^[^@]+@[^@]+\\.[^@]+$",
    "description": "User email address",
    "index": true,
    "immutable": false,
    "sudo": false,
    "tracked": false,
    "searchable": false,
    "transform": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

### Response Fields

#### Identity
- **id** - Field record UUID
- **model_name** - Name of the model
- **field_name** - Name of the field
- **type** - Data type (text, integer, decimal, boolean, timestamp, date, uuid, jsonb, or array types)

#### Constraints
- **required** - Whether field is required (NOT NULL)
- **default_value** - Default value for the field
- **unique** - Whether values must be unique

#### Validation
- **minimum** - Minimum value for numeric types
- **maximum** - Maximum value for numeric types or max length for text
- **pattern** - Regular expression pattern for text validation
- **enum_values** - Array of allowed values

#### Metadata
- **description** - Human-readable description of the field's purpose

#### Protection
- **immutable** - Value can be set once but never changed
- **sudo** - Require sudo token to modify this field

#### Indexing & Search
- **index** - Whether standard btree index is created
- **searchable** - Whether full-text search with GIN index is enabled

#### Change Tracking
- **tracked** - Whether changes are tracked in history table

#### Data Transform
- **transform** - Auto-transform values (lowercase, uppercase, trim, etc.)

#### Relationships
- **relationship_type** - Type of relationship (owned or referenced)
- **related_model** - Target model for relationship
- **related_field** - Target field for relationship
- **relationship_name** - Name of the relationship for API access
- **cascade_delete** - Whether to cascade delete when parent is deleted
- **required_relationship** - Whether relationship is required (NOT NULL FK)

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 404 | `FIELD_NOT_FOUND` | "Field not found in model" | Field doesn't exist |

## Example Usage

### Get Field Definition

```bash
curl -X GET http://localhost:9001/api/describe/users/email \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "model_name": "users",
    "field_name": "email",
    "type": "text",
    "required": true,
    "unique": true,
    "pattern": "^[^@]+@[^@]+\\.[^@]+$",
    "description": "User email address",
    "index": true,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

### Using in JavaScript

```javascript
async function getField(modelName, fieldName) {
  const response = await fetch(`/api/describe/${modelName}/${fieldName}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: field } = await response.json();
  return field;
}

// Check if field is required
async function isRequired(modelName, fieldName) {
  const field = await getField(modelName, fieldName);
  return field.required === true;
}

// Get validation pattern
async function getValidationPattern(modelName, fieldName) {
  const field = await getField(modelName, fieldName);
  return field.pattern;
}
```

## Use Cases

### Form Validation

```javascript
// Build client-side validation from field definition
async function buildFormValidation(modelName) {
  const fields = await getAllFields(modelName);
  const validation = {};

  for (const field of fields) {
    validation[field.field_name] = {
      required: field.required,
      pattern: field.pattern,
      min: field.minimum,
      max: field.maximum,
      enum: field.enum_values
    };
  }

  return validation;
}
```

### Model Documentation

```javascript
// Generate documentation from field metadata
async function documentField(modelName, fieldName) {
  const field = await getField(modelName, fieldName);

  return `
    ### ${field.field_name}
    ${field.description || 'No description'}

    - **Type:** ${field.type}
    - **Required:** ${field.required ? 'Yes' : 'No'}
    - **Unique:** ${field.unique ? 'Yes' : 'No'}
    ${field.pattern ? `- **Pattern:** \`${field.pattern}\`` : ''}
    ${field.minimum ? `- **Minimum:** ${field.minimum}` : ''}
    ${field.maximum ? `- **Maximum:** ${field.maximum}` : ''}
    ${field.enum_values ? `- **Allowed values:** ${field.enum_values.join(', ')}` : ''}
  `;
}
```

### Migration Comparison

```javascript
// Compare field definitions between environments
async function compareField(modelName, fieldName, env1, env2) {
  const col1 = await fetchField(env1, modelName, fieldName);
  const col2 = await fetchField(env2, modelName, fieldName);

  const differences = [];

  if (col1.type !== col2.type) {
    differences.push(`Type: ${env1}=${col1.type}, ${env2}=${col2.type}`);
  }

  if (col1.required !== col2.required) {
    differences.push(`Required: ${env1}=${col1.required}, ${env2}=${col2.required}`);
  }

  if (col1.pattern !== col2.pattern) {
    differences.push(`Pattern: ${env1}=${col1.pattern}, ${env2}=${col2.pattern}`);
  }

  return differences;
}
```

### UI Field Generation

```javascript
// Generate form field from field definition
async function renderFormField(modelName, fieldName) {
  const field = await getField(modelName, fieldName);

  const input = document.createElement('input');
  input.name = field.field_name;
  input.required = field.required;

  // Set input type based on field type
  switch (field.type) {
    case 'integer':
    case 'decimal':
      input.type = 'number';
      if (field.minimum) input.min = field.minimum;
      if (field.maximum) input.max = field.maximum;
      break;
    case 'boolean':
      input.type = 'checkbox';
      break;
    case 'date':
      input.type = 'date';
      break;
    case 'timestamp':
      input.type = 'datetime-local';
      break;
    default:
      input.type = 'text';
      if (field.pattern) input.pattern = field.pattern;
      if (field.maximum) input.maxLength = field.maximum;
  }

  return input;
}
```

## Field Types

### Basic Types
- **text** - General strings (PostgreSQL: TEXT)
- **integer** - Whole numbers (PostgreSQL: INTEGER)
- **decimal** - Precise decimals (PostgreSQL: NUMERIC)
- **boolean** - True/false values (PostgreSQL: BOOLEAN)

### Date/Time Types
- **timestamp** - Date and time (PostgreSQL: TIMESTAMP WITH TIME ZONE)
- **date** - Date only (PostgreSQL: DATE)

### Special Types
- **uuid** - Universally unique identifier (PostgreSQL: UUID)
- **jsonb** - JSON data (PostgreSQL: JSONB)

### Array Types
- **text[]** - Array of strings (PostgreSQL: TEXT[])
- **integer[]** - Array of integers (PostgreSQL: INTEGER[])
- And other array variants

## Protection Flags

### immutable
When `true`, value can be set once during record creation but never modified:
- Perfect for transaction IDs, timestamps, immutable identifiers
- Write operations on this field after creation will fail

### sudo
When `true`, modifying this field requires a sudo token:
- Even if the model doesn't require sudo
- Additional protection for sensitive fields like roles, permissions

## Performance Considerations

- Field metadata is cached
- Fast response time (typically < 10ms)
- No database joins required
- Safe for frequent access

## Related Endpoints

- [`POST /api/describe/:model/fields/:field`](POST.md) - Create new field
- [`PUT /api/describe/:model/fields/:field`](PUT.md) - Update field definition
- [`DELETE /api/describe/:model/fields/:field`](DELETE.md) - Delete field
- [`GET /api/describe/:model`](../:model/GET.md) - Get model definition
