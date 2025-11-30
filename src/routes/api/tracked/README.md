# 42-Tracked API Documentation

> **Change Tracking and Audit Trails for Field-Level Modifications**
>
> The Tracked API provides access to tracked changes for database records. When fields are marked with `tracked=true`, all create, update, and delete operations are captured with field-level deltas, timestamps, and user attribution.

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Core Endpoints](#core-endpoints)
4. [Configuring Tracking](#configuring-tracking)
5. [Response Format](#response-format)
6. [Change Delta Format](#change-delta-format)
7. [Use Cases](#use-cases)
8. [Error Handling](#error-handling)
9. [Performance Considerations](#performance-considerations)
10. [Related APIs](#related-apis)

## Overview

The Tracked API enables audit trails and change tracking for sensitive data fields. Rather than tracking all changes to all records, tracking is opt-in per field using the `tracked` flag on field definitions.

### Key Capabilities
- **Field-level tracking**: Only track changes to specific fields marked with `tracked=true`
- **Field-level deltas**: Stores old and new values for changed fields
- **Operation tracking**: Captures create, update, and delete operations
- **User attribution**: Records which user made each change
- **Chronological ordering**: Auto-incrementing `change_id` for simple time-series queries
- **Minimal overhead**: Only tracked fields consume tracked storage

### Base URLs
```
GET /api/tracked/:model/:record           # List all changes for a record
GET /api/tracked/:model/:record/:change   # Get specific change by ID
```

## Authentication

All Tracked API endpoints require valid JWT authentication. The API respects tenant isolation and record-level permissions.

```bash
Authorization: Bearer <jwt>
```

### Required Permissions
- **Tracked Access**: Same `read_data` permission as Data API GET operations
- **ACL Enforcement**: Record ACL permissions are checked before returning history
- **Tracked Fields Only**: Only changes to tracked fields are returned

## Core Endpoints

### GET /api/tracked/:model/:record

Retrieves all tracked entries for a specific record, ordered by `change_id` descending (newest first).

**Request:**
```bash
GET /api/tracked/account/a1b2c3d4-e5f6-7890-abcd-ef1234567890
Authorization: Bearer <jwt>
```

**Query Parameters:**
- `?limit=N` - Limit number of results (default: based on configuration)
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
        "user_role": "full",
        "user_tenant": "acme"
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

### GET /api/tracked/:model/:record/:change

Retrieves a specific tracked entry by its `change_id`.

**Request:**
```bash
GET /api/tracked/account/a1b2c3d4-e5f6-7890-abcd-ef1234567890/42
Authorization: Bearer <jwt>
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

## Configuring Tracking

### Marking Fields as Tracked

To enable change tracking for a field, set `tracked=true` on the field definition:

**Using Describe API:**
```bash
# Mark email field as tracked
PUT /api/describe/account/fields/email
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "tracked": true
}
```

**Using SQL:**
```sql
-- Mark specific fields as tracked
UPDATE fields
SET tracked = true
WHERE model_name = 'account'
  AND field_name IN ('email', 'name', 'balance');
```

### Model Cache Invalidation

After updating field tracking settings, the model cache automatically invalidates to ensure observers see the updated configuration immediately.

### What Gets Tracked

**Tracked:**
- Fields with `tracked=true` flag
- Create operations: Records `old=null`, `new=<value>` for tracked fields
- Update operations: Records `old=<previous>`, `new=<current>` for changed tracked fields
- Delete operations: Records `old=<value>`, `new=null` for tracked fields

**Not Tracked:**
- System models (models, fields, users, history)
- Fields with `tracked=false` (default)
- System fields (id, created_at, updated_at, etc.) unless explicitly marked tracked
- Untracked fields in tracked models

## Response Format

### History Record Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the tracked record (UUID) |
| `change_id` | number | Auto-incrementing sequence number for chronological ordering |
| `model_name` | string | Name of the model containing the changed record |
| `record_id` | string | ID of the record that was modified |
| `operation` | string | Type of operation: `create`, `update`, or `delete` |
| `changes` | object | JSONB object containing field-level deltas (see below) |
| `created_by` | string\|null | UUID of user who made the change (null for system operations) |
| `created_at` | string | ISO 8601 timestamp when change was recorded |
| `request_id` | string\|null | Request correlation ID for tracing |
| `metadata` | object\|null | Additional context (user role, tenant, etc.) |

### Field Details

**`change_id`**
- Auto-incrementing integer sequence
- Globally unique across all tracked records
- Provides simple chronological ordering
- Higher numbers = more recent changes
- Never reused, even if tracked records are deleted

**`operation`**
- `"create"`: Record was initially created
- `"update"`: Record was modified
- `"delete"`: Record was deleted (soft or hard)

**`created_by`**
- UUID of the authenticated user who performed the operation
- Extracted from JWT token at operation time
- `null` for system-initiated operations or if user context unavailable

**`request_id`**
- Correlation ID from the request that triggered the change
- Useful for tracing a change back to the originating API call
- May be `null` for operations without request context

**`metadata`**
- Additional contextual information
- Current implementation includes: `user_role`, `user_tenant`
- Future: May include IP address, user agent, or custom audit fields
- `null` if no metadata available

## Change Delta Format

The `changes` field is a JSONB object where each key is a tracked field name, and the value is an object with `old` and `new` properties:

### Create Operation
```json
{
  "email": {
    "old": null,
    "new": "john@example.com"
  },
  "name": {
    "old": null,
    "new": "John Doe"
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

**Note:** Only fields that actually changed are included. If a tracked field wasn't modified in an update, it won't appear in the changes object.

### Delete Operation
```json
{
  "email": {
    "old": "john.doe@example.com",
    "new": null
  },
  "name": {
    "old": "John Doe",
    "new": null
  }
}
```

### Empty Changes

If an update operation doesn't modify any tracked fields, no tracked record is created. Only changes to tracked fields trigger tracked recording.

## Use Cases

### Audit Compliance

Track changes to sensitive fields for regulatory compliance:

```bash
# Mark sensitive fields as tracked
PUT /api/describe/medical_records/fields/ssn {"tracked": true}
PUT /api/describe/medical_records/fields/diagnosis {"tracked": true}

# Query audit trail for specific record
GET /api/tracked/medical_records/patient-123
→ Shows all changes to SSN and diagnosis fields with user attribution
```

### Data Recovery

Retrieve previous values after accidental changes:

```bash
# Get history for accidentally modified record
GET /api/tracked/account/account-456

# Find the change that modified email
→ {
  "change_id": 89,
  "changes": {
    "email": {
      "old": "correct@email.com",
      "new": "wrong@email.com"
    }
  }
}

# Manually restore old value
PUT /api/data/account/account-456
{"email": "correct@email.com"}
```

### Change Attribution

Identify who made specific changes and when:

```bash
# Get history for disputed record
GET /api/tracked/contracts/contract-789

# Find who changed payment_amount
→ {
  "change_id": 142,
  "operation": "update",
  "changes": {
    "payment_amount": {
      "old": 1000,
      "new": 5000
    }
  },
  "created_by": "user-uuid-456",
  "created_at": "2025-01-10T15:45:00Z"
}

# Cross-reference with user records
GET /api/data/users/user-uuid-456
→ {"name": "Jane Smith", "email": "jane@acme.com"}
```

### Compliance Reporting

Generate audit reports for regulatory requirements:

```bash
# Get all changes to financial records in date range
GET /api/tracked/transactions/txn-123

# Filter to specific time period (client-side)
history_entries
  .filter(entry =>
    entry.created_at >= '2025-01-01' &&
    entry.created_at < '2025-02-01'
  )
  .map(entry => ({
    date: entry.created_at,
    user: entry.created_by,
    field: Object.keys(entry.changes)[0],
    old_value: entry.changes[field].old,
    new_value: entry.changes[field].new
  }))
```

### Monitoring Field Changes

Track how often specific fields change:

```bash
# Get all history for record
GET /api/tracked/products/product-555

# Analyze change frequency (client-side)
const emailChanges = history.filter(h =>
  h.changes.hasOwnProperty('email')
).length;

const priceChanges = history.filter(h =>
  h.changes.hasOwnProperty('price')
).length;

# Alert if price changed too frequently
if (priceChanges > 10) {
  alert('Price volatility detected');
}
```

## Error Handling

### Common Error Responses

#### Record Not Found

```json
{
  "success": false,
  "error": "Record account-999999 not found in model account",
  "error_code": "RECORD_NOT_FOUND"
}
```

**HTTP Status:** 404 Not Found

**Causes:**
- Record ID doesn't exist
- Record belongs to different tenant
- No tracked data exists for record (if no tracked fields or never modified)

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

#### Change Not Found

```json
{
  "success": false,
  "error": "History entry with change_id 999 not found for record",
  "error_code": "CHANGE_NOT_FOUND"
}
```

**HTTP Status:** 404 Not Found

**Causes:**
- change_id doesn't exist for this record
- change_id belongs to different record
- Tracked entry was deleted

#### Permission Denied

```json
{
  "success": false,
  "error": "Insufficient permissions to access record history",
  "error_code": "PERMISSION_DENIED"
}
```

**HTTP Status:** 403 Forbidden

**Causes:**
- User lacks `read_data` permission for the model
- Record ACLs deny access to user
- User cannot access the underlying record

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

**Tracked Recording:**
- Single INSERT per tracked change (Ring 7 observer)
- No transaction overhead (uses raw SQL to avoid observer recursion)
- Minimal impact: <1ms per tracked record insertion
- Asynchronous to main operation (won't slow down user-facing operations)

**Tracked Querying:**
- Composite index on `(model_name, record_id, change_id DESC)`
- Primary key index on `change_id` for direct lookups
- Timestamp index on `created_at` for all tracked records
- Typical query time: <5ms for single record history (dozens of entries)

### Storage Impact

**Per Tracked Record:**
```
Base overhead: ~200 bytes (UUID, change_id, timestamps, user_id)
Changes JSONB: ~50-200 bytes per tracked field change
Metadata JSONB: ~50-100 bytes if present
Total: ~300-500 bytes per change event
```

**Storage Estimates:**
- 1,000 changes: ~500 KB
- 100,000 changes: ~50 MB
- 1,000,000 changes: ~500 MB

**Retention Strategy:**
Not currently implemented. Future considerations:
- Archive old tracked data to separate table
- Delete tracked data older than N days
- Compress JSONB changes
- Partition by date range

### When to Use Tracked Fields

**Track fields when:**
- Regulatory compliance requires audit trails (HIPAA, SOX, GDPR)
- Sensitive data needs change attribution
- Dispute resolution requires historical values
- Data integrity investigations are common
- Field changes are infrequent but significant

**Don't track fields when:**
- Field changes very frequently (counters, timestamps, status flags)
- Changes aren't meaningful for audit purposes
- Storage costs outweigh audit value
- Field contains large binary data or documents
- Real-time change detection is needed (use webhooks instead)

### Optimization Tips

**Minimize Tracked Fields:**
- Only mark truly sensitive/auditable fields as tracked
- Review tracked fields periodically
- Don't track computed or derived fields

**Batch Tracked Queries:**
- Use pagination (`?limit=100&offset=0`) for large tracked sets
- Fetch in chronological order (change_id DESC) for recent changes
- Cache frequently accessed tracked data on client side

**Index Considerations:**
- Composite index on `(model_name, record_id, change_id)` is crucial
- Additional indexes on `created_by` if filtering by user is common
- Additional indexes on `created_at` if date-range queries are common

## Related APIs

### Data API

**PUT /api/data/:model/:record**

Updates that modify tracked fields automatically create tracked records:

```bash
PUT /api/data/account/user-123
{"email": "new@email.com"}
→ Updates record AND creates tracked entry for email change
```

See: [32-Data API Documentation](32-data-api.md)

### Describe API

**PUT /api/describe/:model/fields/:field**

Configure field tracking:

```bash
PUT /api/describe/account/fields/email
{"tracked": true}
→ Enables change tracking for email field
```

See: [31-Describe API Documentation](31-describe-api.md)

### ACLs API

**GET /api/acls/:model/:record**

Tracked access respects record-level ACLs. If a user can't read a record, they can't read its history:

```bash
GET /api/tracked/users/user-456
→ 403 Forbidden (if user lacks access_read for record)
```

See: [38-ACLs API Documentation](38-acls-api.md)

---

**Next:** TBD

**Previous: [39-Stat API Documentation](39-stat-api.md)** - Record metadata access
