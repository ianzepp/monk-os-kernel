/**
 * HTTP Server Channel - HTTP request/response over raw socket
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The HTTP server channel provides request/response semantics over a raw TCP
 * socket. It wraps an already-accepted socket and handles HTTP wire protocol:
 * parsing incoming requests and formatting outgoing responses.
 *
 * Unlike BunHttpChannel (client-side, makes outbound requests), this channel
 * is server-side: it receives requests from clients and sends responses back.
 *
 * The channel supports:
 * - Parsing HTTP/1.1 requests (method, path, headers, body)
 * - Formatting HTTP/1.1 responses (status, headers, body)
 * - JSON body parsing/serialization
 * - Single request/response per connection (no keep-alive yet)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Socket is set at construction and never modified
 * INV-2: recv() returns exactly one request per connection
 * INV-3: push() sends exactly one response per connection
 * INV-4: Once closed=true, operations must throw error
 * INV-5: Socket is closed only once (on close())
 *
 * CONCURRENCY MODEL
 * =================
 * Each HTTP server channel handles one connection. There is no concurrency
 * within a single channel - recv() must be called before push(). Multiple
 * connections create multiple channels.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: closed flag checked before socket operations
 * RC-2: requestReceived flag prevents multiple recv() calls
 * RC-3: responseSent flag prevents multiple push() calls
 * RC-4: close() closes socket which fails pending operations
 *
 * MEMORY MANAGEMENT
 * =================
 * - Channel owns socket (must close it)
 * - TextEncoder/TextDecoder reused for all operations
 * - Request body buffered in memory (be mindful of large bodies)
 * - close() closes socket which releases file descriptor
 *
 * @module hal/channel/http-server
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Socket } from '../network/types.js';
import type { Channel, ChannelOpts } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed HTTP request from client.
 */
export interface HttpServerRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
}

/**
 * HTTP response to send to client.
 */
export interface HttpServerResponse {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * HTTP server channel (receives requests, sends responses).
 *
 * Wraps an accepted TCP socket with HTTP/1.1 protocol handling.
 */
export class BunHttpServerChannel implements Channel {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    readonly id = randomUUID();
    readonly proto = 'http-server';
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    private socket: Socket;
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();
    private _closed = false;
    private requestReceived = false;
    private responseSent = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(socket: Socket, _opts?: ChannelOpts) {
        this.socket = socket;
        const stat = socket.stat();

        this.description = `http-server:${stat.remoteAddr}:${stat.remotePort}`;
    }

    // =========================================================================
    // PROPERTIES
    // =========================================================================

    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // HANDLE (for kernel dispatch)
    // =========================================================================

    /**
     * Handle kernel messages.
     *
     * Supports:
     * - op='recv': Receive and parse HTTP request
     * - op='send': Send HTTP response
     */
    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');

            return;
        }

        switch (msg.op) {
            case 'recv':
                try {
                    const request = await this.recvRequest();

                    yield respond.ok(request);
                }
                catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }

                break;

            case 'send':
                try {
                    const responseData = msg.data as HttpServerResponse;

                    await this.sendResponse(responseData);
                    yield respond.ok();
                }
                catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }

                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
        }
    }

    // =========================================================================
    // RECV - Parse incoming HTTP request
    // =========================================================================

    /**
     * Receive HTTP request from client.
     *
     * Parses HTTP/1.1 request from socket.
     */
    async recv(): Promise<Message> {
        const request = await this.recvRequest();

        return { op: 'request', data: request };
    }

    private async recvRequest(): Promise<HttpServerRequest> {
        if (this._closed) {
            throw new Error('Channel closed');
        }

        if (this.requestReceived) {
            throw new Error('Request already received');
        }

        // Read all available data with timeout
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        const maxBodySize = 10 * 1024 * 1024; // 10MB limit

        // Read until we have complete headers (double CRLF)
        let headerEnd = -1;
        let buffer = '';

        while (headerEnd === -1) {
            const chunk = await this.socket.read({ timeout: 30000 });

            if (chunk.length === 0) {
                // Connection closed
                if (buffer.length === 0) {
                    throw new Error('Connection closed before request received');
                }

                break;
            }

            chunks.push(chunk);
            totalLength += chunk.length;

            if (totalLength > maxBodySize) {
                throw new Error('Request too large');
            }

            buffer += this.decoder.decode(chunk, { stream: true });
            headerEnd = buffer.indexOf('\r\n\r\n');
        }

        if (headerEnd === -1) {
            throw new Error('Incomplete HTTP request');
        }

        // Parse headers
        const headerPart = buffer.substring(0, headerEnd);
        const bodyPart = buffer.substring(headerEnd + 4);

        const lines = headerPart.split('\r\n');
        const requestLine = lines[0];

        if (!requestLine) {
            throw new Error('Empty request line');
        }

        const requestParts = requestLine.split(' ');
        const method = requestParts[0] ?? 'GET';
        const fullPath = requestParts[1] ?? '/';

        // Parse path and query string
        const pathParts = fullPath.split('?');
        const path = pathParts[0] ?? '/';
        const queryString = pathParts[1];
        const query: Record<string, string> = {};

        if (queryString) {
            for (const pair of queryString.split('&')) {
                const pairParts = pair.split('=');
                const key = pairParts[0];
                const value = pairParts[1];

                if (key) {
                    query[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
                }
            }
        }

        // Parse headers
        const headers: Record<string, string> = {};

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];

            if (!line) {
                continue;
            }

            const colonIndex = line.indexOf(':');

            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim().toLowerCase();
                const value = line.substring(colonIndex + 1).trim();

                headers[key] = value;
            }
        }

        // Read body if Content-Length specified
        let body: unknown = undefined;
        const contentLength = parseInt(headers['content-length'] || '0', 10);

        if (contentLength > 0) {
            // We may already have some body data
            let bodyBuffer = bodyPart;

            while (bodyBuffer.length < contentLength) {
                const chunk = await this.socket.read({ timeout: 30000 });

                if (chunk.length === 0) {
                    break;
                }

                bodyBuffer += this.decoder.decode(chunk, { stream: true });
            }

            // Parse JSON if content-type indicates it
            const contentType = headers['content-type'] || '';

            if (contentType.includes('application/json')) {
                try {
                    body = JSON.parse(bodyBuffer.substring(0, contentLength));
                }
                catch {
                    body = bodyBuffer.substring(0, contentLength);
                }
            }
            else {
                body = bodyBuffer.substring(0, contentLength);
            }
        }

        this.requestReceived = true;

        return { method, path, query, headers, body };
    }

    // =========================================================================
    // PUSH - Send HTTP response
    // =========================================================================

    /**
     * Push HTTP response to client.
     */
    async push(response: Response): Promise<void> {
        if (response.op === 'ok' || response.op === 'item') {
            await this.sendResponse(response.data as HttpServerResponse);
        }
        else if (response.op === 'error') {
            const errorData = response.data as { code: string; message: string };

            await this.sendResponse({
                status: 500,
                body: { error: errorData.code, message: errorData.message },
            });
        }
        else {
            await this.sendResponse({ status: 200, body: response.data });
        }
    }

    private async sendResponse(response: HttpServerResponse): Promise<void> {
        if (this._closed) {
            throw new Error('Channel closed');
        }

        if (this.responseSent) {
            throw new Error('Response already sent');
        }

        const status = response.status ?? 200;
        const statusText = this.getStatusText(status);

        // Serialize body
        let bodyBytes: Uint8Array;
        let contentType = 'application/json';

        if (response.body === undefined || response.body === null) {
            bodyBytes = new Uint8Array(0);
        }
        else if (typeof response.body === 'string') {
            bodyBytes = this.encoder.encode(response.body);
            contentType = 'text/plain; charset=utf-8';
        }
        else {
            bodyBytes = this.encoder.encode(JSON.stringify(response.body));
        }

        // Build headers
        const headers: Record<string, string> = {
            'Content-Type': contentType,
            'Content-Length': String(bodyBytes.length),
            'Connection': 'close',
            ...response.headers,
        };

        // Format HTTP response
        const headerLines = [`HTTP/1.1 ${status} ${statusText}`];

        for (const [key, value] of Object.entries(headers)) {
            headerLines.push(`${key}: ${value}`);
        }

        headerLines.push('', ''); // End headers with blank line

        const headerBytes = this.encoder.encode(headerLines.join('\r\n'));

        // Write response
        await this.socket.write(headerBytes);

        if (bodyBytes.length > 0) {
            await this.socket.write(bodyBytes);
        }

        this.responseSent = true;
    }

    private getStatusText(status: number): string {
        const statusTexts: Record<number, string> = {
            200: 'OK',
            201: 'Created',
            204: 'No Content',
            400: 'Bad Request',
            401: 'Unauthorized',
            403: 'Forbidden',
            404: 'Not Found',
            405: 'Method Not Allowed',
            500: 'Internal Server Error',
            502: 'Bad Gateway',
            503: 'Service Unavailable',
        };

        return statusTexts[status] || 'Unknown';
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        this._closed = true;
        await this.socket.close();
    }
}
