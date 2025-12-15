/**
 * Redis Device - Cache + Pub/Sub with Memory Fallback
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides Redis-like functionality for Monk OS. It abstracts
 * cache (key-value) and pub/sub operations behind a common interface with
 * two interchangeable backends:
 *
 * - Memory: In-process storage for dev/testing/single-node
 * - Redis: External Redis server for production/multi-node
 *
 * This is a barrel file that re-exports types and implementations from the
 * redis/ subdirectory. The actual implementation logic lives in:
 * - redis/types.ts - Interface definitions and types
 * - redis/memory.ts - In-memory implementation
 *
 * PRIMARY USE CASES
 * =================
 * 1. Session storage with TTL
 * 2. Rate limiting (incr + expire)
 * 3. Distributed locks (setnx)
 * 4. Hot data caching
 * 5. Pub/sub for watch() notifications
 * 6. Cross-process event propagation
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exports are re-exports from redis/ subdirectory
 * INV-2: No implementation logic in this file
 * INV-3: Type exports precede implementation exports
 * INV-4: Memory and Redis backends are behaviorally identical
 *
 * BUN TOUCHPOINTS
 * ===============
 * - Memory: Pure JavaScript, no Bun-specific APIs
 * - Redis: Will use Bun's native Redis support when available
 *
 * @module hal/redis
 */

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type {
    RedisDevice,
    RedisConfig,
    PubsubSubscription,
    PubsubMessage,
} from './redis/types.js';

// =============================================================================
// IMPLEMENTATION EXPORTS
// =============================================================================

export { MemoryRedis } from './redis/memory.js';

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

import type { RedisConfig, RedisDevice } from './redis/types.js';
import { MemoryRedis } from './redis/memory.js';

/**
 * Create a Redis device based on configuration.
 *
 * @param config - Redis configuration
 * @returns Configured Redis device (Memory or Redis backend)
 * @throws Error if type is 'redis' (not yet implemented)
 */
export function createRedisDevice(config?: RedisConfig): RedisDevice {
    const type = config?.type ?? 'memory';

    switch (type) {
        case 'memory':
            return new MemoryRedis(config);

        case 'redis':
            // TODO: Implement actual Redis backend
            throw new Error('Redis backend not yet implemented. Use type: "memory" for now.');

        default:
            return new MemoryRedis(config);
    }
}
