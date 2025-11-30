# Trashed API

The Trashed API provides dedicated endpoints for managing soft-deleted (trashed) records. Use these endpoints to list, view, restore, or permanently delete trashed records.

## Base URL

```
/api/trashed
```

## Endpoints

### List All Trashed Records

```http
GET /api/trashed
```

Returns all trashed records across all models, organized by model name.

**Response:**
```json
{
  "success": true,
  "data": {
    "users": [
      { "id": "uuid-1", "name": "John", "trashed_at": "2024-01-15T10:30:00Z" }
    ],
    "posts": [
      { "id": "uuid-2", "title": "Draft", "trashed_at": "2024-01-14T09:00:00Z" }
    ]
  }
}
```

### List Trashed Records for Model

```http
GET /api/trashed/:model
```

Returns all trashed records for a specific model.

**Example:**
```http
GET /api/trashed/posts
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "uuid-1", "title": "Draft Post", "trashed_at": "2024-01-15T10:30:00Z" },
    { "id": "uuid-2", "title": "Old Post", "trashed_at": "2024-01-14T09:00:00Z" }
  ]
}
```

### Get Specific Trashed Record

```http
GET /api/trashed/:model/:id
```

Returns a specific trashed record. Returns 404 if the record doesn't exist or isn't trashed.

**Example:**
```http
GET /api/trashed/posts/uuid-1
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid-1",
    "title": "Draft Post",
    "content": "...",
    "trashed_at": "2024-01-15T10:30:00Z"
  }
}
```

### Restore Single Record

```http
POST /api/trashed/:model/:id
```

Restores a trashed record by setting `trashed_at` to null.

**Example:**
```http
POST /api/trashed/posts/uuid-1
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid-1",
    "title": "Draft Post",
    "trashed_at": null
  }
}
```

### Restore Multiple Records

```http
POST /api/trashed/:model
```

Restores multiple trashed records. Body should be an array of record IDs.

**Example:**
```http
POST /api/trashed/posts
Content-Type: application/json

["uuid-1", "uuid-2", "uuid-3"]
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "uuid-1", "title": "Post 1", "trashed_at": null },
    { "id": "uuid-2", "title": "Post 2", "trashed_at": null },
    { "id": "uuid-3", "title": "Post 3", "trashed_at": null }
  ]
}
```

### Permanently Delete Single Record

```http
DELETE /api/trashed/:model/:id
```

Permanently deletes a trashed record by setting `deleted_at`. This action is **irreversible**.

**Example:**
```http
DELETE /api/trashed/posts/uuid-1
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid-1",
    "title": "Draft Post",
    "deleted_at": "2024-01-16T12:00:00Z"
  }
}
```

### Permanently Delete Multiple Records

```http
DELETE /api/trashed/:model
```

Permanently deletes multiple trashed records. Body should be an array of record IDs. This action is **irreversible**.

**Example:**
```http
DELETE /api/trashed/posts
Content-Type: application/json

["uuid-1", "uuid-2", "uuid-3"]
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "uuid-1", "deleted_at": "2024-01-16T12:00:00Z" },
    { "id": "uuid-2", "deleted_at": "2024-01-16T12:00:00Z" },
    { "id": "uuid-3", "deleted_at": "2024-01-16T12:00:00Z" }
  ]
}
```

## Soft Delete vs Permanent Delete

| Field | Description |
|-------|-------------|
| `trashed_at` | Soft delete timestamp. Record is hidden from normal queries but can be restored. |
| `deleted_at` | Permanent delete timestamp. Record is kept for audit/compliance but never visible via API. |

## Migration from Query Parameters

Previously, trashed records were accessed using `?include_trashed=true` or `?trashed=only` query parameters on Data API endpoints. These have been replaced by this dedicated Trashed API.

**Old way (deprecated):**
```http
GET /api/data/posts?include_trashed=true
PATCH /api/data/posts?include_trashed=true
```

**New way:**
```http
GET /api/trashed/posts
POST /api/trashed/posts
```

## Using Trashed with Find API

The Find API still supports querying trashed records via the request body (not URL parameters):

```http
POST /api/find/posts
Content-Type: application/json

{
  "trashed": "include",
  "where": { "status": "draft" }
}
```

Valid `trashed` values:
- `"exclude"` (default) - Only show active records
- `"include"` - Show both active and trashed records
- `"only"` - Show only trashed records (same as GET /api/trashed/:model)
