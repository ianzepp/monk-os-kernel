# POST /auth/refresh

Exchange an existing JWT token (even if expired) for a new token while preserving the original tenant, user, and access scope. The refresh route validates signature integrity, re-hydrates the user context, and re-issues a token with a new expiration window.

## Request Body

```json
{
  "token": "string"    // Required: Current JWT token (may be expired)
}
```

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600
  }
}
```

## Error Responses

| Status | Error Code | Message | Condition |
|--------|------------|---------|-----------|
| 400 | `AUTH_TOKEN_REQUIRED` | "Token is required for refresh" | Missing token field |
| 401 | `AUTH_TOKEN_INVALID` | "Invalid token" | Invalid or corrupted token signature |
| 401 | `AUTH_TOKEN_EXPIRED` | "Token has expired" | Token expired and cannot be refreshed (user/tenant deleted) |

## Token Refresh Behavior

The refresh endpoint accepts tokens in three states:

1. **Valid, unexpired token** - Refreshes successfully with new expiration
2. **Expired token with valid signature** - Refreshes if user/tenant still exists
3. **Invalid signature or corrupted token** - Returns `AUTH_TOKEN_INVALID` error

**Important:** Refresh validates that the user and tenant still exist in the database. If either has been deleted, refresh fails with `AUTH_TOKEN_EXPIRED` even if the signature is valid.

## Example Usage

### Basic Token Refresh

```bash
curl -X POST http://localhost:9001/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }'
```

### Automatic Refresh Flow

```javascript
async function fetchWithRefresh(url, options = {}) {
  let token = localStorage.getItem('access_token');

  // Try request with current token
  let response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });

  // If unauthorized, try refreshing token
  if (response.status === 401) {
    const refreshResponse = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });

    if (refreshResponse.ok) {
      const { token: newToken } = (await refreshResponse.json()).data;
      localStorage.setItem('access_token', newToken);

      // Retry original request with new token
      response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          'Authorization': `Bearer ${newToken}`
        }
      });
    } else {
      // Refresh failed - redirect to login
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  return response;
}
```

## Token Lifecycle Management

```javascript
// Set up automatic refresh before expiration
function setupAutoRefresh() {
  const token = localStorage.getItem('access_token');

  // Decode JWT to get expiration (without verification)
  const payload = JSON.parse(atob(token.split('.')[1]));
  const expiresAt = payload.exp * 1000; // Convert to milliseconds
  const now = Date.now();

  // Refresh 5 minutes before expiration
  const refreshIn = expiresAt - now - (5 * 60 * 1000);

  if (refreshIn > 0) {
    setTimeout(async () => {
      try {
        const response = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });

        if (response.ok) {
          const { token: newToken } = (await response.json()).data;
          localStorage.setItem('access_token', newToken);
          setupAutoRefresh(); // Schedule next refresh
        }
      } catch (error) {
        console.error('Auto-refresh failed:', error);
      }
    }, refreshIn);
  }
}

// Call after login or page load
setupAutoRefresh();
```

## Security Considerations

- **Token reuse prevention**: Each refresh generates a completely new token
- **Signature validation**: Refresh validates JWT signature before issuing new token
- **User validation**: Confirms user and tenant still exist in database
- **No credential exposure**: Refresh doesn't require username/password
- **Expiration extension**: New token gets full 24-hour lifetime

## Related Endpoints

- [`POST /auth/login`](../login/POST.md) - Initial authentication
- [`GET /api/user/whoami`](../../api/user/whoami/GET.md) - Verify token is valid
