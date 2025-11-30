# GET /api/data/:model

Query all records in a model with optional filtering for soft-deleted and permanently deleted records. This endpoint backs list views, exports, and analytics screens by returning the complete dataset for a model.

## Path Parameters

- `:model` - Model name (required)

## Query Parameters

### Filtering Parameters
- `include_trashed=true` - Include soft-deleted records (`trashed_at IS NOT NULL`)
- `include_deleted=true` - Include permanently deleted records (`deleted_at IS NOT NULL`) - requires root access

### Response Transformation Parameters
- `unwrap` - Remove envelope, return data array directly
- `select=field1,field2` - Return only specified fields (implies unwrap)
- `stat=false` - Exclude timestamp fields (created_at, updated_at, trashed_at, deleted_at)
- `access=false` - Exclude ACL fields (access_read, access_edit, access_full)

## Request Body

None - GET request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": [
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
  ]
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 401 | `AUTH_TOKEN_REQUIRED` | "Authorization token required" | No Bearer token in Authorization header |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Token malformed or bad signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token well-formed but past expiration |
| 404 | `MODEL_NOT_FOUND` | "Model not found" | Invalid model name |

## Default Behavior

By default, this endpoint:
- Returns only **active records** (where `trashed_at IS NULL` and `deleted_at IS NULL`)
- Returns **all fields** defined in the model
- Returns records in **database order** (no explicit sorting)
- Returns **all matching records** (no pagination limit)

## Example Usage

### Get All Active Users

```bash
curl -X GET http://localhost:9001/api/data/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Include Soft-Deleted Records

```bash
curl -X GET "http://localhost:9001/api/data/users?include_trashed=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response includes records with `trashed_at` set:**
```json
{
  "success": true,
  "data": [
    {
      "id": "user-1",
      "name": "Active User",
      "trashed_at": null
    },
    {
      "id": "user-2",
      "name": "Deleted User",
      "trashed_at": "2024-01-15T12:00:00Z"
    }
  ]
}
```

### Include Permanently Deleted Records (Root Only)

```bash
curl -X GET "http://localhost:9001/api/data/users?include_deleted=true" \
  -H "Authorization: Bearer ROOT_JWT_TOKEN"
```

**Response includes records with `deleted_at` set:**
```json
{
  "success": true,
  "data": [
    {
      "id": "user-1",
      "name": "Active User",
      "trashed_at": null,
      "deleted_at": null
    },
    {
      "id": "user-2",
      "name": "Permanently Deleted User",
      "trashed_at": "2024-01-10T10:00:00Z",
      "deleted_at": "2024-01-15T10:00:00Z"
    }
  ]
}
```

## Response Transformation Examples

### Unwrap Response Envelope

By default, responses are wrapped in a success envelope. Use `?unwrap` to get just the data:

```bash
curl -X GET "http://localhost:9001/api/data/users?unwrap" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Standard response (without unwrap):**
```json
{
  "success": true,
  "data": [
    {"id": "user-1", "name": "Alice"},
    {"id": "user-2", "name": "Bob"}
  ]
}
```

**Unwrapped response:**
```json
[
  {"id": "user-1", "name": "Alice"},
  {"id": "user-2", "name": "Bob"}
]
```

### Select Specific Fields

Use `?select=` to return only specific fields (automatically unwraps):

```bash
curl -X GET "http://localhost:9001/api/data/users?select=id,name,email" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (unwrapped with only selected fields):**
```json
[
  {
    "id": "user-1",
    "name": "Alice",
    "email": "alice@example.com"
  },
  {
    "id": "user-2",
    "name": "Bob",
    "email": "bob@example.com"
  }
]
```

**Use case:** Reduce payload size when you only need specific fields for a UI table or export.

### Exclude Timestamp Fields

Use `?stat=false` to remove timestamp fields:

```bash
curl -X GET "http://localhost:9001/api/data/users?stat=false" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (excludes created_at, updated_at, trashed_at, deleted_at):**
```json
{
  "success": true,
  "data": [
    {
      "id": "user-1",
      "name": "Alice",
      "email": "alice@example.com",
      "department": "Engineering"
    }
  ]
}
```

**Use case:** Cleaner output for user-facing displays where timestamps aren't needed.

### Exclude ACL Fields

Use `?access=false` to remove access control fields:

```bash
curl -X GET "http://localhost:9001/api/data/users?access=false" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (excludes access_read, access_edit, access_full):**
```json
{
  "success": true,
  "data": [
    {
      "id": "user-1",
      "name": "Alice",
      "email": "alice@example.com",
      "department": "Engineering",
      "created_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

**Use case:** Simplified data for public-facing APIs or when ACL data isn't needed.

### Combine Multiple Transformations

Query parameters can be combined:

```bash
# Get only id and name, exclude timestamps, unwrap envelope
curl -X GET "http://localhost:9001/api/data/users?select=id,name&stat=false" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
[
  {"id": "user-1", "name": "Alice"},
  {"id": "user-2", "name": "Bob"}
]
```

## Use Cases

### Export All Records
```javascript
const response = await fetch('/api/data/products', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { data: products } = await response.json();

// Export to CSV, Excel, etc.
exportToCSV(products);
```

### Audit Trail with Deleted Records
```javascript
// Get complete history including deleted items
const response = await fetch('/api/data/audit_log?include_deleted=true', {
  headers: { 'Authorization': `Bearer ${rootToken}` }
});
const { data: auditRecords } = await response.json();

// Analyze deletion patterns
const deletedRecords = auditRecords.filter(r => r.deleted_at !== null);
```

### Trash Management
```javascript
// Show trash bin contents
const response = await fetch('/api/data/documents?include_trashed=true', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { data: documents } = await response.json();

// Filter to show only trashed items
const trashedDocs = documents.filter(doc =>
  doc.trashed_at !== null && doc.deleted_at === null
);

// Render trash bin UI
renderTrashBin(trashedDocs);
```

## Streaming JSONL Format

For large datasets or real-time processing, request streaming JSONL (newline-delimited JSON) using the `Accept` header:

```bash
curl -X GET http://localhost:9001/api/data/orders \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Accept: application/x-ndjson"
```

**Response (streamed line by line):**
```
{"id":"order-1","status":"pending","total":150.00}
{"id":"order-2","status":"shipped","total":299.99}
{"id":"order-3","status":"delivered","total":75.50}
```

### Benefits of Streaming

- **Memory efficient**: Records are sent as they're retrieved, not buffered
- **Time to first byte**: Client receives data immediately
- **Large datasets**: Process millions of records without memory issues
- **Real-time pipelines**: Pipe directly to processing tools

### Client Examples

**JavaScript (fetch with streaming):**
```javascript
const response = await fetch('/api/data/orders', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/x-ndjson'
  }
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep incomplete line in buffer

  for (const line of lines) {
    if (line) {
      const record = JSON.parse(line);
      processRecord(record);
    }
  }
}
```

**Command line (pipe to jq):**
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/x-ndjson" \
  http://localhost:9001/api/data/orders | \
  jq -c 'select(.status == "pending")'
```

**Python (streaming):**
```python
import requests
import json

response = requests.get(
    'http://localhost:9001/api/data/orders',
    headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/x-ndjson'
    },
    stream=True
)

for line in response.iter_lines():
    if line:
        record = json.loads(line)
        process_record(record)
```

### Streaming vs Array Response

| Accept Header | Response Format | Use Case |
|---------------|-----------------|----------|
| `application/json` (default) | `{"success":true,"data":[...]}` | Small datasets, simple clients |
| `application/x-ndjson` | One JSON object per line | Large datasets, streaming pipelines |

**Note:** Streaming bypasses the response envelope and transformation middleware. Query parameters like `?unwrap`, `?select=`, `?stat=false` are not applied to streaming responses.

## Alternative Response Formats

### CSV Format

Use `?format=csv` to get results as comma-separated values (automatically unwraps envelope):

```bash
curl -X GET "http://localhost:9001/api/data/users?format=csv" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response (text/csv):**
```csv
id,name,email,department,created_at
550e8400-e29b-41d4-a716-446655440000,John Doe,john@example.com,Engineering,2024-01-15T10:30:00Z
550e8400-e29b-41d4-a716-446655440001,Jane Smith,jane@example.com,Marketing,2024-01-15T10:30:01Z
```

**Use cases:**
- Export to Excel/Google Sheets
- Import into analytics tools
- Generate reports
- Data migration

**Note:** CSV format automatically removes the envelope wrapper, returning just the data records.

### MessagePack Format

Use `?format=msgpack` to get results in binary MessagePack format (smaller, faster):

```bash
curl -X GET "http://localhost:9001/api/data/users?format=msgpack" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  --output users.msgpack
```

**Response:** Binary MessagePack data (application/msgpack)

**Use cases:**
- High-performance APIs (30-50% smaller than JSON)
- Low-bandwidth environments
- Binary data transfer
- Language-agnostic serialization

**Decoding MessagePack (JavaScript):**
```javascript
import { decode } from '@msgpack/msgpack';

const response = await fetch('/api/data/users?format=msgpack', {
  headers: { 'Authorization': `Bearer ${token}` }
});

const buffer = await response.arrayBuffer();
const data = decode(new Uint8Array(buffer));
console.log(data); // Parsed JavaScript object
```

**Decoding MessagePack (Python):**
```python
import msgpack
import requests

response = requests.get(
    'http://localhost:9001/api/data/users?format=msgpack',
    headers={'Authorization': f'Bearer {token}'}
)

data = msgpack.unpackb(response.content)
print(data)
```

## Advanced Queries

For more sophisticated filtering, sorting, and pagination, use the **Find API** instead:

```bash
# Use Find API for complex queries
POST /api/find/users
{
  "where": {
    "department": "Engineering",
    "created_at": { "$gte": "2024-01-01" }
  },
  "order": ["created_at desc"],
  "limit": 50
}
```

See [`POST /api/find/:model`](../../find/:model/POST.md) for details.

## Model Protection

This endpoint respects model-level protection:

- **Frozen models** (`frozen=true`): Read operations are allowed
- **Sudo-protected models** (`sudo=true`): No special requirements for read operations
- **ACL filtering**: Results automatically filtered based on user's `access_read` permissions

## Performance Considerations

⚠️ **Warning**: This endpoint returns **all records** in the model without pagination. For large datasets:

- Use the **Find API** with `limit` and `offset` for pagination
- Consider caching responses for frequently accessed data
- Use field projection in Find API to reduce payload size

**Example of better approach for large datasets:**
```bash
# Instead of GET /api/data/users (returns all)
# Use Find API with pagination:
POST /api/find/users
{
  "select": ["id", "name", "email"],
  "limit": 100,
  "offset": 0
}
```

## Related Endpoints

- [`POST /api/data/:model`](POST.md) - Create multiple records
- [`PUT /api/data/:model`](PUT.md) - Update multiple records
- [`DELETE /api/data/:model`](DELETE.md) - Delete multiple records
- [`POST /api/find/:model`](../../find/:model/POST.md) - Advanced filtering and pagination
