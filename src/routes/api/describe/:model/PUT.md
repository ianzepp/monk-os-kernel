# PUT /api/describe/:model

Update model metadata and protection settings. This endpoint modifies model-level configuration only - use field endpoints to modify field definitions.

## Path Parameters

- `:model` - Model name (required)

## Query Parameters

None

## Request Body

```json
{
  "status": "active",
  "description": "Updated description",
  "sudo": true,
  "freeze": false,
  "immutable": false
}
```

### Allowed Updates

- **status** - Change model status (`pending`, `active`)
- **description** - Update model description
- **sudo** - Change sudo requirement for data operations
- **freeze** - Change freeze status (emergency lockdown)
- **immutable** - Change immutable status (write-once pattern)

**Note:** You cannot change `status` to `system` via the API. System models cannot be modified.

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "model_name": "users",
    "status": "active",
    "description": "Updated description",
    "sudo": true,
    "freeze": false,
    "immutable": false,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T12:45:00Z"
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_PROTECTED` | "Model is protected and cannot be modified" | Attempting to modify system model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |

## Example Usage

### Activate Model

```bash
curl -X PUT http://localhost:9001/api/describe/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "active"
  }'
```

### Enable sudo Protection

```bash
curl -X PUT http://localhost:9001/api/describe/financial_accounts \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sudo": true
  }'
```

### Emergency Freeze

```bash
# Freeze model to prevent data changes during incident
curl -X PUT http://localhost:9001/api/describe/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "freeze": true
  }'
```

### Update Description

```bash
curl -X PUT http://localhost:9001/api/describe/products \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Product catalog with inventory tracking"
  }'
```

## Use Cases

### Model Lifecycle Management

```javascript
// Deploy workflow: pending → active
async function activateModel(modelName) {
  const response = await fetch(`/api/describe/${modelName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'active' })
  });

  const { data: model } = await response.json();
  console.log(`Model '${model.model_name}' is now active`);
  return model;
}
```

### Emergency Lockdown

```javascript
// Freeze model during security incident
async function emergencyFreeze(modelName, reason) {
  console.log(`EMERGENCY: Freezing ${modelName} - ${reason}`);

  const response = await fetch(`/api/describe/${modelName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      freeze: true,
      description: `FROZEN: ${reason}`
    })
  });

  const { data: model } = await response.json();

  // Notify team
  await notifyTeam(`Model ${modelName} has been frozen: ${reason}`);

  return model;
}

// Later: Unfreeze after incident resolved
async function unfreezeModel(modelName) {
  return await fetch(`/api/describe/${modelName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ freeze: false })
  });
}
```

### Add sudo Protection to Existing Model

```javascript
// Upgrade model to require sudo
async function enableSudo(modelName) {
  const response = await fetch(`/api/describe/${modelName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sudo: true })
  });

  const { data: model } = await response.json();
  console.log(`Model '${model.model_name}' now requires sudo token`);
  return model;
}
```

### Convert to Immutable Model

```javascript
// Make existing model immutable for compliance
async function makeImmutable(modelName) {
  const response = await fetch(`/api/describe/${modelName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      immutable: true,
      description: 'Audit log - records are write-once'
    })
  });

  const { data: model } = await response.json();
  console.log(`Model '${model.model_name}' is now immutable`);
  return model;
}
```

## Model Status Transitions

Valid status transitions:
- `pending` → `active` (model is ready for use)
- `active` → `pending` (rollback activation)

**Cannot transition to:**
- `system` (reserved for internal models)

## Protection Flag Behavior

### Enabling sudo
When sudo is enabled on an existing model:
- **Immediate effect**: All subsequent data operations require sudo token
- **Active sessions**: Existing requests without sudo token will fail
- **Use case**: Upgrade security for sensitive data

### Enabling freeze
When freeze is enabled:
- **Immediate effect**: All write operations blocked
- **Read operations**: Continue to work normally
- **Use case**: Emergency lockdown, maintenance windows, incident response

### Enabling immutable
When immutable is enabled on existing model:
- **New records**: Can be created
- **Existing records**: Can no longer be modified
- **Use case**: Convert audit log to write-once after initial data load

## Modifying Fields

**Important:** This endpoint updates model-level metadata only. To modify fields:

- Add field: [`POST /api/describe/:model/fields/:field`](:field/POST.md)
- Update field: [`PUT /api/describe/:model/fields/:field`](:field/PUT.md)
- Delete field: [`DELETE /api/describe/:model/fields/:field`](:field/DELETE.md)

## System Model Protection

Models with `status='system'` cannot be modified:
- `PUT` operations return `403 MODEL_PROTECTED`
- Only root users can access system models
- System model protection is permanent

Examples of system models:
- `models` - Model metadata
- `fields` - Field definitions
- `users` - User accounts
- `sessions` - Active sessions

## Performance Considerations

- Model metadata updates are fast (< 10ms)
- No DDL operations required (no ALTER TABLE)
- Changes take effect immediately
- Model cache is invalidated and refreshed

## Validation

The endpoint validates:
- Model exists and is accessible
- User has permission to modify model
- Status values are valid (`pending`, `active`)
- Boolean values for protection flags

## Related Endpoints

- [`GET /api/describe/:model`](GET.md) - Get model definition
- [`POST /api/describe/:model`](POST.md) - Create new model
- [`DELETE /api/describe/:model`](DELETE.md) - Delete model
- [`PUT /api/describe/:model/fields/:field`](:field/PUT.md) - Update field definition
