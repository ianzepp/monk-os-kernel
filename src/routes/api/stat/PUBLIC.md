# Stat API

Get record metadata without fetching full record data.

## GET /api/stat/:model/:record

Returns only system metadata fields (timestamps, etag, size) for a specific record.

### Request
```
GET /api/stat/users/user-123
Authorization: Bearer <jwt>
```

### Response
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

### Use Cases

- **Cache invalidation**: Check `updated_at` without fetching full record
- **Existence checks**: Verify record exists and get basic metadata
- **Modification tracking**: Monitor when records change for sync operations
- **Soft delete status**: Check `trashed_at` to see if record is deleted

### Fields

- `id`: Record identifier
- `created_at`: ISO 8601 timestamp when record was created
- `updated_at`: ISO 8601 timestamp when record was last modified
- `trashed_at`: ISO 8601 timestamp when record was soft-deleted (null if active)
- `etag`: Entity tag for HTTP caching (currently uses record ID)
- `size`: Record size in bytes (currently 0, TODO: implement)

### Errors

- **404 Not Found**: Record does not exist in the specified model
- **401 Unauthorized**: Missing or invalid authentication token
- **403 Forbidden**: Insufficient permissions to access the model

### Related Endpoints

- `GET /api/data/:model/:record` - Get full record with user data
- `POST /api/file/stat` - Filesystem-style stat operation
- `GET /api/acls/:model/:record` - Get ACL metadata

### Notes

- The `size` field currently returns 0 and is marked for future implementation
- The `etag` field uses the record ID; future versions may use a content hash
- Soft-deleted records (with `trashed_at` set) are still accessible via stat
- This endpoint respects the same ACL permissions as the Data API

See [docs/39-stat-api.md](../../docs/39-stat-api.md) for complete documentation.
