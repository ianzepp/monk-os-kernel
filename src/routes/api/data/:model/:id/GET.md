# GET /api/data/:model/:record

Retrieve a single record by its UUID, including all fields, system metadata, and optional trashed/permanently deleted states. This endpoint is ideal for detail pages, edit forms, or any view that needs the complete authoritative state of a specific record.

## Path Parameters

- `:model` - Model name (required)
- `:record` - Record UUID (required)

## Query Parameters

- `include_trashed=true` - Include soft-deleted records (where `trashed_at IS NOT NULL`)
- `include_deleted=true` - Include permanently deleted records (where `deleted_at IS NOT NULL`) - requires root access

### Response Transformation Parameters

- `unwrap` - Remove envelope, return record object directly
- `select=field1,field2` - Return only specified fields (implies unwrap)
- `stat=false` - Exclude timestamp fields (created_at, updated_at, trashed_at, deleted_at)
- `access=false` - Exclude ACL fields (access_read, access_edit, access_full)

## Request Body

None - GET request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

### Response Fields

- All model-defined fields
- **id** - Record UUID
- **created_at** - Timestamp when record was created
- **updated_at** - Timestamp when record was last modified
- **trashed_at** - Soft delete timestamp (null if not trashed)
- **deleted_at** - Permanent delete timestamp (null if not permanently deleted)

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |
| 404 | `RECORD_NOT_FOUND` | "Record not found" | Record ID does not exist or is inaccessible |

## Example Usage

### Get Active Record

```bash
curl -X GET http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "trashed_at": null,
    "deleted_at": null
  }
}
```

### Get Trashed Record

```bash
curl -X GET "http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000?include_trashed=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response includes record with trashed_at set:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": null
  }
}
```

### Get Permanently Deleted Record (Root Only)

```bash
curl -X GET "http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000?include_deleted=true" \
  -H "Authorization: Bearer ROOT_JWT_TOKEN"
```

**Response includes record with deleted_at set:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "trashed_at": "2024-01-15T12:00:00Z",
    "deleted_at": "2024-01-15T12:00:00Z"
  }
}
```

## Response Transformation Examples

### Unwrap Response Envelope

```bash
curl -X GET "http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000?unwrap" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (unwrapped):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "John Doe",
  "email": "john@example.com",
  "department": "Engineering",
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z",
  "trashed_at": null,
  "deleted_at": null
}
```

### Select Specific Fields

```bash
curl -X GET "http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000?select=id,name,email" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (unwrapped with only selected fields):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "John Doe",
  "email": "john@example.com"
}
```

### Exclude Timestamps

```bash
curl -X GET "http://localhost:9001/api/data/users/550e8400-e29b-41d4-a716-446655440000?stat=false" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (without timestamp fields):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Doe",
    "email": "john@example.com",
    "department": "Engineering"
  }
}
```

## Use Cases

### Detail Page Data Loading

```javascript
async function loadUserDetails(userId) {
  const response = await fetch(`/api/data/users/${userId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: user } = await response.json();
  return user;
}
```

### Edit Form Initialization

```javascript
async function initializeEditForm(userId) {
  // Get current record state
  const response = await fetch(`/api/data/users/${userId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const { data: user } = await response.json();

  // Populate form fields
  document.getElementById('name').value = user.name;
  document.getElementById('email').value = user.email;
  document.getElementById('department').value = user.department;
}
```

### Checking Deletion State

```javascript
async function checkRecordStatus(userId) {
  const response = await fetch(`/api/data/users/${userId}?include_trashed=true`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (response.status === 404) {
    return 'not_found';
  }

  const { data: user } = await response.json();

  if (user.deleted_at) {
    return 'permanently_deleted';
  } else if (user.trashed_at) {
    return 'trashed';
  } else {
    return 'active';
  }
}
```

## Record Not Found Behavior

By default, this endpoint returns **404 RECORD_NOT_FOUND** if:
- Record ID does not exist in the database
- Record is soft-deleted (trashed_at is set) and `include_trashed=true` is not specified
- Record is permanently deleted (deleted_at is set) and `include_deleted=true` is not specified
- User lacks read permissions (based on ACLs)

To retrieve trashed or deleted records, use the appropriate query parameters.

## ACL Filtering

This endpoint respects Access Control Lists (ACLs):
- Only returns records where user has read access (`access_read` includes user or group)
- Returns 404 if user lacks read permission (does not reveal record existence)
- Root users bypass ACL checks

## Model Protection

This endpoint respects model-level protection:

- **Frozen models** (`frozen=true`): Read operations are **allowed**
- **Sudo-protected models** (`sudo=true`): No special requirements for read operations
- **Immutable models/fields**: No restrictions on read operations

## Related Endpoints

- [`PUT /api/data/:model/:record`](PUT.md) - Update single record
- [`DELETE /api/data/:model/:record`](DELETE.md) - Delete single record
- [`GET /api/data/:model`](../:model/GET.md) - Query all records in model
- [`POST /api/find/:model`](../../find/:model/POST.md) - Advanced queries with filtering
