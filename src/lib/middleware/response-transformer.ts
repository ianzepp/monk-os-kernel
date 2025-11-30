/**
 * Response Pipeline Middleware
 *
 * Single middleware that orchestrates all response transformations in a predetermined order.
 *
 * Pipeline Order:
 * 1. Field Extraction - Apply ?unwrap, ?select=, ?stat=true, ?access=true
 * 2. Format Conversion - Convert to JSON/YAML/CSV/TOON/etc based on ?format=
 * 3. Encryption - Encrypt formatted text if ?encrypt=pgp
 *
 * Architecture:
 * - Overrides context.json() ONCE before route handlers run
 * - When routes call context.json(data), pipeline processes the data
 * - Returns final formatted/encrypted response
 * - No response cloning, no re-parsing, no multiple overrides
 */

import type { Context, Next } from 'hono';
import type { JWTPayload } from '@src/lib/jwt-generator.js';

// Field extraction utilities
import { extract } from '@src/lib/field-extractor.js';
import { transform, transformMany } from '@src/lib/transformers/index.js';

// Formatter registry
import { getFormatter, JsonFormatter } from '@src/lib/formatters/index.js';
import { fromBytes, toBytes } from '@monk/common';

// Encryption utilities
import { deriveKeyFromJWT, extractSaltFromPayload } from '@src/lib/encryption/key-derivation.js';
import { encrypt } from '@src/lib/encryption/aes-gcm.js';
import { createArmor } from '@src/lib/encryption/pgp-armor.js';

/**
 * Error response for unavailable format (missing optional @monk/formatter-* package)
 */
function formatUnavailableError(format: string): { data: Uint8Array; contentType: string } {
    const error = {
        success: false,
        error: `Format '${format}' is not available`,
        error_code: 'FORMAT_UNAVAILABLE',
        details: `Install the optional package: npm install @monk/formatter-${format}`
    };
    return {
        data: toBytes(JSON.stringify(error, null, 2)),
        contentType: JsonFormatter.contentType
    };
}

/**
 * Pipeline Step 1: Field Extraction
 *
 * Applies server-side field extraction and system field filtering:
 * - ?unwrap - Remove envelope, return data object
 * - ?select=id,name - Remove envelope, return specific fields
 * - ?stat=true - Include timestamp fields (excluded by default)
 * - ?access=true - Include ACL fields (excluded by default)
 *
 * Only processes successful responses (success: true)
 */
function applyFieldExtraction(data: any, context: Context): any {
    // Only process successful responses with envelope structure
    if (!data || typeof data !== 'object' || data.success !== true) {
        return data;
    }

    // Query options
    const unwrapParam = context.req.query('unwrap');
    const selectParam = context.req.query('select');
    const statParam = context.req.query('stat');
    const accessParam = context.req.query('access');

    // Parse boolean flags (default: exclude stat/access fields)
    const includeStat = statParam === 'true' || statParam === '1';
    const includeAccess = accessParam === 'true' || accessParam === '1';

    // Parse select as comma-separated list
    const selectFields = selectParam && selectParam.trim() !== ''
        ? selectParam.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;

    // Define the result, while injecting the HTTP method, path, stat, and access
    let result = {
        success: true,
        method: context.req.method,
        path: context.req.path,
        stat: statParam,
        access: accessParam,
        ...data
    };

    // Step 1a: Transform data fields (apply stat/access/select filtering)
    // Only filter stat/access fields for data record endpoints
    const path = context.req.path;
    const shouldFilterFields = path.startsWith('/api/data') || path.startsWith('/api/trashed');

    if (result.data !== undefined && shouldFilterFields) {
        const options = { stat: includeStat, access: includeAccess, select: selectFields };
        if (Array.isArray(result.data)) {
            result.data = transformMany(result.data, options);
        } else if (typeof result.data === 'object' && result.data !== null) {
            result.data = transform(result.data, options);
        }
    }

    // Step 1b: Unwrap or select fields (envelope extraction)
    if (selectParam && selectParam.trim() !== '') {
        // select= implies unwrap + field filtering
        // Prepend "data." to each path since select operates within data scope
        const paths = (selectParam as string)
            .split(',')
            .map(p => `data.${p.trim()}`)
            .join(',');
        result = extract(result, paths);
    } else if (unwrapParam !== undefined) {
        // unwrap without select = return full data object
        result = extract(result, 'data');
    }

    // Convert undefined to null (undefined is not valid JSON)
    return result === undefined ? null : result;
}

/**
 * Pipeline Step 2: Format Conversion
 *
 * Converts data to bytes in requested format using the formatter registry.
 * Returns { data, contentType } for next pipeline step.
 */
function applyFormatter(data: any, context: Context): { data: Uint8Array; contentType: string } {
    const format = (context.get('responseFormat') as string) || 'json';
    const formatter = getFormatter(format);

    if (!formatter) {
        return formatUnavailableError(format);
    }

    try {
        // Special case: CSV and SQLite auto-unwrap envelope (they expect arrays)
        const inputData = ((format === 'csv' || format === 'sqlite') && data?.data !== undefined) ? data.data : data;

        return {
            data: formatter.encode(inputData),
            contentType: formatter.contentType
        };
    } catch (error) {
        // If formatting fails, gracefully fall back to JSON
        console.error(`Format encoding failed (${format}), falling back to JSON:`, error);
        return {
            data: toBytes(JSON.stringify(data, null, 2)),
            contentType: JsonFormatter.contentType
        };
    }
}

/**
 * Pipeline Step 3: Encryption (Optional)
 *
 * Encrypts formatted data if ?encrypt=pgp is present:
 * - Derives encryption key from JWT token using PBKDF2
 * - Encrypts with AES-256-GCM
 * - Returns PGP-style ASCII armor
 *
 * Security Model:
 * - JWT token IS the decryption key
 * - Same JWT = same key (allows decryption)
 * - JWT expiry = old encrypted messages undecryptable
 * - Purpose: Transport security, not long-term storage
 *
 * Encrypts ALL responses including errors (prevents info leakage)
 */
function applyEncryption(data: Uint8Array, context: Context): { data: Uint8Array; encrypted: boolean } {
    const encryptParam = context.req.query('encrypt');

    if (encryptParam !== 'pgp') {
        return { data, encrypted: false }; // No encryption requested
    }

    try {
        // Extract JWT token from Authorization header
        const authHeader = context.req.header('Authorization');
        if (!authHeader) {
            throw new Error('Encryption requires authentication - missing Authorization header');
        }

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            throw new Error('Encryption requires authentication - invalid Authorization header format');
        }

        const jwt = parts[1];

        // Get JWT payload from context (set by authValidatorMiddleware)
        const jwtPayload = context.get('jwtPayload') as JWTPayload | undefined;
        if (!jwtPayload) {
            throw new Error('Encryption requires valid JWT payload - token not decoded');
        }

        // Derive encryption key from JWT token
        const salt = extractSaltFromPayload(jwtPayload);
        const key = deriveKeyFromJWT(jwt, salt);

        // Convert to string for encryption (encryption works on text)
        const text = fromBytes(data);

        // Encrypt the formatted text
        const encryptionResult = encrypt(text, key);

        // Create PGP-style ASCII armor
        const armored = createArmor(encryptionResult);

        return { data: toBytes(armored), encrypted: true };
    } catch (error) {
        // Encryption failed - log error and return unencrypted
        // This allows the API to remain functional even if encryption fails
        console.error('Encryption failed, returning unencrypted response:', error);
        return { data, encrypted: false };
    }
}

/**
 * Response Pipeline Middleware
 *
 * Single point of interception for all JSON responses.
 * Runs transformation pipeline: extract → format → encrypt
 *
 * Routes call context.json(data) as normal, pipeline handles the rest.
 */
export async function responseTransformerMiddleware(context: Context, next: Next) {
    // Store original methods
    const originalJson = context.json.bind(context);

    // Override context.json() to intercept ALL JSON responses
    context.json = function (data: any, init?: any) {
        // Only process object responses (skip primitives, null, undefined)
        // This allows routes to return simple values if needed
        const shouldProcess = data && typeof data === 'object';
        if (!shouldProcess) {
            return originalJson(data, init);
        }

        // ========== PIPELINE START ==========

        let result = data;

        // Step 1: Field Extraction (?unwrap, ?select=, ?stat=true, ?access=true)
        result = applyFieldExtraction(result, context);

        // Step 2: Format Conversion (?format=yaml|csv|toon|etc)
        const formatted = applyFormatter(result, context);

        // Step 3: Encryption (?encrypt=pgp)
        const { data: finalData, encrypted } = applyEncryption(formatted.data, context);

        // ========== PIPELINE END ==========

        // Determine final content type and headers
        const finalContentType = encrypted ? 'text/plain; charset=utf-8' : formatted.contentType;

        const headers: Record<string, string> = {
            'Content-Type': finalContentType
        };

        if (encrypted) {
            headers['X-Monk-Encrypted'] = 'pgp';
            headers['X-Monk-Cipher'] = 'AES-256-GCM';
        }

        // Extract status code
        const status = typeof init === 'number' ? init : init?.status || 200;

        // Return final response with byte data
        return new Response(finalData, { status, headers });
    } as any; // Type assertion needed for Hono method override

    // Execute route handlers
    await next();
}
