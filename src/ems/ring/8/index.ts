/**
 * Ring 8: Integration
 *
 * These observers handle integration concerns like cache invalidation,
 * webhooks, and external system notifications.
 *
 * Observers in this ring:
 * - Cache (50): Invalidate model cache on model/field changes
 * - PathCacheSync (60): Sync PathCache with entity mutations
 *
 * @module model/ring/8
 */

export { Cache } from './50-cache.js';
export { PathCacheSync } from './60-path-cache.js';
