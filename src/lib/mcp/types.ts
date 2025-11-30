/**
 * MCP Type Definitions
 */

import type { Hono } from 'hono';

// =============================================================================
// JSON-RPC Types
// =============================================================================

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, any>;
    id: string | number;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

// =============================================================================
// Session Types
// =============================================================================

export interface McpSession {
    token: string | null;
    tenant: string | null;
}

// =============================================================================
// Tool Types
// =============================================================================

export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

// =============================================================================
// Server Types
// =============================================================================

export interface McpServerHandle {
    stop: () => void;
}

export interface McpServerConfig {
    port?: number;
    host?: string;
}

export interface McpContext {
    honoApp: Hono;
    sessionId: string;
    session: McpSession;
}
