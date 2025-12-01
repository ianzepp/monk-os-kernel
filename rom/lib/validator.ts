/**
 * String Validation for VFS Scripts
 *
 * Validator.js-inspired string checks. Pure functions, no I/O.
 */

// ============================================================================
// Format Validators
// ============================================================================

/**
 * Check if string is a valid email address.
 */
export function isEmail(str: string): boolean {
    // Simplified but reasonable email regex
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(str);
}

/**
 * Check if string is a valid URL.
 */
export function isURL(str: string, options: { protocols?: string[]; requireProtocol?: boolean } = {}): boolean {
    const { protocols = ['http', 'https'], requireProtocol = true } = options;

    try {
        const url = new URL(str);
        if (protocols.length > 0 && !protocols.includes(url.protocol.replace(':', ''))) {
            return false;
        }
        return true;
    } catch {
        if (!requireProtocol) {
            // Try with https://
            try {
                new URL('https://' + str);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }
}

/**
 * Check if string is a valid UUID (any version).
 */
export function isUUID(str: string, version?: 1 | 3 | 4 | 5 | 7): boolean {
    const patterns: Record<number | 'any', RegExp> = {
        1: /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        3: /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        4: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        5: /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        7: /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        any: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    };

    return patterns[version ?? 'any'].test(str);
}

/**
 * Check if string is valid JSON.
 */
export function isJSON(str: string): boolean {
    try {
        JSON.parse(str);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if string is a valid IP address (v4 or v6).
 */
export function isIP(str: string, version?: 4 | 6): boolean {
    if (version === 4 || version === undefined) {
        if (isIPv4(str)) return true;
    }
    if (version === 6 || version === undefined) {
        if (isIPv6(str)) return true;
    }
    return false;
}

/**
 * Check if string is a valid IPv4 address.
 */
export function isIPv4(str: string): boolean {
    const parts = str.split('.');
    if (parts.length !== 4) return false;

    for (const part of parts) {
        if (!/^\d+$/.test(part)) return false;
        const num = parseInt(part, 10);
        if (num < 0 || num > 255) return false;
        if (part.length > 1 && part[0] === '0') return false; // No leading zeros
    }

    return true;
}

/**
 * Check if string is a valid IPv6 address.
 */
export function isIPv6(str: string): boolean {
    // Simplified IPv6 validation
    const regex = /^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$|^::$|^([0-9a-f]{1,4}:){1,7}:$|^:([0-9a-f]{1,4}:){1,7}$|^([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}$|^([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}$|^([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}$|^([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}$|^([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}$|^[0-9a-f]{1,4}:(:[0-9a-f]{1,4}){1,6}$|^:((:[0-9a-f]{1,4}){1,7}|:)$/i;
    return regex.test(str);
}

/**
 * Check if string is a valid MAC address.
 */
export function isMACAddress(str: string, options: { separator?: ':' | '-' | '' } = {}): boolean {
    const { separator } = options;

    if (separator === '') {
        return /^[0-9a-f]{12}$/i.test(str);
    }

    const colonFormat = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
    const dashFormat = /^([0-9a-f]{2}-){5}[0-9a-f]{2}$/i;

    if (separator === ':') return colonFormat.test(str);
    if (separator === '-') return dashFormat.test(str);

    return colonFormat.test(str) || dashFormat.test(str);
}

/**
 * Check if string is a valid port number.
 */
export function isPort(str: string): boolean {
    const num = parseInt(str, 10);
    return Number.isInteger(num) && num >= 0 && num <= 65535;
}

// ============================================================================
// String Content Validators
// ============================================================================

/**
 * Check if string contains only alphanumeric characters.
 */
export function isAlphanumeric(str: string): boolean {
    return /^[a-zA-Z0-9]+$/.test(str);
}

/**
 * Check if string contains only alphabetic characters.
 */
export function isAlpha(str: string): boolean {
    return /^[a-zA-Z]+$/.test(str);
}

/**
 * Check if string contains only numeric characters.
 */
export function isNumeric(str: string): boolean {
    return /^[0-9]+$/.test(str);
}

/**
 * Check if string is a valid integer.
 */
export function isInt(str: string, options: { min?: number; max?: number } = {}): boolean {
    if (!/^[-+]?\d+$/.test(str)) return false;

    const num = parseInt(str, 10);
    if (options.min !== undefined && num < options.min) return false;
    if (options.max !== undefined && num > options.max) return false;

    return true;
}

/**
 * Check if string is a valid float.
 */
export function isFloat(str: string, options: { min?: number; max?: number } = {}): boolean {
    if (!/^[-+]?\d*\.?\d+([eE][-+]?\d+)?$/.test(str)) return false;

    const num = parseFloat(str);
    if (!Number.isFinite(num)) return false;
    if (options.min !== undefined && num < options.min) return false;
    if (options.max !== undefined && num > options.max) return false;

    return true;
}

/**
 * Check if string is a valid hexadecimal.
 */
export function isHexadecimal(str: string): boolean {
    return /^(0x)?[0-9a-f]+$/i.test(str);
}

/**
 * Check if string is valid base64.
 */
export function isBase64(str: string): boolean {
    if (str.length === 0) return false;
    if (str.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

/**
 * Check if string is a valid hex color.
 */
export function isHexColor(str: string): boolean {
    return /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(str);
}

// ============================================================================
// String Property Validators
// ============================================================================

/**
 * Check if string is empty (length 0).
 */
export function isEmpty(str: string): boolean {
    return str.length === 0;
}

/**
 * Check if string length is within bounds.
 */
export function isLength(str: string, options: { min?: number; max?: number }): boolean {
    const { min = 0, max } = options;
    if (str.length < min) return false;
    if (max !== undefined && str.length > max) return false;
    return true;
}

/**
 * Check if string is lowercase.
 */
export function isLowercase(str: string): boolean {
    return str === str.toLowerCase() && str !== str.toUpperCase();
}

/**
 * Check if string is uppercase.
 */
export function isUppercase(str: string): boolean {
    return str === str.toUpperCase() && str !== str.toLowerCase();
}

/**
 * Check if string matches a regex.
 */
export function matches(str: string, pattern: RegExp | string): boolean {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    return regex.test(str);
}

// ============================================================================
// Specialized Validators
// ============================================================================

/**
 * Check if string is a valid slug (url-safe identifier).
 */
export function isSlug(str: string): boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(str);
}

/**
 * Check if string is a valid semantic version.
 */
export function isSemVer(str: string): boolean {
    return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(str);
}

/**
 * Check if string is a valid MIME type.
 */
export function isMimeType(str: string): boolean {
    return /^[a-z]+\/[a-z0-9.+-]+$/i.test(str);
}

/**
 * Check if string is a valid JWT.
 */
export function isJWT(str: string): boolean {
    const parts = str.split('.');
    if (parts.length !== 3) return false;

    // Each part should be valid base64url
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    return parts.every(part => base64urlRegex.test(part));
}

/**
 * Check if string looks like a credit card number (Luhn check).
 */
export function isCreditCard(str: string): boolean {
    // Remove spaces and dashes
    const sanitized = str.replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(sanitized)) return false;

    // Luhn algorithm
    let sum = 0;
    let isEven = false;

    for (let i = sanitized.length - 1; i >= 0; i--) {
        let digit = parseInt(sanitized[i], 10);

        if (isEven) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }

        sum += digit;
        isEven = !isEven;
    }

    return sum % 10 === 0;
}
