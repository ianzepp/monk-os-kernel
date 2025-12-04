/**
 * Mount Policy Rule Matching
 *
 * WHY: Checks whether a mount operation (caller, source, target) satisfies
 * a policy rule. Used by mount syscall to enforce access control on filesystem
 * mounts. Supports pattern matching and template substitution for multi-tenant
 * scenarios.
 *
 * TEMPLATE SUBSTITUTION:
 * - {caller} → process UUID (enables per-process mount namespaces)
 * - {tenant} → tenant ID (future: multi-tenant isolation)
 *
 * @module kernel/kernel/matches-mount-rule
 */

import type { MountPolicyRule } from '../kernel.js';
import { matchesPattern } from './matches-pattern.js';

/**
 * Check if a mount operation matches a policy rule.
 *
 * ALGORITHM:
 * 1. Check caller pattern (exact match or wildcard)
 * 2. Check source pattern (glob matching)
 * 3. Expand target template with substitutions
 * 4. Check expanded target pattern (glob matching)
 *
 * WHY: Ordered checks (caller → source → target) fail fast on mismatches.
 * Template expansion happens after caller check to avoid unnecessary work.
 *
 * @param rule - Policy rule to check
 * @param caller - Caller UUID (process attempting mount)
 * @param source - Mount source (e.g., 'host:/path', 's3://bucket', 'tmpfs')
 * @param target - Mount target path (e.g., '/mnt/data')
 * @returns True if rule matches this mount operation
 */
export function matchesMountRule(
    rule: MountPolicyRule,
    caller: string,
    source: string,
    target: string
): boolean {
    // Check caller pattern (exact match or wildcard)
    if (rule.caller !== '*' && rule.caller !== caller) {
        return false;
    }

    // Check source pattern (supports glob matching)
    if (!matchesPattern(rule.source, source)) {
        return false;
    }

    // Expand target template with substitutions
    // WHY: Allows per-process or per-tenant mount namespaces
    const expandedTarget = rule.target
        .replace('{caller}', caller);
    // TODO: Add {tenant} substitution when auth context is available

    // Check expanded target pattern (supports glob matching)
    if (!matchesPattern(expandedTarget, target)) {
        return false;
    }

    return true;
}
