# POST /api/describe/:model

Create a new model with metadata and protection settings. After creating the model, add fields individually using the field endpoints. The model creation automatically generates the underlying PostgreSQL table structure.

## Path Parameters

- `:model` - Model name (required, must match `model_name` in request body unless `?force=true`)

## Query Parameters

- `force=true` - Override model name mismatch between URL and body. If URL model differs from `model_name` in request body, the request fails unless this parameter is provided.

## Request Body

```json
{
  "model_name": "users",
  "status": "active",
  "description": "User accounts and profiles",
  "sudo": false,
  "freeze": false,
  "immutable": false
}
```

### Required Fields

- **model_name** - Model name (must match URL parameter unless `?force=true`)

### Optional Fields

- **status** - Model status: `pending` (default), `active`, or `system`
- **description** - Human-readable description of the model's purpose
- **sudo** - Require sudo token for all data operations (default: `false`)
- **freeze** - Prevent all data changes, SELECT still works (default: `false`)
- **immutable** - Records are write-once (can create but not modify) (default: `false`)

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "model_name": "users",
    "status": "active",
    "description": "User accounts and profiles",
    "sudo": false,
    "freeze": false,
    "immutable": false,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `MISSING_REQUIRED_FIELDS` | "Model name is required" | Missing model_name field |
| 400 | `INVALID_MODEL_NAME` | "Model name must contain only alphanumerics and underscores" | Invalid model name format |
| 400 | `MODEL_NAME_MISMATCH` | "URL model does not match body model_name" | URL != body and no ?force=true |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 409 | `MODEL_EXISTS` | "Model already exists" | Model name already in use |

## Example Usage

### Create Basic Model

```bash
curl -X POST http://localhost:9001/api/describe/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "users",
    "status": "active",
    "description": "User accounts and profiles"
  }'
```

### Create Model with sudo Protection

```bash
curl -X POST http://localhost:9001/api/describe/financial_accounts \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "financial_accounts",
    "status": "active",
    "description": "Financial account records",
    "sudo": true
  }'
```

### Create Immutable Model for Audit Log

```bash
curl -X POST http://localhost:9001/api/describe/audit_log \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type": "application/json" \
  -d '{
    "model_name": "audit_log",
    "status": "active",
    "description": "System audit trail",
    "immutable": true
  }'
```

### Using force Parameter

```bash
# URL says 'users_v2' but body says 'users' - use force to override
curl -X POST "http://localhost:9001/api/describe/users_v2?force=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "users",
    "status": "active"
  }'
```

### Complete Model Creation Workflow

```javascript
// Step 1: Create model
async function createUserModel() {
  const response = await fetch('/api/describe/users', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model_name: 'users',
      status: 'active',
      description: 'User accounts and profiles'
    })
  });

  const { data: model } = await response.json();
  console.log('Model created:', model.model_name);

  return model;
}

// Step 2: Add fields (one at a time)
async function addUserFields() {
  // Add name field
  await fetch('/api/describe/users/fields/name', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'text',
      required: true,
      description: 'User full name'
    })
  });

  // Add email field
  await fetch('/api/describe/users/fields/email', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'text',
      required: true,
      unique: true,
      pattern: '^[^@]+@[^@]+\\.[^@]+$',
      description: 'User email address'
    })
  });

  console.log('Fields added to model');
}

// Execute workflow
await createUserModel();
await addUserFields();
```

## Model Naming Rules

Model names must follow PostgreSQL identifier rules:
- Start with a letter or underscore
- Contain only letters, numbers, and underscores
- Maximum 63 characters
- Case-insensitive (stored as lowercase)

**Valid examples:**
- `users`
- `user_accounts`
- `_internal_cache`
- `products_v2`

**Invalid examples:**
- `123users` (starts with number)
- `user-accounts` (contains hyphen)
- `user.accounts` (contains period)

## Adding Fields After Creation

**Important:** Model creation no longer accepts a `fields` array in the request body. After creating the model, add fields individually:

```bash
POST /api/describe/:model/fields/:field
```

See [`POST /api/describe/:model/fields/:field`](:field/POST.md) for details.

## Model Protection Patterns

### Sudo-Protected Model
Requires elevated permissions for all data operations:
```json
{
  "model_name": "sensitive_data",
  "sudo": true
}
```

All operations on this model will require a sudo token obtained via `POST /api/user/sudo`.

### Frozen Model
Prevents all data modifications during maintenance:
```json
{
  "model_name": "products",
  "freeze": true
}
```

Blocks CREATE, UPDATE, DELETE operations. SELECT still works.

### Immutable Model
Write-once pattern for audit trails:
```json
{
  "model_name": "transaction_log",
  "immutable": true
}
```

Records can be created but never modified. Perfect for compliance and audit requirements.

## Automatic Table Creation

When a model is created, the system automatically:
1. Creates a record in the `models` table
2. Generates PostgreSQL table structure with system fields:
   - `id` (UUID, primary key)
   - `created_at` (timestamp)
   - `updated_at` (timestamp)
   - `trashed_at` (timestamp, for soft deletes)
   - `deleted_at` (timestamp, for permanent deletes)
   - `access_read` (UUID[], ACL permissions)
   - `access_edit` (UUID[], ACL permissions)
   - `access_full` (UUID[], ACL permissions)
3. Sets up triggers for timestamp management
4. Initializes cache entries

## System Models

You cannot create models with `status='system'` via the API. System models are reserved for:
- Core platform tables (models, fields, users, sessions)
- Internal metadata and configuration
- Protected system functionality

## Performance Considerations

- Model creation is a DDL operation (ALTER TABLE)
- May take longer for databases with many models
- Consider creating models during setup/migration, not at runtime
- Use pending status initially, then activate after testing

## Related Endpoints

- [`GET /api/describe`](../GET.md) - List all models
- [`GET /api/describe/:model`](GET.md) - Get model definition
- [`PUT /api/describe/:model`](PUT.md) - Update model metadata
- [`DELETE /api/describe/:model`](DELETE.md) - Delete model
- [`POST /api/describe/:model/fields/:field`](:field/POST.md) - Add field to model
