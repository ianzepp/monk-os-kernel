/**
 * Database Service - Re-export Module
 *
 * This file re-exports from the refactored database module structure.
 * Maintains backward compatibility with existing imports.
 *
 * The actual implementation is now in:
 * - src/lib/database/service.ts  - Database class
 * - src/lib/database/types.ts    - Types (CachedRelationship, SelectOptions)
 * - src/lib/database/select.ts   - Select operations
 * - src/lib/database/mutate.ts   - Create/update/delete operations
 * - src/lib/database/access.ts   - ACL operations
 * - src/lib/database/pipeline.ts - Observer pipeline execution
 */

export { Database } from '@src/lib/database/service.js';
export type { CachedRelationship, SelectOptions } from '@src/lib/database/types.js';
