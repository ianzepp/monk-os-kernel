/**
 * MCP Server
 *
 * Standalone MCP (Model Context Protocol) server using regular HTTP.
 * Provides JSON-RPC endpoint for LLM agents to interact with the Monk API.
 */

import type { Hono } from 'hono';
import type { JsonRpcRequest, McpContext, McpServerHandle, McpServerConfig } from '@src/lib/mcp/index.js';
import { jsonRpcSuccess, jsonRpcError, getOrCreateSession, TOOLS, handleToolCall } from '@src/lib/mcp/index.js';

// =============================================================================
// Request Handler
// =============================================================================

async function handleRequest(honoApp: Hono, request: Request): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
            },
        });
    }

    // Only accept POST requests
    if (request.method !== 'POST') {
        return Response.json(jsonRpcError(null, -32600, 'Only POST requests supported'), {
            status: 405,
        });
    }

    // Get or create session
    const sessionId = request.headers.get('mcp-session-id') || 'default';
    const session = getOrCreateSession(sessionId);

    // Build context
    const ctx: McpContext = { honoApp, sessionId, session };

    // Parse request body
    let rpcRequest: JsonRpcRequest;
    try {
        rpcRequest = (await request.json()) as JsonRpcRequest;
    } catch {
        return Response.json(jsonRpcError(null, -32700, 'Parse error'));
    }

    const { method, params = {}, id } = rpcRequest;

    try {
        switch (method) {
            case 'initialize':
                return Response.json(
                    jsonRpcSuccess(id, {
                        protocolVersion: params.protocolVersion || '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'monk-api', version: '1.0.0' },
                    }),
                    {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'mcp-session-id': sessionId,
                            'Access-Control-Allow-Origin': '*',
                        },
                    }
                );

            case 'initialized':
                return Response.json(jsonRpcSuccess(id, {}));

            case 'tools/list':
                return Response.json(jsonRpcSuccess(id, { tools: TOOLS }));

            case 'tools/call': {
                const { name, arguments: args = {} } = params;
                const result = await handleToolCall(ctx, name, args);
                const content =
                    typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                return Response.json(
                    jsonRpcSuccess(id, {
                        content: [{ type: 'text', text: content }],
                    })
                );
            }

            default:
                return Response.json(jsonRpcError(id, -32601, `Method not found: ${method}`));
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json(
            jsonRpcSuccess(id, {
                content: [{ type: 'text', text: JSON.stringify({ error: true, message }, null, 2) }],
                isError: true,
            })
        );
    }
}

// =============================================================================
// Server
// =============================================================================

/**
 * Start the MCP server
 *
 * @param honoApp - The main Hono app instance for making API calls
 * @param config - Server configuration
 * @returns Server handle with stop() method
 */
export function startMcpServer(honoApp: Hono, config?: McpServerConfig): McpServerHandle {
    const port = config?.port ?? Number(process.env.MCP_PORT || 3001);
    const hostname = config?.host ?? process.env.MCP_HOST ?? '0.0.0.0';

    const server = Bun.serve({
        hostname,
        port,
        fetch: (request) => handleRequest(honoApp, request),
    });

    console.info(`MCP server listening on ${hostname}:${port}`);

    return {
        stop: () => {
            server.stop();
            console.info('MCP server stopped');
        },
    };
}

// Re-export types for convenience
export type { McpServerHandle, McpServerConfig } from '@src/lib/mcp/index.js';
