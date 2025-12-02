/**
 * API Framework
 *
 * JSONL-over-TCP/WebSocket server framework for Monk OS.
 *
 * Usage:
 * ```typescript
 * import { createApi } from '@usr/lib/api';
 *
 * const api = createApi();
 * await api.scan('/usr/api/ops');
 * api.use('data:*', requireAuth, withTenant);
 * await api.listen({ tcp: 9000, ws: 9001 });
 * ```
 */

// Main exports
export { createApi } from './server';
export { OpRouter } from './router';

// Type exports
export type {
    ApiServer,
    Connection,
    ListenOptions,
    Middleware,
    OpContext,
    OpHandler,
    OpRoute,
    User,
} from './types';

// Re-export message types for convenience
export { respond } from '@src/message';
export type { Message, Response } from '@src/message';
