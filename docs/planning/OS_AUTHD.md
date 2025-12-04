# Auth Daemon (authd)

> **Status**: Planning
> **Complexity**: High (multiple phases)
> **Package**: `@anthropic/monk-authd`
> **Dependencies**: `@anthropic/monk-smtpd` (for magic links)

Identity and authentication service for Monk OS.

**Note**: This is a userspace service installed via `os.install()`, not built into the core OS. See `OS_SERVICES.md` for the service architecture.

---

## Feasibility Assessment

### Infrastructure Already Implemented

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Service infrastructure | ✅ | `services.ts` with boot activation |
| Pubsub messaging | ✅ | `PubsubPort` for `auth.*` topics |
| VFS for user/token storage | ✅ | EMS with entities table |
| HTTP client channel | ✅ | `BunHttpChannel` for OAuth callbacks |
| TCP listener | ✅ | `ListenerPort` (for future httpd) |

### What's Missing

| Requirement | Status | Complexity | Notes |
|-------------|--------|------------|-------|
| JWT sign/verify | ❌ | Low | Use `jose` library or Bun crypto |
| SMTP channel | ❌ | Medium | New `BunSmtpChannel` for magic links |
| `user` model in EMS | ❌ | Low | Add table + fields to schema.sql |
| httpd (HTTP server) | ❌ | High | Full HTTP server daemon |
| Per-request identity | ❌ | High | Kernel process context changes |
| ACL enforcement | ❌ | High | Syscall-level grant checking |
| Tenant VFS isolation | ❌ | High | Dynamic per-request mounts |

### Risk Assessment

| Component | Risk | Mitigation |
|-----------|------|------------|
| authd core | Low | Follows existing service patterns |
| JWT handling | Low | Well-understood, libraries exist |
| SMTP | Medium | External dependency, deliverability issues |
| httpd | Medium | Significant new code, but clear scope |
| Kernel ACL | High | Touches every syscall, perf impact |
| Tenant isolation | High | Requires kernel architecture changes |

---

## Implementation Phases

### Phase 1: Foundation (No Breaking Changes)

Add infrastructure without changing existing code.

**1.1 JWT Utilities**

```typescript
// src/hal/crypto/jwt.ts
export interface JwtConfig {
    secret?: string;          // HS256
    publicKey?: string;       // RS256/ES256
    privateKey?: string;
    issuer: string;
    audience: string;
    ttl: number;              // seconds
}

export interface JwtPayload {
    sub: string;              // user ID
    tenant?: string;
    email?: string;
    roles?: string[];
    iat: number;
    exp: number;
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, config: JwtConfig): Promise<string>;
export function verifyJwt(token: string, config: JwtConfig): Promise<JwtPayload>;
export function decodeJwt(token: string): JwtPayload;  // no verification
```

**1.2 User Model in EMS**

Add to `src/ems/schema.sql`:

```sql
-- User entity table
CREATE TABLE IF NOT EXISTS user (
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- User fields
    owner       TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    tenant      TEXT,
    status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
    last_login  TEXT,
    display_name TEXT,
    avatar      TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_email ON user(email);
CREATE INDEX IF NOT EXISTS idx_user_tenant ON user(tenant);

-- Seed user model
INSERT OR IGNORE INTO models (model_name, status, description, pathname) VALUES
    ('user', 'system', 'User account entity', 'email');

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('user', 'email', 'text', 1, 'User email address (unique)'),
    ('user', 'tenant', 'text', 0, 'Tenant ID'),
    ('user', 'status', 'text', 0, 'Account status'),
    ('user', 'last_login', 'timestamp', 0, 'Last login timestamp'),
    ('user', 'display_name', 'text', 0, 'Display name'),
    ('user', 'avatar', 'text', 0, 'Avatar URL');
```

**1.3 Auth Token Model**

```sql
-- Auth tokens (magic links, password resets, etc.)
CREATE TABLE IF NOT EXISTS auth_token (
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    owner       TEXT NOT NULL,              -- user ID
    token       TEXT NOT NULL UNIQUE,       -- the token value
    token_type  TEXT NOT NULL,              -- 'magic-link', 'password-reset', etc.
    expires_at  TEXT NOT NULL               -- expiration timestamp
);

CREATE INDEX IF NOT EXISTS idx_auth_token_token ON auth_token(token);
```

### Phase 2: authd Core

Implement authd as a standalone service using pubsub.

**2.1 Service Definition**

```json
// /etc/services/authd.json
{
  "handler": "/sbin/authd.ts",
  "activate": { "type": "boot" },
  "io": {
    "stdin": { "type": "pubsub", "subscribe": ["auth.*"] },
    "stdout": { "type": "console" },
    "stderr": { "type": "console" }
  }
}
```

**2.2 authd Implementation**

```typescript
// rom/sbin/authd.ts
import { recv, send } from '/lib/process';
import { signJwt, verifyJwt } from '/lib/crypto/jwt';

// Read config from /etc/auth/config.json
const config = JSON.parse(await readFile('/etc/auth/config.json'));

// Main loop - handle auth.* messages
for await (const msg of recv(stdin)) {
    const topic = msg.from;  // e.g., 'auth.validate'
    const data = msg.meta;

    try {
        switch (topic) {
            case 'auth.validate':
                await handleValidate(data, msg.replyTo);
                break;
            case 'auth.begin':
                await handleBegin(data, msg.replyTo);
                break;
            case 'auth.callback':
                await handleCallback(data, msg.replyTo);
                break;
            // ...
        }
    } catch (err) {
        await send(msg.replyTo, { error: err.message });
    }
}
```

**2.3 Calling authd from Application**

```typescript
// Any process can call authd via pubsub
import { port, send, recv } from '/lib/process';

const authPort = await port('pubsub', { subscribe: ['auth.response.*'] });
const requestId = crypto.randomUUID();

// Send request
await send('auth.validate', { jwt: token, replyTo: `auth.response.${requestId}` });

// Wait for response
const response = await recv(authPort);
if (response.meta.error) {
    throw new Error(response.meta.error);
}
const { user, grants } = response.meta;
```

### Phase 3: SMTP Channel (for Magic Links)

**3.1 SMTP Channel**

```typescript
// src/hal/channel/smtp.ts
export class BunSmtpChannel implements Channel {
    readonly proto = 'smtp';

    constructor(url: string, opts?: ChannelOpts) {
        // Parse smtp://user:pass@host:port
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        // msg.op = 'send'
        // msg.data = { to, subject, text, html }

        // Use nodemailer or direct SMTP
        // Bun doesn't have built-in SMTP, need library
    }
}
```

**3.2 Magic Link Flow**

```typescript
// In authd
async function handleBegin(data: { email: string }, replyTo: string) {
    // 1. Find or create user
    let user = await findUserByEmail(data.email);
    if (!user) {
        user = await createUser({ email: data.email, status: 'pending' });
    }

    // 2. Generate token
    const token = crypto.randomUUID();
    await createAuthToken({
        owner: user.id,
        token,
        token_type: 'magic-link',
        expires_at: new Date(Date.now() + config.magicLink.tokenTtl * 1000).toISOString(),
    });

    // 3. Send email
    const smtp = await channel.open('smtp', config.magicLink.smtp);
    await channel.call(smtp, {
        op: 'send',
        data: {
            to: data.email,
            subject: config.magicLink.subject,
            text: `Click here to sign in: ${config.magicLink.baseUrl}/auth/callback?token=${token}`,
        },
    });
    await channel.close(smtp);

    // 4. Reply
    await send(replyTo, { ok: true });
}
```

### Phase 4: httpd (HTTP Server)

Create HTTP server daemon that exposes auth endpoints.

**4.1 httpd Service**

```json
// /etc/services/httpd.json
{
  "handler": "/sbin/httpd.ts",
  "activate": { "type": "tcp:listen", "port": 8080 }
}
```

**4.2 Auth Routes**

```typescript
// In httpd
const routes = {
    'POST /auth/login': async (req) => {
        const { email } = await req.json();
        await sendToPubsub('auth.begin', { email, provider: 'magic-link' });
        return { ok: true };
    },

    'GET /auth/callback': async (req) => {
        const token = req.url.searchParams.get('token');
        const result = await callAuthd('auth.callback', { token, provider: 'magic-link' });

        // Set cookie and redirect
        return new Response(null, {
            status: 302,
            headers: {
                'Location': '/',
                'Set-Cookie': `token=${result.jwt}; HttpOnly; Secure; SameSite=Strict`,
            },
        });
    },

    // ... other routes
};
```

### Phase 5: Kernel Integration (Future)

These require significant kernel changes and should be separate planning docs.

**5.1 Per-Request Identity Context**

```typescript
// Kernel would need to track identity per-process
interface ProcessContext {
    pid: number;
    identity?: {
        userId: string;
        tenant?: string;
        grants: Grant[];
    };
}

// Syscall handlers would check grants
async function handleOpen(proc: Process, path: string, flags: OpenFlags) {
    const grants = proc.context.identity?.grants ?? [];
    if (!checkGrant(grants, path, 'read')) {
        throw new EACCES('Permission denied');
    }
    // ... proceed with open
}
```

**5.2 Tenant VFS Isolation**

```typescript
// Dynamic mount per request
kernel.mount(`/vol/${tenant}`, tenantStorageEngine);

// Or path rewriting
function resolvePath(proc: Process, path: string): string {
    if (path.startsWith('/data/')) {
        return `/tenants/${proc.context.identity.tenant}${path}`;
    }
    return path;
}
```

---

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
│  - Writes user records via EMS                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  httpd (Phase 4)                                                 │
│  - Auth endpoints delegate to authd via pubsub                  │
│  - Validated identity passed to request handlers                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  OS Kernel (Phase 5 - Future)                                    │
│  - Receives identity context                                     │
│  - Mounts tenant-specific VFS                                   │
│  - Applies ACL grants to all operations                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Installation & Configuration

authd is installed and started post-boot via the service API:

```typescript
import { OS } from '@anthropic/monk-os';

const os = new OS();
await os.boot();

// Install services (from npm peer dependencies)
await os.install('@anthropic/monk-smtpd');
await os.install('@anthropic/monk-authd');

// Start SMTP first (authd uses it for magic links)
await os.service('start', 'smtpd', {
    smtp: process.env.SMTP_URL,
    from: 'noreply@myapp.com',
});

// Start authd with config
await os.service('start', 'authd', {
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

    provider: 'magic-link',
    magicLink: {
        baseUrl: 'https://myapp.com',
        subject: 'Sign in to MyApp',
        tokenTtl: 600,  // 10 minutes
    },
});
```

Config is written to `/etc/authd/config.json` by the service manager.

---

## User Model

Users are EMS entities. The "files are rows" philosophy means user records are queryable via EntityOps.

```
/etc/users/
├── {user-uuid-1}      # User entity
├── {user-uuid-2}
└── ...
```

### User Entity Fields

```typescript
interface UserEntity {
    // System fields (from EMS)
    id: string;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;

    // User fields
    email: string;
    tenant?: string;
    status: 'active' | 'suspended' | 'pending';
    last_login?: string;
    display_name?: string;
    avatar?: string;
}
```

### User Operations (via EMS)

```typescript
// Create user
const [user] = await collect(ems.createAll('user', [{
    email: 'ian@example.com',
    tenant: 'acme',
    status: 'active',
}]));

// Update user
await collect(ems.updateIds('user', [userId], {
    last_login: new Date().toISOString(),
}));

// Query users
for await (const user of ems.selectAny('user', {
    where: { tenant: { $eq: 'acme' } }
})) {
    console.log(user.email);
}
```

---

## authd Operations

| Op | Input | Output | Phase |
|----|-------|--------|-------|
| `auth:validate` | `{ jwt }` | `{ user, grants }` | 2 |
| `auth:begin` | `{ provider, email }` | `{ ok }` | 2-3 |
| `auth:callback` | `{ provider, token }` | `{ jwt, user }` | 2-3 |
| `auth:refresh` | `{ jwt }` | `{ jwt }` | 2 |
| `auth:revoke` | `{ jwt }` or `{ userId }` | `{ ok }` | 2 |

### auth:validate

```typescript
// Input
{ jwt: 'eyJ...' }

// authd:
// 1. Verify JWT signature (using configured key)
// 2. Check expiry
// 3. Extract claims
// 4. Load user from EMS
// 5. Load grants for user (Phase 5)

// Output
{
  user: { id, email, tenant, status },
  grants: [
    { path: '/vol/acme/**', ops: ['read', 'list'] },
    { path: '/home/{user-id}/**', ops: ['*'] }
  ]
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

## Directory Structure

```
/etc/
├── auth/
│   └── config.json           # Auth configuration (from boot)
├── users/                    # User entities (EMS)
│   └── ...
├── services/
│   ├── authd.json            # authd service definition
│   └── httpd.json            # httpd service definition (Phase 4)
└── grants/                   # Grant definitions (Phase 5)
    ├── {user-uuid}.json
    └── {role}.json

/var/
└── auth/
    ├── tokens/               # Auth tokens (EMS - ephemeral)
    └── sessions/             # Active sessions (optional)
```

---

## Providers

### Magic Link (Phase 2-3)

Passwordless email authentication.

```typescript
interface MagicLinkConfig {
    smtp: string;           // SMTP URL
    from: string;           // From address
    subject?: string;       // Email subject
    tokenTtl?: number;      // Token lifetime (default: 600s)
    baseUrl: string;        // Base URL for callback links
}
```

### API Key (Phase 2)

For service-to-service auth. Simpler than magic link - no SMTP needed.

```typescript
interface ApiKeyConfig {
    // API keys stored in /etc/auth/api-keys.json
    // Format: { "key-id": { key: "xxx", userId: "yyy", grants: [...] } }
}
```

### OAuth (Future)

```typescript
interface OAuthConfig {
    [provider: string]: {
        clientId: string;
        clientSecret: string;
        scopes?: string[];
    };
}
```

---

## Open Questions

### Resolved

| Question | Decision |
|----------|----------|
| Where do users live? | EMS `user` table |
| How does authd communicate? | Pubsub (`auth.*` topics) |
| Service activation? | Boot-activated |

### Still Open

| Question | Options | Notes |
|----------|---------|-------|
| Tenant provisioning | authd vs separate service | authd knows about new users |
| Grant storage | VFS files vs EMS table | EMS table probably cleaner |
| Multi-tenancy model | Single vs multi-tenant per user | Start with single |
| Session storage | VFS vs memory | VFS for persistence |

---

## References

- `src/kernel/services.ts` - Service infrastructure
- `src/kernel/resource/pubsub-port.ts` - Pubsub messaging
- `src/ems/schema.sql` - EMS schema (add user table here)
- `src/hal/channel/http.ts` - HTTP client (for OAuth)
