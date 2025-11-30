# GET /api/describe/:model

Retrieve model metadata including status, protection settings, and configuration. This endpoint returns model-level information only - use field endpoints to retrieve field definitions.

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

### Response Fields

- **id** - Model record UUID
- **model_name** - Name of the model
- **status** - Model status: `pending`, `active`, or `system`
- **description** - Human-readable description of the model's purpose
- **sudo** - Whether sudo token is required for data operations
- **freeze** - Whether all data changes are prevented (reads still work)
- **immutable** - Whether records are write-once (can be created but not modified)
- **created_at** - Timestamp when model was created
- **updated_at** - Timestamp when model was last modified

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |

## Example Usage

### Get Model Metadata

```bash
curl -X GET http://localhost:9001/api/describe/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
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

### Using in JavaScript

```javascript
async function getModel(modelName) {
  const response = await fetch(`/api/describe/${modelName}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: model } = await response.json();
  return model;
}

// Check if model requires sudo
async function requiresSudo(modelName) {
  const model = await getModel(modelName);
  return model.sudo === true;
}

// Check if model is frozen
async function isFrozen(modelName) {
  const model = await getModel(modelName);
  return model.freeze === true;
}
```

## Use Cases

### Model Validation Before Operations

```javascript
// Check model protection before attempting write
async function safeCreateRecord(modelName, recordData) {
  const model = await getModel(modelName);

  if (model.freeze) {
    throw new Error(`Model '${modelName}' is frozen - no writes allowed`);
  }

  if (model.sudo) {
    // Get sudo token first
    const sudoToken = await getSudoToken('Creating record');
    return createWithSudo(modelName, recordData, sudoToken);
  }

  // Normal create operation
  return createRecord(modelName, recordData);
}
```

### Model Documentation UI

```javascript
// Display model information in admin panel
async function renderModelInfo(modelName) {
  const model = await getModel(modelName);

  return `
    <div class="model-info">
      <h2>${model.model_name}</h2>
      <p>${model.description || 'No description'}</p>
      <dl>
        <dt>Status:</dt>
        <dd>${model.status}</dd>
        <dt>Protection:</dt>
        <dd>
          ${model.sudo ? '🔐 Sudo Required' : ''}
          ${model.freeze ? '🧊 Frozen' : ''}
          ${model.immutable ? '📌 Immutable' : ''}
        </dd>
        <dt>Created:</dt>
        <dd>${new Date(model.created_at).toLocaleDateString()}</dd>
      </dl>
    </div>
  `;
}
```

### Migration Comparison

```javascript
// Compare model settings between environments
async function compareModelConfig(modelName, env1, env2) {
  const model1 = await fetchModel(env1, modelName);
  const model2 = await fetchModel(env2, modelName);

  const differences = [];

  if (model1.sudo !== model2.sudo) {
    differences.push(`Sudo: ${env1}=${model1.sudo}, ${env2}=${model2.sudo}`);
  }

  if (model1.freeze !== model2.freeze) {
    differences.push(`Freeze: ${env1}=${model1.freeze}, ${env2}=${model2.freeze}`);
  }

  if (model1.immutable !== model2.immutable) {
    differences.push(`Immutable: ${env1}=${model1.immutable}, ${env2}=${model2.immutable}`);
  }

  return differences;
}
```

## Model Status Values

- **pending** - Model created but not yet active
- **active** - Model is active and available for use
- **system** - Protected system model (cannot be modified or deleted)

## Model Protection Flags

### sudo
When `true`, all data operations on this model require a sudo token:
```bash
# Get sudo token first
POST /api/user/sudo
{"reason": "Modifying financial records"}

# Use sudo token for operations
Authorization: Bearer SUDO_TOKEN
```

### freeze
When `true`, all data changes are prevented:
- ❌ CREATE operations blocked
- ❌ UPDATE operations blocked
- ❌ DELETE operations blocked
- ✅ SELECT operations still work

Use for emergency lockdowns or maintenance windows.

### immutable
When `true`, records follow write-once pattern:
- ✅ Records can be created
- ❌ Records cannot be modified after creation
- ✅ Records can be soft-deleted (trashed)

Perfect for audit logs, blockchain-style records, or compliance requirements.

## Field Information

**Note:** This endpoint returns model-level metadata only. To retrieve field definitions:

- Use [`GET /api/describe/:model/fields`](fields/GET.md) for all fields
- Use [`GET /api/describe/:model/fields/:field`](fields/:field/GET.md) for individual fields
- Query the `fields` table via Data API: `GET /api/data/fields?where={"model_name":"users"}`

## System Model Protection

Models with `status='system'` have special protection:
- Cannot be modified via PUT
- Cannot be deleted via DELETE
- Fields cannot be added or removed
- Only root users can access system models

## Performance Considerations

- Model metadata is cached with timestamp-based validation
- Fast response time (typically < 10ms)
- Safe for frequent polling
- No database joins required

## Related Endpoints

- [`GET /api/describe`](../GET.md) - List all models
- [`POST /api/describe/:model`](POST.md) - Create new model
- [`PUT /api/describe/:model`](PUT.md) - Update model metadata
- [`DELETE /api/describe/:model`](DELETE.md) - Delete model
- [`GET /api/describe/:model/fields/:field`](:field/GET.md) - Get field definition
