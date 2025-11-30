# ACLs API

The ACLs API provides sudo control over record-level access permissions. It allows administrators and root users to manage the four access control arrays that determine user permissions for specific records.

## Overview

Each record contains four access control arrays:
- `access_read`: User IDs with read access
- `access_edit`: User IDs with edit access  
- `access_full`: User IDs with full access (read/edit/delete)
- `access_deny`: User IDs with denied access (overrides other permissions)

## Authentication Requirements

All ACLs API operations require:
- Valid JWT authentication
- Admin or root level privileges
- Target record must exist in the specified model

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| GET | [`/api/acls/:model/:record`](#get-apiaclsmodelrecord) | Retrieve the effective ACL arrays for a specific record. |
| POST | [`/api/acls/:model/:record`](#post-apiaclsmodelrecord) | Merge additional user IDs into the existing ACL arrays. |
| PUT | [`/api/acls/:model/:record`](#put-apiaclsmodelrecord) | Replace all ACL arrays in a single operation, overwriting prior values. |
| DELETE | [`/api/acls/:model/:record`](#delete-apiaclsmodelrecord) | Reset all ACL arrays so the record falls back to role-based defaults. |

## GET /api/acls/:model/:record

Return the explicit ACL arrays for a record so clients can display or audit who can read, edit, fully manage, or is denied access. The response mirrors the exact lists stored alongside the record, making it easy to compare with default role-based permissions.

### Example

```bash
curl -X GET http://localhost:9001/api/acls/users/123e4567-e89b-12d3-a456-426614174000 \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "record_id": "123e4567-e89b-12d3-a456-426614174000",
    "model": "users",
    "access_lists": {
      "access_read": ["11111111-2222-3333-4444-555555555551", "22222222-3333-4444-5555-666666666662"],
      "access_edit": ["33333333-4444-5555-6666-777777777773"],
      "access_full": ["44444444-5555-6666-7777-888888888884"],
      "access_deny": []
    }
  }
}
```

## POST /api/acls/:model/:record

Merge one or more user IDs into the ACL arrays without disturbing existing entries. Use this endpoint to append additional readers, editors, or deny rules while preserving the rest of the lists.

### Example

```bash
curl -X POST http://localhost:9001/api/acls/users/123e4567-e89b-12d3-a456-426614174000 \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "access_read": ["55555555-6666-7777-8888-999999999995", "66666666-7777-8888-9999-aaaaaaaaaaa6"],
    "access_edit": ["77777777-8888-9999-aaaa-bbbbbbbbbb7"]
  }'
```

## PUT /api/acls/:model/:record

Replace the entire set of ACL arrays in a single request. This is useful when syncing permissions from another system or when you need to ensure the record matches an authoritative list without stale entries lingering.

### Example

```bash
curl -X PUT http://localhost:9001/api/acls/users/123e4567-e89b-12d3-a456-426614174000 \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "access_read": ["11111111-2222-3333-4444-555555555551"],
    "access_edit": ["33333333-4444-5555-6666-777777777773"],
    "access_full": ["44444444-5555-6666-7777-888888888884"],
    "access_deny": ["88888888-9999-aaaa-bbbb-cccccccccc8"]
  }'
```

## DELETE /api/acls/:model/:record

Clear every ACL array so the record reverts to the model's default role permissions. This is the fastest way to undo manual ACL tweaks and let the standard access tiers govern the record again.

### Example

```bash
curl -X DELETE http://localhost:9001/api/acls/users/123e4567-e89b-12d3-a456-426614174000 \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "record_id": "123e4567-e89b-12d3-a456-426614174000",
    "model": "users",
    "status": "default_permissions",
    "access_lists": {
      "access_read": [],
      "access_edit": [],
      "access_full": [],
      "access_deny": []
    }
  }
}
```

## Permission Logic

When ACL arrays are empty (`[]`), the record uses default role-based permissions from the user's authenticated role. When ACL arrays contain user IDs, they explicitly control access:

1. **access_deny** takes precedence - users in this array are always denied
2. **access_full** grants read, edit, and delete permissions
3. **access_edit** grants read and edit permissions  
4. **access_read** grants read-only permissions
5. Empty arrays fall back to role-based permissions

## Error Handling

- `400 Bad Request`: Invalid request format or ACL structure
- `401 Unauthorized`: Missing or invalid authentication
- `403 Forbidden`: Insufficient privileges (requires admin/root)
- `404 Not Found`: Model or record not found
- `500 Internal Server Error`: Database or system error

## Security Notes

- Only full and root users can modify ACLs
- User IDs in ACL arrays must be valid UUID format strings
- Duplicate user IDs are automatically removed
- ACL changes take effect immediately
- Always validate user IDs exist before adding to ACL lists
