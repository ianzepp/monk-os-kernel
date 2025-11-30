# DELETE /api/describe/:model

Soft-delete a model definition and its associated PostgreSQL table. The model is marked as deleted and can be restored using the Data API if needed.

## Path Parameters

- `:model` - Model name (required)

## Query Parameters

None

## Request Body

None - DELETE request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "model_name": "users"
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_PROTECTED` | "Model is protected and cannot be modified" | Attempting to delete system model |
| 404 | `MODEL_NOT_FOUND` | "Model not found or already deleted" | Model doesn't exist or is already trashed |

## Example Usage

### Delete Model

```bash
curl -X DELETE http://localhost:9001/api/describe/old_users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "model_name": "old_users"
  }
}
```

### Using in JavaScript

```javascript
async function deleteModel(modelName) {
  const response = await fetch(`/api/describe/${modelName}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const { data } = await response.json();
  console.log(`Model '${data.model_name}' deleted successfully`);
  return data;
}
```

## Use Cases

### Cleanup Old Models

```javascript
// Delete temporary or test models
async function cleanupTestModels() {
  const models = await listModels();
  const testModels = models.filter(s => s.startsWith('test_'));

  for (const modelName of testModels) {
    try {
      await deleteModel(modelName);
      console.log(`Deleted test model: ${modelName}`);
    } catch (error) {
      console.error(`Failed to delete ${modelName}:`, error);
    }
  }
}
```

### Model Migration

```javascript
// Replace old model with new version
async function migrateModel(oldName, newName) {
  // Step 1: Create new model
  await createModel(newName);

  // Step 2: Copy data from old to new
  const oldData = await getData(oldName);
  await bulkCreate(newName, oldData);

  // Step 3: Verify migration
  const count = await getRecordCount(newName);
  console.log(`Migrated ${count} records to ${newName}`);

  // Step 4: Delete old model
  await deleteModel(oldName);
  console.log(`Old model ${oldName} deleted`);
}
```

### Safe Deletion with Confirmation

```javascript
// Delete model with safety checks
async function safeDeleteModel(modelName) {
  // Check if model has data
  const count = await getRecordCount(modelName);

  if (count > 0) {
    const confirmed = confirm(
      `Model '${modelName}' contains ${count} records. Delete anyway?`
    );

    if (!confirmed) {
      console.log('Deletion cancelled');
      return;
    }
  }

  // Perform deletion
  await deleteModel(modelName);
  console.log(`Model '${modelName}' deleted (${count} records)`);
}
```

## Soft Delete Behavior

This endpoint performs a **soft delete**:
- Model record is marked with `trashed_at` timestamp
- PostgreSQL table is **dropped** (data is lost)
- Model definition remains in `models` table
- Can be restored by clearing `trashed_at` field

**Important:** While the model metadata can be restored, the underlying data is permanently deleted when the PostgreSQL table is dropped.

## What Gets Deleted

When you delete a model:

### Immediate Actions
- PostgreSQL table is **dropped** (all data permanently lost)
- Model record marked with `trashed_at` timestamp
- Field definitions marked as trashed
- Model cache invalidated

### Data Loss
- ⚠️ **All records in the table are permanently deleted**
- ⚠️ **This operation cannot be undone**
- ⚠️ **No backup is created automatically**

### What Remains
- Model metadata in `models` table (trashed)
- Field definitions in `fields` table (trashed)
- Can be found using `?include_trashed=true`

## Restoring a Deleted Model

To restore the model definition (not the data):

```bash
# Clear trashed_at to restore model metadata
PUT /api/data/models/:model_id
{
  "trashed_at": null
}
```

**Note:** This only restores the model definition. You'll need to manually restore any data from backups.

## System Model Protection

System models cannot be deleted:
- `models` - Model metadata
- `fields` - Field definitions
- `users` - User accounts
- `sessions` - Active sessions

Attempting to delete a system model returns `403 MODEL_PROTECTED`.

## Pre-Delete Considerations

Before deleting a model, consider:

1. **Backup data** - Export records if you might need them
```bash
GET /api/data/:model?format=csv > backup.csv
```

2. **Check relationships** - Verify no other models reference this one
```bash
GET /api/data/fields?where={"related_model":"model_name"}
```

3. **Notify users** - Alert team members of the deletion
4. **Review freeze option** - Consider freezing instead of deleting for temporary disable

## Alternative: Freeze Instead of Delete

For temporary disabling without data loss:

```bash
PUT /api/describe/:model
{
  "freeze": true
}
```

This prevents writes while preserving all data.

## Performance Considerations

- Model deletion is a DDL operation (DROP TABLE)
- May take longer for large tables
- Locks the table during deletion
- Consider performing during maintenance windows for large models

## Related Endpoints

- [`GET /api/describe/:model`](GET.md) - Get model definition
- [`POST /api/describe/:model`](POST.md) - Create new model
- [`PUT /api/describe/:model`](PUT.md) - Update model metadata
- [`PUT /api/data/models/:id`](../../data/models/:id/PUT.md) - Restore trashed model metadata
