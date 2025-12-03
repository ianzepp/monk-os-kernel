/**
 * Access Control
 *
 * Grant-based ACLs. No UNIX-style permission bits.
 * - Grants are explicit, not inherited
 * - Deny always wins over grants
 * - Operations are model-defined
 * - Check happens once at open(), not every I/O call
 * - FileHandle IS the capability
 */

/**
 * Permission grant
 */
export interface Grant {
    /** Who receives the grant (user, process, role UUID) */
    to: string;

    /** What operations are permitted */
    ops: string[];

    /** Optional expiration (ms since epoch) */
    expires?: number;
}

/**
 * Access Control List
 */
export interface ACL {
    /** Explicit grants */
    grants: Grant[];

    /** Explicit denies (UUIDs) - always wins over grants */
    deny: string[];
}

/**
 * Operations by model type
 */
export const MODEL_OPS: Record<string, string[]> = {
    file: ['read', 'write', 'delete', 'stat', '*'],
    folder: ['list', 'create', 'delete', 'stat', '*'],
    network: ['connect', 'listen', 'stat', '*'],
    device: ['read', 'write', 'stat', '*'],
    proc: ['signal', 'stat', '*'],
};

/**
 * Check if caller has permission for operation.
 *
 * @param acl - Access control list
 * @param caller - Caller UUID
 * @param op - Operation to check
 * @param now - Current time (for expiration check)
 * @returns True if permitted
 */
export function checkAccess(acl: ACL, caller: string, op: string, now: number = Date.now()): boolean {
    // Deny always wins
    if (acl.deny.includes(caller)) {
        return false;
    }

    // Check grants
    for (const grant of acl.grants) {
        if (grant.to !== caller) {
            continue;
        }

        // Check expiration
        if (grant.expires !== undefined && grant.expires < now) {
            continue;
        }

        // Check operation
        if (grant.ops.includes('*') || grant.ops.includes(op)) {
            return true;
        }
    }

    return false;
}

/**
 * Check multiple operations at once.
 *
 * @param acl - Access control list
 * @param caller - Caller UUID
 * @param ops - Operations to check
 * @param now - Current time
 * @returns True if ALL operations permitted
 */
export function checkAccessAll(acl: ACL, caller: string, ops: string[], now: number = Date.now()): boolean {
    return ops.every((op) => checkAccess(acl, caller, op, now));
}

/**
 * Create default ACL for new entity.
 * Creator gets full control. Everyone else gets read/stat access (world-readable).
 * This matches traditional Unix file permissions (644: rw-r--r--).
 *
 * @param creator - Creator UUID
 * @returns Default ACL
 */
export function defaultACL(creator: string): ACL {
    return {
        grants: [
            { to: creator, ops: ['*'] },
            { to: '*', ops: ['read', 'stat'] },
        ],
        deny: [],
    };
}

/**
 * Serialize ACL to JSON bytes for storage.
 */
export function encodeACL(acl: ACL): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(acl));
}

/**
 * Deserialize ACL from storage bytes.
 */
export function decodeACL(data: Uint8Array): ACL {
    const json = new TextDecoder().decode(data);
    return JSON.parse(json) as ACL;
}
