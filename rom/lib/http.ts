/**
 * HTTP Client Library
 *
 * High-level HTTP client built on the channel syscalls.
 * Provides ergonomic API for REST APIs and streaming responses.
 *
 * Usage:
 *   import { Http } from '/lib/http';
 *
 *   const api = await Http.connect('https://api.example.com');
 *   const users = await api.get<User[]>('/users');
 *   await api.close();
 */

import { channel, httpRequest, type Response } from './process';

/**
 * HTTP client options.
 */
export interface HttpOptions {
    /** Default headers for all requests */
    headers?: Record<string, string>;
    /** Request timeout in ms */
    timeout?: number;
    /** Base path prefix for all requests */
    basePath?: string;
}

/**
 * Per-request options.
 */
export interface RequestOptions {
    /** Request-specific headers (merged with defaults) */
    headers?: Record<string, string>;
    /** Query parameters */
    query?: Record<string, string | number | boolean>;
    /** Request timeout override */
    timeout?: number;
}

/**
 * HTTP response wrapper.
 */
export interface HttpResponse<T = unknown> {
    /** Whether response was successful (op === 'ok') */
    ok: boolean;
    /** Response data */
    data: T;
}

/**
 * HTTP error with status code.
 */
export class HttpError extends Error {
    /** Error code (e.g., 'HTTP_404') */
    code: string;
    /** HTTP status code */
    status: number;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.status = parseInt(code.replace('HTTP_', '')) || 0;
        this.name = 'HttpError';
    }
}

/**
 * HTTP client class.
 *
 * Wraps a channel connection to an HTTP endpoint.
 */
export class Http {
    private ch: number;
    private baseUrl: string;
    private defaultHeaders: Record<string, string>;
    private basePath: string;
    private defaultTimeout?: number;

    private constructor(
        ch: number,
        baseUrl: string,
        opts?: HttpOptions
    ) {
        this.ch = ch;
        this.baseUrl = baseUrl;
        this.defaultHeaders = opts?.headers ?? {};
        this.basePath = opts?.basePath ?? '';
        this.defaultTimeout = opts?.timeout;
    }

    /**
     * Connect to an HTTP endpoint.
     *
     * @param baseUrl - Base URL for all requests
     * @param opts - Connection options
     * @returns Connected Http client
     *
     * @example
     * const api = await Http.connect('https://api.example.com', {
     *     headers: { 'Authorization': 'Bearer token123' }
     * });
     */
    static async connect(baseUrl: string, opts?: HttpOptions): Promise<Http> {
        const ch = await channel.open('http', baseUrl, {
            headers: opts?.headers,
            timeout: opts?.timeout,
        });
        return new Http(ch, baseUrl, opts);
    }

    /**
     * GET request returning parsed JSON.
     *
     * @param path - Request path
     * @param opts - Request options
     * @returns Response data
     *
     * @example
     * const users = await api.get<User[]>('/users');
     * const user = await api.get<User>('/users/123', { query: { expand: 'profile' } });
     */
    async get<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('GET', path, undefined, opts);
        return response.data;
    }

    /**
     * POST request with JSON body.
     *
     * @param path - Request path
     * @param body - Request body (will be JSON-serialized)
     * @param opts - Request options
     * @returns Response data
     *
     * @example
     * const user = await api.post<User>('/users', { name: 'Alice', email: 'alice@example.com' });
     */
    async post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('POST', path, body, opts);
        return response.data;
    }

    /**
     * PUT request with JSON body.
     *
     * @param path - Request path
     * @param body - Request body (will be JSON-serialized)
     * @param opts - Request options
     * @returns Response data
     *
     * @example
     * await api.put('/users/123', { name: 'Alice Smith' });
     */
    async put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('PUT', path, body, opts);
        return response.data;
    }

    /**
     * PATCH request with JSON body.
     *
     * @param path - Request path
     * @param body - Request body (will be JSON-serialized)
     * @param opts - Request options
     * @returns Response data
     *
     * @example
     * await api.patch('/users/123', { status: 'active' });
     */
    async patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('PATCH', path, body, opts);
        return response.data;
    }

    /**
     * DELETE request.
     *
     * @param path - Request path
     * @param opts - Request options
     * @returns Response data
     *
     * @example
     * await api.delete('/users/123');
     */
    async delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('DELETE', path, undefined, opts);
        return response.data;
    }

    /**
     * Stream response as async iterable (JSONL or SSE).
     *
     * @param path - Request path
     * @param opts - Request options
     * @returns Async iterable of parsed items
     *
     * @example
     * for await (const event of api.stream<Event>('/events')) {
     *     console.log('Event:', event);
     * }
     */
    async *stream<T = unknown>(path: string, opts?: RequestOptions): AsyncIterable<T> {
        const msg = httpRequest({
            method: 'GET',
            path: this.basePath + path,
            query: opts?.query as Record<string, unknown>,
            headers: { ...this.defaultHeaders, ...opts?.headers },
            accept: 'application/jsonl',
        });

        for await (const response of channel.stream(this.ch, msg)) {
            if (response.op === 'error') {
                const err = response.data as { code: string; message: string };
                throw new HttpError(err.code, err.message);
            }
            if (response.op === 'item') {
                yield response.data as T;
            }
            if (response.op === 'done') {
                break;
            }
        }
    }

    /**
     * Raw request with full control.
     *
     * @param method - HTTP method
     * @param path - Request path
     * @param body - Request body
     * @param opts - Request options
     * @returns Full response with ok flag and data
     *
     * @example
     * const response = await api.request('OPTIONS', '/users');
     * if (response.ok) {
     *     console.log('Allowed methods:', response.data);
     * }
     */
    async request<T = unknown>(
        method: string,
        path: string,
        body?: unknown,
        opts?: RequestOptions
    ): Promise<HttpResponse<T>> {
        const msg = httpRequest({
            method,
            path: this.basePath + path,
            query: opts?.query as Record<string, unknown>,
            headers: { ...this.defaultHeaders, ...opts?.headers },
            body,
        });

        const response = await channel.call<T>(this.ch, msg);

        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new HttpError(err.code, err.message);
        }

        return {
            ok: response.op === 'ok',
            data: response.data as T,
        };
    }

    /**
     * Close the connection.
     *
     * @example
     * await api.close();
     */
    async close(): Promise<void> {
        await channel.close(this.ch);
    }
}
