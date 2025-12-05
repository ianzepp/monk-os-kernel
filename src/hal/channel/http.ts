/**
 * HTTP Channel - HTTP/HTTPS client via fetch()
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The HTTP channel provides a message-based interface to HTTP/HTTPS requests
 * using Bun's built-in fetch() API. Unlike raw socket I/O, this channel handles
 * protocol details (headers, methods, status codes, content negotiation) and
 * exposes only high-level request/response semantics.
 *
 * The channel supports three response patterns:
 * 1. Single JSON response: Standard REST APIs (yields ok with parsed JSON)
 * 2. JSONL streaming: Newline-delimited JSON (yields item per line, then done)
 * 3. SSE streaming: Server-Sent Events (yields event per SSE message, then done)
 *
 * This design enables processes to consume HTTP APIs without implementing HTTP
 * parsing, connection pooling, or stream decoding. The kernel maps these
 * operations to handle exec() calls.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: baseUrl is set at construction and never modified
 * INV-2: Once closed=true, all handle() calls must yield error response
 * INV-3: handle() always yields at least one response (ok, error, or done)
 * INV-4: Streaming responses yield done as final response
 * INV-5: Timeouts are enforced if configured (AbortController)
 *
 * CONCURRENCY MODEL
 * =================
 * Multiple processes may call handle() concurrently on the same channel.
 * Each request is independent - fetch() manages connection pooling internally.
 * HTTP/1.1 pipelining and HTTP/2 multiplexing are handled by Bun's fetch()
 * implementation.
 *
 * The channel is stateless between requests. Cookies, connection pooling, and
 * keep-alive are managed by the underlying fetch() implementation, not by
 * this channel.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Each fetch() is independent - no shared request state
 * RC-2: Timeout AbortController is per-request (cleared after response)
 * RC-3: Stream readers call releaseLock() in finally blocks
 * RC-4: closed flag checked at start of handle() (not between awaits)
 *
 * MEMORY MANAGEMENT
 * =================
 * - fetch() Response streams must be consumed or canceled to free resources
 * - AbortController timeouts are cleared after response completes
 * - Stream readers are released in finally blocks (even on errors)
 * - No persistent connections are held (fetch() manages connection pool)
 * - close() sets closed flag but has no resources to release
 *
 * @module hal/channel/http
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts, HttpRequest } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * HTTP client channel using fetch().
 *
 * WHY: fetch() is Bun's optimized HTTP client with automatic connection pooling,
 * HTTP/2 support, and TLS. Using it instead of raw sockets eliminates ~1000 lines
 * of HTTP parsing and connection management code.
 *
 * TESTABILITY: Can be mocked by intercepting fetch() globally or by using test
 * servers that return specific response patterns.
 */
export class BunHttpChannel implements Channel {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique channel identifier.
     *
     * WHY: Enables kernel to track channels in handle tables and correlate
     * requests/responses in logs.
     *
     * INVARIANT: Set once at construction, never changes.
     */
    readonly id = randomUUID();

    /**
     * Protocol type.
     *
     * WHY: Identifies this as an HTTP channel for kernel dispatch and logging.
     *
     * INVARIANT: Always 'http' (even for HTTPS - proto describes API, not transport).
     */
    readonly proto = 'http';

    /**
     * Human-readable description.
     *
     * WHY: Shows base URL in logs, error messages, and process listings.
     * Helps debug which API a process is connecting to.
     */
    readonly description: string;

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * Base URL for all requests.
     *
     * WHY: Relative paths in requests are resolved against this base.
     * Simplifies API clients - they don't need to repeat the host/port.
     *
     * INVARIANT: Set at construction, never modified (channels are immutable).
     */
    private baseUrl: string;

    /**
     * Default headers sent with every request.
     *
     * WHY: Common headers (auth tokens, accept types, etc.) can be set once
     * instead of repeating in every request.
     */
    private defaultHeaders: Record<string, string>;

    /**
     * Request timeout in milliseconds.
     *
     * WHY: Prevents requests from hanging indefinitely if server is unresponsive.
     * Uses AbortController to cancel fetch() after timeout.
     */
    private timeout?: number;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether channel is closed.
     *
     * WHY: Fast-path check to reject operations after close(). Prevents use-after-close bugs.
     *
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create HTTP channel.
     *
     * WHY: Channel construction is synchronous - no connection established yet.
     * Actual TCP connections happen lazily on first request (via fetch()).
     *
     * @param url - Base URL for requests
     * @param opts - Channel options (headers, timeout)
     */
    constructor(url: string, opts?: ChannelOpts) {
        this.baseUrl = url;
        this.description = url;
        this.defaultHeaders = opts?.headers ?? {};
        this.timeout = opts?.timeout;
    }

    // =========================================================================
    // PROPERTIES
    // =========================================================================

    /**
     * Check if channel is closed.
     *
     * WHY: Exposed as property for fast kernel checks without method call overhead.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // REQUEST HANDLING
    // =========================================================================

    /**
     * Handle HTTP request message.
     *
     * WHY: Unified interface for both single-value and streaming requests.
     * Caller decides whether to iterate or just take first response.
     *
     * ALGORITHM:
     * 1. Check closed state
     * 2. Validate op='request' (only op we support)
     * 3. Build URL from base + path + query params
     * 4. Create AbortController for timeout
     * 5. Execute fetch() with method, headers, body
     * 6. Check response.ok (HTTP 2xx/3xx)
     * 7. Detect streaming vs single response (content-type)
     * 8. Yield responses based on pattern
     * 9. Clear timeout
     *
     * RESPONSE PATTERNS:
     * - application/jsonl: Stream items, yield done
     * - text/event-stream: Stream events, yield done
     * - default: Parse JSON, yield ok
     *
     * RACE CONDITION:
     * closed flag is checked only at start of method. If close() is called
     * mid-request, fetch() continues but subsequent calls will fail. This is
     * acceptable - in-flight requests can complete, new ones are rejected.
     *
     * ERROR HANDLING:
     * - HTTP errors (4xx/5xx): yield error with status
     * - Network errors: yield error('EIO', message)
     * - Timeout: yield error('ETIMEDOUT', 'Request timeout')
     * - Malformed JSONL: skip line (don't fail entire stream)
     *
     * @param msg - Message with op='request', data=HttpRequest
     * @returns AsyncIterable of responses
     */
    async *handle(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check closed at method entry, before any async operations
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');

            return;
        }

        // Validate operation type
        if (msg.op !== 'request') {
            yield respond.error('EINVAL', `Unknown op: ${msg.op}`);

            return;
        }

        const req = msg.data as HttpRequest;
        const url = this.buildUrl(req.path, req.query);

        try {
            // WHY: AbortController enables timeout enforcement. Without it,
            // fetch() could hang indefinitely on slow/dead servers.
            const controller = new AbortController();
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            if (this.timeout) {
                timeoutId = setTimeout(() => controller.abort(), this.timeout);
            }

            // WHY: Merge default headers with request headers, allowing request
            // to override defaults. Spread order matters: right side wins.
            const response = await fetch(url, {
                method: req.method || 'GET',
                headers: { ...this.defaultHeaders, ...req.headers },
                body: req.body ? JSON.stringify(req.body) : undefined,
                signal: controller.signal,
            });

            // WHY: Clear timeout immediately after response to prevent unnecessary
            // timer firing. Memory leak prevention.
            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            // WHY: response.ok is true for 2xx/3xx status codes. We treat non-ok
            // as errors rather than yielding ok() with error status.
            if (!response.ok) {
                yield respond.error(`HTTP_${response.status}`, response.statusText);

                return;
            }

            // WHY: Content-Type determines response handling. JSONL and SSE are
            // streaming formats, others are single-value.
            const contentType = response.headers.get('content-type') || '';

            if (req.accept === 'application/jsonl' || contentType.includes('application/jsonl')) {
                // STREAMING: JSONL (newline-delimited JSON)
                // WHY: Each line is a separate JSON object. Common for log streams,
                // search results, database dumps.
                if (response.body) {
                    for await (const line of this.readLines(response.body)) {
                        if (line.trim()) {
                            try {
                                yield respond.item(JSON.parse(line));
                            }
                            catch {
                                // WHY: Skip malformed lines instead of failing entire stream.
                                // Servers may send comments or partial data.
                            }
                        }
                    }
                }

                yield respond.done();
            }
            else if (contentType.includes('text/event-stream')) {
                // STREAMING: Server-Sent Events
                // WHY: SSE provides structured events with types and data. Used for
                // real-time updates, notifications, live logs.
                if (response.body) {
                    for await (const event of this.readSSE(response.body)) {
                        yield respond.event(event.type, event.data);
                    }
                }

                yield respond.done();
            }
            else {
                // SINGLE VALUE: JSON response
                // WHY: Standard REST API response. Parse entire body as JSON.
                const data = await response.json();

                yield respond.ok(data);
            }
        }
        catch (err) {
            const error = err as Error;

            if (error.name === 'AbortError') {
                // WHY: AbortController.abort() throws AbortError. This happens
                // on timeout or explicit cancellation.
                yield respond.error('ETIMEDOUT', 'Request timeout');
            }
            else {
                // WHY: Network errors, DNS failures, connection refused, etc.
                // Use EIO (generic I/O error) as catch-all.
                yield respond.error('EIO', error.message);
            }
        }
    }

    // =========================================================================
    // UNSUPPORTED OPERATIONS
    // =========================================================================

    /**
     * Push not supported (HTTP is request/response, not bidirectional).
     *
     * WHY: HTTP client cannot push to server outside of request cycle.
     * Use WebSocket for bidirectional communication.
     */
    async push(_response: Response): Promise<void> {
        throw new Error('HTTP client channels do not support push');
    }

    /**
     * Receive not supported (HTTP is request/response, not bidirectional).
     *
     * WHY: HTTP client initiates requests, cannot receive unsolicited messages.
     * Use WebSocket or SSE for server-initiated messages.
     */
    async recv(): Promise<Message> {
        throw new Error('HTTP client channels do not support recv');
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close channel.
     *
     * WHY: Sets closed flag to reject future requests. No actual resources to
     * release - fetch() manages connection pooling internally.
     *
     * ALGORITHM:
     * 1. Set closed flag
     * 2. Return (no cleanup needed)
     *
     * INVARIANT: Idempotent - safe to call multiple times.
     */
    async close(): Promise<void> {
        this._closed = true;
        // WHY: Connection pooling is handled by fetch() implementation.
        // No explicit cleanup needed here.
    }

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    /**
     * Build full URL from base, path, and query parameters.
     *
     * WHY: Centralizes URL construction logic. Handles query param encoding
     * and null/undefined filtering.
     *
     * ALGORITHM:
     * 1. Create URL object (base + path)
     * 2. Add query params if provided
     * 3. Skip null/undefined values
     * 4. Return string
     *
     * @param path - Request path (can be relative or absolute)
     * @param query - Optional query parameters
     * @returns Full URL string
     */
    private buildUrl(path: string, query?: Record<string, unknown>): string {
        const url = new URL(path, this.baseUrl);

        if (query) {
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }

        return url.toString();
    }

    /**
     * Read response body as lines.
     *
     * WHY: Streaming line reader for JSONL and SSE parsing. Uses backpressure
     * from async iterator - only reads when consumer is ready.
     *
     * ALGORITHM:
     * 1. Get reader from response body
     * 2. Read chunks, decode to text
     * 3. Split on newlines
     * 4. Yield complete lines
     * 5. Buffer incomplete line
     * 6. Yield final buffer on EOF
     * 7. Release reader in finally block
     *
     * RACE CONDITION:
     * Reader must be released even if iterator is abandoned. finally block
     * ensures cleanup happens.
     *
     * @param body - Response body stream
     * @returns AsyncIterable of text lines
     */
    private async *readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                // WHY: stream: true prevents decoder from flushing on every chunk.
                // Maintains decoding state across chunks for multi-byte UTF-8.
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                // WHY: Last element might be incomplete line - keep in buffer
                buffer = lines.pop()!;

                for (const line of lines) {
                    yield line;
                }
            }

            // WHY: Yield final buffer if non-empty (file may not end with newline)
            if (buffer.trim()) {
                yield buffer;
            }
        }
        finally {
            // RACE FIX: Always release reader to prevent resource leak, even if
            // iterator is abandoned or throws error
            reader.releaseLock();
        }
    }

    /**
     * Read response body as Server-Sent Events.
     *
     * WHY: SSE parser for text/event-stream responses. Yields structured events
     * with type and data fields.
     *
     * ALGORITHM:
     * 1. Read lines from body
     * 2. Parse SSE protocol:
     *    - Empty line = end of event
     *    - 'event:' = event type
     *    - 'data:' = event data (can be multi-line)
     * 3. Parse data as JSON if possible
     * 4. Yield event with type and data
     * 5. Reset for next event
     *
     * SSE FORMAT:
     * event: myevent
     * data: {"key":"value"}
     * <blank line>
     *
     * @param body - Response body stream
     * @returns AsyncIterable of events with type and data
     */
    private async *readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<{ type: string; data: Record<string, unknown> }> {
        let eventType = 'message'; // WHY: Default event type per SSE spec
        let dataBuffer = '';

        for await (const line of this.readLines(body)) {
            if (line === '') {
                // WHY: Empty line marks end of event. Flush accumulated data.
                if (dataBuffer) {
                    try {
                        yield { type: eventType, data: JSON.parse(dataBuffer) };
                    }
                    catch {
                        // WHY: Fallback for non-JSON data - wrap in object
                        yield { type: eventType, data: { raw: dataBuffer } };
                    }

                    dataBuffer = '';
                    eventType = 'message'; // Reset to default
                }
            }
            else if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
            }
            else if (line.startsWith('data:')) {
                // WHY: Accumulate data lines (SSE allows multi-line data)
                dataBuffer += line.slice(5).trim();
            }
            // WHY: Ignore other SSE fields (id:, retry:, etc.) for now
        }
    }
}
