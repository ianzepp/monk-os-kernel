/**
 * Check if a mount operation matches a policy rule.
 *
 * @module kernel/kernel/matches-mount-rule
 */

import type { MountPolicyRule } from '../kernel.js';
import { matchesPattern } from './matches-pattern.js';

/**
 * Check if a mount operation matches a policy rule.
 *
 * @param rule - Policy rule to check
 * @param caller - Caller UUID
 * @param source - Mount source
 * @param target - Mount target
 * @returns True if rule matches
 */
export function matchesMountRule(
    rule: MountPolicyRule,
    caller: string,
    source: string,
    target: string
): boolean {
    // Check caller pattern
    if (rule.caller !== '*' && rule.caller !== caller) {
        return false;
    }

    // Check source pattern
    if (!matchesPattern(rule.source, source)) {
        return false;
    }

    // Check target pattern (with substitutions)
    const expandedTarget = rule.target
        .replace('{caller}', caller);
    // TODO: Add {tenant} substitution when auth context is available

    if (!matchesPattern(expandedTarget, target)) {
        return false;
    }

    return true;
}
