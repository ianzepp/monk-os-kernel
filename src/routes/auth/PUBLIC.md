# Auth API

The Auth API handles authentication and tenant registration. All endpoints are public (no JWT required) and issue tokens for accessing protected APIs.

## Base Path

`/auth/*` (no authentication required)

## Content Type

- **Request**: `application/json`
- **Response**: `application/json` (default), `text/plain` (TOON), or `application/yaml` (YAML)

## Response Formats

The Auth API supports three response formats optimized for different clients:

### Format Selection Priority

1. **Query Parameter**: `?format=json|toon|yaml` (highest priority - allows per-request override)
2. **Accept Header**: `Accept: application/json|application/toon|application/yaml`
3. **JWT Preference**: `format` field in JWT payload (set at login)
4. **Default**: JSON format

### Supported Formats

- **JSON** - Standard JSON format (default)
- **TOON** - Token-Oriented Object Notation (30-60% smaller, optimized for LLM agents)
- **YAML** - Human-readable format (ideal for configuration and DevOps tools)

Set persistent format preference by including `format` field in login request. The JWT token will include this preference for all subsequent API calls unless overridden.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | [`/auth/login`](login/POST.md) | Authenticate against an existing tenant and issue a JWT token. |
| POST | [`/auth/refresh`](refresh/POST.md) | Exchange an existing token for a fresh one with the same scope. |
| POST | [`/auth/register`](register/POST.md) | Provision a new tenant and return an initial token. |
| GET | [`/auth/tenants`](tenants/GET.md) | List available tenants (personal mode only). |

## Token Lifecycle

1. **Login**: Get initial JWT token with [`POST /auth/login`](login/POST.md)
2. **Use token**: Access protected APIs with Bearer token in Authorization header
3. **Refresh**: When token nears expiration, use [`POST /auth/refresh`](refresh/POST.md)
4. **Logout**: Tokens are stateless - simply discard client-side

## Server Modes

The server administrator configures the naming mode via `TENANT_NAMING_MODE` environment variable:

### Enterprise Mode (Default)
- Database names are SHA256 hashes for security
- `username` required in registration
- Tenant/template listing disabled (403 error)
- Optimal for multi-tenant SaaS deployments

### Personal Mode
- Database names are human-readable
- `username` optional in registration (defaults to 'root')
- Tenant/template listing enabled
- Optimal for personal PaaS deployments

## Quick Start

### Standard JSON Integration

```bash
# 1. Login and get token
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"tenant": "my-company", "username": "john.doe"}'

# 2. Use token for API calls
curl -X GET http://localhost:9001/api/data/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 3. Refresh when needed
curl -X POST http://localhost:9001/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"token": "YOUR_JWT_TOKEN"}'
```

### LLM Agent Integration (TOON Format)

```bash
# 1. Login with TOON format preference
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"tenant": "my-company", "username": "llm-agent", "format": "toon"}'

# 2. All API calls now return TOON format automatically
curl -X GET http://localhost:9001/api/describe \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response: success: true
#           data[4]: fields,definitions,models,users

# 3. Override to JSON for specific calls
curl -X GET "http://localhost:9001/api/describe?format=json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Related Documentation

- **User API**: `/docs/user` - User identity and account management
- **Sudo API**: `/docs/sudo` - Privilege escalation and user impersonation
- **Data API**: [`../data/PUBLIC.md`](../data/PUBLIC.md) - Working with model-backed data
- **Describe API**: [`../describe/PUBLIC.md`](../describe/PUBLIC.md) - Managing models
