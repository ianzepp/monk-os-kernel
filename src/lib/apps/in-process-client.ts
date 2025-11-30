/**
 * In-Process Client
 *
 * Provides a client interface for app packages to call the core API
 * without network overhead. Routes requests directly through Hono's
 * fetch() method.
 */

import type { Context } from 'hono';
import type { Hono } from 'hono';

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    error_code?: string;
}

export interface InProcessClient {
    get<T = any>(path: string, query?: Record<string, string>): Promise<ApiResponse<T>>;
    post<T = any>(path: string, body?: any): Promise<ApiResponse<T>>;
    put<T = any>(path: string, body?: any): Promise<ApiResponse<T>>;
    delete<T = any>(path: string): Promise<ApiResponse<T>>;
    request<T = any>(method: string, path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
}

export interface RequestOptions {
    query?: Record<string, string>;
    body?: any;
    headers?: Record<string, string>;
}

/**
 * Creates an in-process client that routes requests through Hono
 * without network overhead. Forwards authentication from the original request.
 */
export function createInProcessClient(c: Context, honoApp: Hono): InProcessClient {
    const authHeader = c.req.header('Authorization');

    async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
        // Prevent apps from calling other apps (circular routing)
        if (path.startsWith('/app/')) {
            throw new Error('App packages cannot call /app/* routes');
        }

        // Build URL with query parameters
        let url = `http://internal${path}`;
        if (options.query && Object.keys(options.query).length > 0) {
            const params = new URLSearchParams(options.query);
            url += `?${params.toString()}`;
        }

        // Build headers - always request JSON responses
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...options.headers,
        };

        if (authHeader) {
            headers['Authorization'] = authHeader;
        }

        // Build request
        const init: RequestInit = { method, headers };
        if (options.body !== undefined && !['GET', 'HEAD'].includes(method)) {
            init.body = JSON.stringify(options.body);
        }

        const req = new Request(url, init);
        const res = await honoApp.fetch(req);

        return res.json() as Promise<ApiResponse<T>>;
    }

    return {
        get: <T>(path: string, query?: Record<string, string>) =>
            request<T>('GET', path, { query }),
        post: <T>(path: string, body?: any) =>
            request<T>('POST', path, { body }),
        put: <T>(path: string, body?: any) =>
            request<T>('PUT', path, { body }),
        delete: <T>(path: string) =>
            request<T>('DELETE', path),
        request,
    };
}
