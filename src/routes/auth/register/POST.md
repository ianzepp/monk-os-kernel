# POST /auth/register

Create a new tenant with core system tables and bootstrap a full-access user. A JWT token for the new user is returned so the caller can immediately interact with protected APIs.

**Note**: The API server administrator controls the database naming mode via the `TENANT_NAMING_MODE` environment variable. This is not client-configurable for security reasons.

## Request Body

```json
{
  "tenant": "string",        // Required: Tenant identifier
  "username": "string",      // Optional: Desired username
                             //           Required when server is in enterprise mode
                             //           Defaults to 'root' when server is in personal mode
  "database": "string",      // Optional: Custom database name (only when server is in personal mode)
                             //           Defaults to sanitized tenant name if not provided
  "description": "string",   // Optional: Human-readable description of the tenant
  "adapter": "string"        // Optional: Database adapter - 'postgresql' (default) or 'sqlite'
}
```

## Server Naming Modes

The server administrator configures the database naming strategy via the `TENANT_NAMING_MODE` environment variable:

### Enterprise Mode (Default - `TENANT_NAMING_MODE=enterprise`)
- Database names are SHA256 hashes (e.g., "tenant_a1b2c3d4e5f6789a")
- Prevents collisions, opaque naming
- Any Unicode characters allowed in tenant name
- Most secure for multi-tenant SaaS deployments
- `username` parameter is **required**
- `database` parameter is **not allowed** (returns `AUTH_DATABASE_NOT_ALLOWED`)

### Personal Mode (`TENANT_NAMING_MODE=personal`)
- Database names are human-readable (e.g., "monk-irc" → "tenant_monk_irc")
- Useful for personal PaaS deployments where you control all tenants
- `username` parameter is **optional** (defaults to `'root'`)
- `database` parameter is **optional** (defaults to sanitized `tenant` name)
- Stricter tenant name validation (alphanumeric, hyphens, underscores, spaces only)

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "tenant": "string",     // Tenant name that was provisioned
    "database": "string",   // Backing database the tenant maps to
    "username": "string",   // Auth identifier for the newly created user
    "token": "string",      // JWT token for immediate access
    "expires_in": 86400     // Token lifetime in seconds (24h)
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `AUTH_TENANT_MISSING` | "Tenant is required" | Missing tenant field |
| 400 | `AUTH_USERNAME_MISSING` | "Username is required" | Missing username when server is in enterprise mode |
| 400 | `AUTH_DATABASE_NOT_ALLOWED` | "database parameter can only be specified when server is in personal mode" | database provided when server is in enterprise mode |
| 400 | `INVALID_ADAPTER` | "Invalid adapter '...'. Must be 'postgresql' or 'sqlite'" | Invalid adapter value |
| 409 | `DATABASE_TENANT_EXISTS` | "Tenant '{name}' already exists" | Tenant name already registered |
| 409 | `DATABASE_EXISTS` | "Database '{name}' already exists" | Database name collision (personal mode) |

## Example Usage

### Enterprise Mode Server

```bash
curl -X POST http://localhost:9001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "acme-corp",
    "username": "admin"
  }'
```

**Result:**
- `database = "tenant_a1b2c3d4e5f6789a"` (SHA256 hash)
- `username = "admin"`

---

### Personal Mode Server (Minimal)

```bash
curl -X POST http://localhost:9001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "monk-irc"
  }'
```

**Result:**
- `username = "root"` (default)
- `database = "tenant_monk_irc"` (sanitized from tenant name)

---

### Personal Mode Server (With Description)

```bash
curl -X POST http://localhost:9001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "monk-irc",
    "description": "IRC bridge for Slack integration"
  }'
```

**Result:**
- `username = "root"` (default)
- `database = "tenant_monk_irc"` (sanitized from tenant name)
- Description stored in tenant metadata

---

### Personal Mode Server (Custom Database)

```bash
curl -X POST http://localhost:9001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "monk-irc",
    "username": "admin",
    "database": "my-irc-bridge",
    "description": "IRC bridge for Slack integration"
  }'
```

**Result:**
- `username = "admin"`
- `database = "tenant_my_irc_bridge"` (custom name with tenant_ prefix)
- Description stored in tenant metadata

---

### Using SQLite Adapter

```bash
curl -X POST http://localhost:9001/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "tenant": "my-app",
    "username": "admin",
    "adapter": "sqlite"
  }'
```

**Result:**
- Tenant created with SQLite backend instead of PostgreSQL
- Data stored in a SQLite file rather than PostgreSQL schema

## Implementation Notes

- **Transaction Safety**: Tenant creation is atomic - either fully succeeds or fully rolls back
- **User Creation**: First user is always created with `access='root'` for administrative control
- **JWT Generation**: Token is issued immediately for seamless onboarding experience
- **Database Prefixing**: All databases get `tenant_` prefix to prevent system database collisions
- **Validation**: Tenant names validated based on mode (permissive in enterprise, strict in personal)

## Related Endpoints

- [`POST /auth/login`](../login/POST.md) - Authenticate with existing tenant
- [`GET /auth/tenants`](../tenants/GET.md) - List available tenants (personal mode)
