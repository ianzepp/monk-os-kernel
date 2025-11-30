# POST /api/describe/:model/fields/:field

Add a new field to an existing model. This operation modifies both the fields table (metadata) and the PostgreSQL table structure (ALTER TABLE ADD COLUMN).

## Path Parameters

- `:model` - Model name (required)
- `:field` - Field name (required, taken from URL not request body)

## Query Parameters

None

## Request Body

```json
{
  "type": "text",
  "required": false,
  "unique": false,
  "pattern": "^\\+?[1-9]\\d{1,14}$",
  "description": "User phone number",
  "index": true
}
```

### Required Fields

- **type** - Data type: `text`, `integer`, `decimal`, `boolean`, `timestamp`, `date`, `uuid`, `jsonb`, or array types (`text[]`, `integer[]`, etc.)

### Optional Fields

#### Constraints
- **required** - Whether field is required/NOT NULL (default: `false`)
- **default_value** - Default value for the field
- **unique** - Whether values must be unique (default: `false`)

#### Validation
- **minimum** - Minimum value for numeric types
- **maximum** - Maximum value for numeric or max length for text
- **pattern** - Regular expression pattern for text validation
- **enum_values** - Array of allowed values

#### Metadata
- **description** - Human-readable description

#### Protection
- **immutable** - Value can be set once but never changed (default: `false`)
- **sudo** - Require sudo token to modify this field (default: `false`)

#### Indexing & Search
- **index** - Create standard btree index (default: `false`)
- **searchable** - Enable full-text search with GIN index (default: `false`, text fields only)

#### Change Tracking
- **tracked** - Track changes in history table (default: `false`)

#### Data Transform
- **transform** - Auto-transform values: `lowercase`, `uppercase`, `trim`, `normalize_phone`, `normalize_email`

#### Relationships
- **relationship_type** - Type of relationship: `owned` or `referenced`
- **related_model** - Target model for relationship
- **related_field** - Target field (default: `id`)
- **relationship_name** - Name for API access
- **cascade_delete** - Cascade delete when parent deleted (default: `false`)
- **required_relationship** - Relationship is required/NOT NULL FK (default: `false`)

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "model_name": "users",
    "field_name": "phone",
    "type": "text",
    "required": false,
    "pattern": "^\\+?[1-9]\\d{1,14}$",
    "description": "User phone number",
    "index": true,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `MISSING_REQUIRED_FIELDS` | "Field type is required" | Missing type field |
| 400 | `INVALID_FIELD_NAME` | "Field name must start with letter or underscore" | Invalid field name format |
| 400 | `INVALID_TYPE` | "Invalid field type" | Unsupported data type |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token |
| 403 | `MODEL_PROTECTED` | "Model is protected and cannot be modified" | System model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 409 | `FIELD_EXISTS` | "Field already exists" | Field name already in use |

## Example Usage

### Add Simple Text Field

```bash
curl -X POST http://localhost:9001/api/describe/users/fields/bio \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "description": "User biography"
  }'
```

### Add Required Email Field

```bash
curl -X POST http://localhost:9001/api/describe/users/fields/email \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "required": true,
    "unique": true,
    "pattern": "^[^@]+@[^@]+\\.[^@]+$",
    "description": "User email address",
    "index": true
  }'
```

### Add Integer Field with Constraints

```bash
curl -X POST http://localhost:9001/api/describe/products/fields/price \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "decimal",
    "required": true,
    "minimum": 0,
    "maximum": 999999.99,
    "description": "Product price in USD"
  }'
```

### Add Field with Enum Values

```bash
curl -X POST http://localhost:9001/api/describe/users/fields/role \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "required": true,
    "enum_values": ["admin", "user", "guest"],
    "default_value": "user",
    "description": "User role"
  }'
```

### Add Full-Text Searchable Field

```bash
curl -X POST http://localhost:9001/api/describe/articles/fields/content \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "searchable": true,
    "description": "Article content for full-text search"
  }'
```

### Add Relationship Field

```bash
curl -X POST http://localhost:9001/api/describe/posts/fields/author_id \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "uuid",
    "required": true,
    "relationship_type": "referenced",
    "related_model": "users",
    "related_field": "id",
    "relationship_name": "author",
    "cascade_delete": false,
    "description": "Post author"
  }'
```

## Complete Model Build Workflow

```javascript
// Create model and add fields
async function buildUserModel() {
  // Step 1: Create model
  await fetch('/api/describe/users', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model_name: 'users',
      status: 'pending'
    })
  });

  // Step 2: Add fields
  const fields = [
    {
      name: 'name',
      def: {
        type: 'text',
        required: true,
        description: 'User full name'
      }
    },
    {
      name: 'email',
      def: {
        type: 'text',
        required: true,
        unique: true,
        pattern: '^[^@]+@[^@]+\\.[^@]+$',
        index: true,
        description: 'User email'
      }
    },
    {
      name: 'age',
      def: {
        type: 'integer',
        minimum: 0,
        maximum: 150,
        description: 'User age'
      }
    }
  ];

  for (const field of fields) {
    await fetch(`/api/describe/users/${field.name}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(field.def)
    });
  }

  // Step 3: Activate model
  await fetch('/api/describe/users', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'active' })
  });

  console.log('User model created with fields');
}
```

## Field Naming Rules

Field names must follow PostgreSQL identifier rules:
- Start with a letter or underscore
- Contain only letters, numbers, and underscores
- Maximum 63 characters
- Case-insensitive (stored as lowercase)

**Valid examples:**
- `email`
- `first_name`
- `_internal_id`
- `created_at`

**Invalid examples:**
- `123code` (starts with number)
- `user-name` (contains hyphen)
- `user.name` (contains period)

## Data Types

### Basic Types
- **text** - General strings (PostgreSQL: TEXT)
- **integer** - Whole numbers (PostgreSQL: INTEGER)
- **decimal** - Precise decimals (PostgreSQL: NUMERIC)
- **boolean** - True/false (PostgreSQL: BOOLEAN)

### Date/Time
- **timestamp** - Date and time with timezone (PostgreSQL: TIMESTAMP WITH TIME ZONE)
- **date** - Date only (PostgreSQL: DATE)

### Special
- **uuid** - UUID (PostgreSQL: UUID)
- **jsonb** - JSON data (PostgreSQL: JSONB)

### Arrays
- **text[]** - String array (PostgreSQL: TEXT[])
- **integer[]** - Integer array (PostgreSQL: INTEGER[])
- **uuid[]** - UUID array (PostgreSQL: UUID[])

## Validation Rules

### Application-Level Validation
These rules are enforced in the observer pipeline, not the database:
- `minimum` - Min value for numbers
- `maximum` - Max value/length
- `pattern` - Regex validation
- `enum_values` - Allowed values
- `transform` - Data transformation

### Database-Level Constraints
These create actual PostgreSQL constraints:
- `required` - NOT NULL constraint
- `unique` - UNIQUE constraint/index
- `default_value` - DEFAULT constraint

## Index Types

### Standard Index (`index: true`)
Creates btree index for faster queries:
```sql
CREATE INDEX idx_users_email ON users(email);
```

### Unique Index (`unique: true`)
Creates unique index:
```sql
CREATE UNIQUE INDEX idx_users_email_unique ON users(email);
```

### Full-Text Search (`searchable: true`)
Creates GIN index for text search:
```sql
CREATE INDEX idx_users_content_fts ON users USING gin(to_tsvector('english', content));
```

## Relationship Types

### referenced
Creates foreign key to another table:
```json
{
  "type": "uuid",
  "relationship_type": "referenced",
  "related_model": "users",
  "related_field": "id",
  "relationship_name": "author"
}
```

Allows: `GET /api/data/posts/:id/author`

### owned
Creates one-to-many ownership relationship:
```json
{
  "relationship_type": "owned",
  "related_model": "comments",
  "relationship_name": "comments"
}
```

Allows: `GET /api/data/posts/:id/comments`

## ALTER TABLE Behavior

Adding a field triggers:
1. Record created in `fields` table
2. PostgreSQL ALTER TABLE executed:
   ```sql
   ALTER TABLE users ADD COLUMN phone TEXT;
   ```
3. Indexes/constraints created if specified
4. Model cache invalidated

## Performance Considerations

- Field addition is a DDL operation (ALTER TABLE)
- May lock table briefly during addition
- Consider adding fields during maintenance for large tables
- Multiple fields? Add them one at a time in a transaction

## Related Endpoints

- [`GET /api/describe/:model/fields/:field`](GET.md) - Get field definition
- [`PUT /api/describe/:model/fields/:field`](PUT.md) - Update field
- [`DELETE /api/describe/:model/fields/:field`](DELETE.md) - Delete field
- [`POST /api/describe/:model`](../:model/POST.md) - Create model
