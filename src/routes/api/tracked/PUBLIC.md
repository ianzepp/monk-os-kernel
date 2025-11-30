# Tracked API

The Tracked API provides access to audit trails for tracked field changes. When fields are marked with `tracked=true`, all create, update, and delete operations are captured with field-level deltas, user attribution, and timestamps.

## Overview

Change tracking is field-level and opt-in. Only changes to fields explicitly marked as tracked are recorded. This provides granular audit trails for sensitive data without the overhead of tracking all changes to all fields.

### Key Features
- **Field-level tracking**: Mark specific fields as `tracked=true` to enable tracking
- **Field-level deltas**: Stores old and new values for each changed field
- **Operation types**: Captures create, update, and delete operations
- **User attribution**: Records which user made each change
- **Chronological ordering**: Auto-incrementing `change_id` for simple time-series queries

## Authentication Requirements

All Tracked API operations require:
- Valid JWT authentication
- Read access to the underlying record (same permissions as Data API GET)
- Target record must exist in the specified model

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| GET | [`/api/tracked/:model/:record`](#get-apitrackedmodelrecord) | List all tracked entries for a record (newest first). |
| GET | [`/api/tracked/:model/:record/:change`](#get-apitrackedmodelrecordchange) | Get a specific tracked entry by change_id. |

## GET /api/tracked/:model/:record

Retrieve all tracked entries for a specific record, ordered by `change_id` descending (newest first). Supports pagination via query parameters.

### Example

```bash
curl -X GET http://localhost:9001/api/tracked/account/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Query Parameters:**
- `?limit=N` - Limit number of results
- `?offset=N` - Skip first N results for pagination

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "hist-uuid-1",
      "change_id": 42,
      "model_name": "account",
      "record_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "operation": "update",
      "changes": {
        "email": {
          "old": "john@example.com",
          "new": "john.doe@example.com"
        }
      },
      "created_by": "user-uuid-789",
      "created_at": "2025-01-15T14:30:00.000Z",
      "request_id": "req_abc123",
      "metadata": {
        "user_role": "full"
      }
    },
    {
      "id": "hist-uuid-2",
      "change_id": 41,
      "model_name": "account",
      "record_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "operation": "create",
      "changes": {
        "email": {
          "old": null,
          "new": "john@example.com"
        },
        "name": {
          "old": null,
          "new": "John Doe"
        }
      },
      "created_by": "user-uuid-123",
      "created_at": "2025-01-10T09:00:00.000Z",
      "request_id": "req_xyz789",
      "metadata": null
    }
  ]
}
```

## GET /api/tracked/:model/:record/:change

Retrieve a specific tracked entry by its `change_id`. Use this to get details about a particular change event.

### Example

```bash
curl -X GET http://localhost:9001/api/tracked/account/a1b2c3d4-e5f6-7890-abcd-ef1234567890/42 \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "hist-uuid-1",
    "change_id": 42,
    "model_name": "account",
    "record_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "operation": "update",
    "changes": {
      "email": {
        "old": "john@example.com",
        "new": "john.doe@example.com"
      }
    },
    "created_by": "user-uuid-789",
    "created_at": "2025-01-15T14:30:00.000Z",
    "request_id": "req_abc123",
    "metadata": {
      "user_role": "full",
      "user_tenant": "acme"
    }
  }
}
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the tracked record |
| `change_id` | number | Auto-incrementing sequence number (higher = newer) |
| `model_name` | string | Model containing the changed record |
| `record_id` | string | ID of the record that was modified |
| `operation` | string | Operation type: `create`, `update`, or `delete` |
| `changes` | object | Field-level deltas with old and new values |
| `created_by` | string\|null | UUID of user who made the change |
| `created_at` | string | ISO 8601 timestamp when change was recorded |
| `request_id` | string\|null | Request correlation ID |
| `metadata` | object\|null | Additional context (user role, tenant, etc.) |

## Change Delta Format

The `changes` object contains field-level deltas for tracked fields:

### Create Operation
```json
{
  "email": {
    "old": null,
    "new": "john@example.com"
  }
}
```

### Update Operation
```json
{
  "email": {
    "old": "john@example.com",
    "new": "john.doe@example.com"
  }
}
```

**Note:** Only fields that actually changed are included in the changes object.

### Delete Operation
```json
{
  "email": {
    "old": "john.doe@example.com",
    "new": null
  }
}
```

## Configuring Tracking

To enable history tracking for a field, mark it with `tracked=true` using the Describe API:

```bash
curl -X PUT http://localhost:9001/api/describe/account/fields/email \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tracked": true}'
```

After marking fields as tracked, any create, update, or delete operations on those fields will automatically generate tracked records.

## Common Use Cases

### Audit Compliance
Track changes to sensitive fields for regulatory requirements (HIPAA, SOX, GDPR):
```bash
# Mark sensitive fields as tracked
PUT /api/describe/medical_records/fields/ssn {"tracked": true}
PUT /api/describe/medical_records/fields/diagnosis {"tracked": true}

# Query audit trail
GET /api/tracked/medical_records/patient-123
```

### Data Recovery
Retrieve previous values after accidental changes:
```bash
# Get history to find old value
GET /api/tracked/account/account-456
→ Find change with correct old value

# Restore old value
PUT /api/data/account/account-456
{"email": "<old_value_from_history>"}
```

### Change Attribution
Identify who made specific changes:
```bash
# Get history
GET /api/tracked/contracts/contract-789

# Find user who changed payment_amount
→ created_by: "user-uuid-456"

# Get user details
GET /api/data/users/user-uuid-456
```

## Error Handling

- `400 Bad Request`: Invalid request format
- `401 Unauthorized`: Missing or invalid authentication
- `403 Forbidden`: Insufficient permissions to access record
- `404 Not Found`: Model, record, or change_id not found
- `500 Internal Server Error`: Database or system error

## Performance Notes

- Tracked queries use indexed lookups (very fast)
- Only tracked fields consume history storage
- Empty changes (no tracked fields modified) don't create tracked records
- Pagination recommended for records with many tracked entries

## Security Notes

- Tracked access respects record-level ACLs
- Only users who can read a record can view its history
- History records cannot be modified or deleted via API
- User attribution based on JWT token at operation time
- System operations may have `created_by=null`
