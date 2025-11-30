/**
 * JSON-RPC Helpers
 */

import type { JsonRpcResponse } from './types.js';

export function jsonRpcSuccess(id: string | number | null, result: any): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(
    id: string | number | null,
    code: number,
    message: string,
    data?: any
): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message, data } };
}
