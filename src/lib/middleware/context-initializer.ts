/**
 * System Context Middleware
 *
 * Hono middleware that initializes System context and attaches it to the request context.
 * Provides global error handling and automatic response formatting.
 *
 * Supports streaming responses via async iterables:
 * - When route returns an AsyncGenerator and client accepts 'application/x-ndjson'
 * - Streams records as newline-delimited JSON (JSONL)
 * - Falls back to array collection for non-streaming clients
 *
 * Requires authValidatorMiddleware to run first to populate context.systemInit
 * with authentication data.
 */

import type { Context, Next } from 'hono';
import { System, type SystemInit } from '@src/lib/system.js';
import { createValidationError, createInternalError } from '@src/lib/api-helpers.js';
import { ValidationError, BusinessLogicError, SystemError } from '@src/lib/observers/errors.js';

/**
 * Check if a value is an async iterable (AsyncGenerator)
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return value !== null &&
        typeof value === 'object' &&
        Symbol.asyncIterator in value;
}

/**
 * Create a streaming JSONL response from an array
 *
 * Each record is JSON-stringified and written as a separate line.
 * Uses ReadableStream for chunked transfer to client.
 *
 * Note: The array is already collected (by withTransaction) so this
 * doesn't save memory on the server side, but it does enable:
 * - Chunked transfer encoding for faster time-to-first-byte
 * - JSONL format for easier client-side streaming parsing
 */
function createJsonlStreamFromArray(records: unknown[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;

    return new ReadableStream({
        pull(controller) {
            if (index < records.length) {
                const line = JSON.stringify(records[index]) + '\n';
                controller.enqueue(encoder.encode(line));
                index++;
            } else {
                controller.close();
            }
        }
    });
}

/**
 * Create a streaming JSONL response from an async iterable
 *
 * Each record is JSON-stringified and written as a separate line.
 * Uses ReadableStream with async iteration for true streaming.
 *
 * The connection cleanup is handled by the wrapped generator from
 * runWithSearchPath - when iteration completes, the connection is released.
 */
function createJsonlStreamFromAsyncIterable(iterable: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iterator = iterable[Symbol.asyncIterator]();

    return new ReadableStream({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next();
                if (done) {
                    controller.close();
                } else {
                    const line = JSON.stringify(value) + '\n';
                    controller.enqueue(encoder.encode(line));
                }
            } catch (error) {
                // Write error as final line before closing
                const errorLine = JSON.stringify({
                    error: true,
                    message: error instanceof Error ? error.message : String(error)
                }) + '\n';
                controller.enqueue(encoder.encode(errorLine));
                controller.close();
            }
        },
        async cancel() {
            // If client disconnects, ensure iterator is closed
            // This triggers the finally block in wrapAsyncIterableWithCleanup
            await iterator.return?.();
        }
    });
}

/**
 * Collect async iterable into an array
 *
 * Used when client doesn't accept streaming format but route returned
 * an async iterable.
 */
async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const results: T[] = [];
    for await (const item of iterable) {
        results.push(item);
    }
    return results;
}

/**
 * System context middleware - sets up System instance and global error handling
 *
 * Attaches system to context.set('system', system) for use in route handlers.
 * Provides global error handling with proper error categorization.
 *
 * Uses systemInit from context (set by authValidatorMiddleware).
 */
export async function contextInitializerMiddleware(context: Context, next: Next) {
    try {
        // Extract system options from query parameters
        // Note: trashed option removed from URL - use /api/trashed endpoint instead
        // Note: deleted option is admin-only for permanent delete operations
        const options = {
            deleted: context.req.query('include_deleted') === 'true',
        };

        // Get systemInit from context (set by jwt-system-init, enriched by user-validation)
        const systemInit = context.get('systemInit') as SystemInit | undefined;

        // Create System instance - prefer systemInit, fallback to legacy context constructor
        const system = systemInit
            ? new System(systemInit, options)
            : new System(context, options);

        // Attach system to Hono context for route handler access
        context.set('system', system);

        console.debug(`🔧 System context initialized for request: ${context.req.method} ${context.req.url}`);

        // Execute route handler
        const result = await next();

        // If handler created and finalized a response, return it
        if (context.finalized) {
            return result;
        }

        // Check if route set a result via withTransaction() or withSearchPath()
        const routeResult = context.get('routeResult');
        if (routeResult !== undefined) {
            const accept = context.req.header('Accept') || '';
            const wantsJsonl = accept.includes('application/x-ndjson') ||
                               accept.includes('application/jsonl');

            // Case 1: True async iterable (from withSearchPath + streamAny)
            // Stream directly from database cursor to HTTP response
            if (isAsyncIterable(routeResult)) {
                if (wantsJsonl) {
                    // True streaming: iterate generator, stream JSONL to client
                    // Connection is held open during streaming
                    const stream = createJsonlStreamFromAsyncIterable(routeResult);
                    return new Response(stream, {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/x-ndjson',
                            'Transfer-Encoding': 'chunked',
                        }
                    });
                }

                // Client doesn't want streaming - collect into array
                const collected = await collectAsyncIterable(routeResult);
                const routeTotal = context.get('routeTotal');
                const responseData = {
                    success: true,
                    data: collected,
                    ...(routeTotal !== undefined && { total: routeTotal })
                };
                return context.json(responseData, 200);
            }

            // Case 2: Array marked streamable (from withTransaction + streamAny)
            // Already collected in memory, but can still output as JSONL
            const isStreamable = context.get('streamable') === true;
            if (isStreamable && Array.isArray(routeResult) && wantsJsonl) {
                const stream = createJsonlStreamFromArray(routeResult);
                return new Response(stream, {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/x-ndjson',
                        'Transfer-Encoding': 'chunked',
                    }
                });
            }

            // Case 3: Regular result - return JSON envelope
            const routeTotal = context.get('routeTotal');
            const responseData = {
                success: true,
                data: routeResult,
                ...(routeTotal !== undefined && { total: routeTotal })
            };

            // Note: Field extraction (?unwrap, ?select=) is handled by fieldExtractionMiddleware
            // which runs after this middleware in the response chain

            return context.json(responseData, 200);
        }

        return result;
    } catch (error) {
        // Global error handling with proper error categorization
        console.error(`💥 Request failed: ${context.req.method} ${context.req.url}`, error);

        if (error instanceof ValidationError) {
            return createValidationError(context, error.message, []);
        } else if (error instanceof BusinessLogicError) {
            return createValidationError(context, error.message, []);
        } else if (error instanceof SystemError) {
            return createInternalError(context, error.message);
        } else if (error instanceof Error) {
            return createInternalError(context, error.message);
        } else {
            return createInternalError(context, 'Unknown error occurred');
        }
    }
}

