/**
 * MCP Tool Definitions and Handlers
 */

import type { Hono } from 'hono';
import { executeAgentPrompt } from '@src/lib/tty/headless.js';
import { systemInitFromJWT } from '@src/lib/system.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';
import type { McpTool, McpSession, McpContext } from './types.js';
import { updateSession } from './session.js';

// =============================================================================
// Tool Definitions
// =============================================================================

export const TOOLS: McpTool[] = [
    {
        name: 'MonkAuth',
        description:
            'Authentication for Monk API. Actions: register (create new tenant), login (authenticate), refresh (renew token), status (check auth state).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                action: {
                    type: 'string',
                    enum: ['register', 'login', 'refresh', 'status'],
                    description: 'Auth action to perform',
                },
                tenant: {
                    type: 'string',
                    description: 'Tenant name (required for register/login)',
                },
                username: { type: 'string', description: 'Username (defaults to "root")' },
                password: { type: 'string', description: 'Password (required for login)' },
                description: {
                    type: 'string',
                    description: 'Human-readable tenant description (register only)',
                },
                template: {
                    type: 'string',
                    description: 'Template name (register only, defaults to "system")',
                },
                adapter: {
                    type: 'string',
                    enum: ['postgresql', 'sqlite'],
                    description: 'Database adapter (register only, defaults to "postgresql")',
                },
            },
            required: ['action'],
        },
    },
    {
        name: 'MonkHttp',
        description:
            'HTTP requests to Monk API. Automatically injects JWT token (if authenticated). **Start here: GET /docs (no auth required) returns full API documentation.** Key endpoints: /auth/* (login/register), /api/data/:model (CRUD), /api/find/:model (queries), /api/describe/:model (schema), /api/aggregate/:model (analytics).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                method: {
                    type: 'string',
                    enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                    description: 'HTTP method',
                },
                path: {
                    type: 'string',
                    description: 'API path (e.g., /api/data/users, /docs)',
                },
                query: { type: 'object', description: 'URL query parameters (optional)' },
                body: { description: 'Request body (optional)' },
                requireAuth: {
                    type: 'boolean',
                    description: 'Include JWT token (default: true)',
                },
            },
            required: ['method', 'path'],
        },
    },
    {
        name: 'MonkAgent',
        description:
            'Invoke AI agent to perform tasks. The agent interprets your natural language request and executes appropriate database queries, file operations, or other commands. Requires authentication (use MonkAuth login first).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                prompt: {
                    type: 'string',
                    description:
                        'Natural language request for the AI agent (e.g., "what records changed in the last day", "count users by access level")',
                },
            },
            required: ['prompt'],
        },
    },
];

// =============================================================================
// API Caller
// =============================================================================

async function callApi(
    honoApp: Hono,
    session: McpSession,
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: any,
    requireAuth: boolean = true
): Promise<any> {
    // Build URL with query parameters
    let url = `http://localhost${path}`;
    if (query && Object.keys(query).length > 0) {
        const params = new URLSearchParams(query);
        url += `?${params.toString()}`;
    }

    // Build headers
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };

    if (requireAuth && session.token) {
        headers['Authorization'] = `Bearer ${session.token}`;
    }

    // Build request
    const init: RequestInit = { method, headers };

    if (!['GET', 'HEAD'].includes(method)) {
        init.body = body ? JSON.stringify(body) : '{}';
    }

    // Call Hono app directly (no network)
    const request = new Request(url, init);
    const response = await honoApp.fetch(request);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`API Error (${response.status}): ${JSON.stringify(data)}`);
    }

    return data;
}

// =============================================================================
// Tool Handlers
// =============================================================================

async function handleMonkAuth(ctx: McpContext, params: Record<string, any>): Promise<any> {
    const { action } = params;
    const { honoApp, sessionId, session } = ctx;

    switch (action) {
        case 'status':
            return {
                authenticated: !!session.token,
                tenant: session.tenant,
                has_token: !!session.token,
            };

        case 'register': {
            const body = {
                tenant: params.tenant,
                template: params.template,
                username: params.username,
                description: params.description,
                adapter: params.adapter,
            };
            const response = await callApi(
                honoApp,
                session,
                'POST',
                '/auth/register',
                undefined,
                body,
                false
            );
            if (response.data?.token) {
                session.token = response.data.token;
                session.tenant = response.data.tenant || params.tenant;
                updateSession(sessionId, session);
            }
            return { ...response, message: 'Token cached' };
        }

        case 'login': {
            const body = {
                tenant: params.tenant,
                username: params.username || 'root',
                password: params.password,
            };
            const response = await callApi(
                honoApp,
                session,
                'POST',
                '/auth/login',
                undefined,
                body,
                false
            );
            if (response.data?.token) {
                session.token = response.data.token;
                session.tenant = response.data.tenant || params.tenant;
                updateSession(sessionId, session);
            }
            return { ...response, message: 'Token cached' };
        }

        case 'refresh': {
            const response = await callApi(
                honoApp,
                session,
                'POST',
                '/auth/refresh',
                undefined,
                {},
                true
            );
            if (response.data?.token) {
                session.token = response.data.token;
                updateSession(sessionId, session);
            }
            return response;
        }

        default:
            throw new Error(`Unknown auth action: ${action}`);
    }
}

async function handleMonkHttp(ctx: McpContext, params: Record<string, any>): Promise<any> {
    const { method, path, query, body, requireAuth = true } = params;
    return callApi(ctx.honoApp, ctx.session, method, path, query, body, requireAuth);
}

async function handleMonkAgent(ctx: McpContext, params: Record<string, any>): Promise<any> {
    const { prompt } = params;
    const { sessionId, session } = ctx;

    if (!prompt || typeof prompt !== 'string') {
        throw new Error('Missing required parameter: prompt');
    }

    if (!session.token) {
        throw new Error('Authentication required. Use MonkAuth login first.');
    }

    // Verify JWT and get payload
    const payload = await JWTGenerator.validateToken(session.token);
    if (!payload) {
        throw new Error('Invalid or expired token. Please login again.');
    }

    // Create SystemInit from JWT
    const systemInit = systemInitFromJWT(payload);

    // Execute agent prompt
    const result = await executeAgentPrompt(systemInit, prompt, {
        sessionId: `mcp-${sessionId}`,
    });

    return result;
}

// =============================================================================
// Tool Dispatcher
// =============================================================================

export async function handleToolCall(
    ctx: McpContext,
    name: string,
    args: Record<string, any>
): Promise<any> {
    switch (name) {
        case 'MonkAuth':
            return handleMonkAuth(ctx, args);
        case 'MonkHttp':
            return handleMonkHttp(ctx, args);
        case 'MonkAgent':
            return handleMonkAgent(ctx, args);
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
