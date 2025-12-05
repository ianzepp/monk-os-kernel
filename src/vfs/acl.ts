/**
 * Access Control List (ACL) - Grant-based permission system
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Monk OS uses a capability-based security model with explicit grants. Unlike
 * traditional UNIX permission bits (rwx), access is controlled by named grants
 * that specify which principals (users, processes, roles) can perform which
 * operations on an entity.
 *
 * This design provides several advantages:
 * - Finer-grained control than rwx bits (arbitrary operation names)
 * - Explicit deny list for revocation (deny always wins)
 * - Time-limited grants with expiration
 * - Clear audit trail (grants are explicit, not computed from bits)
 *
 * The ACL is checked once at open() time, not on every I/O call. The resulting
 * FileHandle IS the capability - possession of a valid handle implies permission
 * was granted. This matches capability-based security principles and reduces
 * per-operation overhead.
 *
 * PERMISSION MODEL
 * ================
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                    ACL Evaluation                       │
 *   ├─────────────────────────────────────────────────────────┤
 *   │                                                         │
 *   │  1. Check deny list ──────────> DENIED (if match)       │
 *   │         │                                               │
 *   │         ▼ (no match)                                    │
 *   │                                                         │
 *   │  2. Check grants for caller                             │
 *   │         │                                               │
 *   │         ├──> Check expiration ──> SKIP (if expired)     │
 *   │         │                                               │
 *   │         └──> Check ops list ────> GRANTED (if match)    │
 *   │                   │                                     │
 *   │                   │ (includes '*' wildcard)             │
 *   │                   ▼                                     │
 *   │                                                         │
 *   │  3. No matching grant ──────────> DENIED                │
 *   │                                                         │
 *   └─────────────────────────────────────────────────────────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Deny always takes precedence over grants
 * INV-2: Expired grants are treated as non-existent
 * INV-3: Wildcard '*' in ops matches any operation
 * INV-4: Wildcard '*' in grant.to matches any principal
 * INV-5: Default ACL grants creator full access and world read/stat
 *
 * CONCURRENCY MODEL
 * =================
 * ACL checks are pure functions with no side effects. Multiple concurrent
 * checks against the same ACL are safe. ACL modification (not implemented
 * here) would require synchronization in the storage layer.
 *
 * MEMORY MANAGEMENT
 * =================
 * - ACLs are small JSON objects (grants + deny list)
 * - No caching in this module (caller manages storage)
 * - Encoding/decoding creates new objects (no shared references)
 *
 * @module vfs/acl
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Permission grant record.
 *
 * A grant specifies that a principal (user, process, role UUID) is permitted
 * to perform certain operations on an entity.
 *
 * DESIGN DECISIONS:
 * - 'to' is a UUID or wildcard '*' for world-readable grants
 * - 'ops' is an array allowing multiple operations per grant
 * - 'expires' enables time-limited access (e.g., temporary shares)
 */
export interface Grant {
    /**
     * Principal receiving the grant (UUID or '*' for anyone).
     *
     * WHY UUID not username: UUIDs are immutable, usernames can change.
     * Using UUIDs avoids confused deputy attacks from username recycling.
     */
    to: string;

    /**
     * Operations permitted by this grant.
     *
     * WHY array not set: JSON serialization; small lists don't benefit from Set.
     * Includes special value '*' for all operations.
     *
     * INVARIANT: At least one operation must be specified.
     */
    ops: string[];

    /**
     * Optional expiration timestamp (ms since epoch).
     *
     * WHY optional: Most grants are permanent. Expiration is for special cases
     * like temporary shares or time-limited access tokens.
     *
     * INVARIANT: If set, grant is ignored after this time.
     */
    expires?: number;
}

/**
 * Access Control List structure.
 *
 * Contains explicit grants and a deny list. The deny list provides a mechanism
 * for revocation that takes precedence over all grants.
 *
 * WHY separate deny list: Revocation is common (user leaves, access revoked).
 * Rather than removing grants (which may be complex with inheritance), we
 * add to deny list. Deny is checked first, making revocation immediate.
 */
export interface ACL {
    /**
     * Explicit permission grants.
     *
     * WHY array not map: Multiple grants per principal are allowed
     * (e.g., one permanent, one time-limited).
     */
    grants: Grant[];

    /**
     * Explicitly denied principals (UUIDs).
     *
     * WHY array not set: JSON serialization; typically small lists.
     * INVARIANT: Deny always wins over grants.
     */
    deny: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Standard operations by model type.
 *
 * WHY defined here: Provides documentation of expected operations per model.
 * Models may support additional operations beyond these.
 *
 * TESTABILITY: Allows tests to verify models implement expected operations.
 */
export const MODEL_OPS: Record<string, string[]> = {
    /** File operations: read content, write content, delete file, get metadata */
    file: ['read', 'write', 'delete', 'stat', '*'],

    /** Folder operations: list children, create children, delete folder, get metadata */
    folder: ['list', 'create', 'delete', 'stat', '*'],

    /** Network operations: establish connection, accept connections, get metadata */
    network: ['connect', 'listen', 'stat', '*'],

    /** Device operations: read from device, write to device, get metadata */
    device: ['read', 'write', 'stat', '*'],

    /** Process operations: send signals, get metadata */
    proc: ['signal', 'stat', '*'],
};

// =============================================================================
// ACCESS CHECK FUNCTIONS
// =============================================================================

/**
 * Check if a caller has permission for an operation.
 *
 * ALGORITHM:
 * 1. Check deny list - if caller is denied, return false immediately
 * 2. Iterate through grants looking for matching grant
 * 3. For each grant: check principal match, expiration, and operation
 * 4. Return true if any grant matches, false otherwise
 *
 * WHY caller not principal: In this context, we're checking a specific caller
 * (the entity making the request) against the ACL. The term "caller" is used
 * throughout the kernel codebase.
 *
 * @param acl - Access control list to check
 * @param caller - Caller's UUID
 * @param op - Operation to check (e.g., 'read', 'write')
 * @param now - Current time in ms (default: Date.now()) - injectable for testing
 * @returns True if caller is permitted to perform operation
 */
export function checkAccess(
    acl: ACL,
    caller: string,
    op: string,
    now: number = Date.now(),
): boolean {
    // INV-1: Deny always wins - check first
    if (acl.deny.includes(caller)) {
        return false;
    }

    // Check each grant for a match
    for (const grant of acl.grants) {
        // Check principal: exact match or wildcard '*'
        if (grant.to !== caller && grant.to !== '*') {
            continue;
        }

        // INV-2: Skip expired grants
        if (grant.expires !== undefined && grant.expires < now) {
            continue;
        }

        // INV-3: Check operation - exact match or wildcard '*'
        if (grant.ops.includes('*') || grant.ops.includes(op)) {
            return true;
        }
    }

    // No matching grant found
    return false;
}

/**
 * Check if a caller has permission for ALL of multiple operations.
 *
 * WHY separate function: Common pattern to check multiple operations at once
 * (e.g., open for read+write requires both permissions).
 *
 * ALGORITHM: Simply calls checkAccess for each operation, returns false on
 * first failure. Short-circuits for efficiency.
 *
 * @param acl - Access control list to check
 * @param caller - Caller's UUID
 * @param ops - Operations to check (all must be permitted)
 * @param now - Current time in ms (default: Date.now())
 * @returns True if caller is permitted for ALL operations
 */
export function checkAccessAll(
    acl: ACL,
    caller: string,
    ops: string[],
    now: number = Date.now(),
): boolean {
    return ops.every(op => checkAccess(acl, caller, op, now));
}

// =============================================================================
// ACL CREATION
// =============================================================================

/**
 * Create default ACL for a new entity.
 *
 * SECURITY MODEL (matches Unix 644):
 * - Creator gets full access ('*' wildcard)
 * - World gets read and stat access
 *
 * WHY world-readable default: Matches traditional Unix file permissions (644).
 * Developers expect files to be readable by default. Sensitive files should
 * explicitly restrict access.
 *
 * WHY not inherited: Inheritance adds complexity (what if parent changes?).
 * Explicit grants are simpler to reason about and audit.
 *
 * @param creator - UUID of the creating principal
 * @returns Default ACL with creator full access and world read
 */
export function defaultACL(creator: string): ACL {
    return {
        grants: [
            // Creator gets full control
            { to: creator, ops: ['*'] },
            // World gets read and stat (like Unix 644)
            { to: '*', ops: ['read', 'stat'] },
        ],
        deny: [],
    };
}

// =============================================================================
// SERIALIZATION
// =============================================================================

/**
 * Serialize ACL to JSON bytes for storage.
 *
 * WHY JSON: Human-readable, widely supported, sufficient for ACL size.
 * WHY Uint8Array: Matches storage engine interface (binary blobs).
 *
 * @param acl - ACL to serialize
 * @returns Encoded bytes
 */
export function encodeACL(acl: ACL): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(acl));
}

/**
 * Deserialize ACL from storage bytes.
 *
 * WHY no validation: Caller is responsible for storage integrity.
 * Invalid JSON will throw (intentional - corrupt data should fail fast).
 *
 * @param data - Encoded bytes from storage
 * @returns Deserialized ACL
 * @throws SyntaxError - If data is not valid JSON
 */
export function decodeACL(data: Uint8Array): ACL {
    const json = new TextDecoder().decode(data);

    return JSON.parse(json) as ACL;
}
