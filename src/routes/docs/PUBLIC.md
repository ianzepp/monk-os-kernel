# Monk API

**Ultra-lightweight PaaS backend** built with Hono and TypeScript, featuring model-first development, multi-tenant architecture, and innovative filesystem-like data access for building high-performance SaaS applications.

## API Architecture

### Public Routes (No Authentication Required)
| API | Endpoints | Purpose |
|-----|-----------|---------|
| **Health Check** | `/health` | System health status and uptime |
| **Public Auth** | `/auth/*` | Token acquisition (login, register, refresh) |
| **Documentation** | `/docs/*` | Self-documenting API reference |

### Protected Routes (JWT Authentication Required)
| API | Endpoints | Purpose |
|-----|-----------|---------|
| **Auth API** | `/api/auth/*` | User account management and privilege escalation |
| **Data API** | `/api/data/:model[/:record]` | CRUD operations for model records |
| **Describe API** | `/api/describe/:model[/fields[/:field]]` | Model definition and field management |
| **Find API** | `/api/find/:model` | Advanced search and filtering with 25+ operators |
| **Aggregate API** | `/api/aggregate/:model` | Data aggregation and analytics operations |
| **Bulk API** | `/api/bulk` | Batch operations across multiple models |
| **ACLs API** | `/api/acls/:model/:record` | Access control list management for records |
| **Stat API** | `/api/stat/:model/:record` | Record metadata (timestamps, etag, size) |
| **Tracked API** | `/api/tracked/:model/:record[/:change]` | Change tracking and audit trails |

### Administrative Routes (Sudo Token Required)
| API | Endpoints | Purpose |
|-----|-----------|---------|
| **Sudo API** | `/api/sudo/*` | User management (tenant-scoped, requires sudo token) |

## Key Features

- **Model-First Development**: Define data models with in-house validation and automatic PostgreSQL table generation
- **Multi-Tenant Architecture**: Schema-isolated tenants with JWT-based routing and security
- **Advanced Filtering**: 25+ filter operators with complex logical operations and ACL integration
- **Change Tracking**: Comprehensive audit trails with field-level tracking for all record modifications
- **Privilege Escalation**: Enterprise-grade sudo model with time-limited root access for administrative operations
- **Observer System**: Ring-based business logic execution (0-9 rings) for extensible data processing
- **Access Control**: Fine-grained ACL management at the record level for security and permissions

## Authentication Model

### Three-Tier Security
1. **Public Access**: Token acquisition and documentation (no authentication)
2. **User Access**: Standard API operations with user-level JWT tokens
3. **Root Access**: Administrative operations requiring elevated privileges via sudo

### Token Types
- **User JWT**: Standard operations (1 hour expiration)
- **Root JWT**: Administrative operations (15 minutes expiration, obtained via sudo)
- **Refresh Token**: Long-lived token renewal (configurable expiration)

### JWT Token Structure

All JWT tokens contain the following payload:

```json
{
  "tenant": "tenant_name",
  "database": "tenant_12345678",
  "access": "user_access_level",
  "user": "username",
  "exp": 1234567890
}
```

### Authentication Header

Include the JWT token in all protected API requests:

```bash
Authorization: Bearer <jwt_token>
```

## API Discovery

Use the root endpoint to discover all available APIs and their documentation:

```bash
curl http://localhost:9001/

# Response includes complete API catalog:
{
  "success": true,
  "data": {
    "name": "Monk API (Hono)",
    "version": "3.1.0",
    "endpoints": {
      "home": ["/ (public)", "/health (public)"],
      "docs": ["/README.md (public)", "/docs/:api (public)"],
      "auth": ["/auth/* (public)", "/api/auth/* (protected)"],
      "describe": ["/api/describe[/:model[/:field]] (protected)"],
      "data": ["/api/data/:model[/:record[/:relationship[/:child]]] (protected)"],
      "find": ["/api/find/:model (protected)"],
      "aggregate": ["/api/aggregate/:model (protected)"],
      "bulk": ["/api/bulk (protected)"],
      "acls": ["/api/acls/:model/:record (protected)"],
      "stat": ["/api/stat/:model/:record (protected)"],
      "tracked": ["/api/tracked/:model/:record[/:change] (protected)"],
      "sudo": ["/api/sudo/* (sudo token required)"]
    },
    "documentation": {
      "auth": ["/docs/auth"],
      "describe": ["/docs/api/describe"],
      "data": ["/docs/api/data"],
      "find": ["/docs/api/find"],
      "aggregate": ["/docs/api/aggregate"],
      "bulk": ["/docs/api/bulk"],
      "acls": ["/docs/api/acls"],
      "stat": ["/docs/api/stat"],
      "tracked": ["/docs/api/tracked"],
      "sudo": ["/docs/api/sudo"]
    }
  }
}
```

## Documentation Navigation

This API is fully self-documenting with three levels of documentation depth.

**You are here**: `/docs` (API Discovery - Level 1)

This page lists all available APIs. See the `documentation` section above for API-specific documentation URLs.

### Next: Explore API Overviews (Level 2)

Navigate to `/docs/api/{api}` for protected APIs or `/docs/auth` for authentication to see:
- Complete endpoint table with all operations
- Request/response formats and examples
- Authentication requirements
- Quick start guides

**Available API Documentation**:
- `/docs/api/describe` - Model and field management
- `/docs/api/data` - CRUD operations on records
- `/docs/api/find` - Advanced querying with filters
- `/docs/api/aggregate` - Data aggregation and analytics
- `/docs/api/bulk` - Batch operations across models
- `/docs/api/acls` - Access control management
- `/docs/api/stat` - Record metadata access
- `/docs/api/tracked` - Change tracking and audit trails
- `/docs/auth` - Authentication and token management
- `/docs/api/user` - User account management
- `/docs/api/sudo` - Administrative operations

### Then: Access Endpoint-Specific Docs (Level 3)

From an API overview page, you'll see an endpoint table like:

```
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/describe/:model | Get model metadata |
```

To get detailed documentation for a specific endpoint, construct the URL:

**Mapping Rules**:
1. Take the API endpoint: `GET /api/describe/:model`
2. Replace parameter placeholders with literal names:
   - `:model` → `model`
   - `:field` → `field`
   - `:record` → `record`
   - `:relationship` → `relationship`
   - `:child` → `child`
3. Append HTTP method: `api/describe/model/GET`
4. Add `/docs/` prefix: `/docs/api/describe/model/GET`

**Examples**:
```
API Endpoint                              → Documentation URL
----------------------------------------- → ----------------------------------
GET    /api/describe                      → /docs/api/describe/GET
GET    /api/describe/:model              → /docs/api/describe/model/GET
POST   /api/describe/:model              → /docs/api/describe/model/POST
GET    /api/describe/:model/fields      → /docs/api/describe/model/fields/GET
GET    /api/describe/:model/fields/:field      → /docs/api/describe/model/field/GET
DELETE /api/describe/:model/fields/:field      → /docs/api/describe/model/field/DELETE

GET    /api/data/:model                  → /docs/api/data/model/GET
POST   /api/data/:model                  → /docs/api/data/model/POST
GET    /api/data/:model/:record          → /docs/api/data/model/record/GET
GET    /api/data/:model/:record/:rel     → /docs/api/data/model/record/relationship/GET

GET    /auth/login                        → /docs/auth/login/GET
POST   /auth/login                        → /docs/auth/login/POST
POST   /auth/register                     → /docs/auth/register/POST
```

**Exploration Workflow**:
1. **(You are here)** Read `/docs` to discover available APIs
2. Navigate to `/docs/api/describe` to see Describe API endpoint table
3. Find endpoint: `GET /api/describe/:model`
4. Apply mapping rules → `/docs/api/describe/model/GET`
5. Access `/docs/api/describe/model/GET` for complete endpoint documentation with examples, error codes, and use cases

## Documentation Guide

### Getting Started Documentation
- **Token Operations**: `/docs/auth` - Login, register, refresh workflows
- **User Management**: `/docs/api/user` - Account management and privilege escalation

### Core API Documentation
- **Data Management**: `/docs/api/data` - CRUD operations and record management
- **Model Management**: `/docs/api/describe` - Model definition and field management
- **Access Control**: `/docs/api/acls` - Record-level ACL management and permissions
- **Metadata Access**: `/docs/api/stat` - Record metadata without user data

### Advanced Operations
- **Complex Search**: `/docs/api/find` - Advanced filtering with 25+ operators
- **Data Aggregation**: `/docs/api/aggregate` - Analytics and aggregation operations
- **Batch Processing**: `/docs/api/bulk` - Multi-model transaction operations
- **Change Tracking**: `/docs/api/tracked` - Audit trails and change history
- **Administration**: `/docs/api/sudo` - User management and administrative operations

## Common Operations Quick Reference

| Task | Endpoint | Method | Notes |
|------|----------|--------|-------|
| **Create one record** | `/api/data/:model` | POST | Single object body |
| **Create many records** | `/api/data/:model` | POST | Array body |
| **Read one record** | `/api/data/:model/:id` | GET | |
| **Read all records** | `/api/data/:model` | GET | |
| **Update one record** | `/api/data/:model/:id` | PUT | |
| **Update many records** | `/api/data/:model` | PUT | Array of `{id, ...fields}` |
| **Update by filter** | `/api/bulk` | POST | `operation: "update-any"` with `filter` and `data` |
| **Delete one record** | `/api/data/:model/:id` | DELETE | Soft delete |
| **Delete many records** | `/api/data/:model` | DELETE | Array of `{id}` |
| **Delete by filter** | `/api/bulk` | POST | `operation: "delete-any"` with `filter` |
| **Search with filters** | `/api/find/:model` | POST | 25+ filter operators |
| **Aggregate/Analytics** | `/api/aggregate/:model` | POST | `$sum`, `$avg`, `$count`, `$min`, `$max` with `groupBy` |
| **View change history** | `/api/tracked/:model/:id` | GET | Requires field tracking enabled |
| **Cross-model transaction** | `/api/bulk` | POST | Multiple operations, single transaction |

## Quick Start Workflow

1. **Health Check**: `GET /health` to verify system status
2. **Explore APIs**: `GET /` to discover available endpoints and documentation
3. **Authentication**: Follow `/docs/auth` to obtain JWT tokens
4. **Model Setup**: Use `/docs/api/describe` to define your data structures
5. **Data Operations**: Use `/docs/api/data` for standard CRUD operations
6. **Advanced Features**: Explore `/docs/api/find`, `/docs/api/aggregate`, `/docs/api/bulk` for sophisticated data access
7. **Security & Auditing**: Use `/docs/api/acls` for permissions and `/docs/api/tracked` for audit trails

## Response Format

All endpoints return consistent JSON responses:

```json
// Success responses
{"success": true, "data": { /* response data */ }}

// Error responses
{"success": false, "error": "message", "error_code": "CODE"}
```

### Response Customization

All API endpoints support query parameters for customizing response format and content:

#### Format Selection (`?format=`)

Choose response encoding format to optimize for different use cases:

**Supported Formats:**
- `json` (default) - Standard JSON with 2-space indentation
- `toon` - Compact human-readable format (30-40% fewer tokens for LLMs)
- `yaml` - YAML format for human readability
- `toml` - TOML configuration format (explicit typing, clean syntax)
- `csv` - CSV tabular data (response-only, auto-unwraps, array of objects only)
- `msgpack` - Binary format (30-50% smaller, base64-encoded for HTTP)
- `brainfuck` - Novelty format (response-only)
- `morse` - Morse code encoding
- `qr` - QR code ASCII art (response-only)
- `markdown` - Markdown tables and formatting (response-only)
- `grid-compact` - Compact Grid API format (60% smaller, Grid API only, response-only)

**Examples:**
```bash
# Get response in TOON format (compact for LLMs)
curl http://localhost:9001/api/user/whoami?format=toon

# Get response as TOML (great for config files)
curl http://localhost:9001/api/user/whoami?format=toml

# Get response as MessagePack binary (efficient)
curl http://localhost:9001/api/data/users?format=msgpack

# Get response as Markdown table
curl http://localhost:9001/api/describe?format=markdown

# Export user list as CSV (auto-unwraps data)
curl http://localhost:9001/api/find/users?format=csv > users.csv

# Get Grid API response in compact format (Grid API only, 60% smaller)
curl http://localhost:9001/api/grids/abc123/A1:Z100?format=grid-compact
```

**Alternative Methods:**
1. Query parameter: `?format=toon` (highest priority)
2. Accept header: `Accept: application/toon`
3. JWT preference: Set `format` during login (persists for session)

#### Field Extraction (`?unwrap` and `?select=`)

Extract specific fields server-side, eliminating the need for client-side processing:

**Unwrap (Remove Envelope):**
```bash
# Standard response with envelope
curl /api/user/whoami
# → {"success": true, "data": {"id": "...", "name": "...", ...}}

# Unwrapped response (just the data)
curl /api/user/whoami?unwrap
# → {"id": "...", "name": "...", ...}
```

**Select Specific Fields:**
```bash
# Extract single field (returns plain text)
curl /api/user/whoami?select=id
# → c81d0a9b-8d9a-4daf-9f45-08eb8bc3805c

# Extract multiple fields (returns JSON object)
curl /api/user/whoami?select=id,name,access
# → {"id": "...", "name": "...", "access": "..."}

# Nested field extraction
curl /api/data/users/123?select=profile.email
# → user@example.com
```

**Combined Usage:**
```bash
# Extract fields AND format output
curl /api/user/whoami?select=id,name&format=toon
# → id: c81d0a9b...
#   name: Demo User

# Extract field and get as MessagePack
TOKEN=$(curl /auth/login?select=token -d '{"tenant":"demo","username":"root"}')
```

**Benefits:**
- **No client-side parsing**: Eliminates `| jq` piping in shell scripts
- **Bandwidth optimization**: Return only needed fields
- **Simplified automation**: Direct value extraction for CI/CD
- **Format compatible**: Works with all response formats

**Processing Order:**
1. Route executes and returns full data
2. Field extraction filters data (if `?select=` or `?unwrap` present)
3. Response formatter encodes to requested format (if `?format=` specified)
4. Response encryption encrypts output (if `?encrypt=` specified)

### Response Encryption (`?encrypt=pgp`)

Encrypt API responses for secure transmission using AES-256-GCM with keys derived from your JWT token.

**Encryption Model:**
- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Source**: Derived from your JWT token via PBKDF2
- **Output**: PGP-style ASCII armor format
- **Purpose**: Transport security (ephemeral, not long-term storage)

**Usage:**
```bash
# Encrypt any response
curl /api/user/whoami?encrypt=pgp \
  -H "Authorization: Bearer $JWT" > encrypted.txt

# Decrypt with same JWT
tsx scripts/decrypt.ts "$JWT" < encrypted.txt

# Combine with formatting and field selection
curl /api/find/users?select=id,email&format=csv&encrypt=pgp \
  -H "Authorization: Bearer $JWT"
```

**ASCII Armor Output:**
```
-----BEGIN MONK ENCRYPTED MESSAGE-----
Version: Monk-API/3.0
Cipher: AES-256-GCM

<base64-encoded encrypted data>
-----END MONK ENCRYPTED MESSAGE-----
```

**Security Model (Ephemeral Encryption):**

✅ **Good for:**
- Secure transmission over untrusted networks
- Additional defense-in-depth layer
- Preventing data logging in proxies

⚠️ **Important Limitations:**
- JWT token IS the decryption key
- JWT expiry means old messages become undecryptable
- NOT suitable for long-term storage
- Decrypt immediately or data may be lost

**Composability:**
```bash
# Select → Format → Encrypt (all in one request)
curl /api/find/users?select=id,name,email&format=csv&encrypt=pgp

# Any format can be encrypted
curl /api/data/users?format=yaml&encrypt=pgp
curl /api/describe?format=markdown&encrypt=pgp
```

## Integration Examples

### JavaScript/Node.js

```javascript
// Login with field extraction (get token directly)
const loginResponse = await fetch('https://api.example.com/auth/login?select=token', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    tenant: 'my_tenant',
    username: 'user',
    password: 'pass'
  })
});

// Token is returned directly (not wrapped in envelope)
const token = await loginResponse.text();

// Create a record
const response = await fetch('https://api.example.com/api/data/users', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Jane Smith',
    email: 'jane@example.com'
  })
});

const result = await response.json();
if (result.success) {
  console.log('Created user:', result.data);
} else {
  console.error('Error:', result.error_code, result.error);
}

// Get data in TOON format (compact for LLM processing)
const toonResponse = await fetch('https://api.example.com/api/data/users?format=toon', {
  headers: {'Authorization': `Bearer ${token}`}
});
const toonData = await toonResponse.text();  // TOON-formatted string

// Extract specific fields only
const userResponse = await fetch('https://api.example.com/api/data/users/123?select=email,name', {
  headers: {'Authorization': `Bearer ${token}`}
});
const userInfo = await userResponse.json();  // {"email": "...", "name": "..."}
```

### Python

```python
import requests

# Login with field extraction (get token directly)
login_response = requests.post(
    'https://api.example.com/auth/login?select=token',
    json={
        'tenant': 'my_tenant',
        'username': 'user',
        'password': 'pass'
    }
)

# Token is returned directly (not wrapped in envelope)
token = login_response.text

headers = {
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json'
}

# Create a record
data = {
    'name': 'John Doe',
    'email': 'john@example.com'
}

response = requests.post(
    'https://api.example.com/api/data/users',
    headers=headers,
    json=data
)

result = response.json()
if result['success']:
    print('Created user:', result['data'])
else:
    print('Error:', result['error_code'], result['error'])

# Advanced query with filtering
query = {
    'where': {'status': 'active', 'age': {'$gte': 18}},
    'limit': 50,
    'order': ['created_at desc']
}

response = requests.post(
    'https://api.example.com/api/find/users',
    headers=headers,
    json=query
)

results = response.json()

# Get data in TOON format (compact for LLM processing)
response = requests.post(
    'https://api.example.com/api/find/users?format=toon',
    headers=headers,
    json=query
)

toon_results = response.text  # Returns TOON-formatted string

# Extract specific fields only
response = requests.get(
    'https://api.example.com/api/data/users/123?select=email,name',
    headers=headers
)

user_info = response.json()  # Returns {"email": "...", "name": "..."}
```

### cURL

```bash
# Get authentication token (with field extraction - no jq needed!)
TOKEN=$(curl -X POST https://api.example.com/auth/login?select=token \
  -H "Content-Type: application/json" \
  -d '{"tenant":"my_tenant","username":"user","password":"pass"}')

# Create a record
curl -X POST https://api.example.com/api/data/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com"}'

# Query with filtering
curl -X POST https://api.example.com/api/find/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "where": {"status": "active"},
    "limit": 10,
    "order": ["created_at desc"]
  }'

# Query with TOON format (compact for LLM processing)
curl -X POST https://api.example.com/api/find/users?format=toon \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"where": {"status": "active"}, "limit": 10}'

# Get specific field from user record
USER_EMAIL=$(curl https://api.example.com/api/data/users/123?select=email \
  -H "Authorization: Bearer $TOKEN")

# Bulk operations - batch create
curl -X POST https://api.example.com/api/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "operation": "create-all",
        "model": "users",
        "data": [{"name": "User 1"}, {"name": "User 2"}]
      }
    ]
  }'

# Bulk operations - batch update (update multiple records by ID)
curl -X POST https://api.example.com/api/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "operation": "update-all",
        "model": "products",
        "data": [
          {"id": "prod_1", "price": 29.99},
          {"id": "prod_2", "price": 39.99},
          {"id": "prod_3", "price": 49.99}
        ]
      }
    ]
  }'

# Bulk operations - batch update by filter (update all matching records)
curl -X POST https://api.example.com/api/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "operation": "update-any",
        "model": "orders",
        "filter": {"where": {"status": "pending"}},
        "data": {"status": "processing"}
      }
    ]
  }'
```

## Error Handling

### Error Response Format

All API endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Human-readable error message",
  "error_code": "MACHINE_READABLE_ERROR_CODE",
  "data": {
    // Optional additional error context
  }
}
```

#### Response Fields

**`success`**
- **Type**: `boolean`
- **Value**: Always `false` for error responses
- **Purpose**: Distinguishes error responses from successful responses

**`error`**
- **Type**: `string`
- **Purpose**: Human-readable error message for display to end users
- **Language**: English
- **Format**: Clear, actionable description of what went wrong

**`error_code`**
- **Type**: `string`
- **Purpose**: Machine-readable error identifier for programmatic handling
- **Format**: `SUBJECT_FIRST` naming (e.g., `MODEL_NOT_FOUND`, `TENANT_MISSING`)
- **Stability**: Error codes are stable across API versions

**`data`** (Optional)
- **Type**: `object`
- **Purpose**: Additional structured error context
- **Development Mode**: Includes stack traces and debugging information

### HTTP Status Codes

| Status | Category | Description | Common Error Codes |
|--------|----------|-------------|-------------------|
| `400` | Bad Request | Invalid input, missing fields, malformed requests | `VALIDATION_ERROR`, `JSON_PARSE_ERROR`, `MODEL_ERROR` |
| `401` | Unauthorized | Authentication required or failed | `UNAUTHORIZED`, `TOKEN_EXPIRED` |
| `403` | Forbidden | Insufficient permissions | `FORBIDDEN`, `MODEL_PROTECTED`, `ACCESS_DENIED` |
| `404` | Not Found | Resource does not exist | `NOT_FOUND`, `MODEL_NOT_FOUND`, `RECORD_NOT_FOUND` |
| `405` | Method Not Allowed | HTTP method not supported | `UNSUPPORTED_METHOD` |
| `409` | Conflict | Request conflicts with current state | `CONFLICT`, `DEPENDENCY_ERROR` |
| `413` | Request Too Large | Request body exceeds size limit | `BODY_TOO_LARGE` |
| `415` | Unsupported Media | Content-Type not supported | `UNSUPPORTED_CONTENT_TYPE` |
| `422` | Unprocessable Entity | Well-formed but semantically invalid | `UNPROCESSABLE_ENTITY` |
| `500` | Internal Server Error | Unexpected server error | `INTERNAL_ERROR`, `DATABASE_ERROR` |

### Error Code Reference

#### Model Management Errors
| Error Code | Description | HTTP Status |
|------------|-------------|-------------|
| `MODEL_NOT_FOUND` | Requested model does not exist | 404 |
| `MODEL_PROTECTED` | Cannot modify system-protected model | 403 |
| `MODEL_INVALID_FORMAT` | Model definition has invalid format | 400 |
| `MODEL_MISSING_FIELDS` | Model missing required fields | 400 |
| `MODEL_EXISTS` | Model already exists (conflict) | 409 |

#### Authentication & Authorization Errors
| Error Code | Description | HTTP Status |
|------------|-------------|-------------|
| `UNAUTHORIZED` | Missing or invalid authentication | 401 |
| `TOKEN_EXPIRED` | JWT token has expired | 401 |
| `FORBIDDEN` | Insufficient permissions | 403 |
| `ACCESS_DENIED` | Access denied to resource | 403 |
| `TENANT_MISSING` | Tenant not found or invalid | 401 |

#### Request Validation Errors
| Error Code | Description | HTTP Status |
|------------|-------------|-------------|
| `VALIDATION_ERROR` | General validation failure | 400 |
| `JSON_PARSE_ERROR` | Invalid JSON format | 400 |
| `MISSING_CONTENT_TYPE` | Content-Type header missing | 400 |
| `UNSUPPORTED_CONTENT_TYPE` | Content-Type not supported | 415 |
| `BODY_TOO_LARGE` | Request exceeds 10MB limit | 413 |

#### Data Operation Errors
| Error Code | Description | HTTP Status |
|------------|-------------|-------------|
| `RECORD_NOT_FOUND` | Requested record does not exist | 404 |
| `RECORD_ALREADY_EXISTS` | Record exists (unique constraint) | 409 |
| `DEPENDENCY_ERROR` | Conflicts with dependencies | 409 |
| `DATABASE_ERROR` | Database operation failed | 500 |

### Error Code Naming Convention

Error codes follow `SUBJECT_FIRST` pattern for logical grouping:

- **Model errors**: `MODEL_NOT_FOUND`, `MODEL_PROTECTED`
- **Record errors**: `RECORD_NOT_FOUND`, `RECORD_ALREADY_EXISTS`
- **Auth errors**: `TENANT_MISSING`, `TOKEN_EXPIRED`
- **Request errors**: `JSON_PARSE_ERROR`, `MISSING_CONTENT_TYPE`

This enables:
- **Logical grouping**: All model errors start with `MODEL_*`
- **Easy filtering**: `errorCode.startsWith('MODEL_')`
- **Consistent sorting**: Related errors group alphabetically

### Client Error Handling Example

```javascript
try {
  const response = await fetch('/api/describe/users', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(modelData)
  });

  const result = await response.json();

  if (!result.success) {
    // Handle specific error codes
    switch (result.error_code) {
      case 'MODEL_NOT_FOUND':
        console.error('Model does not exist:', result.error);
        break;
      case 'JSON_PARSE_ERROR':
        console.error('Invalid JSON:', result.data?.details);
        break;
      case 'MODEL_PROTECTED':
        console.error('Cannot modify protected model');
        break;
      default:
        console.error('API Error:', result.error_code, result.error);
    }
  }
} catch (error) {
  console.error('Network or parsing error:', error);
}
```

### Error Handling Best Practices

1. **Check HTTP status code** for error category
2. **Use `error_code`** for specific error handling logic
3. **Display `error` message** to users when appropriate
4. **Process `data` field** for additional context
5. **Implement retry logic** for transient errors (5xx)
6. **Log errors** with correlation IDs for debugging

## Architecture Highlights

- **Ultra-Fast Performance**: Hono framework with ~50KB footprint and multi-runtime support
- **Model-Driven**: Field-based validation with automatic database DDL generation
- **Multi-Tenant**: Automatic tenant isolation via PostgreSQL schemas or SQLite files
- **Self-Documenting**: Complete API reference served via HTTP endpoints
- **Enterprise Security**: Sophisticated authentication with privilege escalation and ACL management
- **Audit Ready**: Comprehensive change tracking and history for compliance requirements
- **Advanced Querying**: Powerful filtering, aggregation, and batch operations

For detailed implementation examples, request/response formats, and integration guidance, visit the specific API documentation endpoints listed above.
