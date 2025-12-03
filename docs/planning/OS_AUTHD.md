# Auth Daemon (authd)

Identity and authentication service for Monk OS.

## Philosophy

Authentication is an OS-level concern, not an application concern. When a request arrives with a JWT, the OS itself validates it and establishes the execution context: identity, tenant, VFS mounts, ACL grants.

The OS is a library that someone boots. Whoever boots it configures auth strategy. authd executes whatever was configured.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Pre-boot Configuration (external to OS)                        │
│  - JWT signing keys                                              │
│  - Auth provider settings (SMTP, OAuth credentials)             │
│  - Written to /etc/auth/ at boot                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  OS Boot                                                         │
│  os.on('auth', (os) => {                                        │
│    os.auth.configure({ provider: 'magic-link', ... });          │
│  });                                                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  authd (boot-activated service)                                  │
│  - Reads /etc/auth/config.json                                  │
│  - Implements configured provider(s)                            │
│  - Issues and validates JWTs                                    │
│  - Writes user records via setstat()                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  httpd / jsond                                                   │
│  - Auth endpoints delegate to authd                             │
│  - Validated identity passed to OS kernel per-request           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  OS Kernel                                                       │
│  - Receives identity context                                     │
│  - Mounts tenant-specific VFS                                   │
│  - Applies ACL grants to all operations                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Boot-Time Configuration

```typescript
import { OS } from '@monk-api/os';

const os = new OS()
  .on('auth', (os) => {
    os.auth.configure({
      // JWT settings (keys provided externally)
      jwt: {
        secret: process.env.JWT_SECRET,
        // Or asymmetric
        publicKey: process.env.JWT_PUBLIC_KEY,
        privateKey: process.env.JWT_PRIVATE_KEY,
        issuer: 'myapp.com',
        audience: 'myapp.com',
        ttl: 3600,        // 1 hour
        refreshTtl: 86400 // 24 hours
      },

      // Auth provider
      provider: 'magic-link',
      magicLink: {
        smtp: process.env.SMTP_URL,
        from: 'auth@myapp.com',
        subject: 'Sign in to MyApp',
        tokenTtl: 600,  // 10 minutes
      },

      // Or OAuth (can have multiple)
      // provider: 'oauth',
      // oauth: {
      //   google: { clientId: '...', clientSecret: '...' },
      //   github: { clientId: '...', clientSecret: '...' },
      // },
    });
  });

await os.boot();
```

Configuration written to `/etc/auth/config.json` for authd to read.

---

## User Model

Users are OS files. The VFS "files are rows" philosophy means user records are files with queryable attributes via `setstat()`.

```
/etc/users/
├── {user-uuid-1}      # User file
├── {user-uuid-2}
└── ...
```

### User File Attributes (via stat/setstat)

```typescript
interface UserStat {
  // Standard file fields
  id: string;           // UUID
  name: string;         // email or username (unique)
  model: 'user';        // VFS model type

  // User-specific fields
  email: string;
  tenant: string;       // Tenant ID
  status: 'active' | 'suspended' | 'pending';
  created: number;      // Unix timestamp
  lastLogin: number;

  // Optional profile
  displayName?: string;
  avatar?: string;
}
```

### User Operations

```typescript
// Create user (authd)
const userId = await create('/etc/users', 'user', {
  name: email,
  email: email,
  tenant: tenantId,
  status: 'active',
});

// Update user
await setstat(`/etc/users/${userId}`, {
  lastLogin: Date.now(),
});

// Query users (BeOS-style)
for await (const user of query('/etc/users', { tenant: 'acme' })) {
  // ...
}
```

---

## authd Operations

| Op | Input | Output | Description |
|----|-------|--------|-------------|
| `auth:begin` | `{ provider, email?, redirect? }` | `{ ok }` or `{ url }` | Start auth flow |
| `auth:callback` | `{ provider, token?, code? }` | `{ jwt, user }` | Complete auth flow |
| `auth:validate` | `{ jwt }` | `{ user, grants }` | Validate JWT, return identity |
| `auth:refresh` | `{ jwt }` | `{ jwt }` | Issue new JWT |
| `auth:revoke` | `{ jwt }` or `{ userId }` | `{ ok }` | Invalidate token/session |

### auth:begin (Magic Link)

```typescript
// Input
{ provider: 'magic-link', email: 'ian@example.com' }

// authd:
// 1. Find or create user by email
// 2. Generate short-lived token
// 3. Store token in /var/auth/tokens/{token}
// 4. Send email with link

// Output
{ op: 'ok' }
```

### auth:callback (Magic Link)

```typescript
// Input
{ provider: 'magic-link', token: 'abc123' }

// authd:
// 1. Look up /var/auth/tokens/{token}
// 2. Verify not expired
// 3. Get user ID from token
// 4. Delete token (single use)
// 5. Update user.lastLogin
// 6. Issue JWT

// Output
{
  op: 'ok',
  data: {
    jwt: 'eyJ...',
    user: { id, email, tenant }
  }
}
```

### auth:validate

```typescript
// Input
{ jwt: 'eyJ...' }

// authd:
// 1. Verify JWT signature (using configured key)
// 2. Check expiry
// 3. Extract claims
// 4. Load user from /etc/users/{sub}
// 5. Load grants for user

// Output
{
  op: 'ok',
  data: {
    user: { id, email, tenant, status },
    grants: [
      { path: '/vol/acme/**', ops: ['read', 'list'] },
      { path: '/home/{user-id}/**', ops: ['*'] }
    ]
  }
}
```

---

## JWT Structure

```typescript
// Header
{ alg: 'HS256', typ: 'JWT' }

// Payload
{
  iss: 'myapp.com',          // Issuer (from config)
  aud: 'myapp.com',          // Audience (from config)
  sub: 'user-uuid',          // User ID
  tenant: 'acme',            // Tenant ID
  iat: 1699900000,           // Issued at
  exp: 1699903600,           // Expiry

  // Optional claims (denormalized for performance)
  email: 'ian@example.com',
  roles: ['admin'],
}
```

Grants are NOT in JWT - looked up from OS at validation time. This allows real-time permission changes without token reissue.

---

## httpd Auth Endpoints

httpd provides HTTP surface, delegates to authd:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/login` | GET | Render login form |
| `/auth/login` | POST | `{ email }` → authd:begin |
| `/auth/callback` | GET | `?token=xxx` → authd:callback |
| `/auth/oauth/:provider` | GET | Redirect to OAuth provider |
| `/auth/oauth/callback` | GET | `?code=xxx` → authd:callback |
| `/auth/refresh` | POST | authd:refresh |
| `/auth/logout` | POST | authd:revoke, clear cookie |

---

## Request Authentication Flow

```
1. Request arrives at httpd
   GET /api/orders
   Cookie: token=eyJ... (or Authorization: Bearer eyJ...)

2. httpd extracts JWT, calls authd
   authd:validate { jwt: 'eyJ...' }

3. authd validates, returns identity
   { user: { id, email, tenant }, grants: [...] }

4. httpd establishes OS request context
   - Sets process identity
   - Kernel mounts tenant VFS: /vol/{tenant} → tenant's data
   - Kernel loads ACL grants

5. Handler executes with constrained access
   - All syscalls filtered through grants
   - VFS operations scoped to tenant
```

---

## Directory Structure

```
/etc/
├── auth/
│   └── config.json           # Auth configuration (from boot)
├── users/
│   ├── {uuid}/               # User files (model: user)
│   └── ...
└── grants/
    ├── {user-uuid}.json      # Per-user grants
    └── {role}.json           # Role-based grants

/var/
└── auth/
    ├── tokens/               # Magic link tokens (ephemeral)
    │   └── {token} → { userId, expires }
    └── sessions/             # Active sessions (optional)
        └── {session-id} → { userId, jwt, created }
```

---

## Service Definition

```json
{
  "handler": "/sbin/authd",
  "activate": {
    "type": "boot"
  },
  "io": {
    "stdin": { "type": "pubsub", "subscribe": ["auth.*"] },
    "stdout": { "type": "console" },
    "stderr": { "type": "console" }
  }
}
```

---

## Providers

### Magic Link (Initial)

Passwordless email authentication.

```typescript
interface MagicLinkConfig {
  smtp: string;           // SMTP URL
  from: string;           // From address
  subject?: string;       // Email subject
  tokenTtl?: number;      // Token lifetime (default: 600s)
  template?: string;      // Email template path
}
```

### OAuth (Future)

```typescript
interface OAuthConfig {
  [provider: string]: {
    clientId: string;
    clientSecret: string;
    scopes?: string[];
    authUrl?: string;     // Override for custom providers
    tokenUrl?: string;
  };
}
```

### API Key (Future)

For service-to-service auth.

```typescript
interface ApiKeyConfig {
  keys: string;           // Path to keys file
  header?: string;        // Header name (default: X-API-Key)
}
```

---

## Open Questions

### Tenant Provisioning

When a new user signs up:
1. Who creates the tenant?
2. Who creates the user's home directory?
3. Who sets initial grants?

Options:
- authd handles it (knows about new users)
- Separate `tenantd` service
- Application-level onboarding handler
- Boot-time hook for provisioning logic

### Session Storage

Where do sessions live?
- VFS files (`/var/auth/sessions/`) - simple, queryable
- Memory only - lost on restart
- External store - for horizontal scaling

For single-instance: VFS files seem natural.

### Multi-tenancy Model

Is tenant:
- A field on user (user belongs to one tenant)?
- A separate entity (users can belong to multiple)?
- Implicit from auth provider (OAuth org)?

### Grant Inheritance

How do grants compose?
- User grants + role grants?
- Tenant-level defaults?
- Path-based inheritance?

---

## Future Work

- [ ] OAuth provider support
- [ ] API key provider
- [ ] Session management UI
- [ ] Token revocation lists
- [ ] Rate limiting per-user
- [ ] Audit logging (auth events)
- [ ] Multi-factor authentication
- [ ] Invite/signup flows
- [ ] Password provider (if needed)
