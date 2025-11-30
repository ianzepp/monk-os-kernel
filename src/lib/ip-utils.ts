/**
 * IP Address Utilities
 *
 * Functions for extracting and validating client IP addresses.
 */

import type { Context } from 'hono';

/**
 * Extract client IP from request context.
 * Checks X-Forwarded-For, X-Real-IP, and falls back to connection info.
 */
export function getClientIp(context: Context): string {
    // Check X-Forwarded-For header (may contain multiple IPs)
    const forwarded = context.req.header('x-forwarded-for');
    if (forwarded) {
        // Take the first IP (original client)
        const firstIp = forwarded.split(',')[0].trim();
        if (firstIp) return normalizeIp(firstIp);
    }

    // Check X-Real-IP header
    const realIp = context.req.header('x-real-ip');
    if (realIp) {
        return normalizeIp(realIp.trim());
    }

    // Fall back to connection remote address
    // May be available via Hono env depending on runtime
    const connInfo = context.env?.remoteAddr || context.env?.ip;
    if (connInfo) {
        return normalizeIp(String(connInfo));
    }

    // Fail secure: don't default to localhost as that would bypass IP restrictions
    throw new Error('Unable to determine client IP address - check proxy configuration');
}

/**
 * Normalize IP address for comparison.
 * Handles IPv6 localhost (::1) and IPv4-mapped IPv6 addresses.
 */
export function normalizeIp(ip: string): string {
    // Remove IPv6 brackets if present
    ip = ip.replace(/^\[|\]$/g, '');

    // Handle IPv4-mapped IPv6 (::ffff:127.0.0.1 -> 127.0.0.1)
    if (ip.startsWith('::ffff:')) {
        return ip.substring(7);
    }

    return ip;
}

/**
 * Check if an IP address is allowed by a whitelist.
 *
 * @param clientIp - The client's IP address
 * @param allowedIps - Array of allowed IP addresses/ranges (PostgreSQL INET format)
 * @returns true if allowed, false if blocked
 */
export function isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
    const normalizedClient = normalizeIp(clientIp);

    for (const allowed of allowedIps) {
        const normalizedAllowed = normalizeIp(allowed);

        // Exact match
        if (normalizedClient === normalizedAllowed) {
            return true;
        }

        // Handle localhost variations
        if (isLocalhost(normalizedClient) && isLocalhost(normalizedAllowed)) {
            return true;
        }

        // CIDR range matching (simplified - exact match or /32 for now)
        // TODO: Implement proper CIDR matching if needed
        if (normalizedAllowed.includes('/')) {
            const [network, prefix] = normalizedAllowed.split('/');
            if (prefix === '32' && normalizeIp(network) === normalizedClient) {
                return true;
            }
            // For other CIDR ranges, we'd need bitwise comparison
            // For now, skip complex CIDR matching
        }
    }

    return false;
}

/**
 * Check if an IP is a localhost address.
 */
function isLocalhost(ip: string): boolean {
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
