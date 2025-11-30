/**
 * Format Detection Middleware
 *
 * Determines the response format based on:
 * 1. Query parameter ?format=toon|json (highest priority)
 * 2. Accept header (Accept: application/toon)
 * 3. JWT formats field (from user token)
 * 4. Default to json (lowest priority)
 */

import type { Context, Next } from 'hono';
import type { JWTPayload } from '@src/lib/jwt-generator.js';

export type ResponseFormat = 'json' | 'toon' | 'yaml' | 'toml' | 'csv' | 'sqlite' | 'msgpack' | 'cbor' | 'brainfuck' | 'morse' | 'qr' | 'markdown' | 'grid-compact';

const SUPPORTED_FORMATS: ResponseFormat[] = ['json', 'toon', 'yaml', 'toml', 'csv', 'sqlite', 'msgpack', 'cbor', 'brainfuck', 'morse', 'qr', 'markdown', 'grid-compact'];

/**
 * Resolves the response format for the current request
 */
function resolveFormat(context: Context): ResponseFormat {
    // Priority 1: Explicit query parameter (allows override)
    const queryFormat = context.req.query('format');
    if (queryFormat && SUPPORTED_FORMATS.includes(queryFormat as ResponseFormat)) {
        return queryFormat as ResponseFormat;
    }

    // Priority 2: Accept header (standard HTTP content negotiation)
    const acceptHeader = context.req.header('accept');
    if (acceptHeader?.includes('application/toon')) {
        return 'toon';
    }
    if (acceptHeader?.includes('text/plain') && acceptHeader.includes('toon')) {
        return 'toon';
    }
    if (acceptHeader?.includes('application/yaml') || acceptHeader?.includes('application/x-yaml')) {
        return 'yaml';
    }
    if (acceptHeader?.includes('text/yaml') || acceptHeader?.includes('text/x-yaml')) {
        return 'yaml';
    }
    if (acceptHeader?.includes('application/msgpack') || acceptHeader?.includes('application/x-msgpack')) {
        return 'msgpack';
    }
    if (acceptHeader?.includes('application/cbor')) {
        return 'cbor';
    }
    if (acceptHeader?.includes('application/toml') || acceptHeader?.includes('application/x-toml')) {
        return 'toml';
    }
    if (acceptHeader?.includes('text/csv') || acceptHeader?.includes('application/csv')) {
        return 'csv';
    }
    if (acceptHeader?.includes('application/x-sqlite3') || acceptHeader?.includes('application/vnd.sqlite3')) {
        return 'sqlite';
    }

    // Priority 3: JWT format preference
    const jwtPayload = context.get('jwtPayload') as JWTPayload | undefined;
    if (jwtPayload?.format && SUPPORTED_FORMATS.includes(jwtPayload.format as ResponseFormat)) {
        return jwtPayload.format as ResponseFormat;
    }

    // Priority 4: Default to JSON
    return 'json';
}

/**
 * Format detection middleware
 * Sets context.get('responseFormat') for downstream middleware
 */
export async function formatDetectorMiddleware(context: Context, next: Next) {
    const format = resolveFormat(context);
    context.set('responseFormat', format);
    return await next();
}
