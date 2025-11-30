# GET /api/describe

List all available model names in the current tenant. This endpoint provides a lightweight directory of models without their definitions or field details.

## Path Parameters

None

## Query Parameters

None

## Request Body

None - GET request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": [
    "users",
    "accounts",
    "products",
    "invoices"
  ]
}
```

The response contains an array of model names (strings). System models are included in the list.

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |

## Example Usage

### List All Models

```bash
curl -X GET http://localhost:9001/api/describe \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": [
    "users",
    "accounts",
    "products",
    "orders",
    "invoices"
  ]
}
```

### Using in JavaScript

```javascript
async function listModels() {
  const response = await fetch('/api/describe', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: models } = await response.json();
  return models;
}

// Example: Check if a model exists
async function modelExists(modelName) {
  const models = await listModels();
  return models.includes(modelName);
}
```

## Use Cases

### Model Discovery

```javascript
// Discover all available models in the tenant
const models = await listModels();
console.log('Available models:', models);

// Build dynamic UI for model selection
const modelSelect = document.getElementById('model-select');
models.forEach(model => {
  const option = document.createElement('option');
  option.value = model;
  option.textContent = model;
  modelSelect.appendChild(option);
});
```

### Validation Before Operations

```javascript
// Validate model exists before attempting operations
async function createRecord(modelName, recordData) {
  const models = await listModels();

  if (!models.includes(modelName)) {
    throw new Error(`Model '${modelName}' does not exist`);
  }

  // Proceed with create operation
  const response = await fetch(`/api/data/${modelName}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([recordData])
  });

  return response.json();
}
```

### Database Migration Tools

```javascript
// Check for model changes between environments
async function compareModels(sourceEnv, targetEnv) {
  const sourceModels = await fetchModels(sourceEnv);
  const targetModels = await fetchModels(targetEnv);

  const missing = sourceModels.filter(s => !targetModels.includes(s));
  const extra = targetModels.filter(s => !sourceModels.includes(s));

  return { missing, extra };
}
```

## Default Behavior

- Returns **all models** in the current tenant (including system models)
- Returns **model names only** (not full definitions or fields)
- Models are returned in **alphabetical order**
- No pagination - returns complete list

## Tenant Isolation

This endpoint respects tenant boundaries:
- Only returns models belonging to the authenticated user's tenant
- Different tenants cannot see each other's models
- System models may be visible across all tenants

## System Models

The response includes system models (those with `status='system'`):
- `models` - Model metadata
- `fields` - Field definitions
- `users` - User accounts
- `sessions` - Active sessions
- And other internal tables

System models are protected and cannot be modified or deleted.

## Performance Considerations

This endpoint is highly optimized:
- Results are cached with timestamp-based validation
- Fast response time even with hundreds of models
- Minimal database queries
- Safe for frequent polling

## Related Endpoints

- [`GET /api/describe/:model`](:model/GET.md) - Get model definition
- [`POST /api/describe/:model`](:model/POST.md) - Create new model
- [`DELETE /api/describe/:model`](:model/DELETE.md) - Delete model
