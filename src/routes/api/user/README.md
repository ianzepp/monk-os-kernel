# 36-User API Documentation

> **Self-Service User Profile Management**
>
> The User API provides controlled self-service operations on the sudo-protected users table, allowing authenticated users to manage their own profiles without requiring sudo tokens. This API demonstrates the `withSelfServiceSudo()` pattern for bypassing model-level sudo protection with business logic constraints.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Implementation Pattern](#implementation-pattern)
4. [Security Model](#security-model)
5. [Endpoints](#endpoints)
6. [Testing](#testing)
7. [Common Use Cases](#common-use-cases)

## Overview

The User API solves a fundamental access control problem: the `users` table is marked as `sudo=true` to protect it from unauthorized modifications, but users should be able to update their own profiles without admin intervention.

### The Problem

Without the User API:
```bash
# Users table requires sudo
PUT /api/data/users/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <regular_jwt>
{"name": "Updated Name"}

# ❌ Error: Model 'users' requires sudo access
```

### The Solution

With the User API:
```bash
# Self-service profile update (no sudo required)
PUT /api/user/profile
Authorization: Bearer <regular_jwt>
{"name": "Updated Name"}

# ✅ Success: withSelfServiceSudo() bypasses sudo requirement
```

### Key Capabilities

- **Self-Service Profile Management**: Users can update their own `name` and `auth` without sudo
- **Account Deactivation**: Users can deactivate their own accounts (soft delete)
- **Security Boundaries**: Users cannot escalate their own privileges or modify protected fields
- **Audit Integration**: All operations logged through standard observer pipeline
- **Reusable Pattern**: `withSelfServiceSudo()` utility can be used by other APIs

### Base URL
```
/api/user/profile           # GET, PUT - Own profile operations
/api/user/deactivate        # POST - Deactivate own account
```

## Architecture

### Design Principles

1. **Least Privilege**: Self-service operations don't require sudo tokens
2. **Defense in Depth**: Multiple layers of validation (route logic + observers)
3. **Explicit Intent**: Users must explicitly confirm dangerous operations (deactivation)
4. **Audit Everything**: All operations logged with timestamp, user, and reason
5. **Composability**: `withSelfServiceSudo()` is a reusable utility, not a monolithic wrapper

### Why Not Admin Endpoints?

The original USER_API.md design included admin endpoints (GET /api/user, POST /api/user/:id, etc.), but these were **not implemented** because they don't provide value over the existing Data API:

**Admin Operations Should Use Data API**:
```bash
# List all users (Data API with sudo)
GET /api/data/users
Authorization: Bearer <sudo_jwt>

# Create user (Data API with sudo)
POST /api/data/users
Authorization: Bearer <sudo_jwt>
{"name": "New User", "auth": "user@example.com", "access": "edit"}

# Change access level (Data API with sudo)
PUT /api/data/users/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <sudo_jwt>
{"access": "full"}
```

The User API focuses exclusively on **self-service operations** where sudo is inappropriate.

## Implementation Pattern

### The `withSelfServiceSudo()` Utility

**Location**: `src/lib/api-helpers.ts`

The User API introduces a new utility function that temporarily grants sudo-equivalent privileges for controlled operations:

```typescript
export async function withSelfServiceSudo<T>(
    context: Context,
    handler: () => Promise<T>
): Promise<T> {
    context.set('as_sudo', true);
    try {
        return await handler();
    } finally {
        context.set('as_sudo', undefined);
    }
}
```

### How It Works

1. **Route Handler Sets Flag**:
   ```typescript
   // src/routes/api/user/profile/PUT.ts
   export default withTransactionParams(async (context, { system, body }) => {
       const user = context.get('user');

       // Validate business logic...

       // Execute with temporary sudo privileges
       const updated = await withSelfServiceSudo(context, async () => {
           return await system.database.updateOne('users', user.id, updates);
       });
   });
   ```

2. **Observer Checks Flag**:
   ```typescript
   // src/observers/all/1/50-sudo-validator.ts
   const jwtPayload = system.context.get('jwtPayload');
   const asSudo = system.context.get('as_sudo');

   // Check BOTH is_sudo (JWT) and as_sudo (self-service)
   if (!jwtPayload?.is_sudo && !asSudo) {
       throw new SystemError('Model requires sudo access');
   }
   ```

3. **Flag Auto-Cleanup**:
   - The `finally` block ensures `as_sudo` is always cleared
   - Prevents flag from leaking to subsequent operations
   - Works correctly even if handler throws errors

### Composability

Unlike the original plan to create `withSelfServiceSudo()` as a route wrapper, the final implementation is a **utility function** that can be called anywhere:

```typescript
// ❌ Original plan (route wrapper - not flexible)
export default withSelfServiceSudo(async (context, { system, body }) => {
    // Entire route runs with as_sudo flag
});

// ✅ Final implementation (utility function - composable)
export default withTransactionParams(async (context, { system, body }) => {
    // Validation runs WITHOUT as_sudo
    validateInput(body);

    // Only database operation runs WITH as_sudo
    const result = await withSelfServiceSudo(context, async () => {
        return await system.database.updateOne('users', userId, updates);
    });

    // Cleanup runs WITHOUT as_sudo
    cleanupResources();
});
```

**Benefits**:
- Minimal privilege scope (only database operation has elevated access)
- Can be used in non-route code (observers, background jobs, etc.)
- Easier to test individual components
- More explicit about what operations are elevated

## Security Model

### Multi-Layer Protection

The User API implements defense in depth with multiple security layers:

#### Layer 1: Route-Level Validation
```typescript
// src/routes/api/user/profile/PUT.ts
const allowedFields = ['name', 'auth'];
const disallowedFields = Object.keys(body).filter(key => !allowedFields.includes(key));

if (disallowedFields.length > 0) {
    throw HttpErrors.badRequest(
        `Cannot update fields: ${disallowedFields.join(', ')}`,
        'VALIDATION_ERROR'
    );
}
```

**Protects Against**:
- Users attempting to modify `access` field
- Users attempting to modify ACL arrays (`access_read`, `access_edit`, `access_full`)
- Malicious requests with unexpected fields

#### Layer 2: Business Logic Constraints
```typescript
// Check for duplicate auth identifier
const existing = await system.database.selectOne('users', {
    where: {
        auth: body.auth,
        id: { $ne: user.id }  // Exclude current user
    }
});

if (existing) {
    throw HttpErrors.conflict('Auth identifier already exists', 'AUTH_CONFLICT');
}
```

**Protects Against**:
- Auth identifier collisions
- Impersonation attempts
- Data integrity violations

#### Layer 3: Observer Pipeline
- **Sudo Validator**: Checks `as_sudo` flag for model-level protection
- **Field Sudo Validator**: Checks sudo-protected fields (if configured)
- **Immutable Validator**: Prevents modification of immutable fields
- **Freeze Validator**: Respects model freeze status

**Protects Against**:
- Direct database manipulation bypassing route logic
- Model-level protection violations
- System-wide security policies

### Privilege Escalation Prevention

The User API cannot be used for privilege escalation:

**Blocked Attack Vectors**:
```bash
# ❌ Cannot change own access level
PUT /api/user/profile
{"access": "root"}
# Error: Cannot update fields: access

# ❌ Cannot modify own ACL arrays
PUT /api/user/profile
{"access_full": ["*"]}
# Error: Cannot update fields: access_full

# ❌ Cannot modify other users
PUT /api/user/profile
{"id": "other-user-id", "name": "Hijacked"}
# Ignored: always updates authenticated user's profile
```

### Audit Trail

All User API operations are automatically logged:

**Profile Updates**:
- Logged via `updated_at` timestamp
- Observer pipeline tracks field changes
- History API can be queried for detailed change log

**Account Deactivations**:
- Logged with `trashed_at` timestamp
- Optional `reason` field for context
- Tracked via observer pipeline

**Access Level Changes** (via Data API only):
- Separate endpoint with mandatory `reason` field
- Full audit log with previous/new values
- Cannot be done via User API (admin-only operation)

## Endpoints

### GET /api/user/profile

**Purpose**: Retrieve own user profile

**Implementation**: `src/routes/api/user/profile/GET.ts`

**Pattern**: Uses `withParams()` (read-only, no transaction needed)

**Key Logic**:
```typescript
export default withParams(async (context: Context, { system }) => {
    const user = context.get('user');  // From JWT validation middleware

    const profile = await system.database.select404(
        'users',
        { where: { id: user.id } },
        'User profile not found'
    );

    setRouteResult(context, profile);
});
```

**Notes**:
- No sudo required (users table is public read)
- Returns full user object including ACL arrays
- Always returns authenticated user's profile (cannot view others)

### PUT /api/user/profile

**Purpose**: Update own name and/or auth identifier

**Implementation**: `src/routes/api/user/profile/PUT.ts`

**Pattern**: Uses `withTransactionParams()` + `withSelfServiceSudo()`

**Key Logic**:
```typescript
export default withTransactionParams(async (context: Context, { system, body }) => {
    const user = context.get('user');

    // Validate allowed fields
    const allowedFields = ['name', 'auth'];
    const disallowedFields = Object.keys(body).filter(key => !allowedFields.includes(key));

    if (disallowedFields.length > 0) {
        throw HttpErrors.badRequest(
            `Cannot update fields: ${disallowedFields.join(', ')}`,
            'VALIDATION_ERROR',
            { disallowed_fields: disallowedFields }
        );
    }

    // Validate and check uniqueness...

    // Update with self-service sudo
    const updated = await withSelfServiceSudo(context, async () => {
        updates.updated_at = new Date().toISOString();
        return await system.database.updateOne('users', user.id, updates);
    });

    setRouteResult(context, updated);
});
```

**Validation**:
- `name`: 2-100 characters
- `auth`: 2-255 characters, unique across tenant
- Rejects attempts to modify `access`, `access_read`, `access_edit`, `access_full`

**Error Handling**:
- `400 VALIDATION_ERROR` - Invalid input or disallowed fields
- `409 AUTH_CONFLICT` - Auth identifier already exists

### POST /api/user/deactivate

**Purpose**: Soft delete own account

**Implementation**: `src/routes/api/user/deactivate/POST.ts`

**Pattern**: Uses `withTransactionParams()` + `withSelfServiceSudo()`

**Key Logic**:
```typescript
export default withTransactionParams(async (context: Context, { system, body }) => {
    const user = context.get('user');

    // Require explicit confirmation
    if (body.confirm !== true) {
        throw HttpErrors.badRequest(
            'Account deactivation requires explicit confirmation',
            'CONFIRMATION_REQUIRED'
        );
    }

    // Soft delete with self-service sudo
    const deactivatedAt = new Date().toISOString();
    await withSelfServiceSudo(context, async () => {
        await system.database.updateOne('users', user.id, {
            trashed_at: deactivatedAt,
            updated_at: deactivatedAt
        });
    });

    setRouteResult(context, {
        message: 'Account deactivated successfully',
        deactivated_at: deactivatedAt,
        reason: body.reason || null
    });
});
```

**Validation**:
- `confirm`: Must be exactly `true` (boolean)
- `reason`: Optional string for audit log

**Effects**:
- Sets `trashed_at` timestamp
- User can no longer authenticate
- Account data preserved (not permanently deleted)
- Admin can reactivate via Data API with sudo

## Testing

### Test Location
`spec/36-user-api/`

### Test Coverage

**Profile GET** (`profile-get.test.sh`):
- ✅ Can view own profile
- ✅ Returns user ID, name, auth, access
- ✅ Works without sudo token

**Profile PUT** (`profile-put.test.sh`):
- ✅ Can update name without sudo
- ✅ Can update auth without sudo
- ✅ Validates name length (min 2 chars)
- ✅ Validates auth uniqueness
- ❌ Cannot update access level
- ❌ Cannot update ACL arrays

**Deactivate POST** (`deactivate-post.test.sh`):
- ✅ Can deactivate with confirmation
- ❌ Cannot deactivate without confirmation
- ✅ Cannot login after deactivation
- ✅ Deactivation timestamp recorded

### Running Tests

```bash
# Run all User API tests
npm run test:sh -- spec/36-user-api/*.test.sh

# Run individual test
./spec/36-user-api/profile-put.test.sh
```

### Test Helpers

Tests use standard helpers from `spec/helpers/setup.sh`:
- `assert_equals` - Assert HTTP status codes
- `assert_json_success` - Assert successful response
- `assert_json_error` - Assert error response with code
- `assert_json_field` - Assert field exists
- `assert_json_value` - Assert field value

## Common Use Cases

### User Updates Own Profile

```bash
# User wants to change their display name
curl -X PUT \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Jane Smith"}' \
  https://api.example.com/api/user/profile
```

**Why User API**: No sudo required, user can self-service

### User Changes Email Address

```bash
# User changes email for authentication
curl -X PUT \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auth": "jane.smith@newcompany.com"}' \
  https://api.example.com/api/user/profile
```

**Why User API**: Updates own auth identifier, validated for uniqueness

### User Leaves Company

```bash
# User deactivates own account when leaving
curl -X POST \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm": true, "reason": "Leaving company"}' \
  https://api.example.com/api/user/deactivate
```

**Why User API**: Self-service offboarding, no admin required

### Admin Promotes User

```bash
# Admin uses Data API with sudo (NOT User API)
curl -X PUT \
  -H "Authorization: Bearer $SUDO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"access": "full"}' \
  https://api.example.com/api/data/users/550e8400-e29b-41d4-a716-446655440000
```

**Why Data API**: Access level changes require sudo and admin privileges

### Admin Creates New User

```bash
# Admin uses Data API with sudo (NOT User API)
curl -X POST \
  -H "Authorization: Bearer $SUDO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "New User", "auth": "new@example.com", "access": "read"}' \
  https://api.example.com/api/data/users
```

**Why Data API**: User creation is admin-only operation

---

## Implementation Notes

### Why withSelfServiceSudo() is Flexible

The utility function pattern allows it to be used in various contexts:

**Use in Route Handlers**:
```typescript
await withSelfServiceSudo(context, async () => {
    return await system.database.updateOne('users', userId, updates);
});
```

**Use in Service Classes**:
```typescript
class UserService {
    async updateProfile(context: Context, userId: string, updates: any) {
        return await withSelfServiceSudo(context, async () => {
            return await this.db.updateOne('users', userId, updates);
        });
    }
}
```

**Use in Background Jobs** (if needed):
```typescript
async function migrateUserProfiles(context: Context) {
    for (const user of users) {
        await withSelfServiceSudo(context, async () => {
            await system.database.updateOne('users', user.id, migration);
        });
    }
}
```

### Future Enhancements

The User API provides a foundation for additional self-service features:

**Password Management**:
- `PUT /api/user/password` - Change own password
- `POST /api/user/password/reset` - Request password reset token

**Profile Extensions**:
- `PUT /api/user/preferences` - Update UI preferences
- `GET /api/user/sessions` - List active sessions
- `DELETE /api/user/sessions/:id` - Revoke specific session

**Security Features**:
- `POST /api/user/mfa/enable` - Enable multi-factor authentication
- `POST /api/user/mfa/verify` - Verify MFA token
- `GET /api/user/audit` - View own audit log

All of these would use the same `withSelfServiceSudo()` pattern.
