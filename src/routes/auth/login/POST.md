# POST /auth/login

Authenticate a user against an existing tenant and receive a fresh JWT token scoped to that tenant. The login route validates the credentials, resolves tenant routing metadata, and issues the token that enables access to protected `/api/*` routes.

## Request Body

```json
{
  "tenant": "string",     // Required: Tenant identifier
  "username": "string",   // Required: Username for authentication
  "format": "string"      // Optional: Preferred response format ("json", "toon", or "yaml")
}
```

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "username": "john.doe",
      "tenant": "my-company",
      "database": "tenant_a1b2c3d4",
      "access": "full",
      "format": "toon"  // Included if format was provided in request
    },
    "expires_in": 3600
  }
}
```

**Note:** The `format` field in the response echoes back the preference you provided. This preference is embedded in the JWT token and will be used for all subsequent API requests unless overridden.

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `AUTH_TENANT_MISSING` | "Tenant is required" | Missing tenant field |
| 400 | `AUTH_USERNAME_MISSING` | "Username is required" | Missing username field |
| 401 | `AUTH_LOGIN_FAILED` | "Authentication failed" | Invalid credentials or tenant not found |

## Example Usage

### Basic Login

```bash
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "my-company",
    "username": "john.doe"
  }'
```

### Login with Format Preference

```bash
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "my-company",
    "username": "john.doe",
    "format": "toon"
  }'
```

**Result:** All subsequent API calls using this token will return TOON format by default.

## Response Format Preference

The optional `format` field sets a persistent response format preference for all API calls made with the returned JWT token:

- **`format: "json"`** - Standard JSON (default)
- **`format: "toon"`** - Token-Oriented Object Notation (30-60% smaller, optimized for LLM agents)
- **`format: "yaml"`** - YAML format (human-readable, ideal for DevOps tools)

### Format Priority

When making API requests with the token, format is determined by:

1. **Query parameter** `?format=json|toon|yaml` (highest priority - per-request override)
2. **Accept header** `Accept: application/json|application/toon|application/yaml`
3. **JWT preference** (set during login)
4. **Default** (JSON)

## Integration Example

```javascript
// Login and store token
const loginResponse = await fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tenant: 'acme',
    username: 'john.doe',
    format: 'json'  // Optional: set default format
  })
});

const { token, user } = (await loginResponse.json()).data;
localStorage.setItem('access_token', token);

// Use token for API calls
const apiResponse = await fetch('/api/data/users', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

## Related Endpoints

- [`POST /auth/refresh`](../refresh/POST.md) - Refresh an existing token
- [`POST /auth/register`](../register/POST.md) - Create new tenant and user
- [`GET /auth/tenants`](../tenants/GET.md) - List available tenants (personal mode)
- [`GET /api/user/whoami`](../../api/user/whoami/GET.md) - Get current user info
