# Bulk API

Execute multiple observer-aware operations across models in a single transaction.

## Base Path
All Bulk API requests use: `POST /api/bulk`

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | [`/api/bulk`](#post-apibulk) | Execute multiple model operations inside one transaction. |

## Content Type
- **Request**: `application/json`
- **Response**: `application/json`

## Authentication Required
Include a valid JWT bearer token. Authorization is evaluated per operation inside the bulk payload.

---

## POST /api/bulk

Submit an ordered list of operations—spanning CRUD actions, ACL updates, read helpers, and aggregations—and the platform will execute them sequentially inside a single transaction. Observer rings, validation, and auditing run for every operation just as they would through the individual endpoints.

### Request Body
```json
{
  "operations": [
    {
      "operation": "string",     // Required: supported operation (hyphen-case)
      "model": "string",        // Required: target model name
      "data": {},                 // Required for mutations (object or array depending on operation)
      "id": "string",            // Required for single-record operations
      "filter": {},               // Required for *-any variants, optional for read helpers
      "aggregate": {},            // Required for aggregate operations
      "groupBy": ["field"],      // Optional: string or string array for aggregate
      "message": "string"        // Optional: custom 404 message for *-404 variants
    }
  ]
}
```

### Success Response (200)
```json
{
  "success": true,
  "data": [
    {
      "operation": "create-all",
      "model": "users",
      "result": [{"id": "user_1", "name": "Ada"}, {"id": "user_2", "name": "Grace"}]
    },
    {
      "operation": "update-any",
      "model": "accounts",
      "result": [{"id": "acct_1", "status": "active"}]
    },
    {
      "operation": "aggregate",
      "model": "orders",
      "result": [{"status": "pending", "total_orders": 12}]
    }
  ]
}
```

## Supported Operations

### Read Helpers
| Operation | Description | Requirements |
|-----------|-------------|--------------|
| `select` / `select-all` | Return records matching an optional filter. | `model`, optional `filter` |
| `select-one` | Return a single record by `id` or filter. | `model`, `id` or `filter` |
| `select-404` | Same as `select-one` but raises 404 when missing. | `model`, `id` or `filter`, optional `message` |
| `count` | Return the count of records. | `model`, optional `filter` |
| `aggregate` | Run aggregations with optional grouping. | `model`, `aggregate`, optional `filter`/`where`, optional `groupBy` |

### Create
| Operation | Description | Requirements |
|-----------|-------------|--------------|
| `create` / `create-one` | Create a single record. | `model`, `data` (object) |
| `create-all` | Create multiple records. | `model`, `data` (array of objects) |

### Update
| Operation | Description | Requirements |
|-----------|-------------|--------------|
| `update` / `update-one` | Update a record by `id`. | `model`, `id`, `data` |
| `update-all` | Update explicit records by providing `{id, ...changes}` items. | `model`, `data` (array with `id`) |
| `update-any` | Update records matching a filter. | `model`, `filter`, `data` |
| `update-404` | Update a single record and raise 404 if missing. | `model`, `id` or `filter`, `data`, optional `message` |

### Delete (Soft Delete)
| Operation | Description | Requirements |
|-----------|-------------|--------------|
| `delete` / `delete-one` | Soft delete a record by `id`. | `model`, `id` |
| `delete-all` | Soft delete explicit records. | `model`, `data` (array with `id`) |
| `delete-any` | Soft delete records matching a filter. | `model`, `filter` |
| `delete-404` | Soft delete a single record and raise 404 if missing. | `model`, `id` or `filter`, optional `message` |

### Access Control
| Operation | Description | Requirements |
|-----------|-------------|--------------|
| `access` / `access-one` | Update ACL fields for a record. | `model`, `id`, `data` |
| `access-all` | Update ACL fields for specific IDs. | `model`, `data` (array with `id`) |
| `access-any` | Update ACL fields for records matching a filter. | `model`, `filter`, `data` |
| `access-404` | ACL update that raises 404 when missing. | `model`, `id` or `filter`, `data`, optional `message` |

### Upsert
| Operation | Description | Requirements |
|-----------|-------------|--------------|
| `upsert` / `upsert-one` | Insert or update a single record based on ID presence. | `model`, `data` (object) |
| `upsert-all` | Insert or update multiple records based on ID presence. | `model`, `data` (array of objects) |

### Unsupported
| Operation | Status |
|-----------|--------|
| `select-max` | Not implemented (returns empty array with warning) |

## Validation Rules
- `create-all`, `update-all`, `delete-all`, `access-all`, `upsert-all` require `data` to be an array. `update-all`, `delete-all`, `access-all` require each element to include an `id`. `upsert-all` does not require `id` (records without `id` are created, records with `id` are updated).
- `update-all`, `delete-all`, `access-all` reject `filter`. Use the `*-any` variants for filter-based updates.
- `update-any`, `delete-any`, `access-any` require a `filter` object.
- `aggregate` requires a non-empty `aggregate` object and does not accept `data`.
- `*-one` operations require an `id`.
- `*-404` operations require either an `id` or a `filter` object.

## Transaction Behavior

All bulk requests execute inside a transaction created by the route (`withTransactionParams`). On success the transaction commits and results are returned in the same order as requested. Any error causes the transaction to roll back and propagates the error response—no partial writes are persisted.

## Error Responses

### Validation Errors

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `BODY_NOT_OBJECT` | "Request body must be an object" | Body is not an object when object expected |
| 400 | `BODY_MISSING_FIELD` | "Request body must contain an operations array" | Missing operations field |
| 400 | `OPERATION_MISSING_FIELDS` | "Operation missing required fields" | Missing `operation` or `model` |
| 400 | `OPERATION_MISSING_ID` | "ID required for operation" | `*-one` without `id`, `*-404` without `id` or `filter`, or array entries without `id` |
| 400 | `OPERATION_MISSING_DATA` | "Operation requires data field" | Mutation without payload |
| 400 | `OPERATION_INVALID_DATA` | "Operation requires data to be [object|array]" | Wrong payload shape or extraneous data |
| 400 | `OPERATION_MISSING_FILTER` | "Operation requires filter to be an object" | `*-any` without filter |
| 400 | `OPERATION_INVALID_FILTER` | "Operation does not support filter" | `*-all` with filter |
| 400 | `OPERATION_MISSING_AGGREGATE` | "Operation requires aggregate" | `aggregate` without spec |
| 400 | `OPERATION_INVALID_GROUP_BY` | "groupBy must be string or array" | Invalid aggregate grouping |
| 422 | `OPERATION_UNSUPPORTED` | "Unsupported operation" | Unrecognized operation type |

### Authentication Errors

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 403 | `PERMISSION_DENIED` | "Operation not authorized" | Lacking model permission |

## Usage Examples

### Mixed Model Operations
```bash
curl -X POST http://localhost:9001/api/bulk \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "operation": "create-one",
        "model": "users",
        "data": {"name": "Jane", "email": "jane@example.com"}
      },
      {
        "operation": "access-one",
        "model": "users",
        "id": "user-123",
        "data": {"access_read": ["user-123"]}
      },
      {
        "operation": "aggregate",
        "model": "orders",
        "aggregate": {"total": {"$sum": "total"}},
        "filter": {"where": {"user_id": "user-123"}}
      }
    ]
  }'
```

### Batch Record Updates with Filters
```json
{
  "operations": [
    {
      "operation": "update-any",
      "model": "orders",
      "filter": {"where": {"status": "pending", "total": {"$gte": 1000}}},
      "data": {"priority": "high"}
    },
    {
      "operation": "delete-any",
      "model": "notifications",
      "filter": {"where": {"read": true}}
    }
  ]
}
```

### Explicit Record Updates
```json
{
  "operations": [
    {
      "operation": "update-all",
      "model": "inventory",
      "data": [
        {"id": "product_1", "reserved": 10},
        {"id": "product_2", "reserved": 4}
      ]
    }
  ]
}
```

## Related Documentation

- **CRUD Endpoints**: [`docs/data`](../../docs/32-data-api.md)
- **Aggregation Endpoint**: [`docs/34-aggregate-api.md`](../../docs/34-aggregate-api.md)
- **Observer System**: [`docs/OBSERVERS.md`](../../docs/OBSERVERS.md)

The Bulk API delivers high-throughput, transaction-safe orchestration across models while preserving the Monk platform’s validation, security, and auditing guarantees.
