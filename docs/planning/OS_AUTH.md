# Authentication Subsystem

> **Status**: Proposed
> **Complexity**: Medium
> **Dependencies**: EMS (schema split pattern), Gateway (process identity), HAL (crypto)

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
- Validate credentials (password, JWT)
- Store sessions in EMS
- Set `proc.user` and `proc.session` on success

**Auth does NOT:**
- Intercept other syscalls (dispatcher gates)
- Own the permission model (VFS/EMS check `proc.user`)
- Manage processes (kernel does that)

**Schema ownership:** Auth owns `src/auth/schema.sql` containing `auth_user` and `auth_session` table definitions. Following the established pattern (see `docs/implemented/EMS_SCHEMA_SPLIT.md`), Auth loads its schema via `ems.exec()` during `Auth.init()`.

---

## Process Identity

Extend Process with identity fields:

```typescript
interface Process {
    id: string;                  // UUID (exists)
    user?: string;               // User ID (null = anonymous)
    session?: string;            // Session ID
    expires?: number;            // Session expiry timestamp (ms since epoch)
    sessionValidatedAt?: number; // Last EMS session check (for 5-min revalidation)
    sessionData?: {              // JWT claims or session metadata
        iat?: number;            // Issued at
        scope?: string[];        // Permissions/scopes
        [key: string]: unknown;
    };
}
```

---

## Syscall Gating

Dispatcher checks session expiry and rejects unauthenticated processes:

```typescript
// In dispatcher.dispatch()
const ALLOW_ANONYMOUS = ['auth:login', 'auth:token', 'auth:register'];
const REVALIDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Lazy session expiration - checked on each syscall
if (proc.expires && proc.expires < Date.now()) {
    proc.user = undefined;
    proc.session = undefined;
    proc.expires = undefined;
    proc.sessionValidatedAt = undefined;
    proc.sessionData = undefined;
    // Falls through to anonymous check below
}

// Periodic EMS revalidation - allows session revocation to propagate
if (proc.session && Date.now() - proc.sessionValidatedAt > REVALIDATE_INTERVAL) {
    const session = await ems.ops.selectOne('auth_session', { id: proc.session });
    if (!session || session.expires < Date.now()) {
        // Session revoked or expired in EMS
        proc.user = proc.session = proc.expires = proc.sessionValidatedAt = undefined;
    }
    proc.sessionValidatedAt = Date.now();
}

if (!proc.user && !ALLOW_ANONYMOUS.includes(name)) {
    yield respond.error('EACCES', 'Authentication required');
    return;
}
```

**Note:** Internal OS code (kernel, subsystems, daemons) calls subsystems directly, bypassing the dispatcher entirely. Gating only applies to syscalls routed through the dispatcher—primarily external clients via gateway and on-OS userspace processes.

---

## Auth Syscalls

| Syscall | Args | Description |
|---------|------|-------------|
| `auth:login` | `{ user, pass }` | Validate credentials, create session, return JWT |
| `auth:token` | `{ jwt }` | Validate JWT, restore session from claims |
| `auth:logout` | - | Clear session, reset proc.user |
| `auth:whoami` | - | Return current user/session info |
| `auth:passwd` | `{ current, new }` or `{ user, new }` | Change password, invalidate other sessions |
| `auth:grant` | `{ principal, scope?, ttl? }` | Mint scoped JWT for a principal (elevated) |
| `auth:register` | `{ user, pass, ... }` | Create new user account |

**Note:** No separate API key mechanism. Services use long-lived JWTs via `auth:token`. Same code path, different TTL. Revocation via EMS session deletion.

### auth:login

```typescript
// Request
{ id: "1", call: "auth:login", args: [{ user: "alice", pass: "secret" }] }

// Success response - returns JWT for client to store and use on reconnect
{ id: "1", op: "ok", data: {
    user: "alice",
    session: "sess-uuid",
    token: "eyJhbG...",      // JWT containing session ID, user ID, expiry
    expiresAt: 1234567890    // token expiry (ms since epoch)
} }

// Failure response
{ id: "1", op: "error", code: "EACCES", message: "Invalid credentials" }
```

**No separate refresh tokens.** Sliding expiration via `auth:token` - clients refresh at 50% TTL (see Token Refresh Strategy). EMS session provides revocation.

### auth:token (JWT)

```typescript
// Request - validates JWT, extends session, returns fresh JWT
{ id: "1", call: "auth:token", args: [{ jwt: "eyJhbG..." }] }

// Success - extends session, returns fresh JWT
{ id: "1", op: "ok", data: {
    user: "alice",
    session: "sess-uuid",
    token: "eyJ...",           // fresh JWT with extended exp
    expiresAt: 1234567890
} }
```

### auth:whoami

```typescript
// Request
{ id: "1", call: "auth:whoami", args: [] }

// Authenticated response
{ id: "1", op: "ok", data: { user: "alice", session: "sess-uuid" } }

// Anonymous response (if gating disabled for testing)
{ id: "1", op: "ok", data: { user: null } }
```

### auth:logout

```typescript
// Request
{ id: "1", call: "auth:logout", args: [] }

// Success
{ id: "1", op: "ok", data: {} }
```

**Server-side:**
1. Delete EMS session entity
2. Clear proc identity (`user`, `session`, `expires`, `sessionValidatedAt`)

**Client-side (SDK responsibility):**
3. Delete stored token from disk/keychain

Invalidates the session immediately. Even if someone has a copy of the JWT, `auth:token` will fail (session not found) and existing connections will be kicked on next EMS revalidation.

### auth:passwd

**Self-service (change own password):**

```typescript
// Request - requires current password
{ id: "1", call: "auth:passwd", args: [{ current: "oldpass", new: "newpass" }] }

// Success
{ id: "1", op: "ok", data: {} }

// Wrong current password
{ id: "1", op: "error", code: "EACCES", message: "Invalid credentials" }
```

**Admin reset (change another user's password):**

```typescript
// Request - no current password, requires elevated permissions
{ id: "1", call: "auth:passwd", args: [{ user: "alice", new: "temppass" }] }

// Success
{ id: "1", op: "ok", data: {} }
```

**Behavior:**
1. Update user entity `passwordHash`
2. Delete all EMS sessions for target user (except caller's session for self-service)
3. Existing JWTs become invalid on next EMS revalidation

Requiring current password for self-service prevents a hijacked session from permanently locking out the legitimate user.

### auth:grant

Mint a scoped JWT for any principal. Requires elevated permissions.

```typescript
// Request - create read-only token for a service
{ id: "1", call: "auth:grant", args: [{
    principal: "svc:monitor",
    scope: ["read"],
    ttl: 31536000000  // 1 year in ms
}] }

// Success - returns JWT and creates session
{ id: "1", op: "ok", data: {
    principal: "svc:monitor",
    session: "sess-uuid",
    token: "eyJ...",
    expiresAt: 1234567890,
    scope: ["read"]
} }
```

**Scopes (Phase 1):**
- `read` - read operations only
- `write` - read + write operations
- `*` - unrestricted (default if not specified)

**Scopes (Phase 4 - Subsystem-level):**
- `vfs:read`, `vfs:write`, `vfs:*` - VFS operations
- `ems:read`, `ems:write`, `ems:*` - EMS operations
- `auth:admin` - auth:grant, auth:passwd for others
- `kernel:*` - process management, shutdown
- `*` - everything

**Rules:**
- Requires elevated permissions to call
- Can only grant scopes caller has (no privilege escalation)
- Principal doesn't need to be existing user - can be any identity string
- Creates EMS session for revocation

**Use cases:**
- Provision service tokens: `svc:httpd`, `svc:monitor`
- Create limited-access tokens for contractors
- Generate read-only tokens for dashboards

Dispatcher enforces scope by mapping syscalls to required scope level.

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

## Token Refresh Strategy

**Sliding expiration with 50% refresh.** Clients refresh their JWT when 50% of TTL has elapsed. Server always returns fresh JWT on `auth:token`.

```typescript
// Client-side logic (SDK/CLI)
function shouldRefresh(jwt: DecodedJWT): boolean {
    const issued = jwt.iat * 1000;
    const expires = jwt.exp * 1000;
    const halfway = issued + (expires - issued) / 2;
    return Date.now() > halfway;
}

async function connectWithToken(tokenPath: string) {
    let token = loadToken(tokenPath);

    if (shouldRefresh(decode(token))) {
        const result = await client.syscall('auth:token', { jwt: token });
        token = result.token;  // fresh JWT with new exp
        saveToken(tokenPath, token);
    }

    return authenticatedClient;
}
```

**Example with 7-day TTL:**
- Day 0: `auth:login` → get JWT, store locally
- Days 0-3.5: connect with stored JWT, no refresh needed
- Day 3.5+: `auth:token` → get fresh JWT, store it
- Cycle repeats indefinitely with regular use
- 7+ days inactive → token expires, must re-login

**Use cases:**
- **Interactive users**: Login once, use CLI/tools for months with auto-refresh
- **Services**: Same mechanism, just longer TTL (or no exp) - refresh is a no-op

Server doesn't track refresh timing - `auth:token` always extends session and returns fresh JWT. Client decides when to call based on 50% rule.

---

## Session Storage (EMS)

Sessions stored in `auth_session` table (defined in `src/auth/schema.sql`):

```typescript
// Table: auth_session
{
    id: 'sess-uuid',
    user_id: 'user-uuid',
    created: 1234567890,
    expires: 1234657890,
    ip?: string,           // Client info (if available)
    user_agent?: string,
}
```

Auth subsystem queries/creates sessions via EMS:

```typescript
class Auth {
    constructor(private ems: EMS, private hal: HAL) {}

    async login(proc: Process, user: string, pass: string): Promise<LoginResult> {
        // Validate credentials (check user entity, hash password)
        const userEntity = await this.ems.ops.selectOne('auth_user', { username: user });
        if (!userEntity || !await this.verifyPassword(pass, userEntity.password_hash)) {
            throw new EACCES('Invalid credentials');
        }

        const expiresAt = Date.now() + SESSION_TTL;

        // Create session in EMS
        const session = await this.ems.ops.createOne('auth_session', {
            user_id: userEntity.id,
            expires: expiresAt,
        });

        // Generate JWT for client
        const token = await this.hal.crypto.signJWT({
            sub: userEntity.id,
            sid: session.id,
            exp: Math.floor(expiresAt / 1000),  // JWT uses seconds
        });

        // Set process identity
        proc.user = userEntity.id;
        proc.session = session.id;
        proc.expires = expiresAt;
        proc.sessionValidatedAt = Date.now();

        return { user: userEntity.id, session: session.id, token, expiresAt };
    }
}
```

---

## User Storage (EMS)

Users stored in `auth_user` table (defined in `src/auth/schema.sql`):

```typescript
// Table: auth_user
{
    id: 'user-uuid',
    username: 'alice',
    password_hash: '$argon2id$...',
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
    proc.expires = payload.exp ? payload.exp * 1000 : undefined;  // JWT exp is seconds
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
├── schema.sql         # Auth tables (auth_user, auth_session) - loaded via ems.exec()
├── auth.ts            # Auth subsystem (login, token, session management)
├── types.ts           # Session, User types
├── password.ts        # Password hashing (argon2id via HAL crypto)
└── jwt.ts             # JWT validation

src/syscall/
├── auth.ts            # auth:* syscall handlers (new file)
```

---

## Implementation Phases

### Phase 0: Bootstrap Auth (MVP)

Minimal auth with pre-provisioned tokens. No passwords, no user entities.

1. Create `src/auth/` directory structure
2. Add `user`, `session`, `expires`, `sessionValidatedAt` fields to Process
3. Add dispatcher gating (reject anonymous, check session expiry)
4. Implement `auth:token` - validate JWT, set proc identity
5. Implement `auth:whoami`
6. Init script mints JWTs directly via HAL crypto (no syscall needed)
7. Update os-sdk to accept token on connect

**What this enables:**
- Services authenticate with pre-provisioned JWTs
- Testing works with minted tokens
- Auth gating is enforced

**What's deferred:**
- Password login (`auth:login`)
- User/session tables in EMS (just use JWT expiry)
- Rate limiting
- `auth:logout`, `auth:passwd`, `auth:register`, `auth:grant`

### Phase 1: Password Login

1. Create `src/auth/schema.sql` with `auth_user` and `auth_session` tables
2. Add `Auth.init()` that loads schema via `ems.exec(schema, { clearModels: true })`
3. Implement `auth:login` with password hashing
4. Implement `auth:logout`
5. 5-min EMS revalidation for session revocation

### Phase 2: Session Management

1. Per-connection exponential backoff (see Rate Limiting section)
2. `auth:passwd` for password changes
3. `auth:grant` for minting scoped tokens
4. `auth:register` for user creation

### Phase 3: Permissions

1. VFS permission checks against proc.user
2. EMS row-level security based on proc.user

### Phase 4: Subsystem Scopes

1. Implement subsystem-level scope checking in dispatcher
2. Scope format: `subsystem:operation` (e.g., `vfs:read`, `ems:write`)
3. Map syscalls to required scopes
4. `auth:grant` enforces scope restrictions
5. Add `auth:admin` scope for administrative syscalls

```typescript
const SYSCALL_SCOPES: Record<string, string[]> = {
    'file:read':    ['vfs:read', 'vfs:*', '*'],
    'file:write':   ['vfs:write', 'vfs:*', '*'],
    'file:delete':  ['vfs:write', 'vfs:*', '*'],
    'ems:select':   ['ems:read', 'ems:*', '*'],
    'ems:create':   ['ems:write', 'ems:*', '*'],
    'auth:grant':   ['auth:admin', '*'],
    'auth:passwd':  ['auth:admin', '*'],  // when targeting another user
    'kernel:kill':  ['kernel:*', '*'],
    // ...
};
```

---

## Rate Limiting

**No user lockouts.** Per-connection exponential backoff only.

```typescript
// Per-connection state (tracked on proc or connection)
let failedAttempts = 0;

async function login(user: string, pass: string) {
    // Exponential delay: 0, 1s, 2s, 4s, 8s... capped at 30s
    if (failedAttempts > 0) {
        await sleep(Math.min(1000 * Math.pow(2, failedAttempts - 1), 30000));
    }

    const success = await validateCredentials(user, pass);

    if (!success) {
        failedAttempts++;
        throw new EACCES('Invalid credentials');  // constant message, no username hints
    }

    failedAttempts = 0;  // reset on success
    return createSession(...);
}
```

**Properties:**
- No lockouts - legitimate users never blocked
- Per-connection - reconnecting resets counter (adds friction for attackers)
- Constant-time failure - no username enumeration
- Capped at 30s delay - after 5 failures: ~16s, after 10+: 30s

**Future (v2):** Add proof-of-work requirement at high backoff levels. Client must solve hashcash-style puzzle before server processes login. Makes brute force computationally expensive without blocking anyone.

---

## Configuration

Auth config in `/etc/auth.json`:

```json
{
    "sessionTTL": 86400000,
    "allowAnonymous": false,
    "jwtPublicKey": "...",
    "passwordMinLength": 8,
    "backoffMaxDelay": 30000,
    "revalidateInterval": 300000
}
```

---

## Open Questions

1. ~~**Root/admin bootstrap**~~: **Resolved.** Internal kernel code calls subsystems directly, bypassing the dispatcher and auth gating entirely. Init scripts seed users via direct EMS calls. No bootstrap problem exists.

   **Documentation TODO:** This security model (internal = root, dispatcher = gated) needs clear documentation outside this planning doc. Key points:
   - Internal kernel/subsystem calls bypass dispatcher entirely
   - Only syscalls routed through dispatcher are auth-gated
   - Internal code effectively runs as root with no permission checks

2. ~~**Service accounts**~~: **Resolved.** Services use long-lived JWTs via `auth:token`. JWT contains `sub` (principal like `svc:httpd`), `sid` (session ID for revocation), and optional `exp`. Provisioned via init script or admin tooling.

3. **Multi-tenant**: Should sessions be scoped to a tenant/org? Or is that an app-level concern?

---

## References

**Implementation patterns:**
- `docs/implemented/EMS_SCHEMA_SPLIT.md` - Schema split architecture (Auth follows this pattern)
- `src/vfs/schema.sql` - VFS schema (reference for Auth schema structure)
- `src/vfs/vfs.ts` - VFS.init() shows how to load subsystem schema via `ems.exec()`

**Codebase:**
- `src/gateway/gateway.ts` - Virtual process creation
- `src/kernel/types.ts` - Process interface
- `src/syscall/dispatcher.ts` - Syscall routing
- `src/vfs/acl.ts` - Existing ACL/grant system (Auth provides identity, VFS checks permissions)
- `src/ems/` - Entity storage for users/sessions
- `src/hal/crypto.ts` - Password hashing, JWT verification
