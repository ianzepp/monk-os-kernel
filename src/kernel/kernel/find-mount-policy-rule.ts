/**
 * Find a matching mount policy rule.
 *
 * Rules are evaluated in order; first match wins.
 *
 * @module kernel/kernel/find-mount-policy-rule
 */

import type { Kernel } from '../kernel.js';
import type { MountPolicyRule } from '../kernel.js';
import { matchesMountRule } from './matches-mount-rule.js';

/**
 * Find a matching mount policy rule.
 *
 * @param self - Kernel instance
 * @param caller - Caller UUID
 * @param source - Mount source
 * @param target - Mount target
 * @returns Matching rule or null
 */
export function findMountPolicyRule(
    self: Kernel,
    caller: string,
    source: string,
    target: string
): MountPolicyRule | null {
    for (const rule of self.mountPolicy.rules) {
        if (matchesMountRule(rule, caller, source, target)) {
            return rule;
        }
    }
    return null;
}
