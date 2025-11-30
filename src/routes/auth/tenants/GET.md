# GET /auth/tenants

List all available tenants (personal mode only). This endpoint provides tenant discovery for personal PaaS deployments where a single administrator manages multiple tenants.

**Security Note**: This endpoint is only available when the server is running in `TENANT_NAMING_MODE=personal`. In enterprise mode, it returns a 403 error to prevent tenant enumeration in multi-tenant SaaS environments.

## Request Body

None - GET request with no body.

## Success Response (200)

```json
{
  "success": true,
  "data": [
    {
      "name": "monk-irc",
      "description": "IRC bridge for Slack integration",
      "users": ["root", "admin"]
    },
    {
      "name": "my-app",
      "description": null,
      "users": ["root"]
    },
    {
      "name": "test-tenant",
      "description": "Testing environment",
      "users": ["root", "testuser"]
    }
  ]
}
```

## Response Fields

- **name** (string): The tenant identifier used for login
- **description** (string|null): Optional human-readable description
- **users** (string[]): Array of available usernames for login (sorted alphabetically)

## Filtering

The endpoint automatically filters results:

- Only returns active tenants (`is_active = true`)
- Excludes template tenants (`tenant_type = 'normal'`)
- Excludes soft-deleted tenants (`trashed_at IS NULL`)
- Excludes hard-deleted tenants (`deleted_at IS NULL`)
- Tenants sorted alphabetically by name
- Users array: Limited to 10 users per tenant, sorted by creation date (oldest first)
- Users array includes only active, non-deleted users

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 403 | `AUTH_TENANT_LIST_NOT_AVAILABLE` | "Tenant listing is only available in personal mode" | Server is in enterprise mode |

## Example Usage

### List All Tenants

```bash
curl -X GET http://localhost:9001/auth/tenants
```

### Extract Tenant Names with jq

```bash
curl -X GET http://localhost:9001/auth/tenants | jq -r '.data[].name'
```

**Output:**
```
monk-irc
my-app
test-tenant
```

### Get Tenants with Descriptions

```bash
curl -X GET http://localhost:9001/auth/tenants | jq '.data[] | {name, description}'
```

**Output:**
```json
{
  "name": "monk-irc",
  "description": "IRC bridge for Slack integration"
}
{
  "name": "my-app",
  "description": null
}
{
  "name": "test-tenant",
  "description": "Testing environment"
}
```

## Use Cases

- **Tenant discovery**: List available tenants before login
- **Admin tools**: Build management interfaces for personal PaaS
- **CLI integration**: Provide autocomplete for tenant selection
- **Documentation**: Generate tenant inventory
- **Onboarding**: Show new users which tenants they can access

## Integration Examples

### CLI Tenant Selector

```bash
#!/bin/bash
# Select tenant from available list

echo "Available tenants:"
TENANTS=$(curl -s http://localhost:9001/auth/tenants | jq -r '.data[].name')
select TENANT in $TENANTS; do
  if [ -n "$TENANT" ]; then
    echo "Selected: $TENANT"
    break
  fi
done
```

### JavaScript Tenant Picker

```javascript
async function loadTenants() {
  try {
    const response = await fetch('/auth/tenants');
    const { data } = await response.json();

    return data.map(tenant => ({
      value: tenant.name,
      label: tenant.description || tenant.name,
      users: tenant.users
    }));
  } catch (error) {
    if (error.status === 403) {
      console.log('Tenant listing not available in enterprise mode');
    }
    return [];
  }
}

// Use in UI
const tenants = await loadTenants();
renderTenantDropdown(tenants);
```

## Personal vs Enterprise Mode

### Personal Mode (TENANT_NAMING_MODE=personal)
- ✅ Endpoint available
- Returns all active tenants
- Useful for single-user PaaS deployments
- Tenant names are human-readable

### Enterprise Mode (TENANT_NAMING_MODE=enterprise)
- ❌ Endpoint blocked (403 error)
- Prevents tenant enumeration attacks
- Multi-tenant SaaS security
- Clients must know tenant name to login

## Related Endpoints

- [`POST /auth/login`](../login/POST.md) - Login to a specific tenant
- [`POST /auth/register`](../register/POST.md) - Create a new tenant
