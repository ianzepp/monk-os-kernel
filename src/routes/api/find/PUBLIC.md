# Find API

The Find API provides advanced search and filtering capabilities for records across models. Execute complex queries with sophisticated filtering, sorting, and aggregation operations.

## Base Path
`/api/find/:model`

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | [`/api/find/:model`](#post-apifindmodel) | Run complex filtered, sorted, and paginated queries with advanced operators. |
| GET | [`/api/find/:model/:target`](#get-apifindmodeltarget) | Execute a saved filter by ID or name. |

## Content Type
- **Request**: `application/json`
- **Response**: `application/json`

## Authentication Required
Requires valid JWT token in Authorization header: `Bearer <token>`

---

## Saved Filters

Filters can be saved to the `filters` model and re-executed by ID or name. This is useful for:
- Dashboard widgets with fixed queries
- Reusable report definitions
- Complex queries that are expensive to construct client-side
- "Bookmarked" searches users can re-run

### Creating a Saved Filter

```bash
POST /api/data/filters
[{
  "name": "active-users",
  "model_name": "users",
  "description": "All active users sorted by creation date",
  "where": { "status": "active" },
  "order": ["created_at desc"],
  "limit": 100
}]
```

### Executing a Saved Filter

```bash
# By name
GET /api/find/users/active-users

# By UUID
GET /api/find/users/550e8400-e29b-41d4-a716-446655440000
```

### Saved Filter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | text | yes | Unique name within the model |
| `model_name` | text | yes | Target model this filter executes against |
| `description` | text | no | Human-readable description |
| `select` | jsonb | no | Fields to return (array of field names) |
| `where` | jsonb | no | Filter conditions |
| `order` | jsonb | no | Sort order (array of "field asc/desc" strings) |
| `limit` | integer | no | Maximum records to return |
| `offset` | integer | no | Number of records to skip |

---

## GET /api/find/:model/:target

Execute a saved filter by ID or name.

### Parameters

- `:model` - The target model (must match the saved filter's `model_name`)
- `:target` - Either a UUID (filter ID) or a string (filter name)

### Success Response (200)

Returns the query results (same format as POST /api/find/:model).

### Error Responses

| Status | Error Code | Description |
|--------|------------|-------------|
| 404 | `FILTER_NOT_FOUND` | Saved filter not found or model_name mismatch |

---

## POST /api/find/:model

Run rich search queries with boolean logic, nested filters, ordering, pagination, and projection control. This is the preferred endpoint when Data API filtering is insufficient or when you need analytics-style queries without writing SQL.

### Request Body
```json
{
  "select": ["name", "email", "created_at"],  // Optional: specify fields to return
  "where": {
    // Complex filter conditions (see Filter Operations below)
  },
  "order": [
    "created_at desc",
    "name asc"
  ],
  "limit": 100,
  "offset": 0
}
```

### Success Response (200)
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "John Doe",
      "email": "john@example.com",
      "role": "full",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T14:22:00Z"
    }
  ]
}
```

## Advanced Filter Operations

### Basic Comparison Operators
```json
{
  "where": {
    "name": "John Doe",                    // Exact match
    "age": {"$gte": 18},                   // Greater than or equal
    "salary": {"$between": [50000, 100000]}, // Range
    "status": {"$in": ["active", "pending"]}, // One of values
    "email": {"$like": "%@company.com"}     // Pattern matching
  }
}
```

### Logical Operators
```json
{
  "where": {
    "$and": [
      {"department": "engineering"},
      {"role": "senior"}
    ],
    "$or": [
      {"status": "active"},
      {"status": "pending"}
    ],
    "$not": {
      "trashed_at": null
    }
  }
}
```

> **Note**: All logical operators (`$and`, `$or`, `$not`, `$nand`, `$nor`) are fully tested and working correctly. Complex nested logical conditions are supported.

### Array Operations (ACL Support)
```json
{
  "where": {
    "access_read": {"$any": ["user-123"]},     // User has read access
    "tags": {"$all": ["urgent", "review"]},    // Contains all tags
    "permissions": {"$size": {"$gte": 3}}      // Array length >= 3
  }
}
```

### Advanced Patterns
```json
{
  "where": {
    "metadata": {
      "preferences": {
        "theme": "dark"                        // Nested object queries
      }
    },
    "created_at": {
      "$between": ["2024-01-01", "2024-01-31"] // Date range
    },
    "$not": {
      "status": "archived"                     // Negation
    }
  }
}
```

## Field Selection (SELECT)

### Specific Fields
```json
{
  "select": ["name", "email", "account_type"]  // Return only specified fields
}
```

### All Fields
```json
{
  "select": ["*"]     // Return all available fields (default behavior)
}
```

### System Fields
```json
{
  "select": ["id", "created_at", "updated_at", "trashed_at"]  // System-managed fields
}
```

> **Performance Note**: The SELECT clause implements true database-level field projection, reducing data transfer and improving query performance by only returning requested fields.

## Sorting and Pagination

### Multiple Sort Fields
```json
{
  "order": [
    "priority desc",
    "created_at asc",
    "name asc"
  ]
}
```

### Pagination
```json
{
  "limit": 50,        // Maximum records to return
  "offset": 100       // Skip first 100 records (for page 3 of 50-record pages)
}
```

> **Note**: Both `limit` and `offset` are fully implemented and tested. Use together for proper pagination through large result sets.

## Usage Examples

### User Search with Complex Criteria
```bash
curl -X POST http://localhost:9001/api/find/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "where": {
      "$and": [
        {"department": "engineering"},
        {"status": {"$in": ["active", "probation"]}},
        {"created_at": {"$gte": "2024-01-01T00:00:00Z"}},
        {"access_read": {"$any": ["project-alpha"]}}
      ]
    },
    "order": [
      "last_login desc"
    ],
    "limit": 25
  }'
```

### Product Catalog Search
```bash
curl -X POST http://localhost:9001/api/find/products \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "where": {
      "$or": [
        {"category": "electronics"},
        {"tags": {"$any": ["featured", "sale"]}}
      ],
      "price": {"$between": [10, 500]},
      "in_stock": true
    },
    "order": [
      "popularity desc",
      "price asc"
    ]
  }'
```

### Access Control Queries
```bash
curl -X POST http://localhost:9001/api/find/documents \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "where": {
      "$and": [
        {"access_read": {"$any": ["current-user-id"]}},
        {"trashed_at": null},
        {"$or": [
          {"tags": {"$any": ["urgent"]}},
          {"priority": {"$gte": 8}}
        ]}
      ]
    }
  }'
```

## Important Behaviors

### Soft Delete Filtering
By default, all queries automatically exclude soft-deleted records and permanently deleted records:
```sql
-- Automatic filtering applied to all queries (trashed=exclude by default):
WHERE "trashed_at" IS NULL AND "deleted_at" IS NULL
```

**Permanently deleted records (`deleted_at IS NOT NULL`) are ALWAYS excluded from API queries.**
These records are kept in the database for compliance and audit purposes but are never visible through the API.

To control visibility of trashed records, use the `trashed` option in the request body:
```bash
# Default: exclude trashed records (show only active)
POST /api/find/users
{"where": {"status": "active"}}

# Include both active and trashed records
POST /api/find/users
{"trashed": "include", "where": {"status": "active"}}

# Show only trashed records
POST /api/find/users
{"trashed": "only"}
```

Valid `trashed` values:
- `"exclude"` (default) - Only show active records
- `"include"` - Show both active and trashed records
- `"only"` - Show only trashed records

> **Note**: For dedicated trash management (restore, permanent delete), use the [Trashed API](../trashed/PUBLIC.md).

### Empty Array Operators
- **`$in: []`** - Returns no results (always false: `1=0`)
- **`$nin: []`** - Returns all results (always true: `1=1`)
- **`$any: []`** - Returns no results (always false: `1=0`)
- **`$all: []`** - Returns all results (always true: `1=1`)

### Field Name Requirements
Field names must match the pattern: `^[a-zA-Z_][a-zA-Z0-9_]*$`
- Start with letter or underscore
- Contain only letters, numbers, and underscores
- Invalid characters are automatically removed (sanitization)

### Sort Direction Normalization
Sort directions accept multiple formats and normalize to `ASC` or `DESC`:
- `"asc"`, `"ascending"` → `ASC`
- `"desc"`, `"descending"` → `DESC`
- Invalid directions default to `ASC`

## Filter Operators Reference

### Comparison Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `$eq` | Equals | `{"age": {"$eq": 25}}` |
| `$ne` | Not equals | `{"status": {"$ne": "deleted"}}` |
| `$gt` | Greater than | `{"score": {"$gt": 90}}` |
| `$gte` | Greater than or equal | `{"age": {"$gte": 18}}` |
| `$lt` | Less than | `{"price": {"$lt": 100}}` |
| `$lte` | Less than or equal | `{"quantity": {"$lte": 10}}` |
| `$between` | Value between range | `{"salary": {"$between": [40000, 80000]}}` |

### Array Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `$in` | Value in array | `{"status": {"$in": ["active", "pending"]}}` |
| `$nin` | Value not in array | `{"role": {"$nin": ["guest", "banned"]}}` |
| `$any` | Array contains any value | `{"tags": {"$any": ["urgent", "review"]}}` |
| `$all` | Array contains all values | `{"skills": {"$all": ["javascript", "typescript"]}}` |
| `$size` | Array size comparison | `{"permissions": {"$size": {"$gte": 3}}}` |

### Text Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `$like` | SQL LIKE pattern | `{"email": {"$like": "%@company.com"}}` |
| `$ilike` | Case-insensitive LIKE | `{"name": {"$ilike": "%john%"}}` |
| `$regex` | Regular expression | `{"phone": {"$regex": "^\\+1"}}` |

### Logic Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `$and` | All conditions must match | `{"$and": [{"age": {"$gte": 18}}, {"status": "active"}]}` |
| `$or` | Any condition must match | `{"$or": [{"role": "full"}, {"permissions": {"$any": ["write"]}}]}` |
| `$not` | Condition must not match | `{"$not": {"status": "deleted"}}` |
| `$nand` | Not all conditions match | `{"$nand": [{"role": "guest"}, {"verified": false}]}` |
| `$nor` | No conditions match | `{"$nor": [{"banned": true}, {"suspended": true}]}` |

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `BODY_NOT_ARRAY` | "Request body must be an array of operations" | Body is not an array when array expected |
| 400 | `OPERATION_MISSING_FIELDS` | "Operation missing required fields" | Missing operation or model |
| 400 | `OPERATION_MISSING_ID` | "ID required for operation" | Single-record operation without ID |
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Target model doesn't exist |
| 422 | `OPERATION_UNSUPPORTED` | "Unsupported operation" | Invalid operation type |

## Performance Considerations

### Query Optimization
- **Index usage**: Ensure filtered fields have database indexes
- **Limit results**: Use pagination for large datasets
- **Selective fields**: Request only needed fields when possible
- **Filter early**: Apply most selective filters first

### Best Practices
```bash
# Good: Specific filters with limits
{"where": {"status": "active", "department": "sales"}, "limit": 100}

# Avoid: Broad queries without limits
{"where": {"created_at": {"$gte": "2020-01-01"}}} # No limit - could return millions
```

## When to Use Find API

**Use Find API when:**
- Complex filtering across multiple fields and conditions
- Advanced sorting requirements with multiple criteria
- ACL-based queries requiring permission filtering
- Analytics queries requiring aggregation-style filtering

**Use Data API when:**
- Simple CRUD operations on known records
- Bulk operations across multiple models (use Bulk API)
- Real-time record updates
- File-like access patterns (use File API)

## Related Documentation

- **Data Operations**: `/docs/data` - Standard CRUD operations
- **Bulk Operations**: `/docs/bulk` - Multi-model batch processing
- **Model Management**: `/docs/describe` - Creating and managing data models
- **File Interface**: `/docs/file` - Filesystem-like data access

The Find API provides powerful search capabilities while maintaining full integration with the Monk platform's observer system and access control mechanisms.
