# DELETE /api/describe/:model/fields/:field

Remove a field from the model. This operation soft-deletes the field metadata (marks as trashed in fields table) and drops the field from the PostgreSQL table, permanently deleting all data in that field.

## Path Parameters

- `:model` - Model name (required)
- `:field` - Field name (required)

## Query Parameters

None

## Request Body

None - DELETE request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "model_name": "users",
    "field_name": "phone"
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `MODEL_PROTECTED` | "Model is protected and cannot be modified" | System model |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 404 | `FIELD_NOT_FOUND` | "Field not found in model" | Field doesn't exist or already deleted |

## Example Usage

### Delete Field

```bash
curl -X DELETE http://localhost:9001/api/describe/users/fields/phone \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "model_name": "users",
    "field_name": "phone"
  }
}
```

### Using in JavaScript

```javascript
async function deleteField(modelName, fieldName) {
  const response = await fetch(`/api/describe/${modelName}/fields/${fieldName}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const { data } = await response.json();
  console.log(`Field '${data.field_name}' deleted from '${data.model_name}'`);
  return data;
}
```

## Use Cases

### Remove Deprecated Field

```javascript
// Clean up old fields no longer in use
async function removeDeprecatedFields(modelName, deprecatedFields) {
  for (const fieldName of deprecatedFields) {
    try {
      await deleteField(modelName, fieldName);
      console.log(`Removed deprecated field: ${fieldName}`);
    } catch (error) {
      console.error(`Failed to remove ${fieldName}:`, error);
    }
  }
}

// Example
await removeDeprecatedFields('users', ['old_field', 'temp_data', 'unused_field']);
```

### Model Migration

```javascript
// Remove field during migration
async function migrateUserModel() {
  // Add new field
  await createField('users', 'full_name', {
    type: 'text',
    required: true
  });

  // Copy data from old fields
  await copyDataToNewField();

  // Remove old fields
  await deleteField('users', 'first_name');
  await deleteField('users', 'last_name');

  console.log('Migration complete');
}
```

### Safe Deletion with Confirmation

```javascript
// Delete field with safety checks
async function safeDeleteField(modelName, fieldName) {
  // Check if field has data
  const sampleData = await fetch(`/api/find/${modelName}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      select: [fieldName],
      limit: 1
    })
  });

  const hasData = (await sampleData.json()).data.length > 0;

  if (hasData) {
    const confirmed = confirm(
      `Field '${fieldName}' contains data. Delete anyway? This cannot be undone.`
    );

    if (!confirmed) {
      console.log('Deletion cancelled');
      return;
    }
  }

  // Perform deletion
  await deleteField(modelName, fieldName);
  console.log(`Field '${fieldName}' permanently deleted`);
}
```

## What Gets Deleted

When you delete a field:

### Immediate Actions
- Field record in `fields` table marked with `trashed_at`
- PostgreSQL field **dropped** from table (`ALTER TABLE DROP COLUMN`)
- **All data in the field is permanently deleted**
- Associated indexes dropped
- Associated constraints removed
- Model cache invalidated

### Data Loss
- ⚠️ **All data in this field is permanently deleted**
- ⚠️ **This operation cannot be undone**
- ⚠️ **No automatic backup is created**

### What Remains
- Field metadata in `fields` table (trashed)
- Can be found using `?include_trashed=true`
- Metadata can be restored, but data is lost forever

## Restoring Field Metadata

To restore the field definition (not the data):

```bash
# Clear trashed_at to restore field metadata
PUT /api/data/fields/:field_id
{
  "trashed_at": null
}
```

**Important:** This only restores the metadata. The PostgreSQL field and all data are permanently deleted.

To recreate the field with data, you must:
1. Create new field: `POST /api/describe/:model/fields/:field`
2. Restore data from backups manually

## System Field Protection

You cannot delete:
- System fields (id, created_at, updated_at, etc.)
- Fields in system models
- Fields referenced by other models (foreign keys)

## Pre-Delete Considerations

Before deleting a field:

1. **Backup data** - Export field data if needed later
```bash
GET /api/data/:model?select=field_name&format=csv > backup.csv
```

2. **Check relationships** - Verify no foreign keys reference this field
```bash
GET /api/data/fields?where={"related_model":"model","related_field":"field"}
```

3. **Review dependencies** - Check application code for references
4. **Notify team** - Alert developers of the deletion
5. **Test in staging** - Always test deletions in non-production first

## Performance Considerations

- Field deletion is a DDL operation (ALTER TABLE DROP COLUMN)
- May lock table briefly during deletion
- Faster than adding fields (no data migration)
- Consider maintenance windows for large tables
- Dropping indexed fields removes index automatically

## Common Errors

### Foreign Key Constraint
If other tables reference this field:
```
ERROR: cannot drop field because other objects depend on it
```
**Solution:** Remove foreign key relationships first.

### System Field
Attempting to delete protected fields:
```
403 MODEL_PROTECTED: System fields cannot be deleted
```
**Solution:** System fields (id, timestamps, access fields) cannot be deleted.

## ALTER TABLE Behavior

Deleting a field executes:
```sql
ALTER TABLE model_name DROP COLUMN field_name CASCADE;
```

The `CASCADE` option ensures:
- Dependent indexes are dropped
- Dependent constraints are removed
- View dependencies may cause errors (drop views first)

## Related Endpoints

- [`GET /api/describe/:model/fields/:field`](GET.md) - Get field definition
- [`POST /api/describe/:model/fields/:field`](POST.md) - Create new field
- [`PUT /api/describe/:model/fields/:field`](PUT.md) - Update field definition
- [`DELETE /api/describe/:model`](../:model/DELETE.md) - Delete entire model
