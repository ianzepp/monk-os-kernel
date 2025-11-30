# 39-Stat API Documentation

> **Record Metadata Access Without User Data**
>
> The Stat API provides efficient access to record system metadata (timestamps, entity tags, size) without fetching the full record data. This enables cache invalidation, modification tracking, and lightweight existence checks.

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Core Endpoint](#core-endpoint)
4. [Response Format](#response-format)
5. [Use Cases](#use-cases)
6. [Error Handling](#error-handling)
7. [Performance Considerations](#performance-considerations)
8. [Related APIs](#related-apis)

## Overview

The Stat API returns only system metadata fields for database records, excluding all user data. This provides a lightweight alternative to the Data API when only metadata is needed.

### Key Capabilities
- **Metadata-only access**: Get timestamps and metadata without fetching record data
- **Cache invalidation**: Check `updated_at` to determine if cached data is stale
- **Existence checks**: Verify records exist without retrieving full data
- **Bandwidth optimization**: Minimal response size for metadata queries
- **Soft delete detection**: Check `trashed_at` status

### Base URL
```
GET /api/stat/:model/:record
```

## Authentication

All Stat API endpoints require valid JWT authentication. The API respects tenant isolation and record-level permissions.

```bash
Authorization: Bearer <jwt>
```

### Required Permissions
- **Stat Access**: Same `read_data` permission as Data API GET operations
- **ACL Enforcement**: Record ACL permissions are checked before returning metadata

## Core Endpoint

### GET /api/stat/:model/:record

Retrieves system metadata for a specific record without fetching user data.

**Request:**
```bash
GET /api/stat/users/user-123
Authorization: Bearer <jwt>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "user-123",
    "created_at": "2025-01-01T12:00:00.000Z",
    "updated_at": "2025-01-15T09:30:00.000Z",
    "trashed_at": null,
    "etag": "user-123",
    "size": 0
  }
}
```

## Response Format

### Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Record identifier (UUID or custom ID) |
| `created_at` | string | ISO 8601 timestamp when record was created |
| `updated_at` | string | ISO 8601 timestamp when record was last modified |
| `trashed_at` | string \| null | ISO 8601 timestamp when record was soft-deleted (null if active) |
| `etag` | string | Entity tag for HTTP caching (currently uses record ID) |
| `size` | number | Record size in bytes (currently 0, TODO: implementation pending) |

### Field Details

**`id`**
- Record's unique identifier
- Matches the `:record` parameter in the request URL
- Useful for confirmation in batch operations

**`created_at`**
- Timestamp when record was initially created
- Never changes after creation
- Useful for audit trails and chronological sorting

**`updated_at`**
- Timestamp of last modification to record
- Updates on any field change (user data or system fields)
- Primary field for cache invalidation logic

**`trashed_at`**
- Non-null indicates soft-deleted record
- Soft-deleted records are accessible by ID but excluded from list operations
- Useful for trash/restore workflows

**`etag`**
- Entity tag for HTTP caching and conditional requests
- Currently uses record ID
- Future versions may use content hash for proper ETag semantics

**`size`**
- Record size in bytes
- Currently returns 0 (implementation pending)
- When implemented, will return size of user data only (excluding system fields)
- Useful for storage quota tracking and bandwidth estimation

## Use Cases

### Cache Invalidation

Check if cached data is stale without fetching the full record:

```bash
# Get metadata
GET /api/stat/users/user-123
→ {"data": {"id": "user-123", "updated_at": "2025-01-15T10:00:00Z", ...}}

# Compare with cached timestamp
if (cached_updated_at < metadata.updated_at) {
    // Cache is stale, fetch fresh data
    GET /api/data/users/user-123
}
```

### Existence Checks

Verify a record exists before performing operations:

```bash
# Check if record exists
GET /api/stat/users/user-123
→ 200 OK: Record exists
→ 404 Not Found: Record doesn't exist

# Proceed with operation if exists
if (stat_response.success) {
    DELETE /api/data/users/user-123
}
```

### Modification Tracking

Monitor when records change for sync operations:

```bash
# Poll for changes
GET /api/stat/documents/doc-456
→ {"data": {"updated_at": "2025-01-15T09:30:00Z", ...}}

# Compare with last sync timestamp
if (metadata.updated_at > last_sync_time) {
    // Record was modified, sync it
    GET /api/data/documents/doc-456
}
```

### Soft Delete Detection

Check if a record is soft-deleted without fetching data:

```bash
# Check deletion status
GET /api/stat/accounts/account-789
→ {"data": {"trashed_at": "2025-01-14T16:20:00Z", ...}}

# Record is soft-deleted, show restore option
if (metadata.trashed_at !== null) {
    showRestoreButton();
}
```

### Batch Metadata Checks

Check metadata for multiple records efficiently:

```bash
# Check multiple records (sequential requests)
for record_id in record_ids:
    GET /api/stat/users/${record_id}
    # Process metadata only (no full data transfer)
```

**Note:** Parallel batch stat operations are not currently supported. For bulk metadata needs, consider using the Data API with `?stat=true&access=false` to get minimal data.

## Error Handling

### Common Error Responses

#### Record Not Found

```json
{
  "success": false,
  "error": "Record user-999999 not found in model users",
  "error_code": "RECORD_NOT_FOUND"
}
```

**HTTP Status:** 404 Not Found

**Causes:**
- Record ID doesn't exist
- Record belongs to different tenant
- Typo in model or record ID

#### Model Not Found

```json
{
  "success": false,
  "error": "Model 'invalid_model' not found",
  "error_code": "MODEL_NOT_FOUND"
}
```

**HTTP Status:** 404 Not Found

**Causes:**
- Model doesn't exist in tenant database
- Typo in model name
- Model was deleted

#### Permission Denied

```json
{
  "success": false,
  "error": "Insufficient permissions to access record",
  "error_code": "PERMISSION_DENIED"
}
```

**HTTP Status:** 403 Forbidden

**Causes:**
- User lacks `read_data` permission
- Record ACLs deny access to user
- User not in `access_read`, `access_edit`, or `access_full` arrays

#### Unauthorized

```json
{
  "success": false,
  "error": "Missing or invalid authentication token",
  "error_code": "UNAUTHORIZED"
}
```

**HTTP Status:** 401 Unauthorized

**Causes:**
- No `Authorization` header provided
- JWT token expired
- Invalid token signature

## Performance Considerations

### Database Impact

**Current Implementation:**
- Executes `SELECT * FROM table WHERE id = :id`
- Fetches all fields from database
- Filters to metadata fields in application layer

**Performance:**
- Single record lookup by primary key (very fast)
- Indexed ID lookup (typically <1ms)
- No table scans or complex queries

**Future Optimization:**
- Could optimize to `SELECT id, created_at, updated_at, trashed_at FROM table WHERE id = :id`
- Would reduce I/O for records with large user data fields
- Currently not implemented to maintain code simplicity

### Network Impact

**Bandwidth Comparison:**

```
Full Data API Response (typical user):
{
  "id": "user-123",
  "name": "John Doe",
  "email": "john@example.com",
  "profile": {...},  // Large nested object
  "access_read": [...],  // ACL arrays
  "access_edit": [...],
  "created_at": "...",
  "updated_at": "..."
}
→ ~800-1500 bytes

Stat API Response:
{
  "id": "user-123",
  "created_at": "...",
  "updated_at": "...",
  "trashed_at": null,
  "etag": "user-123",
  "size": 0
}
→ ~200-250 bytes

Savings: 70-85% reduction in response size
```

### When to Use Stat vs Data API

**Use Stat API when:**
- Checking if record was modified (cache invalidation)
- Verifying record existence
- Monitoring soft-delete status
- Polling for changes in sync loops
- Checking timestamps for audit purposes

**Use Data API when:**
- You need any user data fields
- Fetching records for display
- Performing updates or deletes (need current data)
- Working with relationships
- Applying complex filters (use Find API with `?stat=true&access=false`)

**Don't use Stat API when:**
- You'll immediately fetch the full record anyway (makes two round trips)
- You need to filter by user data fields (use Find API)
- You need ACL information (use ACLs API or Data API)

## Related APIs

### Data API

**GET /api/data/:model/:record**

Returns full record including user data and system fields:

```bash
GET /api/data/users/user-123
→ {id, name, email, ..., created_at, updated_at, access_*, ...}
```

**Query Parameters:**
- `?stat=false` - Exclude timestamp fields
- `?access=false` - Exclude ACL fields

See: [32-Data API Documentation](32-data-api.md)

### File API

**POST /api/file/stat**

Filesystem-style stat operation with filesystem metadata:

```bash
POST /api/file/stat
{"path": "/data/users/user-123"}
→ {file_metadata: {type, permissions, size, modified_time, ...}}
```

Returns filesystem-specific metadata (type, permissions, modified_time) rather than database metadata.

See: [37-File API Documentation](37-file-api.md)

### ACLs API

**GET /api/acls/:model/:record**

Returns only ACL metadata (access control lists):

```bash
GET /api/acls/users/user-123
→ {access_read: [...], access_edit: [...], access_full: [...], access_deny: [...]}
```

Use for managing permissions without fetching data or timestamps.

See: [38-ACLs API Documentation](38-acls-api.md)

### Find API with Filtering

**POST /api/find/:model**

Search with metadata-only responses:

```bash
POST /api/find/users
{
  "where": {"status": "active"},
  "limit": 100
}

# With query parameters:
GET /api/find/users?stat=true&access=false
→ Returns only id + timestamps for filtered records
```

Use for bulk metadata queries with filtering.

See: [33-Find API Documentation](33-find-api.md)

---

**Next: [40-Docs API Documentation](40-docs-api.md)** - API documentation access

**Previous: [38-ACLs API Documentation](38-acls-api.md)** - Access control lists management
