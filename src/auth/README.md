# Auth Module

The Auth subsystem handles authentication and identity management for Monk OS. It provides JWT-based token authentication, password login, session management, and identity reporting. Auth is a peer subsystem alongside VFS/EMS/Kernel, focused solely on "who are you?" rather than "what can you do?" (authorization is handled by existing ACL systems).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Syscall Layer (auth:login, auth:token, auth:whoami, etc.)  │
├─────────────────────────────────────────────────────────────┤
│  Auth Class (credential validation, JWT operations)         │
├─────────────────────────────────────────────────────────────┤
│  JWT Module (HS256 signing/verification)                    │
├─────────────────────────────────────────────────────────────┤
│  HAL (crypto for argon2id password hashing)                 │
│  EMS (persistent user/session storage)                      │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/auth/
├── index.ts              # Public API exports
├── auth.ts               # Main Auth class
├── jwt.ts                # JWT signing/verification (HS256)
├── types.ts              # Type definitions
└── schema.sql            # EMS schema (auth_user, auth_session)
```

## Features

### Phase 0 (Complete): Bootstrap Auth MVP

- JWT validation via `auth:token`
- Identity reporting via `auth:whoami`
- Ephemeral signing key (tokens invalidate on restart)

### Phase 1 (Complete): Password Login

- Password authentication via `auth:login`
- Session storage in EMS (auth_session table)
- Session invalidation via `auth:logout`
- 5-minute session revalidation for revocation detection
- Argon2id password hashing

### Phase 2 (Complete): User Registration & Token Granting

- User registration via `auth:register`
- Scoped token creation via `auth:grant`

### Future Phases

- Phase 3: VFS permission checks against proc.user
- Phase 4: Subsystem-level scope enforcement

## Auth Class

Main authentication subsystem class.

### Constructor

```typescript
const auth = new Auth(hal, ems, config);
```

**Parameters:**
- `hal: HAL` - Hardware abstraction layer (for crypto and entropy)
- `ems?: EMS` - Entity management system (for persistent sessions/users)
- `config?: AuthConfig` - Optional configuration

### Configuration

```typescript
interface AuthConfig {
    sessionTTL?: number;        // Session duration (default: 24 hours)
    allowAnonymous?: boolean;   // Bypass gating (default: false)
}
```

### Lifecycle

```typescript
await auth.init();       // Generate signing key, load schema, seed root user
// ... use auth methods ...
await auth.shutdown();   // Clear signing key
```

### Core Methods

#### Token Operations

**mintToken(principal, ttl?): Promise&lt;TokenResult&gt;**

Mint a new JWT for a user or service.

```typescript
const result = await auth.mintToken('root', 3600000); // 1 hour TTL
// Returns: { user, session, token, expiresAt }
```

**validateToken(token): Promise&lt;JWTPayload | null&gt;**

Validate a JWT and return its payload.

```typescript
const payload = await auth.validateToken(jwtString);
if (payload) {
    console.log('User:', payload.sub, 'Session:', payload.sid);
}
```

**refreshToken(token): Promise&lt;TokenResult | null&gt;**

Validate JWT and return fresh token with extended expiry (sliding expiration).

```typescript
const refreshed = await auth.refreshToken(oldToken);
// Returns new token with same principal but extended expiry
```

#### Password Authentication (Phase 1)

**login(username, password): Promise&lt;LoginResult | null&gt;**

Authenticate with username and password.

```typescript
const result = await auth.login('root', 'secretpassword');
if (result) {
    // Returns: { user, session, token, expiresAt }
    console.log('Login successful:', result.user);
}
else {
    console.log('Invalid credentials');
}
```

**logout(sessionId): Promise&lt;void&gt;**

Invalidate a session.

```typescript
await auth.logout(sessionId);
// Session deleted from EMS, JWT validation will fail on revalidation
```

**revalidateSession(sessionId): Promise&lt;boolean&gt;**

Check if session still exists in EMS and is not expired.

```typescript
const valid = await auth.revalidateSession(sessionId);
// Returns true if session exists and not expired, false otherwise
```

#### User Registration (Phase 2)

**register(username, password): Promise&lt;string | null&gt;**

Create a new user account.

```typescript
const userId = await auth.register('alice', 'password123');
if (userId) {
    console.log('User created:', userId);
}
else {
    console.log('Username already taken');
}
```

#### Token Granting (Phase 2)

**grant(principal, scope?, ttl?): Promise&lt;TokenResult&gt;**

Mint a scoped token for a user or service.

```typescript
// Service token with limited scope
const token = await auth.grant('svc:httpd', ['vfs:read'], 3600000);

// User token without scope restrictions
const userToken = await auth.grant('00000000-0000-0000-0000-000000000001');
```

Note: Scope enforcement is planned for Phase 4. Currently scopes are stored in JWT but not validated.

### Configuration Accessors

**isAnonymousAllowed(): boolean**

Check if anonymous access is permitted.

**getSessionTTL(): number**

Get configured session TTL in milliseconds.

**getRevalidateInterval(): number**

Get session revalidation interval (5 minutes).

## JWT Module

Low-level JWT signing and verification using HMAC-SHA256.

### JWT Structure

```
header.payload.signature
```

- **Header**: `{alg: "HS256", typ: "JWT"}` (Base64URL-encoded)
- **Payload**: Claims including sub, sid, exp, iat (Base64URL-encoded)
- **Signature**: HMAC-SHA256 of "header.payload" (Base64URL-encoded)

### Functions

**signJWT(payload, key): Promise&lt;string&gt;**

Create signed JWT from payload.

```typescript
const payload: JWTPayload = {
    sub: 'user123',
    sid: 'session456',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor((Date.now() + 3600000) / 1000)
};
const token = await signJWT(payload, signingKey);
```

**verifyJWT(token, key): Promise&lt;JWTPayload | null&gt;**

Verify JWT signature and expiration, return payload or null.

```typescript
const payload = await verifyJWT(tokenString, signingKey);
if (payload) {
    console.log('Valid token for user:', payload.sub);
}
```

**generateKey(size?): Uint8Array**

Generate cryptographically secure random key.

```typescript
const key = generateKey(32); // 32 bytes for HS256
```

## Type Definitions

### JWTPayload

```typescript
interface JWTPayload {
    sub: string;        // Subject (user/principal ID)
    sid: string;        // Session ID
    exp?: number;       // Expiration (Unix timestamp in seconds)
    iat: number;        // Issued at (Unix timestamp in seconds)
    scope?: string[];   // Permission scopes (Phase 4)
}
```

### TokenResult

```typescript
interface TokenResult {
    user: string;       // User/principal ID
    session: string;    // Session ID
    token: string;      // JWT string
    expiresAt: number;  // Expiry timestamp (ms since epoch)
}
```

### LoginResult

```typescript
interface LoginResult {
    user: string;       // User ID
    session: string;    // Session ID
    token: string;      // JWT string
    expiresAt: number;  // Expiry timestamp (ms since epoch)
}
```

### AuthUser

```typescript
interface AuthUser {
    id: string;
    username: string;
    password_hash: string;
    disabled: number;           // 0 or 1
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
}
```

### AuthSession

```typescript
interface AuthSession {
    id: string;
    user_id: string;
    expires: number;            // Timestamp in ms
    ip: string | null;
    user_agent: string | null;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
}
```

## Database Schema

Auth uses two EMS tables defined in `schema.sql`:

### auth_user

User accounts for password authentication.

| Field | Type | Description |
|-------|------|-------------|
| id | TEXT | UUID (FK to entities) |
| username | TEXT | Unique username |
| password_hash | TEXT | Argon2id hash |
| disabled | INTEGER | Account disabled flag |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |
| trashed_at | TEXT | Soft delete timestamp |
| expired_at | TEXT | Hard delete timestamp |

### auth_session

Active sessions for authenticated users.

| Field | Type | Description |
|-------|------|-------------|
| id | TEXT | UUID (FK to entities) |
| user_id | TEXT | User/principal ID |
| expires | INTEGER | Expiry timestamp (ms) |
| ip | TEXT | Client IP address |
| user_agent | TEXT | Client user agent |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |
| trashed_at | TEXT | Soft delete timestamp |
| expired_at | TEXT | Hard delete timestamp |

## Constants

### ROOT_USER_ID

Well-known UUID for the root user: `'00000000-0000-0000-0000-000000000001'`

### DEFAULT_ROOT_PASSWORD

Default root password: `'root'` (change in production)

### REVALIDATE_INTERVAL

Session revalidation interval: 5 minutes (300000ms)

Balances security (detect revoked sessions) with performance (avoid EMS checks on every syscall).

## Security Considerations

### Ephemeral Signing Key

The signing key is generated at init and lost on shutdown. All tokens invalidate on OS restart. This is acceptable because the database is also ephemeral in the current architecture.

### Password Hashing

Passwords are hashed with Argon2id, a memory-hard algorithm resistant to GPU/ASIC attacks. The hash includes a random salt and cost parameters.

### Constant-Time Verification

JWT signature verification uses `crypto.subtle.verify()` for constant-time comparison, preventing timing attacks.

### Session Revalidation

Sessions are revalidated against EMS every 5 minutes. This allows logout to propagate without requiring database checks on every syscall.

## Invariants

1. signingKey is non-null after init() completes
2. validateToken() returns null for invalid/expired tokens
3. mintToken() always produces valid JWTs
4. All tokens signed with same ephemeral key until shutdown
5. Root user exists after init() completes

## Concurrency Model

Auth is stateless except for the signing key. All token operations are independent and can run concurrently. The signing key is immutable after init().

## Public Exports

**Classes:**
- `Auth`

**Types:**
- `JWTHeader`, `JWTPayload`
- `TokenResult`, `WhoamiResult`, `LoginResult`
- `AuthConfig`, `AuthUser`, `AuthSession`

**Constants:**
- `DEFAULT_AUTH_CONFIG`
- `ROOT_USER_ID`
- `DEFAULT_ROOT_PASSWORD`
- `REVALIDATE_INTERVAL`

**Functions:**
- `signJWT(payload, key)` - Sign JWT
- `verifyJWT(token, key)` - Verify JWT
- `generateKey(size?)` - Generate signing key

## Examples

### Basic Usage

```typescript
import { Auth } from '@src/auth/index.js';
import { BunHAL } from '@src/hal/index.js';
import { EMS } from '@src/ems/index.js';

const hal = new BunHAL();
const ems = new EMS(hal);
const auth = new Auth(hal, ems);

await hal.init();
await ems.init();
await auth.init();

// Login
const result = await auth.login('root', 'root');
if (result) {
    console.log('Logged in:', result.user);
    console.log('Token:', result.token);
}

// Validate token
const payload = await auth.validateToken(result.token);
console.log('Token valid for user:', payload?.sub);

// Logout
await auth.logout(result.session);

await auth.shutdown();
await ems.shutdown();
await hal.shutdown();
```

### Register and Login

```typescript
// Register new user
const userId = await auth.register('alice', 'password123');

if (userId) {
    // Login with new account
    const login = await auth.login('alice', 'password123');
    console.log('Logged in:', login?.token);
}
```

### Service Token

```typescript
// Mint token for service principal
const serviceToken = await auth.grant('svc:httpd', ['vfs:read'], 3600000);

// Service can use this token for API calls
console.log('Service token:', serviceToken.token);
```

### Token Refresh (Sliding Expiration)

```typescript
// Get fresh token from existing token
const newToken = await auth.refreshToken(oldToken);

if (newToken) {
    console.log('Refreshed token:', newToken.token);
    console.log('New expiry:', new Date(newToken.expiresAt));
}
```
