/**
 * Request Body Parser Middleware
 *
 * Parses request bodies based on Content-Type header.
 * Supports multiple formats to reduce token usage for LLM integrations.
 *
 * Sets context.get('parsedBody') for route handlers to consume.
 */

import type { Context, Next } from 'hono';
import { getFormatter } from '@src/lib/formatters/index.js';
import { fromBytes } from '@monk/common';

/**
 * Content-Type to format name mapping
 */
const CONTENT_TYPE_MAP: Array<{ match: string | RegExp; format: string }> = [
    { match: 'application/json', format: 'json' },
    { match: 'application/toon', format: 'toon' },
    { match: 'application/yaml', format: 'yaml' },
    { match: 'application/x-yaml', format: 'yaml' },
    { match: 'text/yaml', format: 'yaml' },
    { match: 'text/x-yaml', format: 'yaml' },
    { match: 'application/toml', format: 'toml' },
    { match: 'application/x-toml', format: 'toml' },
    { match: 'text/toml', format: 'toml' },
    { match: 'application/msgpack', format: 'msgpack' },
    { match: 'application/x-msgpack', format: 'msgpack' },
    { match: 'application/cbor', format: 'cbor' },
    { match: 'application/morse', format: 'morse' },
    { match: 'text/csv', format: 'csv' },
    { match: 'application/csv', format: 'csv' },
    { match: 'application/x-sqlite3', format: 'sqlite' },
    { match: 'application/vnd.sqlite3', format: 'sqlite' },
];

/**
 * Detect format from Content-Type header and body content
 */
function detectFormat(contentType: string, body: Uint8Array): string {
    const ct = contentType.toLowerCase();

    // Check explicit content types
    for (const { match, format } of CONTENT_TYPE_MAP) {
        if (typeof match === 'string' && ct.includes(match)) {
            return format;
        }
        if (match instanceof RegExp && match.test(ct)) {
            return format;
        }
    }

    // Heuristics for text/plain (decode to string for inspection)
    if (ct.includes('text/plain')) {
        const text = fromBytes(body).trim();
        // TOON: starts with { (object notation)
        if (text.startsWith('{')) {
            return 'toon';
        }
        // Morse: only dots, dashes, spaces, slashes
        if (/^[.\-\s\/]+$/.test(text)) {
            return 'morse';
        }
    }

    // Default to JSON
    return 'json';
}

/**
 * Error response for unavailable format
 */
function formatUnavailableResponse(context: Context, format: string) {
    return context.json({
        success: false,
        error: `Format '${format}' is not available for parsing`,
        error_code: 'FORMAT_UNAVAILABLE',
        details: `Install the optional package: npm install @monk/formatter-${format}`
    }, 400);
}

/**
 * Parses request body based on Content-Type header
 */
export async function bodyParserMiddleware(context: Context, next: Next) {
    // Skip parsing if no body (GET, DELETE, etc.)
    if (context.req.method === 'GET' || context.req.method === 'DELETE' || context.req.method === 'HEAD') {
        return await next();
    }

    try {
        const contentType = context.req.header('content-type') || '';
        const arrayBuffer = await context.req.arrayBuffer();
        const rawBody = new Uint8Array(arrayBuffer);

        // Skip if empty body
        if (rawBody.length === 0) {
            return await next();
        }

        // Detect format and get formatter
        const format = detectFormat(contentType, rawBody);
        const formatter = getFormatter(format);

        if (!formatter) {
            return formatUnavailableResponse(context, format);
        }

        // Parse the body
        const parsedBody = formatter.decode(rawBody);

        // Store parsed body in context for route handlers
        context.set('parsedBody', parsedBody);

        // Override context.req.json() to return parsed body
        context.req.json = async function() {
            return parsedBody;
        } as any;

    } catch (error) {
        // If parsing fails, return error response
        return context.json({
            success: false,
            error: 'Failed to parse request body',
            error_code: 'INVALID_REQUEST_BODY',
            details: error instanceof Error ? error.message : 'Unknown error'
        }, 400);
    }

    return await next();
}
