# Authentication Subsystem

> **Status**: Proposed
> **Complexity**: Medium
> **Dependencies**: EMS (session storage), Gateway (process identity)

Add authentication as a peer subsystem alongside VFS/EMS/Kernel, with mandatory auth for external clients via gateway.

**Key design point:** Auth handles *identity* ("who are you?"), not *authorization* ("what can you do?"). Authorization is already implemented via the ACL system in `src/vfs/acl.ts`. Auth populates `proc.user`, VFS/EMS check it against ACLs.

---

## Motivation

Currently:
- Gateway creates anonymous virtual processes for each connection
- No authentication - anyone who can reach the Unix socket can make syscalls
- No identity tracking for logging, permissions, or audit

External clients (os-sdk) need to authenticate before accessing OS resources.

---

## Architecture

Auth is a **peer subsystem**, not a layer:

```
┌─────────────────────────────────────────────────────────────┐
│  Syscall Dispatcher                                         │
├─────────────────────────────────────────────────────────────┤
│  Kernel    │    VFS    │    EMS    │    Auth   │    HAL    │
│  (proc)    │  (files)  │ (entities)│ (identity)│ (devices) │
└─────────────────────────────────────────────────────────────┘
```

**Auth responsibilities:**
- Handle `auth:*` syscalls
- Validate credentials (password, JWT, API key)
- Store sessions in EMS
- Set `proc.user` and `proc.session` on success

**Auth does NOT:**
- Intercept other syscalls (dispatcher gates)
- Own the permission model (VFS/EMS check `proc.user`)
- Manage processes (kernel does that)

---

## Process Identity

Extend Process with identity fields:

```typescript
interface Process {
    id: string;              // UUID (exists)
    user?: string;           // User ID (null = anonymous)
    groups?: string[];       // Group memberships
    session?: string;        // Session ID
    sessionData?: {          // JWT claims or session metadata
        exp?: number;        // Expiry timestamp
        iat?: number;        // Issued at
        scope?: string[];    // Permissions/scopes
        [key: string]: unknown;
    };
}
```

---

## Syscall Gating

Dispatcher rejects unauthenticated processes for non-auth syscalls:

```typescript
// In dispatcher.dispatch()
const ALLOW_ANONYMOUS = ['auth:login', 'auth:token', 'auth:register'];

if (!proc.user && !ALLOW_ANONYMOUS.includes(name)) {
    yield respond.error('EACCES', 'Authentication required');
    return;
}
```

---

## Auth Syscalls

| Syscall | Args | Description |
|---------|------|-------------|
| `auth:login` | `{ user, pass }` | Validate credentials, create session |
| `auth:token` | `{ jwt }` | Validate JWT, create session from claims |
| `auth:apikey` | `{ key }` | Validate API key, create session |
| `auth:logout` | - | Clear session, reset proc.user |
| `auth:whoami` | - | Return current user/session info |
| `auth:refresh` | `{ token }` | Refresh expiring session |
| `auth:register` | `{ user, pass, ... }` | Create new user account |

### auth:login

```typescript
// Request
{ id: "1", call: "auth:login", args: [{ user: "alice", pass: "secret" }] }

// Success response
{ id: "1", op: "ok", data: { user: "alice", session: "sess-uuid", exp: 1234567890 } }

// Failure response
{ id: "1", op: "error", code: "EACCES", message: "Invalid credentials" }
```

### auth:token (JWT)

```typescript
// Request
{ id: "1", call: "auth:token", args: [{ jwt: "eyJhbG..." }] }

// Success - extracts user from JWT claims
{ id: "1", op: "ok", data: { user: "alice", session: "sess-uuid", scope: ["read", "write"] } }
```

### auth:whoami

```typescript
// Request
{ id: "1", call: "auth:whoami", args: [] }

// Authenticated response
{ id: "1", op: "ok", data: { user: "alice", groups: ["admin"], session: "sess-uuid" } }

// Anonymous response (if gating disabled for testing)
{ id: "1", op: "ok", data: { user: null } }
```

---

## Client Flow (os-sdk)

```typescript
// os-sdk connection
const client = await connect('/tmp/monk.sock');

// Must auth before anything else
const session = await client.syscall('auth:login', { user: 'alice', pass: 'secret' });
// or
const session = await client.syscall('auth:token', { jwt: getJWT() });

// Now other syscalls work
const files = await client.syscall('file:readdir', '/home/alice');
```

SDK could handle this automatically:

```typescript
// os-sdk with built-in auth
const client = await connect('/tmp/monk.sock', {
    auth: { user: 'alice', pass: 'secret' }
    // or
    auth: { jwt: getJWT() }
});

// Auth happens on connect, then syscalls work
const files = await client.readdir('/home/alice');
```

---

## Session Storage (EMS)

Sessions stored as entities:

```typescript
// Model: session
{
    id: 'sess-uuid',
    model: 'session',
    user: 'alice',
    created: 1234567890,
    expires: 1234657890,
    ip?: string,           // Client info (if available)
    userAgent?: string,
}
```

Auth subsystem queries/creates sessions via EMS:

```typescript
class Auth {
    constructor(private ems: EMS, private hal: HAL) {}

    async login(proc: Process, user: string, pass: string): Promise<Session> {
        // Validate credentials (check user entity, hash password)
        const userEntity = await this.ems.ops.selectOne('user', { username: user });
        if (!userEntity || !await this.verifyPassword(pass, userEntity.passwordHash)) {
            throw new EACCES('Invalid credentials');
        }

        // Create session
        const session = await this.ems.ops.createOne('session', {
            user: userEntity.id,
            expires: Date.now() + SESSION_TTL,
        });

        // Set process identity
        proc.user = userEntity.id;
        proc.session = session.id;
        proc.groups = userEntity.groups;

        return session;
    }
}
```

---

## User Storage (EMS)

Users stored as entities:

```typescript
// Model: user
{
    id: 'user-uuid',
    model: 'user',
    username: 'alice',
    passwordHash: '$argon2id$...',
    groups: ['users', 'admin'],
    created: 1234567890,
    disabled?: boolean,
}
```

---

## JWT Validation

For `auth:token`, validate JWT signature and extract claims:

```typescript
async validateJWT(proc: Process, jwt: string): Promise<Session> {
    // Verify signature using HAL crypto
    const payload = await this.hal.crypto.verifyJWT(jwt, this.publicKey);

    // Check expiry
    if (payload.exp && payload.exp < Date.now() / 1000) {
        throw new EACCES('Token expired');
    }

    // Set process identity from claims
    proc.user = payload.sub;
    proc.session = payload.jti ?? this.hal.entropy.uuid();
    proc.sessionData = payload;

    return { user: payload.sub, session: proc.session };
}
```

---

## Permission Checking (Existing ACL System)

VFS already has a complete ACL system in `src/vfs/acl.ts`:

**Existing types:**
```typescript
interface Grant {
    to: string;       // Principal UUID or '*' for anyone
    ops: string[];    // Operations: 'read', 'write', 'delete', 'stat', '*'
    expires?: number; // Optional expiration timestamp
}

interface ACL {
    grants: Grant[];  // Explicit permission grants
    deny: string[];   // Explicitly denied principals (always wins)
}
```

**Existing functions:**
- `checkAccess(acl, caller, op)` - Check if caller can perform operation
- `checkAccessAll(acl, caller, ops)` - Check multiple operations
- `defaultACL(creator)` - Creator gets `*`, world gets `read/stat`
- `encodeACL()` / `decodeACL()` - Serialization

**How Auth connects:**

Auth sets `proc.user`, VFS uses it as the `caller` for ACL checks:

```typescript
// In VFS file:open (simplified)
async function fileOpen(proc: Process, vfs: VFS, path: string, flags: OpenFlags) {
    const acl = await vfs.getACL(entityId);

    // proc.user comes from Auth subsystem
    if (flags.read && !checkAccess(acl, proc.user, 'read')) {
        throw new EACCES('Permission denied');
    }
    if (flags.write && !checkAccess(acl, proc.user, 'write')) {
        throw new EACCES('Permission denied');
    }
    // ...
}
```

**Auth does NOT own ACLs** - it just provides the identity (`proc.user`) that VFS checks against existing ACL infrastructure.

---

## Directory Structure

```
src/auth/
├── index.ts           # Exports Auth class
├── auth.ts            # Auth subsystem (login, token, session management)
├── types.ts           # Session, User types
├── password.ts        # Password hashing (argon2id via HAL crypto)
└── jwt.ts             # JWT validation

src/syscall/
├── auth.ts            # auth:* syscall handlers (new file)
```

---

## Implementation Phases

### Phase 1: Basic Auth (MVP)

1. Add `user`, `session` fields to Process
2. Add dispatcher gating (reject anonymous for non-auth syscalls)
3. Implement `auth:login` with simple password check
4. Implement `auth:whoami`
5. Update os-sdk to auth on connect

### Phase 2: Sessions

1. Add session entity model to EMS
2. Session creation on login
3. Session expiry checking
4. `auth:logout` clears session
5. `auth:refresh` extends session

### Phase 3: JWT Support

1. Implement `auth:token` for JWT validation
2. JWT signature verification via HAL crypto
3. Claims extraction to proc.sessionData

### Phase 4: Permissions

1. VFS permission checks against proc.user
2. EMS row-level security based on proc.user
3. Group-based permissions

---

## Configuration

Auth config in `/etc/auth.json`:

```json
{
    "sessionTTL": 86400000,
    "allowAnonymous": false,
    "jwtPublicKey": "...",
    "passwordMinLength": 8,
    "maxLoginAttempts": 5,
    "lockoutDuration": 300000
}
```

---

## Open Questions

1. **Root/admin bootstrap**: How does the first admin user get created? Seed at boot? Special bootstrap mode?

2. **Service accounts**: Should internal services (logd, gatewayd) have their own identity? Or run as root?

3. **API keys vs passwords**: Support both? API keys for programmatic access, passwords for interactive?

4. **Token refresh**: Automatic refresh in os-sdk? Or explicit `auth:refresh` calls?

5. **Multi-tenant**: Should sessions be scoped to a tenant/org? Or is that an app-level concern?

---

## References

- `src/gateway/gateway.ts` - Virtual process creation (line 319)
- `src/kernel/types.ts` - Process interface
- `src/syscall/dispatcher.ts` - Syscall routing
- `src/vfs/acl.ts` - Existing ACL/grant system (Auth provides identity, VFS checks permissions)
- `src/ems/` - Entity storage for users/sessions
- `src/hal/crypto.ts` - Password hashing, JWT verification
