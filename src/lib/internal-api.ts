/**
 * Internal API Caller
 *
 * Enables fire-and-forget calls to Hono routes from within the application.
 * Uses honoApp.fetch() directly - no network overhead.
 *
 * Primary use case: Background job execution that needs full JWT context
 * (transaction management, namespace isolation, etc.)
 */

import type { Hono } from 'hono';

// Reference to the Hono app (set during app initialization)
let honoApp: Hono | null = null;

/**
 * Set the Hono app reference for internal API calls
 * Called once during app initialization in index.ts
 */
export function setHonoApp(app: Hono) {
    honoApp = app;
}

/**
 * Get the Hono app reference
 */
export function getHonoApp(): Hono | null {
    return honoApp;
}

/**
 * Call an internal API endpoint
 *
 * @param method HTTP method
 * @param path API path (e.g., /api/extracts/123/execute)
 * @param token JWT token (including 'Bearer ' prefix)
 * @param body Optional request body
 * @returns Response from the endpoint
 */
export async function callInternalApi(
    method: string,
    path: string,
    token: string,
    body?: any
): Promise<Response> {
    if (!honoApp) {
        throw new Error('Hono app not initialized for internal API calls');
    }

    const headers: Record<string, string> = {
        'Authorization': token,
    };

    const init: RequestInit = { method, headers };

    // Always set Content-Type for POST/PUT/PATCH (middleware requires it)
    if (!['GET', 'HEAD'].includes(method)) {
        headers['Content-Type'] = 'application/json';
        init.body = body ? JSON.stringify(body) : '{}';
    }

    const request = new Request(`http://localhost${path}`, init);
    return honoApp.fetch(request);
}

/**
 * Fire-and-forget internal API call
 *
 * Kicks off an internal request and returns immediately.
 * Errors are logged but not propagated.
 *
 * @param method HTTP method
 * @param path API path
 * @param token JWT token
 * @param body Optional request body
 * @param context Optional context for logging (e.g., { runId, operation })
 */
export function fireAndForget(
    method: string,
    path: string,
    token: string,
    body?: any,
    context?: Record<string, any>
): void {
    callInternalApi(method, path, token, body)
        .then(async (response) => {
            if (!response.ok) {
                const text = await response.text();
                console.error('Internal API call failed', {
                    ...context,
                    method,
                    path,
                    status: response.status,
                    error: text.substring(0, 500)
                });
            } else {
                console.info('Internal API call completed', {
                    ...context,
                    method,
                    path,
                    status: response.status
                });
            }
        })
        .catch((error) => {
            console.error('Internal API call error', {
                ...context,
                method,
                path,
                error: error instanceof Error ? error.message : String(error)
            });
        });
}
