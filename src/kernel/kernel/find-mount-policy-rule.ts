/**
 * Mount Policy Rule Lookup
 *
 * WHY: Finds the first matching policy rule for a mount operation. Rules are
 * evaluated in order (first match wins), allowing specific rules before general
 * ones. This is critical for security: rule order determines access control.
 *
 * INVARIANT: Rules are evaluated in array order, first match is authoritative
 * VIOLATED BY: Reordering mount policy rules (breaks precedence expectations)
 *
 * @module kernel/kernel/find-mount-policy-rule
 */

import type { Kernel } from '../kernel.js';
import type { MountPolicyRule } from '../kernel.js';
import { matchesMountRule } from './matches-mount-rule.js';

/**
 * Find the first matching mount policy rule.
 *
 * ALGORITHM:
 * 1. Iterate through rules in order
 * 2. Return first rule that matches (caller, source, target)
 * 3. Return null if no rules match
 *
 * WHY: First-match semantics allow deny-by-default security. Common pattern:
 * - Specific allow rules first (e.g., "process X can mount host:/foo")
 * - General deny rules last (implicit: if no match, deny)
 *
 * SECURITY: Caller must check for null return and throw EPERM. A null return
 * means the mount operation is not authorized by any policy rule.
 *
 * @param self - Kernel instance (holds mount policy configuration)
 * @param caller - Caller UUID (process attempting mount)
 * @param source - Mount source (e.g., 'host:/path', 's3://bucket')
 * @param target - Mount target path (e.g., '/mnt/data')
 * @returns First matching rule, or null if no match
 */
export function findMountPolicyRule(
    self: Kernel,
    caller: string,
    source: string,
    target: string,
): MountPolicyRule | null {
    // INVARIANT: Rules evaluated in array order, first match wins
    for (const rule of self.mountPolicy.rules) {
        if (matchesMountRule(rule, caller, source, target)) {
            return rule;
        }
    }

    return null;
}
